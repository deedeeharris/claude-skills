"""mm.py row, decision, field and section operations (also the batch operations), batch and scaffold.
"""

import copy
import json
import os
import pathlib
import re
import subprocess

import mm_atomic
import mm_compile
import mm_gates
import mm_ledger
import mm_rows
import mm_schema
from mm_cli import (
    BATCH_OPS, CliError, PARSER, TEMPLATES, _commit, _guard, _load, _now, _resolve_files, _save_and_render,
    _stamp, _task_dir, _write,
)


def op_add_row(args, doc):
    return mm_rows.add_row(doc, args.item, user_facing=True if args.user_facing else None,
                             test_level=args.test_level, pr=args.pr, test_page=args.test_page, owner=args.owner,
                             target_date=args.target_date, notes=args.notes)


def op_edit_row(args, doc):
    changes = {k: getattr(args, k) for k in ("item", "notes", "owner", "target_date", "pr", "test_page", "test_level")
               if getattr(args, k) is not None}
    if args.user_facing is not None:
        changes["user_facing"] = args.user_facing
    if not changes:
        raise CliError(2, "edit-row needs at least one field to change")
    changed = mm_rows.edit_row(doc, args.id, changes, by="mm.py edit-row")
    return f"{args.id} {', '.join(changed) or 'unchanged'}"


def op_move_row(args, doc):
    mm_rows.move_row(doc, args.id, before=args.before, after=args.after)
    return f"{args.id} {'before ' + args.before if args.before else 'after ' + args.after}"


def op_split_row(args, doc):
    if len(args.item) < 2:
        raise CliError(2, "split-row needs at least two --item values")
    ids = mm_rows.split_row(doc, args.id, args.item, args.reason, by="mm.py split-row")
    return f"{args.id} into {', '.join(ids)}"


def op_retire_row(args, doc):
    row = mm_rows._row(doc, args.id)
    if row.get("state") == "ABANDONED" and (args.reason or "").strip():
        recorded = next((h.get("reason") for h in reversed(row.get("history") or [])
                         if isinstance(h, dict) and h.get("to") == "ABANDONED"), None)
        if args.reason != recorded:
            raise CliError(2, f"row {args.id} is already ABANDONED" + (f" with the reason {recorded!r}" if recorded
                              else "") + "; retire-row records only a change of state, so --reason would be "
                              "dropped; nothing written. Record a decision with add-decision, or reword the row's "
                              "note with edit-row --notes")
    mm_rows.retire_row(doc, args.id, args.reason or "", by="mm.py retire-row")
    return f"{args.id} ABANDONED"


def _refuse_same_state(args, row) -> None:
    """set-row to the row's current state records nothing, so refuse every option supplied (even empty) that it
    would drop; a blocked row's --reason is not dropped: it replaces the blocked reason."""
    if row.get("state") != args.state:
        return
    dropped = [f"--{k}" for k in ("note", "evidence", "reason") if getattr(args, k) is not None
               and not (k == "reason" and args.state == "NEEDS_DECISION")]
    dropped += ["--verify"] if args.verify else []
    if dropped:
        raise CliError(2, f"row {args.id} is already {args.state}: set-row records only a change of state, so "
                          f"{', '.join(dropped)} would be dropped; nothing written. Record a decision with "
                          "add-decision, or reword the row's note with edit-row --notes")


def _set_blocked_reason(row, was_blocked: bool, reason, by: str) -> None:
    """Set the reason of a row now blocked. The move into NEEDS_DECISION records its reason in history; a reason
    that replaces the one of a row already blocked is recorded as an edit, as edit-row records a change, so the
    reason an unblock or a retirement later clears stays in the history."""
    if was_blocked and reason is None:
        return
    old, new = row.get("blocked_reason", ""), reason or ""
    if was_blocked and old != new:
        row.setdefault("history", []).append({"at": mm_ledger._now_iso(), "by": by,
                                              "edit": {"blocked_reason": [old, new]}})
    row["blocked_reason"] = new


def op_set_row(args, doc):
    row = mm_rows._row(doc, args.id)
    was_blocked = row.get("state") == "NEEDS_DECISION"
    _refuse_same_state(args, row)
    blocked = True if args.state == "NEEDS_DECISION" else (False if was_blocked else None)
    try:
        mm_ledger.set_row_state(doc, args.id, args.state, by="mm.py set-row", note=args.note or "",
                                blocked=blocked, evidence=args.evidence, reason=args.reason)
    except mm_ledger.IllegalTransition as exc:
        raise CliError(5, f"{exc}" + (f"; evidence: {args.evidence}" if args.evidence else ""))
    if args.state == "NEEDS_DECISION":
        _set_blocked_reason(row, was_blocked, args.reason, "mm.py set-row")
    elif was_blocked:
        row["blocked_reason"] = ""
    return f"{args.id} {args.state}"


