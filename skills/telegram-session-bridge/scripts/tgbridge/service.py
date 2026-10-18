"""Durable collector, canonical output publication and attachment preparation."""

from __future__ import annotations

import contextlib
import os
import stat
import tempfile
import threading
import time
import uuid
from pathlib import Path

from .formatting import render
from .host import CollectorLock, Host, process_identity
from .store import Store, StoreError
from .telegram import (
    MAX_DOWNLOAD_BYTES,
    MAX_PHOTO_BYTES,
    MAX_UPLOAD_BYTES,
    TelegramError,
)

__all__ = [
    "Service",
    "ServiceError",
    "prepare_request",
    "publish",
    "validate_binding",
    "validate_identity",
]


class ServiceError(ValueError):
    """Safe operational failure with no message contents or credentials."""


def validate_binding(config, store):
    """Check local session/owner identity without resolving credentials or networking."""
    binding = store.binding(config.binding_id)
    fields = ("session_id", "bot_id", "owner_chat_id", "owner_user_id")
    if (
        not binding
        or not binding["active"]
        or any(binding[field] != getattr(config, field) for field in fields)
    ):
        raise ServiceError("Configured and durable binding identity disagree")


def validate_identity(config, store, api):
    """Authenticate this resolved transport against the configured durable session.

    Run before any network use beyond getMe. No cached token-prefix inference:
    rotated credentials for the same bot are valid, a different bot is not.
    """
    validate_binding(config, store)
    bot = api.call("getMe", {})
    if (
        not isinstance(bot, dict)
        or type(bot.get("id")) is not int
        or bot.get("is_bot") is not True
    ):
        raise TelegramError("response")
    if bot["id"] != config.bot_id:
        raise ServiceError("Telegram credential identity does not match bound bot")


def _regular(path):
    try:
        path = Path(path)
        if ".." in path.parts or any(
            p.is_symlink() for p in (path.absolute(), *path.absolute().parents)
        ):
            raise ServiceError("Unsafe canonical artifact path")
        if not stat.S_ISREG(path.stat().st_mode):
            raise ServiceError("Canonical artifact must be an existing regular file")
        return path.absolute()
    except (OSError, TypeError, ValueError):
        raise ServiceError("Cannot read canonical artifact") from None


def _running(config, store, request_id):
    binding = store.binding(config.binding_id)
    request = store.request(config.binding_id, request_id)
    if (
        not binding
        or not binding["active"]
        or not request
        or request["state"] != "running"
        or request["generation"] != binding["generation"]
    ):
        raise StoreError("Request is not current running Telegram work")
    return request


def publish(
    config,
    store,
    request_id,
    *,
    source,
    kind,
    text_path=None,
    attachments=(),
    photos=(),
    mode="markdown",
):
    """Queue existing host-selected text/artifacts; call complete only after success.

    No model calls and no completion side effect. The host owns canonical capture.
    Store owns private file snapshots. Partial multi-item publication is inspectable
    in outbox; never blindly replay a crashed publication.
    """
    if source != "telegram" or kind not in {"progress", "final"}:
        raise ServiceError("Publish requires source telegram and kind progress/final")
    _running(config, store, request_id)
    text = _regular(text_path).read_bytes().decode("utf-8") if text_path else ""
    try:
        chunks = render(text, mode=mode) if text_path else []
    except ValueError:
        raise ServiceError(
            "Text cannot fit nonblank Telegram messages; send the exact bytes as a document."
        ) from None
    # Validate all local sources before queuing any output.
    files = [(_regular(path), False) for path in attachments]
    files += [(_regular(path), True) for path in photos]
    if not chunks and not files:
        raise ServiceError("Publish requires nonempty canonical text or an artifact")
    rows = []
    for chunk in chunks:
        rows.append(
            store.enqueue_output(
                config.binding_id,
                request_id,
                kind,
                {"text": chunk.text, "entities": chunk.entities},
            )
        )
    for path, photo in files:
        limit = MAX_PHOTO_BYTES if photo else MAX_UPLOAD_BYTES
        if path.stat().st_size > limit:
            rows.append(
                store.enqueue_output(
                    config.binding_id,
                    request_id,
                    "notice",
                    {
                        "text": f"Attachment is too large for Telegram ({limit // 1_000_000} MB limit). "
                        "The original file remains on the host; no file was split."
                    },
                )
            )
        else:
            rows.append(
                store.enqueue_output(
                    config.binding_id,
                    request_id,
                    "photo" if photo else kind,
                    {"path": path, "name": path.name},
                )
            )
    return rows


