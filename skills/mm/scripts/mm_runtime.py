"""Machine-readable runtime surfaces of mm.py: status --json, fence, product-changes.

status --json prints one mm.status/1 document: the session binding, the
task, its rows, what waits on the operator, the inbox, in-flight dispatches,
the loop, check and uncommitted PM changes, plus an errors list whose every
message ends with its recovery command. A document is printed, and the exit
is 0, for an unbound session and for every failure it can name.

fence --json reads one hook payload on stdin and prints the mm.fence/1
decision of the same fence hooks/guard.py applies; it writes nothing.

product-changes --json prints mm.changes/1: every dirty or untracked file
git sees outside the PM folder tree, as [size, mtime_ns] (null: deleted),
and HEAD; a dirty submodule adds its own dirty files (prefixed with its
path) and its checked-out HEAD under `submodules`. Given a prior document
with --baseline, it adds `changed`: the files whose fingerprint differs,
plus the product files committed in between when HEAD (or a submodule's
HEAD) moved. It is read-only and takes no lock.

The approval store is prompts/approvals.jsonl: one mm.approval/1 record per
line, written by approve-dispatch and consumed once by dispatch
--approval-id, both under the task's ledger.lock (mm_cli_loop drives them).
A record binds the task, row, route, model, worker, launch template and the
prompt's sha256 until it expires.
"""

import datetime
import hashlib
import json
import pathlib
import re
import sys

import mm_atomic
import mm_cli
import mm_cli_state
import mm_compile
import mm_fence
import mm_git
import mm_inbox
import mm_ledger
import mm_loop
import mm_schema
import mm_where
from mm_cli import CliError, _task_dir
from mm_cli_session import fence_root

import hookio  # on sys.path through mm_fence

STATUS_SCHEMA = "mm.status/1"
FENCE_SCHEMA = "mm.fence/1"
CHANGES_SCHEMA = "mm.changes/1"
COMMIT_RE = re.compile(r"^[0-9a-f]{4,64}$")
APPROVAL_SCHEMA = "mm.approval/1"
APPROVAL_ID_RE = re.compile(r"^a[0-9]+$")
WORKERS = ("subagent", "workflow", "codex", "bg", "other")
CHANNELS = ("cli", "cc-dialog")
TTL_DEFAULT, TTL_MAX = 15, 1440
OVERLAY = pathlib.Path(__file__).resolve().parent.parent / "mm.local.md"
_OPERATOR_RE = re.compile(r"^[ \t]*operator_name[ \t]*:[ \t]*(\S[^\r\n]*?)[ \t]*$", re.M)


# ---------------------------------------------------------------- status --json

def cmd_status(args) -> int:
    if not args.json:
        if not args.task_dir:
            raise CliError(2, "status needs --task-dir (status --json takes --task-dir or --session)")
        return mm_cli_state.cmd_status(args)
    if not args.task_dir and args.session is None:
        raise CliError(2, "status --json needs --task-dir or --session")
    doc = status_document(args.task_dir, args.session, args.mm_version)
    print(json.dumps(doc, ensure_ascii=False, indent=2))
    return 0


def _now() -> str:
    return datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()


