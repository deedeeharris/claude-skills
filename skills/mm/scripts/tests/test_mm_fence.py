import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import io
import json
import ntpath
import os
import posixpath
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

PYTHON = sys.executable
SKILL = pathlib.Path(__file__).resolve().parent.parent.parent
MM_PY = SKILL / "scripts" / "mm.py"
GUARD = SKILL / "hooks" / "guard.py"
HOOKS = SKILL / "hooks"
MARKER = "MM_CC_RUNTIME_MOD_ACTIVE"
SESSION = "pm-session-1"

PRODUCT = "PM mode cannot directly modify product code"
LEGACY = "predates r26 and records no repository root"
BROAD = "a filesystem root or a folder holding your home folder"
UNREADABLE = "cannot be read, so every write from this PM session is refused"
UNSURE = "is product code"
LEDGER = "is the task ledger and changes only through mm.py commands"
MISSING = object()


def fence_module():
    import mm_fence
    return mm_fence


def guard_module():
    if str(HOOKS) not in sys.path:
        sys.path.insert(0, str(HOOKS))
    import guard
    return guard


def make_link(target, link):
    """A directory link: a junction on Windows, a symlink elsewhere."""
    try:
        import _winapi
        create = _winapi.CreateJunction
    except (ImportError, AttributeError):
        os.symlink(str(target), str(link), target_is_directory=True)
        return
    create(str(target), str(link))


def same_path(a, b):
    return os.path.normcase(os.path.realpath(str(a))) == os.path.normcase(os.path.realpath(str(b)))


class FenceCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.env = {k: v for k, v in os.environ.items() if k != MARKER}
        self.env.update(MM_AUTO_COMMIT="off", MM_STATE_DIR=str(self.tmp / "state"), PYTHONDONTWRITEBYTECODE="1",
                        PYTHONIOENCODING="utf-8", HOME=str(self.home), USERPROFILE=str(self.home),
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(self.home / "gitconfig"),
                        GIT_CEILING_DIRECTORIES=str(self.tmp), GIT_AUTHOR_NAME="Test Operator",
                        GIT_AUTHOR_EMAIL="operator" + "@example.invalid", GIT_COMMITTER_NAME="Test Operator",
                        GIT_COMMITTER_EMAIL="operator" + "@example.invalid")
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.cases = []
        self.addCleanup(self.assert_fence_parity)

    def run_py(self, script, *argv, stdin=""):
        return subprocess.run([PYTHON, str(script), *map(str, argv)], input=stdin, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", env=self.env)

    def mm(self, *argv, stdin=""):
        return self.run_py(MM_PY, *argv, stdin=stdin)

    def git(self, *argv, cwd=None):
        proc = subprocess.run(["git", *argv], cwd=str(cwd or self.repo), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", env=self.env)
        self.assertEqual(proc.returncode, 0, "git %s: %s" % (" ".join(argv), proc.stderr))
        return proc.stdout

    def scaffold(self, name="t", root=None):
        task = (root or self.repo) / ".private" / "pm" / "active" / name
        proc = self.mm("scaffold", "--task-dir", task, "--task", name, "--project", "smoke-project", "--row", "Row one")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return task

    def bind(self, task, session=SESSION):
        proc = self.mm("bind", "--task-dir", task, "--session", session)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return proc

    def binding_file(self, session=SESSION):
        return self.tmp / "state" / "sessions" / ("%s.json" % session)

    def write_binding(self, text, session=SESSION):
        path = self.binding_file(session)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def bound_task(self):
        task = self.scaffold()
        self.bind(task)
        return task

    def payload(self, path, tool="Write", session=SESSION, agent=MISSING, cwd=None):
        if tool == "NotebookEdit":
            tool_input = {"notebook_path": str(path), "new_source": "x"}
        elif tool == "MultiEdit":
            tool_input = {"file_path": str(path), "edits": [{"old_string": "a", "new_string": "b"}]}
        elif tool == "Edit":
            tool_input = {"file_path": str(path), "old_string": "a", "new_string": "b"}
        else:
            tool_input = {"file_path": str(path), "content": "x"}
        data = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input,
                "cwd": str(cwd or self.tmp)}
        if session is not None:
            data["session_id"] = session
        if agent is not MISSING:
            data["agent_id"] = agent
        return data

    def patch_payload(self, path, shell=False, session=SESSION):
        patch = "*** Begin Patch\n*** Update File: %s\n@@\n-old\n+new\n*** End Patch\n" % path
        tool_input = {"command": ["apply_patch", patch]} if shell else {"input": patch}
        data = {"tool_name": "shell" if shell else "apply_patch", "tool_input": tool_input, "cwd": str(self.tmp)}
        if session is not None:
            data["session_id"] = session
        return data

    def guard(self, payload):
        stdin = json.dumps(payload)
        proc = self.run_py(GUARD, stdin=stdin)
        self.cases.append((payload, proc, self.fence_in_process(stdin)))
        return proc

    def fence_in_process(self, stdin):
        """mm.py fence --json run through mm.main in this process, with the
        environment the guard subprocess saw (a subprocess per call doubles
        the run time of this module)."""
        import mm
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(stdin.encode("utf-8")))), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main(["fence", "--json"])
        return subprocess.CompletedProcess(["mm.py", "fence", "--json"], rc, out.getvalue(), err.getvalue())

    def fence(self, payload):
        proc = self.mm("fence", "--json", stdin=json.dumps(payload))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return json.loads(proc.stdout)

    def assert_fence_parity(self):
        """Every payload a test sent to guard.py gets the same decision and
        messages from mm.py fence --json (R-10)."""
        for payload, guard, fence in self.cases:
            self.assertEqual(fence.returncode, 0, "fence --json on %r: %s" % (payload, fence.stdout + fence.stderr))
            doc = json.loads(fence.stdout)
            self.assertEqual(doc["schema"], "mm.fence/1")
            self.assertEqual(doc["decision"] == "deny", guard.returncode == 2, payload)
            self.assertEqual("\n".join(doc["messages"]), guard.stderr.rstrip("\n"), payload)

    def assert_denied(self, proc, *texts):
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("mm guard:", proc.stderr)
        for text in texts:
            self.assertIn(text, proc.stderr)

    def assert_allowed(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(proc.stderr, "")

    def guard_with_patch(self, patch_code, payload):
        """Run guard.main() in a process where `patch_code` first changed mm_fence."""
        wrapper = self.tmp / "guard_patched.py"
        wrapper.write_text("import sys\nsys.dont_write_bytecode = True\nsys.path.insert(0, %r)\n"
                           "sys.path.insert(0, %r)\nimport mm_fence, hookio\n%s\nimport guard\n"
                           "sys.exit(guard.main())\n" % (str(HOOKS), str(SKILL / "scripts"), patch_code),
                           encoding="utf-8")
        return self.run_py(wrapper, stdin=json.dumps(payload))


class BroadRootTests(unittest.TestCase):
    def test_when_root_and_home_are_on_different_drives_or_shares_broad_root_of_is_false(self):
        mm_fence = fence_module()
        rows = (
            (ntpath, "D:/work/repo", "C:/Users/u", False),
            (ntpath, "//srv/share/repo", "C:/Users/u", False),
            (ntpath, "C:/Users/u/work/repo", "c:/users/u", False),
            (ntpath, "D:/", "C:/Users/u", True),
            (ntpath, "//srv/share", "C:/Users/u", True),
            (ntpath, "C:/Users", "c:/users/u", True),
            (posixpath, "/work/repo", "/home/u", False),
            (posixpath, "/home", "/home/u", True),
            (posixpath, "/", "/home/u", True),
        )
        for pathmod, root, home, broad in rows:
            with self.subTest(pathmod=pathmod.__name__, root=root, home=home):
                r, h = pathmod.normcase(pathmod.normpath(root)), pathmod.normcase(pathmod.normpath(home))
                self.assertIs(mm_fence.broad_root_of(r, h, pathmod), broad)


class ProductWriteTests(FenceCase):
    def test_when_bound_pm_writes_a_product_file_guard_exits_2_with_the_fence_message(self):
        task = self.bound_task()
        proc = self.guard(self.payload(self.repo / "src" / "a.py"))
        self.assert_denied(proc, PRODUCT, "Delegate it", "mm.py dispatch", "mm.py unbind --session " + SESSION)
        self.assertIn(str(task.absolute()), proc.stderr)

    def test_when_bound_pm_multiedit_and_notebookedit_target_product_files_guard_exits_2(self):
        self.bound_task()
        for tool, name in (("MultiEdit", "a.py"), ("NotebookEdit", "nb.ipynb"), ("Edit", "b.py")):
            with self.subTest(tool=tool):
                self.assert_denied(self.guard(self.payload(self.repo / "src" / name, tool=tool)), PRODUCT)

    def test_when_a_task_under_repo_subproject_is_bound_pm_writes_elsewhere_in_repo_are_denied(self):
        self.git("init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-qm", "seed")
        task = self.scaffold(root=self.repo / "subproject")
        self.bind(task)
        for target in (self.repo / "other" / "a.py", self.repo / "subproject" / "src" / "b.py"):
            with self.subTest(target=target.name):
                self.assert_denied(self.guard(self.payload(target)), PRODUCT)
        self.assert_allowed(self.guard(self.payload(task / "notes.md")))

    def test_when_a_binding_predates_r26_a_pm_write_outside_the_pm_tree_is_denied_and_names_bind(self):
        task = self.scaffold()
        self.write_binding(json.dumps({"task_dir": str(task.absolute()), "bound_at": "2026-01-01T00:00:00+00:00"}))
        for target in (self.repo / "src" / "a.py", self.tmp / "elsewhere" / "x.md"):
            with self.subTest(target=target.name):
                self.assert_denied(self.guard(self.payload(target)), LEGACY,
                                   "mm.py bind --task-dir %s --session %s" % (task.absolute(), SESSION))
        self.assert_allowed(self.guard(self.payload(task / "notes.md")))

    def test_when_the_bound_task_was_closed_the_pm_is_still_fenced_and_told_to_unbind(self):
        task = self.bound_task()
        done = self.repo / ".private" / "pm" / "done"
        done.mkdir(parents=True)
        shutil.move(str(task), str(done / task.name))
        self.assert_denied(self.guard(self.payload(self.repo / "src" / "a.py")), PRODUCT,
                           "mm.py unbind --session " + SESSION)


class WorkerTests(FenceCase):
    def test_when_a_subagent_payload_has_agent_id_guard_allows_the_product_write(self):
        self.bound_task()
        self.assert_allowed(self.guard(self.payload(self.repo / "src" / "a.py", agent="a649a24bad675ba81")))

    def test_when_a_workflow_agent_payload_has_agent_id_guard_allows_the_product_write(self):
        self.bound_task()
        payload = dict(self.payload(self.repo / "src" / "a.py", agent="a70a73b9a2500ebc9"),
                       agent_type="workflow-subagent")
        self.assert_allowed(self.guard(payload))

    def test_when_an_unbound_session_writes_a_product_file_guard_allows_it(self):
        self.bound_task()
        self.assert_allowed(self.guard(self.payload(self.repo / "src" / "a.py", session="another-session")))
        self.assert_allowed(self.guard(self.payload(self.repo / "src" / "a.py", session=None)))

    def test_when_bound_pm_calls_agent_workflow_skill_or_bash_guard_allows_the_call(self):
        self.bound_task()
        for tool, tool_input in (("Agent", {"prompt": "edit src/a.py"}), ("Task", {"prompt": "x"}),
                                 ("Workflow", {"script": "x"}), ("Skill", {"skill": "x"}),
                                 ("Bash", {"command": "echo x >> src/a.py"}), ("PowerShell", {"command": "ls"}),
                                 ("mcp__mm-runtime__dispatch", {"row": "#1"}), ("Read", {"file_path": "src/a.py"})):
            with self.subTest(tool=tool):
                proc = self.guard({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input,
                                   "session_id": SESSION, "cwd": str(self.repo)})
                self.assert_allowed(proc)
                self.assertEqual(proc.stdout, "")

    def test_when_pm_and_worker_payloads_of_one_session_alternate_only_the_pm_write_is_denied(self):
        self.bound_task()
        target = self.repo / "src" / "a.py"
        for agent, code in ((MISSING, 2), ("a1b2c3d4e5f6a7b8c", 0), (MISSING, 2), ("a1b2c3d4e5f6a7b8c", 0)):
            proc = self.guard(self.payload(target, agent=agent))
            self.assertEqual(proc.returncode, code, proc.stderr)

    def test_when_the_parent_binding_is_corrupt_a_worker_product_write_is_allowed(self):
        task = self.scaffold()
        records = (("corrupt", "{not json"),
                   ("legacy", json.dumps({"task_dir": str(task.absolute()), "bound_at": "x"})),
                   ("broad", json.dumps({"task_dir": str(task.absolute()), "bound_at": "x", "role": "pm",
                                         "repo_root": str(self.home), "repo_root_source": "no-git"})))
        for label, text in records:
            with self.subTest(binding=label):
                self.write_binding(text)
                payload = self.payload(self.repo / "src" / "a.py", agent="a649a24bad675ba81")
                self.assert_allowed(self.guard(payload))
                doc = self.fence(payload)
                self.assertEqual(doc["actor"], "worker")
                self.assertEqual(doc["decision"], "allow")

    def test_when_the_parent_binding_is_corrupt_a_worker_edit_of_ledger_json_is_still_denied(self):
        task = self.scaffold()
        self.write_binding("{not json")
        proc = self.guard(self.payload(task / "ledger.json", tool="Edit", agent="a649a24bad675ba81"))
        self.assert_denied(proc, LEDGER)
        self.assertNotIn(UNREADABLE, proc.stderr)

    def test_when_a_task_folder_links_outside_the_pm_tree_worker_and_unbound_edits_of_its_ledger_are_denied(self):
        task = self.scaffold()
        shared = self.tmp / "shared-t"
        shutil.move(str(task), str(shared))
        make_link(shared, task)
        self.assertTrue(same_path(task, shared))
        for name, text in (("ledger.json", LEDGER), ("HANDOFF.md", "is generated from ledger.json")):
            for label, payload in (("worker", self.payload(task / name, tool="Edit", agent="a649a24bad675ba81")),
                                   ("unbound", self.payload(task / name, tool="Edit", session="another-session"))):
                with self.subTest(file=name, actor=label):
                    self.assert_denied(self.guard(payload), text)

    def test_when_a_link_outside_the_pm_tree_resolves_to_a_task_ledger_a_worker_edit_is_denied(self):
        task = self.scaffold()
        make_link(task, self.tmp / "alias")
        self.assert_denied(self.guard(self.payload(self.tmp / "alias" / "ledger.json", tool="Edit",
                                                   agent="a649a24bad675ba81")), LEDGER)

    def test_when_ledger_json_is_a_file_link_either_end_in_the_task_folder_denies_a_worker_write(self):
        mm_fence = fence_module()
        guard = guard_module()
        for pathmod, base in ((posixpath, "/work"), (ntpath, "C:/work")):
            ledger = base + "/repo/.private/pm/active/t/ledger.json"
            for label, raw, table in (("named ledger.json, points elsewhere", "repo/.private/pm/active/t/ledger.json",
                                       {ledger: base + "/shared/notes.txt"}),
                                      ("alias outside, resolves to ledger.json", "alias.txt",
                                       {base + "/alias.txt": ledger})):
                with self.subTest(pathmod=pathmod.__name__, link=label):
                    def realpath(p, table=table):
                        key = str(p).replace("\\", "/")
                        return table.get(key, key)

                    payload = self.payload(raw, cwd=base, agent="a649a24bad675ba81")
                    with mock.patch.dict(os.environ, {"MM_STATE_DIR": self.env["MM_STATE_DIR"]}), \
                            mock.patch.object(mm_fence, "PATHMOD", pathmod), \
                            mock.patch.object(mm_fence, "realpath", realpath):
                        found = guard.refusals(payload)
                    self.assertEqual(len(found), 1, found)
                    self.assertIn(LEDGER, found[0])


class PmTreeTests(FenceCase):
    def test_when_a_pm_tree_folder_is_reached_through_a_link_the_target_is_classified_by_its_real_path(self):
        task = self.bound_task()
        make_link(task, self.repo / "notes-link")
        self.assert_allowed(self.guard(self.payload(self.repo / "notes-link" / "n.md")))
        self.assert_denied(self.guard(self.payload(self.repo / "notes-link" / "ledger.json", tool="Edit")), LEDGER)

    def test_when_bound_pm_writes_task_notes_guard_allows_it(self):
        task = self.bound_task()
        for target in (task / "notes.md", task / "inbox" / "20260101-120000-agent.md", task / "prompts" / "p.md"):
            with self.subTest(target=target.name):
                self.assert_allowed(self.guard(self.payload(target)))

    def test_when_bound_pm_writes_pm_root_dashboard_md_guard_allows_it(self):
        self.bound_task()
        for name in ("DASHBOARD.md", "DASHBOARD.html", "dashboard.json"):
            with self.subTest(name=name):
                self.assert_allowed(self.guard(self.payload(self.repo / ".private" / "pm" / name)))

    def test_when_bound_pm_writes_a_file_outside_the_bound_repo_guard_allows_it(self):
        self.bound_task()
        for target in (self.tmp / "elsewhere" / "notes.md", self.home / ".claude" / "settings.json",
                       self.home / ".claude" / "projects" / "p" / "memory" / "m.md"):
            with self.subTest(target=target.name):
                self.assert_allowed(self.guard(self.payload(target)))

    def test_when_a_pm_target_is_on_another_drive_or_share_than_the_repo_root_path_class_is_out(self):
        mm_fence = fence_module()
        with mock.patch.object(mm_fence, "PATHMOD", ntpath), mock.patch.object(mm_fence, "resolved", ntpath.normcase):
            self.assertEqual(mm_fence.path_class("C:/Users/u/.claude/x", "D:/work/repo"), "OUT")
            self.assertEqual(mm_fence.path_class("d:/WORK/repo/src/a.py", "D:/work/repo"), "PROD")
            self.assertEqual(mm_fence.path_class("//srv/other/a", "//srv/share/repo"), "OUT")
            self.assertEqual(mm_fence.path_class("//srv/share/repo/src/a.py", "//srv/share/repo"), "PROD")
            self.assertEqual(mm_fence.path_class("D:/work/repo/.private/pm/active/t/n.md", "D:/work/repo"), "PMT")

    def test_when_bound_pm_edits_ledger_json_guard_still_denies_with_the_r25_message(self):
        task = self.bound_task()
        before = (task / "ledger.json").read_bytes()
        for tool in ("Edit", "Write", "MultiEdit"):
            with self.subTest(tool=tool):
                proc = self.guard(self.payload(task / "ledger.json", tool=tool))
                self.assert_denied(proc, LEDGER)
                self.assertNotIn(PRODUCT, proc.stderr)
        self.assertEqual((task / "ledger.json").read_bytes(), before)


class FailClosedTests(FenceCase):
    def test_when_agent_id_is_empty_or_null_or_not_a_string_the_actor_is_pm_and_the_write_is_denied(self):
        self.bound_task()
        for agent in ("", "   ", None, 7, [], {}, ["a649a24bad675ba81"]):
            with self.subTest(agent=agent):
                payload = self.payload(self.repo / "src" / "a.py", agent=agent)
                self.assert_denied(self.guard(payload), PRODUCT)
                self.assertEqual(self.fence(payload)["actor"], "pm")

    def test_when_the_binding_is_unreadable_every_pm_write_outside_denied_pm_files_is_denied(self):
        self.scaffold()
        for text in ("{not json", "[]", json.dumps({"bound_at": "x"}), json.dumps({"task_dir": 7}),
                     json.dumps({"task_dir": "/x", "repo_root": ""}), json.dumps({"task_dir": "/x", "repo_root": 3})):
            with self.subTest(binding=text):
                self.write_binding(text)
                for target in (self.repo / "src" / "a.py", self.tmp / "elsewhere" / "x.md"):
                    self.assert_denied(self.guard(self.payload(target)), UNREADABLE)

    def test_when_the_binding_is_unreadable_a_pm_notes_write_is_denied_naming_unbind_and_bind(self):
        task = self.scaffold()
        self.write_binding("{not json")
        self.assert_denied(self.guard(self.payload(task / "notes.md")), UNREADABLE,
                           "mm.py unbind --session " + SESSION, "mm.py bind --task-dir <task> --session " + SESSION)

    def test_when_the_binding_is_unreadable_a_ledger_write_still_gets_the_r25_message(self):
        task = self.scaffold()
        self.write_binding("{not json")
        proc = self.guard(self.payload(task / "ledger.json", tool="Edit"))
        self.assert_denied(proc, LEDGER)
        self.assertNotIn(UNREADABLE, proc.stderr)

    def test_when_target_normalisation_raises_the_pm_write_is_denied(self):
        self.bound_task()
        payload = self.payload(self.repo / "src" / "a.py")
        proc = self.guard_with_patch("def boom(data):\n    raise OSError('boom')\nhookio.target_paths = boom\n",
                                     payload)
        self.assert_denied(proc, "cannot tell", "boom")
        guard = guard_module()
        hookio = sys.modules["hookio"]
        with mock.patch.dict(os.environ, {"MM_STATE_DIR": self.env["MM_STATE_DIR"]}), \
                mock.patch.object(hookio, "target_paths", mock.Mock(side_effect=OSError("boom"))):
            doc = guard.decide(payload)
        self.assertEqual(doc["decision"], "deny")
        self.assertEqual(doc["actor"], "pm")
        self.assertEqual(doc["targets"], [{"path": None, "class": "UNK"}])

    def test_when_a_pm_target_traverses_out_of_the_pm_tree_into_product_code_it_is_denied(self):
        task = self.bound_task()
        for raw, name in ((str(self.repo / ".private" / "pm") + "/../../src/a.py", "a.py"),
                          (str(task) + "/../../../../src/b.py", "b.py")):
            with self.subTest(target=raw):
                proc = self.guard(self.payload(raw))
                self.assert_denied(proc, PRODUCT)
                named = proc.stderr.split(" is in ", 1)[0].rsplit(": ", 1)[1]
                self.assertTrue(same_path(named, self.repo / "src" / name), named)

    def test_when_a_symlink_under_the_pm_tree_points_into_product_code_the_pm_write_is_denied(self):
        mm_fence = fence_module()
        guard = guard_module()
        for pathmod, base, home in ((posixpath, "/work", "/home/u"), (ntpath, "C:/work", "C:/Users/u")):
            with self.subTest(pathmod=pathmod.__name__):
                repo = base + "/repo"
                link, real = repo + "/.private/pm/link/a.py", repo + "/src/a.py"
                table = {link: real}

                def realpath(p, table=table):
                    key = str(p).replace("\\", "/")
                    return table.get(key, key)

                self.write_binding(json.dumps({"task_dir": repo + "/.private/pm/active/t", "bound_at": "x",
                                               "role": "pm", "repo_root": repo, "repo_root_source": "git"}))
                payload = self.payload("repo/.private/pm/link/a.py", cwd=base)
                with mock.patch.dict(os.environ, {"MM_STATE_DIR": self.env["MM_STATE_DIR"]}), \
                        mock.patch.object(mm_fence, "PATHMOD", pathmod), \
                        mock.patch.object(mm_fence, "realpath", realpath), \
                        mock.patch.object(mm_fence, "home", lambda home=home: home):
                    self.assertEqual(mm_fence.path_class(link, repo), "PROD")
                    found = guard.refusals(payload)
                    self.assertEqual(len(found), 1, found)
                    self.assertIn(PRODUCT, found[0])
                    self.assertIn(real, found[0].replace("\\", "/"))
                    table.clear()
                    self.assertEqual(mm_fence.path_class(link, repo), "PMT")
                    self.assertEqual(guard.refusals(payload), [])

    def test_when_a_directory_link_under_the_pm_tree_points_into_product_code_the_pm_write_is_denied(self):
        self.bound_task()
        (self.repo / "src").mkdir()
        make_link(self.repo / "src", self.repo / ".private" / "pm" / "link")
        proc = self.guard(self.payload(self.repo / ".private" / "pm" / "link" / "a.py"))
        self.assert_denied(proc, PRODUCT)
        self.assertFalse((self.repo / "src" / "a.py").exists())

    def test_when_resolving_a_pm_target_raises_the_write_is_denied_even_under_the_pm_tree(self):
        task = self.bound_task()

        def patch_for(suffix):
            return ("_real = mm_fence.resolved\n"
                    "def bad(p):\n"
                    "    if str(p).replace('\\\\', '/').endswith(%r):\n"
                    "        raise OSError('cannot resolve')\n"
                    "    return _real(p)\n"
                    "mm_fence.resolved = bad\n" % suffix)
        notes = self.payload(task / "notes.md")
        proc = self.guard_with_patch(patch_for("active/t/notes.md"), notes)
        self.assert_denied(proc, UNSURE, "cannot resolve")
        worker = self.payload(task / "notes.md", agent="a649a24bad675ba81")
        self.assert_allowed(self.guard_with_patch(patch_for("active/t/notes.md"), worker))
        ledger = self.payload(task / "ledger.json", tool="Edit", agent="a649a24bad675ba81")
        self.assert_denied(self.guard_with_patch(patch_for("active/t/ledger.json"), ledger), LEDGER)

    def test_when_a_binding_holds_a_broad_repo_root_pm_writes_to_dot_claude_and_product_are_denied_naming_unbind(self):
        task = self.scaffold()
        self.write_binding(json.dumps({"task_dir": str(task.absolute()), "bound_at": "x", "role": "pm",
                                       "repo_root": str(self.home), "repo_root_source": "no-git"}))
        for target in (self.home / ".claude" / "x", self.home / "work" / "a.py"):
            with self.subTest(target=target.name):
                self.assert_denied(self.guard(self.payload(target)), BROAD, "mm.py unbind --session " + SESSION)
        self.assert_allowed(self.guard(self.payload(task / "notes.md")))


class CodexTests(FenceCase):
    def test_when_a_bound_session_apply_patch_touches_a_product_file_guard_exits_2(self):
        self.bound_task()
        self.assert_denied(self.guard(self.patch_payload(self.repo / "src" / "a.py")), PRODUCT)

    def test_when_shell_apply_patch_from_a_bound_pm_touches_a_product_file_guard_exits_2(self):
        self.bound_task()
        self.assert_denied(self.guard(self.patch_payload(self.repo / "src" / "a.py", shell=True)), PRODUCT)

    def test_when_a_codex_payload_has_no_session_id_the_product_patch_is_allowed(self):
        self.bound_task()
        for shell in (False, True):
            with self.subTest(shell=shell):
                self.assert_allowed(self.guard(self.patch_payload(self.repo / "src" / "a.py", shell=shell,
                                                                  session=None)))


class FenceCommandTests(FenceCase):
    def test_when_fence_json_runs_on_each_guard_case_its_decision_matches_guard(self):
        task = self.bound_task()
        product, notes = self.repo / "src" / "a.py", task / "notes.md"
        two = self.patch_payload(notes)
        two["tool_input"]["input"] += "*** Begin Patch\n*** Add File: %s\n+x\n*** End Patch\n" % product
        payloads = [self.payload(product), self.payload(notes), self.payload(task / "ledger.json", tool="Edit"),
                    self.payload(product, agent="a649a24bad675ba81"), self.payload(product, session="other-session"),
                    self.payload(self.tmp / "elsewhere" / "x.md"), self.patch_payload(product),
                    self.patch_payload(product, shell=True), two,
                    {"tool_name": "Bash", "tool_input": {"command": "ls"}, "session_id": SESSION},
                    {"tool_name": "Edit", "tool_input": {}, "session_id": SESSION},
                    {"hook_event_name": "PreToolUse", "tool_input": {"file_path": str(product)}},
                    {"hook_event_name": "PostToolUse", "tool_input": {"file_path": str(product)}}]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.guard(payload)
        self.write_binding("{not json")
        self.guard(self.payload(notes))
        self.assertEqual(len(self.cases), len(payloads) + 1)
        decisions = [json.loads(fence.stdout)["decision"] for _, _, fence in self.cases]
        self.assertEqual(decisions[:3], ["deny", "allow", "deny"])
        self.assertIn("allow", decisions)
        doc = json.loads(self.cases[0][2].stdout)
        self.assertEqual(doc["actor"], "pm")
        self.assertEqual(len(doc["targets"]), 1)
        self.assertEqual(doc["targets"][0]["class"], "PROD")
        self.assertTrue(same_path(doc["targets"][0]["path"], product))
        multi = json.loads(self.cases[8][2].stdout)
        self.assertEqual(sorted(t["class"] for t in multi["targets"]), ["PMT", "PROD"])
        self.assertEqual(multi["decision"], "deny")

    def test_when_fence_stdin_is_not_json_decision_is_deny_and_exit_0(self):
        for stdin in ("not json {{", "", "[]", "null", '"Edit"'):
            with self.subTest(stdin=stdin):
                proc = self.mm("fence", "--json", stdin=stdin)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                doc = json.loads(proc.stdout)
                self.assertEqual(doc["schema"], "mm.fence/1")
                self.assertEqual(doc["decision"], "deny")
                self.assertEqual(doc["actor"], "unknown")
                self.assertEqual(doc["targets"], [])
                self.assertTrue(doc["messages"] and doc["messages"][0].startswith("mm guard:"))
                guard = self.run_py(GUARD, stdin=stdin)
                self.assertEqual(guard.returncode, 2)
                self.assertEqual("\n".join(doc["messages"]), guard.stderr.rstrip("\n"))
        self.assertEqual(self.mm("fence").returncode, 2)


if __name__ == "__main__":
    unittest.main()