def prepare_request(config, store, request, api):
    """Validate and download after claim; failures retain the claim for reconciliation."""
    validate_binding(config, store)
    _running(config, store, request["request_id"])
    result = {
        **request,
        "source": "telegram",
        "session_id": config.session_id,
        "attachments": [],
    }
    root = config.private_state_dir / "attachments"
    if request["attachments"]:
        validate_identity(config, store, api)
        _running(config, store, request["request_id"])
        root.mkdir(mode=0o700, exist_ok=True)
        info = root.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
        ):
            raise ServiceError("Unsafe attachment directory")
    for metadata in request["attachments"]:
        attachment = dict(metadata)
        try:
            if metadata["size"] is not None and metadata["size"] > MAX_DOWNLOAD_BYTES:
                raise TelegramError("size")
            destination = root / f"incoming-{uuid.uuid4().hex}"
            attachment["path"] = str(api.download(metadata["file_id"], destination))
        except TelegramError as exc:
            attachment["error"] = exc.code
            notice = (
                "Incoming attachment exceeds the hosted Telegram 20 MB download limit. "
                "The file was not split."
                if exc.code == "size"
                else "Incoming attachment could not be downloaded. Its metadata remains with the request."
            )
            store.enqueue_output(
                config.binding_id, request["request_id"], "notice", {"text": notice}
            )
        result["attachments"].append(attachment)
    _running(config, store, request["request_id"])
    return result


