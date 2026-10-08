"""Repair stage 3: drift between ledger.json and HANDOFF.md, entity by entity (rows by id, decisions by qid,
Section 0A fields by name, text sections by id). The side with the later date wins where both hold an entity; the
newer side's extra ids are taken (the absorb stage when HANDOFF.md is newer); the older side's extra ids are a
question for the operator.
"""

import copy
import re

import mm_compile
import mm_ledger
import mm_rows
import mm_schema
from mm_repair_shape import _history, _next_number, _rows, _unverify


_LABEL_STATE = {label: state for state, label in mm_schema.STATUS_LABELS.items()}


_STAMP_RE = re.compile(r"(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?")


_TEXT_KEYS = {"1-preamble": "section_1_preamble_md", "1-postamble": "section_1_postamble_md", "3": "section_3_md"}


def _stamp(value):
    m = _STAMP_RE.search(str(value or ""))
    return (m.group(1), f"{m.group(2) or '00'}:{m.group(3) or '00'}") if m else None


def _text_views(doc) -> dict:
    pt = doc.get("passthrough", {})
    views = {"title": pt.get("title_line", ""),
             "0b": mm_compile._join_chunks(pt.get("section_0b_md", ""), mm_compile._render_loop(doc)),
             "4": mm_compile._join_chunks(pt.get("section_4_md", ""), mm_compile._archive_pointer(doc),
                                          pt.get("trailing_md", ""))}
    views.update({sid: pt.get(key, "") for sid, key in _TEXT_KEYS.items()})
    return views


def _handoff_views(slices) -> dict:
    views = {"title": slices["title_line"], "0b": slices["section_0b_md"], "4": slices["section_4_md"]}
    views.update({sid: slices.get(key, "") for sid, key in _TEXT_KEYS.items()})
    return views


def _keyed(items, key) -> list:
    """(key, item) pairs; a repeated key gets a ~n suffix so no item is lost."""
    seen, out = {}, []
    for item in items:
        k = str(item.get(key, ""))
        seen[k] = seen.get(k, 0) + 1
        out.append((k if seen[k] == 1 else f"{k}~{seen[k]}", item))
    return out


def _entities(doc, slices) -> dict:
    ledger = {("row", k): v for k, v in _keyed(_rows(doc), "id")}
    ledger.update({("decision", k): v for k, v in _keyed(
        [d for d in doc.get("decisions", []) if isinstance(d, dict)], "qid")})
    handoff = {("row", k): v for k, v in _keyed(slices["rows"], "id")}
    handoff.update({("decision", k): v for k, v in _keyed(slices["decisions"], "qid")})
    for side, index in ((ledger, doc.get("dashboard_index", {})), (handoff, slices["dashboard_index"])):
        side.update({("field", k): v for k, v in index.items() if k != "Last updated"})
    for side, views in ((ledger, _text_views(doc)), (handoff, _handoff_views(slices))):
        side.update({("text", k): v for k, v in views.items()})
    return ledger, handoff


def _render(kind, value) -> str:
    if kind == "row":
        return mm_compile._render_row(value)
    if kind == "decision":
        return mm_compile._render_decision(value).strip()
    return str(value).strip()


def _label(entity) -> str:
    kind, key = entity
    return key if kind in ("row", "decision") else f"{kind} {key}"


def _refined_state(hrow):
    state, blocked = hrow["state"], hrow["blocked"]
    exact = _LABEL_STATE.get(hrow.get("status_label")) if hrow.get("status_glyph_present") else None
    if exact and mm_ledger.state_to_glyph(exact, exact == "NEEDS_DECISION") == mm_ledger.state_to_glyph(state, blocked):
        return exact, exact == "NEEDS_DECISION", True
    return state, blocked, False


def _proven_move(lrow, state) -> bool:
    """True when the normal rules accept lrow's move into `state` with no
    new evidence (a proven HUMAN_VERIFIED into DONE): HANDOFF.md carries none."""
    trial = dict(lrow, state=state, history=list(lrow.get("history") or []) + [
        {"from": lrow["state"], "to": state, "by": "mm.py", "evidence": ""}])
    return not mm_ledger.history_problems({"rows": [trial]})


def _merge_row(lrow, hrow, unverified) -> dict:
    row = copy.deepcopy(lrow)
    for key in ("item", "owner", "target_date", "notes_md", "notes_trailing_pipe", "status_label",
                "status_glyph_present"):
        if key in hrow:
            row[key] = hrow[key]
    row.pop("row_verbatim", None)
    row.pop("raw_line", None)
    if hrow.get("row_verbatim"):
        row["row_verbatim"], row["raw_line"] = True, hrow["raw_line"]
    state, blocked, exact = _refined_state(hrow)
    same_glyph = mm_ledger.state_to_glyph(state, blocked) == mm_ledger.state_to_glyph(lrow["state"], lrow["blocked"])
    if exact or not same_glyph:
        row["state"], row["blocked"] = state, blocked
    if row["state"] != lrow["state"]:
        _history(row, lrow["state"], row["state"], "taken from the newer HANDOFF.md by /mm repair")
        if row["state"] in mm_ledger.GREEN and not _proven_move(lrow, row["state"]):
            unverified.append(_unverify(row, "HANDOFF.md, not an mm.py command with evidence, made it green"))
    return row


