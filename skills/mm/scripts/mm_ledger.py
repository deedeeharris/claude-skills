"""Task ledger: the single authority for a task's state.

Storage decision (binding): one atomically-replaced UTF-8 JSON document per
task, not SQLite -- .private/pm/ is git-tracked in some repos and a binary
blob is unmergeable; concurrency here is one interactive session plus an
occasional cron tick, which the lock file plus compare-and-swap below
covers. Storage is hidden behind load_ledger/save_ledger so this decision
is reversible. This module never parses or writes Markdown -- that is
mm_compile's job.
"""

import contextlib
import ctypes
import json
import os
import pathlib
import re
import time
from datetime import datetime

import mm_atomic
import mm_schema

if os.name == "nt":
    from ctypes import wintypes

STATES = mm_schema.STATES

TERMINAL = mm_schema.TERMINAL

ALLOWED_TRANSITIONS = {
    "BACKLOG":        ("INVESTIGATING", "SPEC_READY", "IMPLEMENTING", "NEEDS_DECISION", "ABANDONED"),
    "INVESTIGATING":  ("SPEC_READY", "NEEDS_DECISION", "BACKLOG", "ABANDONED"),
    "NEEDS_DECISION": ("BACKLOG", "INVESTIGATING", "SPEC_READY", "IMPLEMENTING", "REVIEW", "ABANDONED"),
    "SPEC_READY":     ("IMPLEMENTING", "NEEDS_DECISION", "ABANDONED"),
    "IMPLEMENTING":   ("REVIEW", "LOCAL_GREEN", "NEEDS_DECISION", "ABANDONED"),
    "REVIEW":         ("IMPLEMENTING", "LOCAL_GREEN", "NEEDS_DECISION", "ABANDONED"),
    "LOCAL_GREEN":    ("PR_READY", "IMPLEMENTING", "NEEDS_DECISION", "ABANDONED"),
    "PR_READY":       ("DEV", "IMPLEMENTING", "NEEDS_DECISION", "ABANDONED"),
    "DEV":            ("HUMAN_VERIFIED", "IMPLEMENTING", "NEEDS_DECISION", "ABANDONED"),
    "HUMAN_VERIFIED": ("DONE", "IMPLEMENTING", "ABANDONED"),
    "DONE":           ("IMPLEMENTING",),
    "ABANDONED":      ("BACKLOG",),
}

GLYPH_TO_STATE = {
    "⚪": ("BACKLOG", False),               # white circle
    "\U0001f7e1": ("IMPLEMENTING", False),  # yellow circle
    "\U0001f7e2": ("DONE", False),          # green circle
    "\U0001f534": ("NEEDS_DECISION", True)  # red circle
}


def state_to_glyph(state: str, blocked: bool) -> str:
    if blocked:
        return "\U0001f534"
    if state in ("DONE", "HUMAN_VERIFIED"):
        return "\U0001f7e2"
    if state in ("BACKLOG", "ABANDONED"):
        return "⚪"
    return "\U0001f7e1"


def _state_blocked_ok(state: str, blocked: bool) -> bool:
    # The red glyph has exactly one inverse (GLYPH_TO_STATE): NEEDS_DECISION
    # blocked=True. state_to_glyph maps ANY blocked=True state to red, so any
    # other pairing (e.g. IMPLEMENTING blocked=True, or NEEDS_DECISION
    # blocked=False) is unrepresentable -- it would compile to a glyph whose
    # fixed inverse is a different state, silently rewriting history on the
    # next parse. Only these two shapes round-trip.
    return (state == "NEEDS_DECISION") == bool(blocked)


DASHBOARD_FIELDS = mm_schema.FIELDS


class IllegalTransition(RuntimeError):
    def __init__(self, frm, to, why=""):
        super().__init__(f"illegal transition: {frm} -> {to}" + (f" ({why})" if why else ""))
        self.frm = frm
        self.to = to

class EvidenceRequired(IllegalTransition):
    pass

class EvidenceRefused(IllegalTransition):
    pass

class ReasonRequired(IllegalTransition):
    pass

