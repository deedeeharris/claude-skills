"""Bounded Telegram Bot API transport. No automatic retries of ambiguous sends."""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import secrets
import stat
import tempfile
from http.client import HTTPException
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import validate_token

__all__ = [
    "MAX_DOWNLOAD_BYTES",
    "MAX_PHOTO_BYTES",
    "MAX_UPLOAD_BYTES",
    "Telegram",
    "TelegramError",
]
MAX_DOWNLOAD_BYTES = 20_000_000
MAX_UPLOAD_BYTES = 50_000_000
MAX_PHOTO_BYTES = 10_000_000
_API_ROOT = "https://api.telegram.org"
_API_RESPONSE_LIMIT = 8_000_000


class TelegramError(Exception):
    """Safe transport failure; code never contains an upstream description or URL."""

    def __init__(
        self,
        code: str | int,
        *,
        retry_after: int | None = None,
        ambiguous: bool = False,
    ):
        safe_codes = {
            "network",
            "response",
            "file",
            "size",
            "path",
            "method",
            "redirect",
            "parameters",
        }
        self.code = (
            code
            if type(code) is int
            and 400 <= code <= 599
            or isinstance(code, str)
            and code in safe_codes
            else "response"
        )
        self.retry_after = (
            retry_after if type(retry_after) is int and retry_after >= 0 else None
        )
        self.ambiguous = bool(ambiguous)
        super().__init__(
            f"Telegram request failed ({self.code})"
            + ("; delivery outcome is unknown" if self.ambiguous else "")
        )


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a token-bearing request to another location.
        return None


def _local_path(path: str | Path) -> Path:
    raw = Path(path)
    if ".." in raw.parts:
        raise TelegramError("path")
    result = raw.absolute()
    if any(p.is_symlink() for p in (result, *result.parents)):
        raise TelegramError("path")
    return result


