"""Listener and canonical publication over real SQLite and local fake transports."""

import importlib.util
import io
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError

from tgbridge.config import Config
from tgbridge.store import Store, StoreError
from tgbridge.telegram import (
    MAX_DOWNLOAD_BYTES,
    MAX_UPLOAD_BYTES,
    Telegram,
    TelegramError,
)

if importlib.util.find_spec("tgbridge.service"):
    from tgbridge.service import Service, ServiceError, prepare_request, publish
else:
    Service = None


class FakeTelegram:
    def __init__(self):
        self.updates = []
        self.calls = []
        self.webhook = ""
        self.error = None
        self.downloads = []
        self.on_poll = None

    def call(self, method, params, files=None):
        self.calls.append((method, params, files))
        if method == "getMe":
            return {"id": 991177, "is_bot": True}
        if method == "getWebhookInfo":
            return {"url": self.webhook}
        if method == "getUpdates":
            if self.on_poll:
                self.on_poll()
            if self.error:
                raise self.error
            batch, self.updates = self.updates, []
            return batch
        if self.error:
            raise self.error
        return {"message_id": 88}

    def download(self, file_id, destination):
        self.downloads.append((file_id, destination))
        if self.error:
            raise self.error
        Path(destination).write_bytes(b"\x00\xfforiginal")
        Path(destination).chmod(0o600)
        return Path(destination)


