"""Row, decision and field edits on a loaded ledger doc: add, edit, move, split and retire rows; add and
supersede decisions; set Section 0A and 0B values; archive finished rows and decisions. mm_ledger holds the
states, transitions, validation, lock and save; these functions only change the doc in memory.
"""

import re

import mm_schema
from mm_ledger import IllegalTransition, Refused, TERMINAL, _now_iso, find_row, set_row_state


_NUMBER_RE = re.compile(r"(\d+)\s*$")
_ROW_TEXT_FIELDS = {"item": "item", "notes": "notes_md", "owner": "owner", "target_date": "target_date",
                    "pr": "pr", "test_page": "test_page"}


def _all_rows(doc: dict) -> list:
    archived = (doc.get("archive") or {}).get("rows") or []
    return [r for r in doc.get("rows", []) + archived if isinstance(r, dict)]


def _all_decisions(doc: dict) -> list:
    archived = (doc.get("archive") or {}).get("decisions") or []
    return [d for d in doc.get("decisions", []) + archived if isinstance(d, dict)]


def _single_line(name: str, value: str) -> str:
    if "\n" in value or "\r" in value:
        raise Refused(6, f"{name} must be one line")
    return value


def _row(doc: dict, row_id: str) -> dict:
    try:
        return find_row(doc, row_id)
    except KeyError:
        raise Refused(4, f"no row {row_id!r}")


def _wrapup_index(rows: list):
    return next((i for i, r in enumerate(rows) if r.get("is_wrapup")), None)


def next_row_id(doc: dict) -> str:
    numbers = [int(m.group(1)) for r in _all_rows(doc) for m in [_NUMBER_RE.search(str(r.get("id", "")))] if m]
    return f"#{max(numbers, default=0) + 1}"


def make_row(row_id: str, item: str, **fields) -> dict:
    row = {"id": row_id, "item": _single_line("item", item), "state": "BACKLOG", "blocked": False,
           "blocked_reason": "", "status_label": mm_schema.STATUS_LABELS["BACKLOG"], "status_glyph_present": True,
           "owner": "", "target_date": "not scheduled", "notes_md": "",
           "is_wrapup": mm_schema.is_wrapup_item(item), "history": []}
    for key, value in fields.items():
        if value is None:
            continue
        if key == "test_level" and value not in mm_schema.TEST_LEVELS:
            raise Refused(6, f"test level {value!r} is not one of {', '.join(mm_schema.TEST_LEVELS)}")
        row[_ROW_TEXT_FIELDS.get(key, key)] = _single_line(key, value) if isinstance(value, str) else value
    return row


def add_row(doc: dict, item: str, **fields) -> str:
    row = make_row(next_row_id(doc), item, **fields)
    if row["is_wrapup"]:
        raise Refused(5, "the wrap-up row exists once; add-row cannot add another")
    rows = doc.setdefault("rows", [])
    at = _wrapup_index(rows)
    rows.insert(len(rows) if at is None else at, row)
    return row["id"]


def edit_row(doc: dict, row_id: str, changes: dict, *, by: str) -> list:
    row = _row(doc, row_id)
    if row.get("is_wrapup") and "item" in changes:
        raise Refused(5, "the wrap-up row keeps its literal text")
    if "test_level" in changes and changes["test_level"] not in mm_schema.TEST_LEVELS:
        raise Refused(6, f"test level {changes['test_level']!r} is not one of {', '.join(mm_schema.TEST_LEVELS)}")
    edit = {}
    for key, value in changes.items():
        field_name = _ROW_TEXT_FIELDS.get(key, key)
        if isinstance(value, str):
            _single_line(key, value)
        if row.get(field_name) != value:
            edit[field_name] = [row.get(field_name), value]
            row[field_name] = value
    if edit:
        row.pop("row_verbatim", None)
        row.pop("raw_line", None)
        row.setdefault("history", []).append({"at": _now_iso(), "by": by, "edit": edit})
    return sorted(edit)


def move_row(doc: dict, row_id: str, *, before: str = None, after: str = None) -> None:
    rows = doc.get("rows", [])
    row = _row(doc, row_id)
    anchor = _row(doc, before or after)
    if row.get("is_wrapup"):
        raise Refused(5, "the wrap-up row stays last")
    if anchor is row:
        raise Refused(5, "a row cannot move relative to itself")
    if after and anchor.get("is_wrapup"):
        raise Refused(5, "no row goes after the wrap-up row")
    rows.remove(row)
    at = rows.index(anchor)
    rows.insert(at if before else at + 1, row)


def split_row(doc: dict, row_id: str, items: list, reason: str, *, by: str) -> list:
    rows = doc.get("rows", [])
    parent = _row(doc, row_id)
    if parent.get("is_wrapup") or parent.get("state") in TERMINAL:
        raise Refused(5, f"row {row_id} is the wrap-up row or already {parent.get('state')}; it cannot be split")
    children = []
    for item in items:
        child = make_row(next_row_id({"rows": _all_rows(doc) + children}), item, owner=parent.get("owner"),
                         target_date=parent.get("target_date"), test_level=parent.get("test_level"))
        if child["is_wrapup"]:
            raise Refused(5, "a split child cannot be the wrap-up row")
        child["history"].append({"at": _now_iso(), "by": by, "note": f"split from {row_id}"})
        children.append(child)
    ids = [c["id"] for c in children]
    _abandon(doc, row_id, f"split into {', '.join(ids)}: {reason}", by=by)
    at = rows.index(parent) + 1
    rows[at:at] = children
    return ids


def _abandon(doc: dict, row_id: str, reason: str, *, by: str) -> None:
    try:
        set_row_state(doc, row_id, "ABANDONED", by=by, reason=reason, blocked=False)
    except IllegalTransition as exc:
        raise Refused(5, str(exc))
    find_row(doc, row_id)["blocked_reason"] = ""  # a blocked row's reason stays in its history