def _absorbed_row(hrow, taken, unverified) -> dict:
    row = copy.deepcopy(hrow)
    if row["id"] in taken:
        row["id"] = _next_number(taken, "#")
    row["state"], row["blocked"], _ = _refined_state(hrow)
    row["history"] = []
    _history(row, row["state"], row["state"], "absorbed from HANDOFF.md by /mm repair")
    if row["state"] in mm_ledger.GREEN:
        unverified.append(_unverify(row, "HANDOFF.md, not an mm.py command with evidence, made it green"))
    return row


def _merge_order(primary, secondary, wanted=None) -> list:
    """Items of `primary` in order; items of `secondary` that are not placed
    yet (and are in `wanted`, when given) go right after their nearest
    predecessor in `secondary` that is placed, else first."""
    out = list(primary)
    placed = {k for k, _ in out}
    previous = None
    for k, item in secondary:
        if k not in placed and (wanted is None or k in wanted):
            at = next((i + 1 for i, (pk, _) in enumerate(out) if pk == previous), 0)
            out.insert(at, (k, item))
            placed.add(k)
        if k in placed:
            previous = k
    return out


CRLF, LF = chr(13) + chr(10), chr(10)


def _drift(raw, doc, texts, plan) -> None:
    handoff = texts.get("HANDOFF.md")
    if handoff is None:
        plan.note("handoff-missing", "HANDOFF.md")
        return
    body = mm_compile.strip_generated_header(handoff).replace("\r\n", "\n")
    try:
        raw_compile = mm_compile.compile_handoff(raw)
    except Exception:
        raw_compile = None
    if body == raw_compile:
        if body == handoff.replace("\r\n", "\n"):
            plan.note("header-missing", "HANDOFF.md")
        return
    record = raw.get("compile_record") if isinstance(raw.get("compile_record"), dict) else {}
    if mm_compile.sha256_text(handoff.replace(CRLF, LF)) in {e.get("sha256") for e in record.get("HANDOFF.md", [])}:
        plan.note("ledger-ahead", "HANDOFF.md is an earlier compile")
        return
    slices = mm_compile.parse_handoff(body)
    if not slices.get("has_section_0a"):
        plan.note("ledger-ahead", "HANDOFF.md has no Section 0A; the ledger wins")
        return
    ledger, hand = _entities(doc, slices)
    differing = [e for e in ledger if e in hand and _render(e[0], ledger[e]) != _render(e[0], hand[e])]
    l_only = [e for e in ledger if e not in hand]
    h_only = [e for e in hand if e not in ledger]
    if not differing and not h_only:
        plan.note("ledger-ahead", f"the ledger holds everything HANDOFF.md shows ({len(l_only)} more ids)")
        return
    ld, hd = _stamp(raw.get("updated")), _stamp(slices["dashboard_index"].get("Last updated"))
    newer = None if not ld or not hd or ld == hd else ("ledger" if ld > hd else "handoff")
    asked_direction = False
    if newer is None and not differing and not l_only:
        newer = "handoff"
    elif newer is None:
        asked_direction = True
        newer = plan.ask("direction", f"ledger.json (updated {raw.get('updated')!r}) and HANDOFF.md (Last updated "
                                      f"{slices['dashboard_index'].get('Last updated')!r}) differ in "
                                      f"{', '.join(_label(e) for e in differing[:12]) or 'extra ids'} and the dates "
                                      "do not say which is newer. Which side is newer?",
                         ["ledger", "handoff"], "ledger")
    older = {"ledger": h_only, "handoff": l_only}.get(newer, [])
    extra = (l_only + h_only) if asked_direction else older
    keep = "keep"
    if extra:
        who = "one side" if asked_direction else ("HANDOFF.md" if newer == "ledger" else "ledger.json")
        keep = plan.ask("older-ids", f"{who} holds ids the other side lacks: "
                                     f"{', '.join(_label(e) for e in extra[:20])}. Keep them all (merge), or drop "
                                     "them (they stay in the backup)?", ["keep", "drop"], "keep")
    if newer is None or keep is None:
        return
    _resolve(doc, slices, ledger, hand, differing, h_only, l_only, newer, keep == "keep", plan)


