"""Harness diagnostics and startup use synthetic configuration, queues and sockets."""

import importlib
import io
import json
import os
import socket
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from tgbridge.cli import main
from tgbridge.config import Config
from tgbridge.host import CollectorLock
from tgbridge.service import Service
from tgbridge.store import Store

TOKEN = "123456:" + "X" * 30
MODES = ("collector-only", "cooperative", "task-completion", "native")


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config_path = self.root / "config.json"
        self.config = Config(
            1,
            "binding",
            "session",
            991188,
            "owner_bot",
            7,
            8,
            token_env="BRIDGE_HARNESS_ABSENT_TOKEN",
        )
        self.config.save(self.config_path)
        self.api_calls = []
        with Store(self.root / "state.sqlite3") as store:
            store.bind("binding", "session", 991188, 7, 8)
            store.receive(
                "binding",
                [
                    {
                        "update_id": 41,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "synthetic pending request",
                        },
                    }
                ],
            )
            self.before = store.status("binding")
            self.request_before = store.request("binding", 41)
            self.assertIsNotNone(self.request_before)
            self.assertEqual(self.request_before["state"], "pending")
            self.assertEqual(self.before["binding"]["offset"], 42)

    def harness(self):
        # Missing production API is an explicit behavioral failure during RED.
        try:
            return importlib.import_module("tgbridge.harness")
        except ModuleNotFoundError:
            self.fail("The safe harness report and run-mode guard are missing")

    def report(self, environ=None, config=None):
        return self.harness().harness_report(
            config or self.config, environ={} if environ is None else environ
        )

    def invoke(self, *args, environ=None):
        output, error = io.StringIO(), io.StringIO()

        def factory(token):
            self.api_calls.append(token)
            raise AssertionError("No Telegram client may be created")

        with patch.dict(os.environ, environ or {}, clear=True):
            code = main(
                ["--config", str(self.config_path), *args],
                api_factory=factory,
                stdout=output,
                stderr=error,
            )
        return code, output.getvalue(), error.getvalue()

    def assert_queue_unchanged(self):
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.status("binding"), self.before)
            self.assertEqual(store.request("binding", 41), self.request_before)

    def test_run_without_mode_never_resolves_credentials_or_starts_service(self):
        with (
            patch.object(Config, "resolve_token", side_effect=AssertionError),
            patch("tgbridge.cli.Service", side_effect=AssertionError),
        ):
            code, output, error = self.invoke("run", "--session-owned")
        self.assertEqual(code, 1)
        self.assertIn("--mode", error)
        self.assertEqual(output, "")
        self.assertEqual(self.api_calls, [])
        self.assert_queue_unchanged()

    def test_matching_identity_does_not_claim_automatic_continuation(self):
        for identity in (
            {"CODEX_THREAD_ID": "session"},
            {"CODEX_SESSION_ID": "session"},
            {"CODEX_THREAD_ID": "session", "CODEX_SESSION_ID": "session"},
        ):
            with self.subTest(identity=identity):
                report = self.report(identity)
                self.assertEqual(report["session_identity"], "matched")
                self.assertEqual(report["automatic_continuation"], "blocked")

    def test_absent_identity_and_host_report_unavailable(self):
        report = self.report({"CODEX_HOME": str(self.root)})
        self.assertEqual(report["session_identity"], "unavailable")
        self.assertEqual(report["codex_control_socket"], "unavailable")
        self.assertEqual(report["host_command"], "unconfigured")
        self.assertEqual(report["automatic_continuation"], "blocked")
        self.assertTrue(report["blocking_reasons"])

    def test_mismatched_and_conflicting_identities_block_configured_hook(self):
        cfg = replace(self.config, host_command=["/synthetic/trusted-adapter"])
        for identity in (
            {"CODEX_THREAD_ID": "other"},
            {"CODEX_SESSION_ID": "other"},
            {"CODEX_THREAD_ID": "session", "CODEX_SESSION_ID": "other"},
            {"CODEX_THREAD_ID": "other", "CODEX_SESSION_ID": "session"},
        ):
            with self.subTest(identity=identity):
                report = self.report(identity, cfg)
                self.assertEqual(report["session_identity"], "mismatch")
                self.assertEqual(report["automatic_continuation"], "blocked")

    def test_hook_presence_is_unverified_even_with_missing_codex_socket(self):
        cfg = replace(self.config, host_command=["/synthetic/trusted-adapter"])
        for identity in (
            {},
            {"CODEX_THREAD_ID": "session", "CODEX_HOME": str(self.root)},
        ):
            with self.subTest(identity=identity):
                report = self.report(identity, cfg)
                self.assertEqual(report["host_command"], "configured")
                self.assertEqual(report["automatic_continuation"], "live-unverified")

    def test_socket_metadata_missing_regular_and_unix_socket(self):
        environ = {"CODEX_THREAD_ID": "session", "CODEX_HOME": str(self.root)}
        control = self.root / "app-server-control"
        path = control / "app-server-control.sock"
        self.assertEqual(self.report(environ)["codex_control_socket"], "missing")
        control.mkdir()
        path.write_text("synthetic regular file")
        self.assertEqual(self.report(environ)["codex_control_socket"], "not-socket")
        path.unlink()
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(path))
            report = self.report(environ)
        self.assertEqual(report["codex_control_socket"], "present-unverified")
        self.assertEqual(report["automatic_continuation"], "blocked")

    def test_socket_symlink_and_symlink_parent_are_not_followed(self):
        control = self.root / "app-server-control"
        control.mkdir()
        target_dir = self.root / "target"
        target_dir.mkdir()
        target = target_dir / "app-server-control.sock"
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(target))
            link = control / "app-server-control.sock"
            link.symlink_to(target)
            environ = {"CODEX_THREAD_ID": "session", "CODEX_HOME": str(self.root)}
            self.assertEqual(self.report(environ)["codex_control_socket"], "not-socket")
            link.unlink()
            control.rmdir()
            control.symlink_to(target_dir, target_is_directory=True)
            self.assertEqual(self.report(environ)["codex_control_socket"], "not-socket")
            alias = self.root / "home-alias"
            alias.symlink_to(self.root, target_is_directory=True)
            environ["CODEX_HOME"] = str(alias)
            self.assertEqual(self.report(environ)["codex_control_socket"], "not-socket")

    def test_filesystem_errors_and_private_values_are_redacted(self):
        cfg = replace(self.config, host_command=["/private/argv-secret", TOKEN])
        environ = {
            "CODEX_THREAD_ID": "private-thread-secret",
            "CODEX_SESSION_ID": "other-secret",
            "CODEX_HOME": "/private/home-secret",
            "PRIVATE_TOKEN": TOKEN,
        }
        with patch("os.open", side_effect=PermissionError("private-error-secret")):
            report = self.report(environ, cfg)
        self.assertEqual(report["codex_control_socket"], "unavailable")
        text = json.dumps(report)
        for secret in (*environ.values(), *cfg.host_command, "private-error-secret"):
            self.assertNotIn(secret, text)
        self.assertEqual(
            set(report),
            {
                "session_identity",
                "host_command",
                "codex_control_socket",
                "automatic_continuation",
                "blocking_reasons",
            },
        )

    def test_guard_rejects_invalid_and_missing_modes_with_safe_error(self):
        harness = self.harness()
        self.assertTrue(issubclass(harness.HarnessError, ValueError))
        for mode in (None, "", "private-invalid-mode"):
            with (
                self.subTest(mode=mode),
                self.assertRaises(harness.HarnessError) as error,
            ):
                harness.validate_run_mode(self.config, mode, environ={})
            self.assertIn("--mode", str(error.exception))
            self.assertNotIn("private-invalid-mode", str(error.exception))

    def test_native_requires_hook_and_other_modes_accept_other_hosts(self):
        harness = self.harness()
        with self.assertRaises(harness.HarnessError) as error:
            harness.validate_run_mode(self.config, "native", environ={})
        self.assertIn("host_command", str(error.exception))
        for mode in MODES:
            cfg = (
                replace(self.config, host_command=["/synthetic/adapter"])
                if mode == "native"
                else self.config
            )
            report = harness.validate_run_mode(cfg, mode, environ={})
            self.assertEqual(report["session_identity"], "unavailable")

    def test_every_mode_rejects_current_session_mismatch_before_credentials(self):
        replace(self.config, host_command=["/synthetic/adapter"]).save(self.config_path)
        for mode in MODES:
            with (
                self.subTest(mode=mode),
                patch.object(Config, "resolve_token", side_effect=AssertionError),
                patch("tgbridge.cli.Service", side_effect=AssertionError),
            ):
                code, output, error = self.invoke(
                    "run",
                    "--session-owned",
                    "--mode",
                    mode,
                    environ={
                        "CODEX_THREAD_ID": "session",
                        "CODEX_SESSION_ID": "private-other",
                    },
                )
            self.assertEqual(code, 1)
            self.assertIn("session", error)
            self.assertNotIn("private-other", error)
            self.assertEqual(output, "")
        self.assertEqual(self.api_calls, [])
        self.assert_queue_unchanged()

    def test_failed_native_and_invalid_cli_modes_preserve_queue(self):
        for mode, expected_code in (("native", 1), ("private-invalid-mode", 2)):
            with (
                self.subTest(mode=mode),
                patch.object(Config, "resolve_token", side_effect=AssertionError),
            ):
                code, output, error = self.invoke(
                    "run", "--session-owned", "--mode", mode
                )
            self.assertEqual(code, expected_code)
            self.assertNotIn("private-invalid-mode", error)
            self.assertEqual(output, "")
        self.assertEqual(self.api_calls, [])
        self.assert_queue_unchanged()

    def test_durable_binding_mismatch_is_rejected_before_credentials(self):
        replace(self.config, session_id="other-session").save(self.config_path)
        for mode in ("collector-only", "cooperative", "task-completion"):
            with (
                self.subTest(mode=mode),
                patch.object(Config, "resolve_token", side_effect=AssertionError),
            ):
                code, output, error = self.invoke(
                    "run", "--session-owned", "--mode", mode
                )
            self.assertEqual(code, 1)
            self.assertIn("binding identity", error)
            self.assertEqual(output, "")
        self.assertEqual(self.api_calls, [])
        self.assert_queue_unchanged()

    def test_harness_and_doctor_are_offline_with_missing_token_environment(self):
        for command in ("harness", "doctor", "status"):
            with (
                self.subTest(command=command),
                patch.object(Config, "resolve_token", side_effect=AssertionError),
            ):
                code, output, error = self.invoke(command)
                self.assertEqual(code, 0, error)
                result = json.loads(output)
                if command != "harness":
                    self.assertIn("harness", result)
                report = result if command == "harness" else result["harness"]
                self.assertEqual(report["automatic_continuation"], "blocked")
                if command != "harness":
                    self.assertEqual(
                        result["verification"],
                        {
                            "automatic_continuation": "blocked",
                            "canonical_output_capture": "live-unverified",
                            "session_lifecycle": "live-unverified",
                        },
                    )
                    self.assertIn("blocked", result["idle_behavior"])
        self.assertEqual(self.api_calls, [])
        self.assert_queue_unchanged()

    def test_all_modes_emit_observation_before_bounded_service(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                cfg = replace(
                    self.config,
                    token_env=None,
                    token=TOKEN,
                    host_command=["/synthetic/adapter"] if mode == "native" else [],
                )
                cfg.save(self.config_path)
                output, error = io.StringIO(), io.StringIO()
                observations = []

                class BoundedService:
                    def __init__(inner, config, store, api, *, host=None):
                        pass

                    def run(inner, stop, observations=observations, output=output):
                        observations.append(json.loads(output.getvalue()))

                with (
                    patch.dict(os.environ, {}, clear=True),
                    patch("tgbridge.cli.Service", BoundedService),
                ):
                    code = main(
                        [
                            "--config",
                            str(self.config_path),
                            "run",
                            "--session-owned",
                            "--mode",
                            mode,
                        ],
                        api_factory=lambda token: object(),
                        stdout=output,
                        stderr=error,
                    )
                self.assertEqual(code, 0, error.getvalue())
                self.assertEqual(len(observations), 1)
                self.assertEqual(observations[0]["mode"], mode)
                self.assertEqual(
                    observations[0]["automatic_continuation"],
                    "live-unverified" if mode == "native" else "blocked",
                )
                self.assertNotRegex(
                    output.getvalue(), r'"(?:ready|connected|verified)"'
                )
                self.assertNotIn(TOKEN, output.getvalue() + error.getvalue())
        self.assert_queue_unchanged()

    def test_collector_only_does_not_execute_configured_host_hook(self):
        cfg = replace(
            self.config,
            token_env=None,
            token=TOKEN,
            host_command=["/synthetic/trusted-adapter"],
        )
        cfg.save(self.config_path)

        def bounded_run(service, stop):
            # Exercise the real collector's pending-work dispatch, not a fake hook.
            self.assertEqual(service.config.private_state_dir, self.root)
            service._notify_pending()

        output = io.StringIO()
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("tgbridge.cli.Service.run", bounded_run),
            patch("tgbridge.host.subprocess.Popen", side_effect=AssertionError),
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
                api_factory=lambda token: object(),
                stdout=output,
                stderr=io.StringIO(),
            )
        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(output.getvalue())["automatic_continuation"], "blocked"
        )
        self.assertEqual(Config.load(self.config_path).host_command, cfg.host_command)
        self.assert_queue_unchanged()

    def test_task_completion_accepts_host_assertion_without_native_command(self):
        harness = self.harness()
        for environ in ({}, {"CODEX_THREAD_ID": "session"}):
            with self.subTest(identity_available=bool(environ)):
                try:
                    report = harness.validate_run_mode(
                        self.config, "task-completion", environ=environ
                    )
                except harness.HarnessError:
                    self.fail(
                        "Verified external host task completion needs no native hook"
                    )
                self.assertEqual(report["host_command"], "unconfigured")
                self.assertEqual(report["automatic_continuation"], "blocked")
        self.assert_queue_unchanged()

    def test_task_completion_collects_and_sends_without_launching_configured_hook(self):
        cfg = replace(
            self.config,
            token_env=None,
            token=TOKEN,
            host_command=["/synthetic/private-adapter", "synthetic-argv-secret"],
        )
        cfg.save(self.config_path)
        config_before = self.config_path.read_bytes()
        with Store(self.root / "state.sqlite3") as store:
            row = store.enqueue_output(
                "binding", None, "notice", {"text": "synthetic queued output"}
            )
        sent = threading.Event()
        calls = []

        class SyntheticAPI:
            stop = None
            delivered = False

            def call(inner, method, params, files=None):
                calls.append((method, params))
                if method == "getMe":
                    return {"id": cfg.bot_id, "is_bot": True}
                if method == "getWebhookInfo":
                    return {"url": ""}
                if method == "sendMessage":
                    sent.set()
                    return {"message_id": 91}
                if method == "getUpdates":
                    if not inner.delivered:
                        inner.delivered = True
                        return [
                            {
                                "update_id": 42,
                                "message": {
                                    "chat": {"id": 7, "type": "private"},
                                    "from": {"id": 8},
                                    "text": "synthetic host-notified request",
                                },
                            }
                        ]
                    if not sent.wait(2):
                        raise AssertionError("Synthetic sender did not drain output")
                    inner.stop.set()
                    return []
                raise AssertionError("Unexpected synthetic API operation")

        api = SyntheticAPI()
        real_run = Service.run

        def bounded_run(service, stop):
            api.stop = stop
            return real_run(service, stop)

        def factory(token):
            self.assertEqual(token, TOKEN)
            return api

        output, error = io.StringIO(), io.StringIO()
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("tgbridge.cli.Service.run", bounded_run),
            patch(
                "tgbridge.service.CollectorLock",
                side_effect=lambda bot: CollectorLock(
                    bot, runtime_dir=self.root / "locks"
                ),
            ),
            patch(
                "tgbridge.host.subprocess.Popen",
                side_effect=AssertionError("No adapter or model may launch"),
            ),
        ):
            code = main(
                [
                    "--config",
                    str(self.config_path),
                    "run",
                    "--session-owned",
                    "--mode",
                    "task-completion",
                ],
                api_factory=factory,
                stdout=output,
                stderr=error,
            )
        self.assertEqual(code, 0, error.getvalue())
        observation = json.loads(output.getvalue())
        self.assertEqual(observation["mode"], "task-completion")
        self.assertEqual(observation["automatic_continuation"], "blocked")
        self.assertIn("host task-completion notifications", observation["execution"])
        self.assertIn("same existing session", observation["execution"])
        self.assertIn("live verification", observation["execution"])
        for secret in (TOKEN, *cfg.host_command, str(self.root)):
            self.assertNotIn(secret, output.getvalue() + error.getvalue())
        self.assertNotIn(json.dumps(cfg.session_id), output.getvalue())
        self.assertEqual(self.config_path.read_bytes(), config_before)
        self.assertIn(
            ("sendMessage", {"chat_id": 7, "text": "synthetic queued output"}), calls
        )
        with Store(self.root / "state.sqlite3") as store:
            self.assertTrue(store.binding("binding")["active"])
            self.assertEqual(store.binding("binding")["offset"], 43)
            self.assertEqual(store.request("binding", 41)["state"], "pending")
            self.assertEqual(store.request("binding", 42)["state"], "pending")
            self.assertEqual(store.outputs("binding")[0]["id"], row["id"])
            self.assertEqual(store.outputs("binding")[0]["state"], "sent")
        # Only the actual consumer's ordinary wait may claim stored work.
        code, output, error = self.invoke("wait", "--timeout", "0")
        self.assertEqual(code, 0, error)
        claim = json.loads(output)
        self.assertEqual(claim["request_id"], 41)
        self.assertEqual(claim["session_id"], cfg.session_id)
        self.assertEqual(claim["source"], "telegram")
        with Store(self.root / "state.sqlite3") as store:
            self.assertEqual(store.request("binding", 41)["state"], "running")
            self.assertEqual(store.request("binding", 42)["state"], "pending")
