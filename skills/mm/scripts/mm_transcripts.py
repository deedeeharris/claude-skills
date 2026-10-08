"""Which session transcript belongs to a dispatch's builder: found, never guessed.

Claude Code writes a session's transcript to <projects>/<slug>/<session id>.jsonl.
<projects> is $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects; <slug> is
the folder the session started in with every character other than a letter or
digit replaced by '-' (D:\\work\\my_app is D--work-my-app), one '-' per UTF-16
code unit. A slug longer than 200 characters is cut to 200 and given '-' and a
hash of the folder path, as Claude Code does. Folder names are compared after
the same replacement and without case, so a folder written with a lower-case
drive letter or a kept underscore is found too; for a cut slug, every folder
that starts with the same 200 characters and '-' is looked in, as Claude Code
itself does, since its hash has differed between its versions.

A transcript is a candidate when its first stamped record is at or after the
launch (a few seconds of clock skew allowed), so a session that was already
running, such as the PM's own, never is one. It matches when it holds this
dispatch's launch record, found by mm_liveness.transcript_facts. Exactly one
match is the builder; none yet, or several, is reported, never guessed.
"""

import datetime
import json
import os
import pathlib
import re

import mm_liveness
import mm_where


def projects_dir() -> pathlib.Path:
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    return (pathlib.Path(env) if env else pathlib.Path.home() / ".claude") / "projects"


SLUG_MAX = 200
_DIGITS36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _dashes(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", lambda m: "-" * (1 + (ord(m.group()) > 0xFFFF)), text)


def _hash36(text: str) -> str:
    """Claude Code's h = h * 31 + UTF-16 code unit in 32-bit signed arithmetic,
    written in base 36 without its sign."""
    units = text.encode("utf-16-le")
    h = 0
    for i in range(0, len(units), 2):
        h = (h * 31 + int.from_bytes(units[i:i + 2], "little")) & 0xFFFFFFFF
    n, digits = abs(h - (1 << 32) if h >> 31 else h), ""
    while True:
        n, r = divmod(n, 36)
        digits = _DIGITS36[r] + digits
        if not n:
            return digits


def slug(folder: str) -> str:
    full = _dashes(str(folder))
    return full if len(full) <= SLUG_MAX else f"{full[:SLUG_MAX]}-{_hash36(str(folder))}"


def _is_folder_of(name: str, want: str) -> bool:
    """A project folder named after the slug `want`, or after the same cut
    slug with another hash."""
    name, want = _dashes(name).lower(), want.lower()
    return name == want or (len(want) > SLUG_MAX and name.startswith(want[:SLUG_MAX + 1]))


def repo_of(task_dir) -> pathlib.Path:
    """The folder holding the task's PM root, where the PM launches builders."""
    task_dir = pathlib.Path(task_dir).absolute()
    for parent in task_dir.parents:
        if any(task_dir.is_relative_to(parent / root) for root in mm_where.PM_ROOTS):
            return parent
    return task_dir


def _started(path: pathlib.Path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and record.get("timestamp"):
                return mm_liveness._parse_time(record["timestamp"])
    return None


def find(cwd, *, command, marker, launched_at, session_id=None, projects=None, launch_text="") -> tuple:
    """(matches, folder): the transcripts of sessions started in `cwd` at or
    after the launch that hold this dispatch's launch record, and the project
    folder named after `cwd`."""
    root = pathlib.Path(projects) if projects else projects_dir()
    want = slug(pathlib.Path(cwd).absolute())
    names = root.iterdir() if root.is_dir() else ()
    folders = [p for p in names if p.is_dir() and _is_folder_of(p.name, want)]
    earliest = launched_at - datetime.timedelta(seconds=mm_liveness.SKEW_S)
    matches = []
    for path in sorted(f for folder in folders for f in folder.glob("*.jsonl") if f.is_file()):
        started = _started(path)
        if started is not None and started >= earliest and mm_liveness.transcript_facts(
                path, command=command, marker=marker, launched_at=launched_at, session_id=session_id,
                launch_text=launch_text)["command_record"]:
            matches.append(path)
    return matches, root / want


def unmatched(matches: list, folder: pathlib.Path, elapsed: float, stall_s=None) -> tuple:
    """(verdict, reason) when not exactly one transcript matched. `stall_s` is
    given when the dispatch record stores no usable launch: then none found is
    PENDING until the stall limit, as a launch that is never ALIVE."""
    if matches:
        return "PENDING", (f"{len(matches)} transcripts hold this dispatch's launch record ("
                           + ", ".join(p.name for p in matches) + "); pass --session-id <id> to name the builder")
    reason = f"in {folder} no transcript that started after the launch holds its launch record"
    if stall_s is not None:
        reason += "; the dispatch record stores no launch text naming its prompt copy beyond its path"
        if elapsed < stall_s:
            return "PENDING", f"{reason}, so it is DEAD at the stall limit ({stall_s / 60:.0f} min after the launch)"
        return "DEAD", f"{reason}; {elapsed / 60:.0f} min after the launch (stall limit {stall_s / 60:.0f} min)"
    if elapsed < mm_liveness.FIRST_WINDOW_S:
        return "PENDING", f"{reason} yet ({elapsed:.0f} s after the launch)"
    return "DEAD", f"{reason} {elapsed:.0f} s after the launch"
