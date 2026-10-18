"""Command tests use real subprocesses and injected local pairing transports."""

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tgbridge.config import Config
from tgbridge.store import Store
from tgbridge.telegram import TelegramError

if importlib.util.find_spec("tgbridge.cli"):
    from tgbridge.cli import main
else:
    main = None

ROOT = Path(__file__).resolve().parents[1]
SKILL = (
    ROOT if (ROOT / "SKILL.md").is_file() else ROOT / "skills/telegram-session-bridge"
)
SCRIPTS = SKILL / "scripts"
TOKEN = "123456:" + "X" * 30


class PairAPI:
    def __init__(self, stderr):
        self.stderr = stderr
        self.calls = []
        self.webhook = ""
        self.error = None
        self.user = 8
        self.chat = 7
        self.prefix = []

    def call(self, method, params, files=None):
        self.calls.append((method, params))
        if method == "getMe":
            return {"id": 991188, "username": "owner_bot", "is_bot": True}
        if method == "getWebhookInfo":
            return {"url": self.webhook}
        if method == "getUpdates":
            if self.error:
                raise self.error
            pairing = json.loads(self.stderr.getvalue().splitlines()[-1])[
                "pairing_text"
            ]
            return [
                *self.prefix,
                {
                    "update_id": 11,
                    "message": {
                        "chat": {"id": self.chat, "type": "private"},
                        "from": {"id": self.user},
                        "text": pairing,
                    },
                },
                {
                    "update_id": 12,
                    "message": {
                        "chat": {"id": self.chat, "type": "private"},
                        "from": {"id": self.user},
                        "text": "keep this request",
                    },
                },
            ]
        return True


