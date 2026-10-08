"""Task inbox: write entries, scan loudly, archive without deleting.

An entry is `inbox/<YYYYMMDD-HHMMSS>-<source>.md`: frontmatter with the six
keys below (extra keys, like the ones CEO entries carry, are allowed) and a
body holding the six sections in order. scan reports every file that does
not fit, and never reports inbox/README.md. In the task root it reports a
file named by a shell expression and any .md file whose name starts with
"inbox" (an entry written beside inbox/ instead of into it). archive moves entries to
inbox/processed/<YYYY-MM>/ and never deletes or overwrites. closed_leftovers
finds files that reached a task after close's last scan of its inbox.
"""

import datetime
import json
import os
import pathlib
import re

SECTIONS = ("What was done", "What's next", "Blockers", "Files changed", "Evidence", "Notes for PM")
FRONTMATTER_KEYS = ("agent", "session", "started", "emitted", "status", "task_ref")
STATUSES = ("in-progress", "completed", "blocked", "error", "failed")
NAME_RE = re.compile(r"^(\d{4})(\d{2})\d{2}-\d{6}-[A-Za-z0-9][A-Za-z0-9._-]*\.md$")
SOURCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
INBOX_WARN_BYTES = 50 * 1024 * 1024
CLOSED_RECHECK_DAYS = 14


class InboxError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def _now():
    return datetime.datetime.now().astimezone().replace(microsecond=0)


def section_problems(body: str) -> list:
    """Missing or out-of-order sections, by name."""
    lines = [line.strip() for line in body.replace("\r\n", "\n").split("\n")]
    problems, last = [], -1
    for name in SECTIONS:
        at = next((i for i, line in enumerate(lines) if re.fullmatch(r"##\s+" + re.escape(name), line)), None)
        if at is None:
            problems.append(f"section '## {name}' is missing")
        elif at < last:
            problems.append(f"section '## {name}' is out of order")
        else:
            last = at
    return problems


def split_entry(text: str):
    """(frontmatter dict or None, body)."""
    text = text.replace("\r\n", "\n")
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return None, text
    front = {}
    for line in m.group(1).split("\n"):
        key, sep, value = line.partition(":")
        if sep and key.strip():
            front[key.strip()] = value.strip()
    return front, m.group(2)


def entry_problems(text: str) -> list:
    front, body = split_entry(text)
    if front is None:
        return ["no frontmatter block (--- ... ---) at the top"] + section_problems(body)
    problems = [f"frontmatter key '{key}' is missing" for key in FRONTMATTER_KEYS if not front.get(key)]
    if front.get("status") and front["status"] not in STATUSES:
        problems.append(f"status '{front['status']}' is not one of {', '.join(STATUSES)}")
    return problems + section_problems(body)


