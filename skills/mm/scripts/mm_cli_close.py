"""mm.py close: the closing ritual, journaled so a failure part-way is finished by a rerun.

close refuses while the inbox holds an unprocessed or malformed entry: the
Update flow reads each entry first, and a deferral is an explicit
inbox-archive --entry, never part of close. close --apply writes
close-journal.json into the task folder before its first change, and records
every finished step there. A rerun (close --apply again, from the active or
the done path, or a dry run, which shows what is left) reads the journal and
carries on from the first unfinished step. Every step checks the disk before
it acts, so a step that completed but was not yet recorded is never done
twice; when saving the journal after a step fails, close exits 19 and names
what is on disk. Right before the folder move, and again right before the
commit, close scans the inbox again: an entry that arrived while close ran
stops it with exit 20 and the journal intact. The one auto-commit holds only what close changed (the ledger and the
generated files) and the renames it made (tracked files keep their committed
content, so an untracked or edited operator file is never committed). The
journal stays until that commit succeeds or is not needed; a refused commit
(exit 13) leaves it, and a rerun makes the commit.
"""

import argparse
import json
import os
import pathlib

import mm_atomic
import mm_inbox
import mm_ledger
import mm_schema
from mm_cli import CliError, _commit, _guard, _load, _now, _task_dir, _where_check, _write

JOURNAL = "close-journal.json"
PROMPT_FOLDERS = {".codex-prompts": "archive/codex-prompts"}
STEPS = ("ledger", "prompt-folders", "insights", "move")


