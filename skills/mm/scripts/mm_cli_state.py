"""mm.py compile, check, status, sections and prune-backups.
"""

import contextlib
import io
import json
import os
import pathlib
import shutil
import stat
import subprocess

import mm_compile
import mm_git
import mm_inbox
import mm_ledger
import mm_loop
import mm_schema
from mm_cli import (
    BACKUP_DIR_RE, BLOCKING_DRIFT, CliError, DRIFT, FIXABLE_DRIFT, LEGACY_MESSAGE, _backup, _commit,
    _is_legacy, _load, _now, _require_proven, _save_and_render, _task_dir, _where_check,
)


def cmd_compile(args) -> int:
    task_dir = _task_dir(args)
    _where_check(task_dir)
    now = _now()
    try:
        with mm_ledger.hold_lock(task_dir):
            doc = _load(task_dir)
            _require_proven(doc)
            diagnosis = mm_compile.diagnose(task_dir, doc)
            edited = [(name, kind) for name, kind, _ in diagnosis if kind in BLOCKING_DRIFT]
            if edited and not args.accept_ledger:
                _print_lost_lines(task_dir, doc, edited)
                raise CliError(8, "refusing to overwrite " + ", ".join(n for n, _ in edited) + ": edited by hand. "
                                  "Take the lines above into the ledger with mm.py commands (or /mm repair), "
                                  "or rerun with --accept-ledger to overwrite them after a backup")
            if all(kind == "OK" for _, kind, _ in diagnosis):
                print("MM-OK compile: generated files already match the ledger")
                return 0
            if args.dry_run:
                print("dry run: compile would rewrite " + ", ".join(
                    f"{name} ({kind})" for name, kind, _ in diagnosis if kind != "OK") + "; nothing written")
                return 0
            written = []
            if edited:
                backup = _backup(task_dir, "compile", [n for n, _ in edited], now)
                written.append(backup)
                print(f"backed up {', '.join(n for n, _ in edited)} to {backup}")
            stale = [name for name, kind, _ in diagnosis if kind == "NOT-GENERATED"]
            if stale:
                written.append(_backup(task_dir, "roadmap", stale, now))
            written += _save_and_render(task_dir, doc, doc["revision"], "compile", now)
    except mm_ledger.LockTimeout:
        raise CliError(10, f"{task_dir / 'ledger.lock'} is held by another writer; retry shortly")
    print("MM-OK compile: generated files rewritten from the ledger")
    return _commit(args, task_dir, "compile generated files" + (" (--accept-ledger)" if args.accept_ledger else ""),
                   written)


def _print_lost_lines(task_dir, doc, edited) -> None:
    files = mm_compile.render_files(doc)
    for name, kind in edited:
        actual = (task_dir / name).read_text(encoding="utf-8", errors="replace")
        print(f"{name} ({kind}): a rewrite from the ledger would lose these lines:")
        expected = files.get(name, "")
        if name == "HANDOFF.md":
            report = mm_compile.content_complete(actual, expected)
            lines = report.missing_lines
        else:
            have = set(expected.splitlines())
            lines = [line for line in actual.splitlines() if line.strip() and line not in have]
        for line in lines[:40]:
            print(f"  {line}")
        if len(lines) > 40:
            print(f"  ... {len(lines) - 40} more")


def _backup_counts(task_dir: pathlib.Path) -> dict:
    counts = {}
    backups = task_dir / "backups"
    if backups.is_dir():
        for d in backups.iterdir():
            m = BACKUP_DIR_RE.match(d.name)
            if d.is_dir() and m:
                counts.setdefault(m.group(1), []).append(d)
    return counts


def cmd_check(args) -> int:
    return _check(_task_dir(args))


