"""Is a launched agent actually running? ALIVE, PENDING or DEAD from facts tied to this dispatch.

Claude Code background launch (the facts of the F6 research):
  - within about 15 s the session transcript shows the launch command record
    (`<command-name>/babysitter:yolo</command-name>` when the launch uses the
    babysitter plugin) and an assistant tool_use; an 'Unknown command' record
    for the launch command itself (not for a later prompt) means the launch
    is dead;
  - within about 6 min a babysitter run exists (`<runs>/<id>/run.json`) whose
    processId is not `bare-run`;
  - after that its journal (`<run>/journal/`) keeps growing.
Every fact must belong to this dispatch. The start record is a user record
stamped at or after the launch (a few seconds of clock skew allowed) that
holds this dispatch's launch as mm_launch defines it for each launch form,
never a tool result quoting such text; it fixes the session id, which
--session-id may also pin. mm_transcripts finds the transcript that holds it.
Evidence
counts only inside the chain that record started: records linked to it
through parentUuid, up to the next prompt typed into the session (a
background-task notification or a tool result does not end the chain). A
record without that link is never evidence. The tool_use must be in that
chain. A run counts only when a `run:create` call in that chain returned its
run id, and its run.json has a usable createdAt at or after the launch; a run
merely mentioned later, or created after another prompt, is not this launch.
A journal that stops growing is PENDING until the stall limit, then DEAD. A
bare run directory alone is never proof: the SessionStart hook creates one
for dead sessions too. Transcript mtime is never used.

Codex (`codex exec --json`): the events file shows `turn.started`.

The launch command's own output, when captured (--launch-log), settles a
failed launch at once: a line saying the workspace is not trusted (a
`claude --bg` precondition), an unknown command, or a missing executable
makes it DEAD at any time.
"""

import datetime
import json
import pathlib
import re

import mm_launch

FIRST_WINDOW_S = 20
RUN_WINDOW_S = 6 * 60
CODEX_WINDOW_S = 60
STALL_S = 60 * 60
SKEW_S = 5
BARE_RUN = "bare-run"
_UNKNOWN = ("Unknown slash command", "Unknown command")
_RUN_ID_RE = re.compile(r'"runId"\s*:\s*"([^"]+)"')


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _records(path: pathlib.Path):
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            yield record


def _parse_time(value):
    try:
        stamp = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.astimezone()


def _items(message: dict) -> list:
    content = message.get("content")
    return [c for c in content if isinstance(c, dict)] if isinstance(content, list) else []


def _new_prompt(record: dict, message: dict) -> bool:
    """A user record that starts another turn: typed text, not a tool
    result, not a command expansion, not a background-task notification."""
    if record.get("type") != "user" or record.get("isMeta"):
        return False
    if any(c.get("type") == "tool_result" for c in _items(message)):
        return False
    text = "".join(_strings(message.get("content"))).lstrip()
    return bool(text) and not text.startswith("<task-notification>")


def _names_launch(text: str, command: str) -> bool:
    """`text` names the launch command as a whole word: in full
    (babysitter:yolo) or by the name after its plugin prefix (yolo)."""
    own = command.lstrip("/")
    names = "|".join(re.escape(n) for n in {own, own.rsplit(":", 1)[-1]} if n)
    return bool(names) and re.search(rf"(?<![\w:/-])/?(?:{names})(?![\w:/-])", text) is not None