class FakeHost:
    def __init__(self, accepted=False):
        self.events = []
        self.accepted = accepted
        self.action = None

    def send(self, event, **kwargs):
        self.events.append((event, kwargs))
        if self.action:
            self.action(event, kwargs)
        return {"status": "accepted" if self.accepted else "unsupported"}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Service, "Service implementation is missing")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cfg = Config(
            1, "b", "session", 991177, "owner_bot", 7, 8, token="123456:" + "X" * 30
        )
        self.cfg.save(self.root / "config.json")
        self.store = Store(self.root / "state.sqlite3")
        self.addCleanup(self.store.close)
        self.store.bind("b", "session", self.cfg.bot_id, 7, 8, bot_username="owner_bot")
        self.api = FakeTelegram()
        self.host = FakeHost()
        self.service = Service(self.cfg, self.store, self.api, host=self.host)

    def update(self, uid, text="hello", user=8, document=None):
        message = {
            "chat": {"id": 7, "type": "private"},
            "from": {"id": user},
            "text": text,
        }
        if document:
            message["document"] = document
        return {"update_id": uid, "message": message}

    def running(self):
        self.store.receive("b", [self.update(1)])
        return self.store.claim("b")

    def test_unauthorized_stop_has_no_host_or_queue_effect(self):
        self.running()
        self.api.updates = [self.update(2, "/stop", user=99)]
        self.service.step()
        self.assertEqual(self.store.request("b", 1)["state"], "running")
        self.assertEqual(self.host.events, [])

    def test_idle_and_busy_collection_uses_no_agent_claim(self):
        self.running()
        self.service.step()
        self.assertEqual(self.host.events, [])
        self.api.updates = [self.update(2, "while busy")]
        self.service.step()
        self.assertEqual(self.store.request("b", 2)["state"], "pending")
        self.assertEqual(self.host.events[0][0], "notify")
        self.assertNotIn("text", self.host.events[0][1])
        self.service.step()
        self.assertEqual(len(self.host.events), 1)

    def test_interrupt_priority_fallback_stays_durable_and_native_must_claim(self):
        self.api.updates = [self.update(1), self.update(2, "/interrupt urgent")]
        self.service.step()
        self.assertEqual(self.store.claim("b")["request_id"], 2)
        self.assertIn("priority", self.store.outputs("b")[0]["payload"]["text"].lower())
        self.host.accepted = True
        self.api.updates = [self.update(3, "/interrupt next")]
        self.service.step()
        self.assertEqual(self.store.request("b", 3)["state"], "pending")
        self.assertEqual(self.store.claim("b")["request_id"], 3)
        self.assertEqual(self.store.claim("b")["request_id"], 1)
        self.assertIsNone(self.store.claim("b"))

    def test_stop_persists_cancellation_and_does_not_claim_native_success(self):
        self.running()
        self.store.enqueue_output("b", 1, "final", {"text": "stale"})
        self.api.updates = [self.update(2, "/stop"), self.update(3, "after stop")]
        self.service.step()
        self.assertEqual(self.store.request("b", 1)["state"], "canceled")
        self.assertEqual(self.store.request("b", 3)["state"], "pending")
        self.assertEqual(self.host.events[0][0], "stop")
        self.assertEqual(self.host.events[0][1]["canceled_request_ids"], [1])
        text = self.store.outputs("b")[-1]["payload"]["text"]
        self.assertIn("not confirmed", text)
        with self.assertRaises(StoreError):
            publish(
                self.cfg,
                self.store,
                1,
                source="telegram",
                kind="final",
                text_path=self.root / "missing",
            )

    def test_stale_control_notice_is_suppressed(self):
        self.api.updates = [self.update(1, "/interrupt first")]

        def stop_during_hook(event, kwargs):
            if event == "interrupt":
                self.store.receive("b", [self.update(2, "/stop")])

        self.host.action = stop_during_hook
        self.service.step()
        self.assertEqual(self.store.outputs("b"), [])

    def test_webhook_and_conflicting_consumer_fail_without_deletion(self):
        self.api.webhook = "https://example.invalid/hook"
        with self.assertRaises(ServiceError):
            self.service.run(threading.Event())
        self.assertNotIn("deleteWebhook", [x[0] for x in self.api.calls])
        self.api.webhook = ""
        for code in (409, 401):
            self.api.error = TelegramError(code)
            with self.assertRaises(ServiceError):
                self.service.run(threading.Event())

    def test_startup_recovery_parks_uncertain_send_and_clean_shutdown(self):
        self.running()
        row = self.store.enqueue_output("b", 1, "final", {"text": "answer"})
        self.store.next_output("b")
        stop = threading.Event()
        self.api.on_poll = stop.set
        self.service.run(stop)
        self.assertEqual(self.store.outputs("b")[0]["state"], "ambiguous")
        self.assertEqual(self.store.outputs("b")[0]["id"], row["id"])
        self.assertFalse(any(x[0] == "sendMessage" for x in self.api.calls))

    def test_outbox_ambiguity_and_safe_rate_limit(self):
        self.running()
        self.store.enqueue_output("b", 1, "final", {"text": "first"})
        self.store.enqueue_output("b", 1, "final", {"text": "second"})
        self.api.error = TelegramError("network", ambiguous=True)
        self.service.drain_one()
        self.assertEqual(self.store.outputs("b")[0]["state"], "ambiguous")
        self.service.drain_one()
        self.assertEqual(len(self.api.calls), 1)
        self.store.retry_output(1, ack_duplicate_risk=True)
        self.api.error = TelegramError(429, retry_after=20)
        self.service.drain_one()
        row = self.store.outputs("b")[0]
        self.assertEqual(row["state"], "queued")
        self.assertIsNotNone(row["retry_at"])
        self.assertEqual(row["chat_id"], 7)

    def test_canonical_text_and_files_preserve_content_after_source_edit(self):
        self.running()
        text = self.root / "canonical.txt"
        text.write_text("שלום 🌈\n" * 1500)
        artifact = self.root / "artifact.bin"
        artifact.write_bytes(b"\x00\xfforiginal")
        rows = publish(
            self.cfg,
            self.store,
            1,
            source="telegram",
            kind="final",
            text_path=text,
            attachments=[artifact],
            mode="plain",
        )
        self.assertEqual(
            "".join(r["payload"].get("text", "") for r in rows), text.read_text()
        )
        artifact.write_bytes(b"changed")
        self.assertEqual(
            Path(rows[-1]["payload"]["path"]).read_bytes(), b"\x00\xfforiginal"
        )
        self.store.complete("b", 1)
        for _ in rows:
            self.service.drain_one()
        self.assertTrue(all(r["state"] == "sent" for r in self.store.outputs("b")))
        self.assertEqual(self.api.calls[-1][0], "sendDocument")
        self.assertTrue(all(x[1]["chat_id"] == 7 for x in self.api.calls))

    def test_boundary_output_drains_with_a_transport_rejecting_blank_text(self):
        self.running()
        text = self.root / "canonical.txt"
        content = "x" * 4096 + "\n"
        text.write_text(content)
        rows = publish(
            self.cfg,
            self.store,
            1,
            source="telegram",
            kind="final",
            text_path=text,
            mode="plain",
        )
        self.store.enqueue_output("b", 1, "final", {"text": "later output"})
        calls = []

        def rejecting_blank(method, params, files=None):
            calls.append(params["text"])
            if not params["text"].strip():
                raise TelegramError(400)
            return {"message_id": len(calls)}

        self.api.call = rejecting_blank
        for _ in range(len(rows) + 1):
            self.service.drain_one()
        self.assertEqual("".join(calls[:-1]), content)
        self.assertEqual(calls[-1], "later output")
        self.assertTrue(all(row["state"] == "sent" for row in self.store.outputs("b")))

    def test_unrepresentable_text_admits_no_partial_text_or_document(self):
        self.running()
        text = self.root / "canonical.txt"
        artifact = self.root / "fixture.bin"
        artifact.write_bytes(b"synthetic document")
        for content in (" \t\n", "x" * 4096 + " " * 4097):
            text.write_text(content)
            with self.subTest(length=len(content)):
                with self.assertRaisesRegex(ServiceError, "exact bytes.*document"):
                    publish(
                        self.cfg,
                        self.store,
                        1,
                        source="telegram",
                        kind="final",
                        text_path=text,
                        attachments=[artifact],
                        mode="plain",
                    )
                self.assertEqual(self.store.outputs("b"), [])
                self.assertEqual(self.store.request("b", 1)["state"], "running")

    def test_redirected_output_is_durable_and_blocks_until_explicit_resolution(self):
        class RedirectThenSuccess:
            def __init__(self, error):
                self.error = error
                self.requests = []

            def open(self, request, timeout):
                self.requests.append(request)
                if len(self.requests) == 1:
                    raise self.error
                return io.BytesIO(b'{"ok":true,"result":{"message_id":88}}')

        artifact = self.root / "fixture.bin"
        artifact.write_bytes(b"synthetic document")
        for code in (301, 302, 303, 307, 308, 200, 600):
            for multipart in (False, True):
                with self.subTest(code=code, multipart=multipart):
                    store = Store(self.root / f"redirect-{code}-{multipart}.sqlite3")
                    self.addCleanup(store.close)
                    store.bind(
                        "b", "session", self.cfg.bot_id, 7, 8, bot_username="owner_bot"
                    )
                    store.receive("b", [self.update(1)])
                    store.claim("b")
                    first = store.enqueue_output(
                        "b",
                        1,
                        "final",
                        {"path": artifact} if multipart else {"text": "fixture"},
                    )
                    later = store.enqueue_output("b", 1, "final", {"text": "later"})
                    opener = RedirectThenSuccess(
                        HTTPError(
                            "https://example.invalid/",
                            code,
                            "refused",
                            {"Location": "https://example.invalid/redirected"},
                            io.BytesIO(b"" if multipart else b"not JSON"),
                        )
                    )
                    api = Telegram("123456:" + "X" * 30, opener=opener)
                    service = Service(self.cfg, store, api, host=self.host)
                    service.drain_one()
                    rows = store.outputs("b")
                    failed = next(row for row in rows if row["id"] == first["id"])
                    self.assertEqual(failed["state"], "ambiguous")
                    self.assertEqual(
                        failed["error_code"],
                        "redirect" if 300 <= code < 400 else "response",
                    )
                    service.drain_one()
                    self.assertEqual(len(opener.requests), 1)
                    with self.assertRaisesRegex(StoreError, "ack-duplicate-risk"):
                        store.retry_output(first["id"])
                    store.finish_output(first["id"], "canceled")
                    service.drain_one()
                    delivered = next(
                        row for row in store.outputs("b") if row["id"] == later["id"]
                    )
                    self.assertEqual(delivered["state"], "sent")
                    self.assertEqual(len(opener.requests), 2)

    def test_publish_formatting_error_has_constant_guidance_without_content(self):
        from unittest.mock import patch

        self.running()
        text = self.root / "canonical.txt"
        text.write_text("synthetic canonical content")
        detail = "synthetic private detail https://example.invalid/source"
        with (
            patch("tgbridge.service.render", side_effect=ValueError(detail)),
            self.assertRaises(ServiceError) as caught,
        ):
            publish(
                self.cfg,
                self.store,
                1,
                source="telegram",
                kind="final",
                text_path=text,
                mode="plain",
            )
        self.assertNotIn(detail, str(caught.exception))
        self.assertIn("exact bytes", str(caught.exception))
        self.assertIn("document", str(caught.exception))
        self.assertEqual(self.store.outputs("b"), [])

    def test_oversized_outbound_notice_is_deliverable_without_blocking_file(self):
        self.running()
        artifact = self.root / "large.bin"
        with artifact.open("wb") as f:
            f.truncate(MAX_UPLOAD_BYTES + 1)
        rows = publish(
            self.cfg,
            self.store,
            1,
            source="telegram",
            kind="final",
            attachments=[artifact],
        )
        self.assertEqual(len(rows), 1)
        self.assertIn("too large", rows[0]["payload"]["text"])
        self.service.drain_one()
        self.assertEqual(self.store.outputs("b")[0]["state"], "sent")
        self.assertEqual(artifact.stat().st_size, MAX_UPLOAD_BYTES + 1)

    def test_download_safe_paths_and_oversized_notice_keep_request_text(self):
        self.store.receive(
            "b",
            [
                self.update(
                    1,
                    "caption",
                    document={
                        "file_id": "f",
                        "file_name": "../../bad.bin",
                        "file_size": 9,
                    },
                )
            ],
        )
        request = self.store.claim("b")
        prepared = prepare_request(self.cfg, self.store, request, self.api)
        self.assertEqual(prepared["text"], "caption")
        path = Path(prepared["attachments"][0]["path"])
        self.assertEqual(path.parent, self.root / "attachments")
        self.assertNotIn("bad", path.name)
        self.assertEqual(path.read_bytes(), b"\x00\xfforiginal")
        self.store.receive(
            "b",
            [
                self.update(
                    2,
                    "large",
                    document={
                        "file_id": "big",
                        "file_name": "large.bin",
                        "file_size": MAX_DOWNLOAD_BYTES + 1,
                    },
                )
            ],
        )
        prepared = prepare_request(
            self.cfg, self.store, self.store.claim("b"), self.api
        )
        self.assertEqual(prepared["attachments"][0]["error"], "size")
        self.assertEqual(len(self.api.downloads), 1)
        self.assertIn("20 MB", self.store.outputs("b")[0]["payload"]["text"])

    def test_publish_rejects_wrong_source_and_unsafe_file(self):
        self.running()
        source = self.root / "text"
        source.write_text("canonical")
        for src in ("web", "", None):
            with self.assertRaises(ServiceError):
                publish(
                    self.cfg, self.store, 1, source=src, kind="final", text_path=source
                )
        link = self.root / "link"
        link.symlink_to(source)
        with self.assertRaises(ServiceError):
            publish(
                self.cfg, self.store, 1, source="telegram", kind="final", text_path=link
            )

    def test_uploaded_file_keeps_original_display_filename(self):
        self.running()
        artifact = self.root / "report.pdf"
        artifact.write_bytes(b"%PDF-original")
        publish(
            self.cfg,
            self.store,
            1,
            source="telegram",
            kind="final",
            attachments=[artifact],
        )
        self.service.drain_one()
        self.assertEqual(self.api.calls[-1][2]["document"].name, "report.pdf")

    def test_unbind_while_polling_exits_cleanly_without_host_work(self):
        self.api.updates = [self.update(1)]
        self.api.on_poll = lambda: self.store.unbind("b")
        self.assertFalse(self.service.step())
        self.assertEqual(self.host.events, [])

    def test_transport_size_rejection_does_not_block_its_notice(self):
        self.running()
        artifact = self.root / "file.bin"
        artifact.write_bytes(b"original")
        publish(
            self.cfg,
            self.store,
            1,
            source="telegram",
            kind="final",
            attachments=[artifact],
        )
        self.api.error = TelegramError("size")
        self.service.drain_one()
        rows = self.store.outputs("b")
        self.assertEqual([r["state"] for r in rows], ["canceled", "queued"])
        self.api.error = None
        self.service.drain_one()
        self.assertEqual(self.store.outputs("b")[-1]["state"], "sent")
        self.assertEqual(artifact.read_bytes(), b"original")

    def test_streamed_download_size_error_keeps_metadata_and_notice(self):
        self.store.receive(
            "b",
            [
                self.update(
                    1, "caption", document={"file_id": "f", "file_name": "unknown.bin"}
                )
            ],
        )
        self.api.error = TelegramError("size")
        result = prepare_request(self.cfg, self.store, self.store.claim("b"), self.api)
        self.assertEqual(result["attachments"][0]["error"], "size")
        self.assertEqual(result["text"], "caption")
        self.assertIn("20 MB", self.store.outputs("b")[0]["payload"]["text"])

    def test_safe_read_retries_wait_retry_after_and_fatal_is_immediate(self):
        class WaitRecorder:
            def __init__(self):
                self.delays = []

            def wait(self, delay):
                self.delays.append(delay)

        stop = WaitRecorder()
        Service._read_retry(TelegramError(429, retry_after=17), 1, stop)
        Service._read_retry(TelegramError("network"), 2, stop)
        self.assertEqual(stop.delays, [17, 2])
        with self.assertRaises(ServiceError):
            Service._read_retry(TelegramError(409), 1, stop)
        for code in (401, 400, 403):
            with self.assertRaises(ServiceError):
                Service._read_retry(TelegramError(code), 20, stop)
        Service._read_retry(TelegramError("network"), 5, stop)
        Service._read_retry(TelegramError("network"), 100000, stop)
        self.assertEqual(stop.delays, [17, 2, 16, 60])

    def test_bare_interrupt_help_does_not_create_work(self):
        self.api.updates = [self.update(1, "/interrupt")]
        self.service.step()
        self.assertIsNone(self.store.claim("b"))
        self.assertEqual(self.host.events, [])
        self.assertIn(
            "/interrupt <request>", self.store.outputs("b")[0]["payload"]["text"]
        )

    def test_ambiguous_integer_error_is_never_automatically_retried(self):
        self.running()
        self.store.enqueue_output("b", 1, "final", {"text": "answer"})
        self.api.error = TelegramError(429, retry_after=1, ambiguous=True)
        self.service.drain_one()
        self.assertEqual(self.store.outputs("b")[0]["state"], "ambiguous")
        self.service.drain_one()
        self.assertEqual(len(self.api.calls), 1)

    def test_stop_between_notice_check_and_admission_cannot_relabel_old_ack(self):
        self.api.updates = [self.update(1, "/interrupt first")]
        original = self.store.enqueue_output

        def race(binding_id, request_id, kind, payload, **kwargs):
            self.store.receive("b", [self.update(2, "/stop")])
            return original(binding_id, request_id, kind, payload, **kwargs)

        self.store.enqueue_output = race
        self.service.step()
        self.assertEqual(self.store.outputs("b"), [])

    def test_long_unicode_upload_name_is_truncated_without_changing_snapshot(self):
        self.running()
        artifact = self.root / ("表" * 80 + ".pdf")
        artifact.write_bytes(b"original")
        row = publish(
            self.cfg,
            self.store,
            1,
            source="telegram",
            kind="final",
            attachments=[artifact],
        )[0]
        snapshot = Path(row["payload"]["path"])
        before_mode = snapshot.stat().st_mode
        self.service.drain_one()
        name = self.api.calls[-1][2]["document"].name
        self.assertTrue(name.startswith("表"))
        self.assertTrue(name.endswith(".pdf"))
        self.assertLessEqual(len(name.encode()), 240)
        self.assertEqual(snapshot.read_bytes(), b"original")
        self.assertEqual(snapshot.stat().st_mode, before_mode)

    def test_plain_canonical_capture_preserves_original_newline_characters(self):
        self.running()
        source = self.root / "canonical.txt"
        source.write_bytes(b"first\r\nsecond\rthird\n")
        rows = publish(
            self.cfg,
            self.store,
            1,
            source="telegram",
            kind="final",
            text_path=source,
            mode="plain",
        )
        self.assertEqual(
            "".join(row["payload"]["text"] for row in rows),
            source.read_bytes().decode("utf-8"),
        )

    def test_collector_receives_while_outbound_transport_is_busy(self):
        import time

        self.running()
        self.store.enqueue_output("b", 1, "final", {"text": "answer"})
        started, release, stop = threading.Event(), threading.Event(), threading.Event()
        original_call = self.api.call
        delivered = []

        def blocking_send(method, params, files=None):
            if method == "sendMessage":
                started.set()
                release.wait(3)
                return {"message_id": 44}
            if method == "getUpdates" and started.is_set() and not delivered:
                delivered.append(True)
                return [self.update(2, "arrived while sending")]
            return original_call(method, params, files)

        self.api.call = blocking_send
        observed = []

        def observe():
            try:
                if started.wait(2):
                    deadline = time.monotonic() + 1
                    with Store(self.root / "state.sqlite3") as other:
                        while time.monotonic() < deadline:
                            row = other.request("b", 2)
                            if row:
                                observed.append(row["text"])
                                break
                            time.sleep(0.01)
            finally:
                stop.set()
                release.set()

        observer = threading.Thread(target=observe)
        observer.start()
        try:
            self.service.run(stop)
        finally:
            release.set()
            observer.join(3)
        self.assertEqual(observed, ["arrived while sending"])

    def test_definite_rate_rejection_after_stop_does_not_requeue_old_output(self):
        self.running()
        self.store.enqueue_output("b", 1, "final", {"text": "old answer"})

        def stopped_send(method, params, files=None):
            self.store.receive("b", [self.update(2, "/stop")])
            raise TelegramError(429, retry_after=5)

        self.api.call = stopped_send
        self.service.drain_one()
        self.assertEqual(self.store.outputs("b")[0]["state"], "canceled")
        self.assertEqual(self.store.binding("b")["generation"], 1)

    def test_recovered_stop_never_targets_running_post_stop_work(self):
        self.running()
        self.store.receive(
            "b", [self.update(2, "/stop"), self.update(3, "new work after stop")]
        )
        claimed = self.store.claim("b")
        self.assertEqual((claimed["request_id"], claimed["generation"]), (3, 1))
        self.store.close()
        with Store(self.root / "state.sqlite3") as reopened:
            recovered = Service(self.cfg, reopened, self.api, host=self.host)
            recovered.step(drain=False)
            event, payload = self.host.events[0]
            self.assertEqual(event, "stop")
            self.assertEqual(payload["generation"], 1)
            self.assertEqual(payload["canceled_request_ids"], [])
            self.assertEqual(reopened.request("b", 1)["state"], "canceled")
            self.assertEqual(reopened.request("b", 3)["state"], "running")
            self.assertEqual(
                reopened.request("b", 3)["generation"], payload["generation"]
            )
