"""Which copy of a task to write, and which task this session is on.

.private/pm is git-tracked, so every worktree holds its own copy of a task.
copies() lists them (ledger revision, or the 0A Last updated of a legacy
HANDOFF), canonical() names the newest, and state() tells a writer its copy
is stale (behind) or split from another copy (diverged: equal revisions with
different content, or a lower revision missing from the higher copy's git
history), in which case no copy may be written until the operator resolves it. closed_elsewhere() finds a move of the task to done/ on another
ref. Sessions bind to a task in ${MM_STATE_DIR:-~/.local/state/mm}/sessions/;
resolve() applies the router order: explicit path, session binding, branch,
the only matching active/ folder. A git failure other than "not a git
repository" raises mm_git.GitFailed, never reads as "no other copy".
"""

import datetime
import json
import os
import pathlib
import re

import mm_atomic
import mm_git

PM_ROOTS = (".private/pm", ".claude/pm", "docs/pm")
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_LAST_UPDATED_RE = re.compile(r"^\s*-\s+Last updated:\s*(.*)$", re.M)


class WhereError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def state_dir() -> pathlib.Path:
    env = os.environ.get("MM_STATE_DIR")
    return pathlib.Path(env) if env else pathlib.Path.home() / ".local" / "state" / "mm"


def _binding(session: str) -> pathlib.Path:
    if not SESSION_RE.match(session or ""):
        raise WhereError(2, "no usable session id; hosts without one skip binding")
    return state_dir() / "sessions" / f"{session}.json"


def bind(task_dir: pathlib.Path, session: str, repo_root: str, repo_root_source: str) -> pathlib.Path:
    """Write the binding: the task, when, the role (always pm: only the PM
    binds) and the PM fence root resolved once here, so the guard needs no git."""
    path = _binding(session)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"task_dir": str(pathlib.Path(task_dir).absolute()),
              "bound_at": datetime.datetime.now().astimezone().replace(microsecond=0).isoformat(),
              "role": "pm", "repo_root": str(repo_root), "repo_root_source": repo_root_source}
    mm_atomic.atomic_write_text(path, json.dumps(record, indent=2) + "\n")
    return path


