import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import build_pm_dashboard
import mm_atomic


WELL_FORMED_0A = """## Section 0A Dashboard Index

- Project: Demo Project
- Task: Task Alpha
- Status: active
- Last updated: 2026-08-01 10:00
- Target finish date: 2026-08-20
- Target week: 2026-W34
- Deadline type: target
- Schedule confidence: medium
- At risk: no
- Owner: alice
- Waiting on: none
- Priority: 3
- Category: infra
- Strategic value: 3
- Money value: 3
- Energy cost: medium
- Review cadence: weekly
- Next human decision: none
- Next agent action: continue build
- Blockers summary: none
- Executive note: none
"""

# Missing the "Energy cost" field on purpose -> malformed (out of order / missing field).
MALFORMED_0A = """## Section 0A Dashboard Index

- Project: Demo Project
- Task: Task Beta
- Status: active
- Last updated: 2026-08-01 10:00
- Target finish date: 2026-08-20
- Target week: 2026-W34
- Deadline type: target
- Schedule confidence: medium
- At risk: no
- Owner: bob
- Waiting on: none
- Priority: 3
- Category: infra
- Strategic value: 3
- Money value: 3
- Review cadence: weekly
- Next human decision: none
- Next agent action: continue build
- Blockers summary: none
- Executive note: none
"""


def _make_root(tmpdir):
    root = pathlib.Path(tmpdir)
    active = root / ".private" / "pm" / "active"
    (active / "task-alpha").mkdir(parents=True)
    (active / "task-alpha" / "HANDOFF.md").write_text(
        "# HANDOFF — task-alpha\n\n" + WELL_FORMED_0A, encoding="utf-8", newline="\n"
    )
    (active / "task-beta").mkdir(parents=True)
    (active / "task-beta" / "HANDOFF.md").write_text(
        "# HANDOFF — task-beta\n\n" + MALFORMED_0A, encoding="utf-8", newline="\n"
    )
    return root


class BuildAndWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_writes_three_files_prints_marker_and_reports_malformed_task(self):
        root = _make_root(self.tmpdir)

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = build_pm_dashboard.build_and_write(root)
        output = buf.getvalue()
        lines = output.splitlines()

        self.assertEqual(rc, 0)
        self.assertTrue(lines, "expected stdout output")
        self.assertRegex(lines[-1], r"^MM-DASHBOARD-OK ")
        self.assertIn("unprocessed inbox", output)
        self.assertIn("missing target date", output)

        pm_root = root / ".private" / "pm"
        self.assertTrue((pm_root / "DASHBOARD.md").is_file())
        self.assertTrue((pm_root / "dashboard.json").is_file())
        self.assertTrue((pm_root / "DASHBOARD.html").is_file())

        dashboard_md = (pm_root / "DASHBOARD.md").read_text(encoding="utf-8")
        self.assertIn("Task Beta", dashboard_md)
        self.assertIn("### Malformed Section 0A", dashboard_md)

    def test_self_test_flag_exits_zero(self):
        self.assertEqual(build_pm_dashboard.run_self_test(), 0)


