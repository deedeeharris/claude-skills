"""Final-review regressions: real private state, deterministic local transports."""

import io
import os
import subprocess
import sys
import threading
import unittest
from dataclasses import replace
from unittest.mock import patch

import test_cli
import test_service
from tgbridge.cli import main
from tgbridge.host import Host
from tgbridge.service import Service, ServiceError
from tgbridge.store import Store
from tgbridge.telegram import TelegramError


class FastStop(threading.Event):
    """Keep real sender synchronization; only elide collector backoff time."""

    def __init__(self, action=None):
        super().__init__()
        self.delays = []
        self.action = action

    def wait(self, timeout=None):
        if threading.current_thread() is threading.main_thread():
            self.delays.append(timeout)
            if self.action:
                self.action()
            return self.is_set()
        return super().wait(0.001)


class RuntimeFixTests(unittest.TestCase):
    setUp = test_service.ServiceTests.setUp
    update = test_service.ServiceTests.update
    running = test_service.ServiceTests.running

    def identified_transport(self, *, bot_id=None, failures=0, stage="getUpdates"):
        original = lambda method, params, files=None: test_service.FakeTelegram.call(
            self.api, method, params, files
        )
        count = [0]
        stop = FastStop()

        def call(method, params, files=None):
            if method == stage:
                count[0] += 1
                if count[0] <= failures:
                    raise TelegramError("network")
            if method == "getMe":
                self.api.calls.append((method, params, files))
                return {"id": bot_id or self.cfg.bot_id, "is_bot": True}
            if method == "getUpdates":
                stop.set()
            return original(method, params, files)

        self.api.call = call
        return stop, count

    def test_long_server_retry_after_is_honored_with_interruptible_slices(self):
        stop = FastStop()
        Service._read_retry(
            TelegramError(429, retry_after=90),
            100,
            stop,
            alive=lambda: not stop.is_set(),
        )
        self.assertEqual(sum(stop.delays), 90)
        self.assertLessEqual(max(stop.delays), 0.25)

    def test_failed_hook_backoff_starts_after_hook_completion(self):
        now = [0.0]
        attempts = []

        def send(event, **payload):
            attempts.append(now[0])
            now[0] += 5
            return {"status": "unsupported", "reason": "timeout"}

        self.host.send = send
        self.api.updates = [self.update(1)]
        with patch("tgbridge.service.time.monotonic", side_effect=lambda: now[0]):
            self.service.step(drain=False)
            now[0] = 5.5
            self.service.step(drain=False)
            self.assertEqual(attempts, [0])
            now[0] = 6
            self.service.step(drain=False)
            self.assertEqual(attempts, [0, 6])

    def test_notify_retry_rate_caps_and_idle_does_not_invoke_hook(self):
        now = [0.0]
        attempts = []

        def send(event, **payload):
            attempts.append(now[0])
            return {"status": "unsupported", "reason": "failed"}

        self.host.send = send
        with patch("tgbridge.service.time.monotonic", side_effect=lambda: now[0]):
            for instant in range(20):
                now[0] = instant
                self.service.step(drain=False)
            self.assertEqual(attempts, [])
            self.api.updates = [self.update(1)]
            for instant in range(300):
                now[0] = instant
                self.service.step(drain=False)
        self.assertEqual(attempts, [0, 1, 3, 7, 15, 31, 63, 123, 183, 243])
        self.assertEqual(self.store.request("b", 1)["state"], "pending")

    def test_real_owner_death_during_startup_or_poll_backoff_stops_cleanly(self):
        for stage in ("getMe", "getUpdates"):
            with self.subTest(stage=stage):
                owner = subprocess.Popen(
                    [sys.executable, "-c", "import time; time.sleep(30)"]
                )
                self.addCleanup(
                    lambda proc=owner: proc.kill() if proc.poll() is None else None
                )
                cfg = replace(self.cfg, owner_pid=owner.pid)
                service = Service(cfg, self.store, self.api)
                calls = []
                stop = FastStop()

                def died(stop=stop, owner=owner):
                    stop.action = None
                    owner.terminate()
                    owner.wait(timeout=3)

                stop.action = died

                def call(method, params, files=None, calls=calls, stage=stage, cfg=cfg):
                    calls.append(method)
                    if method == stage:
                        raise TelegramError(429, retry_after=90)
                    if method == "getMe":
                        return {"id": cfg.bot_id, "is_bot": True}
                    return {"url": ""}

                self.api.call = call
                service.run(stop)
                self.assertEqual(calls.count(stage), 1)
                self.assertLessEqual(sum(stop.delays), 0.5)
                self.assertTrue(self.store.binding("b")["active"])

    def test_poll_backoff_honors_unbind_and_stop(self):
        for reason in ("stop", "unbind"):
            with self.subTest(reason=reason):
                calls = []
                stop = FastStop()

                def action(stop=stop, reason=reason):
                    stop.action = None
                    if reason == "unbind":
                        self.store.unbind("b")
                    else:
                        stop.set()

                stop.action = action

                def call(method, params, files=None, calls=calls):
                    calls.append(method)
                    if method == "getMe":
                        return {"id": self.cfg.bot_id, "is_bot": True}
                    if method == "getWebhookInfo":
                        return {"url": ""}
                    raise TelegramError(429, retry_after=90)

                self.api.call = call
                self.service.run(stop)
                self.assertEqual(calls, ["getMe", "getWebhookInfo", "getUpdates"])
                self.assertLessEqual(sum(stop.delays), 0.5)

    def test_runtime_rejects_other_bot_before_queue_or_network_effects(self):
        self.running()
        self.store.enqueue_output("b", 1, "final", {"text": "private A"})
        self.store.bind("other", "other-session", 222222, 7, 8)
        self.api.updates = [self.update(2, "intended for B")]
        before = self.store.binding("b")["offset"]
        stop, _ = self.identified_transport(bot_id=222222)
        with self.assertRaisesRegex(ServiceError, "identity"):
            self.service.run(stop)
        self.assertEqual([x[0] for x in self.api.calls], ["getMe"])
        self.assertEqual(self.store.binding("b")["offset"], before)
        self.assertIsNone(self.store.request("b", 2))
        self.assertEqual(self.store.outputs("b")[0]["state"], "queued")
        self.assertEqual(self.host.events, [])

    def test_runtime_rejects_config_durable_identity_disagreement(self):
        for field, value in (
            ("session_id", "another"),
            ("bot_id", 222222),
            ("owner_chat_id", 9),
            ("owner_user_id", 10),
        ):
            with self.subTest(field=field):
                self.api.calls.clear()
                stop, _ = self.identified_transport()
                service = Service(
                    replace(self.cfg, **{field: value}), self.store, self.api
                )
                with self.assertRaisesRegex(ServiceError, "identity"):
                    service.run(stop)
                self.assertEqual(self.api.calls, [])

    def test_same_bot_rotated_credential_can_collect(self):
        self.cfg = replace(self.cfg, token="991177:" + "Y" * 30)
        self.service = Service(self.cfg, self.store, self.api, host=self.host)
        self.api.updates = [self.update(1)]
        stop, _ = self.identified_transport()
        self.service.run(stop)
        self.assertEqual(self.api.calls[0][0], "getMe")
        self.assertEqual(self.store.request("b", 1)["state"], "pending")

    def test_notify_recovers_on_empty_batches_and_claims_once(self):
        now = [0.0]
        attempts = []
        claims = []

        def send(event, **payload):
            attempts.append((event, payload))
            if len(attempts) == 1:
                return {"status": "unsupported", "reason": "timeout"}
            claims.append(self.store.claim("b"))
            return {"status": "accepted"}

        self.host.send = send
        self.api.updates = [self.update(1)]
        with patch("tgbridge.service.time.monotonic", side_effect=lambda: now[0]):
            self.service.step(drain=False)
            for instant in (0.1, 0.9, 1.0, 2.0, 100.0):
                now[0] = instant
                self.service.step(drain=False)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(claims[0]["request_id"], 1)
        self.assertEqual(self.store.request("b", 1)["state"], "running")
        self.assertIsNone(self.store.claim("b"))
        self.assertTrue(all("text" not in payload for _, payload in attempts))

    def test_notify_accepted_busy_work_and_unconfigured_hook_are_not_repeated(self):
        for host in (self.host, Host([], "b", "session")):
            self.host.accepted = True
            service = Service(self.cfg, self.store, self.api, host=host)
            self.store.receive("b", [self.update(1)])
            with patch.object(host, "send", wraps=host.send) as send:
                with patch("tgbridge.service.time.monotonic", side_effect=range(100)):
                    for _ in range(10):
                        service.step(drain=False)
                self.assertEqual(send.call_count, 1)
            self.assertEqual(self.store.request("b", 1)["state"], "pending")

    def test_failed_notify_invalidated_by_stop_or_unbind(self):
        self.api.updates = [self.update(1)]
        with patch("tgbridge.service.time.monotonic", return_value=0):
            self.service.step(drain=False)
        self.api.updates = [self.update(2, "/stop"), self.update(3, "new")]
        with patch("tgbridge.service.time.monotonic", return_value=100):
            self.service.step(drain=False)
        notifications = [
            payload for event, payload in self.host.events if event == "notify"
        ]
        self.assertEqual([x["generation"] for x in notifications], [0, 1])
        self.store.unbind("b")
        with patch("tgbridge.service.time.monotonic", return_value=200):
            self.assertFalse(self.service.step(drain=False))
        self.assertEqual(sum(e == "notify" for e, _ in self.host.events), 2)
        self.assertEqual(sum(e == "stop" for e, _ in self.host.events), 1)

    def test_pending_startup_and_priority_fallback_retry_without_control_replay(self):
        self.store.receive("b", [self.update(1, "/interrupt urgent")])
        now = [0.0]
        stop = FastStop()
        events = []

        def send(event, **payload):
            events.append(event)
            if event == "notify" and events.count("notify") == 2:
                self.store.claim("b")
                stop.set()
                return {"status": "accepted"}
            return {"status": "unsupported", "reason": "timeout"}

        original = self.api.call
        polls = [0]

        def call(method, params, files=None):
            if method == "getMe":
                return {"id": self.cfg.bot_id, "is_bot": True}
            if method == "getUpdates":
                polls[0] += 1
                now[0] += 1
                if polls[0] > 10:
                    stop.set()
            return original(method, params, files)

        self.api.call, self.host.send = call, send
        with patch("tgbridge.service.time.monotonic", side_effect=lambda: now[0]):
            self.service.run(stop)
        self.assertEqual(self.store.request("b", 1)["state"], "running")
        self.assertEqual(events.count("notify"), 2)
        self.assertEqual(events.count("interrupt"), 1)

    def test_pending_notify_recovers_during_poll_outage_without_new_receipt(self):
        self.store.receive("b", [self.update(1)])
        now = [0.0]
        stop = FastStop(action=lambda: now.__setitem__(0, now[0] + 0.25))
        notifications = []

        def send(event, **payload):
            notifications.append(event)
            if len(notifications) == 2:
                self.store.claim("b")
                stop.set()
                return {"status": "accepted"}
            return {"status": "unsupported", "reason": "timeout"}

        def call(method, params, files=None):
            if method == "getMe":
                return {"id": self.cfg.bot_id, "is_bot": True}
            if method == "getWebhookInfo":
                return {"url": ""}
            if now[0] > 100:
                stop.set()
            raise TelegramError("network")

        self.api.call, self.host.send = call, send
        with patch("tgbridge.service.time.monotonic", side_effect=lambda: now[0]):
            self.service.run(stop)
        self.assertEqual(notifications, ["notify", "notify"])
        self.assertEqual(self.store.request("b", 1)["state"], "running")
        self.assertEqual(self.store.binding("b")["offset"], 2)

    def test_reads_recover_after_extended_outage_in_each_startup_or_poll_stage(self):
        for stage in ("getMe", "getWebhookInfo", "getUpdates"):
            with self.subTest(stage=stage):
                self.api.updates = [self.update(1)]
                stop, count = self.identified_transport(failures=8, stage=stage)
                try:
                    self.service.run(stop)
                except ServiceError as exc:
                    self.fail(f"Retryable {stage} outage terminated collector: {exc}")
                self.assertEqual(count[0], 9)
                self.assertEqual(self.store.binding("b")["offset"], 2)
                self.assertEqual(self.store.request("b", 1)["state"], "pending")
                self.assertLessEqual(max(stop.delays), 60)
                self.assertGreaterEqual(sum(stop.delays), 63)

    def test_startup_backoff_honors_unbind_and_owner_death(self):
        for reason in ("owner", "stop", "unbind"):
            with self.subTest(reason=reason):
                cfg = replace(self.cfg, owner_pid=os.getpid())
                service = Service(cfg, self.store, self.api)
                identities = [(os.getpid(), "alive")]
                stop = FastStop()
                calls = []

                def action(stop=stop, reason=reason, identities=identities):
                    stop.action = None
                    if reason == "unbind":
                        self.store.unbind("b")
                    elif reason == "owner":
                        identities[0] = None
                    else:
                        stop.set()

                stop.action = action

                def call(method, params, files=None, calls=calls):
                    calls.append(method)
                    raise TelegramError(429, retry_after=3600)

                self.api.call = call
                with patch(
                    "tgbridge.service.process_identity",
                    side_effect=lambda pid, identities=identities: identities[0],
                ):
                    try:
                        service.run(stop)
                    except ServiceError as exc:
                        self.fail(f"Lifecycle shutdown must be clean: {exc}")
                self.assertEqual(len(calls), 1)
                self.assertLessEqual(sum(stop.delays), 0.5)


