"""Repair stages 1, 2 and 4 on an in-memory copy of a ledger: missing top-level keys, rounds as a list, foreign
row and decision shapes, missing or null row keys, invented and unknown states, illegal state/blocked pairs, the
wrap-up row, off-enum Section 0A values, bare-date updated and the wrap-up order. Also the Plan that records each
class and asks a numbered question where a choice is ambiguous.
"""

import datetime
import re

import mm_compile
import mm_ledger
import mm_rows
import mm_schema


INVENTED_STATES = {"NEEDS_FIX": "IMPLEMENTING", "IN_PROGRESS": "IMPLEMENTING", "IN PROGRESS": "IMPLEMENTING",
                   "TODO": "BACKLOG"}


_ROW_DEFAULTS = (("item", ""), ("state", "BACKLOG"), ("blocked_reason", ""), ("owner", ""), ("target_date", ""),
                 ("notes_md", ""), ("history", None))


class RepairError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


class Question:
    def __init__(self, n, key, text, options, recommended, answer):
        self.n, self.key, self.text = n, key, text
        self.options, self.recommended, self.answer = options, recommended, answer

    def render(self) -> str:
        state = f"answered: {self.answer}" if self.answer else f"answer with --decide {self.n}={self.recommended}"
        return (f"QUESTION {self.n} [{self.key}]: {self.text}\n  options: {', '.join(self.options)} "
                f"(recommended: {self.recommended})\n  {state}")


class Plan:
    def __init__(self, decide: dict):
        self.decide = decide
        self.questions = []
        self.classes = {}
        self.doc = None

    def ask(self, key, text, options, recommended):
        n = len(self.questions) + 1
        answer = self.decide.get(n)
        if answer is not None and answer not in options:
            raise RepairError(2, f"--decide {n}={answer}: question {n} takes one of {', '.join(options)}")
        self.questions.append(Question(n, key, text, list(options), recommended, answer))
        return answer

    def note(self, name, what) -> None:
        self.classes.setdefault(name, []).append(str(what))

    @property
    def unanswered(self) -> list:
        return [q for q in self.questions if q.answer is None]

    def report(self) -> list:
        return [f"REPAIR {name}: {len(items)} ({', '.join(items)})" for name, items in self.classes.items()]


def _now():
    return datetime.datetime.now().astimezone().replace(microsecond=0)


def _history(row, frm, to, note):
    row.setdefault("history", []).append({"at": _now().isoformat(), "from": frm, "to": to, "by": "mm.py repair",
                                          "note": note, "evidence": "", "reason": ""})


def _set_state(row, state, note):
    frm = row.get("state")
    row["state"], row["blocked"] = state, state == "NEEDS_DECISION"
    row["status_label"] = mm_schema.STATUS_LABELS[state]
    row["status_glyph_present"] = True
    row.pop("row_verbatim", None)
    row.pop("raw_line", None)
    _history(row, frm, state, note)


def _unverify(row, why) -> str:
    """Move a green that repair cannot prove to REVIEW, marked as needing
    verification; DONE then needs the normal evidence path again."""
    green = row["state"]
    _set_state(row, "REVIEW", f"{why}; {green} is not proven, so /mm repair moved it to REVIEW - verify it with "
                              "set-row --verify, or set DONE with --evidence")
    row["history"][-1]["unverified"] = True
    return f"{row.get('id')} {green} -> REVIEW"


def _rows(doc) -> list:
    return [r for r in doc.get("rows", []) if isinstance(r, dict)]


def _next_number(ids, prefix) -> str:
    numbers = [int(m.group(1)) for i in ids for m in [re.fullmatch(re.escape(prefix) + r"(\d+)", str(i))] if m]
    return f"{prefix}{max(numbers, default=0) + 1}"


def _top_level(doc, plan) -> None:
    idx = doc.get("dashboard_index") if isinstance(doc.get("dashboard_index"), dict) else {}
    defaults = mm_ledger.new_ledger(idx.get("Task", ""), idx.get("Project", "unknown"))
    for key, value in defaults.items():
        if key not in doc:
            doc[key] = value
            plan.note("missing-top-keys", key)
    if isinstance(doc.get("rounds"), list):
        plan.note("rounds-list", f"{len(doc['rounds'])} entries -> rounds.history")
        doc["rounds"] = {"max_rounds": 3, "rubric_sha256": "", "residual": [], "history": doc["rounds"]}


def _foreign_row(row, rid, plan) -> None:
    if "title" not in row and "due" not in row:
        return
    legacy = row.get("legacy") if isinstance(row.get("legacy"), dict) else {}
    if "title" in row:
        title = row["title"]
        if row.get("item") not in (None, "", title):
            answer = plan.ask(f"title:{rid}", f"row {rid} has the item {row['item']!r} and the title {title!r}; "
                                              "which is the row's text? (the other is kept under legacy)",
                              ["item", "title"], "item")
            if answer is None:
                return
            if answer == "title":
                legacy["item"] = row["item"]
                row["item"] = title
        else:
            row["item"] = title
        legacy["title"] = row.pop("title")
    if "due" in row:
        due = row.pop("due")
        legacy["due"] = due
        if not row.get("target_date"):
            row["target_date"] = due
    row["legacy"] = legacy
    plan.note("foreign-row-shape", rid)


