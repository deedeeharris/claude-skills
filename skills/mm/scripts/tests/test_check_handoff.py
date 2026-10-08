import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

PYTHON = sys.executable
MM_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
HOOK_SCRIPT = MM_ROOT / "hooks" / "check-handoff.py"
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"
DIRTY_FIXTURE = FIXTURES / "handoff_dirty.md"
CLEAN_FIXTURE = FIXTURES / "handoff_clean.md"


def run_cli(path):
    return subprocess.run(
        [PYTHON, str(HOOK_SCRIPT), "--check", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def run_hook(stdin_text):
    return subprocess.run(
        [PYTHON, str(HOOK_SCRIPT)],
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


class CliModeTests(unittest.TestCase):
    def test_dirty_fixture_exits_1_and_names_line_number(self):
        result = run_cli(DIRTY_FIXTURE)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Line 13:", result.stderr)

    def test_clean_fixture_exits_0_and_prints_nothing(self):
        result = run_cli(CLEAN_FIXTURE)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def test_unanchored_mid_line_occurrence_of_anchored_symptom_does_not_trip(self):
        # Regression proof for ANCHOR_AT_LINE_START: handoff_clean.md contains
        # the literal substring "old content below" mid-sentence (not at line
        # start). If anchoring were ever removed or broken — falling back to
        # plain substring matching like the other four patterns — this exact
        # fixture line would start failing. Without this case, an anchoring
        # regression is invisible: the dirty fixture's line-start occurrence
        # would still match under plain substring matching too.
        text = CLEAN_FIXTURE.read_text(encoding="utf-8")
        self.assertIn("old content below", text)
        for line in text.splitlines():
            stripped = line.lstrip(" -*>").lstrip()
            if "old content below" in line.lower():
                self.assertFalse(
                    stripped.lower().startswith("old content below"),
                    "fixture's unanchored occurrence must not be line-anchored",
                )
        result = run_cli(CLEAN_FIXTURE)
        self.assertEqual(result.returncode, 0)


class HookModeTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_dirty_handoff_path_emits_parseable_context(self):
        target = self.tmpdir / "HANDOFF.md"
        shutil.copyfile(DIRTY_FIXTURE, target)
        event = json.dumps({"tool_input": {"file_path": str(target)}})

        result = run_hook(event)

        self.assertEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        ctx = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("No Archaeology", ctx)

    def test_clean_handoff_path_prints_nothing(self):
        target = self.tmpdir / "HANDOFF.md"
        shutil.copyfile(CLEAN_FIXTURE, target)
        event = json.dumps({"tool_input": {"file_path": str(target)}})

        result = run_hook(event)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_non_handoff_path_exits_0_and_prints_nothing(self):
        target = self.tmpdir / "notes.md"
        shutil.copyfile(DIRTY_FIXTURE, target)
        event = json.dumps({"tool_input": {"file_path": str(target)}})

        result = run_hook(event)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_garbage_stdin_exits_0(self):
        result = run_hook("not valid json {{{")

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_bash_command_naming_compiler_finds_and_scans_recent_handoff(self):
        # mm_compile.py (the compiled/ledger workflow's authoritative HANDOFF.md
        # writer) runs via the Bash tool, not a matched edit tool, so tool_input
        # carries no file_path. The hook must fall back to locating the
        # HANDOFF.md the command just wrote.
        target = self.tmpdir / "task" / "HANDOFF.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(DIRTY_FIXTURE, target)
        event = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "python3 scripts/mm_compile.py"},
            "cwd": str(self.tmpdir),
        })

        result = run_hook(event)

        self.assertEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        ctx = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("No Archaeology", ctx)

    def test_bash_command_not_naming_handoff_or_compiler_is_ignored(self):
        target = self.tmpdir / "task" / "HANDOFF.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(DIRTY_FIXTURE, target)
        event = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "npm test"},
            "cwd": str(self.tmpdir),
        })

        result = run_hook(event)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_bash_command_ignores_stale_handoff_outside_recent_write_window(self):
        target = self.tmpdir / "task" / "HANDOFF.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(DIRTY_FIXTURE, target)
        stale = time.time() - 3600
        os.utime(target, (stale, stale))
        event = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "python3 scripts/mm_compile.py"},
            "cwd": str(self.tmpdir),
        })

        result = run_hook(event)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
