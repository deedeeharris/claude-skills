"""
Executable resolution and preflight checks for mm PM dispatch.

This module RESOLVES and REPORTS. It does not spawn any agent CLI — no
dispatch engine lives here.

STDIN DISCIPLINE — per CLI, never blanket:
  * codex: `codex exec` reads instructions FROM STDIN when the prompt
    argument is omitted or is "-", and APPENDS piped stdin even when a
    prompt argument exists (codex-cli/SKILL.md). The canonical mm dispatch
    pipes the prompt file into stdin. Therefore stdin=DEVNULL is CORRECT
    ONLY after the launcher has chosen an argv/file prompt mode. A blanket
    DEVNULL breaks the documented codex flow.
  * claude --bg / any launcher not fed by stdin: stdin=subprocess.DEVNULL.
  * The diagnosis to record: an INHERITED stdin makes the child wait
    forever — 0% CPU, empty output file, process still in the process
    table. It looks like a hang; it is a read that never returns.
"""
import os
import shutil
import subprocess
import sys

KNOWN_EXECUTABLES = {
    "python": [sys.executable, "python3", "python"],
    "git": ["git"],
    "claude": ["claude"],
    "codex": ["codex"],
    "agy": ["agy"],
}


class PreflightFailed(RuntimeError):
    pass


def _rejected(resolved_path, name):
    normalized = resolved_path.replace("/", "\\").lower()
    if "\\windowsapps\\" in normalized:
        return True
    if name == "python" and ("\\venv\\" in normalized or "\\.venv\\" in normalized):
        return True
    return False


def resolve_executable(name, candidates=None):
    """Resolve `name` from explicit `candidates` (absolute paths from the
    operator's overlay), else from KNOWN_EXECUTABLES, which holds only PATH
    names plus the running interpreter."""
    candidates = candidates or KNOWN_EXECUTABLES.get(name)
    if not candidates:
        raise PreflightFailed(f"unknown executable name: {name!r}")

    tried = []
    for candidate in candidates:
        if os.path.isfile(candidate):
            if _rejected(candidate, name):
                tried.append(f"{candidate} (rejected: forbidden path)")
                continue
            return candidate
        tried.append(f"{candidate} (not a file)")

        found = shutil.which(candidate)
        if found:
            if _rejected(found, name):
                tried.append(f"{candidate} -> {found} (rejected: forbidden path)")
                continue
            return found
        tried.append(f"{candidate} -> not found on PATH")

    raise PreflightFailed(
        f"could not resolve executable {name!r}; candidates tried: {tried}"
    )


def probe_version(exe, version_argv):
    try:
        proc = subprocess.run(
            [exe] + list(version_argv),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise PreflightFailed(f"failed to probe version for {exe}: {e}")

    output = ((proc.stdout or "") + (proc.stderr or "")).strip()

    if proc.returncode != 0:
        raise PreflightFailed(
            f"version probe for {exe} exited {proc.returncode}: {output}"
        )

    return output


def preflight(requirements):
    if not requirements:
        raise PreflightFailed(
            "preflight called with zero requirements — an empty requirements "
            "list is a failure to configure, not a clean pass"
        )

    problems = []
    results = {}

    for name, version_argv in requirements:
        try:
            exe = resolve_executable(name)
        except PreflightFailed as e:
            problems.append(str(e))
            continue

        try:
            version = probe_version(exe, version_argv)
        except PreflightFailed as e:
            problems.append(str(e))
            continue

        results[name] = {"path": exe, "version": version}

    if problems:
        raise PreflightFailed("; ".join(problems))

    return results