def status_document(task_dir_arg, session_arg, version: str) -> dict:
    errors = []

    def error(code, message):
        if code not in [e["code"] for e in errors]:
            errors.append({"code": code, "message": message})

    doc = {"schema": STATUS_SCHEMA, "ok": True, "generated_at": _now(), "mm_version": version,
           "session": {"id": None, "binding_state": "not-asked", "bound": False, "role": None, "role_source": None,
                       "bound_at": None},
           "task_source": "none", "task": None, "mode": None, "open_row": None, "rows": [],
           "waiting_on_operator": [], "inbox": None, "dispatches_in_flight": [], "loop": None,
           "check": {"status": "not_run", "code": None, "lines": []}, "uncommitted": None, "errors": errors}
    state, record, sid = None, None, "<id>"
    if session_arg is not None:
        given = session_arg.strip()
        doc["session"]["id"] = given or None
        if not mm_where.SESSION_RE.match(given):
            error("SESSION-ID-UNUSABLE", f"the session id {given!r} is not usable (1 to 128 letters, digits, dots, "
                                         "underscores or dashes, starting with a letter or digit): pass the session "
                                         "id Claude Code reports: mm.py status --json --session <id>")
        else:
            sid = given
            state, record = mm_where.binding_record(sid)
            session = doc["session"]
            session["binding_state"] = state
            if state != "absent":
                session["bound"], session["role"] = True, "pm"
                session["role_source"] = mm_where.binding_role(record)[1] if state == "ok" else "fail-closed"
                bound_at = record.get("bound_at") if state == "ok" else None
                session["bound_at"] = bound_at if isinstance(bound_at, str) else None
            if state == "unreadable":
                error("BINDING-UNREADABLE", f"the binding file of session {sid} cannot be read, so every PM write "
                                            f"is refused (fail closed): run mm.py unbind --session {sid}, then mm.py "
                                            f"bind --task-dir <task> --session {sid}")
    if task_dir_arg:
        doc["task_source"] = "explicit"
        task_dir = pathlib.Path(task_dir_arg).absolute()
        try:
            root, source = fence_root(task_dir)
        except mm_git.GitFailed as exc:
            root, source = None, None
            error("GIT-FAILED", f"{exc}: fix git (its first error line is quoted above) and run mm.py status again")
    elif state == "ok":
        doc["task_source"] = "session"
        task_dir = pathlib.Path(record["task_dir"])
        root = record.get("repo_root")
        source = record.get("repo_root_source") if root else None
        if root is None:
            error("BINDING-LEGACY", f"the binding of session {sid} predates r26 and records no repository root, so "
                                    f"PM writes outside the PM folder are refused: run mm.py bind --task-dir "
                                    f"{task_dir} --session {sid} once to record the repository root")
    else:
        if state == "unreadable":
            doc["task_source"] = "session"
        return _finish(doc)
    if root is not None and mm_fence.broad_root(root):
        error("FENCE-ROOT-TOO-BROAD", f"the PM fence root {root} is a filesystem root or a folder holding your home "
                                      f"folder, so PM writes outside the PM folder are refused: run mm.py unbind "
                                      f"--session {sid}; bind refuses that root, so move the task into a repository "
                                      "or a project folder below your home folder before binding again")
    task = {"name": task_dir.name, "dir": str(task_dir), "repo_root": root, "repo_root_source": source,
            "dir_exists": task_dir.is_dir(), "legacy": False, "revision": None}
    doc["task"] = task
    if not task["dir_exists"]:
        if doc["task_source"] == "session":
            error("TASK-DIR-MISSING", f"the task folder {task_dir} was moved or closed: run mm.py unbind --session "
                                      f"{sid}, then bind the task where it now lives")
        else:
            error("NO-TASK", f"no task folder at {task_dir}: pass --task-dir, or run mm.py bind --task-dir <task> "
                             f"--session {sid}")
        return _finish(doc)
    task["legacy"] = mm_cli._is_legacy(task_dir)
    if not task["legacy"] and not (task_dir / "ledger.json").is_file():
        error("NO-TASK", f"{task_dir} holds no ledger.json: pass --task-dir, or run mm.py bind --task-dir <task> "
                         f"--session {sid}")
        return _finish(doc)
    ledger = None
    try:
        ledger = _legacy_doc(task_dir) if task["legacy"] else mm_ledger.load_ledger(task_dir)
    except (OSError, ValueError, KeyError, mm_ledger.LedgerValidationError) as exc:
        error("LEDGER-INVALID", f"the ledger of {task_dir} is invalid ({exc}): run mm.py check --task-dir "
                                f"{task_dir} and repair what it reports with mm.py commands")
    if ledger is not None:
        _fill_ledger(doc, task, ledger)
    try:
        entries, problems, late = mm_inbox.counts(task_dir)
        doc["inbox"] = {"entries": entries, "problems": problems, "closed_task_files": late}
    except (OSError, ValueError) as exc:
        doc["inbox"] = None
        error("INBOX-UNREADABLE", f"the inbox of {task_dir} cannot be scanned ({exc}), so worker reports may be "
                                  f"missed: run mm.py inbox-scan --task-dir {task_dir} to see which file, fix or "
                                  "move it aside, and run mm.py status again")
    store = mm_loop.records_path(task_dir)
    try:
        doc["dispatches_in_flight"] = [_flight(r) for r in mm_loop.in_flight_records(mm_loop.read_records(task_dir))]
    except (OSError, ValueError, AttributeError, TypeError) as exc:
        error("DISPATCHES-UNREADABLE", f"the dispatch log {store} cannot be read or holds a line that is not a "
                                       f"dispatch record ({type(exc).__name__}: {exc}), so in-flight dispatches are "
                                       f"unknown: inspect {store}, move the bad line aside, and run mm.py status "
                                       "again")
    try:
        code, lines = mm_cli_state.check_report(task_dir)
        doc["check"] = {"status": {0: "ok", 3: "fixable"}.get(code, "failed"), "code": code, "lines": lines[:20]}
    except Exception as exc:
        error("CHECK-RAISED", f"mm.py check raised {type(exc).__name__}: {exc}: run mm.py check --task-dir "
                              f"{task_dir} to see the error")
    try:
        doc["uncommitted"] = mm_git.pending(task_dir)
    except mm_git.GitFailed as exc:
        error("GIT-FAILED", f"{exc}: fix git (its first error line is quoted above) and run mm.py status again")
    return _finish(doc)


