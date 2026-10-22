"""Validated private configuration. Secret values are never included in errors."""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass, field, fields
from pathlib import Path

from .privatefs import (
    check_private,
    open_nofollow,
    private_directory,
    safe_path,
    sync_directory,
)

__all__ = ["Config", "ConfigError", "validate_token"]


class ConfigError(ValueError):
    """Invalid configuration, credentials or private storage."""


def validate_token(token: str) -> str:
    if not isinstance(token, str) or not re.fullmatch(
        r"[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,100}", token
    ):
        raise ConfigError("Invalid Telegram bot credentials")
    return token


def _safe_path(path: str | Path) -> Path:
    return safe_path(path)


def _private_parent(path: Path, *, create: bool) -> None:
    if create:
        private_directory(path.parent)
    check_private(path.parent, directory=True)


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError("Duplicate configuration field")
        result[key] = value
    return result


@dataclass
class Config:
    version: int
    binding_id: str
    session_id: str
    bot_id: int
    bot_username: str
    owner_chat_id: int
    owner_user_id: int
    token_env: str | None = None
    token: str | None = field(default=None, repr=False)
    host_command: list[str] = field(default_factory=list)
    owner_pid: int | None = None
    _path: Path | None = field(default=None, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        self._validate()

    def _validate(self) -> None:
        if type(self.version) is not int or self.version != 1:
            raise ConfigError("Unsupported configuration version")
        for value in (self.binding_id, self.session_id):
            if not isinstance(value, str) or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", value
            ):
                raise ConfigError("Invalid binding or session identifier")
        for value in (self.bot_id, self.owner_chat_id, self.owner_user_id):
            if type(value) is not int or not 0 < value < 2**63:
                raise ConfigError("Invalid bot or owner identifier")
        if not isinstance(self.bot_username, str) or not re.fullmatch(
            r"[A-Za-z][A-Za-z0-9_]{4,31}", self.bot_username
        ):
            raise ConfigError("Invalid bot username")
        if (self.token_env is None) == (self.token is None):
            raise ConfigError("Exactly one token source is required")
        if self.token_env is not None:
            if not isinstance(self.token_env, str) or not re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", self.token_env
            ):
                raise ConfigError("Invalid token environment variable name")
        else:
            validate_token(self.token)
        if not isinstance(self.host_command, list) or any(
            not isinstance(arg, str) or not arg or any(ord(c) < 32 for c in arg)
            for arg in self.host_command
        ):
            raise ConfigError("Host command must be an argument vector")
        if self.owner_pid is not None and (
            type(self.owner_pid) is not int or self.owner_pid <= 0
        ):
            raise ConfigError("Invalid owner process identifier")

    @property
    def private_state_dir(self) -> Path:
        if self._path is None:
            raise ConfigError("Configuration has not been loaded or saved")
        return self._path.parent

    def resolve_token(self) -> str:
        self._validate()
        return validate_token(
            os.environ.get(self.token_env, "")
            if self.token_env is not None
            else self.token
        )

    @classmethod
    def load(cls, path: str | Path) -> Config:
        try:
            path = _safe_path(path)
            _private_parent(path, create=False)
            fd = open_nofollow(path, os.O_RDONLY)
            with os.fdopen(fd, "r", encoding="utf-8") as handle:
                info = os.fstat(handle.fileno())
                check_private(path, fd=handle.fileno())
                if info.st_size > 65_536:
                    raise ConfigError("Configuration is too large")
                raw = json.load(handle, object_pairs_hook=_unique_object)
            allowed = {f.name for f in fields(cls) if f.init}
            if not isinstance(raw, dict) or set(raw) - allowed:
                raise ConfigError("Malformed configuration")
            cfg = cls(**raw)
            cfg._path = path
            return cfg
        except (OSError, ValueError, TypeError):
            raise ConfigError("Cannot load private configuration") from None

    def save(self, path: str | Path) -> None:
        self._validate()
        temporary = None
        try:
            path = _safe_path(path)
            _private_parent(path, create=True)
            if path.exists() and not path.is_file():
                raise ConfigError("Configuration path must be a regular file")
            raw = {
                f.name: getattr(self, f.name)
                for f in fields(self)
                if f.init and getattr(self, f.name) is not None
            }
            # Preserve nullable schema fields while omitting the unused token source.
            raw["owner_pid"] = self.owner_pid
            fd, temporary = tempfile.mkstemp(prefix=".config-", dir=path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(raw, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            temporary = None
            sync_directory(path.parent)
            self._path = path
        except (OSError, ValueError, TypeError):
            raise ConfigError("Cannot save private configuration") from None
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)
