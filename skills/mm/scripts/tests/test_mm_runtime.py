import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import ast
import contextlib
import datetime
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import mm
import mm_compile
import mm_git
import mm_ledger

SKILL = pathlib.Path(__file__).resolve().parent.parent.parent
GOLDEN = pathlib.Path(__file__).resolve().parent / "fixtures" / "status_r25_golden.txt"
DUBIOUS = "fatal: detected dubious ownership in repository at 'x'"
STATUS_FIELDS = {"schema": str, "ok": bool, "generated_at": str, "mm_version": str, "session": dict,
                 "task_source": str, "task": dict, "mode": str, "open_row": dict, "rows": list,
                 "waiting_on_operator": list, "inbox": dict, "dispatches_in_flight": list, "loop": dict,
                 "check": dict, "uncommitted": list, "errors": list}
SESSION_FIELDS = {"id", "binding_state", "bound", "role", "role_source", "bound_at"}
TASK_FIELDS = {"name", "dir", "repo_root", "repo_root_source", "dir_exists", "legacy", "revision"}
ROW_FIELDS = {"id", "item", "state", "status_label", "blocked", "user_facing", "test_level", "pr", "test_page",
              "is_wrapup"}
FLIGHT_FIELDS = {"id", "at", "route", "model", "row", "mode", "worker", "approval_id", "last_verdict"}
LOOP_FIELDS = {"mode", "cadence", "routes", "noop_count", "noop_cap", "last_tick", "stopped_reason", "owner_session"}
NOT_RUN = {"status": "not_run", "code": None, "lines": []}


class RuntimeCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.home.mkdir()
        env = {
            "MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state"), "HOME": str(self.home),
            "USERPROFILE": str(self.home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(self.home / "gc"),
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
        self.task = self.repo / ".private" / "pm" / "active" / "widget"

    def git(self, *argv, cwd=None):
        proc = subprocess.run(["git", *argv], cwd=str(cwd or self.repo), capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        self.assertEqual(proc.returncode, 0, "git %s: %s" % (" ".join(argv), proc.stderr))
        return proc.stdout

    def mm(self, *argv, stdin=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(sys, "stdin", io.StringIO(stdin or "")):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        rc, out, err = self.mm(*argv)
        self.assertEqual(rc, 0, "mm %s -> %d\n%s\n%s" % (" ".join(map(str, argv)), rc, out, err))
        return out

    def scaffold(self, task=None, *rows):
        task = task or self.task
        argv = ["scaffold", "--task-dir", task, "--task", task.name, "--project", "smoke-project"]
        for row in rows or ("Row one",):
            argv += ["--row", row]
        self.ok(*argv)
        return task

    def status(self, *argv):
        rc, out, err = self.mm("status", "--json", *argv)
        self.assertEqual(rc, 0, out + err)
        return json.loads(out)

    def human(self, task=None):
        return self.ok("status", "--task-dir", task or self.task)

    def write_binding(self, record, session="s1"):
        path = self.tmp / "state" / "sessions" / ("%s.json" % session)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(record if isinstance(record, str) else json.dumps(record), encoding="utf-8")

    def section(self, text, heading):
        return text.split(heading + "\n", 1)[1].split("\n\n", 1)[0].splitlines()

    def codes(self, doc):
        return [e["code"] for e in doc["errors"]]

    def force(self, doc):
        mm_ledger.save_ledger(self.task, doc, expected_revision=doc["revision"], updated_by="test")
        doc = mm_ledger.load_ledger(self.task)
        files = mm_compile.render_files(doc)
        mm_compile.record_compile(doc, files, doc["revision"] + 1)
        mm_ledger.save_ledger(self.task, doc, expected_revision=doc["revision"], updated_by="test")
        for name, text in files.items():
            (self.task / name).write_text(text, encoding="utf-8", newline="\n")

    def assert_unfilled(self, doc, *names):
        for name in names:
            self.assertIsNone(doc[name], name)


class StatusJsonTests(RuntimeCase):
    def test_when_status_json_runs_on_a_bound_session_it_returns_every_schema_field(self):
        self.scaffold(None, "Build the widget", "Ship it")
        self.ok("loop", "off", "--task-dir", self.task, "--reason", "not now")
        self.ok("bind", "--task-dir", self.task, "--session", "s1")
        doc = self.status("--session", "s1")
        self.assertEqual(set(doc), set(STATUS_FIELDS))
        for name, kind in STATUS_FIELDS.items():
            self.assertIsInstance(doc[name], kind, name)
        self.assertEqual(doc["schema"], "mm.status/1")
        self.assertEqual(doc["mm_version"], mm.VERSION)
        self.assertIsNotNone(datetime.datetime.fromisoformat(doc["generated_at"]).tzinfo)
        self.assertTrue(doc["ok"])
        self.assertEqual(doc["errors"], [])
        self.assertEqual(set(doc["session"]), SESSION_FIELDS)
        self.assertEqual(doc["session"]["id"], "s1")
        self.assertEqual(doc["session"]["binding_state"], "ok")
        self.assertIs(doc["session"]["bound"], True)
        self.assertEqual((doc["session"]["role"], doc["session"]["role_source"]), ("pm", "binding"))
        self.assertIsInstance(doc["session"]["bound_at"], str)
        self.assertEqual(doc["task_source"], "session")
        self.assertEqual(set(doc["task"]), TASK_FIELDS)
        self.assertEqual(doc["task"]["name"], "widget")
        self.assertEqual(pathlib.Path(doc["task"]["dir"]), self.task.absolute())
        self.assertEqual(pathlib.Path(doc["task"]["repo_root"]).resolve(), self.repo.resolve())
        self.assertEqual(doc["task"]["repo_root_source"], "git")
        self.assertIs(doc["task"]["dir_exists"], True)
        self.assertIs(doc["task"]["legacy"], False)
        ledger = json.loads((self.task / "ledger.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["task"]["revision"], ledger["revision"])
        self.assertEqual([r["id"] for r in doc["rows"]], [r["id"] for r in ledger["rows"]])
        for row, source in zip(doc["rows"], ledger["rows"]):
            self.assertEqual(set(row), ROW_FIELDS)
            self.assertEqual((row["item"], row["state"], row["status_label"], row["blocked"]),
                             (source["item"], source["state"], source["status_label"], source["blocked"]))
            self.assertIsNone(row["test_level"])
        self.assertIs(doc["rows"][-1]["is_wrapup"], True)
        self.assertEqual(doc["open_row"], {"id": "#1", "item": "Build the widget", "state": ledger["rows"][0]["state"],
                                           "status_label": ledger["rows"][0]["status_label"]})
        self.assertEqual(set(doc["loop"]), LOOP_FIELDS)
        self.assertEqual((doc["loop"]["mode"], doc["loop"]["stopped_reason"], doc["loop"]["last_tick"]),
                         ("off", "not now", None))
        self.assertEqual(doc["check"]["status"], "ok")
        self.assertEqual(doc["check"]["code"], 0)
        self.assertIn("MM-CHECK-OK", doc["check"]["lines"])
        human = self.human()
        self.assertIn("Mode: %s" % doc["mode"], human)
        self.assertEqual(self.section(human, "Waiting on the operator:"),
                         ["- " + w["text"] for w in doc["waiting_on_operator"]] or ["- nothing"])
        inbox = doc["inbox"]
        self.assertIn("Inbox: %d unprocessed entries, %d scan problems, %d closed-task files"
                      % (inbox["entries"], inbox["problems"], inbox["closed_task_files"]), human)
        self.assertTrue(doc["uncommitted"])
        self.assertEqual(self.section(human, "Uncommitted PM changes:"), ["- " + l for l in doc["uncommitted"]])
        self.assertEqual(doc["dispatches_in_flight"], [])

    def test_when_status_json_runs_with_task_dir_task_source_is_explicit(self):
        self.scaffold()
        doc = self.status("--task-dir", self.task)
        self.assertEqual(doc["task_source"], "explicit")
        self.assertEqual(doc["session"], {"id": None, "binding_state": "not-asked", "bound": False, "role": None,
                                          "role_source": None, "bound_at": None})
        self.assertEqual(pathlib.Path(doc["task"]["repo_root"]).resolve(), self.repo.resolve())
        self.assertEqual(doc["task"]["repo_root_source"], "git")
        self.assertEqual(doc["mode"], "attended")
        self.assertIsNone(doc["loop"])
        self.assertTrue(doc["ok"], doc["errors"])

    def test_when_a_row_needs_decision_status_json_lists_it_as_waiting_kind_decision(self):
        self.scaffold(None, "Build the widget", "Ship it")
        self.ok("add-row", "--task-dir", self.task, "--item", "Pick an API")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#4", "--blocked", "--reason", "which API")
        self.ok("edit-row", "--task-dir", self.task, "--id", "#2", "--user-facing")
        doc = self.status("--task-dir", self.task)
        waiting = {w["row"]: w for w in doc["waiting_on_operator"]}
        self.assertEqual(waiting["#4"], {"row": "#4", "kind": "decision", "text": "#4 needs a decision: which API"})
        self.assertEqual(waiting["#2"]["kind"], "human_check")
        self.assertEqual(self.section(self.human(), "Waiting on the operator:"),
                         ["- " + w["text"] for w in doc["waiting_on_operator"]])
        self.assertEqual([w["row"] for w in doc["waiting_on_operator"]], ["#2", "#4"])

    def test_when_a_dispatch_is_in_flight_status_json_lists_its_record(self):
        self.scaffold()
        prompt = self.tmp / "prompt.md"
        prompt.write_text("do the thing\n", encoding="utf-8")
        self.ok("dispatch", "--task-dir", self.task, "--route", "bg-it", "--model", "sonnet", "--prompt-file", prompt,
                "--approved-by", "Test Operator", "--row", "#1")
        doc = self.status("--task-dir", self.task)
        self.assertEqual(len(doc["dispatches_in_flight"]), 1)
        flight = doc["dispatches_in_flight"][0]
        self.assertEqual(set(flight), FLIGHT_FIELDS)
        self.assertEqual({k: flight[k] for k in ("id", "route", "model", "row", "mode", "worker", "approval_id",
                                                  "last_verdict")},
                         {"id": "d1", "route": "bg-it", "model": "sonnet", "row": "#1", "mode": "attended",
                          "worker": None, "approval_id": None, "last_verdict": None})
        self.assertIsNotNone(datetime.datetime.fromisoformat(flight["at"]))
        self.assertIn("- d1 bg-it:sonnet (last check: none)", self.human())

    def test_when_ledger_has_fixable_findings_status_json_check_status_is_fixable(self):
        self.scaffold(None, "Build the widget", "Ship it")
        doc = json.loads((self.task / "ledger.json").read_text(encoding="utf-8"))
        doc["rows"].insert(1, doc["rows"].pop())
        self.force(doc)
        status = self.status("--task-dir", self.task)
        self.assertEqual((status["check"]["status"], status["check"]["code"]), ("fixable", 3))
        self.assertTrue(any("WRAPUP-NOT-LAST" in line for line in status["check"]["lines"]))
        self.assertLessEqual(len(status["check"]["lines"]), 20)
        self.assertTrue(status["ok"])


class StatusFailureDocumentTests(RuntimeCase):
    def test_when_the_binding_holds_a_broad_repo_root_status_json_reports_fence_root_too_broad_and_names_unbind(self):
        self.scaffold()
        self.write_binding({"task_dir": str(self.task.absolute()), "bound_at": "2026-01-01T00:00:00+00:00",
                            "role": "pm", "repo_root": str(self.home), "repo_root_source": "no-git"})
        doc = self.status("--session", "s1")
        self.assertIs(doc["ok"], False)
        self.assertIs(doc["session"]["bound"], True)
        self.assertEqual(doc["task"]["repo_root"], str(self.home))
        self.assertEqual(self.codes(doc), ["FENCE-ROOT-TOO-BROAD"])
        message = doc["errors"][0]["message"]
        self.assertIn("mm.py unbind --session s1", message)
        self.assertIn("bind refuses that root", message)
        self.assertTrue(doc["rows"])
        self.assertEqual(doc["check"]["status"], "ok")

    def test_when_session_is_unbound_status_json_returns_bound_false_and_null_task(self):
        doc = self.status("--session", "never-bound")
        self.assertIs(doc["ok"], True)
        self.assertEqual(doc["session"], {"id": "never-bound", "binding_state": "absent", "bound": False,
                                          "role": None, "role_source": None, "bound_at": None})
        self.assertEqual(doc["task_source"], "none")
        self.assert_unfilled(doc, "task", "mode", "open_row", "inbox", "loop", "uncommitted")
        self.assertEqual((doc["rows"], doc["waiting_on_operator"], doc["dispatches_in_flight"], doc["errors"]),
                         ([], [], [], []))
        self.assertEqual(doc["check"], NOT_RUN)

    def test_when_binding_file_is_corrupt_status_json_returns_binding_unreadable_and_role_pm(self):
        self.write_binding("{not json")
        doc = self.status("--session", "s1")
        self.assertIs(doc["ok"], False)
        self.assertEqual({k: doc["session"][k] for k in ("binding_state", "bound", "role", "role_source")},
                         {"binding_state": "unreadable", "bound": True, "role": "pm", "role_source": "fail-closed"})
        self.assertEqual(self.codes(doc), ["BINDING-UNREADABLE"])
        self.assertIn("mm.py unbind --session s1, then mm.py bind --task-dir <task> --session s1",
                      doc["errors"][0]["message"])
        self.assertEqual(doc["task_source"], "session")
        self.assert_unfilled(doc, "task", "mode", "open_row", "inbox", "loop", "uncommitted")
        self.assertEqual((doc["rows"], doc["waiting_on_operator"], doc["dispatches_in_flight"]), ([], [], []))
        self.assertEqual(doc["check"], NOT_RUN)

    def test_when_bound_task_folder_was_moved_status_json_returns_task_dir_missing(self):
        self.scaffold()
        self.ok("bind", "--task-dir", self.task, "--session", "s1")
        done = self.repo / ".private" / "pm" / "done"
        done.mkdir(parents=True)
        shutil.move(str(self.task), str(done / "widget"))
        doc = self.status("--session", "s1")
        self.assertIs(doc["ok"], False)
        self.assertEqual(self.codes(doc), ["TASK-DIR-MISSING"])
        self.assertIn("mm.py unbind --session s1", doc["errors"][0]["message"])
        task = doc["task"]
        self.assertEqual((task["name"], task["dir_exists"], task["legacy"], task["revision"]),
                         ("widget", False, False, None))
        self.assertEqual(pathlib.Path(task["dir"]), self.task.absolute())
        self.assertEqual(pathlib.Path(task["repo_root"]).resolve(), self.repo.resolve())
        self.assert_unfilled(doc, "mode", "open_row", "inbox", "loop", "uncommitted")
        self.assertEqual((doc["rows"], doc["waiting_on_operator"], doc["dispatches_in_flight"]), ([], [], []))
        self.assertEqual(doc["check"], NOT_RUN)

    def test_when_ledger_is_invalid_status_json_returns_ledger_invalid_and_check_failed(self):
        self.scaffold()
        (self.task / "ledger.json").write_text("{not json", encoding="utf-8")
        doc = self.status("--task-dir", self.task)
        self.assertIs(doc["ok"], False)
        self.assertEqual(self.codes(doc), ["LEDGER-INVALID"])
        self.assertIn("mm.py check --task-dir", doc["errors"][0]["message"])
        self.assertEqual(doc["rows"], [])
        self.assert_unfilled(doc, "open_row", "mode", "loop")
        self.assertEqual(doc["inbox"], {"entries": 0, "problems": 0, "closed_task_files": 0})
        self.assertEqual((doc["check"]["status"], doc["check"]["code"]), ("failed", 1))
        self.assertTrue(doc["check"]["lines"])

    def test_when_dispatches_jsonl_is_malformed_status_json_returns_dispatches_unreadable_and_no_flights(self):
        self.scaffold()
        store = self.task / "prompts" / "dispatches.jsonl"
        store.parent.mkdir(parents=True, exist_ok=True)
        for data in (b'{"id":\n', b'[1]\n', b'\xff\xfe{"id": "d1"}\n'):
            with self.subTest(data=data):
                store.write_bytes(data)
                doc = self.status("--task-dir", self.task)
                self.assertIs(doc["ok"], False)
                self.assertEqual(self.codes(doc), ["DISPATCHES-UNREADABLE"])
                self.assertEqual(doc["dispatches_in_flight"], [])
                message = doc["errors"][0]["message"]
                self.assertIn(str(store), message)
                self.assertTrue(message.endswith("move the bad line aside, and run mm.py status again"), message)
                self.assertTrue(doc["rows"])
                self.assertEqual(doc["check"]["status"], "ok")

    def test_when_dispatches_jsonl_cannot_be_read_status_json_returns_dispatches_unreadable(self):
        self.scaffold()
        store = self.task / "prompts" / "dispatches.jsonl"
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text("", encoding="utf-8")
        real = pathlib.Path.read_text

        def read_text(path, *a, **k):
            if path.name == "dispatches.jsonl":
                raise PermissionError(13, "Permission denied", str(path))
            return real(path, *a, **k)
        with mock.patch.object(pathlib.Path, "read_text", read_text):
            doc = self.status("--task-dir", self.task)
        self.assertIs(doc["ok"], False)
        self.assertEqual(self.codes(doc), ["DISPATCHES-UNREADABLE"])
        self.assertEqual(doc["dispatches_in_flight"], [])
        self.assertIn("Permission denied", doc["errors"][0]["message"])

    def test_when_an_inbox_entry_cannot_be_read_status_json_returns_inbox_unreadable_and_inbox_null(self):
        self.scaffold()
        inbox = self.task / "inbox"
        inbox.mkdir(exist_ok=True)
        (inbox / "20261003-120000-worker.md").write_text("report\n", encoding="utf-8")
        real = pathlib.Path.read_text

        def read_text(path, *a, **k):
            if path.name == "20261003-120000-worker.md":
                raise PermissionError(13, "Permission denied", str(path))
            return real(path, *a, **k)
        with mock.patch.object(pathlib.Path, "read_text", read_text):
            doc = self.status("--task-dir", self.task)
        self.assertIs(doc["ok"], False)
        self.assertEqual(self.codes(doc), ["INBOX-UNREADABLE"])
        self.assertIsNone(doc["inbox"])
        message = doc["errors"][0]["message"]
        self.assertIn("Permission denied", message)
        self.assertTrue(message.endswith("run mm.py inbox-scan --task-dir %s to see which file, fix or move it aside, "
                                         "and run mm.py status again" % self.task.absolute()), message)
        self.assertTrue(doc["rows"])

    def test_when_status_json_has_neither_task_dir_nor_session_exits_2(self):
        rc, out, err = self.mm("status", "--json")
        self.assertEqual(rc, 2, out + err)
        self.assertEqual(out, "")

    def test_when_binding_has_no_repo_root_status_json_reports_binding_legacy_and_names_bind(self):
        self.scaffold()
        self.write_binding({"task_dir": str(self.task.absolute()), "bound_at": "2026-01-01T00:00:00+00:00"})
        doc = self.status("--session", "s1")
        self.assertIs(doc["ok"], False)
        self.assertEqual((doc["session"]["bound"], doc["session"]["role_source"]), (True, "legacy-default"))
        self.assertIsNone(doc["task"]["repo_root"])
        self.assertEqual(self.codes(doc), ["BINDING-LEGACY"])
        self.assertIn("mm.py bind --task-dir %s --session s1" % self.task.absolute(), doc["errors"][0]["message"])
        self.assertTrue(doc["rows"])
        self.assertEqual(doc["mode"], "attended")
        self.assertEqual(doc["check"]["status"], "ok")


class HumanStatusTests(RuntimeCase):
    def test_when_status_runs_without_json_output_matches_the_r25_golden_text(self):
        task = self.tmp / "proj" / ".private" / "pm" / "active" / "widget"
        self.scaffold(task, "Build the widget", "Write the notes", "Ship it")
        self.ok("edit-row", "--task-dir", task, "--id", "#3", "--user-facing", "--test-level", "e2e", "--pr", "PR 12",
                "--test-page", "http://localhost:3000/w")
        self.ok("add-row", "--task-dir", task, "--item", "Pick an API")
        self.ok("mark-row", "--task-dir", task, "--id", "#5", "--blocked", "--reason", "which API")
        self.assertEqual(self.human(task), GOLDEN.read_text(encoding="utf-8"))
        rc, out, err = self.mm("status")
        self.assertEqual(rc, 2, out + err)


class ProductChangesTests(RuntimeCase):
    def changes(self, task=None, baseline=None):
        argv = ["product-changes", "--task-dir", task or self.task, "--json"]
        stdin = None
        if baseline is not None:
            stdin = json.dumps(baseline)
            argv += ["--baseline", "-"]
        rc, out, err = self.mm(*argv, stdin=stdin)
        self.assertEqual(rc, 0, out + err)
        doc = json.loads(out)
        self.assertEqual(doc["schema"], "mm.changes/1")
        return doc

    def commit_file(self, rel, text="one\n"):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        self.git("add", rel)
        self.git("commit", "-qm", "add " + rel)
        return path

    def test_when_an_already_dirty_file_is_edited_again_product_changes_lists_it_as_changed(self):
        self.scaffold()
        path = self.commit_file("src/a.py")
        path.write_text("two\n", encoding="utf-8")
        before = self.changes()
        self.assertIn("src/a.py", before["files"])
        path.write_text("three, longer\n", encoding="utf-8")
        baseline = self.tmp / "baseline.json"
        baseline.write_text(json.dumps(before), encoding="utf-8")
        rc, out, err = self.mm("product-changes", "--task-dir", self.task, "--json", "--baseline", baseline)
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(json.loads(out)["changed"], ["src/a.py"])

    def test_when_a_new_untracked_file_appears_product_changes_lists_it(self):
        self.scaffold()
        before = self.changes()
        self.assertNotIn("changed", before)
        (self.repo / "src").mkdir()
        (self.repo / "src" / "new.py").write_text("x\n", encoding="utf-8")
        after = self.changes(baseline=before)
        self.assertEqual(after["changed"], ["src/new.py"])
        size, mtime_ns = after["files"]["src/new.py"]
        self.assertEqual(size, (self.repo / "src" / "new.py").stat().st_size)
        self.assertIsInstance(mtime_ns, int)

    def test_when_a_rename_shows_in_either_status_column_product_changes_lists_both_paths(self):
        self.scaffold()
        self.commit_file("src/old.py", "line one\nline two\nline three\n")
        self.commit_file("a", "aaaa\nbbbb\ncccc\n")
        self.commit_file("src/moved.py", "m one\nm two\nm three\n")
        os.replace(self.repo / "src" / "old.py", self.repo / "src" / "new.py")
        self.git("add", "-N", "src/new.py")
        os.replace(self.repo / "a", self.repo / "b")
        self.git("add", "-N", "b")
        self.git("mv", "src/moved.py", "src/kept.py")
        with open(self.repo / "src" / "kept.py", "a", encoding="utf-8") as f:
            f.write("m four\n")
        status = self.git("status", "--porcelain=v1", "-z", "--untracked-files=all")
        for entry in (" R src/new.py\0src/old.py\0", " R b\0a\0", "RM src/kept.py\0src/moved.py\0"):
            self.assertIn(entry, status)
        files = self.changes()["files"]
        self.assertEqual(sorted(files), ["a", "b", "src/kept.py", "src/moved.py", "src/new.py", "src/old.py"])
        self.assertEqual([files[p] for p in ("a", "src/old.py", "src/moved.py")], [None, None, None])

    def test_when_porcelain_marks_a_rename_or_copy_in_either_column_the_source_entry_is_consumed(self):
        import mm_runtime
        out = " R new.py\0old.py\0C  c2.py\0c1.py\0 C c4.py\0c3.py\0RM x\0y\0?? u.py\0"
        self.assertEqual(mm_runtime._porcelain_paths(out), ["new.py", "old.py", "c2.py", "c4.py", "x", "y", "u.py"])

    def test_when_only_pm_tree_files_change_product_changes_lists_nothing(self):
        self.scaffold()
        before = self.changes()
        (self.task / "notes.md").write_text("n\n", encoding="utf-8")
        (self.repo / ".private" / "pm" / "DASHBOARD.md").write_text("d\n", encoding="utf-8")
        self.ok("add-row", "--task-dir", self.task, "--item", "more")
        after = self.changes(baseline=before)
        self.assertEqual(after["changed"], [])
        self.assertFalse([p for p in after["files"] if ".private/pm" in p], after["files"])

    def test_when_the_task_is_not_in_a_git_repo_product_changes_returns_empty_and_exit_0(self):
        task = self.scaffold(self.tmp / "plain" / ".private" / "pm" / "active" / "widget")
        doc = self.changes(task)
        self.assertEqual((doc["repo_root"], doc["head"], doc["files"]), (None, None, {}))

    def test_when_a_clean_file_is_edited_and_committed_between_snapshots_product_changes_lists_it(self):
        self.scaffold()
        path = self.commit_file("src/a.py")
        self.git("add", ".private")
        self.git("commit", "-qm", "pm")
        before = self.changes()
        self.assertEqual(before["files"], {})
        path.write_text("edited\n", encoding="utf-8")
        self.git("commit", "-qam", "edit")
        after = self.changes(baseline=before)
        self.assertNotEqual(after["head"], before["head"])
        self.assertEqual(after["changed"], ["src/a.py"])

    def test_when_head_moves_by_a_pm_tree_commit_only_product_changes_lists_nothing(self):
        self.scaffold()
        before = self.changes()
        self.git("add", ".private")
        self.git("commit", "-qm", "pm only")
        after = self.changes(baseline=before)
        self.assertNotEqual(after["head"], before["head"])
        self.assertEqual(after["changed"], [])

    def unborn(self):
        repo = self.tmp / "fresh"
        repo.mkdir()
        self.git("init", "-q", "-b", "main", cwd=repo)
        task = self.scaffold(repo / ".private" / "pm" / "active" / "widget")
        (repo / "src").mkdir()
        (repo / "src" / "a.py").write_text("x\n", encoding="utf-8")
        return repo, task

    def test_when_the_repo_has_no_commit_yet_product_changes_exits_0_with_head_null(self):
        repo, task = self.unborn()
        doc = self.changes(task)
        self.assertIsNone(doc["head"])
        self.assertEqual(pathlib.Path(doc["repo_root"]).resolve(), repo.resolve())
        self.assertEqual(list(doc["files"]), ["src/a.py"])

    def test_when_the_first_commit_lands_between_snapshots_product_changes_lists_its_product_files(self):
        repo, task = self.unborn()
        before = self.changes(task)
        self.assertIsNone(before["head"])
        self.git("add", "-A", cwd=repo)
        self.git("commit", "-qm", "first", cwd=repo)
        after = self.changes(task, baseline=before)
        self.assertIsNotNone(after["head"])
        self.assertEqual(after["files"], {})
        self.assertEqual(after["changed"], ["src/a.py"])

    def failing(self, rule):
        real = mm_git._git

        def fake(argv, cwd, stdin=None):
            found = rule(list(argv))
            return found if found is not None else real(argv, cwd, stdin)
        return mock.patch.object(mm_git, "_git", fake)

    def assert_git_failed(self, rc, out, err, text):
        self.assertEqual(rc, 21, out + err)
        self.assertEqual(out, "")
        self.assertIn(text, err)
        self.assertNotIn("Traceback", err)

    def test_when_rev_parse_head_fails_with_another_exit_code_product_changes_exits_21(self):
        self.scaffold()

        def rule(argv):
            if argv == ["rev-parse", "--verify", "-q", "HEAD"]:
                return subprocess.CompletedProcess(argv, 128, "", "fatal: bad object HEAD\n")
        with self.failing(rule):
            self.assert_git_failed(*self.mm("product-changes", "--task-dir", self.task, "--json"), "fatal: bad object")

    def test_when_head_is_not_verifiable_and_rev_parse_git_dir_fails_product_changes_exits_21(self):
        self.scaffold()

        def rule(argv):
            if argv == ["rev-parse", "--verify", "-q", "HEAD"]:
                return subprocess.CompletedProcess(argv, 1, "", "")
            if argv == ["rev-parse", "--git-dir"]:
                return subprocess.CompletedProcess(argv, 128, "", "fatal: not a git dir any more\n")
        with self.failing(rule):
            self.assert_git_failed(*self.mm("product-changes", "--task-dir", self.task, "--json"),
                                   "fatal: not a git dir any more")

    def test_when_git_is_not_on_path_inside_a_repo_product_changes_exits_21_and_prints_no_document(self):
        self.scaffold()
        real = shutil.which
        with mock.patch("shutil.which", lambda name, *a, **k: None if name in ("git", "git.exe") else real(name, *a, **k)):
            self.assert_git_failed(*self.mm("product-changes", "--task-dir", self.task, "--json"),
                                   "git was not found on PATH")

    def test_when_git_rev_parse_fails_product_changes_exits_21_with_the_git_error_line(self):
        self.scaffold()

        def rule(argv):
            if "--show-toplevel" in argv:
                return subprocess.CompletedProcess(argv, 128, "", DUBIOUS + "\nTo add an exception, call:\n")
        with self.failing(rule):
            rc, out, err = self.mm("product-changes", "--task-dir", self.task, "--json")
        self.assert_git_failed(rc, out, err, DUBIOUS)
        self.assertNotIn("To add an exception", err)

    def submodule(self):
        lib = self.tmp / "lib"
        lib.mkdir()
        self.git("init", "-q", "-b", "main", cwd=lib)
        for name in ("a.py", "b.py", "c.py"):
            (lib / name).write_text(name + "\n", encoding="utf-8")
        self.git("add", ".", cwd=lib)
        self.git("commit", "-qm", "lib", cwd=lib)
        self.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", str(lib), "lib")
        self.git("commit", "-qm", "add lib")
        sub = self.repo / "lib"
        (sub / "a.py").write_text("a, dirty\n", encoding="utf-8")
        return sub

    def test_when_a_file_inside_an_already_dirty_submodule_is_edited_product_changes_lists_it(self):
        self.scaffold()
        sub = self.submodule()
        before = self.changes()
        self.assertIn("lib", before["files"])
        self.assertIn("lib/a.py", before["files"])
        (sub / "b.py").write_text("b, edited later\n", encoding="utf-8")
        after = self.changes(baseline=before)
        self.assertIn("lib/b.py", after["files"])
        self.assertEqual(after["changed"], ["lib/b.py"])

    def test_when_a_commit_inside_an_already_dirty_submodule_moves_its_head_product_changes_lists_the_file(self):
        self.scaffold()
        sub = self.submodule()
        before = self.changes()
        (sub / "c.py").write_text("c, committed\n", encoding="utf-8")
        self.git("add", "c.py", cwd=sub)
        self.git("commit", "-qm", "c", cwd=sub)
        after = self.changes(baseline=before)
        self.assertNotEqual(after["submodules"]["lib"], before["submodules"]["lib"])
        self.assertIn("lib/c.py", after["changed"])
        self.assertNotIn("lib/a.py", after["changed"])

    def test_when_git_status_fails_inside_a_dirty_submodule_product_changes_exits_21(self):
        self.scaffold()
        sub = self.submodule()
        real = mm_git._git

        def fake(argv, cwd, stdin=None):
            if argv[:1] == ["status"] and pathlib.Path(cwd) == sub:
                return subprocess.CompletedProcess(argv, 128, "", "fatal: submodule index is corrupt\n")
            return real(argv, cwd, stdin)
        with mock.patch.object(mm_git, "_git", fake):
            self.assert_git_failed(*self.mm("product-changes", "--task-dir", self.task, "--json"),
                                   "fatal: submodule index is corrupt")


FORBIDDEN = ("integrations/", "mm-runtime", "claude-plugin", "$.")
EXEMPT = ("scripts/tests/", "scripts/mm_runtime_install.py")
MARKER = "MM_CC_RUNTIME_MOD_ACTIVE"


def core_python(skill):
    """(scanned, exempted) relative paths of every .py under hooks/ and scripts/."""
    scanned, exempted = [], []
    for path in sorted((skill / "hooks").rglob("*.py")) + sorted((skill / "scripts").rglob("*.py")):
        rel = path.relative_to(skill).as_posix()
        (exempted if any(rel == e or (e.endswith("/") and rel.startswith(e)) for e in EXEMPT) else scanned).append(rel)
    return scanned, exempted


class PortableCoreTests(unittest.TestCase):
    def test_when_core_python_is_scanned_no_file_references_the_claude_code_plugin(self):
        scanned, _ = core_python(SKILL)
        holders = []
        for rel in scanned:
            text = (SKILL / rel).read_text(encoding="utf-8")
            for word in FORBIDDEN:
                self.assertFalse(word in text, "%s names %r" % (rel, word))
            for node in ast.walk(ast.parse(text)):
                names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                         else [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
                self.assertFalse([n for n in names if n.split(".")[0] == "mm_runtime_install"], rel)
            if MARKER in text:
                holders.append(rel)
        self.assertEqual(holders, ["hooks/pm_status.py"])

    def test_the_r19_exemptions_are_exactly_the_installer_and_scripts_tests(self):
        self.assertEqual(EXEMPT, ("scripts/tests/", "scripts/mm_runtime_install.py"))
        scanned, exempted = core_python(SKILL)
        for rel in exempted:
            self.assertTrue(rel.startswith("scripts/tests/") or rel == "scripts/mm_runtime_install.py", rel)
        for rel in ("hooks/guard.py", "hooks/hookio.py", "hooks/pm_status.py", "hooks/check-handoff.py",
                    "scripts/mm.py", "scripts/mm_fence.py", "scripts/mm_runtime.py", "scripts/mm_where.py"):
            self.assertIn(rel, scanned)
        self.assertIn("scripts/tests/test_mm_runtime.py", exempted)
        every = sorted(p.relative_to(SKILL).as_posix() for d in ("hooks", "scripts") for p in (SKILL / d).rglob("*.py"))
        self.assertEqual(sorted(scanned + exempted), every)


if __name__ == "__main__":
    unittest.main()
