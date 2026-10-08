import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import subprocess
import tempfile
import shutil
import unittest

from mm_gates import (
    VacuousGate,
    GateError,
    GateContractViolation,
    GitCommandFailed,
    run_gates,
    gate_files_exist,
    gate_command_exits_zero,
    gate_diff_matches_claims,
)

PY = sys.executable


def _git(args, cwd):
    return subprocess.run(
        ["git"] + args,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )


def _init_repo(repo_dir):
    _git(["init"], repo_dir)
    _git(["config", "user.email", "test" + "@example.invalid"], repo_dir)
    _git(["config", "user.name", "mm-test"], repo_dir)
    (repo_dir / "committed.txt").write_text("hello\n", encoding="utf-8", newline="\n")
    _git(["add", "."], repo_dir)
    _git(["commit", "-m", "init"], repo_dir)


class RunGatesTest(unittest.TestCase):
    def test_empty_checks_raises_vacuous(self):
        with self.assertRaises(VacuousGate):
            run_gates([])

    def test_all_ok_reports_true(self):
        ok, checks = run_gates([{"item": "a", "ok": True, "note": "fine"}])
        self.assertTrue(ok)
        self.assertEqual(len(checks), 1)

    def test_one_failure_reports_false(self):
        ok, _ = run_gates(
            [
                {"item": "a", "ok": True, "note": "fine"},
                {"item": "b", "ok": False, "note": "broken"},
            ]
        )
        self.assertFalse(ok)

    def test_truthy_non_bool_ok_is_rejected(self):
        # RED: the string "false" is truthy in Python — a gate contract that
        # relies on truthiness would silently report this as a PASS.
        with self.assertRaises(GateContractViolation):
            run_gates([{"item": "a", "ok": "false", "note": "looks red, isn't"}])

    def test_int_ok_is_rejected(self):
        with self.assertRaises(GateContractViolation):
            run_gates([{"item": "a", "ok": 1, "note": "int is not bool"}])

    def test_passing_check_with_empty_note_is_rejected(self):
        # RED: a passing check with no evidence note is not reporting
        # evidence — must be rejected, not silently accepted.
        with self.assertRaises(GateContractViolation):
            run_gates([{"item": "a", "ok": True, "note": ""}])

    def test_failing_check_with_empty_note_is_rejected(self):
        with self.assertRaises(GateContractViolation):
            run_gates([{"item": "a", "ok": False, "note": ""}])

    def test_empty_item_is_rejected(self):
        with self.assertRaises(GateContractViolation):
            run_gates([{"item": "", "ok": True, "note": "fine"}])

    def test_missing_note_key_is_rejected(self):
        with self.assertRaises(GateContractViolation):
            run_gates([{"item": "a", "ok": True}])

    def test_contract_violation_is_a_gate_error_not_a_result(self):
        self.assertTrue(issubclass(GateContractViolation, GateError))


class GateFilesExistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_paths_raises_vacuous(self):
        with self.assertRaises(VacuousGate):
            gate_files_exist([], root=self.tmp)

    def test_missing_path_is_red_with_path_in_note(self):
        checks = gate_files_exist(["ghost.txt"], root=self.tmp)
        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0]["ok"])
        self.assertIn("ghost.txt", checks[0]["note"])

    def test_existing_path_is_green_with_evidence(self):
        target = self.tmp / "present.txt"
        target.write_text("data\n", encoding="utf-8", newline="\n")
        checks = gate_files_exist(["present.txt"], root=self.tmp)
        self.assertEqual(len(checks), 1)
        self.assertTrue(checks[0]["ok"])
        self.assertTrue(checks[0]["note"])


class GateCommandExitsZeroTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_nonzero_exit_is_red_with_stderr_and_code(self):
        argv = [PY, "-c", "import sys;sys.stderr.write('boom');sys.exit(3)"]
        checks = gate_command_exits_zero("boom cmd", argv, cwd=self.tmp)
        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0]["ok"])
        self.assertIn("boom", checks[0]["note"])
        self.assertIn("3", checks[0]["note"])

    def test_zero_exit_is_green_with_stdout_preserved(self):
        argv = [PY, "-c", "import sys;sys.stdout.write('hello-stdout');sys.exit(0)"]
        checks = gate_command_exits_zero("hello cmd", argv, cwd=self.tmp)
        self.assertEqual(len(checks), 1)
        self.assertTrue(checks[0]["ok"])
        self.assertIn("hello-stdout", checks[0]["note"])

    def test_timeout_is_red(self):
        argv = [PY, "-c", "import time;time.sleep(5)"]
        checks = gate_command_exits_zero("slow cmd", argv, cwd=self.tmp, timeout=1)
        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0]["ok"])
        self.assertIn("timed out", checks[0]["note"])


class GateDiffMatchesClaimsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        _init_repo(self.repo)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_outside_git_work_tree_is_red(self):
        not_repo = self.tmp / "not_a_repo"
        not_repo.mkdir()
        checks = gate_diff_matches_claims(["x.txt"], repo_root=not_repo)
        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0]["ok"])
        self.assertIn("not a git work tree", checks[0]["note"])

    def test_claimed_but_untouched_is_red(self):
        checks = gate_diff_matches_claims(["never_touched.txt"], repo_root=self.repo)
        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0]["ok"])
        self.assertIn("claimed but not changed", checks[0]["note"])

    def test_touched_but_unclaimed_is_red(self):
        (self.repo / "committed.txt").write_text(
            "hello again\n", encoding="utf-8", newline="\n"
        )
        checks = gate_diff_matches_claims([], repo_root=self.repo)
        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0]["ok"])
        self.assertIn("changed but not claimed", checks[0]["note"])
        self.assertIn("committed.txt", checks[0]["item"])

    def test_matching_claim_is_green(self):
        (self.repo / "committed.txt").write_text(
            "hello again\n", encoding="utf-8", newline="\n"
        )
        checks = gate_diff_matches_claims(["committed.txt"], repo_root=self.repo)
        self.assertEqual(len(checks), 1)
        self.assertTrue(checks[0]["ok"])

    def test_no_claims_no_changes_raises_vacuous(self):
        with self.assertRaises(VacuousGate):
            gate_diff_matches_claims([], repo_root=self.repo)

    def test_untracked_file_counts_as_changed(self):
        (self.repo / "new_file.txt").write_text(
            "new\n", encoding="utf-8", newline="\n"
        )
        checks = gate_diff_matches_claims(["new_file.txt"], repo_root=self.repo)
        self.assertEqual(len(checks), 1)
        self.assertTrue(checks[0]["ok"])

    def test_git_diff_failure_raises_git_command_failed_not_clean_pass(self):
        # RED: a work tree that is genuinely inside git (rev-parse succeeds)
        # but has no commits yet -> `git diff --name-only HEAD` exits 128
        # ("ambiguous argument 'HEAD'") with EMPTY stdout. Before this fix
        # that empty stdout was silently read as "nothing changed" -> a
        # gate ERROR reported as a clean PASS. Verified live:
        #   $ git init && git diff --name-only HEAD ; echo exit=$?
        #   fatal: ambiguous argument 'HEAD': unknown revision ...
        #   exit=128
        empty_repo = self.tmp / "empty_repo"
        empty_repo.mkdir()
        _git(["init"], empty_repo)
        _git(["config", "user.email", "test" + "@example.invalid"], empty_repo)
        _git(["config", "user.name", "mm-test"], empty_repo)
        with self.assertRaises(GitCommandFailed):
            gate_diff_matches_claims(["anything.txt"], repo_root=empty_repo)

    def test_git_command_failed_is_a_gate_error_not_a_result(self):
        self.assertTrue(issubclass(GitCommandFailed, GateError))


if __name__ == "__main__":
    unittest.main()
