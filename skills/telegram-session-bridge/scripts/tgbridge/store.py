"""Private transactional inbox/outbox. Recovery requires the collector's lock.

Opening a Store never replays host work or reclassifies a live sender. Each
thread/process must use its own connection. Explicit retry can duplicate a send.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from .messages import authorized_message, parse_message
from .privatefs import (
    check_private,
    open_nofollow,
    private_directory,
    readonly_snapshot,
    safe_path,
    sync_directory,
)

__all__ = ["Store", "StoreError"]


class StoreError(ValueError):
    """Invalid state transition, identity, or private storage."""


def _integer(value, *, minimum=0):
    if type(value) is not int or not minimum <= value < 2**63 - 1:
        raise StoreError("Invalid integer identifier")
    return value


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", value
    ):
        raise StoreError("Invalid binding or session identifier")
    return value


def _path(value):
    if not isinstance(value, (str, Path)):
        raise StoreError("Invalid private path")
    try:
        return safe_path(value)
    except (OSError, TypeError, ValueError):
        raise StoreError("Unsafe private path") from None


def _private(path, *, directory=False):
    try:
        check_private(path, directory=directory)
    except (OSError, TypeError, ValueError):
        raise StoreError("Storage must be privately owned") from None


class Store:
    def __init__(self, path):
        self._conn = None
        try:
            self.path = _path(path)
            private_directory(self.path.parent)
            _private(self.path.parent, directory=True)
            fd = open_nofollow(self.path, os.O_CREAT | os.O_RDWR)
            os.close(fd)
            _private(self.path)
            # Rollback journals live beside the database in its private directory.
            self._conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.execute("PRAGMA synchronous=FULL")
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS bindings (
                    binding_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    bot_id INTEGER NOT NULL, owner_chat_id INTEGER NOT NULL,
                    owner_user_id INTEGER NOT NULL, bot_username TEXT NOT NULL,
                    offset INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
                    generation INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS active_bot ON bindings(bot_id) WHERE active=1;
                CREATE TABLE IF NOT EXISTS requests (
                    binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
                    request_id INTEGER NOT NULL, generation INTEGER NOT NULL,
                    kind TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL,
                    priority INTEGER NOT NULL, state TEXT NOT NULL,
                    PRIMARY KEY(binding_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS controls (
                    id INTEGER PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
                    request_id INTEGER NOT NULL, generation INTEGER NOT NULL,
                    kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
                    UNIQUE(binding_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS outbox (
                    id INTEGER PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
                    request_id INTEGER, generation INTEGER NOT NULL, kind TEXT NOT NULL,
                    chat_id INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
                    message_id INTEGER, error_code TEXT, retry_at REAL
                );
            """)
        except (OSError, ValueError, TypeError, sqlite3.Error):
            self.close()
            raise StoreError("Cannot open private state") from None

    def close(self):
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @contextmanager
    def _transaction(self):
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self._conn.execute("COMMIT")
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise

    @staticmethod
    def _decode(row):
        if row is None:
            return None
        result = dict(row)
        for key in ("attachments", "payload"):
            if key in result:
                result[key] = json.loads(result[key])
        if "active" in result:
            result["active"] = bool(result["active"])
        if (
            "error_code" in result
            and result["error_code"] is not None
            and result["error_code"].isdigit()
        ):
            result["error_code"] = int(result["error_code"])
        return result

    def binding(self, binding_id):
        _identifier(binding_id)
        return self._decode(
            self._conn.execute(
                "SELECT * FROM bindings WHERE binding_id=?", (binding_id,)
            ).fetchone()
        )

    def _binding(self, binding_id, *, active=True):
        binding = self.binding(binding_id)
        if binding is None or (active and not binding["active"]):
            raise StoreError("Binding is unavailable")
        return binding

    def bind(
        self,
        binding_id,
        session_id,
        bot_id,
        chat_id,
        user_id,
        initial_offset=0,
        bot_username="",
    ):
        _identifier(binding_id)
        _identifier(session_id)
        for value in (bot_id, chat_id, user_id):
            _integer(value, minimum=1)
        _integer(initial_offset)
        if not isinstance(bot_username, str) or (
            bot_username
            and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", bot_username)
        ):
            raise StoreError("Invalid bot username")
        with self._transaction():
            old = self.binding(binding_id)
            identity = (session_id, bot_id, chat_id, user_id, bot_username)
            if old is not None:
                if not old["active"] or identity != tuple(
                    old[key]
                    for key in (
                        "session_id",
                        "bot_id",
                        "owner_chat_id",
                        "owner_user_id",
                        "bot_username",
                    )
                ):
                    raise StoreError("Binding identity cannot change")
                return old
            if self._conn.execute(
                "SELECT 1 FROM bindings WHERE bot_id=? AND active=1", (bot_id,)
            ).fetchone():
                raise StoreError("Bot already has an active binding")
            self._conn.execute(
                "INSERT INTO bindings(binding_id,session_id,bot_id,owner_chat_id,owner_user_id,bot_username,offset) VALUES(?,?,?,?,?,?,?)",
                (binding_id, *identity, initial_offset),
            )
            return self.binding(binding_id)

    def _cancel_generation(self, binding_id):
        self._conn.execute(
            "UPDATE requests SET state='canceled' WHERE binding_id=? AND state IN ('pending','running')",
            (binding_id,),
        )
        self._conn.execute(
            "UPDATE outbox SET state='canceled' WHERE binding_id=? AND state IN ('queued','failed')",
            (binding_id,),
        )
        self._conn.execute(
            "UPDATE controls SET state='canceled' WHERE binding_id=? AND state='pending'",
            (binding_id,),
        )
        self._conn.execute(
            "UPDATE bindings SET generation=generation+1 WHERE binding_id=?",
            (binding_id,),
        )

    def unbind(self, binding_id):
        with self._transaction():
            self._binding(binding_id)
            self._cancel_generation(binding_id)
            self._conn.execute(
                "UPDATE bindings SET active=0 WHERE binding_id=?", (binding_id,)
            )
            return self.binding(binding_id)

    def receive(self, binding_id, updates):
        with self._transaction():
            binding = self._binding(binding_id)
            offset = binding["offset"]
            # Telegram batches are processed in canonical update order, including
            # stop boundaries, even if a caller supplies an unsorted batch.
            valid = [
                u
                for u in updates
                if isinstance(u, dict)
                and type(u.get("update_id")) is int
                and 0 <= u["update_id"] < 2**63 - 1
            ]
            for update in sorted(valid, key=lambda u: u["update_id"]):
                uid = update["update_id"]
                if uid < offset:
                    continue
                offset = uid + 1
                message = authorized_message(
                    update, binding["owner_chat_id"], binding["owner_user_id"]
                )
                normalized = (
                    parse_message(message, binding["bot_username"])
                    if message is not None
                    else None
                )
                if normalized is None:
                    continue
                kind = normalized["kind"]
                if kind == "stop":
                    self._cancel_generation(binding_id)
                    binding = self._binding(binding_id)
                generation = binding["generation"]
                if kind in ("task", "interrupt"):
                    self._conn.execute(
                        "INSERT INTO requests VALUES(?,?,?,?,?,?,?,?)",
                        (
                            binding_id,
                            uid,
                            generation,
                            kind,
                            normalized["text"],
                            json.dumps(normalized["attachments"], ensure_ascii=False),
                            int(kind == "interrupt"),
                            "pending",
                        ),
                    )
                if kind != "task":
                    self._conn.execute(
                        "INSERT INTO controls(binding_id,request_id,generation,kind,text,state) VALUES(?,?,?,?,?,'pending')",
                        (binding_id, uid, generation, kind, normalized["text"]),
                    )
            self._conn.execute(
                "UPDATE bindings SET offset=? WHERE binding_id=?", (offset, binding_id)
            )
            return self.binding(binding_id)

    def request(self, binding_id, request_id):
        _identifier(binding_id)
        _integer(request_id)
        return self._decode(
            self._conn.execute(
                "SELECT * FROM requests WHERE binding_id=? AND request_id=?",
                (binding_id, request_id),
            ).fetchone()
        )

    def claim(self, binding_id):
        with self._transaction():
            binding = self._binding(binding_id, active=False)
            if not binding["active"]:
                return None
            row = self._conn.execute(
                "SELECT * FROM requests WHERE binding_id=? AND generation=? AND state='pending' ORDER BY priority DESC, request_id LIMIT 1",
                (binding_id, binding["generation"]),
            ).fetchone()
            if row is None:
                return None
            self._conn.execute(
                "UPDATE requests SET state='running' WHERE binding_id=? AND request_id=?",
                (binding_id, row["request_id"]),
            )
            return self.request(binding_id, row["request_id"])

    def _running(self, binding_id, request_id):
        binding = self._binding(binding_id)
        request = self.request(binding_id, request_id)
        if (
            request is None
            or request["state"] != "running"
            or request["generation"] != binding["generation"]
        ):
            raise StoreError("Request is not current running Telegram work")
        return request

    def complete(self, binding_id, request_id):
        return self._change_request(binding_id, request_id, "completed")

    def recover(self, binding_id, request_id):
        """Explicit operator action after verifying old host work has stopped."""
        return self._change_request(binding_id, request_id, "pending")

    def _change_request(self, binding_id, request_id, state):
        with self._transaction():
            self._running(binding_id, request_id)
            self._conn.execute(
                "UPDATE requests SET state=? WHERE binding_id=? AND request_id=?",
                (state, binding_id, request_id),
            )
            return self.request(binding_id, request_id)

    def next_control(self, binding_id):
        with self._transaction():
            binding = self._binding(binding_id, active=False)
            if not binding["active"]:
                return None
            row = self._conn.execute(
                "SELECT * FROM controls WHERE binding_id=? AND generation=? AND state='pending' ORDER BY id LIMIT 1",
                (binding_id, binding["generation"]),
            ).fetchone()
            if row is None:
                return None
            self._conn.execute(
                "UPDATE controls SET state='running' WHERE id=?", (row["id"],)
            )
            return self._decode(
                self._conn.execute(
                    "SELECT * FROM controls WHERE id=?", (row["id"],)
                ).fetchone()
            )

    def finish_control(self, control_id):
        return self._change_control(control_id, "done")

    def recover_control(self, control_id):
        """Explicitly requeue a control only after checking the old host action."""
        return self._change_control(control_id, "pending")

    def _change_control(self, control_id, state):
        _integer(control_id, minimum=1)
        with self._transaction():
            row = self._conn.execute(
                "SELECT * FROM controls WHERE id=?", (control_id,)
            ).fetchone()
            if row is None or row["state"] != "running":
                raise StoreError("Control is not running")
            if state == "pending":
                binding = self._binding(row["binding_id"])
                if row["generation"] != binding["generation"]:
                    raise StoreError("Control generation is stale")
            self._conn.execute(
                "UPDATE controls SET state=? WHERE id=?", (state, control_id)
            )
            return self._decode(
                self._conn.execute(
                    "SELECT * FROM controls WHERE id=?", (control_id,)
                ).fetchone()
            )

    def _snapshot(self, source):
        destination = None
        try:
            source = _path(source)
            directory = _path(self.path.parent / "outbox")
            private_directory(directory, parents=False)
            _private(directory, directory=True)
            fd = open_nofollow(source, os.O_RDONLY)
            with os.fdopen(fd, "rb") as original:
                if not stat.S_ISREG(os.fstat(original.fileno()).st_mode):
                    raise StoreError("Attachment must be a regular file")
                out_fd, name = tempfile.mkstemp(prefix="snapshot-", dir=directory)
                destination = Path(name)
                with os.fdopen(out_fd, "wb") as snapshot:
                    shutil.copyfileobj(original, snapshot)
                    snapshot.flush()
                    os.fsync(snapshot.fileno())
                    readonly_snapshot(snapshot.fileno())
            sync_directory(directory)
            return destination
        except (OSError, ValueError, TypeError):
            if destination is not None:
                destination.unlink(missing_ok=True)
            raise StoreError("Cannot preserve attachment snapshot") from None

    def enqueue_output(
        self, binding_id, request_id, kind, payload, *, expected_generation=None
    ):
        snapshot = None
        try:
            with self._transaction():
                binding = self._binding(binding_id)
                if expected_generation is not None:
                    _integer(expected_generation)
                    if expected_generation != binding["generation"]:
                        raise StoreError("Output generation is stale")
                if request_id is None:
                    if (
                        kind != "notice"
                        or not isinstance(payload, dict)
                        or "text" not in payload
                        or set(payload) - {"text", "entities", "chat_id"}
                    ):
                        raise StoreError("Request-less output must be a text notice")
                else:
                    self._running(binding_id, request_id)
                if kind not in (
                    "progress",
                    "final",
                    "notice",
                    "text",
                    "document",
                    "photo",
                    "file",
                ):
                    raise StoreError("Invalid output kind")
                allowed = {
                    "text",
                    "entities",
                    "path",
                    "name",
                    "mime_type",
                    "caption",
                    "caption_entities",
                    "chat_id",
                }
                if (
                    not isinstance(payload, dict)
                    or set(payload) - allowed
                    or not ("text" in payload or "path" in payload)
                ):
                    raise StoreError("Invalid output payload")
                if "chat_id" in payload and (
                    type(payload["chat_id"]) is not int
                    or payload["chat_id"] != binding["owner_chat_id"]
                ):
                    raise StoreError("Output destination is fixed")
                # JSON copy prevents callers mutating persisted canonical content.
                raw = dict(payload)
                for key in ("text", "name", "mime_type", "caption"):
                    if key in raw and not isinstance(raw[key], str):
                        raise StoreError("Invalid output text")
                for key in ("entities", "caption_entities"):
                    if key in raw and not isinstance(raw[key], list):
                        raise StoreError("Invalid output entities")
                if "path" in raw:
                    snapshot = self._snapshot(raw["path"])
                    raw["path"] = str(snapshot)
                raw["chat_id"] = binding["owner_chat_id"]
                try:
                    encoded = json.dumps(raw, ensure_ascii=False, allow_nan=False)
                except (ValueError, TypeError):
                    raise StoreError("Invalid output payload") from None
                cursor = self._conn.execute(
                    "INSERT INTO outbox(binding_id,request_id,generation,kind,chat_id,payload,state) VALUES(?,?,?,?,?,?,'queued')",
                    (
                        binding_id,
                        request_id,
                        binding["generation"],
                        kind,
                        binding["owner_chat_id"],
                        encoded,
                    ),
                )
                return self._output(cursor.lastrowid)
        except BaseException:
            if snapshot is not None:
                snapshot.unlink(missing_ok=True)
            raise

    def _output(self, output_id):
        _integer(output_id, minimum=1)
        row = self._conn.execute(
            "SELECT * FROM outbox WHERE id=?", (output_id,)
        ).fetchone()
        if row is None:
            raise StoreError("Unknown output")
        return self._decode(row)

    def outputs(self, binding_id):
        self._binding(binding_id, active=False)
        return [
            self._decode(row)
            for row in self._conn.execute(
                "SELECT * FROM outbox WHERE binding_id=? ORDER BY id", (binding_id,)
            )
        ]

    def next_output(self, binding_id):
        with self._transaction():
            binding = self._binding(binding_id, active=False)
            if not binding["active"]:
                return None
            row = self._conn.execute(
                "SELECT * FROM outbox WHERE binding_id=? AND generation=? AND state NOT IN ('sent','canceled') ORDER BY id LIMIT 1",
                (binding_id, binding["generation"]),
            ).fetchone()
            if (
                row is None
                or row["state"] != "queued"
                or (row["retry_at"] is not None and row["retry_at"] > time.time())
            ):
                return None
            self._conn.execute(
                "UPDATE outbox SET state='sending' WHERE id=?", (row["id"],)
            )
            return self._output(row["id"])

    def finish_output(self, output_id, state, **metadata):
        transitions = {
            "sending": {"sent", "ambiguous", "failed", "queued"},
            "ambiguous": {"sent", "canceled"},
            "failed": {"canceled"},
            "queued": {"canceled"},
        }
        if set(metadata) - {"message_id", "error_code", "retry_at"}:
            raise StoreError("Unknown output metadata")
        if "message_id" in metadata:
            _integer(metadata["message_id"], minimum=1)
        if "error_code" in metadata:
            code = metadata["error_code"]
            if not (
                (type(code) is int and 400 <= code <= 599)
                or (
                    isinstance(code, str)
                    and code
                    in {
                        "network",
                        "response",
                        "file",
                        "size",
                        "path",
                        "method",
                        "redirect",
                        "parameters",
                    }
                )
            ):
                raise StoreError("Unsafe output error code")
        if "retry_at" in metadata:
            value = metadata["retry_at"]
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise StoreError("Invalid retry time")
        if (
            ("message_id" in metadata and state != "sent")
            or ("error_code" in metadata and state == "sent")
            or ("retry_at" in metadata and state != "queued")
        ):
            raise StoreError("Metadata does not match output state")
        if state == "failed" and metadata.get("error_code") in (
            None,
            "network",
            "response",
        ):
            raise StoreError("Uncertain sends must remain ambiguous")
        with self._transaction():
            row = self._output(output_id)
            if state not in transitions.get(row["state"], set()):
                raise StoreError("Invalid output state transition")
            if state == "queued" and (
                metadata.get("error_code") != 429
                or metadata.get("retry_at", 0) <= time.time()
            ):
                raise StoreError("Only a definite 429 may schedule automatic retry")
            if state == "queued":
                binding = self._binding(row["binding_id"])
                if row["generation"] != binding["generation"]:
                    raise StoreError("Output generation is stale")
            self._conn.execute(
                "UPDATE outbox SET state=?,message_id=?,error_code=?,retry_at=? WHERE id=?",
                (
                    state,
                    metadata.get("message_id"),
                    metadata.get("error_code"),
                    metadata.get("retry_at"),
                    output_id,
                ),
            )
            return self._output(output_id)

    def retry_output(self, output_id, *, ack_duplicate_risk=False):
        """Atomically require explicit acknowledgment before retrying ambiguity."""
        if type(ack_duplicate_risk) is not bool:
            raise StoreError("Duplicate-risk acknowledgment must be boolean")
        with self._transaction():
            row = self._output(output_id)
            binding = self._binding(row["binding_id"])
            if row["generation"] != binding["generation"] or row["state"] not in (
                "ambiguous",
                "failed",
                "queued",
            ):
                raise StoreError("Output cannot be retried")
            if row["state"] == "ambiguous" and not ack_duplicate_risk:
                raise StoreError(
                    "Retry can duplicate delivery; use --ack-duplicate-risk after review"
                )
            self._conn.execute(
                "UPDATE outbox SET state='queued',error_code=NULL,retry_at=NULL WHERE id=?",
                (output_id,),
            )
            return self._output(output_id)

    def recover_outbox(self, binding_id):
        """Caller MUST hold its single collector lock and exclude live senders."""
        with self._transaction():
            self._binding(binding_id, active=False)
            self._conn.execute(
                "UPDATE outbox SET state='ambiguous',error_code='response' WHERE binding_id=? AND state='sending'",
                (binding_id,),
            )
            return self.outputs(binding_id)

    def status(self, binding_id):
        binding = self._binding(binding_id, active=False)
        result = {"binding": binding}
        for table, key in (
            ("requests", "requests"),
            ("controls", "controls"),
            ("outbox", "outputs"),
        ):
            result[key] = {
                row["state"]: row["count"]
                for row in self._conn.execute(
                    f"SELECT state,COUNT(*) AS count FROM {table} WHERE binding_id=? GROUP BY state",
                    (binding_id,),
                )
            }
        for table, key, column, state in (
            ("requests", "running_requests", "request_id", "running"),
            ("controls", "running_controls", "id", "running"),
            ("outbox", "ambiguous_outputs", "id", "ambiguous"),
        ):
            result[key] = [
                row[column]
                for row in self._conn.execute(
                    f"SELECT {column} FROM {table} WHERE binding_id=? AND state=? ORDER BY {column}",
                    (binding_id, state),
                )
            ]
        return result