def _rewrite_citations(value, old: str, new: str):
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [_rewrite_citations(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: _rewrite_citations(v, old, new) for k, v in value.items()}
    return value


def _target(task_dir: pathlib.Path):
    return task_dir.parent.parent / "done" / task_dir.name if task_dir.parent.name == "active" else None


def _locate(task_dir: pathlib.Path) -> tuple:
    """(the folder holding the task now, its journal or None). After a move
    that was not yet recorded as finished, the journal sits under done/."""
    for folder in (task_dir, _target(task_dir)):
        if folder is not None and (folder / JOURNAL).is_file():
            try:
                return folder, json.loads((folder / JOURNAL).read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise CliError(19, f"{folder / JOURNAL} is unreadable ({exc}); finish the close by hand")
    return task_dir, None


def _inbox_clear(folder: pathlib.Path) -> bool:
    """True when the inbox holds nothing; else print every entry and problem."""
    entries, problems = mm_inbox.scan(folder)
    for name, status in entries:
        print(f"UNPROCESSED inbox/{name} status={status}")
    for kind, rel, detail in problems:
        print(f"INBOX-PROBLEM {kind} {rel}: {detail}")
    return not entries and not problems


def _require_clear_inbox(folder: pathlib.Path) -> None:
    if _inbox_clear(folder):
        return
    raise CliError(20, "close refused: the inbox is not clear, so a report could be closed unread. Run the update "
                       "flow first: read each entry, record its facts with mm.py, then mm.py inbox-archive --entry "
                       "<name> (or --all). A malformed entry is fixed, or read and archived by name; deferring an "
                       "entry is that explicit inbox-archive, never part of close. Nothing written")


def _insights_name(folder: pathlib.Path, date: str) -> str:
    name, n = f"insights_archive_{date}.md", 2
    while (folder / name).exists():
        name, n = f"insights_archive_{date}-{n}.md", n + 1
    return name


def _new_journal(args, task_dir: pathlib.Path) -> dict:
    doc = _load(task_dir)
    open_rows = [r for r in doc.get("rows", []) if r.get("state") not in mm_schema.TERMINAL and not r.get("is_wrapup")]
    if open_rows:
        for row in open_rows:
            print(f"OPEN {row.get('id')} {row.get('state')} {row.get('item', '')[:70]}")
        raise CliError(5, "close needs every other row DONE with evidence, or ABANDONED with the reason "
                          "'deferred at close: <why>' (mm.py set-row, retire-row) first")
    target = _target(task_dir)
    if target is not None and target.exists():
        raise CliError(4, f"{target} exists; close will not merge into it")
    date = _now().date().isoformat()
    return {"operator": args.operator, "task_dir": str(task_dir), "target": str(target) if target else None,
            "folders": [name for name in PROMPT_FOLDERS if (task_dir / name).is_dir()],
            "insights": _insights_name(task_dir, date), "done": [], "paths": [], "renames": []}


def _recheck_inbox(folder: pathlib.Path, journal: dict, before: str) -> None:
    """Scan the inbox again right before `before`: an agent may have written
    an entry while close ran. Stop with the journal intact if it did."""
    if _inbox_clear(folder):
        return
    raise CliError(20, f"close stopped before {before}: the inbox changed while close ran (listed above), so a report "
                       f"could be closed unread. {folder / JOURNAL} keeps the finished steps "
                       f"({', '.join(journal['done']) or 'none'}). Read each entry with the update flow and archive it "
                       f"(mm.py inbox-archive --task-dir {folder} --entry <name>), then rerun mm.py close --task-dir "
                       f"{folder} --operator {journal['operator']} --apply to finish")


def _plan(journal: dict) -> list:
    return ([f"archive {name}/ to {PROMPT_FOLDERS[name]}/ and rewrite its citations" for name in journal["folders"]]
            + ["set the wrap-up row DONE with evidence human:" + journal["operator"] + "; Status done",
               f"rename insights.md to {journal['insights']}"]
            + ([f"move the folder to {journal['target']}"] if journal["target"] else [])
            + ["commit only what close changed or renamed; untracked or edited operator files stay uncommitted"])


def _save(folder: pathlib.Path, journal: dict) -> None:
    mm_atomic.atomic_write_text(folder / JOURNAL, json.dumps(journal, indent=2) + "\n")


def _step_ledger(args, folder: pathlib.Path, journal: dict) -> pathlib.Path:
    folders = journal["folders"]

    def apply(doc):
        for name in folders:
            for key in ("passthrough", "rows", "decisions"):
                doc[key] = _rewrite_citations(doc[key], name + "/", PROMPT_FOLDERS[name] + "/")
        wrap = next(r for r in doc["rows"] if r.get("is_wrapup"))
        if wrap.get("state") != "DONE":
            mm_ledger.set_row_state(doc, wrap["id"], "DONE", by="mm.py close",
                                    evidence="human:" + journal["operator"])
        doc["dashboard_index"]["Status"] = "done"
        return f"{wrap['id']} DONE"

    quiet = argparse.Namespace(**{**vars(args), "task_dir": str(folder), "no_commit": True})
    _write(quiet, "close", lambda d: _guard(lambda _a, doc: apply(doc), quiet, d), [])
    journal["paths"] += [str(p) for p in getattr(quiet, "written", [])]
    return folder


def _step_prompt_folders(args, folder, journal):
    for name in journal["folders"]:
        source, destination = folder / name, folder / PROMPT_FOLDERS[name]
        if source.is_dir():
            if destination.exists():
                raise OSError(f"{destination} exists; move {source} by hand")
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.rename(source, destination)
        journal["renames"].append([str(source), str(destination)])
    return folder


def _step_insights(args, folder, journal):
    source, destination = folder / "insights.md", folder / journal["insights"]
    if source.is_file():
        if destination.exists():
            raise OSError(f"{destination} exists; rename {source} by hand")
        os.rename(source, destination)
    journal["renames"].append([str(source), str(destination)])
    return folder


def _step_move(args, folder, journal):
    target = pathlib.Path(journal["target"]) if journal["target"] else None
    if target is None or folder == target:
        return folder
    if target.exists():
        raise OSError(f"{target} exists; close will not merge into it")
    target.parent.mkdir(parents=True, exist_ok=True)
    os.rename(folder, target)
    return target


STEP_FUNCTIONS = {"ledger": _step_ledger, "prompt-folders": _step_prompt_folders, "insights": _step_insights,
                  "move": _step_move}


def _commit_close(args, folder: pathlib.Path, journal: dict) -> int:
    """Commit the paths close wrote and the renames it made, at the task's
    final place: the steps before the move recorded paths under the origin."""
    origin = pathlib.Path(journal["task_dir"])

    def final(path):
        path = pathlib.Path(path)
        return folder / path.relative_to(origin) if folder != origin and path.is_relative_to(origin) else path

    renames = [(pathlib.Path(old), final(new)) for old, new in journal["renames"]]
    renames += [(origin, folder)] if folder != origin else []
    return _commit(args, folder, f"close {origin.name}", [final(p) for p in journal["paths"]], renames)


def cmd_close(args) -> int:
    task_dir = _task_dir(args)
    folder, journal = _locate(task_dir)
    resuming = journal is not None
    if not resuming:
        journal = _new_journal(args, task_dir)
    if "move" not in journal["done"]:
        _require_clear_inbox(folder)
    if not args.apply:
        print("dry run: close would\n" + "\n".join(f"  {n}. {step}" for n, step in enumerate(_plan(journal), 1)))
        if resuming:
            left = [s for s in STEPS if s not in journal["done"]] + ["commit"]
            print(f"resume: {folder / JOURNAL} shows done: {', '.join(journal['done']) or 'nothing'}; "
                  f"left: {', '.join(left)}")
        print("rerun with --apply after the operator's yes")
        return 0
    if "move" not in journal["done"] and folder == task_dir:
        _where_check(folder)
    if not resuming:
        _save(folder, journal)
    for step in STEPS:
        if step in journal["done"]:
            continue
        if step == "move":
            _recheck_inbox(folder, journal, "moving the folder to done/")
        try:
            folder = STEP_FUNCTIONS[step](args, folder, journal)
        except CliError as exc:
            if step == "ledger" and exc.code != 7 and not journal["done"]:
                (folder / JOURNAL).unlink(missing_ok=True)
                raise
            raise CliError(19, _stopped(step, exc, folder, journal))
        except (OSError, mm_atomic.AtomicWriteError) as exc:
            raise CliError(19, _stopped(step, exc, folder, journal))
        journal["done"].append(step)
        try:
            _save(folder, journal)
        except (OSError, mm_atomic.AtomicWriteError) as exc:
            raise CliError(19, _unrecorded(step, exc, folder, journal))
    _recheck_inbox(folder, journal, "the commit")
    code = _commit_close(args, folder, journal)
    if code:
        print(f"MM-CLOSE-UNCOMMITTED {folder}: every step is done but the commit was refused; {folder / JOURNAL} "
              f"keeps it pending. Fix the cause, then rerun mm.py close --task-dir {folder} (or "
              f"{journal['task_dir']}) --operator {journal['operator']} --apply to commit")
        return code
    (folder / JOURNAL).unlink()
    print(f"MM-CLOSE-OK {folder}")
    return 0


def _unrecorded(step: str, exc, folder: pathlib.Path, journal: dict) -> str:
    """Step `step` finished, but saving the journal after it failed: name
    what is on disk now, read back rather than assumed."""
    path = folder / JOURNAL
    try:
        recorded = json.loads(path.read_text(encoding="utf-8")).get("done", [])
        on_disk = f"{path} records done: {', '.join(recorded) or 'none'}"
    except (OSError, ValueError, AttributeError) as err:
        on_disk = f"no readable journal at {path} ({err})"
    return (f"close finished step '{step}' on disk, but could not record it in the journal ({exc}). On disk now: the "
            f"task folder is {folder}; {on_disk}. Each step checks the disk before it acts, so a rerun does not "
            f"repeat '{step}': fix the cause, then rerun mm.py close --task-dir {folder} --operator "
            f"{journal['operator']} --apply to finish")


def _stopped(step: str, exc, folder: pathlib.Path, journal: dict) -> str:
    try:
        _save(folder, journal)
    except OSError:
        pass
    return (f"close stopped at step '{step}' ({exc}); {folder / JOURNAL} records the finished steps "
            f"({', '.join(journal['done']) or 'none'}). Fix the cause, then rerun mm.py close --task-dir "
            f"{journal['task_dir']} --operator {journal['operator']} --apply to finish")
