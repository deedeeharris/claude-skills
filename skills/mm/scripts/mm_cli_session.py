"""mm.py inbox commands, worktree copies and session binding.
"""

import re

import mm_fence
import mm_git
import mm_inbox
import mm_transcripts
import mm_where
from mm_cli import CliError, _commit, _git_refusal, _task_dir, _where_check


def cmd_inbox_write(args) -> int:
    task_dir = _task_dir(args)
    if not task_dir.is_dir():
        raise CliError(4, f"no task at {task_dir}")
    _where_check(task_dir)
    now = mm_inbox._now().isoformat()
    fields = {"agent": args.agent or args.source, "session": args.session or "none", "started": args.started or now,
              "emitted": args.emitted or now, "status": args.status, "task_ref": args.task_ref}
    try:
        path = mm_inbox.write_entry(task_dir, args.source, fields, args.body)
    except mm_inbox.InboxError as exc:
        raise CliError(exc.code, str(exc))
    print(f"MM-INBOX-WRITTEN {path}")
    return _commit(args, task_dir, f"inbox-write {path.name}", [path])


def cmd_inbox_scan(args) -> int:
    task_dir = _task_dir(args)
    entries, problems, late = mm_inbox.breakdown(task_dir)
    for name, status in entries:
        print(f"ENTRY {name} status={status}")
    for kind, rel, detail in problems:
        print(f"INBOX-PROBLEM {kind} {rel}: {detail}")
    for rel, detail in late:
        print(f"INBOX-CLOSED-TASK {rel}: {detail}")
    print(f"MM-INBOX-SCAN entries={len(entries)} problems={len(problems)}"
          + (f" closed-task-files={len(late)}" if late else ""))
    return 3 if problems or late else 0


def cmd_inbox_archive(args) -> int:
    task_dir = _task_dir(args)
    if not args.entry and not args.all:
        raise CliError(2, "inbox-archive takes --entry <name> (repeatable) or --all (every valid entry)")
    names = list(args.entry or []) + (mm_inbox.valid_entries(task_dir) if args.all else [])
    if args.dry_run:
        print("dry run: would archive " + (", ".join(names) or "nothing"))
        return 0
    _where_check(task_dir)
    try:
        moved = mm_inbox.archive(task_dir, list(dict.fromkeys(names)))
    except mm_inbox.InboxError as exc:
        raise CliError(exc.code, str(exc))
    for name, target in moved:
        print(f"ARCHIVED {name} -> {target.relative_to(task_dir).as_posix()}")
    left = mm_inbox.scan(task_dir)[1] if args.all else []
    for kind, rel, detail in left:
        print(f"LEFT {rel} ({kind}: {detail}); fix it, or archive it by name with --entry")
    paths = [p for name, target in moved for p in (task_dir / "inbox" / name, target)]
    code = _commit(args, task_dir, f"inbox-archive {len(moved)} entries", paths) if moved else 0
    if code:
        return code
    if left:
        print(f"MM-INBOX-NOT-CLEAR {len(left)} problem files remain; the inbox is not cleared")
        return 3
    return 0


# ---------------------------------------------------------------- where and session binding

def cmd_where(args) -> int:
    task_dir = _task_dir(args)
    try:
        found = mm_where.copies(task_dir)
        closed, split = mm_where.closed_elsewhere(task_dir), mm_where.diverged(found)
    except mm_git.GitFailed as exc:
        raise _git_refusal(exc)
    if not found:
        print(f"COPY {task_dir.resolve()} (this)")
        print(f"CANONICAL {task_dir.resolve()}")
        print("the only copy: not in a git work tree, or a single worktree")
    else:
        for c in found:
            print(f"COPY {c['path']} {c['label']}" + (" (this)" if c["this"] else ""))
        print(f"CANONICAL {mm_where.canonical(found)['path']}")
    if closed:
        print(f"warning: closed on {closed}: this task was moved to done/ there; writing here reopens it")
    if split is not None:
        print(f"DIVERGED {split[0]['path']}: {split[1]}; no copy may be written until the operator merges the "
              "branches or picks one copy")
        return 16
    if mm_where._behind(found) is not None:
        print("this copy is behind: write to the canonical copy")
        return 12
    return 0


def _session(args) -> str:
    return (args.session or "").strip()


def fence_root(task_dir) -> tuple:
    """(repo_root, repo_root_source) of the PM fence for a task: the git top
    level of its worktree, or, outside git, the folder holding its PM root.
    Raises mm_git.GitFailed when git itself fails."""
    repo = mm_git._repo(task_dir, strict=True)
    if repo is not None:
        return str(repo[0]), "git"
    return str(mm_transcripts.repo_of(task_dir)), "no-git"


def cmd_bind(args) -> int:
    task_dir = _task_dir(args)
    if not task_dir.is_dir():
        raise CliError(4, f"no task at {task_dir}")
    try:
        mm_where._binding(_session(args))
        root, source = fence_root(task_dir)
    except mm_where.WhereError as exc:
        raise CliError(exc.code, str(exc))
    except mm_git.GitFailed as exc:
        raise CliError(21, f"mm.py bind: cannot resolve the git repository of {task_dir} ({exc}), so the PM fence "
                           "root is unknown; fix git and bind again")
    if mm_fence.broad_root(root):
        raise CliError(2, f"mm.py bind: the PM fence root of {task_dir} would be {root}, a filesystem root or a "
                          "folder holding your home folder, which would fence ~/.claude and memory; nothing written. "
                          "Move the task into a repository or a project folder below your home folder, then bind "
                          "again")
    try:
        path = mm_where.bind(task_dir, _session(args), root, source)
    except mm_where.WhereError as exc:
        raise CliError(exc.code, str(exc))
    print(f"MM-BOUND {_session(args)} -> {task_dir} ({path})")
    return 0


def cmd_whoami(args) -> int:
    try:
        found, source = mm_where.resolve(args.task_dir, _session(args) or None, args.repo, args.pattern)
    except (mm_where.WhereError, re.error) as exc:
        raise CliError(2, str(exc))
    except mm_git.GitFailed as exc:
        raise _git_refusal(exc)
    if found is None:
        raise CliError(4, f"no task found ({source}); ask the operator which task")
    print(found)
    print(f"source: {source}")
    return 0


def cmd_unbind(args) -> int:
    try:
        removed = mm_where.unbind(_session(args))
    except mm_where.WhereError as exc:
        raise CliError(exc.code, str(exc))
    print(f"MM-UNBOUND {_session(args)}" if removed else f"no binding for {_session(args)}")
    return 0
