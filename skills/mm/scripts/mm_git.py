"""Auto-commit of the PM paths one mm.py invocation wrote.

The commit stages and commits only the paths the command itself wrote or
deleted, with their working content, and the renames it made, with the
content git already holds (never the rest of the task folder, where the
operator may have untracked files or edits of their own), goes on the
current branch with the message
`mm(<task>): <verb> <what>`, and is never sent to a remote. It refuses, and
leaves the written files uncommitted, while a merge, rebase, cherry-pick or
revert is in progress, on a detached HEAD, or when anything at all is
already staged, inside the task folder or outside it (the index is left
exactly as it was). When staging or the commit fails (a hook, for example),
it unstages what it staged, so the index is again as it found it. When
git cannot create .git/index.lock, the refusal says .git is not writable by
this process and names the likely causes. When git itself fails (dubious
ownership, a corrupt index), the refusal and `status` print git's first
error line, and when git is not on PATH inside a folder with a .git entry, they
say so. Outside a git work tree, or for an ignored folder, it does nothing.

The setting is resolved in this order: the --no-commit flag, then the
MM_AUTO_COMMIT environment variable (on or off), then the auto_commit key of
mm.local.md beside SKILL.md, then the default, on.
"""

import os
import pathlib
import re
import shutil
import subprocess

OVERLAY = pathlib.Path(__file__).resolve().parent.parent / "mm.local.md"
_OVERLAY_KEY_RE = re.compile(r"^\s*auto_commit\s*:\s*(\S+)", re.M)
_LOCKED_OUT = ("Permission denied", "Operation not permitted", "Read-only file system", "Access is denied")
_IN_PROGRESS = (("MERGE_HEAD", "a merge"), ("rebase-merge", "a rebase"), ("rebase-apply", "a rebase"),
                ("CHERRY_PICK_HEAD", "a cherry-pick"), ("REVERT_HEAD", "a revert"))


class GitFailed(OSError):
    """git itself failed, as opposed to: the folder is not in a work tree."""


def _failed(what: str, proc) -> GitFailed:
    line = next((l.strip() for l in (proc.stderr or "").splitlines() if l.strip()), f"exit {proc.returncode}")
    return GitFailed(f"git {what} failed: {line}")


class Result:
    """code 0 (committed, nothing to commit, or skipped) or 13 (refused)."""

    def __init__(self, code: int, note: str):
        self.code = code
        self.note = note


def _switch(value):
    value = (value or "").strip().lower()
    if value in ("on", "off"):
        return value == "on"
    return None


def enabled(no_commit: bool = False) -> bool:
    if no_commit:
        return False
    from_env = _switch(os.environ.get("MM_AUTO_COMMIT"))
    if from_env is not None:
        return from_env
    try:
        m = _OVERLAY_KEY_RE.search(OVERLAY.read_text(encoding="utf-8"))
    except OSError:
        m = None
    from_overlay = _switch(m.group(1)) if m else None
    return True if from_overlay is None else from_overlay


def _ceilings() -> list:
    raw = os.environ.get("GIT_CEILING_DIRECTORIES", "")
    out = []
    for part in raw.split(os.pathsep):
        if part.strip():
            try:
                out.append(pathlib.Path(part).resolve())
            except OSError:
                pass
    return out


def maybe_in_repo(path: pathlib.Path) -> bool:
    """Cheap pre-check without a subprocess: is there a .git entry at or
    above the nearest existing ancestor of `path`, below any ceiling?"""
    current = _existing(pathlib.Path(path)).resolve()
    ceilings = _ceilings()
    while True:
        if (current / ".git").exists():
            return True
        parent = current.parent
        if parent == current or parent in ceilings:
            return False
        current = parent


def _existing(path: pathlib.Path) -> pathlib.Path:
    while not path.exists() and path.parent != path:
        path = path.parent
    return path


def _anchor(path: pathlib.Path) -> pathlib.Path:
    """The nearest existing folder at or above `path`, to run git in."""
    found = _existing(pathlib.Path(path))
    return found if found.is_dir() else found.parent