class CLITests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(main, "CLI implementation is missing")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config_path = self.root / "config.json"
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        self.api = PairAPI(self.stderr)

    def configured(self):
        cfg = Config(1, "b", "session", 991188, "owner_bot", 7, 8, token=TOKEN)
        cfg.save(self.config_path)
        with Store(self.root / "state.sqlite3") as store:
            store.bind("b", "session", cfg.bot_id, 7, 8, bot_username=cfg.bot_username)
        return cfg

    def local(self, *args, stdin=""):
        return main(
            ["--config", str(self.config_path), *args],
            api_factory=lambda token: self.api,
            stdin=io.StringIO(stdin),
            stdout=self.stdout,
            stderr=self.stderr,
        )

    def proc(self, *args, stdin=""):
        env = {**os.environ, "PYTHONPATH": str(SCRIPTS)}
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "tg_bridge.py"),
                "--config",
                str(self.config_path),
                *args,
            ],
            input=stdin,
            text=True,
            capture_output=True,
            timeout=5,
            env=env,
            check=False,
        )

    def test_launcher_help_and_offline_init_validation_redact_token(self):
        result = self.proc("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("publish", result.stdout)
        result = self.proc(
            "init", "--session-id", "s", "--token-stdin", stdin="bad-secret-value"
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("bad-secret-value", result.stdout + result.stderr)
        self.assertFalse(self.config_path.exists())

    def test_init_pairs_in_memory_and_preserves_post_pairing_boundary(self):
        self.assertEqual(
            self.local(
                "init", "--session-id", "real-session", "--token-stdin", stdin=TOKEN
            ),
            0,
        )
        cfg = Config.load(self.config_path)
        self.assertEqual((cfg.owner_chat_id, cfg.owner_user_id), (7, 8))
        self.assertEqual(cfg.session_id, "real-session")
        self.assertNotIn(TOKEN, self.stdout.getvalue() + self.stderr.getvalue())
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.binding(cfg.binding_id)["offset"], 12)
            self.assertIsNone(store.claim(cfg.binding_id))
        command = next(
            params for name, params in self.api.calls if name == "setMyCommands"
        )
        self.assertEqual(command["scope"], {"type": "chat", "chat_id": 7})
        self.assertEqual(
            [x["command"] for x in command["commands"]], ["interrupt", "stop"]
        )

    def test_pair_refuses_webhook_conflict_and_half_valid_config(self):
        self.api.webhook = "https://example.invalid"
        self.assertEqual(
            self.local("pair", "--session-id", "s", "--token-stdin", stdin=TOKEN), 1
        )
        self.assertFalse(self.config_path.exists())
        self.api.webhook = ""
        self.api.error = TelegramError(409)
        self.assertEqual(
            self.local("pair", "--session-id", "s", "--token-stdin", stdin=TOKEN), 1
        )
        self.assertFalse(self.config_path.exists())
        self.assertNotIn("deleteWebhook", [x[0] for x in self.api.calls])

    def test_pair_ignores_group_sender_chat_and_near_match(self):
        class InvalidThenValid(PairAPI):
            def call(inner, method, params, files=None):
                batch = super(InvalidThenValid, inner).call(method, params, files)
                if method == "getUpdates":
                    correct = batch[0]
                    text = correct["message"]["text"]
                    return [
                        {
                            "update_id": 7,
                            "message": {
                                "chat": {"id": 1, "type": "group"},
                                "from": {"id": 1},
                                "text": text,
                            },
                        },
                        {
                            "update_id": 8,
                            "message": {
                                "chat": {"id": 1, "type": "private"},
                                "from": {"id": 1},
                                "sender_chat": {"id": 1},
                                "text": text,
                            },
                        },
                        {
                            "update_id": 9,
                            "message": {
                                "chat": {"id": 1, "type": "private"},
                                "from": {"id": 1},
                                "text": text + " extra",
                            },
                        },
                        *batch,
                    ]
                return batch

        self.api = InvalidThenValid(self.stderr)
        self.assertEqual(
            self.local("pair", "--session-id", "s", "--token-stdin", stdin=TOKEN), 0
        )
        self.assertEqual(Config.load(self.config_path).owner_user_id, 8)

    def test_explicit_same_session_resume_preserves_queue_and_rejects_move(self):
        cfg = self.configured()
        with Store(self.root / "state.sqlite3") as store:
            store.receive(
                "b",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "pending",
                        },
                    }
                ],
            )
        self.assertEqual(self.local("bind", "--session-id", "other", "--resume"), 1)
        self.assertEqual(self.local("bind", "--session-id", "session", "--resume"), 0)
        self.assertEqual(self.api.calls, [])
        self.assertEqual(Config.load(self.config_path).binding_id, cfg.binding_id)
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.claim("b")["text"], "pending")

    def test_fresh_bind_pairs_to_saved_owner_and_has_new_identity(self):
        self.configured()
        self.assertEqual(self.local("bind", "--session-id", "new-session"), 0)
        cfg = Config.load(self.config_path)
        self.assertNotEqual(cfg.binding_id, "b")
        with Store(self.root / "state.sqlite3") as store:
            self.assertFalse(store.binding("b")["active"])
            self.assertEqual(store.binding(cfg.binding_id)["offset"], 12)
            self.assertIsNone(store.claim(cfg.binding_id))
        self.assertEqual(self.local("unbind"), 0)
        with Store(self.root / "state.sqlite3") as store:
            self.assertFalse(store.binding(cfg.binding_id)["active"])

    def test_status_and_doctor_are_offline_redacted_and_truthful(self):
        self.configured()
        for command in ("status", "doctor"):
            result = self.proc(command)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(data["verification"]["automatic_continuation"], "blocked")
            self.assertEqual(
                data["verification"]["canonical_output_capture"], "live-unverified"
            )
            self.assertEqual(
                data["verification"]["session_lifecycle"], "live-unverified"
            )
            self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.proc("run").returncode, 1)

    def test_wait_timeout_claim_publish_complete_and_source_guard(self):
        self.configured()
        self.assertEqual(self.proc("wait", "--timeout", "0").returncode, 3)
        with Store(self.root / "state.sqlite3") as store:
            store.receive(
                "b",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "work",
                        },
                    }
                ],
            )
        result = self.proc("wait", "--timeout", ".1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["source"], "telegram")
        text = self.root / "canonical.txt"
        text.write_text("full canonical answer 🌈")
        artifact = self.root / "artifact.bin"
        artifact.write_bytes(b"\x00\xff")
        self.assertNotEqual(
            self.proc(
                "publish",
                "--request-id",
                "1",
                "--kind",
                "final",
                "--text-file",
                str(text),
            ).returncode,
            0,
        )
        result = self.proc(
            "publish",
            "--request-id",
            "1",
            "--source",
            "telegram",
            "--kind",
            "final",
            "--text-file",
            str(text),
            "--file",
            str(artifact),
            "--format",
            "plain",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        artifact.write_bytes(b"changed")
        self.assertEqual(self.proc("complete", "--request-id", "1").returncode, 0)
        with Store(self.root / "state.sqlite3") as store:
            rows = store.outputs("b")
            self.assertEqual(rows[0]["payload"]["text"], text.read_text())
            self.assertEqual(Path(rows[1]["payload"]["path"]).read_bytes(), b"\x00\xff")
            self.assertEqual(store.request("b", 1)["state"], "completed")

    def test_unrepresentable_publish_explains_document_without_admitting_text(self):
        self.configured()
        with Store(self.root / "state.sqlite3") as store:
            store.receive(
                "b",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "synthetic work",
                        },
                    }
                ],
            )
            store.claim("b")
        text = self.root / "canonical.txt"
        text.write_text("x" * 4096 + " " * 4097)
        self.assertEqual(
            self.local(
                "publish",
                "--request-id",
                "1",
                "--source",
                "telegram",
                "--kind",
                "final",
                "--text-file",
                str(text),
                "--format",
                "plain",
            ),
            1,
        )
        self.assertIn("exact bytes", self.stderr.getvalue())
        self.assertIn("document", self.stderr.getvalue())
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.outputs("b"), [])
            self.assertEqual(store.request("b", 1)["state"], "running")
        self.assertEqual(self.api.calls, [])

    def test_recovery_requires_explicit_old_work_check_and_outbox_resolution(self):
        self.configured()
        with Store(self.root / "state.sqlite3") as store:
            store.receive(
                "b",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "work",
                        },
                    }
                ],
            )
            store.claim("b")
            row = store.enqueue_output("b", 1, "final", {"text": "answer"})
            store.next_output("b")
            store.recover_outbox("b")
        self.assertEqual(self.proc("recover", "--request-id", "1").returncode, 1)
        self.assertEqual(
            self.proc(
                "recover", "--request-id", "1", "--previous-work-stopped"
            ).returncode,
            0,
        )
        self.assertEqual(
            self.proc("outbox", "retry", "--id", str(row["id"])).returncode, 1
        )
        result = self.proc(
            "outbox", "mark-sent", "--id", str(row["id"]), "--message-id", "50"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.proc("outbox", "inspect")
        self.assertEqual(json.loads(result.stdout)[0]["state"], "sent")
        self.assertNotIn("answer", result.stdout)

    def test_setup_state_failure_does_not_leave_saved_configuration(self):
        with Store(self.root / "state.sqlite3") as store:
            store.bind(
                "previous", "old-session", 991188, 7, 8, bot_username="owner_bot"
            )
        self.assertEqual(
            self.local(
                "init", "--session-id", "new-session", "--token-stdin", stdin=TOKEN
            ),
            1,
        )
        self.assertFalse(self.config_path.exists())

    def test_fresh_bind_does_not_inherit_previous_session_owner_pid(self):
        cfg = self.configured()
        cfg.owner_pid = 999999999
        cfg.save(self.config_path)
        self.assertEqual(self.local("bind", "--session-id", "new-session"), 0)
        self.assertIsNone(Config.load(self.config_path).owner_pid)

    def test_pair_expiry_preserves_saved_owner_and_binding(self):
        self.configured()
        self.api.user = 99
        result = self.local(
            "bind", "--session-id", "new-session", "--pair-timeout", ".06"
        )
        self.assertEqual(result, 1)
        cfg = Config.load(self.config_path)
        self.assertEqual((cfg.binding_id, cfg.owner_user_id), ("b", 8))
        with Store(self.root / "state.sqlite3") as store:
            self.assertTrue(store.binding("b")["active"])
        self.assertFalse(any(name == "setMyCommands" for name, _ in self.api.calls))

    def test_default_environment_source_does_not_copy_secret(self):
        from unittest.mock import patch

        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": TOKEN}):
            self.assertEqual(self.local("init", "--session-id", "session"), 0)
        cfg = Config.load(self.config_path)
        self.assertEqual(cfg.token_env, "TELEGRAM_BOT_TOKEN")
        self.assertIsNone(cfg.token)
        self.assertNotIn(TOKEN, self.config_path.read_text())

    def test_sigterm_exits_collector_and_releases_lock_preserving_queue(self):
        import signal
        import time

        from tgbridge.host import CollectorLock

        self.configured()
        with Store(self.root / "state.sqlite3") as store:
            store.receive(
                "b",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "pending",
                        },
                    }
                ],
            )
        marker = self.root / "polling"
        fixture = self.root / "runner.py"
        fixture.write_text(
            "from tgbridge.cli import main\nimport time\nfrom pathlib import Path\n"
            "class API:\n"
            " def call(self, method, params, files=None):\n"
            '  if method == "getMe": return {"id":991188,"is_bot":True}\n'
            '  if method == "getWebhookInfo": return {"url":""}\n'
            f"  Path({str(marker)!r}).touch()\n"
            "  time.sleep(.05)\n  return []\n"
            f'raise SystemExit(main(["--config",{str(self.config_path)!r},"run","--session-owned","--mode","collector-only"], api_factory=lambda token: API()))\n'
        )
        proc = subprocess.Popen(
            [sys.executable, str(fixture)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={
                **os.environ,
                "PYTHONPATH": str(SCRIPTS),
                "CODEX_THREAD_ID": "session",
                "CODEX_SESSION_ID": "session",
            },
        )
        self.addCleanup(lambda: proc.kill() if proc.poll() is None else None)
        deadline = time.monotonic() + 3
        while (
            not marker.exists() and proc.poll() is None and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        self.assertTrue(marker.exists())
        proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=3)
        self.assertEqual(proc.returncode, 0, stderr)
        self.assertNotIn(TOKEN, stdout + stderr)
        with CollectorLock(991188):
            pass
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.claim("b")["text"], "pending")

    def test_interrupted_init_can_retry_same_directory_with_new_pairing(self):
        pending = Config(
            1, "interrupted", "old-session", 991188, "owner_bot", 7, 8, token=TOKEN
        )
        pending.save(self.root / ".pending-pairing.json")
        with Store(self.root / "state.sqlite3") as store:
            store.bind(
                "interrupted",
                "old-session",
                991188,
                7,
                8,
                initial_offset=5,
                bot_username="owner_bot",
            )
        self.assertEqual(
            self.local(
                "init",
                "--session-id",
                "new-session",
                "--token-stdin",
                "--recover-setup",
                stdin=TOKEN,
            ),
            0,
        )
        cfg = Config.load(self.config_path)
        self.assertFalse((self.root / ".pending-pairing.json").exists())
        with Store(self.root / "state.sqlite3") as store:
            self.assertFalse(store.binding("interrupted")["active"])
            self.assertTrue(store.binding(cfg.binding_id)["active"])
            self.assertEqual(store.binding(cfg.binding_id)["offset"], 12)

    def test_interrupted_fresh_bind_can_retry_without_adopting_orphan_work(self):
        self.configured()
        pending = Config(
            1, "interrupted", "new-session", 991188, "owner_bot", 7, 8, token=TOKEN
        )
        pending.save(self.root / ".pending-binding.json")
        with Store(self.root / "state.sqlite3") as store:
            store.unbind("b")
            store.bind(
                "interrupted",
                "new-session",
                991188,
                7,
                8,
                initial_offset=5,
                bot_username="owner_bot",
            )
        self.assertEqual(
            self.local("bind", "--session-id", "new-session", "--recover-setup"), 0
        )
        cfg = Config.load(self.config_path)
        self.assertNotEqual(cfg.binding_id, "interrupted")
        with Store(self.root / "state.sqlite3") as store:
            self.assertFalse(store.binding("interrupted")["active"])
            self.assertEqual(store.binding(cfg.binding_id)["offset"], 12)
            self.assertIsNone(store.claim(cfg.binding_id))

    def test_interrupted_setup_does_not_silently_retire_active_staged_binding(self):
        pending = Config(
            1, "interrupted", "old-session", 991188, "owner_bot", 7, 8, token=TOKEN
        )
        pending.save(self.root / ".pending-pairing.json")
        with Store(self.root / "state.sqlite3") as store:
            store.bind(
                "interrupted", "old-session", 991188, 7, 8, bot_username="owner_bot"
            )
        self.assertEqual(
            self.local(
                "init", "--session-id", "new-session", "--token-stdin", stdin=TOKEN
            ),
            1,
        )
        self.assertFalse(self.config_path.exists())
        with Store(self.root / "state.sqlite3") as store:
            self.assertTrue(store.binding("interrupted")["active"])
        self.assertIn("--recover-setup", self.stderr.getvalue())

    def test_retry_rechecks_ambiguity_atomically_after_cli_inspection(self):
        from unittest.mock import patch

        self.configured()
        path = self.root / "state.sqlite3"
        with Store(path) as store:
            row = store.enqueue_output(
                "b", None, "notice", {"text": "canonical notice"}
            )
        original_outputs = Store.outputs

        def stale_snapshot(inspector, binding_id):
            snapshot = original_outputs(inspector, binding_id)
            with Store(path) as sender:
                self.assertEqual(sender.next_output("b")["id"], row["id"])
                sender.finish_output(row["id"], "ambiguous", error_code="network")
            return snapshot

        with patch.object(Store, "outputs", stale_snapshot):
            result = self.local("outbox", "retry", "--id", str(row["id"]))
        self.assertEqual(result, 1)
        self.assertIn("--ack-duplicate-risk", self.stderr.getvalue())
        with Store(path) as store:
            actual = store.outputs("b")[0]
            self.assertEqual(actual["state"], "ambiguous")
            self.assertEqual(actual["error_code"], "network")
        self.assertEqual(
            self.local(
                "outbox", "retry", "--id", str(row["id"]), "--ack-duplicate-risk"
            ),
            0,
        )
        with Store(path) as store:
            self.assertEqual(store.outputs("b")[0]["state"], "queued")
