"""Host protocol tests with real child processes and advisory locks."""

import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

if importlib.util.find_spec("tgbridge.host"):
    from tgbridge.host import CollectorLock, Host, HostError, process_identity
else:
    Host = None


class HostTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Host, "Host implementation is missing")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def hook(self, source, *, timeout=5):
        script = self.root / "hook.py"
        script.write_text(source)
        return Host(
            [sys.executable, str(script)], "binding", "session", timeout=timeout
        )

    def test_stdin_protocol_never_interpolates_untrusted_content(self):
        capture = self.root / "capture.json"
        host = self.hook(
            "import json,sys\ne=json.load(sys.stdin)\n"
            f'open({str(capture)!r}, "w").write(json.dumps(e))\n'
            'print(json.dumps({"status":"accepted"}))'
        )
        text = f"$(touch {self.root / 'pwned'}); `echo secret`"
        result = host.send("interrupt", request_id=44, generation=2, text=text)
        self.assertEqual(result["status"], "accepted")
        event = json.loads(capture.read_text())
        self.assertEqual(event["session_id"], "session")
        self.assertEqual(event["binding_id"], "binding")
        self.assertEqual(event["request_id"], 44)
        self.assertEqual(event["text"], text)
        self.assertEqual(event["ownership"], "claim_required")
        self.assertFalse((self.root / "pwned").exists())

    def test_zero_exit_is_not_native_ack_and_failures_are_redacted(self):
        for source in (
            'print("token secret")',
            "import sys; sys.exit(9)",
            'print(\'{"status":"unsupported","reason":"TOKEN"}\')',
        ):
            with self.subTest(source=source):
                result = self.hook(source).send(
                    "stop", generation=3, canceled_request_ids=[1]
                )
                self.assertEqual(result["status"], "unsupported")
                self.assertNotIn("TOKEN", json.dumps(result))
                self.assertNotIn("secret", json.dumps(result))
        self.assertEqual(Host([], "b", "s").send("notify")["status"], "unsupported")

    def test_timeout_is_bounded_and_stop_scope_is_explicit(self):
        start = time.monotonic()
        result = self.hook("import time; time.sleep(30)", timeout=0.1).send(
            "stop", generation=4, canceled_request_ids=[9]
        )
        self.assertLess(time.monotonic() - start, 2)
        self.assertEqual(result["reason"], "timeout")
        capture = self.root / "stop.json"
        host = self.hook(
            "import json,sys\ne=json.load(sys.stdin)\n"
            f'open({str(capture)!r},"w").write(json.dumps(e))\n'
            'print(\'{"status":"accepted"}\')'
        )
        host.send("stop", generation=4, canceled_request_ids=[9])
        event = json.loads(capture.read_text())
        self.assertEqual(event["scope"], "binding_session_tasks")
        self.assertEqual(event["canceled_request_ids"], [9])
        self.assertEqual(event["generation"], 4)
        with self.assertRaises(HostError):
            Host([], "b", "s", timeout=6)

    def test_bot_lock_excludes_other_config_paths_and_releases(self):
        with CollectorLock(991122, runtime_dir=self.root):
            with (
                self.assertRaises(HostError),
                CollectorLock(991122, runtime_dir=self.root),
            ):
                pass
            with CollectorLock(991123, runtime_dir=self.root):
                pass
        with CollectorLock(991122, runtime_dir=self.root):
            pass
        self.assertIsNotNone(process_identity(os.getpid()))
        self.assertIsNone(process_identity(999999999))

    def test_lock_refuses_symlink(self):
        (self.root / "991122.lock").symlink_to(self.root / "victim")
        with self.assertRaises(HostError), CollectorLock(991122, runtime_dir=self.root):
            pass

    def test_default_lock_directory_does_not_depend_on_process_tmpdir(self):
        from unittest.mock import patch

        first = CollectorLock(991122).root
        with patch("tempfile.gettempdir", return_value=str(self.root)):
            second = CollectorLock(991122).root
        self.assertEqual(first, second)