def check_report(task_dir: pathlib.Path) -> tuple:
    """(exit code, printed lines) of check, for callers that judge a result."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = _check(task_dir)
    return code, buf.getvalue().splitlines()


def _check(task_dir: pathlib.Path) -> int:
    if _is_legacy(task_dir):
        return _check_legacy(task_dir)
    if not (task_dir / "ledger.json").is_file():
        raise CliError(4, f"no task at {task_dir}")
    try:
        doc = json.loads((task_dir / "ledger.json").read_text(encoding="utf-8"))
        mm_ledger.validate_ledger(doc)
    except ValueError as exc:
        print(f"INVALID ledger.json is not JSON: {exc}")
        return 1
    except mm_ledger.LedgerValidationError as exc:
        print("INVALID ledger.json:")
        for problem in exc.problems:
            print(f"  {problem}")
        print("run /mm repair")
        return 1
    hints = {"HANDOFF-EDITED": "edited by hand; mm.py compile names the lines, /mm repair absorbs them",
             "LEDGER-AHEAD": "the ledger moved on; run mm.py compile",
             "UNKNOWN": "no compile record explains the difference; run /mm repair",
             "MISSING": "run mm.py compile",
             "HEADER-MISSING": "written before generated headers; the next mm.py write regenerates it",
             "NOT-GENERATED": "hand-made; the next mm.py write backs it up and generates it"}
    unproven = mm_ledger.history_problems(doc)
    for rid, code, message in unproven:
        print(f"INVALID {code} {rid}: {message}")
    if unproven:
        print("the ledger fails its content check: do not compile or write; run /mm repair")
        hints["LEDGER-AHEAD"] = "the ledger moved on without mm.py (see INVALID above); run /mm repair"
    drift = bool(unproven)
    fixable = False
    for name, kind, _ in mm_compile.diagnose(task_dir, doc):
        if kind in DRIFT:
            drift = True
            print(f"DRIFT {name} {kind}: {hints[kind]}")
        elif kind in FIXABLE_DRIFT:
            fixable = True
            print(f"FIX {name} {kind}: {hints[kind]}")
    for level, code, message in mm_compile.findings(doc):
        fixable = fixable or level == "fix"
        print(f"{'FIX' if level == 'fix' else 'warning'} {code}: {message}")
    size = mm_inbox.inbox_bytes(task_dir)
    if size > mm_inbox.INBOX_WARN_BYTES:
        print(f"warning INBOX-LARGE: inbox/ holds {size // (1024 * 1024)} MB; evidence belongs under "
              "<task>/evidence/, not in the inbox")
    for kind, dirs in sorted(_backup_counts(task_dir).items()):
        if len(dirs) > mm_schema.BACKUPS_KEEP:
            print(f"warning BACKUPS-OVER-CAP: {len(dirs)} {kind} backups (keep {mm_schema.BACKUPS_KEEP}); "
                  "run mm.py prune-backups")
    if drift:
        return 1
    if fixable:
        return 3
    print("MM-CHECK-OK")
    return 0


def _check_legacy(task_dir: pathlib.Path) -> int:
    original = (task_dir / "HANDOFF.md").read_text(encoding="utf-8")
    slices = mm_compile.parse_handoff(original)
    if not slices.get("has_section_0a"):
        print("round-trip FAIL: no Section 0A Dashboard Index")
        return 1
    doc = mm_compile._doc_from_slices(slices)
    report = mm_compile.complete_against(original, doc)
    if not report.passed:
        print("round-trip FAIL: parsing HANDOFF.md loses content")
        mm_compile._print_completeness_report(report)
        return 1
    print("round-trip PASS")
    for level, code, message in mm_compile.findings(doc):
        print(f"{'FIX' if level == 'fix' else 'warning'} {code}: {message}")
    print("legacy folder: run /mm migrate")
    return 3


def waiting_on_operator(doc: dict) -> list:
    """What waits on the operator, in row order, as {row, kind, text}: kind
    decision, verification or human_check. Human status and status --json
    both print these."""
    out = []
    for row in doc.get("rows", []):
        rid, item = row.get("id"), row.get("item", "")
        if row.get("state") == "NEEDS_DECISION":
            kind, text = "decision", f"{rid} needs a decision: {row.get('blocked_reason') or item[:70]}"
        elif mm_ledger.needs_verification(row):
            kind, text = "verification", (f"{rid} needs verification: /mm repair could not prove its green; verify "
                                          "it with set-row --verify, or set DONE with --evidence")
        elif row.get("user_facing") and row.get("state") not in ("HUMAN_VERIFIED",) + mm_schema.TERMINAL:
            kind, text = "human_check", f"{rid} is user-facing and waits for a human check (HUMAN_VERIFIED)"
        else:
            continue
        out.append({"row": rid, "kind": kind, "text": text})
    return out


def cmd_status(args) -> int:
    task_dir = _task_dir(args)
    if _is_legacy(task_dir):
        doc = mm_compile._doc_from_slices(mm_compile.parse_handoff(
            (task_dir / "HANDOFF.md").read_text(encoding="utf-8")))
        doc["task"] = doc["dashboard_index"].get("Task") or task_dir.name
    else:
        doc = _load(task_dir)
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else {}
    out = [f"\U0001f3a9 PM mode | Task: {doc.get('task', task_dir.name)}",
           f"Mode: {'unattended' if loop.get('mode') == 'unattended' else 'attended'}"]
    if loop:
        out.append(mm_compile.loop_line(loop))
    if _is_legacy(task_dir):
        out.append(LEGACY_MESSAGE)
    out += ["", "Rows (id | status | item | test level | PR | test page):"]
    for row in doc.get("rows", []):
        item = row.get("item", "")
        out.append(f"{row.get('id')} | {mm_compile.status_cell(row)} | {item[:70]} | "
                   f"{row.get('test_level') or 'none'} | {row.get('pr') or '-'} | {row.get('test_page') or '-'}")
    waiting = [f"- {entry['text']}" for entry in waiting_on_operator(doc)]
    out += ["", "Waiting on the operator:"] + (waiting or ["- nothing"])
    entries, problems, late = mm_inbox.counts(task_dir)
    out += ["", f"Inbox: {entries} unprocessed entries, {problems} scan problems, {late} closed-task files"
                + (" (mm.py inbox-scan lists them)" if problems or late else "")]
    flights = mm_loop.in_flight(mm_loop.read_records(task_dir))
    out += ["", "In-flight dispatches:"] + ([f"- {line}" for line in flights] or ["- none"])
    notes = [f"- INVALID {code} {rid}: {message}; run /mm repair" for rid, code, message in
             mm_ledger.history_problems(doc)]
    notes += [f"- {code}: {message}" for _, code, message in mm_compile.findings(doc)]
    out += ["", "Checks:"] + (notes or ["- no cap or structure findings"])
    try:
        uncommitted = [f"- {line}" for line in mm_git.pending(task_dir)] or ["- none"]
    except mm_git.GitFailed as exc:
        uncommitted = [f"- unknown: {exc}"]
    out += ["", "Uncommitted PM changes:"] + uncommitted
    print("\n".join(out))
    return 0


def cmd_sections(args) -> int:
    doc = _load(_task_dir(args))
    registry = mm_compile.section_registry(doc)
    if args.json:
        print(json.dumps(registry, ensure_ascii=False, indent=2))
        return 0
    for entry in registry:
        print(f"{entry['id']:<12} {entry['kind']:<16} {entry['heading']}  <- {entry['command']}")
    return 0


def _plain_files(folder: pathlib.Path):
    """Every regular file under `folder`, found without following links, or
    None when the folder holds any other entry: a symlink, a junction or
    another reparse point, or a special file. Git cannot hold those as they
    are, so deleting them could lose data."""
    files = []
    with os.scandir(folder) as entries:
        for entry in entries:
            attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
            if entry.is_symlink() or getattr(entry, "is_junction", lambda: False)() or \
                    attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                return None
            if entry.is_dir(follow_symlinks=False):
                below = _plain_files(pathlib.Path(entry.path))
                if below is None:
                    return None
                files += below
            elif entry.is_file(follow_symlinks=False):
                files.append(pathlib.Path(entry.path))
            else:
                return None
    return files


def _committed_clean(folder: pathlib.Path) -> bool:
    """True when deleting `folder` loses nothing: git reports no staged,
    unstaged, untracked or ignored change under it, it holds no link or
    special file, and every file in it is tracked. Git status runs first,
    before any shortcut for a folder without files. False outside a work
    tree or when git fails."""
    git = shutil.which("git")
    if not git:
        return False
    status = subprocess.run([git, "status", "--porcelain", "--untracked-files=all", "--ignored", "--", "."],
                            cwd=folder, capture_output=True, text=True)
    if status.returncode != 0 or status.stdout.strip():
        return False
    files = _plain_files(folder)
    if files is None:
        return False
    if not files:
        return True
    rels = [str(p.relative_to(folder)) for p in files]
    tracked = subprocess.run([git, "ls-files", "--error-unmatch", "--"] + rels, cwd=folder, capture_output=True,
                             text=True)
    return tracked.returncode == 0


def cmd_prune_backups(args) -> int:
    task_dir = _task_dir(args)
    _load(task_dir)
    candidates = []
    for kind, dirs in sorted(_backup_counts(task_dir).items()):
        candidates += sorted(dirs, key=lambda d: d.name)[: max(len(dirs) - args.keep, 0)]
    if not candidates:
        print(f"nothing to prune (keep {args.keep} per kind)")
        return 0
    if not args.apply:
        print("dry run: would prune " + ", ".join(d.name for d in candidates) + "; rerun with --apply")
        return 0
    pruned = []
    for d in candidates:
        if _committed_clean(d):
            shutil.rmtree(d)
            pruned.append(d)
            print(f"PRUNED {d.name}")
        else:
            print(f"REFUSED {d.name}: it holds untracked files, a link (symlink or junction), or uncommitted changes "
                  "(staged or not), so deleting it could lose them; commit or remove them first")
    return _commit(args, task_dir, f"prune-backups {len(pruned)} backups", pruned) if pruned else 0