def _git(argv, cwd, stdin=None):
    exe = shutil.which("git")
    return subprocess.run([exe] + list(argv), cwd=str(cwd), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", input=stdin)


def _git_bytes(argv, cwd):
    """git's stdout as bytes, or None when git failed."""
    proc = subprocess.run([shutil.which("git")] + list(argv), cwd=str(cwd), capture_output=True)
    return proc.stdout if proc.returncode == 0 else None


def _repo(path: pathlib.Path, strict: bool = False):
    """(toplevel, git_dir) of the work tree holding `path`, or None. With
    `strict`, a git failure other than 'not a git repository' raises, and so
    does a .git entry above `path` when git is not on PATH."""
    if not maybe_in_repo(path):
        return None
    if not shutil.which("git"):
        if strict:
            raise GitFailed(f"git was not found on PATH, yet {path} is inside a folder with a .git entry")
        return None
    proc = _git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], _anchor(path))
    if strict and proc.returncode != 0 and "not a git repository" not in proc.stderr:
        raise _failed("rev-parse", proc)
    lines = proc.stdout.splitlines()
    if proc.returncode != 0 or len(lines) < 2:
        return None
    return pathlib.Path(lines[0]), pathlib.Path(lines[1])


def _relative(path: pathlib.Path) -> str:
    """`path` relative to its work tree's top, in git's slash form. Asked
    from the nearest existing ancestor, so a folder that close just moved
    away still gets its old name."""
    anchor = _anchor(path)
    proc = _git(["rev-parse", "--show-prefix"], anchor)
    if proc.returncode != 0:
        raise _failed("rev-parse --show-prefix", proc)
    prefix = proc.stdout.strip()
    rest = pathlib.PurePath(path).relative_to(anchor).as_posix() if path != anchor else ""
    parts = [p for p in (prefix.rstrip("/"), rest) if p and p != os.curdir]
    return "/".join(parts)


def checkout_form(path: pathlib.Path, data: bytes):
    """The content git stores for `path` when `data` (its bytes on disk) is
    exactly what git itself writes on checkout of a blob it already holds,
    under this repository's own attributes and settings; else None. So a
    line-ending form git never produced here (a rewrite before git held the
    content, or one that differs from git's own conversion) is not one."""
    path = pathlib.Path(path)
    repo = _repo(path)
    if repo is None:
        return None
    rel = _relative(path)
    oid = _git(["hash-object", "--", rel], repo[0]).stdout.strip()
    if not oid or _git(["cat-file", "-e", oid], repo[0]).returncode != 0:
        return None
    if _git_bytes(["cat-file", "--filters", "--path=" + rel, oid], repo[0]) != data:
        return None
    return _git_bytes(["cat-file", "blob", oid], repo[0])


def _sandbox_note(stderr: str, git_dir: pathlib.Path) -> str:
    """The explanation when git failed because this process may not write
    the .git folder (it could not create index.lock), else ""."""
    if "index.lock" not in stderr or not any(reason in stderr for reason in _LOCKED_OUT):
        return ""
    return (f". {git_dir} is not writable by this process (git could not create index.lock); possible causes: a "
            "sandbox that blocks writes to .git, such as Codex --sandbox workspace-write, or the folder's "
            "permissions. Auto-commit needs a .git this process can write; otherwise the operator commits these paths")


def _inside(name: str, rels) -> bool:
    return any(name == rel or name.startswith(rel + "/") for rel in rels)


def pending(task_dir: pathlib.Path) -> list:
    """Uncommitted changes under the task folder, as porcelain lines; raises
    GitFailed when git cannot tell."""
    repo = _repo(task_dir, strict=True)
    if repo is None:
        return []
    rel = _relative(pathlib.Path(task_dir))
    proc = _git(["status", "--porcelain", "--untracked-files=all", "--", rel], repo[0])
    if proc.returncode != 0:
        raise _failed("status", proc)
    return [l for l in proc.stdout.splitlines() if l.strip()]


def _unstage(top: pathlib.Path, rels) -> bool:
    """Put the index entries of `rels` back to HEAD (to absent on an unborn
    branch). Nothing else was staged, so this is the index as it was."""
    if _git(["reset", "-q", "--"] + list(rels), top).returncode == 0:
        return True
    return _git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--"] + list(rels), top).returncode == 0


def _restore(top: pathlib.Path, rels) -> str:
    """Unstage `rels`, then say what the index still holds of them."""
    unstaged = _unstage(top, rels)
    left = _git(["diff", "--cached", "--name-only", "-z", "--"] + list(rels), top)
    if left.returncode != 0:
        return f"the index state is unknown ({_failed('diff --cached', left)}); run git status"
    names = [n for n in left.stdout.split("\0") if n]
    if names:
        return "unstaging failed; still staged: " + ", ".join(names[:10]) + "; run git status"
    return "the index was restored" if unstaged else "nothing was left staged"


