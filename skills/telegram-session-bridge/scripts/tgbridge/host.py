"""Trusted local host notifications; no model or shell execution."""

from __future__ import annotations

import json
import math
import os
import signal
import subprocess
import tempfile
from pathlib import Path

from .privatefs import (
    check_private,
    lock_fd,
    open_nofollow,
    private_directory,
    runtime_root,
    safe_path,
)

__all__ = ["CollectorLock", "Host", "HostError", "process_identity"]


class HostError(ValueError):
    """A safe local host/ownership error."""


class Host:
    def __init__(self, command, binding_id, session_id, *, timeout=5):
        if (
            not isinstance(command, list)
            or any(not isinstance(x, str) or not x or "\x00" in x for x in command)
            or isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 < timeout <= 5
        ):
            raise HostError("Invalid host configuration")
        self.command = list(command)
        self.binding_id = binding_id
        self.session_id = session_id
        self.timeout = timeout

    def send(
        self,
        event,
        *,
        request_id=None,
        generation=0,
        text="",
        canceled_request_ids=None,
    ):
        if event not in {"notify", "interrupt", "stop"}:
            raise HostError("Invalid host event")
        if not self.command:
            return {"status": "unsupported", "reason": "unconfigured"}
        payload = {
            "event": event,
            "binding_id": self.binding_id,
            "session_id": self.session_id,
            "request_id": request_id,
            "generation": generation,
            "text": text,
            "canceled_request_ids": canceled_request_ids or [],
            "scope": "binding_session_tasks",
            "ownership": "claim_required",
        }
        if os.name == "nt":
            from .windows_host import send

            return send(self.command, payload, self.timeout)
        # Disk-backed output avoids unbounded child stdout/stderr in parent RAM.
        with tempfile.TemporaryFile() as output:
            try:
                proc = subprocess.Popen(
                    self.command,
                    stdin=subprocess.PIPE,
                    stdout=output,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                try:
                    proc.communicate(json.dumps(payload).encode(), timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                    return {"status": "unsupported", "reason": "timeout"}
                if proc.returncode != 0:
                    return {"status": "unsupported", "reason": "failed"}
                output.seek(0)
                response = json.loads(output.read(8193))
                if isinstance(response, dict) and response.get("status") == "accepted":
                    return {"status": "accepted"}
            except (OSError, ValueError, TypeError):
                pass
        return {"status": "unsupported", "reason": "unsupported"}


class CollectorLock:
    """One local collector per bot, shared by every config directory for this UID."""

    def __init__(self, bot_id, *, runtime_dir=None):
        if type(bot_id) is not int or bot_id <= 0:
            raise HostError("Invalid bot identity")
        self.root = Path(runtime_dir) if runtime_dir is not None else runtime_root()
        self.bot_id = bot_id
        self.fd = None

    def __enter__(self):
        try:
            self.root = safe_path(self.root)
            private_directory(self.root, parents=False)
            fd = open_nofollow(
                self.root / f"{self.bot_id}.lock", os.O_CREAT | os.O_RDWR
            )
            self.fd = fd
            check_private(self.root / f"{self.bot_id}.lock", fd=fd)
            lock_fd(fd)
            return self
        except (OSError, ValueError):
            self.__exit__(None, None, None)
            raise HostError("Bot collector is locked or lock path is unsafe") from None

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        # Never unlink the inode: doing so permits competing lock holders.


def process_identity(pid):
    """PID/start-time identity on Linux/Windows, or None when unavailable."""
    if os.name == "nt":
        from .windows_host import process_identity as windows_identity

        return windows_identity(pid)
    try:
        data = Path(f"/proc/{pid}/stat").read_text()
        fields = data[data.rfind(")") + 2 :].split()
        if fields[0] == "Z":
            return None
        return (pid, fields[19])
    except (OSError, IndexError, ValueError):
        return None
