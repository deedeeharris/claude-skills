"""PreToolUse guard: ledger.json and the generated PM files change only through mm.py,
and a bound PM session does not write product code itself.

Blocks Edit, Write, MultiEdit, NotebookEdit and Codex apply_patch on a task's
ledger.json, HANDOFF.md, HANDOFF-archive.md, and ROADMAP.html in a ledger
folder, inside a .private/pm, .claude/pm or docs/pm tree. In a session bound
with `mm.py bind` (the PM), it also blocks those writes to any file inside
the bound task's repository outside the PM folder tree; delegated workers
(payloads with an agent_id) and unbound sessions are not fenced. The fence
lives in scripts/mm_fence.py, which `mm.py fence` uses too. A block exits 2
with the reason on stderr, which both Claude Code and Codex hand back to the
model.

It fails closed for write tools: when the payload names a write tool (Edit,
Write, MultiEdit, NotebookEdit, apply_patch, or a shell call running
apply_patch) but the target file cannot be determined, or the path check
itself raises, the call is refused. Other tools pass silently. A payload
that cannot be read as a JSON object (empty, truncated, not UTF-8, or JSON of
another shape) is refused too: the guard cannot tell whether it is a
protected write. So is a JSON object without a non-empty string tool_name,
unless its hook_event_name shows it is not a PreToolUse event. Run by hand, --help (or a terminal on stdin) prints this
text and exits 0. Bash writes are not parsed here:
check-handoff runs mm.py check afterwards, and check fails on any hand edit.
"""

import json
import pathlib
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))

import hookio  # noqa: E402
import mm_fence  # noqa: E402

GENERATED = ("HANDOFF.md", "HANDOFF-archive.md", "ROADMAP.html")
WRITE_COMMANDS = ("mm.py add-row, edit-row, set-row, add-decision, set-field or set-section "
                  "(or batch for several); mm.py compile regenerates the generated files")


def verdict(path: pathlib.Path):
    """The refusal message for a write to `path`, or None when the write is allowed."""
    task_dir = hookio.pm_task_dir(path)
    if task_dir is None:
        return None
    name = path.name
    ledger_mode = (task_dir / "ledger.json").is_file()
    if name == "ledger.json":
        return (f"mm guard: {path} is the task ledger and changes only through mm.py commands; "
                f"use: {WRITE_COMMANDS}")
    if name not in GENERATED:
        return None
    if name == "ROADMAP.html" and not ledger_mode:
        return None
    if ledger_mode or name == "HANDOFF-archive.md":
        return (f"mm guard: {path} is generated from ledger.json by mm.py and never edited by hand; "
                f"use: {WRITE_COMMANDS}")
    if (task_dir / "HANDOFF.md").is_file():
        return (f"mm guard: {path} is generated from ledger.json by mm.py and never edited by hand; "
                f"use: /mm migrate (mm.py migrate --task-dir {task_dir}) to convert this legacy folder "
                f"to a ledger, then {WRITE_COMMANDS}")
    return (f"mm guard: {path} is generated from ledger.json by mm.py and never edited by hand; "
            f"use: mm.py scaffold --task-dir {task_dir} to create a new task")


PATCH_TOOLS = ("apply_patch",)
SHELL_TOOLS = ("shell", "local_shell", "exec_command", "container.exec")


def is_write(data: dict) -> bool:
    """True when the payload names a tool that writes files."""
    name = data.get("tool_name")
    if name in hookio.EDIT_TOOLS or name in PATCH_TOOLS:
        return True
    if name in SHELL_TOOLS:
        command = data.get("tool_input", {}).get("command") if isinstance(data.get("tool_input"), dict) else None
        first = command[0] if isinstance(command, list) and command else command
        return isinstance(first, str) and first.strip().startswith("apply_patch")
    return False


def decide(data: dict) -> dict:
    """The fence decision document for one payload (mm_fence.evaluate)."""
    return mm_fence.evaluate(data, verdict=verdict, is_write=is_write)


def refusals(data: dict) -> list:
    return decide(data)["messages"]


def parse_payload(raw: bytes):
    """(the hook payload as a dict, "") or (None, why it cannot be read)."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        return None, f"the PreToolUse payload on stdin is not readable JSON ({type(exc).__name__})"
    if not isinstance(data, dict):
        return None, f"the PreToolUse payload on stdin is a JSON {type(data).__name__}, not an object"
    return data, ""


def _payload():
    try:
        raw = sys.stdin.buffer.read()
    except OSError as exc:
        return None, f"the PreToolUse payload on stdin is not readable JSON ({type(exc).__name__})"
    return parse_payload(raw)


def unreadable(problem: str) -> str:
    return (f"mm guard: {problem}, so the call is refused: the guard cannot tell whether it writes a protected PM "
            "file (it fails closed)")


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if {"--help", "-h"} & set(argv) or sys.stdin is None or sys.stdin.isatty():
        print(__doc__)
        return 0
    data, problem = _payload()
    found = refusals(data) if data is not None else [unreadable(problem)]
    if not found:
        return 0
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    print("\n".join(found), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