def _finish(doc: dict) -> dict:
    doc["ok"] = not doc["errors"]
    return doc


def _legacy_doc(task_dir: pathlib.Path) -> dict:
    doc = mm_compile._doc_from_slices(mm_compile.parse_handoff((task_dir / "HANDOFF.md").read_text(encoding="utf-8")))
    doc["task"] = doc["dashboard_index"].get("Task") or task_dir.name
    return doc


def _fill_ledger(doc: dict, task: dict, ledger: dict) -> None:
    task["name"] = ledger.get("task") or task["name"]
    revision = ledger.get("revision")
    task["revision"] = revision if isinstance(revision, int) and not task["legacy"] else None
    loop = ledger.get("loop") if isinstance(ledger.get("loop"), dict) else None
    doc["mode"] = "unattended" if (loop or {}).get("mode") == "unattended" else "attended"
    doc["loop"] = _loop(loop) if loop is not None else None
    rows = [r for r in ledger.get("rows", []) if isinstance(r, dict)]
    doc["rows"] = [_row(r) for r in rows]
    open_row = next((r for r in rows if r.get("state") not in mm_schema.TERMINAL and not r.get("is_wrapup")), None)
    if open_row is not None:
        doc["open_row"] = {k: open_row.get(k) for k in ("id", "item", "state", "status_label")}
    doc["waiting_on_operator"] = mm_cli_state.waiting_on_operator(ledger)


def _row(row: dict) -> dict:
    return {"id": row.get("id"), "item": row.get("item"), "state": row.get("state"),
            "status_label": row.get("status_label"), "blocked": bool(row.get("blocked")),
            "user_facing": bool(row.get("user_facing")), "test_level": row.get("test_level") or None,
            "pr": row.get("pr") or None, "test_page": row.get("test_page") or None,
            "is_wrapup": bool(row.get("is_wrapup"))}