def _resolve(doc, slices, ledger, hand, differing, h_only, l_only, newer, keep, plan) -> None:
    rows_l = _keyed(_rows(doc), "id")
    rows_h = _keyed(slices["rows"], "id")
    decs_l = _keyed([d for d in doc.get("decisions", []) if isinstance(d, dict)], "qid")
    decs_h = _keyed(slices["decisions"], "qid")
    take = {e for e in h_only if keep or newer == "handoff"}
    unverified = []
    if newer == "handoff":
        primary_rows = [(k, _merge_row(ledger[("row", k)], v, unverified) if ("row", k) in differing
                         else ledger.get(("row", k), v)) for k, v in rows_h]
        primary_decs = [(k, _merge_decision(ledger[("decision", k)], v) if ("decision", k) in differing
                         else ledger.get(("decision", k), v)) for k, v in decs_h]
        rows, decisions = _merge_order(primary_rows, rows_l), _merge_order(primary_decs, decs_l)
        for kind, key in differing + sorted(take):
            if kind == "field":
                doc["dashboard_index"][key] = hand[(kind, key)]
            elif kind == "text":
                _set_text(doc, key, hand[(kind, key)])
        if not keep:
            for kind, key in l_only:
                _drop_ledger_only(doc, ledger[(kind, key)], kind, key, plan)
        plan.note("handoff-ahead", "the newer HANDOFF.md wins for "
                  + (", ".join(_label(e) for e in differing) or "no shared entry"))
    else:
        rows = _merge_order(rows_l, rows_h, {k for kind, k in take if kind == "row"})
        decisions = _merge_order(decs_l, decs_h, {k for kind, k in take if kind == "decision"})
        for kind, key in sorted(take):
            if kind == "field":
                doc["dashboard_index"][key] = hand[(kind, key)]
        if h_only and not keep:
            plan.note("dropped-handoff-only", ", ".join(_label(e) for e in h_only))
        plan.note("ledger-ahead", "the newer ledger wins for "
                  + (", ".join(_label(e) for e in differing) or "no shared entry"))
    taken = [k for k, _ in rows_l]
    absorbed_rows, absorbed_decs, final_rows, final_decs = [], [], [], []
    for k, v in rows:
        if ("row", k) in h_only:
            v = _absorbed_row(v, taken, unverified)
            taken.append(v["id"])
            absorbed_rows.append(v["id"])
        final_rows.append(v)
    for k, v in decisions:
        if ("decision", k) in h_only:
            v = copy.deepcopy(v)
            v["status"] = v.get("status") or "IMPORTED"
            absorbed_decs.append(k)
        final_decs.append(v)
    doc["rows"] = final_rows + [r for r in doc.get("rows", []) if not isinstance(r, dict)]
    doc["decisions"] = final_decs + [d for d in doc.get("decisions", []) if not isinstance(d, dict)]
    for name, items in (("absorb-rows", absorbed_rows), ("absorb-decisions", absorbed_decs),
                        ("absorb-fields", [k for kind, k in sorted(take) if kind == "field"]),
                        ("unverified-green", unverified)):
        if items:
            plan.note(name, ", ".join(items))


def _merge_decision(ldec, hdec) -> dict:
    merged = copy.deepcopy(ldec)
    for key in ("qid", "header_sep", "question", "body_lines", "sep_after"):
        merged[key] = copy.deepcopy(hdec.get(key))
    for key in mm_compile.DECISION_FIELD_ORDER:
        if hdec.get(key):
            merged[key] = hdec[key]
    return merged


def _set_text(doc, sid, text) -> None:
    pt = doc["passthrough"]
    if sid == "title":
        pt["title_line"] = text
    elif sid == "0b":
        loop = mm_compile._render_loop(doc)
        pt["section_0b_md"] = text[: -len(loop)].rstrip("\n") if loop and text.endswith(loop) else text
    elif sid == "4":
        pointer = mm_compile._archive_pointer(doc)
        lines = [line for line in text.split("\n") if not pointer or line != pointer]
        pt["section_4_md"] = "\n".join(lines).strip("\n")
        pt["trailing_md"] = ""
    else:
        pt[_TEXT_KEYS[sid]] = text


def _drop_ledger_only(doc, item, kind, key, plan) -> None:
    if kind == "row" and item.get("state") not in mm_schema.TERMINAL and not item.get("is_wrapup"):
        mm_ledger.set_row_state(doc, item["id"], "ABANDONED", by="mm.py repair", blocked=False,
                                reason="not in the newer HANDOFF.md (/mm repair, operator chose drop)")
        plan.note("dropped-ledger-only", key)
    elif kind == "decision" and item.get("status") != "SUPERSEDED":
        mm_rows._set_decision_status(item, "SUPERSEDED")
        mm_rows._add_decision_line(item, "- Superseded by the newer HANDOFF.md (/mm repair, operator chose drop)")
        plan.note("dropped-ledger-only", key)
