import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from mm_envelope import validate_envelope

PY = sys.executable
VALIDATE_CLI = str(
    pathlib.Path(__file__).resolve().parent.parent / "validate_envelope.py"
)


def _valid_doc():
    return {
        "schema_version": 1,
        "session": "demo-task | Agent | phase-a",
        "task": "demo-task",
        "emitted": "2026-08-09T13:04:11+03:00",
        "status": "completed",
        "summary": "Did the work \u2014 \u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1, caf\u00e9 cr\u00e8me, all green.",
        "artifacts": ["out/report.md"],
        "changed_files": ["scripts/mm_gates.py"],
        "commit_message": "add gate checks",
        "notes_for_next_agent": "none",
        "human_action": "none",
    }


class ValidateEnvelopeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, doc):
        path = self.tmp / "session.envelope.json"
        path.write_text(
            json.dumps(doc, ensure_ascii=False, indent=2),
            encoding="utf-8",
            newline="\n",
        )
        return path

    def test_missing_file_is_red(self):
        checks, status = validate_envelope(self.tmp / "does_not_exist.json")
        self.assertTrue(any(not c["ok"] for c in checks))
        self.assertTrue(all(len(c["note"]) > 0 for c in checks))
        self.assertIsNone(status)

    def test_missing_key_is_red(self):
        doc = _valid_doc()
        del doc["commit_message"]
        path = self._write(doc)
        checks, status = validate_envelope(path)
        key_checks = [c for c in checks if c["item"] == "key:commit_message"]
        self.assertEqual(len(key_checks), 1)
        self.assertFalse(key_checks[0]["ok"])
        overall = all(c["ok"] for c in checks)
        self.assertFalse(overall)
        self.assertEqual(status, "completed")

    def test_status_not_in_enum_is_red(self):
        doc = _valid_doc()
        doc["status"] = "done"
        path = self._write(doc)
        checks, status = validate_envelope(path)
        status_checks = [c for c in checks if c["item"] == "status enum"]
        self.assertEqual(len(status_checks), 1)
        self.assertFalse(status_checks[0]["ok"])
        self.assertEqual(status, "done")

    def test_valid_envelope_with_non_ascii_text_is_green(self):
        path = self._write(_valid_doc())
        checks, status = validate_envelope(path)
        self.assertTrue(len(checks) > 0)
        self.assertTrue(all(c["ok"] for c in checks))
        self.assertEqual(status, "completed")
        self.assertTrue(any("\u03ba\u03b1\u03bb" in c["note"] for c in checks))

    def test_summary_over_400_chars_is_red(self):
        doc = _valid_doc()
        doc["summary"] = "s" * 401
        checks, status = validate_envelope(self._write(doc))
        summary = [c for c in checks if c["item"] == "summary length"]
        self.assertEqual(len(summary), 1)
        self.assertFalse(summary[0]["ok"])

    def test_invalid_json_is_red(self):
        path = self.tmp / "broken.json"
        path.write_text("{not json", encoding="utf-8", newline="\n")
        checks, status = validate_envelope(path)
        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0]["ok"])
        self.assertIsNone(status)

    def test_blocked_status_is_schema_valid(self):
        # "blocked" is a valid enum member — schema-valid, but NOT success.
        # The CLI test class below proves this becomes exit 2, not exit 0/1.
        doc = _valid_doc()
        doc["status"] = "blocked"
        path = self._write(doc)
        checks, status = validate_envelope(path)
        self.assertTrue(all(c["ok"] for c in checks))
        self.assertEqual(status, "blocked")

    def test_failed_status_is_schema_valid(self):
        doc = _valid_doc()
        doc["status"] = "failed"
        path = self._write(doc)
        checks, status = validate_envelope(path)
        self.assertTrue(all(c["ok"] for c in checks))
        self.assertEqual(status, "failed")


class ValidateEnvelopeCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, doc):
        path = self.tmp / "session.envelope.json"
        path.write_text(
            json.dumps(doc, ensure_ascii=False, indent=2),
            encoding="utf-8",
            newline="\n",
        )
        return path

    def _run(self, path):
        return subprocess.run(
            [PY, VALIDATE_CLI, str(path)],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
        )

    def test_missing_file_exits_1_with_missing_marker(self):
        proc = self._run("C:/does/not/exist.json")
        self.assertEqual(proc.returncode, 1)
        self.assertTrue(proc.stdout.startswith("MISSING ENVELOPE:"))

    def test_malformed_envelope_exits_1(self):
        doc = _valid_doc()
        del doc["commit_message"]
        path = self._write(doc)
        proc = self._run(path)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("exit 1", proc.stdout)

    def test_completed_envelope_exits_0(self):
        path = self._write(_valid_doc())
        proc = self._run(path)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("exit 0", proc.stdout)

    def test_non_ascii_envelope_prints_utf8_and_exits_0(self):
        env = dict(os.environ, PYTHONIOENCODING="cp1252")
        proc = subprocess.run([PY, VALIDATE_CLI, str(self._write(_valid_doc()))], capture_output=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("\u03ba\u03b1\u03bb".encode("utf-8"), proc.stdout)

    def test_help_flag_prints_usage_and_exits_0(self):
        proc = self._run("--help")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("usage: validate_envelope.py", proc.stdout)

    def test_failed_envelope_exits_2_not_0_or_1(self):
        doc = _valid_doc()
        doc["status"] = "failed"
        path = self._write(doc)
        proc = self._run(path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("exit 2", proc.stdout)

    def test_blocked_envelope_exits_2_not_0_or_1(self):
        doc = _valid_doc()
        doc["status"] = "blocked"
        path = self._write(doc)
        proc = self._run(path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("exit 2", proc.stdout)


if __name__ == "__main__":
    unittest.main()