class RevisionConflict(RuntimeError):
    def __init__(self, actual, expected):
        super().__init__(f"revision conflict: doc has {actual!r}, expected {expected!r}")
        self.actual = actual
        self.expected = expected

class LockTimeout(RuntimeError):
    pass

class IllegalStateBlockedCombo(RuntimeError):
    def __init__(self, state, blocked):
        super().__init__(
            f"illegal state/blocked pair: state={state!r} blocked={blocked!r} -- "
            "NEEDS_DECISION requires blocked=True and every other state requires blocked=False"
        )
        self.state = state
        self.blocked = blocked

class LedgerValidationError(RuntimeError):
    def __init__(self, problems, *, source="ledger"):
        self.problems = list(problems)
        self.source = source
        super().__init__(f"invalid ledger ({source}): " + "; ".join(self.problems))


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")

def ledger_path(task_dir: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(task_dir) / "ledger.json"

def is_migrated(task_dir: pathlib.Path) -> bool:
    return ledger_path(task_dir).is_file()

_TOP_LEVEL_TYPES = {
    "schema_version": int, "revision": int, "task": str, "project": str,
    "pm_root": str, "created": str, "updated": str, "updated_by": str,
    "dashboard_index": dict, "rows": list, "decisions": list,
    "passthrough": dict, "rounds": dict,
}

_TOP_LEVEL_OPTIONAL_TYPES = {"compile_record": dict, "loop": dict, "archive": dict}

_ROW_OPTIONAL_TYPES = {"user_facing": bool, "test_level": str, "pr": str, "test_page": str}

_ROW_REQUIRED_TYPES = {
    "id": str, "item": str, "state": str, "blocked": bool, "blocked_reason": str,
    "status_label": str, "owner": str, "target_date": str, "notes_md": str,
    "is_wrapup": bool, "history": list,
}


def validate_ledger(doc, *, source: str = "ledger") -> None:
    """Reject anything JSON-shaped that isn't a well-formed ledger.

    Checks required top-level keys and their types, the row schema, the
    state enum, row id uniqueness, and the state/blocked pairing invariant
    (see _state_blocked_ok). Never rejects or strips an EXTRA key anywhere
    in the document: mm_compile stores unmodelled HANDOFF regions as
    verbatim passthrough blobs under keys this module does not model, and
    losslessness depends on this module round-tripping them untouched
    (SHARED INVARIANT 1). Raises LedgerValidationError with every problem
    found, not just the first, so a broken ledger is fixable from one
    message.
    """
    if not isinstance(doc, dict):
        raise LedgerValidationError(
            [f"top level must be a JSON object, got {type(doc).__name__}"], source=source
        )

    problems = []
    for key, expected_type in _TOP_LEVEL_TYPES.items():
        if key not in doc:
            problems.append(f"missing required top-level key {key!r}")
        elif expected_type is int:
            if not (isinstance(doc[key], int) and not isinstance(doc[key], bool)):
                problems.append(f"{key!r} must be an int, got {type(doc[key]).__name__}")
        elif not isinstance(doc[key], expected_type):
            problems.append(f"{key!r} must be a {expected_type.__name__}, got {type(doc[key]).__name__}")

    rows = doc.get("rows")
    if isinstance(rows, list):
        seen_ids = {}
        for i, row in enumerate(rows):
            where = f"rows[{i}]"
            if not isinstance(row, dict):
                problems.append(f"{where}: must be an object, got {type(row).__name__}")
                continue

            for key, expected_type in _ROW_REQUIRED_TYPES.items():
                if key not in row:
                    problems.append(f"{where}: missing required key {key!r}")
                elif not isinstance(row[key], expected_type):
                    problems.append(
                        f"{where}.{key}: must be a {expected_type.__name__}, got {type(row[key]).__name__}"
                    )
            if "status_glyph_present" in row and not isinstance(row["status_glyph_present"], bool):
                problems.append(
                    f"{where}.status_glyph_present: must be a bool, "
                    f"got {type(row['status_glyph_present']).__name__}"
                )

            for key, expected_type in _ROW_OPTIONAL_TYPES.items():
                if key in row and not isinstance(row[key], expected_type):
                    problems.append(
                        f"{where}.{key}: must be a {expected_type.__name__}, got {type(row[key]).__name__}"
                    )
            if isinstance(row.get("test_level"), str) and row["test_level"] not in mm_schema.TEST_LEVELS:
                problems.append(f"{where}.test_level: {row['test_level']!r} is not one of {mm_schema.TEST_LEVELS}")

            state = row.get("state")
            state_ok = isinstance(state, str) and state in STATES
            if isinstance(state, str) and not state_ok:
                problems.append(f"{where}.state: {state!r} is not one of {STATES}")

            row_id = row.get("id")
            if isinstance(row_id, str):
                if row_id in seen_ids:
                    problems.append(f"{where}.id: {row_id!r} duplicates {seen_ids[row_id]}")
                else:
                    seen_ids[row_id] = where

            blocked = row.get("blocked")
            if state_ok and isinstance(blocked, bool) and not _state_blocked_ok(state, blocked):
                problems.append(
                    f"{where}: state={state!r} blocked={blocked!r} is an unrepresentable pair "
                    "(NEEDS_DECISION requires blocked=True; every other state requires blocked=False)"
                )

    for key, expected_type in _TOP_LEVEL_OPTIONAL_TYPES.items():
        if key in doc and not isinstance(doc[key], expected_type):
            problems.append(f"{key!r} must be a {expected_type.__name__}, got {type(doc[key]).__name__}")
    archive = doc.get("archive")
    if isinstance(archive, dict) and "carried_0a_md" in archive and not isinstance(archive["carried_0a_md"], str):
        problems.append(f"archive.carried_0a_md: must be a str, got {type(archive['carried_0a_md']).__name__}")

    if problems:
        raise LedgerValidationError(problems, source=source)


def load_ledger(task_dir: pathlib.Path) -> dict:
    path = ledger_path(task_dir)
    text = path.read_text(encoding="utf-8")
    doc = json.loads(text)
    validate_ledger(doc, source=str(path))
    return doc


_STALE_LOCK_AGE_S = 30.0

_PID_DEAD = object()  # sentinel: OS confirms no process holds this pid


def _process_start_time(pid: int):
    """Best-effort process creation time for `pid`, as raw Windows FILETIME
    ticks (an opaque but stable identity: the OS reuses pids fast, but two
    different processes can't share a creation timestamp for the same pid).

    Returns _PID_DEAD when the OS affirmatively says no such process exists
    (OpenProcess fails with ERROR_INVALID_PARAMETER) -- the only case safe to
    treat as "confirmed gone". Returns None for every other kind of failure
    (wrong platform, access denied, API error) -- "cannot tell", which
    callers must treat as "assume live".
    """
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return _PID_DEAD if ctypes.get_last_error() == 87 else None  # 87 = ERROR_INVALID_PARAMETER
    try:
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel_time = wintypes.FILETIME()
        user_time = wintypes.FILETIME()
        ok = kernel32.GetProcessTimes(
            handle, ctypes.byref(creation), ctypes.byref(exit_time),
            ctypes.byref(kernel_time), ctypes.byref(user_time),
        )
        if not ok:
            return None
        return (creation.dwHighDateTime << 32) | creation.dwLowDateTime
    finally:
        kernel32.CloseHandle(handle)


def _lock_identity_payload() -> bytes:
    pid = os.getpid()
    start = _process_start_time(pid)
    return json.dumps({"pid": pid, "start_time": None if start is _PID_DEAD else start}).encode("utf-8")


def _read_lock_identity(lock_path: pathlib.Path):
    try:
        raw = lock_path.read_bytes()
    except OSError:
        return None
    if not raw:
        return None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("pid"), int):
        return None
    return payload