def write_entry(task_dir: pathlib.Path, source: str, fields: dict, body: str) -> pathlib.Path:
    if not SOURCE_RE.match(source or ""):
        raise InboxError(6, f"--source {source!r} must be a slug (letters, digits, '.', '_', '-')")
    for key in FRONTMATTER_KEYS:
        value = str(fields.get(key) or "")
        if not value or "\n" in value or "\r" in value:
            raise InboxError(6, f"frontmatter {key} must be one non-empty line")
    if fields["status"] not in STATUSES:
        raise InboxError(6, f"--status must be one of {', '.join(STATUSES)}")
    problems = section_problems(body)
    if problems:
        raise InboxError(6, "the body is refused, nothing written: " + "; ".join(problems))
    inbox = task_dir / "inbox"
    inbox.mkdir(exist_ok=True)
    text = "---\n" + "".join(f"{key}: {fields[key]}\n" for key in FRONTMATTER_KEYS) + "---\n\n"
    text += body.replace("\r\n", "\n").strip("\n") + "\n"
    stem = f"{_now().strftime('%Y%m%d-%H%M%S')}-{source}"
    for n in range(1, 1000):
        path = inbox / (f"{stem}.md" if n == 1 else f"{stem}-{n}.md")
        try:
            with open(path, "x", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            return path
        except FileExistsError:
            continue
    raise InboxError(6, f"no free name for {stem}.md")


def scan(task_dir: pathlib.Path) -> tuple:
    """(entries, problems): entries are (name, status) of valid entries;
    problems are (kind, path relative to the task, detail)."""
    entries, problems = [], []
    for path in sorted(task_dir.iterdir()) if task_dir.is_dir() else []:
        if "$(" in path.name or "`" in path.name:
            problems.append(("SHELL-NAME", path.name, "a file named by an unexpanded shell expression; an agent's "
                                                      "command went wrong. Read it, then move its content"))
        elif path.is_file() and path.suffix.lower() == ".md" and path.name.lower().startswith("inbox"):
            problems.append(("STRAY-INBOX-FILE", path.name, "a file in the task root named like an inbox entry "
                                                            "(a missing '/' after inbox, or an expanded shell "
                                                            "expression); an agent's report may be in it. Read it, "
                                                            "then move its content into inbox/"))
    inbox = task_dir / "inbox"
    for path in sorted(inbox.iterdir()) if inbox.is_dir() else []:
        rel = f"inbox/{path.name}"
        if path.is_dir():
            if path.name != "processed":
                problems.append(("UNEXPECTED-FOLDER", rel, "only processed/ belongs here; evidence goes under "
                                                          "<task>/evidence/"))
            continue
        if path.name == "README.md":
            continue
        if path.suffix.lower() != ".md":
            problems.append(("NOT-MARKDOWN", rel, "only .md entries belong in the inbox; evidence goes under "
                                                 "<task>/evidence/"))
            continue
        found = []
        if not NAME_RE.match(path.name):
            found.append(("MISNAMED", "the name must be <YYYYMMDD-HHMMSS>-<source>.md"))
        text = path.read_text(encoding="utf-8", errors="replace")
        found += [("MALFORMED", detail) for detail in entry_problems(text)]
        if found:
            problems += [(kind, rel, detail) for kind, detail in found]
        else:
            entries.append((path.name, split_entry(text)[0].get("status", "")))
    return entries, problems


def breakdown(task_dir: pathlib.Path) -> tuple:
    """(entries, problems, closed-task files) as inbox-scan reports them: a
    file of this task that closed_leftovers reports counts there only."""
    task_dir = pathlib.Path(task_dir)
    entries, problems = scan(task_dir)
    late = closed_leftovers(task_dir)
    own = f"{task_dir.parent.name}/{task_dir.name}/"
    again = {rel[len(own):] for rel, _ in late if rel.startswith(own)}
    entries = [(name, status) for name, status in entries if f"inbox/{name}" not in again]
    problems = [p for p in problems if p[1] not in again]
    return entries, problems, late


def counts(task_dir: pathlib.Path) -> tuple:
    """(entries, problems, closed-task files) as inbox-scan reports them;
    status and the dashboard show these numbers."""
    return tuple(len(found) for found in breakdown(task_dir))


def _closed_at(folder: pathlib.Path):
    try:
        doc = json.loads((folder / "ledger.json").read_text(encoding="utf-8"))
        stamp = datetime.datetime.fromisoformat(doc["updated"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return stamp if stamp.tzinfo else stamp.astimezone()


def closed_leftovers(task_dir: pathlib.Path) -> list:
    """(path under the PM root, detail) for every inbox file of a task closed
    in the last CLOSED_RECHECK_DAYS days (by the `updated` stamp close writes
    to its ledger), and of an active/ folder of that name holding no task,
    the scanned task included. close found the inbox clear, so any such file
    arrived after its last scan."""
    task_dir = pathlib.Path(task_dir)
    pm_root = task_dir.parent.parent
    if task_dir.parent.name not in ("active", "done") or not (pm_root / "done").is_dir():
        return []
    cutoff = _now() - datetime.timedelta(days=CLOSED_RECHECK_DAYS)
    out = []
    for done in sorted(p for p in (pm_root / "done").iterdir() if p.is_dir()):
        closed = _closed_at(done)
        if closed is None or closed < cutoff:
            continue
        old = pm_root / "active" / done.name
        stray = old.is_dir() and not (old / "ledger.json").exists() and not (old / "HANDOFF.md").exists()
        for folder, why in [(done, "it reached the task after close's last inbox scan")] + (
                [(old, "it was written to the task's old active/ path after close moved the task")] if stray else []):
            entries, problems = scan(folder)
            rels = [f"inbox/{name}" for name, _ in entries] + [rel for _, rel, _ in problems]
            out += [(f"{folder.parent.name}/{folder.name}/{rel}", f"{why}, so nobody has read it. Read it, apply its "
                     f"facts with the operator, then archive it into done/{done.name}/inbox/processed/")
                    for rel in dict.fromkeys(rels)]
    return out


def inbox_bytes(task_dir: pathlib.Path) -> int:
    inbox = task_dir / "inbox"
    return sum(p.stat().st_size for p in inbox.rglob("*") if p.is_file()) if inbox.is_dir() else 0


def _month(name: str) -> str:
    m = NAME_RE.match(name)
    return f"{m.group(1)}-{m.group(2)}" if m else _now().strftime("%Y-%m")


def archive(task_dir: pathlib.Path, names) -> list:
    """Move the named inbox entries to processed/<YYYY-MM>/; returns
    (name, destination) pairs. A name collision gets -2, -3, ..."""
    inbox = task_dir / "inbox"
    moved = []
    for name in names:
        source = inbox / name
        if pathlib.PurePath(name).name != name or name == "README.md" or not source.is_file():
            raise InboxError(4, f"no inbox entry {name!r}")
        folder = inbox / "processed" / _month(name)
        folder.mkdir(parents=True, exist_ok=True)
        stem, suffix = os.path.splitext(name)
        for n in range(1, 1000):
            target = folder / (name if n == 1 else f"{stem}-{n}{suffix}")
            if not target.exists() and _move_no_clobber(source, target):
                break
        else:
            raise InboxError(4, f"no free name for {name} under {folder}")
        moved.append((name, target))
    return moved


def _move_no_clobber(source: pathlib.Path, target: pathlib.Path) -> bool:
    """Move without ever replacing an existing file. False when the target
    appeared meanwhile."""
    try:
        os.link(source, target)
    except FileExistsError:
        return False
    except OSError:
        if target.exists():
            return False
        os.rename(source, target)
        return True
    os.unlink(source)
    return True


def valid_entries(task_dir: pathlib.Path) -> list:
    return [name for name, _ in scan(task_dir)[0]]
