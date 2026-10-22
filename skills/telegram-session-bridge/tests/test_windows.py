"""Native Windows privacy, process ownership and durable collector regressions."""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tgbridge.config import Config, ConfigError
from tgbridge.harness import harness_report, validate_run_mode
from tgbridge.host import CollectorLock, Host, HostError, process_identity
from tgbridge.privatefs import check_private, private_directory, safe_path
from tgbridge.service import Service, prepare_request, publish
from tgbridge.store import Store, StoreError

if os.name == "nt":
    import ntsecuritycon
    import win32security
    from tgbridge.windows_security import current_sid


@unittest.skipUnless(os.name == "nt", "Native Windows API tests")
class WindowsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private"
        private_directory(self.root)

    def config(self):
        return Config(
            1,
            "binding",
            "session",
            991177,
            "owner_bot",
            7,
            8,
            token_env="TEST_BRIDGE_TOKEN",
        )

    def grant_everyone(self, path):
        acl = win32security.ACL()
        acl.AddAccessAllowedAce(
            win32security.ACL_REVISION, ntsecuritycon.FILE_ALL_ACCESS, current_sid()
        )
        acl.AddAccessAllowedAce(
            win32security.ACL_REVISION,
            ntsecuritycon.FILE_GENERIC_READ,
            win32security.ConvertStringSidToSid("S-1-1-0"),
        )
        win32security.SetNamedSecurityInfo(
            str(path),
            win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION
            | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            acl,
            None,
        )

    def test_config_and_database_are_private_and_roundtrip(self):
        config = self.config()
        path = self.root / "config.json"
        config.save(path)
        config.save(path)
        self.assertEqual(Config.load(path).session_id, "session")
        check_private(path)
        check_private(self.root, directory=True)
        with Store(self.root / "state.sqlite3") as store:
            store.bind("binding", "session", 991177, 7, 8)
        check_private(self.root / "state.sqlite3")

    def test_config_rejects_file_and_directory_with_everyone_access(self):
        config = self.config()
        path = self.root / "config.json"
        config.save(path)
        self.grant_everyone(path)
        with self.assertRaises(ConfigError):
            Config.load(path)
        self.grant_everyone(self.root)
        with self.assertRaises(ConfigError):
            config.save(path)
        with self.assertRaises(StoreError):
            Store(self.root / "state.sqlite3")

    def test_config_accepts_owner_rights_only_for_current_owner(self):
        path = self.root / "config.json"
        self.config().save(path)
        acl = win32security.ACL()
        acl.AddAccessAllowedAce(
            win32security.ACL_REVISION,
            ntsecuritycon.FILE_ALL_ACCESS,
            win32security.ConvertStringSidToSid("S-1-3-4"),
        )
        win32security.SetNamedSecurityInfo(
            str(path),
            win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION
            | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            acl,
            None,
        )
        self.assertEqual(Config.load(path).session_id, "session")

    def test_output_with_public_outbox_raises_store_error_without_admission(self):
        source = self.root / "private-message.bin"
        source.write_bytes(b"original")
        outbox = self.root / "outbox"
        private_directory(outbox)
        self.grant_everyone(outbox)
        with Store(self.root / "state.sqlite3") as store:
            store.bind("binding", "session", 991177, 7, 8)
            store.receive(
                "binding",
                [
                    {
                        "update_id": 1,
                        "message": {
                            "chat": {"id": 7, "type": "private"},
                            "from": {"id": 8},
                            "text": "attachment request",
                        },
                    }
                ],
            )
            store.claim("binding")
            with self.assertRaises(StoreError) as caught:
                store.enqueue_output("binding", 1, "final", {"path": source})
            self.assertNotIn(source.name, str(caught.exception))
            self.assertEqual(store.outputs("binding"), [])
            self.assertEqual(store.request("binding", 1)["state"], "running")
        self.assertEqual(source.read_bytes(), b"original")
        self.assertEqual(list(outbox.iterdir()), [])
        with self.assertRaises(ValueError):
            check_private(outbox, directory=True)

    def test_junction_and_alternate_stream_paths_are_rejected(self):
        junction = Path(self.temp.name) / "junction"
        result = subprocess.run(
            [
                str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"),
                "/d",
                "/c",
                "mklink",
                "/J",
                str(junction),
                str(self.root),
            ],
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.addCleanup(lambda: junction.rmdir() if junction.exists() else None)
        with self.assertRaises(ValueError):
            safe_path(junction / "config.json")
        with self.assertRaises(ValueError):
            safe_path(self.root / "config.json:hidden")

    def test_lock_excludes_another_process_and_releases_after_close(self):
        code = (
            "import sys; from tgbridge.host import CollectorLock,HostError; "
            "lock=CollectorLock(991177,runtime_dir=sys.argv[1]); "
            "lock.__enter__()"
        )
        with CollectorLock(991177, runtime_dir=self.root):
            other = subprocess.run(
                [sys.executable, "-c", code, str(self.root)],
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(other.returncode, 0)
            self.assertIn(b"HostError", other.stderr)
            with (
                self.assertRaises(HostError),
                CollectorLock(991177, runtime_dir=self.root),
            ):
                pass
        other = subprocess.run(
            [sys.executable, "-c", code, str(self.root)],
            capture_output=True,
            check=False,
        )
        self.assertEqual(other.returncode, 0, other.stderr)

    def test_process_identity_detects_owner_exit(self):
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"]
        )
        try:
            self.assertIsNotNone(process_identity(process.pid))
            self.assertEqual(
                process_identity(process.pid), process_identity(process.pid)
            )
            process.terminate()
            process.wait(timeout=5)
            self.assertIsNone(process_identity(process.pid))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_hook_timeout_stops_descendant_process(self):
        child_pid = self.root / "child.pid"
        script = self.root / "hook.py"
        script.write_text(
            "import subprocess,sys,time\n"
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])\n"
            f"open({str(child_pid)!r},'w').write(str(p.pid))\n"
            "time.sleep(30)\n",
            encoding="utf-8",
        )
        result = Host(
            [sys.executable, str(script)], "binding", "session", timeout=1
        ).send("notify")
        self.assertEqual(result, {"status": "unsupported", "reason": "timeout"})
        self.assertTrue(child_pid.exists(), "Hook did not reach descendant creation")
        pid = int(child_pid.read_text())
        deadline = time.monotonic() + 3
        while process_identity(pid) is not None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertIsNone(process_identity(pid))

    def test_harness_allows_matching_cooperative_identity_without_posix_socket(self):
        environment = {
            "CODEX_SESSION_ID": "session",
            "CODEX_THREAD_ID": "session",
            "CODEX_HOME": str(self.root),
        }
        report = harness_report(self.config(), environ=environment)
        self.assertEqual(report["session_identity"], "matched")
        self.assertEqual(report["codex_control_socket"], "unavailable")
        validate_run_mode(self.config(), "cooperative", environ=environment)

    def test_collector_claim_attachment_and_publication_preserve_original_bytes(self):
        from test_service import FakeTelegram

        config = self.config()
        config.save(self.root / "config.json")
        with Store(self.root / "state.sqlite3") as store:
            store.bind("binding", "session", 991177, 7, 8)
            api = FakeTelegram()
            api.updates = [
                {
                    "update_id": 1,
                    "message": {
                        "chat": {"id": 7, "type": "private"},
                        "from": {"id": 8},
                        "text": "attachment request",
                        "document": {
                            "file_id": "file-one",
                            "file_name": "input.bin",
                            "file_size": 10,
                        },
                    },
                }
            ]
            service = Service(config, store, api)
            self.assertTrue(service.step())
            self.assertEqual(store.request("binding", 1)["state"], "pending")
            request = store.claim("binding")
            prepared = prepare_request(config, store, request, api)
            self.assertEqual(prepared["source"], "telegram")
            self.assertEqual(
                Path(prepared["attachments"][0]["path"]).read_bytes(),
                b"\x00\xfforiginal",
            )
            check_private(Path(prepared["attachments"][0]["path"]))
            artifact = self.root / "report.bin"
            artifact.write_bytes(b"original\x00bytes")
            publish(
                config,
                store,
                1,
                source="telegram",
                kind="final",
                attachments=[artifact],
            )
            artifact.write_bytes(b"edited later")
            snapshot = Path(store.outputs("binding")[0]["payload"]["path"])
            self.assertEqual(snapshot.read_bytes(), b"original\x00bytes")
            check_private(snapshot)
            service.drain_one()
            self.assertEqual(store.outputs("binding")[0]["state"], "sent")
            self.assertEqual(api.calls[-1][0], "sendDocument")
            store.complete("binding", 1)
            self.assertEqual(store.request("binding", 1)["state"], "completed")


if __name__ == "__main__":
    unittest.main()
