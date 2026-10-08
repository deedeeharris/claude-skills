"""mm-cli: the one writer of a task's ledger.json and its generated files.

ledger.json is the only editable source. HANDOFF.md, HANDOFF-archive.md and
ROADMAP.html are generated from it and start with the generated header.
Every write runs, in order: legacy check, lock, load, hand-edit
precondition, apply, validate, caps, render, save with revision
compare-and-swap, write the generated files. The exit codes live in --help
and nowhere else.

This file is only the argument parser and the dispatcher. The commands live in
mm_cli (the shared write path), mm_cli_rows, mm_cli_state, mm_cli_repair,
mm_cli_session, mm_cli_close, mm_cli_loop (dispatch, approve-dispatch) and mm_runtime (status --json,
fence, product-changes).
"""

import argparse
import pathlib
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import mm_inbox  # noqa: E402
import mm_schema  # noqa: E402
import mm_cli  # noqa: E402
from mm_cli import (  # noqa: E402
    CliError, LEDGER_COMMANDS, LEGACY_MESSAGE, TEXT_OPTIONS, _is_legacy, _peek_task_dir, _resolve_files,
    _utf8_stdio,
)
from mm_cli_state import cmd_check, cmd_compile, cmd_prune_backups, cmd_sections  # noqa: E402
from mm_cli_rows import (  # noqa: E402
    cmd_batch, cmd_scaffold, cmd_write, op_add_decision, op_add_row, op_archive, op_edit_row, op_mark_row,
    op_move_row, op_retire_row, op_set_field, op_set_row, op_set_section, op_split_row, op_supersede_decision,
)
from mm_cli_repair import cmd_migrate, cmd_repair  # noqa: E402
from mm_cli_session import (  # noqa: E402
    cmd_bind, cmd_inbox_archive, cmd_inbox_scan, cmd_inbox_write, cmd_unbind, cmd_where, cmd_whoami,
)
from mm_cli_close import cmd_close  # noqa: E402
from mm_cli_loop import cmd_approve_dispatch, cmd_dispatch, cmd_launch_check, cmd_loop  # noqa: E402
import mm_runtime  # noqa: E402
from mm_runtime import cmd_fence, cmd_product_changes, cmd_status  # noqa: E402

VERSION = "2.0.0"

EXIT_CODES = {
    0: "ok (migrate/repair dry run: nothing to change)",
    1: "check failed, or the launch is dead",
    2: "usage error, or unknown command",
    3: "check found fixable problems (caps, structure, missing header, legacy folder); inbox problems remain",
    4: "target exists, target missing, or legacy folder refused (run /mm migrate)",
    5: "transition, evidence or row-structure change refused",
    6: "field, cap or enum refused",
    7: "ledger saved but generated files not written (run mm.py compile)",
    8: "a generated file was edited by hand, or the drift direction is unknown",
    9: "approval refused",
    10: "revision conflict, or the lock is held",
    11: "ledger invalid (run /mm repair)",
    12: "this copy is behind the canonical copy",
    13: "written, but auto-commit refused (the reason is printed); after close, rerun close --apply to commit; "
        "build_pm_dashboard.py returns it too",
    14: "dry run found changes (migrate/repair): report and unified diff printed",
    15: "an ambiguous choice needs the operator: questions printed, nothing written",
    16: "the task's worktree copies diverged: stop and ask the operator (nothing written)",
    17: "dry run (migrate/repair): the proposed result fails check; nothing written, do not apply",
    18: "a failed migrate/repair write could not be restored: copy the originals back from the named backup",
    19: "close stopped part-way: close-journal.json records the finished steps (or the message names the disk state "
        "when the journal could not be saved); rerun close --apply to finish",
    20: "close refused, or stopped before the move or the commit: the inbox holds unprocessed or malformed entries; "
        "run update or inbox-archive, then rerun",
    21: "git itself failed (dubious ownership, a corrupt index): git's first error line is printed; which worktree "
        "copy is current is unknown, so nothing written. Fix what git names, then rerun",
    22: "the approval store prompts/approvals.jsonl is unreadable or malformed: nothing written; move it aside and "
        "approve again",
}


