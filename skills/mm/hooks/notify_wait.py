"""Wait ping: one ntfy push when the mm PM waits on the operator.

Hooks: Claude Code PreToolUse on AskUserQuestion and Stop (both async), and
Codex Stop; `--host claude-code|codex|agy` names the host. It sends only when
the session is the mm PM and the turn waits on the operator. The message names
who waits and where (host, repo, task, local time, session id, working folder,
resume command) and nothing else: the question, the Blocked text and the reply
text are only hashed, to recognise the same wait again. The title is ASCII.

PM: the session's mm.py binding, else the footer line `PM mode: mm PM for
<task>` (a footer `PM mode: no` stops here), else the PM banner in the last
reply, else the newest banner in the transcript tail. A subagent never sends.
Waiting: a PreToolUse on AskUserQuestion; on Stop, a last `Blocked:` line that
is not none or -, or, with no Blocked line at all, a last line ending in '?'.

Topic: MM_NTFY_TOPIC when set (empty turns the ping off), else ntfy_topic in
mm.local.md beside SKILL.md; none, no ping. MM_NTFY_DRY_RUN=1 appends the
request to <state>/notify/outbox.jsonl instead of sending. At most one ping per
session per minute; the same wait in the same session is not re-sent for 6
hours. It prints nothing, always exits 0, and gives up on the network after 4 s.
"""

import datetime
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import urllib.request

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

import hookio  # noqa: E402
import mm_where  # noqa: E402

OVERLAY = HERE.parent / "mm.local.md"
TOPIC_RE = re.compile(r"^\s*ntfy_topic\s*:\s*([A-Za-z0-9_-]{1,64})\s*$", re.M)
SLUG = r"([A-Za-z0-9][A-Za-z0-9._-]{0,63})"
FOOTER_PM_RE = re.compile(r"^PM mode:\s*mm PM for\s+`?" + SLUG, re.M)
FOOTER_NO_RE = re.compile(r"^PM mode:\s*no\b", re.M)
BANNER_RE = re.compile(r"PM mode \| Task:\s*`?" + SLUG)
BLOCKED_RE = re.compile(r"^\s*Blocked:\s*(.*?)\s*$", re.M)
NOT_BLOCKED = {"", "none", "none.", "-", "n/a", "no"}
HOSTS = {"claude-code": "Claude Code", "codex": "Codex", "agy": "agy"}
SERVER = "https://ntfy.sh/"
TAIL_BYTES = 2 * 1024 * 1024
MIN_GAP = 60
SAME_WAIT_GAP = 6 * 3600