def _lock_holder_is_confirmed_dead(identity) -> bool:
    """True only when the recorded holder is PROVABLY gone: its pid no
    longer exists, or the pid now belongs to a different process (recycled
    pid, not the same holder). Anything we cannot positively disprove --
    missing identity, no recorded start time, access denied inspecting the
    pid -- returns False, i.e. "assume live, refuse to steal". A wrong steal
    silently discards someone's write; a false refusal just waits.
    """
    if identity is None or identity.get("start_time") is None:
        return False
    current = _process_start_time(identity["pid"])
    if current is _PID_DEAD:
        return True
    if current is None:
        return False
    return current != identity["start_time"]


def _acquire_lock(lock_path: pathlib.Path):
    identity_bytes = _lock_identity_payload()
    for attempt in range(20):
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - lock_path.stat().st_mtime
            except OSError:
                age = 0.0
            if age > _STALE_LOCK_AGE_S and _lock_holder_is_confirmed_dead(_read_lock_identity(lock_path)):
                # Old AND the OS confirms the recorded holder is gone --
                # reclaim. A merely-old lock whose holder we can't disprove
                # (or that predates identity tagging) is left alone: that is
                # exactly the "steal a live lock" defect this replaces.
                try:
                    lock_path.unlink()
                except OSError:
                    pass
                continue
            if attempt < 19:
                time.sleep(0.1)
            continue
        try:
            os.write(fd, identity_bytes)
        except OSError:
            pass
        return fd
    raise LockTimeout(f"could not acquire lock {lock_path} after 20 attempts")


