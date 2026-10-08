import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import ast
import contextlib
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import mm
import mm_git

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent


class GitCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        home = self.tmp / "home"
        home.mkdir()
        env = {
            "MM_AUTO_COMMIT": "on", "MM_STATE_DIR": str(self.tmp / "state"), "HOME": str(home),
            "USERPROFILE": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(home / "gitconfig"),
            "GIT_CEILING_DIRECTORIES": str(self.tmp), "GIT_AUTHOR_NAME": "Test Operator",
            "GIT_AUTHOR_EMAIL": "operator" + "@example.invalid", "GIT_COMMITTER_NAME": "Test Operator",
            "GIT_COMMITTER_EMAIL": "operator" + "@example.invalid",
        }
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-qm", "seed")
        self.task = self.repo / ".private" / "pm" / "active" / "git-task"

    def git(self, *argv, cwd=None):
        proc = subprocess.run(["git", *argv], cwd=cwd or self.repo, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        self.assertEqual(proc.returncode, 0, "git %s: %s" % (" ".join(argv), proc.stderr))
        return proc.stdout

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue() + err.getvalue()

    def scaffold(self):
        rc, output = self.mm("scaffold", "--task-dir", self.task, "--task", "git-task", "--project", "smoke-project",
                             "--row", "Git row one")
        self.assertEqual(rc, 0, output)

    def head(self):
        return self.git("rev-parse", "HEAD").strip()

    def subject(self):
        return self.git("log", "-1", "--format=%s").strip()

    def committed_files(self, ref="HEAD"):
        return [l for l in self.git("show", "--name-only", "--format=", ref).splitlines() if l.strip()]

    def staged(self):
        return [l for l in self.git("diff", "--cached", "--name-only").splitlines() if l.strip()]

    def pending(self):
        return self.git("status", "--porcelain", "--", ".private/pm/active/git-task").strip()


class AutoCommitTests(GitCase):
    def test_auto_commit_commits_only_task_pm_paths(self):
        (self.repo / "src").mkdir()
        (self.repo / "src" / "x.py").write_text("x = 1\n", encoding="utf-8")
        (self.repo / "README.md").write_text("seed\nchanged by a builder\n", encoding="utf-8")
        self.scaffold()
        files = self.committed_files()
        self.assertTrue(files)
        for name in files:
            self.assertTrue(name.startswith(".private/pm/active/git-task/"), name)
        self.assertIn(".private/pm/active/git-task/ledger.json", files)
        self.assertIn(".private/pm/active/git-task/HANDOFF.md", files)
        status = self.git("status", "--porcelain")
        self.assertIn("?? src/", status)
        self.assertIn(" M README.md", status)
        self.assertEqual(self.pending(), "")

    def test_auto_commit_refuses_when_unrelated_file_is_prestaged_and_leaves_it_uncommitted(self):
        self.scaffold()
        (self.repo / "src").mkdir()
        (self.repo / "src" / "x.py").write_text("x = 1\n", encoding="utf-8")
        self.git("add", "src/x.py")
        before = self.head()
        rc, output = self.mm("add-row", "--task-dir", self.task, "--item", "Staged-work row")
        self.assertEqual(rc, 13, output)
        self.assertIn("src/x.py", output)
        self.assertEqual(self.head(), before)
        self.assertEqual(self.staged(), ["src/x.py"])
        self.assertNotEqual(self.pending(), "")
        self.assertIn("Staged-work row", (self.task / "ledger.json").read_text(encoding="utf-8"))
        self.git("reset", "-q", "--", "src/x.py")
        rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "go")
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.pending(), "")
        self.assertIn("Staged-work row", self.git("show", "HEAD:.private/pm/active/git-task/ledger.json"))
        self.assertEqual(self.git("ls-files", "--", "src/x.py").strip(), "")

    def test_auto_commit_refuses_during_rebase(self):
        self.scaffold()
        before = self.head()
        git_dir = self.repo / ".git"
        for name in ("rebase-merge", "rebase-apply"):
            (git_dir / name).mkdir()
            rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action",
                                 "--value", name)
            self.assertEqual(rc, 13, output)
            self.assertIn("rebase", output)
            (git_dir / name).rmdir()
        self.assertEqual(self.head(), before)
        self.assertNotEqual(self.pending(), "")

    def test_auto_commit_refuses_during_merge_or_cherry_pick(self):
        self.scaffold()
        before = self.head()
        git_dir = self.repo / ".git"
        for name, word in (("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")):
            (git_dir / name).write_text(before + "\n", encoding="utf-8")
            rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action",
                                 "--value", word)
            self.assertEqual(rc, 13, output)
            self.assertIn(word, output)
            (git_dir / name).unlink()
        self.assertEqual(self.head(), before)

    def test_auto_commit_refuses_on_detached_head(self):
        self.scaffold()
        self.git("checkout", "-q", "--detach")
        before = self.head()
        rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "d")
        self.assertEqual(rc, 13, output)
        self.assertIn("detached", output)
        self.assertEqual(self.head(), before)
        self.git("checkout", "-q", "main")

    def test_auto_commit_outside_git_is_a_noop_with_note(self):
        task = self.tmp / "plain" / ".private" / "pm" / "active" / "loose-task"
        rc, output = self.mm("scaffold", "--task-dir", task, "--task", "loose-task", "--project", "smoke-project")
        self.assertEqual(rc, 0, output)
        self.assertIn("not in a git work tree", output)
        self.assertTrue((task / "ledger.json").is_file())

    def test_auto_commit_message_is_mm_task_verb_what(self):
        self.scaffold()
        self.assertTrue(self.subject().startswith("mm(git-task): scaffold "), self.subject())
        rc, output = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.subject(), "mm(git-task): set-row #1 IMPLEMENTING")
        batch = self.tmp / "ops.json"
        batch.write_text('[{"op": "add-row", "item": "a"}, {"op": "add-row", "item": "b"}]', encoding="utf-8")
        rc, output = self.mm("batch", "--task-dir", self.task, "--file", batch)
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.subject(), "mm(git-task): batch 2 ops")

    def test_auto_commit_setting_off_skips_commit(self):
        self.scaffold()
        before = self.head()
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off"}):
            rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "a")
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.head(), before)
        rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "b",
                             "--no-commit")
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.head(), before)
        overlay = self.tmp / "mm.local.md"
        overlay.write_text("```yaml\nauto_commit: off\n```\n", encoding="utf-8")
        with mock.patch.object(mm_git, "OVERLAY", overlay), mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": ""}):
            rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "c")
            self.assertEqual(rc, 0, output)
            self.assertEqual(self.head(), before)
            with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "on"}):
                rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action",
                                     "--value", "d")
            self.assertEqual(rc, 0, output)
        self.assertNotEqual(self.head(), before)
        self.assertEqual(self.pending(), "")

    def test_auto_commit_never_pushes(self):
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True, capture_output=True)
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-q", "-u", "origin", "main")
        pushed = self.git("--git-dir", str(remote), "rev-parse", "refs/heads/main").strip()
        self.scaffold()
        rc, output = self.mm("add-row", "--task-dir", self.task, "--item", "Local only")
        self.assertEqual(rc, 0, output)
        self.assertNotEqual(self.head(), pushed)
        self.assertEqual(self.git("--git-dir", str(remote), "rev-parse", "refs/heads/main").strip(), pushed)
        self.assertEqual(self.git("--git-dir", str(remote), "for-each-ref", "--format=%(refname)").split(),
                         ["refs/heads/main"])
        tree = ast.parse((SCRIPTS / "mm_git.py").read_text(encoding="utf-8"))
        literals = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        self.assertFalse(literals & {"push", "-A", "--all", "-a", "--no-verify", "."})

    def test_auto_commit_hook_failure_exits_13_and_shows_the_hook_output(self):
        self.scaffold()
        hook = self.repo / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\necho hook-says-no\nexit 1\n", encoding="utf-8", newline="\n")
        hook.chmod(0o755)
        before = self.head()
        rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "h")
        self.assertEqual(rc, 13, output)
        self.assertIn("hook-says-no", output)
        self.assertEqual(self.head(), before)

    def test_when_a_file_inside_the_task_is_prestaged_auto_commit_refuses_and_leaves_it_staged(self):
        self.scaffold()
        insights = self.task / "insights.md"
        insights.write_text(insights.read_text(encoding="utf-8") + "\noperator draft, staged\n", encoding="utf-8")
        self.git("add", "--", ".private/pm/active/git-task/insights.md")
        before = self.head()
        rc, output = self.mm("add-row", "--task-dir", self.task, "--item", "Row while insights is staged")
        self.assertEqual(rc, 13, output)
        self.assertIn("insights.md", output)
        self.assertEqual(self.head(), before)
        self.assertEqual(self.staged(), [".private/pm/active/git-task/insights.md"])
        self.assertNotIn("operator draft", self.git("show", "HEAD:.private/pm/active/git-task/insights.md"))

    def test_when_a_task_file_has_unstaged_operator_edits_auto_commit_leaves_it_out(self):
        self.scaffold()
        insights = self.task / "insights.md"
        insights.write_text(insights.read_text(encoding="utf-8") + "\noperator draft, not staged\n", encoding="utf-8")
        rc, output = self.mm("add-row", "--task-dir", self.task, "--item", "Row beside an operator edit")
        self.assertEqual(rc, 0, output)
        files = self.committed_files()
        self.assertIn(".private/pm/active/git-task/ledger.json", files)
        self.assertNotIn(".private/pm/active/git-task/insights.md", files)
        self.assertIn(" M .private/pm/active/git-task/insights.md", self.git("status", "--porcelain"))
        self.assertEqual(self.staged(), [])

    def test_when_the_commit_fails_auto_commit_restores_the_index(self):
        self.scaffold()
        hook = self.repo / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8", newline="\n")
        hook.chmod(0o755)
        rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "r")
        self.assertEqual(rc, 13, output)
        self.assertEqual(self.staged(), [])
        self.assertIn("index was restored", output)
        self.assertNotEqual(self.pending(), "")

    def test_when_a_sandbox_blocks_the_git_index_lock_the_refusal_says_so(self):
        self.scaffold()
        head = self.head()
        real = mm_git._git
        for reason in ("Permission denied", "Operation not permitted", "Read-only file system"):
            def sandboxed(argv, cwd, stdin=None, reason=reason):
                if argv[0] == "add":
                    lock = pathlib.Path(self.repo, ".git", "index.lock")
                    return subprocess.CompletedProcess(["git"] + list(argv), 128, "",
                                                       "fatal: Unable to create '%s': %s\n" % (lock, reason))
                return real(argv, cwd, stdin)

            with self.subTest(reason=reason), mock.patch.object(mm_git, "_git", sandboxed):
                rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action",
                                     "--value", "next " + reason)
                self.assertEqual(rc, 13, output)
                self.assertIn("is not writable by this process", output)
                self.assertIn("possible causes: a sandbox that blocks writes to .git", output)
                self.assertIn("Codex --sandbox workspace-write", output)
                self.assertIn("the folder's permissions", output)
                self.assertNotIn("it runs in a sandbox", output)
                self.assertIn("the operator commits", output)
                self.assertEqual(self.head(), head)
                self.assertEqual(self.staged(), [])

    def test_when_nothing_could_be_staged_the_refusal_does_not_claim_unstaging_failed(self):
        self.scaffold()
        real = mm_git._git
        lock = pathlib.Path(self.repo, ".git", "index.lock")

        def sandboxed(argv, cwd, stdin=None):
            if argv[0] in ("add", "reset", "rm", "update-index"):
                return subprocess.CompletedProcess(["git"] + list(argv), 128, "",
                                                   "fatal: Unable to create '%s': Permission denied\n" % lock)
            return real(argv, cwd, stdin)

        with mock.patch.object(mm_git, "_git", sandboxed):
            rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "s")
        self.assertEqual(rc, 13, output)
        self.assertEqual(self.staged(), [])
        self.assertNotIn("unstaging failed", output)
        self.assertIn("nothing was left staged", output)

    def test_when_unstaging_fails_and_files_stay_staged_the_refusal_names_them(self):
        self.scaffold()
        real = mm_git._git

        def stuck(argv, cwd, stdin=None):
            if argv[0] == "commit" or argv[0] in ("reset", "rm"):
                return subprocess.CompletedProcess(["git"] + list(argv), 1, "", "error: simulated\n")
            return real(argv, cwd, stdin)

        with mock.patch.object(mm_git, "_git", stuck):
            rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "u")
        self.assertEqual(rc, 13, output)
        self.assertIn("unstaging failed; still staged: .private/pm/active/git-task/", output)
        self.git("reset", "-q")

    def test_auto_commit_of_an_ignored_task_folder_is_a_noop_with_note(self):
        (self.repo / ".gitignore").write_text(".private/\n", encoding="utf-8")
        before = self.head()
        rc, output = self.mm("scaffold", "--task-dir", self.task, "--task", "git-task", "--project", "p")
        self.assertEqual(rc, 0, output)
        self.assertIn("ignored", output)
        self.assertEqual(self.head(), before)

    def test_status_lists_uncommitted_pm_changes(self):
        self.scaffold()
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off"}):
            self.assertEqual(self.mm("add-row", "--task-dir", self.task, "--item", "Pending row")[0], 0)
        rc, output = self.mm("status", "--task-dir", self.task)
        self.assertEqual(rc, 0, output)
        self.assertIn("Uncommitted PM changes:", output)
        self.assertIn("ledger.json", output.split("Uncommitted PM changes:")[1])

    def test_when_git_status_fails_status_reports_the_failure_not_none(self):
        self.scaffold()
        (self.repo / ".git" / "index").write_bytes(b"not an index")
        proc = subprocess.run(["git", "status", "--porcelain"], cwd=self.repo, capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        first = next(l.strip() for l in proc.stderr.splitlines() if l.strip())
        rc, output = self.mm("status", "--task-dir", self.task)
        self.assertEqual(rc, 0, output)
        section = output.split("Uncommitted PM changes:")[1]
        self.assertNotIn("- none", section)
        self.assertIn("git status failed: " + first, section)

    def test_when_a_git_call_fails_status_and_auto_commit_report_its_first_error_line(self):
        self.scaffold()
        real = mm_git._git
        for failing in (("rev-parse", "--show-toplevel"), ("rev-parse", "--show-prefix"), ("check-ignore",),
                        ("symbolic-ref",), ("diff", "--quiet")):
            def broken(argv, cwd, stdin=None, failing=failing):
                if all(word in argv for word in failing):
                    return subprocess.CompletedProcess(["git"] + list(argv), 128, "",
                                                       "fatal: detected dubious ownership in repository\n"
                                                       "To add an exception for this directory, call:\n")
                return real(argv, cwd, stdin)

            head, before = self.head(), (self.task / "ledger.json").read_bytes()
            with self.subTest(failing=failing), mock.patch.object(mm_git, "_git", broken):
                rc, output = self.mm("set-field", "--task-dir", self.task, "--field", "Next agent action",
                                     "--value", "next " + " ".join(failing))
                self.assertIn("failed: fatal: detected dubious ownership in repository", output)
                if failing == ("rev-parse", "--show-toplevel"):
                    self.assertEqual(rc, 21, output)
                    self.assertEqual((self.task / "ledger.json").read_bytes(), before)
                    result = mm_git.auto_commit(self.task, "mm(git-task): probe", paths=[self.task / "ledger.json"])
                    self.assertEqual(result.code, 13, result.note)
                    output = result.note
                    self.assertIn("failed: fatal: detected dubious ownership in repository", output)
                else:
                    self.assertEqual(rc, 13, output)
                for wrong in ("not in a git work tree", "detached", "is ignored by git", "nothing to commit",
                              "To add an exception"):
                    self.assertNotIn(wrong, output)
                self.assertEqual(self.head(), head)
                if failing[0] == "rev-parse":
                    section = self.mm("status", "--task-dir", self.task)[1].split("Uncommitted PM changes:")[1]
                    self.assertNotIn("- none", section)
                    self.assertIn("failed: fatal: detected dubious ownership in repository", section)


class LineEndingTests(GitCase):
    """check compares raw bytes: any line-ending rewrite is a hand edit, except
    the exact form git itself writes on checkout of content it already holds."""

    NAMES = ("HANDOFF.md", "ROADMAP.html")

    def check(self, task):
        rc, output = self.mm("check", "--task-dir", task)
        return rc, output

    def test_when_line_endings_are_rewritten_outside_git_check_fails(self):
        task = self.tmp / "plain" / ".private" / "pm" / "active" / "loose-task"
        rc, output = self.mm("scaffold", "--task-dir", task, "--task", "loose-task", "--project", "p", "--row", "r")
        self.assertEqual(rc, 0, output)
        for name in self.NAMES:
            path = task / name
            original = path.read_bytes()
            for edited in (original.replace(b"\n", b"\r\n"), original.replace(b"\n", b"\r\n", 1)):
                path.write_bytes(edited)
                rc, output = self.check(task)
                self.assertEqual(rc, 1, "%s: %s" % (name, output))
                self.assertIn("HANDOFF-EDITED", output)
            path.write_bytes(original)
            self.assertEqual(self.check(task)[0], 0)

    def crlf_rewrite_is_refused(self):
        for name in self.NAMES:
            path = self.task / name
            original = path.read_bytes()
            self.assertNotIn(b"\r\n", original)
            path.write_bytes(original.replace(b"\n", b"\r\n"))
            rc, output = self.check(self.task)
            self.assertEqual(rc, 1, "%s: %s" % (name, output))
            self.assertIn("HANDOFF-EDITED", output)
            path.write_bytes(original)
            self.assertEqual(self.check(self.task)[0], 0)

    def test_when_line_endings_are_rewritten_in_a_crlf_repo_before_git_holds_the_file_check_fails(self):
        self.git("config", "core.autocrlf", "true")
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off"}):
            self.scaffold()
            rc, output = self.mm("add-row", "--task-dir", self.task, "--item", "Row git never saw")
            self.assertEqual(rc, 0, output)
        self.crlf_rewrite_is_refused()

    def test_when_a_crlf_rewrite_differs_from_what_git_checks_out_check_fails(self):
        self.git("config", "core.autocrlf", "true")
        self.scaffold()
        text = self.tmp / "section.txt"
        text.write_bytes(b"- a line with a lone \r carriage return, which makes git treat the file as binary\n")
        rc, output = self.mm("set-section", "--task-dir", self.task, "--id", "3", "--text-file", text)
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.pending(), "")
        path = self.task / "HANDOFF.md"
        self.assertIn(b" \r c", path.read_bytes())
        path.unlink()
        self.git("checkout", "--", ".private/pm/active/git-task/HANDOFF.md")
        self.assertEqual(self.check(self.task)[0], 0)
        original = path.read_bytes()
        path.write_bytes(original.replace(b"\n", b"\r\n"))
        rc, output = self.check(self.task)
        self.assertEqual(rc, 1, output)
        self.assertIn("HANDOFF-EDITED", output)

    def test_when_git_checks_the_files_out_with_crlf_check_still_passes(self):
        self.git("config", "core.autocrlf", "true")
        self.scaffold()
        for name in self.NAMES + ("ledger.json",):
            (self.task / name).unlink()
        self.git("checkout", "--", ".private/pm/active/git-task")
        self.assertIn(b"\r\n", (self.task / "HANDOFF.md").read_bytes())
        rc, output = self.check(self.task)
        self.assertEqual(rc, 0, output)
        rc, output = self.mm("add-row", "--task-dir", self.task, "--item", "Row after a CRLF checkout")
        self.assertEqual(rc, 0, output)
        path = self.task / "HANDOFF.md"
        path.unlink()
        self.git("checkout", "--", ".private/pm/active/git-task/HANDOFF.md")
        data = path.read_bytes()
        self.assertIn(b"\r\n", data)
        self.assertEqual(self.check(self.task)[0], 0)
        path.write_bytes(data.replace(b"\r\n", b"\n", 1))
        rc, output = self.check(self.task)
        self.assertEqual(rc, 1, output)
        path.write_bytes(data)
        self.assertEqual(self.check(self.task)[0], 0)


if __name__ == "__main__":
    unittest.main()