def _loop(loop: dict) -> dict:
    last = loop.get("last_tick")
    return {"mode": loop.get("mode", "off"), "cadence": loop.get("cadence") or None,
            "routes": list(loop.get("routes") or []), "noop_count": loop.get("noop_count", 0),
            "noop_cap": loop.get("noop_cap", mm_loop.NOOP_CAP),
            "last_tick": {"at": last.get("at"), "result": last.get("result")} if isinstance(last, dict) and last
            else None,
            "stopped_reason": loop.get("stopped_reason") or None, "owner_session": loop.get("owner_session") or None}


def _flight(record: dict) -> dict:
    last = (record.get("liveness") or [{}])[-1]
    return {"id": record.get("id"), "at": record.get("at"), "route": record.get("route"),
            "model": record.get("model"), "row": record.get("row") or None, "mode": record.get("mode"),
            "worker": record.get("worker"), "approval_id": record.get("approval_id"),
            "last_verdict": last.get("verdict") if isinstance(last, dict) else None}


# ---------------------------------------------------------------- fence --json

def cmd_fence(args) -> int:
    import guard
    stream = sys.stdin
    raw = stream.buffer.read() if hasattr(stream, "buffer") else stream.read().encode("utf-8")
    data, problem = guard.parse_payload(raw)
    if data is None:
        found = {"decision": "deny", "actor": "unknown", "targets": [], "messages": [guard.unreadable(problem)]}
    else:
        found = guard.decide(data)
    print(json.dumps({"schema": FENCE_SCHEMA, **found}, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------- product-changes --json

def cmd_product_changes(args) -> int:
    task_dir = _task_dir(args)
    if not task_dir.is_dir():
        raise CliError(4, f"no task at {task_dir}")
    baseline = _baseline(args.baseline) if args.baseline is not None else None
    try:
        doc = product_changes(task_dir, baseline)
    except mm_git.GitFailed as exc:
        raise CliError(21, f"mm.py product-changes: {exc}; no document printed. Fix what git names, then rerun")
    print(json.dumps(doc, ensure_ascii=False, indent=2))
    return 0


def _baseline(source: str) -> dict:
    try:
        text = sys.stdin.read() if source == "-" else pathlib.Path(source).read_text(encoding="utf-8")
        doc = json.loads(text)
    except (OSError, ValueError) as exc:
        raise CliError(2, f"--baseline {source} cannot be read as JSON ({exc})")
    def commit(value):
        return value is None or (isinstance(value, str) and COMMIT_RE.match(value))
    head = doc.get("head") if isinstance(doc, dict) else None
    subs = doc.get("submodules", {}) if isinstance(doc, dict) else None
    if not isinstance(doc, dict) or not isinstance(doc.get("files"), dict) or not commit(head) or \
            not isinstance(subs, dict) or not all(commit(v) for v in subs.values()):
        raise CliError(2, f"--baseline {source} is not a {CHANGES_SCHEMA} document (files object, head a commit id "
                          "or null, submodules absent or an object of commit ids or nulls)")
    return doc


def product_changes(task_dir: pathlib.Path, baseline=None) -> dict:
    """The mm.changes/1 document; raises mm_git.GitFailed when git fails."""
    repo = mm_git._repo(task_dir, strict=True)
    if repo is None:
        doc = {"schema": CHANGES_SCHEMA, "repo_root": None, "head": None, "files": {}, "submodules": {}}
        top = None
    else:
        top = repo[0]
        files, submodules = {}, {}
        _dirty(top, "", files, submodules)
        doc = {"schema": CHANGES_SCHEMA, "repo_root": str(top), "head": _head(top), "files": files,
               "submodules": submodules}
    if baseline is not None:
        doc["changed"] = _changed(baseline, doc, top)
    return doc


def _dirty(work: pathlib.Path, prefix: str, files: dict, submodules: dict) -> None:
    """Fingerprint every dirty or untracked path git status reports in the
    work tree `work`, keyed `prefix + path`. A reported folder holding a .git
    entry is a dirty submodule (or a nested repository): its checked-out HEAD
    goes into `submodules` and its own dirty files are fingerprinted the same
    way, so an edit inside an already-dirty submodule changes a fingerprint."""
    proc = mm_git._git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], work)
    if proc.returncode != 0:
        raise mm_git._failed("status" + (f" in submodule {prefix.rstrip('/')}" if prefix else ""), proc)
    for rel in _porcelain_paths(proc.stdout):
        key = prefix + rel
        if hookio.in_pm_tree(key):
            continue
        files[key] = _fingerprint(work / rel)
        inner = work / rel.rstrip("/")
        if inner.is_dir() and (inner / ".git").exists():
            name = key.rstrip("/")
            submodules[name] = _head(inner)
            _dirty(inner, name + "/", files, submodules)


