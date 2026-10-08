"""Stdin and patch parsing shared by the mm hooks.

read_event() returns the hook payload as a dict, or None for anything that is
not a JSON object. target_paths() lists the files a tool call writes: the
file_path or notebook_path of Edit, Write, MultiEdit and NotebookEdit, and
the "*** Update File:", "*** Add File:" and "*** Delete File:" lines of a
Codex apply_patch, wherever the patch text sits inside tool_input. Relative
paths are resolved against the payload's cwd. pm_task_dir() names the task
folder when a path sits directly inside a .private/pm, .claude/pm or docs/pm
tree; in_pm_tree() tells whether a path is at or below such a folder at all
(task folders, and files like .private/pm/DASHBOARD.md).
"""

import json
import os
import pathlib
import re
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent / "scripts"
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
PATCH_LINE_RE = re.compile(r"^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$", re.M)
MOVE_LINE_RE = re.compile(r"^\*\*\* Move to:\s*(.+?)\s*$", re.M)
PM_TREES = ((".private", "pm"), (".claude", "pm"), ("docs", "pm"))


def read_event():
    try:
        data = json.load(sys.stdin)
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)


def patch_paths(text: str) -> list:
    return [m.group(1) for m in PATCH_LINE_RE.finditer(text)] + [m.group(1) for m in MOVE_LINE_RE.finditer(text)]


def target_paths(data: dict) -> list:
    tool_input = data.get("tool_input")
    found = []
    if isinstance(tool_input, dict):
        for key in ("file_path", "notebook_path", "TargetFile"):
            value = tool_input.get(key)
            if isinstance(value, str) and value:
                found.append(value)
    for text in _strings(tool_input):
        if "*** " in text:
            found.extend(patch_paths(text))
    cwd = data.get("cwd") if isinstance(data.get("cwd"), str) and data.get("cwd") else os.getcwd()
    out = []
    for p in found:
        path = pathlib.Path(p)
        if not path.is_absolute():
            path = pathlib.Path(cwd) / path
        if path not in out:
            out.append(path)
    return out


def pm_task_dir(path: pathlib.Path):
    """The folder holding `path` when that folder is inside a PM tree, else None."""
    parts = [p.lower() for p in pathlib.Path(str(path).replace("\\", "/")).parts]
    for i in range(len(parts) - 1):
        if (parts[i], parts[i + 1]) in PM_TREES and len(parts) > i + 3:
            return pathlib.Path(path).parent
    return None


def in_pm_tree(path) -> bool:
    """True when `path` is at or below a .private/pm, .claude/pm or docs/pm
    folder. Components are compared case-folded and split on both slash
    forms, so a normcase'd Windows path is read the same on every OS."""
    parts = [p.lower() for p in re.split(r"[\\/]+", str(path)) if p]
    return any((parts[i], parts[i + 1]) in PM_TREES for i in range(len(parts) - 1))


def session_id(data: dict) -> str:
    value = data.get("session_id") or data.get("sessionId") or ""
    return value.strip() if isinstance(value, str) else ""

