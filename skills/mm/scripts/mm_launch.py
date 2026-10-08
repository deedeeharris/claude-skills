"""What counts as a dispatch's launch record in a Claude Code transcript, for each launch form.

The dispatch record stores the launch as dispatched (`launch`): the launch
template with the prompt copy's absolute path in place of {prompt}; a template
without {prompt} is a prefix, and the path follows it after a space. It also
stores that path exactly as substituted (`prompt_path`).
  - A slash command (first word `/name` or `/plugin:name`, no further `/`,
    such as `/babysitter:yolo <path>`): a user or system record whose
    text holds the command record (`<command-name>/babysitter:yolo</command-name>`)
    and names the prompt copy.
  - Any other launch (a plain prompt, a command that is not a slash command,
    such as an absolute executable path `/usr/bin/run <path>`): a user record
    whose text holds the whole launch text the record stores.
  - A record whose stored launch is empty, does not hold its stored
    `prompt_path`, or holds no letter or digit besides that path (a dispatch
    with no launch, a template that is only {prompt}, or {prompt} wrapped in
    quotes, brackets or other punctuation): only the prompt copy's name links
    a record to it, which proves nothing, so the launch is never ALIVE:
    PENDING, then DEAD once the stall limit has passed since the launch.
  - An older record without `prompt_path` whose launch is not a slash command
    can never be proven, and its stall limit proves nothing either: it is
    PENDING with the reason PREDATES and never DEAD by time; the operator
    checks the builder by hand and closes the dispatch. No transcript can
    prove it, so an explicit --transcript that exists is refused.
In every form the start record is stamped at or after the launch and is never
a tool result quoting such text.
"""

import re

SLASH_COMMAND = re.compile(r"/[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?")
PREDATES = ("record predates prompt_path; cannot prove this launch; operator must check the builder by hand "
            "(the dispatch record stores no launch text naming its prompt copy), then close it with mm.py "
            "dispatch --close {id} --outcome <what they found>; never DEAD at the stall limit")


def launch_facts(record: dict) -> dict:
    """The launch command (slash form) or the launch text, exactly as stored
    (any other form), of a dispatch record; the launch text is empty unless the
    record stores one holding its stored `prompt_path` and a letter or digit
    besides that path."""
    launch = record.get("launch") or ""
    first = (launch.split() or [""])[0]
    if SLASH_COMMAND.fullmatch(first):
        return {"command": first, "launch_text": ""}
    path = record.get("prompt_path") or ""
    rest = launch.replace(path, "") if path and path in launch else ""
    usable = any(c.isalnum() for c in rest)
    return {"command": "", "launch_text": launch if usable else ""}


def predates_prompt_path(record: dict) -> bool:
    """An older record, stored before records kept `prompt_path`, whose launch
    is not a slash command: nothing can prove it, not even its stall limit."""
    launch = record.get("launch") or ""
    first = (launch.split() or [""])[0]
    return bool(first) and not SLASH_COMMAND.fullmatch(first) and not record.get("prompt_path")


def is_start(record: dict, texts: list, *, command: str, marker: str, launch_text: str) -> bool:
    """`record` (not a tool result, stamped at or after the launch) is this
    dispatch's launch record; with neither a command nor a launch text it
    only names the prompt copy, which plain_verdict never takes as proof."""
    kind = record.get("type")
    if command:
        tag = f"<command-name>{command}</command-name>"
        return kind in ("user", "system") and any(marker in t and tag in t for t in texts)
    if launch_text:
        return kind == "user" and any(launch_text in t for t in texts)
    return kind in ("user", "system") and any(marker in t for t in texts)


def describe(*, command: str, marker: str, launch_text: str) -> str:
    if command:
        return f"the command record {command} for {marker}"
    if launch_text:
        return f"a user record holding the launch text {launch_text!r}"
    return f"a record naming {marker}"


def plain_verdict(elapsed: float, stall_s: float, launch_text: str) -> tuple:
    """(verdict, reason) for a launch that is not a slash command, once its
    start record and a tool_use in its chain are seen. Without a stored launch
    text that start record only names the prompt copy, which proves nothing."""
    if launch_text:
        return "ALIVE", "the transcript shows this launch and an assistant tool_use"
    reason = ("the dispatch record stores no launch text naming its prompt copy beyond its path, so a record "
              "naming the prompt copy does not prove this launch")
    if elapsed < stall_s:
        return "PENDING", f"{reason}; DEAD at the stall limit ({stall_s / 60:.0f} min after the launch)"
    return "DEAD", f"{reason}; {elapsed / 60:.0f} min after the launch (stall limit {stall_s / 60:.0f} min)"