@contextlib.contextmanager
def hold_lock(task_dir: pathlib.Path):
    """Hold ledger.lock across a whole load-apply-write cycle. Pass
    lock_held=True to save_ledger inside the block."""
    lock_path = pathlib.Path(task_dir) / "ledger.lock"
    fd = _acquire_lock(lock_path)
    try:
        yield
    finally:
        os.close(fd)
        _unlink_lock(lock_path)


def save_ledger(task_dir: pathlib.Path, doc: dict, *, expected_revision: int, updated_by: str,
                now: str = None, lock_held: bool = False) -> dict:
    # CAS against the persisted revision (read fresh under the lock), not
    # doc's own in-memory field -- doc is normally the caller's own copy
    # straight from load_ledger, so comparing it to itself would never
    # catch a concurrent writer.
    task_dir = pathlib.Path(task_dir)
    path = ledger_path(task_dir)

    with contextlib.nullcontext() if lock_held else hold_lock(task_dir):
        current_revision = 0
        if path.is_file():
            current_revision = json.loads(path.read_text(encoding="utf-8")).get("revision", 0)
        if current_revision != expected_revision:
            raise RevisionConflict(current_revision, expected_revision)

        doc = dict(doc)
        doc["revision"] = expected_revision + 1
        doc["updated"] = now or _now_iso()
        doc["updated_by"] = updated_by
        validate_ledger(doc, source=str(path))
        mm_atomic.atomic_write_text(path, ledger_text(doc))

    return doc


def ledger_text(doc: dict) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


def _unlink_lock(lock_path: pathlib.Path) -> None:
    for attempt in range(5):
        try:
            lock_path.unlink()
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt < 4:
                time.sleep(0.05)


_CMD_EVIDENCE_RE = re.compile(r"^cmd:\s*(?P<cmd>\S.*?)\s+exit:(?P<code>-?\d+)\s*$")
_RUN_EVIDENCE_RE = re.compile(r"^run by mm: (?P<cmd>.+) exit:(?P<code>-?\d+)$")
_HUMAN_EVIDENCE_RE = re.compile(r"^human:\s*(?P<name>\S.*)$")


def parse_evidence(evidence: str):
    """Return (kind, detail, exit_code); kind is cmd, run or human. Raise
    EvidenceRefused for anything else: an agent's claim is not evidence."""
    text = (evidence or "").strip()
    for kind, rx in (("cmd", _CMD_EVIDENCE_RE), ("run", _RUN_EVIDENCE_RE)):
        m = rx.match(text)
        if m:
            return kind, m.group("cmd"), int(m.group("code"))
    m = _HUMAN_EVIDENCE_RE.match(text)
    if m:
        return "human", m.group("name").strip(), None
    raise EvidenceRefused("?", "DONE", "evidence must be 'cmd:<command> exit:<n>', "
                                       f"'run by mm: <argv> exit:<n>' or 'human:<name>', got {text!r}")


