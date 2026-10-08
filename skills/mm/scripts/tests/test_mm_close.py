import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import datetime
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import mm
import mm_ledger

ENTRY = """---
agent: builder
session: s-1
started: 2026-01-01T09:00:00+00:00
emitted: 2026-01-01T10:00:00+00:00
status: completed
task_ref: #1
---

## What was done
- Built the widget.

## What's next
- none

## Blockers
- none

## Files changed
- none

## Evidence
- none

## Notes for PM
- none
"""


class CloseCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        home = self.tmp / "home"
        home.mkdir()
        env = {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state"), "HOME": str(home),
               "USERPROFILE": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(home / "gitconfig"),
               "GIT_CEILING_DIRECTORIES": str(self.tmp), "GIT_AUTHOR_NAME": "Test Operator",
               "GIT_AUTHOR_EMAIL": "operator" + "@example.invalid", "GIT_COMMITTER_NAME": "Test Operator",
               "GIT_COMMITTER_EMAIL": "operator" + "@example.invalid"}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = self.tmp / "repo"
        self.active = self.repo / ".private" / "pm" / "active"
        self.task = self.active / "widget"
        self.done = self.repo / ".private" / "pm" / "done" / "widget"

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue() + err.getvalue()

    def ok(self, *argv):
        rc, output = self.mm(*argv)
        self.assertEqual(rc, 0, output)
        return output

    def git(self, *argv):
        proc = subprocess.run(["git", *argv], cwd=self.repo, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def scaffold(self):
        self.ok("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "smoke-project",
                "--row", "Build the widget", "--row", "Show the widget page")
        (self.task / "inbox" / "20260101-100000-builder.md").write_text(ENTRY, encoding="utf-8")
        prompts = self.task / ".codex-prompts"
        prompts.mkdir()
        (prompts / "review.md").write_text("Review the widget.\n", encoding="utf-8")
        self.ok("set-section", "--task-dir", self.task, "--id", "3", "--text", "- see .codex-prompts/review.md")

    def defer(self):
        for rid in ("#1", "#2"):
            self.ok("retire-row", "--task-dir", self.task, "--id", rid, "--reason", "deferred at close: trial ends")

    def consume(self):
        """The Update flow's last act: the read entries leave the inbox."""
        self.ok("inbox-archive", "--task-dir", self.task, "--all")

    def git_repo(self):
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-qm", "seed")

    def failing_hook(self):
        hook = self.repo / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\necho hook-says-no\nexit 1\n", encoding="utf-8", newline="\n")
        hook.chmod(0o755)
        return hook


class CloseTests(CloseCase):
    def test_close_dry_run_lists_open_rows_and_writes_nothing(self):
        self.scaffold()
        before = sorted(p.as_posix() for p in self.task.rglob("*"))
        rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator")
        self.assertEqual(rc, 5, output)
        self.assertIn("#1", output)
        self.assertIn("#2", output)
        self.assertIn("deferred at close", output)
        rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(rc, 5, output)
        self.assertEqual(sorted(p.as_posix() for p in self.task.rglob("*")), before)
        self.defer()
        rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator")
        self.assertEqual(rc, 20, output)
        self.consume()
        rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator")
        self.assertEqual(rc, 0, output)
        self.assertIn("dry run", output)
        self.assertTrue(self.task.is_dir())
        self.assertFalse(self.done.exists())

    def test_close_apply_archives_and_moves_the_task_to_done(self):
        self.scaffold()
        self.defer()
        self.consume()
        self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertFalse(self.task.exists())
        doc = mm_ledger.load_ledger(self.done)
        wrap = doc["rows"][-1]
        self.assertEqual(wrap["state"], "DONE")
        self.assertEqual(wrap["history"][-1]["evidence"], "human:Test Operator")
        self.assertEqual(doc["dashboard_index"]["Status"], "done")
        today = datetime.date.today().isoformat()
        self.assertTrue((self.done / ("insights_archive_%s.md" % today)).is_file())
        self.assertFalse((self.done / "insights.md").exists())
        self.assertTrue((self.done / "inbox" / "processed" / "2026-01" / "20260101-100000-builder.md").is_file())
        self.assertFalse((self.done / ".codex-prompts").exists())
        self.assertTrue((self.done / "archive" / "codex-prompts" / "review.md").is_file())
        self.assertIn("archive/codex-prompts/review.md", doc["passthrough"]["section_3_md"])
        self.assertEqual(self.ok("check", "--task-dir", self.done).strip().splitlines()[-1], "MM-CHECK-OK")

    def test_close_is_one_commit_covering_the_old_and_new_paths(self):
        self.git_repo()
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "on"}):
            self.scaffold()
            self.defer()
            self.consume()
            self.track_prompts()
            head = self.git("rev-parse", "HEAD").strip()
            self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(self.git("rev-list", "--count", head + "..HEAD").strip(), "1")
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(), "mm(widget): close widget")
        files = self.git("show", "--name-status", "--format=", "HEAD")
        self.assertIn(".private/pm/done/widget/ledger.json", files)
        self.assertIn(".private/pm/done/widget/archive/codex-prompts/review.md", files)
        self.assertIn(".private/pm/active/widget/insights.md", files)
        self.assertEqual(self.git("ls-files", "--", ".private/pm/active/widget").strip(), "")
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all").strip(), "")

    def assert_finished_once(self):
        self.assertFalse(self.task.exists())
        doc = mm_ledger.load_ledger(self.done)
        wrap = doc["rows"][-1]
        self.assertEqual(wrap["state"], "DONE")
        self.assertEqual(sum(1 for h in wrap["history"] if h.get("to") == "DONE"), 1)
        self.assertEqual(doc["dashboard_index"]["Status"], "done")
        today = datetime.date.today().isoformat()
        self.assertTrue((self.done / ("insights_archive_%s.md" % today)).is_file())
        self.assertFalse((self.done / "insights.md").exists())
        self.assertTrue((self.done / "inbox" / "processed" / "2026-01" / "20260101-100000-builder.md").is_file())
        self.assertTrue((self.done / "archive" / "codex-prompts" / "review.md").is_file())
        self.assertEqual([p.name for p in self.done.glob("close-journal*")], [])
        self.assertEqual(self.ok("check", "--task-dir", self.done).strip().splitlines()[-1], "MM-CHECK-OK")

    def test_when_close_fails_midway_it_exits_19_and_a_rerun_finishes_it(self):
        self.scaffold()
        self.defer()
        self.consume()
        real = os.rename

        def no_rename(src, dst):
            if pathlib.Path(dst).name.startswith("insights_archive_"):
                raise OSError("disk full")
            real(src, dst)

        with mock.patch("os.rename", no_rename):
            rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(rc, 19, output)
        self.assertIn("close-journal.json", output)
        self.assertIn("--apply", output)
        self.assertTrue(self.task.is_dir())
        self.assertEqual(mm_ledger.load_ledger(self.task)["rows"][-1]["state"], "DONE")
        self.assertTrue((self.task / "insights.md").is_file())
        rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator")
        self.assertEqual(rc, 0, output)
        self.assertIn("resume", output)
        self.assertIn("left: insights, move, commit", output)
        self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assert_finished_once()

    def test_when_the_folder_move_fails_a_rerun_moves_it_and_commits_once(self):
        self.git_repo()
        real = os.rename

        def no_move(src, dst):
            if pathlib.Path(dst) == self.done:
                raise PermissionError("the folder is open in another program")
            real(src, dst)

        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "on"}):
            self.scaffold()
            self.defer()
            self.consume()
            self.track_prompts()
            head = self.git("rev-parse", "HEAD").strip()
            with mock.patch("os.rename", no_move):
                rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
            self.assertEqual(rc, 19, output)
            self.assertEqual(self.git("rev-parse", "HEAD").strip(), head)
            self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assert_finished_once()
        self.assertEqual(self.git("rev-list", "--count", head + "..HEAD").strip(), "1")
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all").strip(), "")

    def test_close_refuses_when_the_done_folder_exists(self):
        self.scaffold()
        self.defer()
        self.done.mkdir(parents=True)
        rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(rc, 4, output)
        self.assertTrue((self.task / "insights.md").is_file())
        self.assertEqual(mm_ledger.load_ledger(self.task)["rows"][-1]["state"], "BACKLOG")

    def track_prompts(self):
        self.git("add", "--", ".private/pm/active/widget/.codex-prompts")
        self.git("commit", "-qm", "operator commits the prompt folder")

    def status(self):
        return sorted(l for l in self.git("status", "--porcelain", "--untracked-files=all").splitlines() if l.strip())

    def test_close_commits_only_what_it_changed_or_renamed_never_an_operator_file(self):
        self.git_repo()
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "on"}):
            self.scaffold()
            self.defer()
            self.consume()
            self.track_prompts()
            notes = self.task / "notes.md"
            notes.write_text("committed notes\n", encoding="utf-8", newline="\n")
            self.git("add", "--", ".private/pm/active/widget/notes.md")
            self.git("commit", "-qm", "operator notes")
            notes.write_text("committed notes\noperator edit, not staged\n", encoding="utf-8", newline="\n")
            (self.task / "draft.md").write_text("operator draft, never added\n", encoding="utf-8", newline="\n")
            head = self.git("rev-parse", "HEAD").strip()
            self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(self.git("rev-list", "--count", head + "..HEAD").strip(), "1")
        tracked = self.git("ls-files", "--", ".private/pm").splitlines()
        self.assertNotIn(".private/pm/done/widget/draft.md", tracked)
        self.assertIn(".private/pm/done/widget/notes.md", tracked)
        self.assertIn(".private/pm/done/widget/archive/codex-prompts/review.md", tracked)
        self.assertIn(".private/pm/done/widget/ledger.json", tracked)
        self.assertEqual([t for t in tracked if t.startswith(".private/pm/active/")], [])
        self.assertEqual(self.git("show", "HEAD:.private/pm/done/widget/notes.md"), "committed notes\n")
        self.assertEqual(self.status(), [" M .private/pm/done/widget/notes.md", "?? .private/pm/done/widget/draft.md"])
        self.assertEqual((self.done / "draft.md").read_text(encoding="utf-8"), "operator draft, never added\n")
        self.assertIn("operator edit, not staged", (self.done / "notes.md").read_text(encoding="utf-8"))
        self.assertEqual(self.git("diff", "--cached", "--name-only").strip(), "")

    def commit_fails_then_rerun(self, rerun_dir):
        self.git_repo()
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "on"}):
            self.scaffold()
            self.defer()
            self.consume()
            self.track_prompts()
            head = self.git("rev-parse", "HEAD").strip()
            hook = self.failing_hook()
            rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
            self.assertEqual(rc, 13, output)
            self.assertIn("hook-says-no", output)
            self.assertNotIn("MM-CLOSE-OK", output)
            self.assertTrue((self.done / "close-journal.json").is_file(), output)
            self.assertIn("--apply", output)
            self.assertEqual(self.git("rev-parse", "HEAD").strip(), head)
            self.assertEqual(self.git("diff", "--cached", "--name-only").strip(), "")
            rc, output = self.mm("close", "--task-dir", rerun_dir(), "--operator", "Test Operator")
            self.assertEqual(rc, 0, output)
            self.assertIn("left: commit", output)
            hook.unlink()
            output = self.ok("close", "--task-dir", rerun_dir(), "--operator", "Test Operator", "--apply")
        self.assertIn("MM-CLOSE-OK", output)
        self.assert_finished_once()
        self.assertEqual(self.git("rev-list", "--count", head + "..HEAD").strip(), "1")
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(), "mm(widget): close widget")
        self.assertEqual(self.git("ls-files", "--", ".private/pm/active").strip(), "")
        self.assertEqual(self.status(), [])

    def test_when_the_close_commit_fails_a_rerun_from_the_active_path_commits_it(self):
        self.commit_fails_then_rerun(lambda: self.task)

    def test_when_the_close_commit_fails_a_rerun_from_the_done_path_commits_it(self):
        self.commit_fails_then_rerun(lambda: self.done)

    def test_close_refuses_with_20_while_the_inbox_holds_unprocessed_or_malformed_entries(self):
        self.scaffold()
        self.defer()
        before = sorted(p.as_posix() for p in self.task.rglob("*"))
        for apply in ((), ("--apply",)):
            rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", *apply)
            self.assertEqual(rc, 20, output)
            self.assertIn("20260101-100000-builder.md", output)
            self.assertIn("inbox-archive", output)
            self.assertIn("update", output.lower())
        self.assertEqual(sorted(p.as_posix() for p in self.task.rglob("*")), before)
        self.assertEqual(mm_ledger.load_ledger(self.task)["rows"][-1]["state"], "BACKLOG")
        self.consume()
        bad = self.task / "inbox" / "20260102-100000-reviewer.md"
        bad.write_text("an agent report with no frontmatter\n", encoding="utf-8")
        rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(rc, 20, output)
        self.assertIn("20260102-100000-reviewer.md", output)
        self.assertIn("MALFORMED", output)
        self.assertTrue(bad.is_file())
        self.assertTrue(self.task.is_dir())
        self.ok("inbox-archive", "--task-dir", self.task, "--entry", bad.name)
        self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertTrue((self.done / "inbox" / "processed" / "2026-01" / bad.name).is_file())

    def late_entry(self, step, folder_of):
        """Wrap close step `step` so an agent's report lands in the inbox while it runs."""
        import mm_cli_close
        real = mm_cli_close.STEP_FUNCTIONS[step]
        name = "20260101-110000-late-agent.md"

        def step_with_late_entry(args, folder, journal):
            result = real(args, folder, journal)
            (folder_of(result) / "inbox" / name).write_text(ENTRY, encoding="utf-8")
            return result

        return mock.patch.dict(mm_cli_close.STEP_FUNCTIONS, {step: step_with_late_entry}), name

    def test_when_an_entry_arrives_before_the_move_close_stops_with_20_and_keeps_the_journal(self):
        self.scaffold()
        self.defer()
        self.consume()
        patch, name = self.late_entry("insights", lambda folder: folder)
        with patch:
            rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(rc, 20, output)
        self.assertIn(name, output)
        self.assertTrue(self.task.is_dir())
        self.assertFalse(self.done.exists())
        self.assertTrue((self.task / "inbox" / name).is_file())
        self.assertTrue((self.task / "close-journal.json").is_file())
        self.ok("inbox-archive", "--task-dir", self.task, "--entry", name)
        self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assert_finished_once()

    def test_when_an_entry_arrives_after_the_move_close_stops_with_20_before_the_commit(self):
        self.git_repo()
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "on"}):
            self.scaffold()
            self.defer()
            self.consume()
            self.track_prompts()
            head = self.git("rev-parse", "HEAD").strip()
            patch, name = self.late_entry("move", lambda folder: folder)
            with patch:
                rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
            self.assertEqual(rc, 20, output)
            self.assertIn(name, output)
            self.assertEqual(self.git("rev-parse", "HEAD").strip(), head)
            self.assertTrue((self.done / "close-journal.json").is_file())
            self.assertTrue((self.done / "inbox" / name).is_file())
            self.ok("inbox-archive", "--task-dir", self.done, "--entry", name)
            self.ok("close", "--task-dir", self.done, "--operator", "Test Operator", "--apply")
        self.assertFalse(self.task.exists())
        self.assertEqual([p.name for p in self.done.glob("close-journal*")], [])
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(), "mm(widget): close widget")
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all").strip(), "")

    def test_when_the_journal_write_after_a_step_fails_close_exits_19_naming_the_disk_state(self):
        import mm_cli_close
        self.scaffold()
        self.defer()
        self.consume()
        real, calls = mm_cli_close._save, []

        def save_fails_after_the_first_step(folder, journal):
            calls.append(list(journal["done"]))
            if journal["done"] == ["ledger"]:
                raise OSError("disk full")
            real(folder, journal)

        with mock.patch.object(mm_cli_close, "_save", save_fails_after_the_first_step):
            rc, output = self.mm("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assertEqual(rc, 19, output)
        self.assertIn("ledger", output)
        self.assertIn("disk full", output)
        self.assertIn("finished step 'ledger' on disk", output)
        self.assertIn("records done: none", output)
        self.assertIn(str(self.task), output)
        self.assertEqual(mm_ledger.load_ledger(self.task)["rows"][-1]["state"], "DONE")
        self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        self.assert_finished_once()


if __name__ == "__main__":
    unittest.main()