def transcript_facts(path: pathlib.Path, *, command: str, marker: str, launched_at, session_id=None,
                     launch_text="") -> dict:
    """This dispatch's launch in one transcript: the start record, an
    assistant tool_use in the chain it started, an 'Unknown command' record
    that belongs to this launch, and the run ids that run:create calls in
    that chain returned. An 'Unknown command' record belongs to this launch
    when it names the launch command and is stamped at or after the launch
    (no start record appeared), or when it is in the chain and is either the
    start record's direct result or names the launch command; a later
    prompt's unknown command, or one of another command, never makes this
    launch DEAD."""
    facts = {"command_record": False, "tool_use": False, "unknown_command": "", "session": session_id or None,
             "runs": []}
    chain, creates, start, before_start = set(), set(), None, ""
    earliest = launched_at - datetime.timedelta(seconds=SKEW_S)
    for record in _records(path):
        stamp = _parse_time(record["timestamp"]) if record.get("timestamp") else None
        session = record.get("sessionId")
        if facts["session"] and session and session != facts["session"]:
            continue
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        texts = list(_strings(message.get("content"))) + list(_strings(record.get("content")))
        user = record.get("type") in ("user", "system")
        unknown = next((t for t in texts for u in _UNKNOWN if u in t), "").strip()[:120] if user else ""
        quoted = any(c.get("type") == "tool_result" for c in _items(message))
        if not facts["command_record"]:
            if not quoted and stamp is not None and stamp >= earliest and mm_launch.is_start(
                    record, texts, command=command, marker=marker, launch_text=launch_text):
                facts["command_record"] = True
                facts["session"] = facts["session"] or session
                start = record.get("uuid")
                chain.update([start] if start else [])
            elif unknown and not quoted and stamp is not None and stamp >= earliest and not before_start and (
                    _names_launch(unknown, command)):
                before_start = unknown
            continue
        if record.get("parentUuid") not in chain:
            continue
        if unknown and not facts["unknown_command"] and (
                (start and record.get("parentUuid") == start) or _names_launch(unknown, command)):
            facts["unknown_command"] = unknown
            continue
        if _new_prompt(record, message):
            continue
        chain.update([record["uuid"]] if record.get("uuid") else [])
        for item in _items(message):
            if record.get("type") == "assistant" and item.get("type") == "tool_use":
                facts["tool_use"] = True
                if any("run:create" in t for t in _strings(item.get("input"))):
                    creates.add(item.get("id"))
            elif item.get("type") == "tool_result" and item.get("tool_use_id") in creates:
                facts["runs"] += [r for t in _strings(item.get("content")) for r in _RUN_ID_RE.findall(t)]
    if not facts["command_record"]:
        facts["unknown_command"] = before_start
    return facts