def _porcelain_paths(out: str) -> list:
    """The paths of `git status --porcelain=v1 -z`; a rename (R in either
    status column) also names its old path, which is gone from the work tree;
    a copy (C) names its unchanged source, which is read and dropped."""
    entries, paths, i = out.split("\0"), [], 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        paths.append(entry[3:])
        if "R" in entry[:2] or "C" in entry[:2]:
            if "R" in entry[:2] and i < len(entries) and entries[i]:
                paths.append(entries[i])
            i += 1
    return list(dict.fromkeys(paths))


def _fingerprint(path: pathlib.Path):
    try:
        st = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    return [st.st_size, st.st_mtime_ns]


def _head(top: pathlib.Path):
    """HEAD's commit id; None for an unborn HEAD (a repository with no commit
    yet); raises GitFailed for anything else."""
    proc = mm_git._git(["rev-parse", "--verify", "-q", "HEAD"], top)
    if proc.returncode == 0:
        return proc.stdout.strip()
    if proc.returncode == 1 and not proc.stdout.strip():
        git_dir = mm_git._git(["rev-parse", "--git-dir"], top)
        if git_dir.returncode == 0:
            return None
        raise mm_git._failed("rev-parse --git-dir", git_dir)
    raise mm_git._failed("rev-parse --verify HEAD", proc)


def _changed(baseline: dict, doc: dict, top) -> list:
    before, after = baseline.get("files") or {}, doc["files"]
    changed = {p for p in set(before) | set(after) if (p in before) != (p in after) or before.get(p) != after.get(p)}
    old, new = baseline.get("head"), doc["head"]
    if top is not None and new is not None and old != new:
        argv = ["ls-tree", "-r", "--name-only", "-z", new] if old is None else \
            ["diff", "--name-only", "--no-renames", "-z", f"{old}..{new}"]
        proc = mm_git._git(argv, top)
        if proc.returncode != 0:
            raise mm_git._failed(argv[0], proc)
        changed |= {p for p in proc.stdout.split("\0") if p}
    old_subs, new_subs = baseline.get("submodules") or {}, doc.get("submodules") or {}
    for sub in set(old_subs) | set(new_subs):
        old, new = old_subs.get(sub), new_subs.get(sub)
        if (sub in old_subs) == (sub in new_subs) and old == new:
            continue
        changed.add(sub)
        if top is not None and old is not None and new is not None:
            proc = mm_git._git(["diff", "--name-only", "--no-renames", "-z", f"{old}..{new}"], top / sub)
            if proc.returncode != 0:
                raise mm_git._failed(f"diff in submodule {sub}", proc)
            changed |= {f"{sub}/{p}" for p in proc.stdout.split("\0") if p}
    return sorted(p for p in changed if not hookio.in_pm_tree(p))


# ---------------------------------------------------------------- approvals store

class ApprovalStoreError(Exception):
    """prompts/approvals.jsonl cannot be read, or a line is not an approval record."""


def _clock() -> datetime.datetime:
    return datetime.datetime.now().astimezone().replace(microsecond=0)


