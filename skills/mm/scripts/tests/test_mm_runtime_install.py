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

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent
SKILL = SCRIPTS.parent
INSTALLER = SCRIPTS / "mm_runtime_install.py"
SOURCE = SKILL / "integrations" / "claude-code" / "mm-runtime"


def tree(root: pathlib.Path) -> dict:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def literal(text: str, name: str) -> str:
    """The value of `export const <name> = <literal>` in mm-config.ts, as written."""
    for line in text.splitlines():
        if line.startswith("export const %s = " % name):
            return line[len("export const %s = " % name):]
    raise AssertionError("no export const %s in:\n%s" % (name, text))


class InstallCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.home.mkdir()
        # A folder name JSON must escape on every OS (non-ASCII) plus, on Windows, the backslashes of the path.
        bindir = self.tmp / "py \u00e9 bin"
        bindir.mkdir()
        self.python = bindir / "python.exe"
        self.python.write_text("synthetic interpreter, never run\n", encoding="utf-8")
        self.source_before = tree(SOURCE)

    def install(self, *argv):
        env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home), PYTHONDONTWRITEBYTECODE="1",
                   PYTHONIOENCODING="utf-8")
        proc = subprocess.run([sys.executable, str(INSTALLER), *[str(a) for a in argv]], capture_output=True,
                              text=True, encoding="utf-8", errors="replace", env=env)
        return proc.returncode, proc.stdout, proc.stderr

    def assert_source_unchanged(self):
        self.assertEqual(tree(SOURCE), self.source_before, "the plugin source in the skill changed")

    def assert_no_settings_written(self):
        self.assertEqual(sorted(p.relative_to(self.home).as_posix() for p in self.home.rglob("*")), [],
                         "the installer wrote under the home folder")


class InstallTests(InstallCase):
    def test_when_install_runs_it_copies_the_plugin_and_writes_escaped_paths_into_mm_config(self):
        dest = self.tmp / "installed \u00e9" / "mm-runtime"
        rc, out, err = self.install("--dest", dest, "--python", self.python)
        self.assertEqual(rc, 0, out + err)
        source = tree(SOURCE)
        copied = tree(dest)
        expected = {rel for rel in source if not rel.startswith("tests/")}
        self.assertEqual(set(copied), expected)
        self.assertTrue(any(rel.startswith("tests/") for rel in source), "the source has tests to leave out")
        self.assertFalse((dest / "tests").exists())
        for rel in expected - {"hooks/mm-config.ts"}:
            self.assertEqual(copied[rel], source[rel], rel)
        config = (dest / "hooks" / "mm-config.ts").read_text(encoding="utf-8")
        mm_py = str((SKILL / "scripts" / "mm.py").resolve())
        self.assertEqual(literal(config, "PYTHON"), json.dumps(os.path.abspath(self.python)))
        self.assertEqual(literal(config, "MM_PY"), json.dumps(mm_py))
        self.assertEqual(json.loads(literal(config, "PYTHON")), os.path.abspath(self.python))
        self.assertEqual(json.loads(literal(config, "MM_PY")), mm_py)
        self.assertNotIn("\u00e9", config, "non-ASCII must be escaped, not written raw")
        self.assertEqual(len([l for l in config.splitlines() if l.startswith("export const")]), 2)
        lines = out.splitlines()
        self.assertEqual(lines[0], "MM-RUNTIME-INSTALL-OK %s" % dest.resolve())
        self.assertIn("CLAUDE_CODE_PLUGIN_DIRS", out)
        self.assertIn("edited no settings file", out)
        self.assertIn("claude plugin validate --strict %s" % dest.resolve(), out)
        self.assert_source_unchanged()
        self.assert_no_settings_written()

    def test_when_install_runs_again_on_its_own_copy_it_rewrites_the_config(self):
        dest = self.tmp / "mm-runtime"
        self.assertEqual(self.install("--dest", dest, "--python", self.python)[0], 0)
        other = self.tmp / "py \u00e9 bin" / "python3.exe"
        other.write_text("another synthetic interpreter\n", encoding="utf-8")
        rc, out, err = self.install("--dest", dest, "--python", other)
        self.assertEqual(rc, 0, out + err)
        config = (dest / "hooks" / "mm-config.ts").read_text(encoding="utf-8")
        self.assertEqual(json.loads(literal(config, "PYTHON")), os.path.abspath(other))

    def test_when_dest_is_inside_the_skill_install_exits_2(self):
        dest = SKILL / "integrations" / "mm-runtime-copy"
        self.addCleanup(shutil.rmtree, dest, True)
        rc, out, err = self.install("--dest", dest, "--python", self.python)
        self.assertEqual(rc, 2, out + err)
        self.assertFalse(dest.exists())
        self.assertIn("inside the skill folder", err)
        self.assertEqual(out, "")
        self.assert_source_unchanged()

    def test_when_dest_is_inside_the_agents_tree_install_exits_2(self):
        dest = self.home / ".agents" / "skills" / "mm-runtime"
        rc, out, err = self.install("--dest", dest, "--python", self.python)
        self.assertEqual(rc, 2, out + err)
        self.assertFalse((self.home / ".agents").exists())
        self.assertIn(".agents", err)
        self.assertEqual(out, "")

    def test_when_dest_holds_other_files_install_exits_2_and_leaves_them(self):
        dest = self.tmp / "busy"
        dest.mkdir()
        (dest / "notes.txt").write_bytes(b"keep me\n")
        rc, out, err = self.install("--dest", dest, "--python", self.python)
        self.assertEqual(rc, 2, out + err)
        self.assertEqual(tree(dest), {"notes.txt": b"keep me\n"})
        self.assertIn("not an earlier mm-runtime copy", err)

    def test_when_python_is_not_a_file_install_exits_2(self):
        dest = self.tmp / "mm-runtime"
        rc, out, err = self.install("--dest", dest, "--python", self.tmp / "no-such-python")
        self.assertEqual(rc, 2, out + err)
        self.assertFalse(dest.exists())
        self.assertIn("--python", err)

    def test_when_dry_run_install_writes_nothing(self):
        dest = self.tmp / "dry" / "mm-runtime"
        rc, out, err = self.install("--dest", dest, "--python", self.python, "--dry-run")
        self.assertEqual(rc, 0, out + err)
        self.assertFalse((self.tmp / "dry").exists())
        lines = out.splitlines()
        self.assertEqual(lines[0], "MM-RUNTIME-INSTALL-DRY-RUN %s: nothing written" % dest.resolve())
        self.assertIn("CLAUDE_CODE_PLUGIN_DIRS", out)
        self.assertIn(json.dumps(os.path.abspath(self.python)), out)
        self.assert_source_unchanged()
        self.assert_no_settings_written()


if __name__ == "__main__":
    unittest.main()