def retire_row(doc: dict, row_id: str, reason: str, *, by: str) -> None:
    row = _row(doc, row_id)
    if row.get("is_wrapup"):
        raise Refused(5, "the wrap-up row cannot be retired")
    if not reason.strip():
        raise Refused(5, "retire-row needs a reason")
    _abandon(doc, row_id, reason, by=by)


def _decision(doc: dict, qid: str) -> dict:
    found = next((d for d in doc.get("decisions", []) if isinstance(d, dict) and d.get("qid") == qid), None)
    if found is None:
        raise Refused(4, f"no decision {qid!r}")
    return found


def add_decision(doc: dict, *, status: str, source: str, date: str, who: str, decision: str, why: str,
                 alternatives: str = None) -> str:
    if status not in mm_schema.DECISION_STATUSES:
        raise Refused(6, f"decision status {status!r} is not one of {', '.join(mm_schema.DECISION_STATUSES)}")
    fields = {"status": status, "source": source, "date": date, "who": who, "decision": decision, "why": why}
    if alternatives is not None:
        fields["alternatives"] = alternatives
    for key, value in fields.items():
        _single_line(key, value)
    numbers = [int(d["qid"][1:]) for d in _all_decisions(doc) if re.fullmatch(r"Q\d+", str(d.get("qid", "")))]
    qid = f"Q{max(numbers, default=0) + 1}"
    body = [f"- **{key.capitalize()}:** {value}" for key, value in fields.items()]
    doc.setdefault("decisions", []).append(
        {"qid": qid, "header_sep": ": ", "question": decision, "body_lines": body, "sep_after": False, **fields})
    return qid


def _set_decision_status(d: dict, status: str) -> None:
    d["status"] = status
    lines = d.get("body_lines")
    if lines is None:
        return
    for i, line in enumerate(lines):
        if re.match(r"^-\s+\*\*Status:\*\*", line):
            lines[i] = f"- **Status:** {status}"
            return
    lines.insert(0, f"- **Status:** {status}")


def _add_decision_line(d: dict, line: str) -> None:
    if d.get("body_lines") is None:
        d["body_lines"] = [f"- **{k.capitalize()}:** {d.get(k, '')}"
                           for k in ("status", "source", "date", "who", "decision", "why")]
    d["body_lines"].append(line)


def supersede_decision(doc: dict, qid: str, by_qid: str, reason: str) -> None:
    old, new = _decision(doc, qid), _decision(doc, by_qid)
    _single_line("reason", reason)
    if old is new:
        raise Refused(5, "a decision cannot supersede itself")
    if old.get("status") == "SUPERSEDED":
        raise Refused(5, f"{qid} is already superseded")
    _set_decision_status(old, "SUPERSEDED")
    _add_decision_line(old, f"- Superseded by {by_qid}: {reason}")
    _add_decision_line(new, f"- Supersedes {qid}")


def set_field(doc: dict, name: str, value: str) -> str:
    """Replace one Section 0A value. Returns a warning, or ""."""
    if name not in mm_schema.FIELDS:
        raise Refused(6, f"{name!r} is not a Section 0A field")
    _single_line(name, value)
    allowed = mm_schema.ALLOWED.get(name)
    if allowed and value.strip().lower() not in allowed:
        raise Refused(6, f"{name} must be one of {', '.join(sorted(allowed))}; got {value!r}")
    if len(value) > mm_schema.FIELD_FAIL_CHARS:
        raise Refused(6, f"{name} is {len(value)} chars; the cap is {mm_schema.FIELD_FAIL_CHARS}")
    doc["dashboard_index"][name] = value
    if name == "Task":
        doc["passthrough"]["title_line"] = f"# HANDOFF — {value}"
    if len(value) > mm_schema.FIELD_WARN_CHARS:
        return f"warning: {name} is {len(value)} chars; keep Section 0A values under {mm_schema.FIELD_WARN_CHARS}"
    return ""


def set_0b_field(doc: dict, name: str, value: str) -> None:
    if name not in mm_schema.SECTION_0B_FIELDS:
        raise Refused(6, f"{name!r} is not a Section 0B field; use one of: {', '.join(mm_schema.SECTION_0B_FIELDS)}")
    line = f"**{name}:** {value}"
    lines = (doc["passthrough"].get("section_0b_md") or "").split("\n")
    prefix = f"**{name}:**"
    for i, existing in enumerate(lines):
        if existing.startswith(prefix):
            lines[i] = line
            break
    else:
        lines = lines + ["", line] if any(lines) else [line]
    doc["passthrough"]["section_0b_md"] = "\n".join(lines)


def archive(doc: dict, *, keep_done: int, keep_decisions: int) -> tuple:
    rows = doc.get("rows", [])
    closed = [r for r in rows if r.get("state") in TERMINAL and not r.get("is_wrapup")]
    move_rows = closed[:max(len(closed) - keep_done, 0)]
    decisions = doc.get("decisions", [])
    final = [d for d in decisions if isinstance(d, dict) and d.get("status") in ("FINAL", "SUPERSEDED")]
    move_decisions = final[:max(len(final) - keep_decisions, 0)]
    if move_rows or move_decisions:
        store = doc.setdefault("archive", {"file": "HANDOFF-archive.md", "rows": [], "decisions": []})
        store.setdefault("rows", []).extend(move_rows)
        store.setdefault("decisions", []).extend(move_decisions)
        doc["rows"] = [r for r in rows if not any(r is m for m in move_rows)]
        doc["decisions"] = [d for d in decisions if not any(d is m for m in move_decisions)]
    return [r.get("id") for r in move_rows], [d.get("qid") for d in move_decisions]
