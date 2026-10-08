"""UserPromptSubmit hook: the PM-mode line for a session bound to a task.

A session bound with `mm.py bind` gets one JSON object on stdout: a
systemMessage with the banner, task and mode, and an additionalContext line
naming the task folder and `mm.py status`. An unbound session, or any
unreadable input, gets no output. It reads two small files and never runs git.
When the environment variable MM_CC_RUNTIME_MOD_ACTIVE equals the payload's
session id (an optional runtime adapter already shows the banner), the
systemMessage is left out and the additionalContext is unchanged. Any other
value, or none, gives the full output; a child session inherits a value that
never equals its own id.
"""

import json
import os
import pathlib
import sys

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

import hookio  # noqa: E402

BANNER = "\U0001f3a9 PM mode | Task: "
MARKER = "MM_CC_RUNTIME_MOD_ACTIVE"


def describe(task_dir: pathlib.Path) -> tuple:
    """(task name, mode) from ledger.json, else from the folder name."""
    try:
        doc = json.loads((task_dir / "ledger.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return task_dir.name, "attended"
    loop = doc.get("loop") if isinstance(doc, dict) and isinstance(doc.get("loop"), dict) else {}
    task = doc.get("task") if isinstance(doc, dict) and isinstance(doc.get("task"), str) else ""
    return task or task_dir.name, "unattended" if loop.get("mode") == "unattended" else "attended"


def message(data: dict):
    session = hookio.session_id(data)
    if not session:
        return None
    import mm_where
    try:
        task_dir = mm_where.whoami(session)
    except mm_where.WhereError:
        return None
    if task_dir is None or not task_dir.is_dir():
        return None
    task, mode = describe(task_dir)
    script = HERE.parent / "scripts" / "mm.py"
    out = {
        "systemMessage": f"{BANNER}{task} | mode: {mode}",
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": (f"{BANNER}{task} ({mode}). Task folder: {task_dir}. "
                                  f"Status block: {script} status --task-dir {task_dir}"),
        },
    }
    if os.environ.get(MARKER) == session:
        del out["systemMessage"]
    return out


def main() -> int:
    try:
        data = hookio.read_event()
        out = message(data) if data else None
    except Exception:
        return 0
    if out:
        print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