def _row_shape(doc, plan) -> None:
    ids = [r.get("id") for r in _rows(doc)]
    for i, row in enumerate(_rows(doc)):
        rid = row.get("id") or f"rows[{i}]"
        keys = ("id",) + tuple(k for k, _ in _ROW_DEFAULTS) + ("blocked", "status_label", "is_wrapup")
        nulls = [key for key in keys if key in row and row[key] is None]
        for key in nulls:
            del row[key]
        if nulls:
            plan.note("null-row-values", f"{rid} ({' '.join(nulls)})")
        _foreign_row(row, rid, plan)
        missing = [key for key in keys if key not in row and key not in nulls]
        if "id" not in row:
            row["id"] = rid = _next_number(ids, "#")
            ids.append(rid)
        for key, value in _ROW_DEFAULTS:
            row.setdefault(key, [] if value is None else value)
        state = row["state"]
        if state in INVENTED_STATES:
            _set_state(row, INVENTED_STATES[state], f"invented state {state!r}")
            plan.note("invented-state", f"{rid} {state} -> {row['state']}")
        elif state not in mm_schema.STATES:
            guess = next((s for k, s, _ in mm_compile._FALLBACK_KEYWORDS if k in str(state).lower()), "BACKLOG")
            answer = plan.ask(f"state:{rid}", f"row {rid} has the unknown state {state!r}; which state is it?",
                              mm_schema.STATES, guess)
            if answer:
                _set_state(row, answer, f"unknown state {state!r}, operator chose {answer}")
                plan.note("unknown-state", f"{rid} {state} -> {answer}")
        row.setdefault("blocked", row["state"] == "NEEDS_DECISION")
        row.setdefault("status_label", mm_schema.STATUS_LABELS.get(row["state"], ""))
        if missing:
            plan.note("missing-row-keys", f"{rid} ({' '.join(missing)})")


def _decision_shape(doc, plan) -> None:
    decisions = [d for d in doc.get("decisions", []) if isinstance(d, dict)]
    taken = [d["qid"] for d in decisions if d.get("qid")]
    for d in decisions:
        if "qid" in d:
            if "status" not in d:
                d["status"] = "IMPORTED"
                plan.note("decision-status-missing", d["qid"])
            continue
        qid = str(d.get("id") or _next_number(taken, "D"))
        if qid in taken:
            answer = plan.ask(f"qid:{qid}", f"the decision id {qid} (decided {d.get('decision', '')[:60]!r}) "
                                            "collides with another decision; give it the next free id?",
                              ["renumber", "keep"], "renumber")
            if answer is None:
                continue
            if answer == "renumber":
                qid = _next_number(taken, re.sub(r"\d+$", "", qid) or "D")
        taken.append(qid)
        text = str(d.get("decision") or d.get("question") or "")
        fields = {"status": d.get("status") or "IMPORTED", "source": str(d.get("provenance") or d.get("source") or ""),
                  "date": str(d.get("at") or d.get("date") or "")[:10], "who": str(d.get("by") or d.get("who") or ""),
                  "decision": text, "why": str(d.get("why") or "")}
        d.update({"qid": qid, "header_sep": ": ", "question": text, "sep_after": False, **fields})
        if not isinstance(d.get("body_lines"), list):
            d["body_lines"] = [f"- **{mm_compile.DECISION_FIELD_LABELS[k]}:** {v}" for k, v in fields.items() if v]
        plan.note("foreign-decision-shape", qid)


def _pairs(doc, plan) -> None:
    for row in _rows(doc):
        state, blocked, rid = row.get("state"), row.get("blocked"), row.get("id")
        if state not in mm_schema.STATES or not isinstance(blocked, bool) or mm_ledger._state_blocked_ok(state, blocked):
            continue
        if state == "NEEDS_DECISION":
            row["blocked"] = True
            plan.note("state-blocked-pair", f"{rid} NEEDS_DECISION blocked false -> true")
        elif state not in mm_schema.TERMINAL:
            _set_state(row, "NEEDS_DECISION", f"{state} was blocked")
            plan.note("state-blocked-pair", f"{rid} {state} blocked -> NEEDS_DECISION")
        else:
            answer = plan.ask(f"pair:{rid}", f"row {rid} is {state} and blocked; keep it {state} and unblock it, "
                                             "or make it NEEDS_DECISION?", ["unblock", "needs-decision"], "unblock")
            if answer == "unblock":
                row["blocked"] = False
            elif answer == "needs-decision":
                _set_state(row, "NEEDS_DECISION", f"{state} was blocked; operator chose NEEDS_DECISION")
            if answer:
                plan.note("state-blocked-pair", f"{rid} {state} blocked -> {answer}")


