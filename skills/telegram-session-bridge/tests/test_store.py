"""Durable store behavior exercised against real private SQLite files."""

import concurrent.futures
import importlib.util
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path

if importlib.util.find_spec("tgbridge.store"):
    from tgbridge.store import Store, StoreError
else:
    Store = None
    StoreError = ValueError


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Store, "Store implementation is missing")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "state.sqlite3"
        self.store = Store(self.path)
        self.addCleanup(self.store.close)
        self.store.bind("b", "s", 1, 7, 8, bot_username="owner_bot")

    def update(self, uid, text="hello", *, chat=7, user=8):
        return {
            "update_id": uid,
            "message": {
                "chat": {"id": chat, "type": "private"},
                "from": {"id": user},
                "text": text,
            },
        }

    def running(self, uid=101):
        self.store.receive("b", [self.update(uid)])
        return self.store.claim("b")

    def output(self, uid=101, text="answer"):
        return self.store.enqueue_output(
            "b", uid, "final", {"text": text, "entities": []}
        )

    def test_receive_survives_reopen_and_offset_never_regresses(self):
        self.store.receive("b", [self.update(101)])
        self.store.close()
        with Store(self.path) as reopened:
            self.assertEqual(reopened.claim("b")["text"], "hello")
            reopened.receive("b", [self.update(100), self.update(101)])
            self.assertEqual(reopened.binding("b")["offset"], 102)
            self.assertIsNone(reopened.claim("b"))

    def test_owner_filter_and_duplicate_updates_are_defense_in_depth(self):
        wrong = self.update(103)
        wrong["edited_message"] = wrong.pop("message")
        self.store.receive(
            "b",
            [
                self.update(100, user=9),
                self.update(101, chat=9),
                wrong,
                self.update(104),
                self.update(104),
            ],
        )
        self.assertEqual(self.store.claim("b")["request_id"], 104)
        self.assertIsNone(self.store.claim("b"))
        self.assertEqual(self.store.binding("b")["offset"], 105)

    def test_receive_rolls_back_entire_batch_before_offset(self):
        batch = [self.update(101), self.update(102)]
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                "CREATE TRIGGER abort_second BEFORE INSERT ON requests WHEN NEW.request_id=102 BEGIN SELECT RAISE(ABORT, 'fixture'); END"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.receive("b", batch)
        self.assertEqual(self.store.binding("b")["offset"], 0)
        self.assertIsNone(self.store.request("b", 101))

    def test_interrupt_priority_and_durable_controls(self):
        self.store.receive(
            "b",
            [
                self.update(101),
                self.update(102, "/interrupt urgent"),
                self.update(103, "/help"),
                self.update(104, "/status"),
            ],
        )
        self.assertEqual(self.store.claim("b")["text"], "urgent")
        self.assertEqual(self.store.claim("b")["request_id"], 101)
        self.store.close()
        with Store(self.path) as other:
            control = other.next_control("b")
            self.assertEqual(
                (control["kind"], control["request_id"]), ("interrupt", 102)
            )
            other.finish_control(control["id"])
            self.assertEqual(other.next_control("b")["kind"], "help")

    def test_stop_cancels_old_generation_and_same_batch_work_survives(self):
        self.running(100)
        old = self.output(100)
        notice = self.store.enqueue_output("b", None, "notice", {"text": "old notice"})
        self.store.receive(
            "b", [self.update(101), self.update(102, "/stop"), self.update(103, "new")]
        )
        for uid in (100, 101):
            self.assertEqual(self.store.request("b", uid)["state"], "canceled")
        self.assertEqual(self.store.claim("b")["request_id"], 103)
        self.assertEqual(self.store.binding("b")["generation"], 1)
        self.assertEqual(
            {row["id"]: row["state"] for row in self.store.outputs("b")},
            {old["id"]: "canceled", notice["id"]: "canceled"},
        )
        with self.assertRaises(StoreError):
            self.store.complete("b", 100)
        with self.assertRaises(StoreError):
            self.output(100)
        self.assertEqual(self.store.next_control("b")["kind"], "stop")

    def test_running_work_requires_explicit_recovery(self):
        self.running()
        self.store.close()
        with Store(self.path) as other:
            self.assertIsNone(other.claim("b"))
            self.assertEqual(other.status("b")["running_requests"], [101])
            other.recover("b", 101)
            self.assertEqual(other.claim("b")["request_id"], 101)
            other.complete("b", 101)
            self.assertEqual(other.request("b", 101)["state"], "completed")
            with self.assertRaises(StoreError):
                other.recover("b", 101)

    def test_binding_identity_and_resume_do_not_mutate_owner_or_offset(self):
        self.running()
        self.store.bind("b", "s", 1, 7, 8, initial_offset=999, bot_username="owner_bot")
        self.assertEqual(self.store.binding("b")["offset"], 102)
        for args in [
            ("b", "other", 1, 7, 8),
            ("b", "s", 1, 9, 8),
            ("other", "s2", 1, 7, 8),
        ]:
            with self.assertRaises(StoreError):
                self.store.bind(*args)

    def test_fresh_binding_and_unbind_isolation(self):
        self.running()
        self.output()
        self.store.unbind("b")
        self.assertFalse(self.store.binding("b")["active"])
        self.assertIsNone(self.store.claim("b"))
        with self.assertRaises(StoreError):
            self.store.receive("b", [self.update(102)])
        self.store.bind("new", "s2", 1, 7, 8, initial_offset=102)
        self.assertIsNone(self.store.claim("new"))
        self.assertIsNone(self.store.next_output("new"))
        self.assertIsNone(self.store.request("new", 101))
        with self.assertRaises(StoreError):
            self.store.bind("b", "s", 1, 7, 8, bot_username="owner_bot")

    def test_concurrent_connections_claim_each_request_once(self):
        self.store.receive("b", [self.update(i) for i in range(100, 120)])
        barrier = threading.Barrier(4)

        def worker(_):
            with Store(self.path) as conn:
                barrier.wait()
                result = []
                while row := conn.claim("b"):
                    result.append(row["request_id"])
                return result

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            claimed = [uid for batch in pool.map(worker, range(4)) for uid in batch]
        self.assertEqual(sorted(claimed), list(range(100, 120)))

    def test_requestless_outputs_only_admit_text_notices(self):
        self.assertEqual(self.store.status("b")["requests"], {})
        source = self.root / "unassociated.bin"
        source.write_bytes(b"unassociated task bytes")
        for kind, payload in (
            ("final", {"text": "unassociated final"}),
            ("progress", {"text": "unassociated progress"}),
            ("file", {"path": source}),
            ("document", {"path": source}),
            ("photo", {"path": source}),
            ("text", {"text": "unassociated task"}),
        ):
            with self.subTest(kind=kind), self.assertRaises(StoreError):
                self.store.enqueue_output("b", None, kind, payload)
        self.assertEqual(self.store.outputs("b"), [])
        self.assertEqual(list(self.root.glob("outbox/snapshot-*")), [])
        notice = self.store.enqueue_output(
            "b", None, "notice", {"text": "relay ready", "entities": [], "chat_id": 7}
        )
        self.assertIsNone(notice["request_id"])
        self.assertEqual(self.store.next_output("b")["id"], notice["id"])
        self.assertEqual(self.store.status("b")["requests"], {})

    def test_requestless_notices_reject_file_or_attachment_payloads(self):
        source = self.root / "unassociated.bin"
        source.write_bytes(b"unassociated task bytes")
        for payload in (
            {"path": source},
            {"text": "file bypass", "path": source},
            {"text": "metadata bypass", "name": "task.bin"},
            {"text": "caption bypass", "caption": "task result"},
            {"text": "mime bypass", "mime_type": "application/octet-stream"},
            {"text": "entities bypass", "caption_entities": []},
        ):
            with self.subTest(keys=sorted(payload)), self.assertRaises(StoreError):
                self.store.enqueue_output("b", None, "notice", payload)
        self.assertEqual(self.store.outputs("b"), [])
        self.assertEqual(list(self.root.glob("outbox/snapshot-*")), [])

    def test_output_requires_current_running_telegram_request(self):
        for uid in (999, None, True, "101"):
            if uid is None:
                continue
            with self.assertRaises(StoreError):
                self.output(uid)
        self.store.receive("b", [self.update(101)])
        with self.assertRaises(StoreError):
            self.output()
        self.store.claim("b")
        output = self.output()
        self.store.complete("b", 101)
        with self.assertRaises(StoreError):
            self.output()
        self.assertEqual(self.store.next_output("b")["id"], output["id"])

    def test_order_blocks_on_sending_ambiguous_failed_and_future_retry(self):
        self.running()
        first, second = self.output(text="first"), self.output(text="second")
        self.assertEqual(self.store.next_output("b")["id"], first["id"])
        self.assertIsNone(self.store.next_output("b"))
        self.store.finish_output(first["id"], "ambiguous", error_code="network")
        self.assertIsNone(self.store.next_output("b"))
        self.store.retry_output(first["id"], ack_duplicate_risk=True)
        self.store.next_output("b")
        self.store.finish_output(
            first["id"], "queued", error_code=429, retry_at=time.time() + 3600
        )
        self.assertIsNone(self.store.next_output("b"))
        self.store.retry_output(first["id"])
        self.store.next_output("b")
        self.store.finish_output(first["id"], "failed", error_code=400)
        self.assertIsNone(self.store.next_output("b"))
        self.store.finish_output(first["id"], "canceled")
        self.assertEqual(self.store.next_output("b")["id"], second["id"])

    def test_open_does_not_recover_live_sender_explicit_recovery_is_ambiguous(self):
        self.running()
        first = self.output()
        self.store.next_output("b")
        with Store(self.path) as other:
            self.assertEqual(other.outputs("b")[0]["state"], "sending")
            self.assertIsNone(other.next_output("b"))
            other.recover_outbox("b")
            self.assertEqual(other.outputs("b")[0]["state"], "ambiguous")
            self.assertIsNone(other.next_output("b"))
            other.finish_output(first["id"], "sent", message_id=77)
            self.assertEqual(other.outputs("b")[0]["message_id"], 77)

    def test_output_transition_validation_and_fixed_owner(self):
        self.running()
        for payload in (
            {"text": "x", "chat_id": 9},
            {"text": "x", "reply_to_message_id": 9},
            {"path": "/no/file"},
        ):
            with self.assertRaises(StoreError):
                self.store.enqueue_output("b", 101, "final", payload)
        row = self.output()
        self.assertEqual(row["chat_id"], 7)
        self.assertEqual(row["payload"]["chat_id"], 7)
        with self.assertRaises(StoreError):
            self.store.finish_output(row["id"], "sent")
        self.store.next_output("b")
        for metadata in (
            {"chat_id": 9},
            {"error_code": "token-bearing-url"},
            {"retry_at": float("nan")},
            {"message_id": True},
        ):
            with self.assertRaises(StoreError):
                self.store.finish_output(row["id"], "failed", **metadata)
        with self.assertRaises(StoreError):
            self.store.finish_output(row["id"], "queued", error_code="network")
        self.store.finish_output(row["id"], "sent", message_id=12)
        with self.assertRaises(StoreError):
            self.store.retry_output(row["id"])

    def test_control_requires_explicit_recovery_after_uncertain_host_action(self):
        self.assertTrue(
            callable(getattr(self.store, "recover_control", None)),
            "Explicit control recovery is missing",
        )
        self.store.receive("b", [self.update(101, "/interrupt urgent")])
        control = self.store.next_control("b")
        self.store.close()
        with Store(self.path) as other:
            self.assertIsNone(other.next_control("b"))
            self.assertEqual(other.status("b")["running_controls"], [control["id"]])
            other.recover_control(control["id"])
            self.assertEqual(other.next_control("b")["id"], control["id"])
            other.finish_control(control["id"])
            self.assertIsNone(other.next_control("b"))

    def test_stop_preserves_inflight_audit_without_blocking_new_generation(self):
        self.running()
        old = self.output()
        self.store.next_output("b")
        self.store.receive("b", [self.update(102, "/stop"), self.update(103, "new")])
        self.assertEqual(self.store.outputs("b")[0]["state"], "sending")
        notice = self.store.enqueue_output("b", None, "notice", {"text": "stopped"})
        self.assertEqual(self.store.next_output("b")["id"], notice["id"])
        self.store.finish_output(notice["id"], "sent", message_id=44)
        self.store.recover_outbox("b")
        self.assertEqual(self.store.outputs("b")[0]["state"], "ambiguous")
        with self.assertRaises(StoreError):
            self.store.retry_output(old["id"])
        self.store.claim("b")
        new = self.output(103)
        self.assertEqual(self.store.next_output("b")["id"], new["id"])

    def test_failed_output_insert_removes_partial_snapshot(self):
        self.running()
        source = self.root / "bytes.bin"
        source.write_bytes(b"unchanged")
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                "CREATE TRIGGER no_output BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'fixture'); END"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.enqueue_output("b", 101, "final", {"path": source})
        self.assertEqual(list((self.root / "outbox").iterdir()), [])
        self.assertEqual(self.store.outputs("b"), [])

    def test_transport_ambiguity_cannot_be_marked_failed_or_scheduled(self):
        self.running()
        row = self.output()
        self.store.next_output("b")
        for code in ("network", "response"):
            with self.assertRaises(StoreError):
                self.store.finish_output(row["id"], "failed", error_code=code)
        for state, metadata in (
            ("failed", {"error_code": 400, "message_id": 1}),
            ("sent", {"error_code": 400}),
            ("ambiguous", {"retry_at": time.time() + 10}),
        ):
            with self.assertRaises(StoreError):
                self.store.finish_output(row["id"], state, **metadata)
        self.assertEqual(self.store.outputs("b")[0]["state"], "sending")

    def test_invalid_snapshot_types_are_safe_store_errors(self):
        self.running()
        for path in (False, 123, [], {}):
            with self.subTest(path=path), self.assertRaises(StoreError):
                self.store.enqueue_output("b", 101, "final", {"path": path})

    def test_concurrent_output_claim_only_one_sender(self):
        self.running()
        self.output()
        self.output(text="second")
        barrier = threading.Barrier(2)

        def worker(_):
            with Store(self.path) as conn:
                barrier.wait()
                return conn.next_output("b")

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            rows = list(pool.map(worker, range(2)))
        self.assertEqual(sum(row is not None for row in rows), 1)

    def test_file_snapshot_is_private_immutable_and_preserves_bytes(self):
        self.running()
        source = self.root / "original.bin"
        source.write_bytes(b"\x00\xfforiginal")
        row = self.store.enqueue_output(
            "b",
            101,
            "final",
            {"path": str(source), "name": "original.bin", "caption": "full caption"},
        )
        snapshot = Path(row["payload"]["path"])
        source.write_bytes(b"changed")
        self.assertEqual(snapshot.read_bytes(), b"\x00\xfforiginal")
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o400)
        self.assertEqual(snapshot.parent.stat().st_mode & 0o777, 0o700)
        self.store.close()
        with Store(self.path) as other:
            self.assertEqual(
                Path(other.outputs("b")[0]["payload"]["path"]).read_bytes(),
                b"\x00\xfforiginal",
            )

    def test_private_storage_rejects_public_paths_and_symlinks(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        public = self.root / "public"
        public.mkdir()
        public.chmod(0o755)
        with self.assertRaises(StoreError):
            Store(public / "state.sqlite3")
        link = self.root / "link"
        link.symlink_to(self.path)
        with self.assertRaises(StoreError):
            Store(link)
        for args in [("bad", "s", True, 7, 8), ("bad", "s", 2, 0, 8)]:
            with self.assertRaises(StoreError):
                self.store.bind(*args)

    def test_notice_generation_admission_is_atomic_after_stop(self):
        generation = self.store.binding("b")["generation"]
        self.store.receive("b", [self.update(101, "/stop")])
        with self.assertRaises(StoreError):
            self.store.enqueue_output(
                "b",
                None,
                "notice",
                {"text": "obsolete control ack"},
                expected_generation=generation,
            )
        self.assertEqual(self.store.outputs("b"), [])
        row = self.store.enqueue_output(
            "b",
            None,
            "notice",
            {"text": "current control ack"},
            expected_generation=generation + 1,
        )
        self.assertEqual(row["generation"], generation + 1)
        with self.assertRaises(StoreError):
            self.store.enqueue_output(
                "b",
                None,
                "notice",
                {"text": "bad generation"},
                expected_generation=True,
            )

    def test_ambiguous_retry_requires_explicit_acknowledgment_in_store(self):
        self.running()
        row = self.output()
        self.store.next_output("b")
        self.store.finish_output(row["id"], "ambiguous", error_code="network")
        with self.assertRaises(StoreError):
            self.store.retry_output(row["id"])
        self.assertEqual(self.store.outputs("b")[0]["state"], "ambiguous")
        self.assertEqual(self.store.outputs("b")[0]["error_code"], "network")
        for invalid in (False, 1, "true", None):
            with self.subTest(ack=invalid), self.assertRaises(StoreError):
                self.store.retry_output(row["id"], ack_duplicate_risk=invalid)
        retried = self.store.retry_output(row["id"], ack_duplicate_risk=True)
        self.assertEqual(retried["state"], "queued")
        self.assertIsNone(retried["error_code"])
        self.store.receive("b", [self.update(102, "/stop")])
        with self.assertRaises(StoreError):
            self.store.retry_output(row["id"], ack_duplicate_risk=True)


if __name__ == "__main__":
    unittest.main()