def op_mark_row(args, doc):
    row = mm_rows._row(doc, args.id)
    if args.blocked:
        was_blocked = row.get("state") == "NEEDS_DECISION"
        mm_ledger.set_row_state(doc, args.id, "NEEDS_DECISION", by="mm.py mark-row", blocked=True,
                                reason=args.reason)
        _set_blocked_reason(row, was_blocked, args.reason, "mm.py mark-row")
        return f"{args.id} blocked"
    if row.get("state") != "NEEDS_DECISION":
        raise CliError(5, f"row {args.id} is not blocked")
    entered = [h for h in row.get("history", []) if h.get("to") == "NEEDS_DECISION"]
    previous = entered[-1].get("from") if entered else None
    target = previous if previous in mm_ledger.ALLOWED_TRANSITIONS["NEEDS_DECISION"] else "BACKLOG"
    mm_ledger.set_row_state(doc, args.id, target, by="mm.py mark-row", blocked=False, reason=args.reason)
    row["blocked_reason"] = ""
    return f"{args.id} unblocked to {target}"


def op_add_decision(args, doc):
    return mm_rows.add_decision(doc, status=args.status, source=args.source, date=args.date, who=args.who,
                                  decision=args.decision, why=args.why, alternatives=args.alternatives)


def op_supersede_decision(args, doc):
    mm_rows.supersede_decision(doc, args.qid, args.by, args.reason)
    return f"{args.qid} by {args.by}"


def op_set_field(args, doc):
    if args.section is not None:
        if args.section != "0b":
            raise CliError(6, "--section takes 0b; Section 0A fields need no --section")
        mm_rows.set_0b_field(doc, args.field, args.value)
        return f"0b {args.field}"
    if args.field == "Last updated":
        raise CliError(6, "Last updated is stamped by every mm.py write")
    warning = mm_rows.set_field(doc, args.field, args.value)
    if warning:
        args.warnings.append(warning)
    return args.field


def op_set_section(args, doc):
    args.id = args.id.strip()
    if args.id not in mm_compile.TEXT_SECTIONS:
        raise CliError(6, f"section {args.id!r} is not a text section; use one of "
                          f"{', '.join(mm_compile.TEXT_SECTIONS)} (mm.py sections lists them)")
    text = args.text.strip("\n")
    for line in text.split("\n"):
        if mm_compile.is_section_heading(line) or line.strip() == mm_schema.GENERATED_HEADER:
            raise CliError(6, f"section text may not contain the structural line {line!r}")
    doc["passthrough"][mm_compile.TEXT_SECTIONS[args.id]] = text
    return args.id


def op_archive(args, doc):
    rows, decisions = mm_rows.archive(doc, keep_done=args.keep_done, keep_decisions=args.keep_decisions)
    archive_text = mm_compile.compile_archive(doc) or ""
    moved = [r for r in (doc.get("archive") or {}).get("rows", []) if r.get("id") in rows]
    lost = [r.get("id") for r in moved if mm_compile.escape_cell(r.get("item", "")) not in archive_text]
    lost += [q for q in decisions if f"### {q}" not in archive_text]
    if lost:
        raise CliError(1, f"archive would lose {', '.join(lost)}; nothing written")
    return f"rows {', '.join(rows) or 'none'}; decisions {', '.join(decisions) or 'none'}"


# ---------------------------------------------------------------- command handlers

def cmd_write(args) -> int:
    apply = args.apply_op
    if args.command == "set-row" and args.verify:
        if args.evidence is not None:
            raise CliError(2, "set-row takes --verify or --evidence, not both: --verify records its own run as the "
                              "evidence, so --evidence would be dropped; nothing run, nothing written")
        apply = _verify_then_set_row
    if args.command == "archive" and not args.apply:
        return _archive_dry_run(args)
    return _write(args, args.command, lambda doc: _guard(apply, args, doc), args.warnings)


def _verify_then_set_row(args, doc):
    """Run under the ledger lock that _write holds for the whole write, so the state the same-state refusal reads is
    the state the write changes, and a refused request never runs its --verify command."""
    _refuse_same_state(args, mm_rows._row(doc, args.id))
    args.evidence = _run_verify(args.verify_argv)
    return op_set_row(args, doc)


def _run_verify(argv) -> str:
    if not argv:
        raise CliError(2, "--verify needs the command after --, for example --verify -- python -m unittest")
    try:
        checks = mm_gates.gate_command_exits_zero("verify", argv, cwd=os.getcwd())
    except OSError as exc:
        raise CliError(5, f"verify command could not start: {exc}")
    m = re.match(r"exit=(-?\d+)", checks[0]["note"])
    if not m:
        raise CliError(5, f"verify command did not finish: {checks[0]['note'][:200]}")
    shown = subprocess.list2cmdline(argv).replace("\r", " ").replace("\n", "\\n")
    return f"run by mm: {shown} exit:{m.group(1)}"


