"""The PM write fence: who writes, and whether the write lands in product code.

hooks/guard.py and `mm.py fence` both decide through evaluate(), so one
payload gets one decision. The actor of a hook payload is "unbound" (no
usable session id, or no binding), "worker" (the payload carries a non-empty
agent_id: a subagent or workflow agent of the session, decided before the
binding is read), "pm-unreadable" (the binding file cannot be read) or "pm".
A PM write is allowed under the PM folder tree (.private/pm, .claude/pm,
docs/pm) and outside the bound task's repository, and refused inside it.
The repository root was resolved once by `mm.py bind` and is read from the
binding, so no git runs here. Every target is resolved first (links,
junctions and `..` followed), so a path through a PM folder cannot reach
product code, and a target that cannot be resolved is refused for the PM.
The ledger and generated-file rules (guard.verdict) apply to every actor,
on both the target as written and its resolved destination: a link at
either end of a write to a protected file does not unprotect it.
Anything uncertain fails closed: a false refusal is visible and recoverable.

The path helpers take strings and touch no file; `pathmod` defaults to the
module's PATHMOD, read at call time, so a test can pass ntpath or posixpath
on any OS.
"""

import os
import pathlib
import sys

HOOKS = pathlib.Path(__file__).resolve().parent.parent / "hooks"
if str(HOOKS) not in sys.path:
    sys.path.insert(0, str(HOOKS))

import hookio  # noqa: E402
import mm_where  # noqa: E402

PATHMOD = os.path
NO_TOOL_NAME = ("mm guard: this PreToolUse event has no recognizable tool name (missing, empty or not a string), so "
                "it is refused: the guard cannot tell whether it writes a protected PM file (it fails closed)")


# ---------------------------------------------------------------- path helpers (pure)

def within(path: str, root: str, pathmod=None) -> bool:
    """True when `path` is `root` or below it. Paths on different drives or
    UNC shares never contain one another (commonpath would raise for them)."""
    pathmod = PATHMOD if pathmod is None else pathmod
    p, r = pathmod.normcase(path), pathmod.normcase(root)
    if pathmod.splitdrive(p)[0] != pathmod.splitdrive(r)[0]:
        return False
    return pathmod.commonpath([p, r]) == r


def broad_root_of(r: str, h: str, pathmod=None) -> bool:
    """True when the root `r` is a filesystem root (/, a drive, a UNC share)
    or holds the home folder `h`: fencing it would fence ~/.claude and memory."""
    pathmod = PATHMOD if pathmod is None else pathmod
    return pathmod.dirname(r) == r or within(h, r, pathmod)


# ---------------------------------------------------------------- filesystem layer

def realpath(p) -> str:
    """Links, junctions and `..` followed; a missing tail kept as written."""
    return PATHMOD.realpath(p)


def resolved(p) -> str:
    return PATHMOD.normcase(realpath(p))


def home() -> str:
    return str(pathlib.Path.home())


def broad_root(root) -> bool:
    """broad_root_of on the resolved root and home; a resolution error counts
    as broad (fail closed)."""
    try:
        return broad_root_of(resolved(root), resolved(home()))
    except Exception:
        return True


def path_class(target, root) -> str:
    """PMT (under a PM folder), PROD (inside `root`), OUT, or ERR (the
    resolution or the containment test raised), from the resolved target."""
    try:
        canon = resolved(target)
    except Exception:
        return "ERR"
    if hookio.in_pm_tree(canon):
        return "PMT"
    try:
        return "PROD" if within(canon, resolved(root)) else "OUT"
    except Exception:
        return "ERR"


# ---------------------------------------------------------------- actor

def _actor(data: dict) -> tuple:
    """(actor, session id, binding record or None)."""
    session = hookio.session_id(data)
    if not session or not mm_where.SESSION_RE.match(session):
        return "unbound", session, None
    agent = data.get("agent_id")
    if isinstance(agent, str) and agent.strip():
        return "worker", session, None
    state, record = mm_where.binding_record(session)
    if state == "absent":
        return "unbound", session, None
    if state == "unreadable":
        return "pm-unreadable", session, None
    return "pm", session, record


def actor(data: dict) -> str:
    return _actor(data)[0]


# ---------------------------------------------------------------- the decision table

def _unreadable(session):
    return (f"mm guard: the session binding for {session} cannot be read, so every write from this PM session is "
            f"refused (fail closed), PM notes included. Run mm.py unbind --session {session}, then mm.py bind "
            f"--task-dir <task> --session {session}")


