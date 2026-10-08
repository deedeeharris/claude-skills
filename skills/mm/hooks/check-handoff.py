"""No-Archaeology hook: PostToolUse checker for HANDOFF.md.

Two modes:
  HOOK MODE (default): a Claude Code PostToolUse event as JSON on stdin.
    Contract: never break a turn. Always exits 0. On a violation it prints
    exactly one JSON object on stdout carrying hookSpecificOutput.additionalContext
    (the common Claude Code hook pattern). Never prints non-JSON to stdout.
    Matches Edit/Write/MultiEdit by file_path/TargetFile directly. Also matches
    Bash (the compiled/ledger workflow's mm_compile.py runs there, not through
    a matched edit tool) by locating the HANDOFF.md the command just wrote,
    but only when the command text names HANDOFF or the compiler. Codex
    apply_patch payloads are read through hookio (the *** File: lines).
    Besides the archaeology symptoms it warns about Section 0A values over
    400 chars, and in a ledger folder it runs `mm.py check` and reports drift.
  CLI MODE (--check <path>): prints human-readable violations to stderr and
    exits 1 if any are found, 0 if clean. This is the testable red/green
    surface and the entry point non-Claude runners use.

Implements No-Archaeology patterns A and B only (literal-substring symptoms
and one line-anchored symptom) — not patterns C, D or E from the full test,
and not the prose-only literal "correcting the" (dropped: it fires on
legitimate work text such as "correcting the encoding bug").
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

import hookio  # noqa: E402

patterns = [
    "preserved for audit trail",
    "historical note kept for honesty",
    "old content below",
    "initial assessment was",
    "re-diagnosed",
]

ANCHOR_AT_LINE_START = frozenset({"old content below"})

_ANCHOR_PREFIX = r"^\s*(?:[-*>]\s*)?(?:\*\*)?"
_ANCHOR_RES = {
    p: re.compile(_ANCHOR_PREFIX + re.escape(p), re.IGNORECASE)
    for p in patterns
    if p in ANCHOR_AT_LINE_START
}

SECTION_4_ARCHIVE = "## section 4 archive"

# The authoritative HANDOFF.md writer (mm_compile.py) runs via the Bash tool,
# not Edit/Write/MultiEdit, so tool_input carries no file_path/TargetFile to
# key off. When the matched tool is Bash, fall back to locating the HANDOFF.md
# the command just wrote by recency under the event's cwd, but only bother
# walking the filesystem when the command text itself names HANDOFF or the
# compiler — keeps the hook a no-op for the vast majority of Bash calls.
BASH_COMMAND_TRIGGERS = ("HANDOFF", "mm_compile")
RECENT_WRITE_WINDOW_S = 15
WALK_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv"}
WALK_MAX_DEPTH = 6


def _scan_lines_before_archive(lines):
    scan_lines = []
    for line in lines:
        if line.lower().startswith(SECTION_4_ARCHIVE):
            break
        scan_lines.append(line)
    return scan_lines


def _find_violations(lines):
    violations = []
    for i, line in enumerate(lines, 1):
        lowered = line.lower()
        for p in patterns:
            if p in ANCHOR_AT_LINE_START:
                hit = bool(_ANCHOR_RES[p].search(line))
            else:
                hit = p in lowered
            if hit:
                violations.append((i, line))
                break
    return violations


def scan_file(path):
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    return _find_violations(_scan_lines_before_archive(lines))


def _format_violation(i, line):
    text = line.strip()[:100].encode("ascii", "backslashreplace").decode("ascii")
    return f"  Line {i}: {text}"


FIELD_CAP_CHARS = 400
CHECK_TIMEOUT_S = 30


def long_fields(path):
    """Section 0A fields whose value is over the 400-char cap, as (name, length)."""
    try:
        import mm_compile
        with open(path, encoding="utf-8") as f:
            fields = mm_compile.parse_handoff(f.read()).get("dashboard_index", {})
    except Exception:
        return []
    return [(name, len(value)) for name, value in fields.items() if len(value) > FIELD_CAP_CHARS]


def _format_long_field(name, length):
    return (f"  Section 0A field {name!r} is {length} chars (cap {FIELD_CAP_CHARS}); "
            f"replace it with a shorter value through mm.py set-field")


def ledger_drift(path):
    """`mm.py check` output lines for a HANDOFF in a ledger folder when check fails, else []."""
    task_dir = pathlib.Path(path).parent
    if not (task_dir / "ledger.json").is_file():
        return []
    try:
        proc = subprocess.run([sys.executable, str(HERE.parent / "scripts" / "mm.py"), "check",
                               "--task-dir", str(task_dir)], capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=CHECK_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode == 0:
        return []
    lines = [line for line in (proc.stdout + proc.stderr).splitlines() if line.strip()]
    return [f"  mm.py check exited {proc.returncode}:"] + ["    " + line for line in lines[:20]]


def run_cli(path):
    try:
        violations = scan_file(path)
    except OSError as exc:
        print(f"No Archaeology Test: could not read {path}: {exc}", file=sys.stderr)
        return 1
    for name, length in long_fields(path):
        print("Warning:" + _format_long_field(name, length), file=sys.stderr)
    if not violations:
        return 0
    print("No Archaeology Test FAILED - fix before continuing:", file=sys.stderr)
    for i, line in violations:
        print(_format_violation(i, line), file=sys.stderr)
    return 1


def _find_recently_written_handoff(cwd):
    """Newest HANDOFF.md under cwd whose mtime falls inside the recent-write
    window, or None. Bounded depth, skips heavy/irrelevant directories."""
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        return None
    now = time.time()
    root_depth = os.path.normpath(cwd).count(os.sep)
    best, best_mtime = None, -1.0
    for dirpath, dirnames, filenames in os.walk(cwd):
        depth = os.path.normpath(dirpath).count(os.sep) - root_depth
        if depth >= WALK_MAX_DEPTH:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in WALK_SKIP_DIRS]
        if "HANDOFF.md" not in filenames:
            continue
        candidate = os.path.join(dirpath, "HANDOFF.md")
        try:
            mtime = os.path.getmtime(candidate)
        except OSError:
            continue
        if now - mtime <= RECENT_WRITE_WINDOW_S and mtime > best_mtime:
            best, best_mtime = candidate, mtime
    return best


def _findings(fp):
    parts = []
    violations = scan_file(fp)
    if violations:
        detail = "\n".join(_format_violation(i, line) for i, line in violations)
        parts.append(f"No Archaeology Test FAILED in {fp} — fix before continuing:\n{detail}")
    long = long_fields(fp)
    if long:
        parts.append(f"Section 0A cap warning in {fp}:\n" + "\n".join(_format_long_field(n, k) for n, k in long))
    drift = ledger_drift(fp)
    if drift:
        parts.append(f"Ledger check failed for {fp}; HANDOFF.md is generated from ledger.json:\n" + "\n".join(drift))
    return parts


def _emit_violations(*paths):
    parts = [part for fp in paths for part in _findings(fp)]
    if not parts:
        return
    context = "\n\n".join(parts)
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": context,
        }
    }
    print(json.dumps(output))


def _run_hook_body():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return
    if not isinstance(data, dict):
        return
    tool_input = data.get("tool_input", {})
    handoffs = [str(p) for p in hookio.target_paths(data) if "HANDOFF" in p.name and p.is_file()]
    if handoffs:
        _emit_violations(*handoffs)
        return
    if not isinstance(tool_input, dict):
        return
    command = tool_input.get("command", "")
    if not isinstance(command, str) or not command:
        return
    if not any(trigger in command for trigger in BASH_COMMAND_TRIGGERS):
        return
    found = _find_recently_written_handoff(data.get("cwd") or os.getcwd())
    if found is None:
        return
    _emit_violations(found)


def run_hook():
    # Contract: never break a turn. Any unexpected exception is swallowed
    # here so the caller always sees exit 0.
    try:
        _run_hook_body()
    except Exception:
        pass


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--check":
        sys.exit(run_cli(sys.argv[2]))
    run_hook()
    sys.exit(0)


if __name__ == "__main__":
    main()