def _archive_dry_run(args) -> int:
    doc = _load(_task_dir(args))
    rows, decisions = mm_rows.archive(copy.deepcopy(doc), keep_done=args.keep_done,
                                        keep_decisions=args.keep_decisions)
    if not rows and not decisions:
        print("nothing to archive")
        return 0
    print(f"dry run: archive would move rows {', '.join(rows) or 'none'} and decisions "
          f"{', '.join(decisions) or 'none'} to HANDOFF-archive.md; rerun with --apply")
    return 0


def cmd_batch(args) -> int:
    try:
        ops = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CliError(2, f"cannot read batch file {args.file}: {exc}")
    if not isinstance(ops, list) or not ops:
        raise CliError(2, "a batch file holds a non-empty JSON array of operations")
    parsed = []
    for n, op in enumerate(ops, 1):
        if not isinstance(op, dict) or op.get("op") not in BATCH_OPS:
            raise CliError(2, f"op {n}: 'op' must be one of {', '.join(BATCH_OPS)}")
        argv = [op["op"], "--task-dir", args.task_dir]
        for key, value in op.items():
            if key == "op":
                continue
            if key in ("task_dir", "dry_run", "verify", "apply", "no_commit"):
                raise CliError(2, f"op {n}: {key!r} is not allowed inside a batch")
            flag = "--" + key.replace("_", "-")
            values = value if isinstance(value, list) else [value]
            for v in values:
                if v is True:
                    argv.append(flag)
                elif v is not False and v is not None:
                    argv.append(f"{flag}={v}")
        try:
            sub = PARSER[0].parse_args(argv)
        except SystemExit:
            raise CliError(2, f"op {n} ({op['op']}): invalid arguments")
        sub.warnings = args.warnings
        _resolve_files(sub)
        parsed.append(sub)

    def apply(doc):
        for n, sub in enumerate(parsed, 1):
            try:
                _guard(sub.apply_op, sub, doc)
            except CliError as exc:
                raise CliError(exc.code, f"op {n} ({sub.command}): {exc}")
        return f"{len(parsed)} ops"

    return _write(args, "batch", apply, args.warnings)


def cmd_scaffold(args) -> int:
    task_dir = _task_dir(args)
    if task_dir.exists():
        raise CliError(4, f"{task_dir} exists; scaffold only creates a new task folder")
    now = _now()
    doc = mm_ledger.new_ledger(args.task, args.project)
    parts = task_dir.parent.parts
    doc["pm_root"] = "/".join(parts[parts.index(".private"):]) if ".private" in parts else task_dir.parent.as_posix()
    doc["passthrough"]["section_0b_md"] = "\n\n".join(
        f"**{name}:** none" for name in mm_schema.SECTION_0B_FIELDS if name != "Last updated")
    rows = []
    try:
        for item in args.row or []:
            rows.append(mm_rows.make_row(mm_rows.next_row_id({"rows": rows}), item))
        rows.append(mm_rows.make_row(mm_rows.next_row_id({"rows": rows}), mm_schema.WRAPUP_LITERAL, owner="PM",
                                       notes="last row: run the closing ritual (mm.py close)"))
    except mm_ledger.Refused as exc:
        raise CliError(exc.code, str(exc))
    if sum(1 for r in rows if r["is_wrapup"]) != 1:
        raise CliError(5, "a --row may not be the wrap-up literal; scaffold adds the wrap-up row itself")
    doc["rows"] = rows
    _stamp(doc, now)
    if args.dry_run:
        print(f"dry run: scaffold {task_dir} with rows {', '.join(r['id'] for r in rows)}; nothing written")
        return 0
    task_dir.mkdir(parents=True)
    (task_dir / "inbox" / "processed").mkdir(parents=True)
    (task_dir / "prompts").mkdir()
    with mm_ledger.hold_lock(task_dir):
        _save_and_render(task_dir, doc, 0, "scaffold", now)
    extra = [
        (task_dir / "insights.md", (TEMPLATES / "insights.md").read_text(encoding="utf-8").replace("<TASK>", args.task)),
        (task_dir / "inbox" / "README.md", (TEMPLATES / "inbox-README.md").read_text(encoding="utf-8")),
        (task_dir / "inbox" / "processed" / ".gitkeep", ""),
        (task_dir / "prompts" / "README.md", (TEMPLATES / "prompts-README.md").read_text(encoding="utf-8")),
    ]
    mm_atomic.atomic_write_many(extra)
    print(f"MM-SCAFFOLD-OK {task_dir}")
    return _commit(args, task_dir, f"scaffold {args.task}", [task_dir])