def _text(parser, command: str, name: str, *, required=False, append=False, help=""):
    group = parser.add_mutually_exclusive_group(required=required)
    dest = name.replace("-", "_")
    action = "append" if append else "store"
    group.add_argument("--" + name, dest=dest, action=action, help=help)
    group.add_argument("--" + name + "-file", dest=dest + "_file", action=action, metavar="PATH",
                       help=f"read --{name} from a UTF-8 file (one trailing newline stripped)")
    TEXT_OPTIONS.setdefault(command, []).append(name)


def _count(text: str) -> int:
    """An argparse type: a whole number, 0 or more."""
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number")
    if value < 0:
        raise argparse.ArgumentTypeError(f"{text} is negative; give 0 or more")
    return value


def _row_fields(p, command):
    for name in ("notes", "owner", "target-date", "pr", "test-page"):
        _text(p, command, name)
    p.add_argument("--test-level", choices=None, help="one of " + ", ".join(mm_schema.TEST_LEVELS))


def build_parser() -> argparse.ArgumentParser:
    epilog = "exit codes:\n" + "\n".join(f"  {code:>2}  {text}" for code, text in EXIT_CODES.items())
    parser = argparse.ArgumentParser(prog="mm.py", description=__doc__.split("\n\n")[0], epilog=epilog,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", action="version", version=f"mm-cli {VERSION}")
    subs = parser.add_subparsers(dest="command", metavar="<command>")

    def sub(name, help, handler=cmd_write, apply_op=None, write=True):
        p = subs.add_parser(name, help=help)
        p.add_argument("--task-dir", required=True)
        if write:
            p.add_argument("--dry-run", action="store_true", help="validate and report; write nothing")
            p.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
        p.set_defaults(handler=handler, apply_op=apply_op, warnings=[], no_commit=False)
        return p

    p = sub("scaffold", "create a task folder with a ledger and its generated files", cmd_scaffold)
    p.add_argument("--task", required=True)
    p.add_argument("--project", required=True)
    _text(p, "scaffold", "row", append=True, help="a Section 1 row; repeat for more rows")

    p = sub("add-row", "insert a row before the wrap-up row", apply_op=op_add_row)
    _text(p, "add-row", "item", required=True)
    p.add_argument("--user-facing", action="store_true")
    _row_fields(p, "add-row")

    p = sub("edit-row", "reword or update a row's text fields", apply_op=op_edit_row)
    p.add_argument("--id", required=True)
    _text(p, "edit-row", "item")
    _row_fields(p, "edit-row")
    facing = p.add_mutually_exclusive_group()
    facing.add_argument("--user-facing", dest="user_facing", action="store_const", const=True, default=None)
    facing.add_argument("--not-user-facing", dest="user_facing", action="store_const", const=False)

    p = sub("move-row", "reorder a row; the wrap-up row stays last", apply_op=op_move_row)
    p.add_argument("--id", required=True)
    where = p.add_mutually_exclusive_group(required=True)
    where.add_argument("--before")
    where.add_argument("--after")

    p = sub("split-row", "replace a row by two or more rows; the parent is retired", apply_op=op_split_row)
    p.add_argument("--id", required=True)
    _text(p, "split-row", "item", required=True, append=True)
    _text(p, "split-row", "reason", required=True)

    p = sub("retire-row", "set a row ABANDONED with a reason; rows are never deleted", apply_op=op_retire_row)
    p.add_argument("--id", required=True)
    _text(p, "retire-row", "reason")

    p = sub("set-row", "change a row's state; DONE needs evidence", apply_op=op_set_row)
    p.add_argument("--id", required=True)
    p.add_argument("--state", required=True, help="one of " + ", ".join(mm_schema.STATES))
    _text(p, "set-row", "evidence", help="cmd:<command> exit:<n>, or human:<name>")
    _text(p, "set-row", "reason")
    _text(p, "set-row", "note")
    p.add_argument("--verify", action="store_true", help="run the command given after -- and record its exit code")

    p = sub("mark-row", "block or unblock a row (NEEDS_DECISION)", apply_op=op_mark_row)
    p.add_argument("--id", required=True)
    flag = p.add_mutually_exclusive_group(required=True)
    flag.add_argument("--blocked", action="store_true")
    flag.add_argument("--unblocked", action="store_true")
    _text(p, "mark-row", "reason")

    p = sub("add-decision", "append a decision with the seven decision fields", apply_op=op_add_decision)
    p.add_argument("--status", required=True, help="one of " + ", ".join(mm_schema.DECISION_STATUSES))
    p.add_argument("--date", required=True)
    for name in ("source", "who", "decision", "why"):
        _text(p, "add-decision", name, required=True)
    _text(p, "add-decision", "alternatives")

    p = sub("supersede-decision", "mark a decision SUPERSEDED by a newer one", apply_op=op_supersede_decision)
    p.add_argument("--qid", required=True)
    p.add_argument("--by", required=True)
    _text(p, "supersede-decision", "reason", required=True)

    p = sub("set-field", "replace a Section 0A value (or a named 0B line with --section 0b)",
            apply_op=op_set_field)
    p.add_argument("--field", required=True)
    p.add_argument("--section")
    _text(p, "set-field", "value", required=True)

    p = sub("set-section", "replace one text section (mm.py sections lists them)", apply_op=op_set_section)
    p.add_argument("--id", required=True)
    _text(p, "set-section", "text", required=True)

    p = sub("archive", "move DONE/ABANDONED rows and FINAL/SUPERSEDED decisions to HANDOFF-archive.md",
            apply_op=op_archive)
    p.add_argument("--keep-done", type=int, default=10)
    p.add_argument("--keep-decisions", type=int, default=20)
    p.add_argument("--apply", action="store_true")

    p = sub("batch", "apply a JSON list of operations, all or nothing", cmd_batch)
    p.add_argument("--file", required=True)

    p = sub("compile", "regenerate the generated files from the ledger", cmd_compile)
    p.add_argument("--accept-ledger", action="store_true", help="overwrite hand edits after a backup")

    sub("check", "read-only validity, drift and cap check", cmd_check, write=False)
    p = subs.add_parser("status", help="print the status block; --json prints the mm.status/1 document")
    p.set_defaults(handler=cmd_status, apply_op=None, warnings=[], no_commit=False, mm_version=VERSION)
    p.add_argument("--task-dir", help="the task; required without --json")
    p.add_argument("--session", help="--json only: the session id; alone, only its binding is read")
    p.add_argument("--json", action="store_true", help="print one mm.status/1 JSON document (exit 0)")

    p = subs.add_parser("fence", help="the PM write fence decision for the hook payload on stdin (mm.fence/1)")
    p.set_defaults(handler=cmd_fence, apply_op=None, warnings=[], no_commit=False)
    p.add_argument("--json", action="store_true", required=True)

    p = sub("product-changes", "dirty and untracked product files with fingerprints, and HEAD (mm.changes/1)",
            cmd_product_changes, write=False)
    p.add_argument("--json", action="store_true", required=True)
    p.add_argument("--baseline", metavar="FILE|-", help="a prior document (- reads stdin); adds `changed`")

    p = sub("sections", "list every rendered section and the command that writes it", cmd_sections, write=False)
    p.add_argument("--json", action="store_true")

    p = sub("prune-backups", "keep the newest backups per kind; never deletes untracked files or uncommitted changes",
            cmd_prune_backups, write=False)
    p.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
    p.add_argument("--keep", type=_count, default=mm_schema.BACKUPS_KEEP, help="backups to keep per kind, 0 or more")
    p.add_argument("--apply", action="store_true")

    p = sub("inbox-write", "write one inbox entry (six sections, timestamped name, never overwrites)",
            cmd_inbox_write, write=False)
    p.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
    p.add_argument("--source", required=True, help="a slug naming the writer, used in the file name")
    p.add_argument("--status", required=True, help="one of " + ", ".join(mm_inbox.STATUSES))
    p.add_argument("--task-ref", required=True, help="the row id, for example #3")
    for name in ("agent", "session", "started", "emitted"):
        p.add_argument("--" + name)
    _text(p, "inbox-write", "body", required=True, help="the six sections, in order")

    sub("inbox-scan", "report every inbox file that does not fit the protocol (exit 3)", cmd_inbox_scan, write=False)

    p = sub("inbox-archive", "move entries to inbox/processed/<YYYY-MM>/; never deletes", cmd_inbox_archive)
    p.add_argument("--entry", action="append", help="an inbox file name (repeatable)")
    p.add_argument("--all", action="store_true", help="every valid entry")

    sub("where", "list the task's copies across worktrees and name the canonical one", cmd_where, write=False)
    p = sub("bind", "remember this session's task", cmd_bind, write=False)
    p.add_argument("--session", required=True)
    p = subs.add_parser("whoami", help="which task: explicit path, then session binding, then branch or folder")
    p.set_defaults(handler=cmd_whoami, apply_op=None, warnings=[], no_commit=False)
    p.add_argument("--session", default="")
    p.add_argument("--task-dir", help="an explicit task path; it wins")
    p.add_argument("--repo", help="the repository to match the branch and active/ folders in")
    p.add_argument("--pattern", help="the task-ID pattern from the overlay (a regex)")
    p = subs.add_parser("unbind", help="forget this session's task")
    p.set_defaults(handler=cmd_unbind, apply_op=None, warnings=[], no_commit=False)
    p.add_argument("--session", required=True)

    loop = subs.add_parser("loop", help="unattended mode: on, off, status, tick")
    actions = loop.add_subparsers(dest="loop_action", metavar="<on|off|status|tick>", required=True)

    def loop_sub(name, help):
        q = actions.add_parser(name, help=help)
        q.add_argument("--task-dir", required=True)
        q.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
        q.set_defaults(handler=cmd_loop, apply_op=None, warnings=[], no_commit=False, dry_run=False)
        return q

    q = loop_sub("on", "switch unattended mode on with the operator's approved route:model list")
    q.add_argument("--approved-by")
    q.add_argument("--route", action="append", help="<route>:<model>, repeatable")
    q.add_argument("--cadence")
    q.add_argument("--noop-cap", type=int)
    q.add_argument("--notifier")
    q.add_argument("--host-rule", action="append", help="'<source>: <conflict> => <answer>', repeatable")
    q.add_argument("--cron-id")
    q.add_argument("--owner-session")
    q.add_argument("--crons-file", help="the host's CronList as a JSON array of {id, prompt}")
    q = loop_sub("off", "switch unattended mode off")
    _text(q, "loop", "reason")
    loop_sub("status", "print the loop state")
    q = loop_sub("tick", "--begin prints the state; --result records one tick and its report")
    q.add_argument("--begin", action="store_true")
    q.add_argument("--result", choices=("noop", "productive", "stopped"))
    q.add_argument("--crons-file", help="the host's CronList as a JSON array of {id, prompt}")
    for name in ("row", "action", "next", "dedup", "report", "reason"):
        _text(q, "loop", name)

    p = sub("approve-dispatch", "record the operator's one-time approval of one dispatch (mm.approval/1)",
            cmd_approve_dispatch)
    p.add_argument("--row", required=True)
    p.add_argument("--route", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--worker", required=True, choices=mm_runtime.WORKERS)
    p.add_argument("--prompt-file", required=True)
    p.add_argument("--launch", help="the launch template dispatch will get; absent: the route's default")
    p.add_argument("--operator", help="default: operator_name in mm.local.md")
    p.add_argument("--channel", choices=mm_runtime.CHANNELS, default="cli")
    p.add_argument("--session")
    p.add_argument("--ttl-minutes", type=int, default=mm_runtime.TTL_DEFAULT, help="1 to 1440, default 15")
    p.add_argument("--expect-sha256", help="refuse (exit 9) unless the prompt still has this sha256")
    p.add_argument("--json", action="store_true", help="print {schema, dry_run, record}")

    p = sub("dispatch", "record an approved dispatch and save an exact copy of its prompt", cmd_dispatch,
            write=False)
    p.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
    p.add_argument("--route")
    p.add_argument("--model")
    p.add_argument("--prompt-file")
    p.add_argument("--approved-by", help="attended: the operator who said yes to this prompt, route and model")
    p.add_argument("--approval-id", help="attended: consume this approve-dispatch record (needs --worker)")
    p.add_argument("--worker", choices=mm_runtime.WORKERS, help="the worker kind; recorded")
    p.add_argument("--operator-exception", metavar="OPERATOR",
                   help="unattended: the operator who approved this one off-list route and model (recorded)")
    _text(p, "dispatch", "exception-reason", help="the operator's own words approving the off-list dispatch")
    p.add_argument("--row")
    p.add_argument("--launch", help="launch template; {prompt} becomes the prompt copy's absolute path")
    p.add_argument("--close", metavar="DISPATCH_ID", help="mark a dispatch finished")
    _text(p, "dispatch", "outcome")

    p = sub("launch-check", "ALIVE, PENDING or DEAD for a dispatch, from transcript, run and event facts",
            cmd_launch_check, write=False)
    p.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
    p.add_argument("--dispatch-id", required=True)
    p.add_argument("--transcript", help="the builder's session transcript; default: found by its launch record in "
                   "Claude Code's project folder for --cwd. A file without that record is refused (exit 2)")
    p.add_argument("--cwd", help="the folder the launch ran in; default: the one the dispatch record stored, else "
                   "the repo holding the task folder")
    p.add_argument("--run-dir")
    p.add_argument("--events")
    p.add_argument("--launch-log", help="the launch command's captured output; a failure line in it is DEAD at once")
    p.add_argument("--launched-at", help="ISO time of the launch; default: the dispatch time")
    p.add_argument("--session-id", help="the launched session's id; default: the one the first check recorded")
    p.add_argument("--stall-minutes", type=int, default=60,
                   help="a run journal that has not grown for this long makes the launch DEAD (default 60)")

    p = sub("close", "the closing ritual (dry run unless --apply)", cmd_close, write=False)
    p.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
    p.add_argument("--operator", required=True)
    p.add_argument("--apply", action="store_true")

    for name, handler, text in (
            ("migrate", cmd_migrate, "convert a legacy HANDOFF-only folder to a ledger task (dry run unless --apply)"),
            ("repair", cmd_repair, "fix an invalid or drifted ledger folder (dry run unless --apply)")):
        p = sub(name, text, handler, write=False)
        p.add_argument("--apply", action="store_true", help="write, after the operator's yes to the dry run")
        p.add_argument("--decide", action="append", metavar="N=CHOICE", help="answer question N (repeatable)")
        p.add_argument("--no-commit", action="store_true", help="skip the auto-commit of this write")
    return parser


PARSER = build_parser()
mm_cli.PARSER.append(PARSER)


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    _utf8_stdio()
    verify_argv = []
    if "--" in argv:
        cut = argv.index("--")
        argv, verify_argv = argv[:cut], argv[cut + 1:]
    if argv and argv[0] in LEDGER_COMMANDS:
        task_dir = _peek_task_dir(argv)
        if task_dir is not None and _is_legacy(task_dir):
            print(LEGACY_MESSAGE, file=sys.stderr)
            return 4
    try:
        args = PARSER.parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2
    if args.command is None:
        PARSER.print_help()
        return 2
    args.verify_argv = verify_argv
    args.warnings = []
    try:
        if verify_argv and not getattr(args, "verify", False):
            raise CliError(2, "arguments after -- are only read by set-row --verify")
        _resolve_files(args)
        return args.handler(args)
    except CliError as exc:
        print(f"mm: {exc}", file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