IMPORT_SOURCES = ("migrate", "mm.py repair")

GREEN = ("DONE", "HUMAN_VERIFIED")


def needs_verification(row: dict) -> bool:
    """True when /mm repair moved the row off a green it could not prove and
    no mm.py command has moved the row since."""
    last = next((h for h in reversed(row.get("history") or []) if isinstance(h, dict) and "to" in h), None)
    return bool(last and last.get("unverified") and row.get("state") == last.get("to"))


def _entry_proves(entry: dict, frm: str, frm_proven: bool) -> bool:
    """True when history entry `entry` (a move from `frm` into DONE or
    HUMAN_VERIFIED) carries the evidence the transition rules demand."""
    try:
        kind, _, code = parse_evidence(entry.get("evidence") or "")
    except EvidenceRefused:
        return entry.get("to") == "DONE" and frm == "HUMAN_VERIFIED" and frm_proven
    if entry.get("to") == "HUMAN_VERIFIED":
        return kind == "human"
    return kind == "human" or code == 0


def is_move(entry) -> bool:
    """True for a history entry that records a move (it names a from or a to state), not an edit or a note."""
    return isinstance(entry, dict) and ("to" in entry or "from" in entry)


def malformed_move(entry: dict) -> str:
    """Why a recorded move cannot be walked, or "": every move needs a real
    'to' state, and every move but an import needs a real 'from' state."""
    to, frm = entry.get("to"), entry.get("from")
    if to not in STATES or (entry.get("by") not in IMPORT_SOURCES and frm not in STATES):
        return (f"a recorded move names from {frm!r} and to {to!r}, not two states, so where the row was after it "
                "is unknown; the history was edited by hand")
    return ""


def history_problems(doc: dict) -> list:
    """(row id, code, message) for every row whose state its own history
    does not prove. A row starts at BACKLOG; each recorded move must start
    where the previous one ended and the last must end at the row's state;
    a move into DONE or HUMAN_VERIFIED needs its evidence. An import by
    migrate or /mm repair is the recorded origin of the state it sets. A
    move without a from or to state is never walked: the row's place after
    it is unknown until an import records one.
    mm.py commands always satisfy this; a hand edit of ledger.json does not."""
    out = []
    for row in doc.get("rows", []):
        if not isinstance(row, dict) or row.get("state") not in STATES:
            continue
        rid, state, walked, proven = row.get("id"), row["state"], "BACKLOG", False
        broken, lost = False, ""
        for entry in row.get("history") or []:
            if not is_move(entry):
                continue
            to, frm = entry.get("to"), entry.get("from")
            why = malformed_move(entry)
            if why:
                walked, proven, lost = None, False, why
                continue
            if entry.get("by") in IMPORT_SOURCES:
                walked, proven = to, True
                continue
            if frm != walked:
                out.append((rid, "HISTORY-BROKEN", lost if walked is None else f"a recorded move starts at {frm} "
                                                   f"but the row was {walked} then; the history was edited by hand"))
                broken = True
                break
            proven = _entry_proves(entry, frm, proven) if to in ("DONE", "HUMAN_VERIFIED") else False
            walked = to
        if broken:
            continue
        if walked is None:
            out.append((rid, "HISTORY-BROKEN", lost))
        elif walked != state:
            out.append((rid, "STATE-UNRECORDED", f"the row is {state} but its history ends at {walked}: no mm.py "
                                                 "command moved it there (a hand edit of ledger.json)"))
        elif state in ("DONE", "HUMAN_VERIFIED") and not proven:
            out.append((rid, "GREEN-WITHOUT-EVIDENCE", f"the move into {state} carries no evidence the rules "
                                                       "accept (cmd:... exit:0, run by mm, or human:<name>)"))
    return out


def find_row(doc: dict, row_id: str) -> dict:
    for candidate in doc.get("rows", []):
        if candidate.get("id") == row_id:
            return candidate
    raise KeyError(f"no row with id {row_id!r}")


