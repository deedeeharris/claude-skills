import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import mm
import mm_git


class WhereCase(unittest.TestCase):
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

    def git(self, *argv, cwd=None):
        proc = subprocess.run(["git", *argv], cwd=cwd or self.repo, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        self.assertEqual(proc.returncode, 0, "git %s: %s" % (" ".join(argv), proc.stderr))
        return proc.stdout

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        rc, out, err = self.mm(*argv)
        self.assertEqual(rc, 0, out + err)
        return out

    def scaffold(self, name, root=None):
        task = (root or self.repo) / ".private" / "pm" / "active" / name
        self.ok("scaffold", "--task-dir", task, "--task", name, "--project", "smoke-project", "--row", "Row one")
        return task


class WorktreeTests(WhereCase):
    def two_copies(self):
        task = self.scaffold("widget")
        wt = self.tmp / "wt"
        self.git("worktree", "add", "-q", "-b", "side", str(wt))
        other = wt / ".private" / "pm" / "active" / "widget"
        self.ok("add-row", "--task-dir", other, "--item", "Row made in the other worktree")
        return task, other

    def test_when_two_worktrees_hold_task_where_names_higher_revision_canonical(self):
        task, other = self.two_copies()
        rc, out, err = self.mm("where", "--task-dir", task)
        self.assertEqual(rc, 12, out + err)
        canonical = [l for l in out.splitlines() if l.startswith("CANONICAL ")]
        self.assertEqual(len(canonical), 1, out)
        self.assertEqual(pathlib.Path(canonical[0].split(" ", 1)[1]).resolve(), other.resolve())
        self.assertEqual(len([l for l in out.splitlines() if l.startswith("COPY ")]), 2)
        rc, out, err = self.mm("where", "--task-dir", other)
        self.assertEqual(rc, 0, out + err)

    def test_when_this_copy_is_behind_write_commands_refuse(self):
        task, other = self.two_copies()
        before = (task / "ledger.json").read_bytes()
        head = self.git("rev-parse", "HEAD")
        for argv in (("add-row", "--item", "late"), ("set-field", "--field", "Next agent action", "--value", "x")):
            rc, out, err = self.mm(argv[0], "--task-dir", task, *argv[1:])
            self.assertEqual(rc, 12, out + err)
            self.assertIn(str(other.resolve()).lower(), (out + err).lower().replace("/", os.sep))
        self.assertEqual((task / "ledger.json").read_bytes(), before)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)

    def diverged_copies(self, extra_main=0):
        task = self.scaffold("widget")
        self.git("checkout", "-q", "-b", "side")
        self.ok("add-row", "--task-dir", task, "--item", "Row made on side")
        self.git("checkout", "-q", "main")
        self.ok("add-row", "--task-dir", task, "--item", "Row made on main")
        for n in range(extra_main):
            self.ok("add-row", "--task-dir", task, "--item", "Main extra %d" % n)
        wt = self.tmp / "wt"
        self.git("worktree", "add", "-q", str(wt), "side")
        return task, wt / ".private" / "pm" / "active" / "widget"

    def assert_writes_stop_with_16(self, copy):
        before = (copy / "ledger.json").read_bytes()
        rc, out, err = self.mm("add-row", "--task-dir", copy, "--item", "late")
        self.assertEqual(rc, 16, out + err)
        self.assertIn("diverged", out + err)
        self.assertEqual((copy / "ledger.json").read_bytes(), before)
        rc, out, err = self.mm("where", "--task-dir", copy)
        self.assertEqual(rc, 16, out + err)
        self.assertIn("DIVERGED", out)

    def test_when_two_copies_hold_the_same_revision_with_different_content_writes_stop_with_16(self):
        task, other = self.diverged_copies()
        self.assertEqual(json.loads((task / "ledger.json").read_text(encoding="utf-8"))["revision"],
                         json.loads((other / "ledger.json").read_text(encoding="utf-8"))["revision"])
        self.assert_writes_stop_with_16(task)
        self.assert_writes_stop_with_16(other)

    def test_when_the_lower_copy_is_not_in_the_higher_copys_history_both_stop_with_16(self):
        task, other = self.diverged_copies(extra_main=1)
        self.assert_writes_stop_with_16(task)
        self.assert_writes_stop_with_16(other)

    def test_a_crlf_worktree_copy_on_one_line_of_history_never_stops_with_16(self):
        setups = (("core.autocrlf", lambda: self.git("config", "core.autocrlf", "true")),
                  ("anchored eol=crlf attribute", lambda: (self.repo / ".gitattributes").write_text(
                      "/.private/pm/active/widget/ledger.json text eol=crlf\n", encoding="utf-8")))
        for n, (label, setup) in enumerate(setups):
            with self.subTest(label):
                self.repo = self.tmp / ("crlf-repo-%d" % n)
                wt = self.tmp / ("crlf-wt-%d" % n)
                self.repo.mkdir()
                self.git("init", "-q", "-b", "main")
                setup()
                (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
                self.git("add", "-A")
                self.git("commit", "-qm", "seed")
                task = self.scaffold("widget")
                self.git("worktree", "add", "-q", "-b", "side", str(wt))
                other = wt / ".private" / "pm" / "active" / "widget"
                self.assertIn(b"\r\n", (other / "ledger.json").read_bytes())
                for copy in (task, other):
                    rc, out, err = self.mm("where", "--task-dir", copy)
                    self.assertEqual(rc, 0, out + err)
                self.ok("add-row", "--task-dir", task, "--item", "Row made on main")
                rc, out, err = self.mm("add-row", "--task-dir", other, "--item", "late")
                self.assertEqual(rc, 12, out + err)
                self.assertNotIn("diverged", out + err)
                self.ok("add-row", "--task-dir", task, "--item", "Main goes on")

    def test_where_warns_when_the_task_was_closed_on_another_ref(self):
        task = self.scaffold("widget")
        self.git("checkout", "-q", "-b", "closing")
        done = self.repo / ".private" / "pm" / "done"
        done.mkdir(parents=True)
        self.git("mv", ".private/pm/active/widget", ".private/pm/done/widget")
        self.git("commit", "-qm", "close widget")
        self.git("checkout", "-q", "main")
        out = self.ok("where", "--task-dir", task)
        self.assertIn("closed on closing", out)


class BindingTests(WhereCase):
    def test_when_bound_session_whoami_returns_bound_task(self):
        task = self.scaffold("widget")
        self.ok("bind", "--task-dir", task, "--session", "session-1")
        state = self.tmp / "state" / "sessions" / "session-1.json"
        self.assertEqual(pathlib.Path(json.loads(state.read_text(encoding="utf-8"))["task_dir"]), task.absolute())
        out = self.ok("whoami", "--session", "session-1")
        self.assertEqual(pathlib.Path(out.splitlines()[0]), task.absolute())
        self.ok("unbind", "--session", "session-1")
        self.assertFalse(state.exists())
        rc, out, err = self.mm("whoami", "--session", "session-1")
        self.assertEqual(rc, 4, out + err)
        rc, out, err = self.mm("bind", "--task-dir", task, "--session", "")
        self.assertEqual(rc, 2, out + err)

    def test_binding_precedence_explicit_path_over_binding_over_branch(self):
        a = self.scaffold("widget-a")
        b = self.scaffold("widget-b")
        c = self.tmp / "elsewhere" / ".private" / "pm" / "active" / "widget-c"
        self.git("checkout", "-q", "-b", "task/widget-a")
        self.ok("bind", "--task-dir", b, "--session", "s1")
        out = self.ok("whoami", "--session", "s1", "--task-dir", c, "--repo", self.repo)
        self.assertEqual(pathlib.Path(out.splitlines()[0]), c.absolute())
        self.assertIn("source: explicit", out)
        out = self.ok("whoami", "--session", "s1", "--repo", self.repo)
        self.assertEqual(pathlib.Path(out.splitlines()[0]), b.absolute())
        self.assertIn("source: session", out)
        out = self.ok("whoami", "--session", "s2", "--repo", self.repo)
        self.assertEqual(pathlib.Path(out.splitlines()[0]).resolve(), a.resolve())
        self.assertIn("source: branch", out)
        self.git("checkout", "-q", "main")
        rc, out, err = self.mm("whoami", "--session", "s2", "--repo", self.repo)
        self.assertEqual(rc, 4, out + err)
        self.assertIn("ask the operator", out + err)
        out = self.ok("whoami", "--session", "s2", "--repo", self.repo, "--pattern", "widget-b")
        self.assertEqual(pathlib.Path(out.splitlines()[0]).resolve(), b.resolve())
        self.assertIn("source: folder", out)


class BindRecordTests(WhereCase):
    """R-4: role, repo root and its source in the binding; the three binding states."""

    def binding(self, session="session-1"):
        return json.loads((self.tmp / "state" / "sessions" / ("%s.json" % session)).read_text(encoding="utf-8"))

    def write_binding(self, text, session="session-1"):
        path = self.tmp / "state" / "sessions" / ("%s.json" % session)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def assert_no_binding(self, session="session-1"):
        self.assertFalse((self.tmp / "state" / "sessions" / ("%s.json" % session)).exists())

    def test_when_bind_runs_the_record_holds_role_pm(self):
        task = self.scaffold("widget")
        self.ok("bind", "--task-dir", task, "--session", "session-1")
        record = self.binding()
        self.assertEqual(record["role"], "pm")
        self.assertEqual(pathlib.Path(record["task_dir"]), task.absolute())
        self.assertIn("bound_at", record)

    def test_when_bind_runs_in_a_git_subproject_repo_root_is_the_worktree_top_level(self):
        task = self.scaffold("widget", root=self.repo / "subproject")
        self.ok("bind", "--task-dir", task, "--session", "session-1")
        record = self.binding()
        self.assertEqual(pathlib.Path(record["repo_root"]).resolve(), self.repo.resolve())
        self.assertEqual(record["repo_root_source"], "git")

    def test_when_bind_runs_outside_any_git_repo_repo_root_is_the_pm_parent_and_source_is_no_git(self):
        plain = self.tmp / "plain"
        task = self.scaffold("widget", root=plain)
        self.ok("bind", "--task-dir", task, "--session", "session-1")
        record = self.binding()
        self.assertEqual(pathlib.Path(record["repo_root"]), plain.absolute())
        self.assertEqual(record["repo_root_source"], "no-git")

    def test_when_git_fails_during_bind_it_exits_21_and_writes_no_binding(self):
        task = self.scaffold("widget")
        real = mm_git._git

        def broken(argv, cwd, stdin=None):
            if "--show-toplevel" in argv:
                return subprocess.CompletedProcess(["git"] + list(argv), 128, "", GitFailureTests.DUBIOUS + "\n")
            return real(argv, cwd, stdin)
        with mock.patch.object(mm_git, "_git", broken):
            rc, out, err = self.mm("bind", "--task-dir", task, "--session", "session-1")
        self.assertEqual(rc, 21, out + err)
        self.assertIn("cannot resolve the git repository of", err)
        self.assertIn(GitFailureTests.DUBIOUS, err)
        self.assert_no_binding()

    def test_when_bind_resolves_the_home_folder_as_root_it_exits_2_and_writes_no_binding(self):
        task = self.scaffold("widget", root=self.tmp / "home")
        rc, out, err = self.mm("bind", "--task-dir", task, "--session", "session-1")
        self.assertEqual(rc, 2, out + err)
        self.assertIn("a filesystem root or a folder holding your home folder", err)
        self.assertIn("nothing written", err)
        self.assert_no_binding()

    def test_when_bind_resolves_a_git_root_that_holds_the_home_folder_it_exits_2_and_writes_no_binding(self):
        outer = self.tmp / "outer"
        (outer / "user").mkdir(parents=True)
        self.git("init", "-q", "-b", "main", cwd=outer)
        task = self.scaffold("widget", root=outer)
        with mock.patch.dict(os.environ, {"HOME": str(outer / "user"), "USERPROFILE": str(outer / "user")}):
            rc, out, err = self.mm("bind", "--task-dir", task, "--session", "session-1")
        self.assertEqual(rc, 2, out + err)
        self.assertIn("the PM fence root of", err)
        self.assertIn("a filesystem root or a folder holding your home folder", err)
        self.assert_no_binding()

    def test_when_bind_resolves_a_filesystem_root_it_exits_2_and_writes_no_binding(self):
        task = self.scaffold("widget")
        anchor = pathlib.Path(self.tmp.anchor)
        with mock.patch.object(mm_git, "_repo", lambda path, strict=False: (anchor, anchor / ".git")):
            rc, out, err = self.mm("bind", "--task-dir", task, "--session", "session-1")
        self.assertEqual(rc, 2, out + err)
        self.assertIn("a filesystem root or a folder holding your home folder", err)
        self.assert_no_binding()

    def test_when_bind_resolves_a_repo_below_home_it_binds_and_the_pm_may_write_dot_claude_and_memory(self):
        home = self.tmp / "home"
        self.repo = home / "work" / "repo"
        self.repo.mkdir(parents=True)
        self.git("init", "-q", "-b", "main")
        task = self.scaffold("widget")
        self.ok("bind", "--task-dir", task, "--session", "session-1")
        guard = pathlib.Path(mm.__file__).resolve().parent.parent / "hooks" / "guard.py"
        env = {k: v for k, v in os.environ.items() if k != "MM_CC_RUNTIME_MOD_ACTIVE"}
        for target, code in ((home / ".claude" / "settings.json", 0),
                             (home / ".claude" / "projects" / "p" / "memory" / "m.md", 0),
                             (self.repo / "src" / "a.py", 2)):
            with self.subTest(target=target.name):
                payload = {"hook_event_name": "PreToolUse", "tool_name": "Write", "session_id": "session-1",
                           "tool_input": {"file_path": str(target), "content": "x"}, "cwd": str(self.repo)}
                proc = subprocess.run([sys.executable, str(guard)], input=json.dumps(payload), capture_output=True,
                                      text=True, encoding="utf-8", errors="replace", env=env)
                self.assertEqual(proc.returncode, code, proc.stderr)

    def test_when_the_repo_is_on_another_drive_than_home_bind_succeeds(self):
        import ntpath
        import mm_fence
        task = self.scaffold("widget")
        found = (pathlib.PurePath("D:/work/repo"), pathlib.PurePath("D:/work/repo/.git"))
        with mock.patch.object(mm_fence, "PATHMOD", ntpath), mock.patch.object(mm_fence, "resolved", ntpath.normcase), \
                mock.patch.object(mm_fence, "home", lambda: "C:/Users/u"), \
                mock.patch.object(mm_git, "_repo", lambda path, strict=False: found):
            rc, out, err = self.mm("bind", "--task-dir", task, "--session", "session-1")
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(ntpath.normcase(self.binding()["repo_root"]), "d:\\work\\repo")

    def test_when_resolving_the_root_raises_broad_root_is_true_and_bind_exits_2(self):
        import mm_fence
        task = self.scaffold("widget")
        with mock.patch.object(mm_fence, "resolved", mock.Mock(side_effect=OSError("cannot resolve"))):
            self.assertTrue(mm_fence.broad_root(str(self.repo)))
            rc, out, err = self.mm("bind", "--task-dir", task, "--session", "session-1")
        self.assertEqual(rc, 2, out + err)
        self.assert_no_binding()

    def test_when_repo_root_is_not_a_string_binding_record_returns_unreadable(self):
        import mm_where
        for value in (7, None, "", ["x"]):
            with self.subTest(value=value):
                self.write_binding(json.dumps({"task_dir": "/x", "bound_at": "y", "repo_root": value}))
                self.assertEqual(mm_where.binding_record("session-1")[0], "unreadable")
        self.write_binding(json.dumps({"task_dir": "/x", "bound_at": "y", "repo_root": "/r"}))
        state, record = mm_where.binding_record("session-1")
        self.assertEqual((state, record["repo_root"]), ("ok", "/r"))

    def test_when_binding_has_no_role_binding_record_returns_ok_and_role_defaults_to_pm(self):
        import mm_where
        self.write_binding(json.dumps({"task_dir": "/x", "bound_at": "y"}))
        state, record = mm_where.binding_record("session-1")
        self.assertEqual(state, "ok")
        self.assertEqual(mm_where.binding_role(record), ("pm", "legacy-default"))
        self.assertEqual(mm_where.binding_role(dict(record, role="pm")), ("pm", "binding"))
        self.assertEqual(mm_where.binding_role(dict(record, role="worker")), ("pm", "fail-closed"))

    def test_when_binding_is_not_json_binding_record_returns_unreadable(self):
        import mm_where
        for text in ("{not json", "[]", "null", json.dumps({"bound_at": "y"}), json.dumps({"task_dir": 7})):
            with self.subTest(text=text):
                self.write_binding(text)
                self.assertEqual(mm_where.binding_record("session-1"), ("unreadable", None))
        self.assertIsNone(mm_where.whoami("session-1"))

    def test_when_no_binding_exists_binding_record_returns_absent(self):
        import mm_where
        self.assertEqual(mm_where.binding_record("session-never-bound"), ("absent", None))


class GitFailureTests(WhereCase):
    DUBIOUS = "fatal: detected dubious ownership in repository at 'x'"

    def failing_git(self, words):
        real = mm_git._git

        def broken(argv, cwd, stdin=None):
            if all(word in argv for word in words):
                return subprocess.CompletedProcess(["git"] + list(argv), 128, "", self.DUBIOUS + "\n"
                                                   "To add an exception for this directory, call:\n")
            return real(argv, cwd, stdin)
        return mock.patch.object(mm_git, "_git", broken)

    def assert_refused(self, rc, out, err):
        self.assertEqual(rc, 21, out + err)
        self.assertIn(self.DUBIOUS, err)
        self.assertIn("nothing written", err)
        self.assertNotIn("To add an exception", out + err)
        self.assertNotIn("Traceback", out + err)

    def test_when_git_fails_while_finding_the_copies_writes_refuse_before_writing(self):
        task = self.scaffold("widget")
        self.git("worktree", "add", "-q", "-b", "side", str(self.tmp / "wt"))
        self.ok("add-row", "--task-dir", self.tmp / "wt" / ".private" / "pm" / "active" / "widget", "--item", "x")
        before, head = (task / "ledger.json").read_bytes(), self.git("rev-parse", "HEAD")
        for words in (("rev-parse", "--show-toplevel"), ("worktree", "list"), ("rev-parse", "--show-prefix"),
                      ("hash-object",), ("log",)):
            with self.subTest(failing=words), self.failing_git(words):
                self.assert_refused(*self.mm("add-row", "--task-dir", task, "--item", "late"))
                self.assert_refused(*self.mm("where", "--task-dir", task))
        self.assertEqual((task / "ledger.json").read_bytes(), before)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)

    def test_when_git_fails_while_reading_the_branch_whoami_refuses(self):
        self.scaffold("widget")
        for words in (("rev-parse", "--show-toplevel"), ("symbolic-ref",)):
            with self.subTest(failing=words), self.failing_git(words):
                self.assert_refused(*self.mm("whoami", "--session", "s1", "--repo", self.repo))

    def test_when_git_is_not_on_path_inside_a_repo_writes_refuse_before_writing(self):
        task = self.scaffold("widget")
        self.git("worktree", "add", "-q", "-b", "side", str(self.tmp / "wt"))
        self.ok("add-row", "--task-dir", self.tmp / "wt" / ".private" / "pm" / "active" / "widget", "--item", "x")
        plain = self.scaffold("widget", root=self.tmp / "plain")
        before, head = (task / "ledger.json").read_bytes(), self.git("rev-parse", "HEAD")
        real = shutil.which
        with mock.patch("shutil.which", lambda name, *a, **k: None if name in ("git", "git.exe") else real(name, *a, **k)):
            for argv in (("add-row", "--task-dir", task, "--item", "late"), ("where", "--task-dir", task),
                         ("whoami", "--session", "s1", "--repo", self.repo)):
                with self.subTest(argv=argv[0]):
                    rc, out, err = self.mm(*argv)
                    self.assertEqual(rc, 21, out + err)
                    self.assertIn("git was not found on PATH", err)
                    self.assertIn("nothing written", err)
                    self.assertNotIn("Traceback", out + err)
            self.assertIsNone(mm_git.checkout_form(task / "ledger.json", before))
            self.ok("add-row", "--task-dir", plain, "--item", "outside any repo")
        self.assertEqual((task / "ledger.json").read_bytes(), before)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)

    def test_when_git_says_not_a_git_repository_writes_proceed_as_before(self):
        plain = self.tmp / "plain"
        (plain / ".git").mkdir(parents=True)
        task = self.scaffold("widget", root=plain)
        self.ok("add-row", "--task-dir", task, "--item", "late")
        self.assertIn("the only copy", self.ok("where", "--task-dir", task))


if __name__ == "__main__":
    unittest.main()