def whoami(session: str):
    path = _binding(session)
    try:
        return pathlib.Path(json.loads(path.read_text(encoding="utf-8"))["task_dir"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def binding_record(session: str) -> tuple:
    """("absent", None), ("ok", record) or ("unreadable", None). Unreadable:
    the file cannot be read, is not JSON, is not an object, has no string
    task_dir, or has a repo_root that is not a non-empty string. A record
    without repo_root is ok (a binding made before r26)."""
    path = _binding(session)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "absent", None
    except (OSError, ValueError):
        return "unreadable", None
    try:
        record = json.loads(text)
    except ValueError:
        return "unreadable", None
    if not isinstance(record, dict) or not isinstance(record.get("task_dir"), str):
        return "unreadable", None
    if "repo_root" in record and not (isinstance(record["repo_root"], str) and record["repo_root"]):
        return "unreadable", None
    return "ok", record


def binding_role(record: dict) -> tuple:
    """(role, source): every bound session is the PM. Source "binding" when
    the record says pm, "legacy-default" when it has no role (made before
    r26), "fail-closed" for any other value."""
    if "role" not in record:
        return "pm", "legacy-default"
    return "pm", "binding" if record["role"] == "pm" else "fail-closed"


def unbind(session: str) -> bool:
    path = _binding(session)
    if path.is_file():
        path.unlink()
        return True
    return False


def _key(copy_dir: pathlib.Path):
    """(sort key, label): a ledger copy by revision, a legacy copy by its 0A
    Last updated; any ledger copy sorts above any legacy one."""
    ledger = copy_dir / "ledger.json"
    if ledger.is_file():
        try:
            revision = json.loads(ledger.read_text(encoding="utf-8")).get("revision")
        except (OSError, ValueError, AttributeError):
            revision = None
        revision = revision if isinstance(revision, int) else -1
        return (1, revision), f"revision {revision}"
    try:
        m = _LAST_UPDATED_RE.search((copy_dir / "HANDOFF.md").read_text(encoding="utf-8", errors="replace"))
    except OSError:
        m = None
    stamp = m.group(1).strip() if m else ""
    return (0, stamp), f"legacy, Last updated {stamp or 'unknown'}"


def copies(task_dir: pathlib.Path) -> list:
    """Every worktree copy of the task as dicts (path, key, label, this);
    empty outside git or with a single worktree."""
    task_dir = pathlib.Path(task_dir)
    repo = mm_git._repo(task_dir, strict=True)
    if repo is None or not task_dir.exists():
        return []
    proc = mm_git._git(["worktree", "list", "--porcelain"], repo[0])
    if proc.returncode != 0:
        raise mm_git._failed("worktree list", proc)
    trees = [line[len("worktree "):] for line in proc.stdout.splitlines() if line.startswith("worktree ")]
    if len(trees) < 2:
        return []
    rel = mm_git._relative(task_dir)
    this = task_dir.resolve()
    out = []
    for tree in trees:
        candidate = (pathlib.Path(tree) / rel).resolve()
        if (candidate / "ledger.json").is_file() or (candidate / "HANDOFF.md").is_file():
            key, label = _key(candidate)
            out.append({"path": candidate, "key": key, "label": label, "this": candidate == this})
    return out


def canonical(found: list):
    if not found:
        return None
    best = max(c["key"] for c in found)
    top = [c for c in found if c["key"] == best]
    return next((c for c in top if c["this"]), top[0])


def _blob(copy_dir: pathlib.Path):
    """The git blob id of the copy's ledger.json, through git's own
    filters, so a CRLF checkout hashes like the committed file."""
    proc = mm_git._git(["hash-object", "--", "ledger.json"], copy_dir)
    if proc.returncode != 0:
        raise mm_git._failed("hash-object", proc)
    return proc.stdout.strip()


def _lineage(copy_dir: pathlib.Path) -> set:
    """Every ledger.json blob reachable from the copy's HEAD, plus its
    working file: the states this copy has passed through."""
    proc = mm_git._git(["log", "--format=", "--raw", "--no-abbrev", "--full-history", "-m", "--", "ledger.json"],
                       copy_dir)
    if proc.returncode != 0:
        raise mm_git._failed("log", proc)
    blobs = {part for line in proc.stdout.splitlines() if line.startswith(":") for part in line.split()[2:4]}
    blobs.add(_blob(copy_dir))
    return {b for b in blobs if b and b.strip("0")}


def diverged(found: list):
    """(other copy, why) when this copy and another ledger copy split: the
    same revision with different content, or a lower revision that is not in
    the higher copy's history. None when the copies form one line."""
    this = next((c for c in found if c["this"]), None)
    if this is None or this["key"][0] != 1:
        return None
    mine, theirs = _blob(this["path"]), None
    for other in found:
        if other is this or other["key"][0] != 1:
            continue
        if other["key"] == this["key"]:
            if _blob(other["path"]) != mine:
                return other, f"the same {this['label']} with different content"
        elif other["key"] > this["key"]:
            if mine not in _lineage(other["path"]):
                return other, f"{other['label']}, whose history does not contain this copy's {this['label']}"
        else:
            theirs = theirs if theirs is not None else _lineage(this["path"])
            if _blob(other["path"]) not in theirs:
                return other, f"{other['label']}, which is not in this copy's history"
    return None


def state(task_dir: pathlib.Path) -> tuple:
    """("diverged", other path, why), ("behind", canonical path, ""), or
    ("ok", None, "") for a writer about to change this copy."""
    found = copies(task_dir)
    split = diverged(found)
    if split is not None:
        return "diverged", split[0]["path"], split[1]
    ahead = _behind(found)
    return ("behind", ahead, "") if ahead is not None else ("ok", None, "")


def behind(task_dir: pathlib.Path):
    """The canonical copy's path when this copy is behind it, else None."""
    return _behind(copies(task_dir))


def _behind(found: list):
    best = canonical(found)
    this = next((c for c in found if c["this"]), None)
    if best is None or this is None or best is this or best["key"] <= this["key"]:
        return None
    return best["path"]


def closed_elsewhere(task_dir: pathlib.Path):
    """The ref on which this active/ task was moved to done/, or None."""
    task_dir = pathlib.Path(task_dir)
    if task_dir.parent.name != "active":
        return None
    repo = mm_git._repo(task_dir, strict=True)
    if repo is None:
        return None
    pm_rel = mm_git._relative(task_dir.parent.parent)
    old, new = f"{pm_rel}/active/{task_dir.name}/", f"{pm_rel}/done/{task_dir.name}/"
    proc = mm_git._git(["log", "--all", "--diff-filter=R", "--name-status", "--format=commit %H", "--", pm_rel],
                       repo[0])
    if proc.returncode != 0:
        raise mm_git._failed("log", proc)
    commit = None
    for line in proc.stdout.splitlines():
        if line.startswith("commit "):
            commit = line.split(" ", 1)[1].strip()
            continue
        parts = line.split("\t")
        if commit and len(parts) == 3 and parts[0].startswith("R") and parts[1].startswith(old) \
                and parts[2].startswith(new):
            refs = mm_git._git(["branch", "-a", "--contains", commit, "--format=%(refname:short)"], repo[0])
            if refs.returncode != 0:
                raise mm_git._failed("branch --contains", refs)
            names = [r.strip() for r in refs.stdout.splitlines() if r.strip()]
            return names[0] if names else commit[:12]
    return None


def _branch(repo: pathlib.Path) -> str:
    if mm_git._repo(repo, strict=True) is None:
        return ""
    proc = mm_git._git(["symbolic-ref", "-q", "--short", "HEAD"], repo)
    if proc.returncode not in (0, 1):
        raise mm_git._failed("symbolic-ref", proc)
    return proc.stdout.strip()


def resolve(explicit=None, session=None, repo=None, pattern=None) -> tuple:
    """(task dir or None, source): explicit > session > branch > the only
    matching active/ folder. None means ask the operator."""
    if explicit:
        return pathlib.Path(explicit).absolute(), "explicit"
    if session:
        bound = whoami(session)
        if bound is not None:
            return bound, "session"
    if not repo:
        return None, "no --repo to look for a branch or folder"
    repo = pathlib.Path(repo)
    folders = sorted(d for root in PM_ROOTS if (repo / root / "active").is_dir()
                     for d in (repo / root / "active").iterdir() if d.is_dir())
    if pattern:
        folders = [d for d in folders if re.search(pattern, d.name)]
    branch = _branch(repo)
    if branch:
        if pattern:
            m = re.search(pattern, branch)
            hits = [d for d in folders if m and m.group(0) in d.name]
        else:
            hits = [d for d in folders if d.name in branch.split("/")]
        if len(hits) == 1:
            return hits[0], "branch"
    if len(folders) == 1:
        return folders[0], "folder"
    return None, f"{len(folders)} active folders and the branch {branch or '(none)'} name no single task"