def _wrapup(doc, plan) -> None:
    rows = _rows(doc)
    for row in rows:
        if not isinstance(row.get("is_wrapup"), bool):
            row["is_wrapup"] = mm_schema.is_wrapup_item(str(row.get("item", "")))
    flagged = [r for r in rows if r["is_wrapup"]]
    if not flagged:
        if plan.ask("wrapup-missing", "no row is the wrap-up row; add it at the end?", ["add", "skip"], "add") == "add":
            row = mm_rows.make_row(_next_number([r.get("id") for r in rows], "#"), mm_schema.WRAPUP_LITERAL,
                                     owner="PM", notes="last row: run the closing ritual (mm.py close)")
            doc["rows"].append(row)
            plan.note("wrapup-added", row["id"])
    elif len(flagged) > 1:
        ids = [r["id"] for r in flagged]
        keep = plan.ask("wrapup-duplicate", f"rows {', '.join(ids)} are all wrap-up rows; which one stays the "
                                            "wrap-up row? (the others become normal rows)", ids, ids[-1])
        if keep:
            for row in flagged:
                row["is_wrapup"] = row["id"] == keep
            plan.note("wrapup-duplicate", f"kept {keep}")


def _fields(doc, plan) -> None:
    idx = doc["dashboard_index"]
    for name in mm_schema.FIELDS:
        if name not in idx:
            idx[name] = {"Task": doc.get("task", ""), "Project": doc.get("project", "")}.get(
                name, mm_schema.FIELD_DEFAULTS[name])
            plan.note("0a-field-missing", name)
    for name, allowed in mm_schema.ALLOWED.items():
        value = str(idx.get(name, ""))
        if value.strip().lower() in allowed:
            continue
        options = sorted(allowed)
        recommended = "unknown" if "unknown" in allowed else mm_schema.FIELD_DEFAULTS[name]
        answer = plan.ask(f"0a:{name}", f"Section 0A {name} is {value!r}, which is not one of {', '.join(options)}; "
                                        "which value replaces it?", options, recommended)
        if answer:
            idx[name] = answer
            plan.note("0a-off-enum", f"{name} {value!r} -> {answer}")


def _order(doc, plan) -> None:
    rows = doc.get("rows", [])
    at = next((i for i, r in enumerate(rows) if isinstance(r, dict) and r.get("is_wrapup")), None)
    if at is not None and at != len(rows) - 1:
        row = rows.pop(at)
        rows.append(row)
        plan.note("wrapup-not-last", f"{row.get('id')} moved to the end")


def _mend_breaks(row, message) -> None:
    """Record repair as the origin right before every move that starts where
    the row was not, so the walk reaches the entries after the break. A move
    without a from or to state gets no origin: the row's place after it is
    unknown, and the next move's origin starts at the last known state."""
    mended, walked, known = [], "BACKLOG", "BACKLOG"
    for entry in row.get("history") or []:
        if mm_ledger.is_move(entry) and mm_ledger.malformed_move(entry):
            walked = None
        elif mm_ledger.is_move(entry):
            if entry.get("by") not in mm_ledger.IMPORT_SOURCES and entry["from"] != walked:
                mended.append({"at": _now().isoformat(), "from": known, "to": entry["from"],
                               "by": "mm.py repair", "note": f"HISTORY-BROKEN: {message}; origin recorded by "
                               "/mm repair, not verified", "evidence": "", "reason": ""})
            walked = known = entry["to"]
        mended.append(entry)
    row["history"] = mended


def _unproven(doc, plan) -> None:
    """Rows whose state their history does not prove (a hand edit, or a
    ledger from before evidence was required): a green moves to REVIEW and
    waits for verification; any other state is kept. Either way the repair
    records itself as its origin, named in the report before --apply."""
    rows = {r.get("id"): r for r in _rows(doc)}
    mended = []
    for rid, code, message in mm_ledger.history_problems(doc):
        if code == "HISTORY-BROKEN":
            _mend_breaks(rows[rid], message)
            if rows[rid]["state"] in mm_ledger.GREEN:
                plan.note("unproven-state", _unverify(rows[rid], f"{code}: {message}") + f" ({code}), needs "
                                            "verification")
            else:
                mended.append(rid)
    problems = mm_ledger.history_problems(doc)
    for rid in mended:
        if all(rid != other for other, _, _ in problems):
            plan.note("unproven-state", f"{rid} {rows[rid]['state']} (HISTORY-BROKEN) kept, origin recorded by "
                                        "/mm repair")
    for rid, code, message in problems:
        row = rows[rid]
        if row["state"] in mm_ledger.GREEN:
            plan.note("unproven-state", _unverify(row, f"{code}: {message}") + f" ({code}), needs verification")
            continue
        recorded = next((h["to"] for h in reversed(row.get("history") or [])
                         if mm_ledger.is_move(h) and not mm_ledger.malformed_move(h)), "BACKLOG")
        _history(row, recorded, row["state"], f"{code}: {message}; kept by /mm repair, not verified - re-verify "
                                              "it or move it back with set-row")
        plan.note("unproven-state", f"{rid} {row['state']} ({code}) kept without evidence")


def _dates(doc, plan) -> None:
    updated = doc.get("updated")
    if isinstance(updated, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", updated):
        doc["updated"] = updated + "T00:00:00"
        plan.note("bare-date-updated", f"{updated} -> {doc['updated']}")