class DashboardCommitTests(unittest.TestCase):
    DASHBOARD = [".private/pm/DASHBOARD.html", ".private/pm/DASHBOARD.md", ".private/pm/dashboard.json"]

    def setUp(self):
        self.tmpdir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmpdir, True)
        home = self.tmpdir / "home"
        home.mkdir()
        patcher = mock.patch.dict(os.environ, {
            "MM_AUTO_COMMIT": "on", "HOME": str(home), "USERPROFILE": str(home), "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": str(home / "gitconfig"), "GIT_CEILING_DIRECTORIES": str(self.tmpdir),
            "GIT_AUTHOR_NAME": "Test Operator", "GIT_AUTHOR_EMAIL": "operator" + "@example.invalid",
            "GIT_COMMITTER_NAME": "Test Operator", "GIT_COMMITTER_EMAIL": "operator" + "@example.invalid"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.root = _make_root(self.tmpdir / "repo")
        self.git("init", "-q", "-b", "main")
        (self.root / "README.md").write_text("seed\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-qm", "seed")
        (self.root / ".private" / "pm" / "operator-notes.md").write_text("mine\n", encoding="utf-8")

    def git(self, *argv):
        proc = subprocess.run(["git", *argv], cwd=self.root, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def build(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = build_pm_dashboard.build_and_write(self.root)
        return rc, out.getvalue(), err.getvalue()

    def test_rebuild_commits_exactly_the_three_dashboard_files(self):
        rc, out, err = self.build()
        self.assertEqual(rc, 0, out + err)
        self.assertRegex(out.splitlines()[-1], r"^MM-DASHBOARD-OK ")
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(), "mm(dashboard): rebuild the repo dashboard")
        self.assertEqual(sorted(self.git("show", "--name-only", "--format=", "HEAD").split()), self.DASHBOARD)
        untracked = self.git("status", "--porcelain", "--untracked-files=all")
        self.assertIn("?? .private/pm/operator-notes.md", untracked)
        self.assertIn("?? .private/pm/active/task-alpha/HANDOFF.md", untracked)

    def test_rebuild_refuses_to_commit_while_anything_is_staged(self):
        (self.root / "staged.txt").write_text("operator work\n", encoding="utf-8")
        self.git("add", "staged.txt")
        rc, out, err = self.build()
        self.assertEqual(rc, 13, out + err)
        self.assertIn("auto-commit refused", err)
        self.assertEqual(self.git("diff", "--cached", "--name-only").split(), ["staged.txt"])
        self.assertEqual(self.git("log", "--format=%s").split(), ["seed"])
        self.assertTrue((self.root / ".private" / "pm" / "DASHBOARD.md").is_file())

    def test_when_the_commit_is_refused_the_success_marker_never_prints(self):
        (self.root / "staged.txt").write_text("operator work\n", encoding="utf-8")
        self.git("add", "staged.txt")
        rc, out, err = self.build()
        self.assertEqual(rc, 13, out + err)
        self.assertNotIn("MM-DASHBOARD-OK", out + err)
        self.assertIn("DASHBOARD.md", out)


class WriteFailureLeavesExistingFileUntouchedTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_atomic_write_many_failure_preserves_prior_dashboard_and_omits_marker(self):
        # Drives the REAL mm_atomic.atomic_write_many (not a stub that raises
        # before touching anything): all three destinations pre-exist, the
        # first file's replace is allowed to genuinely happen, then the
        # second replace is made to fail, exercising the real rollback path
        # (mm_atomic restores an already-swapped destination from its
        # retained prior bytes when a later replace in the batch fails).
        # This proves actual rollback behavior, not just "never attempted".
        root = _make_root(self.tmpdir)
        pm_root = root / ".private" / "pm"
        pm_root.mkdir(parents=True, exist_ok=True)
        pre_md = "PRE-EXISTING DASHBOARD CONTENT\n"
        pre_json = '{"pre": "existing"}\n'
        pre_html = "<html>pre-existing</html>\n"
        (pm_root / "DASHBOARD.md").write_text(pre_md, encoding="utf-8", newline="\n")
        (pm_root / "dashboard.json").write_text(pre_json, encoding="utf-8", newline="\n")
        (pm_root / "DASHBOARD.html").write_text(pre_html, encoding="utf-8", newline="\n")

        real_replace = mm_atomic._replace_with_retry
        call_count = {"n": 0}

        def fail_on_second_replace(tmp, path, retries, retry_delay_s):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise mm_atomic.AtomicWriteError("simulated failure on second item")
            return real_replace(tmp, path, retries, retry_delay_s)

        buf_out = io.StringIO()
        buf_err = io.StringIO()
        with mock.patch.object(mm_atomic, "_replace_with_retry", side_effect=fail_on_second_replace):
            with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
                rc = build_pm_dashboard.build_and_write(root)

        self.assertEqual(rc, 1)
        self.assertEqual((pm_root / "DASHBOARD.md").read_text(encoding="utf-8"), pre_md)
        self.assertEqual((pm_root / "dashboard.json").read_text(encoding="utf-8"), pre_json)
        self.assertEqual((pm_root / "DASHBOARD.html").read_text(encoding="utf-8"), pre_html)
        for line in buf_out.getvalue().splitlines():
            self.assertFalse(line.startswith("MM-DASHBOARD-OK"), "marker must not print on failure")
        self.assertIn("dashboard write failed", buf_err.getvalue())


if __name__ == "__main__":
    unittest.main()
