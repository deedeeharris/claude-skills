import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import unittest

import mm_preflight
from mm_preflight import PreflightFailed, resolve_executable, preflight, probe_version


class ResolveExecutableTest(unittest.TestCase):
    def test_python_resolves_to_known_absolute_path(self):
        self.assertEqual(resolve_executable("python"), sys.executable)

    def test_unknown_name_raises(self):
        with self.assertRaises(PreflightFailed):
            resolve_executable("not_a_known_tool")

    def test_nonexistent_candidates_raise_listing_every_candidate_tried(self):
        original = dict(mm_preflight.KNOWN_EXECUTABLES)
        mm_preflight.KNOWN_EXECUTABLES["ghost_tool"] = [
            "C:/definitely/not/here/ghost.exe",
            "ghost_tool_binary_xyz_does_not_exist",
        ]
        try:
            with self.assertRaises(PreflightFailed) as ctx:
                resolve_executable("ghost_tool")
            msg = str(ctx.exception)
            self.assertIn("C:/definitely/not/here/ghost.exe", msg)
            self.assertIn("ghost_tool_binary_xyz_does_not_exist", msg)
        finally:
            mm_preflight.KNOWN_EXECUTABLES.clear()
            mm_preflight.KNOWN_EXECUTABLES.update(original)

    def test_rejects_windowsapps_store_stub_without_touching_real_home(self):
        import shutil
        import tempfile

        original = dict(mm_preflight.KNOWN_EXECUTABLES)
        fake_home = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, fake_home, True)
        fake_stub = str(
            fake_home
            / "AppData"
            / "Local"
            / "Microsoft"
            / "WindowsApps"
            / "fake_python.exe"
        )
        stub_path = pathlib.Path(fake_stub)
        stub_path.parent.mkdir(parents=True, exist_ok=True)
        stub_path.write_text("stub", encoding="utf-8", newline="\n")
        mm_preflight.KNOWN_EXECUTABLES["store_stub_tool"] = [fake_stub]
        try:
            with self.assertRaises(PreflightFailed) as ctx:
                resolve_executable("store_stub_tool")
            self.assertIn("rejected", str(ctx.exception))
        finally:
            mm_preflight.KNOWN_EXECUTABLES.clear()
            mm_preflight.KNOWN_EXECUTABLES.update(original)
            stub_path.unlink(missing_ok=True)

    def test_rejects_venv_python(self):
        original = dict(mm_preflight.KNOWN_EXECUTABLES)
        import tempfile

        tmp_dir = pathlib.Path(tempfile.mkdtemp())
        venv_python = tmp_dir / "venv" / "Scripts" / "python.exe"
        venv_python.parent.mkdir(parents=True, exist_ok=True)
        venv_python.write_text("stub", encoding="utf-8", newline="\n")
        mm_preflight.KNOWN_EXECUTABLES["python"] = [str(venv_python)]
        try:
            with self.assertRaises(PreflightFailed):
                resolve_executable("python")
        finally:
            mm_preflight.KNOWN_EXECUTABLES.clear()
            mm_preflight.KNOWN_EXECUTABLES.update(original)
            import shutil

            shutil.rmtree(tmp_dir, ignore_errors=True)


class ProbeVersionTest(unittest.TestCase):
    def test_red_nonzero_exit_is_treated_as_preflight_failure(self):
        # RED: exe exists (real python) but the "version" invocation exits
        # non-zero — this is exactly the false-green shape (broken shim /
        # foreign venv / Store stub) that probe_version must catch.
        with self.assertRaises(PreflightFailed) as ctx:
            probe_version(
                sys.executable,
                ["-c", "import sys; sys.exit(3)"],
            )
        msg = str(ctx.exception)
        self.assertIn("3", msg)
        self.assertIn(sys.executable, msg)

    def test_green_zero_exit_returns_version_string(self):
        # GREEN: real, working interpreter, exits 0 -> version string returned.
        version = probe_version(sys.executable, ["--version"])
        self.assertIn("Python", version)


class PreflightTest(unittest.TestCase):
    def test_empty_requirements_is_rejected_not_a_vacuous_pass(self):
        # RED: zero requirements is a failure to configure, not a clean
        # bill of health — preflight() must not return {} silently.
        with self.assertRaises(PreflightFailed) as ctx:
            preflight([])
        self.assertIn("zero requirements", str(ctx.exception))

    def test_collects_all_problems_before_raising(self):
        original = dict(mm_preflight.KNOWN_EXECUTABLES)
        mm_preflight.KNOWN_EXECUTABLES["ghost_a"] = ["C:/nope/a.exe"]
        mm_preflight.KNOWN_EXECUTABLES["ghost_b"] = ["C:/nope/b.exe"]
        try:
            with self.assertRaises(PreflightFailed) as ctx:
                preflight([("ghost_a", ["--version"]), ("ghost_b", ["--version"])])
            msg = str(ctx.exception)
            self.assertIn("ghost_a", msg)
            self.assertIn("ghost_b", msg)
        finally:
            mm_preflight.KNOWN_EXECUTABLES.clear()
            mm_preflight.KNOWN_EXECUTABLES.update(original)

    def test_success_returns_path_and_version_per_tool(self):
        result = preflight([("python", ["--version"])])
        self.assertIn("python", result)
        self.assertEqual(result["python"]["path"], sys.executable)
        self.assertIn("Python", result["python"]["version"])


if __name__ == "__main__":
    unittest.main()