class Telegram:
    def __init__(self, token: str, *, timeout: float = 35.0, opener: Any = None):
        self._token = validate_token(token)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 < timeout <= 120
        ):
            raise ValueError("Network timeout must be between 0 and 120 seconds")
        self.timeout = float(timeout)
        self._opener = opener if opener is not None else build_opener(_NoRedirects())

    def _multipart(
        self, params: dict[str, Any], files: dict[str, Path], method: str
    ) -> tuple[bytes, str]:
        photo_fields = set(files) if method == "sendPhoto" else set()
        media = params.get("media")
        if isinstance(media, str):
            try:
                media = json.loads(media)
            except ValueError:
                raise TelegramError("parameters") from None
        descriptors = media if isinstance(media, list) else [media]
        for descriptor in descriptors:
            if isinstance(descriptor, dict) and descriptor.get("type") == "photo":
                reference = descriptor.get("media")
                if isinstance(reference, str) and reference.startswith("attach://"):
                    photo_fields.add(reference[len("attach://") :])
        boundary = "tgbridge-" + secrets.token_hex(24)
        parts = []
        for name, value in params.items():
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_]+", name):
                raise TelegramError("parameters")
            value = (
                json.dumps(value, ensure_ascii=False)
                if not isinstance(value, str)
                else value
            )
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
                + value.encode()
                + b"\r\n"
            )
        for name, path in files.items():
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_]+", name):
                raise TelegramError("parameters")
            limit = MAX_PHOTO_BYTES if name in photo_fields else MAX_UPLOAD_BYTES
            try:
                path = _local_path(path)
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode):
                        raise TelegramError("file")
                    if info.st_size > limit:
                        raise TelegramError("size")
                    data = handle.read(limit + 1)
                if len(data) > limit:
                    raise TelegramError("size")
                filename = (
                    "".join(c for c in path.name if ord(c) >= 32 and c not in '\x7f"\\')
                    or "attachment"
                )
                mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                header = (
                    f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                    f"Content-Type: {mime}\r\n\r\n"
                ).encode()
                parts.append(header + data + b"\r\n")
            except (OSError, TypeError, ValueError):
                raise TelegramError("file") from None
        parts.append(f"--{boundary}--\r\n".encode())
        return b"".join(parts), "multipart/form-data; boundary=" + boundary

    @staticmethod
    def _result(payload: bytes, *, ambiguous: bool) -> Any:
        try:
            result = json.loads(payload)
        except (ValueError, UnicodeError):
            raise TelegramError("response", ambiguous=ambiguous) from None
        if not isinstance(result, dict) or type(result.get("ok")) is not bool:
            raise TelegramError("response", ambiguous=ambiguous)
        if not result["ok"]:
            code = result.get("error_code")
            if type(code) is not int or not 400 <= code <= 599:
                raise TelegramError("response", ambiguous=ambiguous)
            parameters = result.get("parameters")
            retry = (
                parameters.get("retry_after") if isinstance(parameters, dict) else None
            )
            raise TelegramError(code, retry_after=retry)
        if "result" not in result:
            raise TelegramError("response", ambiguous=ambiguous)
        return result["result"]

    def call(
        self, method: str, params: dict[str, Any], files: dict[str, Path] | None = None
    ) -> Any:
        if not isinstance(method, str) or not re.fullmatch(
            r"[A-Za-z][A-Za-z0-9]{0,63}", method
        ):
            raise TelegramError("method")
        # An unacknowledged mutating request may have reached Telegram.
        ambiguous = not method.startswith("get")
        try:
            if not isinstance(params, dict):
                raise TelegramError("parameters")
            if files:
                body, content_type = self._multipart(params, files, method)
            else:
                body = json.dumps(params, ensure_ascii=False).encode()
                content_type = "application/json"
        except (TypeError, ValueError, UnicodeError):
            raise TelegramError("parameters") from None
        request = Request(
            f"{_API_ROOT}/bot{self._token}/{method}",
            data=body,
            headers={"Content-Type": content_type},
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                payload = response.read(_API_RESPONSE_LIMIT + 1)
            if len(payload) > _API_RESPONSE_LIMIT:
                raise TelegramError("response", ambiguous=ambiguous)
            return self._result(payload, ambiguous=ambiguous)
        except HTTPError as error:
            code = error.code
            try:
                payload = error.read(_API_RESPONSE_LIMIT + 1)
            except (OSError, ValueError, HTTPException):
                payload = b""
            finally:
                error.close()
            # A redirect cannot establish that a mutating request was unapplied.
            # Ignore its body, and never forward the token-bearing request.
            if type(code) is int and 300 <= code <= 399:
                raise TelegramError("redirect", ambiguous=ambiguous) from None
            if type(code) is not int or not 400 <= code <= 599:
                raise TelegramError("response", ambiguous=ambiguous) from None
            try:
                return self._result(payload, ambiguous=ambiguous)
            except TelegramError as parsed:
                if type(parsed.code) is int:
                    raise parsed from None
            raise TelegramError(code, ambiguous=ambiguous and code >= 500) from None
        except (URLError, OSError, TimeoutError, HTTPException):
            raise TelegramError("network", ambiguous=ambiguous) from None

    def download(self, file_id: str, destination: str | Path) -> Path:
        """Atomically download up to 20 MB; existing files survive every failure."""
        temporary = None
        try:
            if not isinstance(file_id, str) or not file_id:
                raise TelegramError("parameters")
            destination = Path(destination)
            safe_destination = _local_path(destination)
            if not safe_destination.parent.is_dir() or (
                safe_destination.exists() and not safe_destination.is_file()
            ):
                raise TelegramError("path")
            metadata = self.call("getFile", {"file_id": file_id})
            if not isinstance(metadata, dict):
                raise TelegramError("response")
            size = metadata.get("file_size")
            if size is not None and (type(size) is not int or size < 0):
                raise TelegramError("response")
            if size is not None and size > MAX_DOWNLOAD_BYTES:
                raise TelegramError("size")
            file_path = metadata.get("file_path")
            if (
                not isinstance(file_path, str)
                or not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", file_path)
                or any(part in (".", "..") for part in file_path.split("/"))
            ):
                raise TelegramError("path")
            url = f"{_API_ROOT}/file/bot{self._token}/{file_path}"
            with self._opener.open(Request(url), timeout=self.timeout) as response:
                if response.geturl() != url:
                    raise TelegramError("redirect")
                content_length = response.headers.get("Content-Length")
                if content_length is not None:
                    try:
                        content_length = int(content_length)
                    except (ValueError, TypeError):
                        raise TelegramError("response") from None
                    if content_length < 0:
                        raise TelegramError("response")
                    if content_length > MAX_DOWNLOAD_BYTES:
                        raise TelegramError("size")
                fd, temporary = tempfile.mkstemp(
                    prefix=".download-", dir=safe_destination.parent
                )
                total = 0
                with os.fdopen(fd, "wb") as handle:
                    while True:
                        data = response.read(
                            min(65_536, MAX_DOWNLOAD_BYTES + 1 - total)
                        )
                        if not data:
                            break
                        total += len(data)
                        if total > MAX_DOWNLOAD_BYTES:
                            raise TelegramError("size")
                        handle.write(data)
                    if (size is not None and total != size) or (
                        content_length is not None and total != content_length
                    ):
                        raise TelegramError("response")
                    handle.flush()
                    os.fsync(handle.fileno())
            # Recheck because transfer time can be long; replacement never follows a final symlink.
            _local_path(safe_destination)
            os.replace(temporary, safe_destination)
            temporary = None
            return destination
        except HTTPError as error:
            code = error.code
            error.close()
            raise TelegramError("redirect" if 300 <= code < 400 else code) from None
        except (URLError, OSError, TimeoutError, HTTPException):
            raise TelegramError("network") from None
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)