def _rename_records(top: pathlib.Path, moves) -> list:
    """update-index --index-info records that move every index entry under
    each old path to its new path with the same blob and mode: the rename as
    committed, never the working file. The longest matching old path wins."""
    proc = _git(["ls-files", "-s", "-z", "--"] + sorted({old for old, _ in moves}), top)
    if proc.returncode != 0:
        raise OSError("git ls-files failed: " + proc.stderr.strip())
    records = []
    for entry in (e for e in proc.stdout.split("\0") if e):
        meta, _, name = entry.partition("\t")
        mode, oid = meta.split()[:2]
        matches = [(old, new) for old, new in moves if name == old or name.startswith(old + "/")]
        if not matches:
            continue
        old, new = max(matches, key=lambda m: len(m[0]))
        records += [f"0 {oid}\t{name}", f"{mode} {oid}\t{new}{name[len(old):]}"]
    return records


def auto_commit(task_dir, message: str, *, paths, renames=(), no_commit: bool = False) -> Result:
    """Commit exactly `paths` (the files and folders this invocation wrote or
    deleted, staged with their working content) and `renames` ((old, new)
    pairs this invocation moved: the tracked entries under old move to new
    with their committed content, so an untracked or edited file that moved
    along is never committed)."""
    if not enabled(no_commit):
        return Result(0, "auto-commit is off; nothing committed")
    try:
        return _auto_commit(pathlib.Path(task_dir), message, paths, renames)
    except GitFailed as exc:
        return Result(13, f"auto-commit refused: {exc}; the PM files are written but not committed: "
                          + ", ".join(str(p) for p in list(paths)[:10]))


def _auto_commit(task_dir: pathlib.Path, message: str, paths, renames) -> Result:
    repo = _repo(task_dir, strict=True)
    if repo is None:
        return Result(0, f"note: {task_dir} is not in a git work tree; auto-commit skipped")
    top, git_dir = repo
    task_rel = _relative(task_dir)
    ignored = _git(["check-ignore", "-q", "--", task_rel], top)
    if ignored.returncode == 0:
        return Result(0, f"note: {task_rel} is ignored by git; auto-commit skipped")
    if ignored.returncode != 1:
        raise _failed("check-ignore", ignored)
    paths = [pathlib.Path(p) for p in paths]
    rels = [_relative(p) for p in paths]
    moves = [(_relative(pathlib.Path(old)), _relative(pathlib.Path(new))) for old, new in renames]
    touched = rels + [rel for move in moves for rel in move]
    left = "; the PM files are written but not committed: " + ", ".join(dict.fromkeys(touched[:10]))
    for name, what in _IN_PROGRESS:
        if (git_dir / name).exists():
            return Result(13, f"auto-commit refused: {what} is in progress ({name}){left}. Finish it, then commit "
                              "them, or let the next mm.py write that touches them do it")
    head = _git(["symbolic-ref", "-q", "HEAD"], top)
    if head.returncode == 1:
        return Result(13, f"auto-commit refused: HEAD is detached{left}. Check out a branch, then commit them")
    if head.returncode != 0:
        raise _failed("symbolic-ref", head)
    staged = _git(["diff", "--cached", "--name-only", "-z"], top)
    if staged.returncode != 0:
        return Result(13, "auto-commit refused: git diff --cached failed: " + staged.stderr.strip() + left)
    already = [n for n in staged.stdout.split("\0") if n]
    if already:
        return Result(13, "auto-commit refused: files are already staged (" + ", ".join(already[:10])
                      + "); the index was left as it was" + left)
    if not touched:
        return Result(0, "nothing to commit")
    steps = []
    if moves:
        try:
            records = _rename_records(top, moves)
        except OSError as exc:
            return Result(13, f"auto-commit refused: {exc}; the index was left as it was{left}")
        if records:
            steps.append((["update-index", "-z", "--index-info"], "\0".join(records) + "\0"))
    steps += [(["add", "--", rel] if path.exists() else ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", rel],
               None) for path, rel in zip(paths, rels)]
    for argv, stdin in steps:
        proc = _git(argv, top, stdin)
        if proc.returncode != 0:
            return Result(13, f"auto-commit refused: git {argv[0]} failed: {proc.stderr.strip()}; "
                              + _restore(top, touched) + left + _sandbox_note(proc.stderr, git_dir))
    quiet = _git(["diff", "--cached", "--quiet"], top)
    if quiet.returncode == 0:
        return Result(0, "nothing to commit")
    if quiet.returncode != 1:
        return Result(13, f"auto-commit refused: {_failed('diff --cached', quiet)}; {_restore(top, touched)}{left}")
    proc = _git(["commit", "-q", "-m", message], top)
    if proc.returncode != 0:
        return Result(13, "auto-commit refused: git commit failed; " + _restore(top, touched)
                      + left + _sandbox_note(proc.stderr, git_dir) + ":\n" + (proc.stdout + proc.stderr).strip())
    return Result(0, f"committed: {message}")