def runs_after(runs_dir: pathlib.Path, launched_at, run_ids) -> tuple:
    """(runs, ignored). runs: (run id, processId, journal file count, journal
    bytes) of every run under `runs_dir` (a runs folder or one run) with a
    usable createdAt at or after the launch, a real processId, and a run id
    in `run_ids` (the ids this launch's run:create calls returned). ignored
    counts the other recent runs by reason."""
    candidates = [runs_dir] if (runs_dir / "run.json").is_file() else sorted(runs_dir.glob("*/"))
    earliest = launched_at - datetime.timedelta(seconds=SKEW_S)
    out, ignored = [], {"bare": 0, "undated": 0, "unnamed": 0}
    for run in candidates:
        try:
            meta = json.loads((run / "run.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        created = _parse_time(meta["createdAt"]) if meta.get("createdAt") else None
        process = str(meta.get("processId", ""))
        run_id = str(meta.get("runId") or run.name)
        if created is None:
            ignored["undated"] += 1
        elif created < earliest:
            continue
        elif not process or process == BARE_RUN:
            ignored["bare"] += 1
        elif run_id not in run_ids:
            ignored["unnamed"] += 1
        else:
            files = [p for p in (run / "journal").rglob("*") if p.is_file()] if (run / "journal").is_dir() else []
            out.append((run_id, process, len(files), sum(p.stat().st_size for p in files)))
    return out, ignored


def _unchanged_since(previous: list, journal: int):
    """The time of the first earlier check in the latest unbroken stretch of
    checks that saw the journal at exactly this size."""
    since = None
    for check in previous:
        if check.get("journal") == journal:
            since = since or _parse_time(check.get("at", ""))
        elif check.get("journal") is not None:
            since = None
    return since


def _no_run(elapsed: float, ignored: dict, session):
    if elapsed < RUN_WINDOW_S:
        return "ALIVE", "command record and tool_use seen; the babysitter run is not due yet", None, session
    notes = [f"{n} {label}" for n, label in ((ignored["bare"], f"{BARE_RUN} run dirs, which are not proof"),
                                              (ignored["undated"], "runs without a usable createdAt"),
                                              (ignored["unnamed"], "runs this launch did not create")) if n]
    note = f" (ignored: {'; '.join(notes)})" if notes else ""
    return ("DEAD", f"no babysitter run with a real processId created by this launch {elapsed:.0f} s after the "
                    f"launch{note}", None, session)


def claude_verdict(*, transcript, runs_dir, launched_at, now, command, marker, session_id=None, previous=(),
                   stall_s=STALL_S, launch_text=""):
    """(verdict, reason, journal, session) for a Claude Code launch."""
    elapsed = (now - launched_at).total_seconds()
    if transcript is None or not pathlib.Path(transcript).is_file():
        if elapsed < FIRST_WINDOW_S:
            return "PENDING", f"no transcript yet ({elapsed:.0f} s after the launch)", None, session_id
        return "DEAD", f"no session transcript {elapsed:.0f} s after the launch", None, session_id
    facts = transcript_facts(pathlib.Path(transcript), command=command, marker=marker, launched_at=launched_at,
                             session_id=session_id, launch_text=launch_text)
    session = facts["session"]
    if facts["unknown_command"]:
        return "DEAD", f"the transcript shows {facts['unknown_command']!r}", None, session
    start = mm_launch.describe(command=command, marker=marker, launch_text=launch_text)
    missing = [name for name, ok in ((start + " after the launch", facts["command_record"]),
                                     ("an assistant tool_use in the chain it started", facts["tool_use"])) if not ok]
    if missing:
        if elapsed < FIRST_WINDOW_S:
            return "PENDING", "waiting for " + " and ".join(missing), None, session
        return "DEAD", f"{elapsed:.0f} s after the launch the transcript lacks " + " and ".join(missing), None, session
    if not command:
        return (*mm_launch.plain_verdict(elapsed, stall_s, launch_text), None, session)
    runs, ignored = runs_after(pathlib.Path(runs_dir), launched_at, facts["runs"]) if runs_dir else ([], {
        "bare": 0, "undated": 0, "unnamed": 0})
    if not runs:
        return _no_run(elapsed, ignored, session)
    journal = max(r[2] * 1_000_000 + r[3] for r in runs)
    seen = [c["journal"] for c in previous if c.get("journal") is not None]
    if seen and journal <= seen[-1]:
        idle = (now - (_unchanged_since(list(previous), journal) or now)).total_seconds()
        if idle >= stall_s:
            return ("DEAD", f"the run journal has not grown for {idle / 60:.0f} min (stall limit "
                            f"{stall_s / 60:.0f} min)", journal, session)
        return "PENDING", f"the run journal has not grown for {idle / 60:.0f} min", journal, session
    return "ALIVE", f"babysitter run {runs[0][0]} is writing its journal", journal, session


LAUNCH_FAILURES = ("not trusted", "Unknown slash command", "Unknown command", "command not found",
                   "is not recognized as an internal or external command")


def launch_log_failure(path) -> str:
    """The first line of a launch command's captured output that says the
    launch failed (an untrusted workspace, an unknown command, a missing
    executable), else "". A file that cannot be read raises OSError."""
    text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    return next((line.strip()[:160] for line in text.splitlines() if any(f in line for f in LAUNCH_FAILURES)), "")


def late_note(elapsed: float, previous) -> str:
    """A note when the first check runs long after the +20 s the protocol sets."""
    if previous or elapsed <= 2 * FIRST_WINDOW_S:
        return ""
    return (f" (first check came at +{elapsed:.0f} s; run it at about +{FIRST_WINDOW_S} s, so a launch that failed "
            "at once is reported at once)")


def codex_verdict(*, events, launched_at, now):
    elapsed = (now - launched_at).total_seconds()
    if events is not None and pathlib.Path(events).is_file():
        types = [r.get("type") for r in _records(pathlib.Path(events))]
        if "turn.started" in types:
            return "ALIVE", "the events file shows turn.started", None
    if elapsed < CODEX_WINDOW_S:
        return "PENDING", "no turn.started event yet", None
    return "DEAD", f"no turn.started event {elapsed:.0f} s after the launch", None
