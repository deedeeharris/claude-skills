"""
Gate checks for the mm PM skill.

A gate NEVER returns a bare bool or a bare string. It always returns a list
of GateCheck dicts: {"item": str, "ok": bool, "note": str}. `note` carries
evidence when ok=True and the reason when ok=False; an empty note is invalid
in both directions. A gate that ran zero checks raises VacuousGate — a
vacuous pass is fatal, not a silent green.

Rule we keep that SSSF lacks: every gate ships with a test that drives it RED
against deliberately broken input BEFORE any green assertion is trusted.
"""
import os
import pathlib
import subprocess


class VacuousGate(AssertionError):
    pass


class GateError(RuntimeError):
    """Gate machinery itself failed — never a PASS, never a FAIL, never to
    be folded into `all(c["ok"] ...)`. Distinct outcome the caller must
    handle separately from a clean or dirty result."""

    pass


class GateContractViolation(GateError):
    """A check dict violated {"item": non-empty str, "ok": real bool,
    "note": non-empty str}. Truthy non-bool `ok` (e.g. the string "false")
    or a missing evidence `note` are rejected here, not silently accepted."""

    pass


class GitCommandFailed(GateError):
    """A git subprocess the gate depends on exited non-zero. Empty stdout
    from a failed git command is NOT the same as "nothing changed" and
    must never be read as a clean pass."""

    pass


def run_gates(checks):
    if not checks:
        raise VacuousGate("gate ran zero checks")
    for c in checks:
        item = c.get("item")
        ok = c.get("ok")
        note = c.get("note")
        if not isinstance(ok, bool):
            raise GateContractViolation(
                f"check {item!r}: ok must be a real bool, got {ok!r} ({type(ok).__name__})"
            )
        if not isinstance(item, str) or not item.strip():
            raise GateContractViolation(f"check item must be a non-empty str, got {item!r}")
        if not isinstance(note, str) or not note.strip():
            raise GateContractViolation(
                f"check {item!r}: note must be a non-empty str (evidence), got {note!r}"
            )
    return (all(c["ok"] for c in checks), checks)


def gate_files_exist(paths, *, root):
    if not paths:
        raise VacuousGate("gate ran zero checks")

    checks = []
    for p in paths:
        full = pathlib.Path(root) / p
        if full.is_file():
            checks.append({"item": p, "ok": True, "note": f"exists: {full}"})
        else:
            checks.append({"item": p, "ok": False, "note": f"missing: {full}"})
    return checks


def gate_command_exits_zero(item, argv, *, cwd, env=None, timeout=300):
    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        note = f"timed out after {timeout}s: argv={argv}"
        return [{"item": item, "ok": False, "note": note}]

    stdout_tail = (proc.stdout or "")[-2000:]
    stderr_tail = (proc.stderr or "")[-2000:]
    ok = proc.returncode == 0
    note = (
        f"exit={proc.returncode} "
        f"stdout(last2000)={stdout_tail!r} "
        f"stderr(last2000)={stderr_tail!r}"
    )
    return [{"item": item, "ok": ok, "note": note}]


def _norm_path(p):
    return p.strip().replace("\\", "/").casefold()


def gate_diff_matches_claims(claimed, *, repo_root, ignore=()):
    work_tree_proc = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=repo_root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    if work_tree_proc.returncode != 0 or work_tree_proc.stdout.strip() != "true":
        return [{"item": "git work tree", "ok": False, "note": "not a git work tree"}]

    diff_proc = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"],
        cwd=repo_root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    if diff_proc.returncode != 0:
        raise GitCommandFailed(
            f"git diff failed: exit={diff_proc.returncode} "
            f"stderr={(diff_proc.stderr or '').strip()!r}"
        )

    untracked_proc = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard"],
        cwd=repo_root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    if untracked_proc.returncode != 0:
        raise GitCommandFailed(
            f"git ls-files failed: exit={untracked_proc.returncode} "
            f"stderr={(untracked_proc.stderr or '').strip()!r}"
        )

    changed = set()
    for line in (diff_proc.stdout or "").splitlines():
        if line.strip():
            changed.add(_norm_path(line))
    for line in (untracked_proc.stdout or "").splitlines():
        if line.strip():
            changed.add(_norm_path(line))

    if not claimed and not changed:
        raise VacuousGate("gate ran zero checks")

    claimed_norm = {}
    for c in claimed:
        claimed_norm[_norm_path(c)] = c
    ignore_norm = {_norm_path(i) for i in ignore}

    checks = []
    for cn, orig in claimed_norm.items():
        if cn in changed:
            checks.append(
                {"item": orig, "ok": True, "note": f"matched changed path: {cn}"}
            )
        else:
            checks.append(
                {"item": orig, "ok": False, "note": f"claimed but not changed: {cn}"}
            )

    for cp in sorted(changed):
        if cp not in claimed_norm and cp not in ignore_norm:
            checks.append(
                {"item": cp, "ok": False, "note": f"changed but not claimed: {cp}"}
            )

    if not checks:
        raise VacuousGate("gate ran zero checks")

    return checks