def _legacy(session, task_dir):
    return (f"mm guard: the binding of session {session} predates r26 and records no repository root, so PM writes "
            f"outside the PM folder are refused (fail closed). Run mm.py bind --task-dir {task_dir} --session "
            f"{session} once to record it")


def _broad(session, root):
    return (f"mm guard: the binding of session {session} records {root} as its repository root, a filesystem root or "
            f"a folder holding your home folder, so PM writes outside the PM folder are refused (fail closed), "
            f"~/.claude and memory included. Run mm.py unbind --session {session}; bind refuses that root, so move "
            f"the task into a repository or a project folder below your home folder before binding again")


def _product(path, root, task_dir, session):
    return (f"mm guard: PM mode cannot directly modify product code: {path} is in {root}, the repository of the "
            f"bound task {task_dir}. Delegate it (subagent, workflow, Codex or background session, recorded with "
            f"mm.py dispatch), or leave PM mode: mm.py unbind --session {session}")


def _target(target: str, who: str, session: str, record, verdict) -> tuple:
    """(path to report, class or None, refusal or None) for one write target;
    the first matching row of rows 4 to 12 decides."""
    try:
        canon = resolved(target)
        real = realpath(target)
        error = None
    except Exception as exc:
        canon = real = None
        error = exc
    pmt = error is None and hookio.in_pm_tree(canon)
    shown, cls = (real, "PMT" if pmt else None) if error is None else (target, "ERR")
    refusal = (verdict(pathlib.Path(real)) if error is None else None) or verdict(pathlib.Path(target))
    if refusal:
        return shown, cls, refusal
    if who in ("worker", "unbound"):
        return shown, cls, None
    if who == "pm-unreadable":
        return shown, cls, _unreadable(session)
    if who != "pm":
        return shown, cls, (f"mm guard: no fence rule matched {target} for actor {who}, so the write is refused "
                            "(fail closed)")
    if pmt:
        return shown, cls, None
    if "repo_root" not in record:
        return shown, cls, _legacy(session, record.get("task_dir"))
    root = record["repo_root"]
    if broad_root(root):
        return shown, cls, _broad(session, root)
    if error is None:
        try:
            if within(canon, resolved(root)):
                return shown, "PROD", _product(real, root, record.get("task_dir"), session)
            return shown, "OUT", None
        except Exception as exc:
            error = exc
    return shown, "ERR", (f"mm guard: cannot tell whether {target} is product code ({error}), so the PM write is "
                          "refused (fail closed)")


def evaluate(data: dict, verdict=None, is_write=None) -> dict:
    """{decision, actor, targets: [{path, class}], messages} for one payload.
    `verdict` and `is_write` are guard.py's ledger rule and write test."""
    if verdict is None or is_write is None:
        import guard
        verdict, is_write = verdict or guard.verdict, is_write or guard.is_write
    doc = {"decision": "allow", "actor": "unknown", "targets": [], "messages": []}
    name = data.get("tool_name")
    if not (isinstance(name, str) and name.strip()):
        event = data.get("hook_event_name")
        if isinstance(event, str) and event.strip() and event.strip() != "PreToolUse":
            return doc
        return _deny(doc, [NO_TOOL_NAME])
    try:
        who, session, record = _actor(data)
    except Exception:
        who, session, record = "unknown", "", None
    doc["actor"] = who
    if not is_write(data):
        return doc
    try:
        paths = hookio.target_paths(data)
        if not paths:
            doc["targets"] = [{"path": None, "class": "UNK"}]
            return _deny(doc, [f"mm guard: cannot tell which file this {name} call writes, so it is refused (the "
                               "guard fails closed for write tools). Name the file in the tool call; PM files change "
                               "only through mm.py"])
        messages = []
        for path in paths:
            shown, cls, refusal = _target(str(path), who, session, record, verdict)
            doc["targets"].append({"path": shown, "class": cls})
            if refusal and refusal not in messages:
                messages.append(refusal)
    except Exception as exc:
        doc["targets"] = doc["targets"] or [{"path": None, "class": "UNK"}]
        return _deny(doc, [f"mm guard: cannot tell whether this {name} call writes a protected PM file ({exc}), so "
                           "it is refused (the guard fails closed for write tools)"])
    return _deny(doc, messages) if messages else doc


def _deny(doc: dict, messages: list) -> dict:
    doc["decision"], doc["messages"] = "deny", messages
    return doc


def refusals(data: dict) -> list:
    return evaluate(data)["messages"]
