"""Shared plumbing of mm.py: the error type, text-from-file options, loading, and the one write path
(where check, lock, load, hand-edit precondition, apply, validate, caps, save, render, commit).
"""

import copy
import datetime
import pathlib
import re
import shutil
import sys

import mm_atomic
import mm_compile
import mm_git
import mm_ledger
import mm_schema
import mm_where


TEMPLATES = pathlib.Path(__file__).resolve().parent.parent / "templates"

LEGACY_MESSAGE = ("legacy folder: HANDOFF.md has no ledger.json. Every task is ledger-based; "
                  "run /mm migrate on it first (mm.py migrate --task-dir <dir>)")
BLOCKING_DRIFT = ("HANDOFF-EDITED", "UNKNOWN")
DRIFT = ("HANDOFF-EDITED", "LEDGER-AHEAD", "UNKNOWN", "MISSING")
FIXABLE_DRIFT = ("HEADER-MISSING", "NOT-GENERATED")
BATCH_OPS = ("add-row", "edit-row", "move-row", "split-row", "retire-row", "set-row", "mark-row",
             "add-decision", "supersede-decision", "set-field", "set-section", "archive")
LEDGER_COMMANDS = BATCH_OPS + ("batch", "compile", "prune-backups", "loop", "approve-dispatch", "dispatch", "close")
BACKUP_DIR_RE = re.compile(r"^\d{8}-\d{6}-(.+?)(?:-\d+)?$")

TEXT_OPTIONS = {}
PARSER = []  # mm.py appends its parser here, for batch to parse each operation


class CliError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def _utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def _now():
    return datetime.datetime.now().astimezone().replace(microsecond=0)


def _task_dir(args) -> pathlib.Path:
    return pathlib.Path(args.task_dir).absolute()


def _is_legacy(task_dir: pathlib.Path) -> bool:
    return (task_dir / "HANDOFF.md").is_file() and not (task_dir / "ledger.json").is_file()


def _peek_task_dir(argv):
    for i, arg in enumerate(argv):
        if arg == "--task-dir" and i + 1 < len(argv):
            return pathlib.Path(argv[i + 1])
        if arg.startswith("--task-dir="):
            return pathlib.Path(arg.split("=", 1)[1])
    return None


def _read_text_file(path: str, *, keep_cr: bool) -> str:
    """UTF-8 text with one trailing newline stripped. Multi-line section text
    keeps carriage returns as data; a one-line value drops the CR a
    Windows-edited file leaves before that newline."""
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        raise CliError(2, f"cannot read {path}: {exc}")
    if text.endswith("\n"):
        text = text[:-1]
    if not keep_cr and text.endswith("\r"):
        text = text[:-1]
    return text


def _resolve_files(args) -> None:
    for name in dict.fromkeys(TEXT_OPTIONS.get(getattr(args, "command", ""), [])):
        dest = name.replace("-", "_")
        value = getattr(args, dest + "_file", None)
        if value is None:
            continue
        keep_cr = name == "text"
        text = ([_read_text_file(v, keep_cr=keep_cr) for v in value] if isinstance(value, list)
                else _read_text_file(value, keep_cr=keep_cr))
        setattr(args, dest, text)


def _load(task_dir: pathlib.Path) -> dict:
    if not (task_dir / "ledger.json").is_file():
        if (task_dir / "HANDOFF.md").is_file():
            raise CliError(4, LEGACY_MESSAGE)
        raise CliError(4, f"no task at {task_dir}; create one with mm.py scaffold")
    try:
        return mm_ledger.load_ledger(task_dir)
    except (ValueError, mm_ledger.LedgerValidationError) as exc:
        raise CliError(11, f"ledger invalid: {exc}; run /mm repair")


UNPROVEN_ADVICE = ("a row's state is not proven by its own history, so ledger.json was edited by hand. No mm.py "
                   "write or compile runs on it, because that would record the edit as legitimate; run /mm repair "
                   "(a dry run shows each row and what repair records for it)")


def _require_proven(doc: dict) -> None:
    """Refuse (exit 11) a ledger whose rows are not proven by their history."""
    problems = mm_ledger.history_problems(doc)
    if problems:
        raise CliError(11, "ledger content invalid: " + "; ".join(f"{rid} {code}: {message}"
                                                                   for rid, code, message in problems)
                       + ". " + UNPROVEN_ADVICE)


def _stamp(doc: dict, now) -> None:
    doc["dashboard_index"]["Last updated"] = now.strftime("%Y-%m-%d %H:%M") + " by mm.py"


def _check_growth(before: dict, after: dict) -> None:
    old0 = len(mm_compile.section0_text(before).encode("utf-8"))
    new0 = len(mm_compile.section0_text(after).encode("utf-8"))
    if new0 > mm_schema.SECTION0_FAIL_BYTES and new0 > old0:
        raise CliError(6, f"Section 0 would grow to {new0} bytes; the cap is {mm_schema.SECTION0_FAIL_BYTES}. "
                          "Shorten 0B, or move detail into a reference file")
    old_cells = {r.get("id"): [len(c) for c in mm_compile.row_cells(r)] for r in before.get("rows", [])}
    for row in after.get("rows", []):
        previous = old_cells.get(row.get("id"), [])
        for i, cell in enumerate(mm_compile.row_cells(row)):
            if len(cell) > mm_schema.CELL_FAIL_CHARS and len(cell) > (previous[i] if i < len(previous) else 0):
                raise CliError(6, f"row {row.get('id')} would hold a {len(cell)}-char cell; the cap is "
                                  f"{mm_schema.CELL_FAIL_CHARS}")