class Service:
    def __init__(self, config, store, api, *, host=None):
        self.config, self.store, self.api = config, store, api
        self.host = (
            host
            if host is not None
            else Host(config.host_command, config.binding_id, config.session_id)
        )
        self.binding_id = config.binding_id
        self._canceled = []
        self._notify_generation = None
        self._notify_satisfied = False
        self._notify_failures = 0
        self._notify_at = 0.0

    def _notify_pending(self, *, fresh=False):
        """Reconcile wake-ups only; durable claims remain the sole task ownership."""
        state = self.store.status(self.binding_id)
        binding = state["binding"]
        if not binding["active"] or not state["requests"].get("pending"):
            self._notify_generation = None
            return
        if self._notify_generation != binding["generation"]:
            self._notify_generation = binding["generation"]
            self._notify_satisfied = False
            self._notify_failures = 0
            self._notify_at = 0.0
        elif fresh and self._notify_satisfied:
            self._notify_satisfied = False
        now = time.monotonic()
        if self._notify_satisfied or now < self._notify_at:
            return
        result = self.host.send("notify", generation=binding["generation"])
        if result.get("status") == "accepted" or result.get("reason") == "unconfigured":
            self._notify_satisfied = True
            self._notify_failures = 0
        else:
            self._notify_failures = min(self._notify_failures + 1, 7)
            self._notify_at = time.monotonic() + min(
                2 ** (self._notify_failures - 1), 60
            )

    def _current(self, generation):
        binding = self.store.binding(self.binding_id)
        return bool(
            binding and binding["active"] and binding["generation"] == generation
        )

    def _notice(self, text, generation):
        if self._current(generation):
            try:
                self.store.enqueue_output(
                    self.binding_id,
                    None,
                    "notice",
                    {"text": text},
                    expected_generation=generation,
                )
            except StoreError:
                if self._current(generation):
                    raise

    def control_one(self):
        control = self.store.next_control(self.binding_id)
        if control is None:
            return
        generation = control["generation"]
        if not self._current(generation):
            return
        kind = control["kind"]
        if kind in {"interrupt", "stop"}:
            canceled = []
            if kind == "stop":
                # A recovered control may see newer running work. IDs are only
                # hints; retain canceled requests strictly before its boundary.
                for request_id in self._canceled:
                    request = self.store.request(self.binding_id, request_id)
                    if (
                        request
                        and request["generation"] < generation
                        and request["state"] == "canceled"
                    ):
                        canceled.append(request_id)
            result = self.host.send(
                kind,
                request_id=control["request_id"],
                generation=generation,
                text=control["text"],
                canceled_request_ids=canceled,
            )
            if kind == "interrupt":
                text = (
                    "Native interrupt acknowledged; priority request awaits explicit claim."
                    if result["status"] == "accepted"
                    else "Native interrupt unavailable or unconfirmed; request queued with priority."
                )
            else:
                text = (
                    "Pending work cleared; native cancellation acknowledged. Relay remains active."
                    if result["status"] == "accepted"
                    else "Pending work cleared. Active host cancellation is not confirmed. Relay remains active."
                )
        elif kind == "help":
            text = "Send a request, /interrupt <request> for priority, /stop to clear work, or /status."
        else:
            state = self.store.status(self.binding_id)
            text = f"Relay active. Requests: {state['requests']}. Native integration remains live-unverified."
        self._notice(text, generation)
        # A concurrent stop may have invalidated this running control.
        if self._current(generation):
            self.store.finish_control(control["id"])

    def step(self, *, drain=True):
        """Low-level cycle; caller owns bot lock and must validate this API identity.

        Production callers use run, which authenticates before polling/sending.
        """
        binding = self.store.binding(self.binding_id)
        if not binding or not binding["active"]:
            return False
        updates = self.api.call(
            "getUpdates",
            {"offset": binding["offset"], "timeout": 1, "allowed_updates": ["message"]},
        )
        if not isinstance(updates, list):
            raise TelegramError("response")
        self._canceled = self.store.status(self.binding_id)["running_requests"]
        try:
            self.store.receive(self.binding_id, updates)
        except StoreError:
            current = self.store.binding(self.binding_id)
            if current and not current["active"]:
                return False
            raise
        self.control_one()
        fresh = False
        for update in updates:
            uid = update.get("update_id") if isinstance(update, dict) else None
            if type(uid) is not int or uid < binding["offset"]:
                continue
            request = self.store.request(self.binding_id, uid)
            if request and request["state"] == "pending":
                fresh = True
                break
        self._notify_pending(fresh=fresh)
        if drain:
            self.drain_one()
        return True

    def drain_one(self):
        """Low-level send; caller owns bot lock and has validated this API identity."""
        output = self.store.next_output(self.binding_id)
        if output is None:
            return
        payload = output["payload"]
        params = {"chat_id": self.config.owner_chat_id}
        files = None
        if "path" in payload:
            photo = output["kind"] == "photo"
            field = "photo" if photo else "document"
            method = "sendPhoto" if photo else "sendDocument"
            files = {field: Path(payload["path"])}
            params.update(
                {k: payload[k] for k in ("caption", "caption_entities") if k in payload}
            )
        else:
            method = "sendMessage"
            params.update({k: payload[k] for k in ("text", "entities") if k in payload})
        try:
            with contextlib.ExitStack() as cleanup:
                if files:
                    directory = cleanup.enter_context(
                        tempfile.TemporaryDirectory(
                            prefix=".send-", dir=self.config.private_state_dir
                        )
                    )
                    name = (
                        str(payload.get("name") or "attachment")
                        .replace("\\", "/")
                        .rsplit("/", 1)[-1]
                    )
                    name = "".join(c for c in name if ord(c) >= 32 and c != chr(127))
                    if name in {"", ".", ".."}:
                        name = "attachment"
                    if len(name.encode()) > 240:
                        suffix = Path(name).suffix
                        if len(suffix.encode()) > 32:
                            suffix = ""
                        stem = name[: -len(suffix)] if suffix else name
                        name = (
                            stem.encode()[: 240 - len(suffix.encode())].decode(
                                "utf-8", errors="ignore"
                            )
                            + suffix
                        )
                    alias = Path(directory) / name
                    try:
                        os.link(payload["path"], alias, follow_symlinks=False)
                    except OSError:
                        raise TelegramError("file") from None
                    files = {field: alias}
                response = self.api.call(method, params, files=files)
            mid = response.get("message_id") if isinstance(response, dict) else None
            if type(mid) is not int or mid <= 0:
                raise TelegramError("response", ambiguous=True)
            self.store.finish_output(output["id"], "sent", message_id=mid)
        except TelegramError as exc:
            if exc.ambiguous or exc.code in {"network", "response"}:
                self.store.finish_output(output["id"], "ambiguous", error_code=exc.code)
            elif exc.code == 429:
                try:
                    self.store.finish_output(
                        output["id"],
                        "queued",
                        error_code=429,
                        retry_at=time.time() + max(1, exc.retry_after or 1),
                    )
                except StoreError:
                    if self._current(output["generation"]):
                        raise
                    # A stop/unbind happened during the rejected send. This known
                    # non-delivery can be discarded, but must never enter a new generation.
                    self.store.finish_output(output["id"], "failed", error_code=429)
                    self.store.finish_output(output["id"], "canceled")
            else:
                self.store.finish_output(output["id"], "failed", error_code=exc.code)
                if exc.code == "size" or exc.code == 413:
                    # A rejected file must not block its own explanatory notice.
                    self.store.finish_output(output["id"], "canceled")
                    self._notice(
                        "Attachment is too large for Telegram. Original bytes remain on the host; no file was split.",
                        output["generation"],
                    )
                if exc.code in {401, 409}:
                    raise ServiceError(
                        f"Telegram collector stopped ({exc.code})"
                    ) from None

    def run(self, stop_event=None):
        """Foreground loop: the invoking host MUST own this job's session lifetime."""
        stop = stop_event if stop_event is not None else threading.Event()
        identity = (
            process_identity(self.config.owner_pid) if self.config.owner_pid else None
        )
        if self.config.owner_pid and identity is None:
            raise ServiceError(
                "Owner process identity is unavailable; use a host-owned session job"
            )

        def alive():
            binding = self.store.binding(self.binding_id)
            if (
                stop.is_set()
                or not binding
                or not binding["active"]
                or (
                    identity is not None
                    and process_identity(self.config.owner_pid) != identity
                )
            ):
                stop.set()
                return False
            return True

        with CollectorLock(self.config.bot_id):
            failures = 0
            authenticated = False
            while alive():
                try:
                    if not authenticated:
                        validate_identity(self.config, self.store, self.api)
                        authenticated = True
                    if not alive():
                        return
                    webhook = self.api.call("getWebhookInfo", {})
                    if not isinstance(webhook, dict) or not isinstance(
                        webhook.get("url"), str
                    ):
                        raise TelegramError("response")
                    if webhook["url"]:
                        raise ServiceError(
                            "Existing webhook refused; no webhook was deleted"
                        )
                    break
                except TelegramError as exc:
                    failures += 1
                    self._read_retry(exc, failures, stop, alive=alive)
            if not alive():
                return
            self.store.recover_outbox(self.binding_id)
            self._notify_pending()
            sender_errors = []

            def send_loop():
                try:
                    # SQLite connections belong to the creating thread. The lock
                    # remains held until this worker has fully stopped.
                    with Store(self.store.path) as outgoing:
                        sender = Service(
                            self.config, outgoing, self.api, host=self.host
                        )
                        while not stop.is_set():
                            current = outgoing.binding(self.binding_id)
                            if not current or not current["active"]:
                                break
                            sender.drain_one()
                            stop.wait(0.05)
                except Exception:  # noqa: BLE001 - redact all worker-boundary failures
                    # Never propagate transport/OS exception text from a worker.
                    sender_errors.append(True)
                    stop.set()

            sender = threading.Thread(target=send_loop, name="tgbridge-outbox")
            sender.start()
            try:
                failures = 0
                while alive():
                    try:
                        if not self.step(drain=False):
                            break
                        failures = 0
                    except TelegramError as exc:
                        failures += 1
                        self._read_retry(
                            exc,
                            failures,
                            stop,
                            alive=alive,
                            on_wait=self._notify_pending,
                        )
                    # Avoid tight loops if Telegram immediately returns an empty batch.
                    stop.wait(0.05)
            finally:
                stop.set()
                # Do not unlock while an old sender may still transmit. The host
                # supervisor may terminate the process if its shutdown grace expires;
                # next startup then classifies any sending row as ambiguous.
                sender.join()
            if sender_errors:
                raise ServiceError(
                    "Outbox sender stopped; inspect durable outbox state"
                )

    @staticmethod
    def _read_retry(exc, failures, stop, *, alive=None, on_wait=None):
        if exc.code in {401, 409}:
            raise ServiceError(f"Telegram collector stopped ({exc.code})") from None
        if exc.code not in {
            "network",
            "response",
            429,
            500,
            502,
            503,
            504,
        }:
            raise ServiceError("Telegram read rejected") from None
        delay = (
            max(1, exc.retry_after or 1)
            if exc.code == 429
            else min(2 ** min(max(0, failures - 1), 6), 60)
        )
        if alive is None:
            stop.wait(delay)
            return
        # Recheck actual ownership and binding during long outages, including
        # startup. No model or control action runs in this interruptible wait.
        while delay > 0 and alive():
            if on_wait:
                on_wait()
            interval = min(0.25, delay)
            if stop.wait(interval):
                return
            delay -= interval