def _check_transition(doc, row, frm, to_state, evidence, reason):
    if to_state == "HUMAN_VERIFIED":
        if not (evidence or "").strip() or parse_evidence(evidence)[0] != "human":
            raise EvidenceRequired(frm, to_state, "HUMAN_VERIFIED needs human:<name> evidence")
        return
    if to_state == "ABANDONED":
        if not (reason or "").strip():
            raise ReasonRequired(frm, to_state, "ABANDONED needs a reason")
        if frm == "DONE":
            raise IllegalTransition(frm, to_state)
        return
    if to_state == "DONE":
        if frm in TERMINAL:
            raise IllegalTransition(frm, to_state)
        if row.get("is_wrapup"):
            open_rows = [r.get("id") for r in doc.get("rows", [])
                         if r is not row and r.get("state") not in TERMINAL]
            if open_rows:
                raise IllegalTransition(frm, to_state, "the wrap-up row waits for " + ", ".join(open_rows))
        if frm == "HUMAN_VERIFIED":
            return
        if row.get("user_facing"):
            raise IllegalTransition(frm, to_state, "a user-facing row reaches DONE only from HUMAN_VERIFIED")
        if not (evidence or "").strip():
            raise EvidenceRequired(frm, to_state, "DONE needs evidence")
        kind, _, code = parse_evidence(evidence)
        if kind in ("cmd", "run") and code != 0:
            raise EvidenceRefused(frm, to_state, f"the command exited {code}, not 0")
        return
    if to_state not in ALLOWED_TRANSITIONS.get(frm, ()):
        raise IllegalTransition(frm, to_state)


def set_row_state(doc: dict, row_id: str, to_state: str, *, by: str, note: str = "", blocked=None,
                  evidence: str = None, reason: str = None) -> dict:
    if to_state not in STATES:
        raise IllegalTransition(row_id, to_state)

    row = find_row(doc, row_id)
    frm = row.get("state")
    is_noop = to_state == frm
    if not is_noop:
        _check_transition(doc, row, frm, to_state, evidence, reason)

    # `blocked` is carried over unchanged on a noop, or on any transition
    # where the caller didn't explicitly say -- but the resulting pair must
    # still be representable, so check it against the value that will
    # actually land, not just newly-passed values.
    new_blocked = blocked if blocked is not None else row.get("blocked", False)
    if not _state_blocked_ok(to_state, new_blocked):
        raise IllegalStateBlockedCombo(to_state, new_blocked)

    row["state"] = to_state
    row["blocked"] = new_blocked
    if not is_noop:
        row["status_label"] = mm_schema.STATUS_LABELS[to_state]
        row["status_glyph_present"] = True
        row.pop("row_verbatim", None)
        row.pop("raw_line", None)
        row.setdefault("history", []).append({
            "at": _now_iso(), "from": frm, "to": to_state, "by": by, "note": note,
            "evidence": evidence or "", "reason": reason or "",
        })
    return doc


class Refused(RuntimeError):
    """An operation the ledger rules refuse. `code` is the mm.py exit code:
    4 target missing, 5 transition or row structure, 6 field, cap or enum."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def new_ledger(task: str, project: str) -> dict:
    now = _now_iso()
    dashboard_index = dict(mm_schema.FIELD_DEFAULTS)
    dashboard_index["Project"] = project
    dashboard_index["Task"] = task
    dashboard_index["Status"] = "active"

    return {
        "schema_version": 1,
        "revision": 0,
        "task": task,
        "project": project,
        "pm_root": "",
        "created": now,
        "updated": now,
        "updated_by": "mm PM (new_ledger)",
        "dashboard_index": dashboard_index,
        "rows": [],
        "decisions": [],
        "passthrough": {
            "title_line": f"# HANDOFF — {task}",
            "section_0b_md": "",
            "section_3_md": "",
            "section_4_md": "",
            "trailing_md": "",
        },
        "rounds": {"max_rounds": 3, "rubric_sha256": "", "residual": []},
    }
