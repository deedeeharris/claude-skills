"""Read-only host metadata and explicit operator startup assertions.

Neither a matching identity nor a socket/hook proves same-session continuation.
No socket connection, subprocess, credential resolution or model call occurs here.
"""

from __future__ import annotations

import errno
import os
import stat
from pathlib import Path

from .config import Config

__all__ = ["HarnessError", "harness_report", "validate_run_mode"]

_MODES = ("collector-only", "cooperative", "task-completion", "native")


class HarnessError(ValueError):
    """Safe capability/startup error; never include environment values."""


def _control_socket(home):
    """Inspect the conventional socket with no symlink traversal, including parents."""
    if os.name == "nt":
        # The conventional POSIX control socket is not a Windows host adapter.
        return "unavailable"
    directory = None
    try:
        path = Path(home).absolute()
        # Pin each directory as it is opened. O_NOFOLLOW also avoids a symlink
        # replacement race that checking Path.is_symlink() first would permit.
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        directory = os.open(path.anchor, flags)
        for part in (*path.parts[1:], "app-server-control"):
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        info = os.stat(
            "app-server-control.sock", dir_fd=directory, follow_symlinks=False
        )
        return "present-unverified" if stat.S_ISSOCK(info.st_mode) else "not-socket"
    except FileNotFoundError:
        return "missing"
    except OSError as exc:
        return (
            "not-socket" if exc.errno in {errno.ELOOP, errno.ENOTDIR} else "unavailable"
        )
    except (ValueError, TypeError):
        return "unavailable"
    finally:
        if directory is not None:
            os.close(directory)


def harness_report(config: Config, *, environ=None) -> dict:
    """Return safe capability observations without validating live host ownership."""
    environ = os.environ if environ is None else environ
    thread = environ.get("CODEX_THREAD_ID")
    session = environ.get("CODEX_SESSION_ID")
    identities = [value for value in (thread, session) if value]
    identity = (
        "unavailable"
        if not identities
        else "matched"
        if all(value == config.session_id for value in identities)
        else "mismatch"
    )
    configured = bool(config.host_command)
    home = environ.get("CODEX_HOME")
    control = _control_socket(home) if identities and home else "unavailable"
    reasons = []
    if identity == "mismatch":
        reasons.append("Current and bound session identities disagree.")
    if not configured:
        reasons.append("No trusted host command is configured.")
    if control == "missing":
        reasons.append("The conventional Codex control socket is missing.")
    elif control == "not-socket":
        reasons.append("The conventional Codex control path is not a socket.")
    return {
        "session_identity": identity,
        "host_command": "configured" if configured else "unconfigured",
        "codex_control_socket": control,
        "automatic_continuation": (
            "blocked" if not configured or identity == "mismatch" else "live-unverified"
        ),
        "blocking_reasons": reasons,
    }


def validate_run_mode(config: Config, mode, *, environ=None) -> dict:
    """Validate operator assertions without detecting host continuation capabilities."""
    if mode not in _MODES:
        raise HarnessError(
            "Run requires --mode collector-only, cooperative, task-completion, or native. "
            "collector-only saves queued work; cooperative requires an open "
            "existing-agent blocking-tool loop; task-completion requires live-verified "
            "same-session host task-completion notifications; native requires a trusted "
            "host_command."
        )
    report = harness_report(config, environ=environ)
    if report["session_identity"] == "mismatch":
        raise HarnessError(
            "Current and bound session identities disagree; run from the bound "
            "session with consistent Codex identity variables."
        )
    if mode == "native" and not config.host_command:
        raise HarnessError(
            "Native mode requires a separately configured trusted host_command; "
            "no native adapter is bundled or verified."
        )
    return report