def topic() -> str:
    if "MM_NTFY_TOPIC" in os.environ:
        value = os.environ["MM_NTFY_TOPIC"].strip()
        return value if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) else ""
    try:
        found = TOPIC_RE.search(OVERLAY.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return ""
    return found.group(1) if found else ""


def digest(kind: str, value: str) -> str:
    return hashlib.sha256((kind + "\0" + value).encode("utf-8")).hexdigest()[:16]


def wait_signature(data: dict, text: str) -> str:
    """A short hash naming this wait, or "" when the turn does not wait."""
    event = re.sub(r"[^a-z]", "", str(data.get("hook_event_name", "")).lower())
    if event == "pretooluse":
        if data.get("tool_name") != "AskUserQuestion":
            return ""
        return digest("ask", json.dumps(data.get("tool_input"), sort_keys=True, ensure_ascii=False))
    if event != "stop":
        return ""
    blocked = BLOCKED_RE.findall(text)
    if blocked:
        value = blocked[-1].strip("`*_ ")
        return "" if value.lower() in NOT_BLOCKED else digest("blocked", value)
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return digest("question", lines[-1]) if lines and lines[-1].endswith("?") else ""


def task_from_transcript(path) -> str:
    try:
        p = pathlib.Path(path)
        with p.open("rb") as fh:
            fh.seek(max(0, p.stat().st_size - TAIL_BYTES))
            blob = fh.read().decode("utf-8", "replace")
    except (OSError, TypeError, ValueError):
        return ""
    names = BANNER_RE.findall(blob)
    return names[-1] if names else ""


def pm_task(data: dict, text: str) -> tuple:
    """(task name, task folder or None) when this session is the mm PM, else ("", None)."""
    session = hookio.session_id(data)
    if session:
        try:
            bound = mm_where.whoami(session)
        except mm_where.WhereError:
            bound = None
        if bound is not None and bound.is_dir():
            return bound.name, bound
    found = FOOTER_PM_RE.findall(text)
    if found:
        return found[-1], None
    if FOOTER_NO_RE.search(text):
        return "", None
    found = BANNER_RE.findall(text)
    if found:
        return found[-1], None
    return task_from_transcript(data.get("transcript_path")), None


def repo_name(task_dir, cwd: str) -> str:
    if task_dir is not None and len(task_dir.parents) > 3:
        return task_dir.parents[3].name
    here = pathlib.Path(cwd)
    for d in (here, *here.parents):
        if (d / ".git").exists():
            return d.name
    return here.name


def local_now() -> str:
    now = datetime.datetime.now().astimezone()
    return now.strftime("%a %Y-%m-%d %H:%M %Z")


def compose(host: str, repo: str, task: str, session: str, cwd: str) -> tuple:
    resume = {"claude-code": f'cd /d "{cwd}" && claude --resume {session}',
              "codex": f'cd /d "{cwd}" && codex resume {session}'}.get(host, "")
    lines = [f"{HOSTS[host]} is waiting for you (mm PM).", f"Repo: {repo}", f"Task: {task}",
             f"Time: {local_now()}", f"Session: {session or '-'}", f"Dir: {cwd}"]
    if resume and session:
        lines.append(f"Resume: {resume}")
    return f"mm PM waiting - {HOSTS[host]}", "\n".join(lines)


def notify_dir() -> pathlib.Path:
    path = mm_where.state_dir() / "notify"
    path.mkdir(parents=True, exist_ok=True)
    return path


def due(session: str, sig: str, now: float) -> bool:
    """Record this wait and say whether to send it (min gap, same-wait gap)."""
    name = session if mm_where.SESSION_RE.match(session or "") else "nosession"
    path = notify_dir() / f"{name}.json"
    try:
        last = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        last = {}
    last = last if isinstance(last, dict) else {}
    at = float(last.get("at") or 0)
    if now - at < MIN_GAP or (last.get("sig") == sig and now - at < SAME_WAIT_GAP):
        return False
    path.write_text(json.dumps({"sig": sig, "at": now}), encoding="utf-8")
    return True


def send(chan: str, title: str, body: str) -> str:
    headers = {"Title": title.encode("ascii", "replace").decode("ascii"), "Tags": "warning,computer",
               "Priority": "high", "Content-Type": "text/plain; charset=utf-8"}
    if os.environ.get("MM_NTFY_DRY_RUN") == "1":
        record = {"url": SERVER + chan, "headers": headers, "body": body}
        with (notify_dir() / "outbox.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return "dry-run"
    req = urllib.request.Request(SERVER + chan, data=body.encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=4) as resp:
        return f"sent {resp.status}"


def log(session: str, host: str, result: str) -> None:
    try:
        with (notify_dir() / "notify.log").open("a", encoding="utf-8") as fh:
            fh.write(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {host} "
                     f"{session or '-'} {result}\n")
    except OSError:
        pass


def run(argv: list) -> None:
    host = argv[argv.index("--host") + 1] if "--host" in argv[:-1] else "claude-code"
    data = hookio.read_event()
    if host not in HOSTS or not data or data.get("agent_id"):
        return
    chan = topic()
    text = data.get("last_assistant_message")
    text = text if isinstance(text, str) else ""
    sig = wait_signature(data, text) if chan else ""
    if not sig:
        return
    task, task_dir = pm_task(data, text)
    if not task:
        return
    session = hookio.session_id(data)
    cwd = data.get("cwd") if isinstance(data.get("cwd"), str) and data.get("cwd") else os.getcwd()
    if not due(session, sig, time.time()):
        log(session, host, "skipped: same wait or within a minute")
        return
    title, body = compose(host, repo_name(task_dir, cwd), task, session, cwd)
    try:
        log(session, host, send(chan, title, body))
    except Exception as exc:
        log(session, host, f"failed: {type(exc).__name__}")


def main() -> int:
    try:
        run(sys.argv[1:])
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