def _backup(task_dir: pathlib.Path, kind: str, names, now) -> pathlib.Path:
    target = mm_atomic.exclusive_dir(task_dir / "backups", f"{now.strftime('%Y%m%d-%H%M%S')}-{kind}")
    for name in names:
        shutil.copy2(task_dir / name, target / name)
        if (target / name).read_bytes() != (task_dir / name).read_bytes():
            raise CliError(1, f"backup of {name} did not verify; nothing written")
    return target


def _save_and_render(task_dir, doc, before_revision, verb, now) -> list:
    """Save the ledger and write the generated files; returns the paths written."""
    files = mm_compile.render_files(doc)
    mm_compile.record_compile(doc, files, before_revision + 1)
    mm_ledger.save_ledger(task_dir, doc, expected_revision=before_revision, updated_by=f"mm.py {verb}",
                          now=now.isoformat(), lock_held=True)
    try:
        mm_atomic.atomic_write_many([(task_dir / name, text) for name, text in files.items()])
    except Exception as exc:
        raise CliError(7, f"ledger saved, generated files not written ({exc}); run mm.py compile")
    return [task_dir / "ledger.json"] + [task_dir / name for name in files]


def _commit(args, task_dir: pathlib.Path, what: str, paths, renames=()) -> int:
    """Auto-commit exactly `paths`, the PM paths this invocation wrote, and
    `renames`, the (old, new) moves it made. Returns 0, or 13 when git
    refused; the files stay written either way."""
    subject = " ".join(str(what).split())[:120]
    result = mm_git.auto_commit(task_dir, f"mm({task_dir.name}): {subject}", paths=paths, renames=renames,
                                no_commit=getattr(args, "no_commit", False))
    if result.code:
        print(f"mm: {result.note}", file=sys.stderr)
    elif not result.note.startswith(("auto-commit is off", "committed", "nothing to commit")):
        print(result.note, file=sys.stderr)
    return result.code


def _guard(apply, args, doc):
    try:
        return apply(args, doc)
    except mm_ledger.Refused as exc:
        raise CliError(exc.code, str(exc))
    except (mm_ledger.IllegalTransition, mm_ledger.IllegalStateBlockedCombo) as exc:
        raise CliError(5, str(exc))


def _git_refusal(exc) -> CliError:
    return CliError(21, f"{exc}; git itself failed, so mm cannot tell which copy of the task to use (a stale or split "
                        "worktree copy is not ruled out); nothing written. Fix what git names, then rerun")


def _where_check(task_dir: pathlib.Path) -> None:
    try:
        kind, other, why = mm_where.state(task_dir)
    except mm_git.GitFailed as exc:
        raise _git_refusal(exc)
    if kind == "diverged":
        raise CliError(16, f"the copies of this task diverged: {other} holds {why}. Writing any copy deepens the "
                           "split; stop and ask the operator to merge the branches or pick one copy "
                           f"(mm.py where --task-dir {task_dir} lists every copy)")
    if kind == "behind":
        raise CliError(12, f"this copy is behind the canonical copy {other}; write there instead "
                           f"(mm.py where --task-dir {task_dir} lists every copy)")


def _write(args, verb: str, apply, warnings: list) -> int:
    task_dir = _task_dir(args)
    if not task_dir.is_dir():
        raise CliError(4, f"no task at {task_dir}")
    _where_check(task_dir)
    if task_dir.parent.name == "done":
        print(f"warning: {task_dir.name} is under done/; writing anyway", file=sys.stderr)
    now = _now()
    try:
        with mm_ledger.hold_lock(task_dir):
            doc = _load(task_dir)
            _require_proven(doc)
            before = copy.deepcopy(doc)
            diagnosis = mm_compile.diagnose(task_dir, doc)
            edited = [f"{name} ({kind})" for name, kind, _ in diagnosis if kind in BLOCKING_DRIFT]
            if edited:
                raise CliError(8, "refusing to write: " + ", ".join(edited) + " differs from every recorded "
                                  "compile, so it was edited by hand. mm.py compile names the lines a rewrite "
                                  "would lose; /mm repair absorbs them; compile --accept-ledger overwrites them "
                                  "after a backup")
            summary = apply(doc)
            _stamp(doc, now)
            try:
                mm_ledger.validate_ledger(doc)
            except mm_ledger.LedgerValidationError as exc:
                raise CliError(11, f"the change would leave an invalid ledger: {exc}")
            _check_growth(before, doc)
            if getattr(args, "dry_run", False):
                print(f"dry run: {verb} {summary}; nothing written")
                return 0
            written = []
            stale = [name for name, kind, _ in diagnosis if kind == "NOT-GENERATED"]
            if stale:
                written.append(_backup(task_dir, "roadmap", stale, now))
            written += _save_and_render(task_dir, doc, before["revision"], verb, now)
    except mm_ledger.LockTimeout:
        raise CliError(10, f"{task_dir / 'ledger.lock'} is held by another writer; retry shortly")
    except mm_ledger.RevisionConflict as exc:
        raise CliError(10, str(exc))
    warnings = warnings + [f"warning {code}: {message}" for level, code, message in mm_compile.findings(doc)
                           if code in ("SECTION0-LARGE", "HANDOFF-LARGE")]
    for warning in warnings:
        print(warning, file=sys.stderr)
    print(f"MM-OK {verb} {summary}")
    args.written = written
    return _commit(args, task_dir, f"{verb} {summary}", written)