def operator_name() -> str:
    """operator_name from the overlay mm.local.md beside SKILL.md, or ""."""
    try:
        text = OVERLAY.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    found = _OPERATOR_RE.search(text)
    return found.group(1).strip().strip("\"'").strip() if found else ""


def approvals_path(task_dir) -> pathlib.Path:
    return pathlib.Path(task_dir) / "prompts" / "approvals.jsonl"


def read_approvals(task_dir) -> list:
    path = approvals_path(task_dir)
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ApprovalStoreError(f"{path} cannot be read ({exc})")
    records = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            raise ApprovalStoreError(f"{path} line {number} is not JSON ({exc})")
        if not isinstance(record, dict) or not isinstance(record.get("id"), str) or \
                not APPROVAL_ID_RE.match(record["id"]):
            raise ApprovalStoreError(f"{path} line {number} is not an approval record (an object whose id is a<N>)")
        records.append(record)
    return records


def write_approvals(task_dir, records: list) -> None:
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    mm_atomic.atomic_write_text(approvals_path(task_dir), text, encoding="utf-8", newline="\n")


def new_approval(records: list, *, task, task_dir, row, route, model, worker, launch, prompt_path, prompt_bytes,
                 operator, channel, session, ttl_minutes) -> dict:
    """The next mm.approval/1 record (id a<N>, max + 1); `launch` is the
    resolved template, `prompt_bytes` the exact bytes approved."""
    numbers = [int(r["id"][1:]) for r in records]
    now = _clock()
    return {"id": "a%d" % (max(numbers, default=0) + 1), "task": task, "task_dir": str(task_dir), "row": row,
            "route": route, "model": model, "worker": worker, "launch": launch, "prompt_path": str(prompt_path),
            "prompt_sha256": hashlib.sha256(prompt_bytes).hexdigest(), "prompt_bytes": len(prompt_bytes),
            "operator": operator, "channel": channel, "session": session, "approved_at": now.isoformat(),
            "expires_at": (now + datetime.timedelta(minutes=ttl_minutes)).isoformat(), "consumed_at": None,
            "consumed_by": None}


def _same_dir(recorded, current) -> bool:
    """True when both name one folder once links and case are resolved; a
    missing or unresolvable recorded folder never matches."""
    if not isinstance(recorded, str) or not recorded:
        return False
    try:
        return mm_fence.resolved(recorded) == mm_fence.resolved(current)
    except (OSError, ValueError):
        return False


def approval_refusal(record: dict, *, now, **expected):
    """(code, detail) when `record` cannot approve this dispatch, else None.
    Checked in order: CONSUMED, EXPIRED, MISMATCH:<field> for task, task_dir,
    row, route, model, worker and launch, then PROMPT-CHANGED
    (`prompt_sha256`). task_dir compares resolved, case-normalized folders, so
    an approval copied into another worktree's copy of the task approves
    nothing there."""
    if record.get("consumed_at") is not None:
        return "CONSUMED", f"{record['id']} was consumed by {record.get('consumed_by')} at {record['consumed_at']}"
    try:
        expires = datetime.datetime.fromisoformat(str(record.get("expires_at")))
        live = expires.tzinfo is not None and now < expires
    except ValueError:
        expires, live = record.get("expires_at"), False
    if not live:
        return "EXPIRED", f"{record['id']} expired at {expires}"
    for field in ("task", "task_dir", "row", "route", "model", "worker", "launch"):
        same = _same_dir(record.get(field), expected[field]) if field == "task_dir" \
            else record.get(field) == expected[field]
        if not same:
            return f"MISMATCH:{field}", (f"{record['id']} approved {field} {record.get(field)!r}; this dispatch gives "
                                         f"{expected[field]!r}")
    if record.get("prompt_sha256") != expected["prompt_sha256"]:
        return "PROMPT-CHANGED", (f"the prompt's sha256 is now {expected['prompt_sha256'][:12]}, but "
                                  f"{record['id']} approved {str(record.get('prompt_sha256'))[:12]}")
    return None