class AttachmentIdentityTests(unittest.TestCase):
    setUp = test_cli.CLITests.setUp
    configured = test_cli.CLITests.configured
    local = test_cli.CLITests.local

    def test_wait_swapped_environment_bot_retains_visible_claim_without_download(self):
        cfg = replace(self.configured(), token=None, token_env="BRIDGE_TEST_TOKEN")
        cfg.save(self.config_path)
        update = {
            "update_id": 1,
            "message": {
                "chat": {"id": 7, "type": "private"},
                "from": {"id": 8},
                "document": {"file_id": "a", "file_name": "a.txt"},
            },
        }
        with Store(self.root / "state.sqlite3") as store:
            store.receive("b", [update])
            offset = store.binding("b")["offset"]
            store.bind("other", "other-session", 222222, 7, 8)
        calls = []

        class OtherBot:
            def call(self, method, params, files=None):
                calls.append(method)
                return {"id": 222222, "is_bot": True}

            def download(self, *args):
                calls.append("getFile")
                raise TelegramError("file")

        with patch.dict(os.environ, {"BRIDGE_TEST_TOKEN": "222222:" + "Y" * 30}):
            code = main(
                ["--config", str(self.config_path), "wait", "--timeout", "0"],
                api_factory=lambda token: OtherBot(),
                stdout=self.stdout,
                stderr=self.stderr,
            )
        self.assertEqual(code, 1)
        self.assertEqual(calls, ["getMe"])
        self.assertIn("request 1", self.stderr.getvalue())
        self.assertIn("running", self.stderr.getvalue())
        self.assertNotIn("Y" * 30, self.stderr.getvalue())
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.request("b", 1)["state"], "running")
            self.assertEqual(store.binding("b")["offset"], offset)
            self.assertIsNone(store.claim("b"))

    def test_collector_resolved_environment_cannot_cross_configured_bots(self):
        cfg = replace(self.configured(), token=None, token_env="BRIDGE_TEST_TOKEN")
        cfg.save(self.config_path)
        with Store(self.root / "state.sqlite3") as store:
            store.bind("other", "other-session", 222222, 7, 8)
        calls = []
        tokens = []

        class OtherBot:
            def call(self, method, params, files=None):
                calls.append(method)
                if method == "getMe":
                    return {"id": 222222, "is_bot": True}
                if method == "getWebhookInfo":
                    return {"url": ""}
                raise TelegramError(409)

        def factory(token):
            tokens.append(token)
            return OtherBot()

        changed = "222222:" + "Y" * 30
        with patch.dict(
            os.environ,
            {
                "BRIDGE_TEST_TOKEN": changed,
                "CODEX_THREAD_ID": "session",
                "CODEX_SESSION_ID": "session",
            },
        ):
            code = main(
                [
                    "--config",
                    str(self.config_path),
                    "run",
                    "--session-owned",
                    "--mode",
                    "collector-only",
                ],
                api_factory=factory,
                stdout=self.stdout,
                stderr=self.stderr,
            )
        self.assertEqual(code, 1)
        self.assertEqual(tokens, [changed])
        self.assertEqual(calls, ["getMe"])
        self.assertNotIn(changed, self.stderr.getvalue())
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.binding("b")["offset"], 0)
            self.assertIsNone(store.claim("b"))

    def test_text_wait_rejects_local_identity_mismatch_offline_before_claim(self):
        cfg = replace(
            self.configured(),
            token=None,
            token_env="BRIDGE_ABSENT_TOKEN",
            session_id="wrong-session",
        )
        cfg.save(self.config_path)
        with Store(self.root / "state.sqlite3") as store:
            store.receive(
                "b",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "offline",
                        },
                    }
                ],
            )
        self.assertEqual(self.local("wait", "--timeout", "0"), 1)
        self.assertEqual(self.api.calls, [])
        self.assertIn("identity", self.stderr.getvalue())
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.request("b", 1)["state"], "pending")

    def test_text_wait_status_doctor_do_not_resolve_missing_token(self):
        cfg = replace(self.configured(), token=None, token_env="BRIDGE_ABSENT_TOKEN")
        cfg.save(self.config_path)
        with Store(self.root / "state.sqlite3") as store:
            store.receive(
                "b",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "offline",
                        },
                    }
                ],
            )
        for command in (("status",), ("doctor",), ("wait", "--timeout", "0")):
            self.stdout = io.StringIO()
            self.assertEqual(self.local(*command), 0)
        self.assertEqual(self.api.calls, [])
