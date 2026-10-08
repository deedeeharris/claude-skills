import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import ast
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import build_pm_dashboard
import mm
import mm_compile
import mm_inbox
import mm_ledger
import mm_loop

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent
MM_PY = SCRIPTS / "mm.py"
WRAPUP = "Wrap up: insights review + move to done/"


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.project = self.tmp / "proj"
        self.task = self.project / ".private" / "pm" / "active" / "widget"

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        rc, out, err = self.mm(*argv)
        self.assertEqual(rc, 0, "mm %s -> %d\n%s\n%s" % (" ".join(map(str, argv)), rc, out, err))
        return out, err

    def scaffold(self, *rows):
        args = ["scaffold", "--task-dir", self.task, "--task", "widget", "--project", "smoke-project"]
        for r in rows:
            args += ["--row", r]
        self.ok(*args)

    def doc(self):
        return json.loads((self.task / "ledger.json").read_text(encoding="utf-8"))

    def row(self, rid):
        return next(r for r in self.doc()["rows"] if r["id"] == rid)

    def ids(self):
        return [r["id"] for r in self.doc()["rows"]]

    def handoff(self):
        return (self.task / "HANDOFF.md").read_text(encoding="utf-8")

    def ledger_bytes(self):
        return (self.task / "ledger.json").read_bytes()

    def textfile(self, text, name="text.txt"):
        path = self.tmp / name
        path.write_text(text + "\n", encoding="utf-8", newline="\n")
        return path

    def force(self, doc):
        """Write a ledger and its generated files directly, bypassing the
        CLI's write checks, to build states the CLI itself refuses."""
        mm_ledger.save_ledger(self.task, doc, expected_revision=doc["revision"], updated_by="test")
        doc = mm_ledger.load_ledger(self.task)
        files = mm_compile.render_files(doc)
        mm_compile.record_compile(doc, files, doc["revision"] + 1)
        mm_ledger.save_ledger(self.task, doc, expected_revision=doc["revision"], updated_by="test")
        for name, text in files.items():
            (self.task / name).write_text(text, encoding="utf-8", newline="\n")


class ScaffoldTests(CliCase):
    def test_cli_version_prints_mm_cli_prefix(self):
        proc = subprocess.run([sys.executable, str(MM_PY), "--version"], capture_output=True, text=True,
                              encoding="utf-8", timeout=60)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(proc.stdout.startswith("mm-cli "), proc.stdout)

    def test_when_scaffold_runs_ledger_validates_and_handoff_matches_compile(self):
        rc, out, _ = self.mm("scaffold", "--task-dir", self.task, "--task", "widget", "--project",
                             "smoke-project", "--row", "Build the widget")
        self.assertEqual(rc, 0)
        self.assertIn("MM-SCAFFOLD-OK", out)
        doc = mm_ledger.load_ledger(self.task)
        self.assertEqual(self.handoff(), mm_compile.render_files(doc)["HANDOFF.md"])
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)

    def test_when_scaffold_runs_wrapup_row_is_last_and_unique(self):
        self.scaffold("One", "Two")
        rows = self.doc()["rows"]
        self.assertEqual([r["id"] for r in rows], ["#1", "#2", "#3"])
        self.assertEqual([r["is_wrapup"] for r in rows], [False, False, True])
        self.assertEqual(rows[-1]["item"], WRAPUP)

    def test_when_scaffold_target_exists_it_refuses_and_writes_nothing(self):
        self.task.mkdir(parents=True)
        (self.task / "notes.md").write_text("mine\n", encoding="utf-8")
        rc, _, err = self.mm("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "p")
        self.assertEqual(rc, 4)
        self.assertEqual(sorted(p.name for p in self.task.iterdir()), ["notes.md"])
        self.assertIn("exists", err)

    def test_when_scaffolded_dashboard_parse_reports_no_malformed_reason(self):
        self.scaffold("One")
        values, reason = build_pm_dashboard.parse_section_0a(self.task / "HANDOFF.md")
        self.assertEqual(reason, "")
        self.assertEqual(values["Task"], "widget")

    def test_scaffold_always_creates_a_ledger(self):
        self.scaffold()
        for name in ("ledger.json", "HANDOFF.md", "ROADMAP.html", "insights.md", "inbox/README.md",
                     "prompts/README.md"):
            self.assertTrue((self.task / name).is_file(), name)
        self.assertTrue((self.task / "inbox" / "processed").is_dir())
        for name in ("HANDOFF.md", "ROADMAP.html"):
            first = (self.task / name).read_text(encoding="utf-8").split("\n", 1)[0]
            self.assertEqual(first, mm_compile.GENERATED_HEADER)
        self.assertEqual(self.ids(), ["#1"])


class RowCommandTests(CliCase):
    def setUp(self):
        super().setUp()
        self.scaffold("Build the widget", "Write the notes")

    def test_when_add_row_runs_new_row_is_inserted_before_wrapup(self):
        self.ok("add-row", "--task-dir", self.task, "--item", "Ship it", "--user-facing", "--test-level", "e2e")
        self.assertEqual(self.ids(), ["#1", "#2", "#4", "#3"])
        new = self.row("#4")
        self.assertTrue(new["user_facing"])
        self.assertEqual(new["test_level"], "e2e")
        self.assertEqual(new["state"], "BACKLOG")

    def test_when_set_row_done_without_evidence_exits_nonzero_and_ledger_unchanged(self):
        before = self.ledger_bytes()
        rc, _, err = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE")
        self.assertEqual(rc, 5)
        self.assertIn("evidence", err)
        self.assertEqual(self.ledger_bytes(), before)

    def test_when_set_row_done_with_cmd_evidence_from_implementing_succeeds(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--evidence",
                "cmd:python -m unittest exit:0")
        row = self.row("#1")
        self.assertEqual(row["state"], "DONE")
        self.assertEqual(row["history"][-1]["evidence"], "cmd:python -m unittest exit:0")

    def test_when_backlog_to_done_with_evidence_succeeds(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--evidence",
                "human:Test Operator")
        self.assertEqual(self.row("#1")["state"], "DONE")

    def test_when_cmd_evidence_has_nonzero_exit_done_is_refused(self):
        before = self.ledger_bytes()
        rc, _, _ = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--evidence",
                           "cmd:python -m unittest exit:1")
        self.assertEqual(rc, 5)
        self.assertEqual(self.ledger_bytes(), before)

    def test_when_user_facing_row_goes_done_without_human_verified_exits_nonzero(self):
        self.ok("edit-row", "--task-dir", self.task, "--id", "#2", "--user-facing")
        rc, _, _ = self.mm("set-row", "--task-dir", self.task, "--id", "#2", "--state", "DONE", "--evidence",
                           "cmd:check exit:0")
        self.assertEqual(rc, 5)
        self.ok("set-row", "--task-dir", self.task, "--id", "#2", "--state", "HUMAN_VERIFIED", "--evidence",
                "human:Test Operator")
        self.ok("set-row", "--task-dir", self.task, "--id", "#2", "--state", "DONE")
        self.assertEqual(self.row("#2")["state"], "DONE")

    def test_when_human_verified_without_human_evidence_exits_nonzero(self):
        rc, _, _ = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "HUMAN_VERIFIED",
                           "--evidence", "cmd:check exit:0")
        self.assertEqual(rc, 5)
        self.assertEqual(self.row("#1")["state"], "BACKLOG")

    def test_when_verify_command_exits_nonzero_transition_is_refused(self):
        before = self.ledger_bytes()
        rc, _, err = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--verify",
                             "--", sys.executable, "-c", "import sys; sys.exit(3)")
        self.assertEqual(rc, 5)
        self.assertIn("exit:3", err)
        self.assertEqual(self.ledger_bytes(), before)

    def test_when_verify_command_exits_zero_evidence_is_recorded_as_run_by_mm(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--verify", "--",
                sys.executable, "-c", "import sys; sys.exit(0)")
        evidence = self.row("#1")["history"][-1]["evidence"]
        self.assertTrue(evidence.startswith("run by mm: "), evidence)
        self.assertTrue(evidence.endswith(" exit:0"), evidence)

    def test_when_abandoned_without_reason_exits_nonzero(self):
        rc, _, _ = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "ABANDONED")
        self.assertEqual(rc, 5)
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "ABANDONED", "--reason", "dropped")
        self.assertEqual(self.row("#1")["history"][-1]["reason"], "dropped")

    def test_when_wrapup_done_while_other_rows_open_exits_nonzero(self):
        rc, _, err = self.mm("set-row", "--task-dir", self.task, "--id", "#3", "--state", "DONE", "--evidence",
                             "human:Test Operator")
        self.assertEqual(rc, 5)
        self.assertIn("#1", err)

    def test_when_set_row_changes_state_status_label_follows(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        self.assertEqual(self.row("#1")["status_label"], "In progress")
        self.assertIn("| #1 | Build the widget | \U0001f7e1 In progress |", self.handoff())
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION", "--reason", "which API")
        row = self.row("#1")
        self.assertTrue(row["blocked"])
        self.assertEqual(row["status_label"], "Blocked: needs a decision")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        self.assertFalse(self.row("#1")["blocked"])

    def test_when_set_row_repeats_the_current_state_with_a_note_it_refuses_and_writes_nothing(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        before = self.ledger_bytes()
        for extra in (["--note", "operator chose the v2 API"], ["--evidence", "cmd:python -m unittest exit:0"],
                      ["--reason", "keys arrived"], ["--verify", "--", sys.executable, "-c", "pass"]):
            with self.subTest(extra=extra[0]):
                rc, out, err = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING",
                                       *extra)
                self.assertEqual(rc, 2, out + err)
                self.assertNotIn("MM-OK", out)
                self.assertIn(extra[0], err)
                self.assertIn("add-decision", err)
                self.assertIn("edit-row", err)
                self.assertEqual(self.ledger_bytes(), before)
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION", "--reason", "which API")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION", "--reason", "which DB")
        self.assertEqual(self.row("#1")["blocked_reason"], "which DB")

    def test_when_a_blocked_row_is_blocked_again_without_a_reason_its_reason_is_kept(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION", "--reason", "which API")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION")
        self.assertEqual(self.row("#1")["blocked_reason"], "which API")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked")
        self.assertEqual(self.row("#1")["blocked_reason"], "which API")
        ops = self.tmp / "ops.json"
        ops.write_text(json.dumps([{"op": "set-row", "id": "#1", "state": "NEEDS_DECISION"},
                                   {"op": "mark-row", "id": "#1", "blocked": True}]), encoding="utf-8")
        self.ok("batch", "--task-dir", self.task, "--file", ops)
        self.assertEqual(self.row("#1")["blocked_reason"], "which API")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked", "--reason", "which DB")
        self.assertEqual(self.row("#1")["blocked_reason"], "which DB")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION", "--reason", "")
        self.assertEqual(self.row("#1")["blocked_reason"], "")

    def test_when_set_row_repeats_the_current_state_with_an_empty_option_it_refuses_and_writes_nothing(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        before = self.ledger_bytes()
        for extra in (["--note", ""], ["--evidence", ""], ["--reason", ""], ["--note-file", self.textfile("")]):
            with self.subTest(extra=extra[0]):
                rc, out, err = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING",
                                       *extra)
                self.assertEqual(rc, 2, out + err)
                self.assertNotIn("MM-OK", out)
                self.assertIn(extra[0].replace("-file", ""), err)
                self.assertEqual(self.ledger_bytes(), before)

    def test_when_set_row_repeats_the_current_state_with_verify_the_command_never_runs(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        before = self.ledger_bytes()
        flag = self.tmp / "ran.txt"
        command = [sys.executable, "-c", "open(%r, 'w').write('ran')" % str(flag)]
        rc, out, err = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING",
                               "--verify", "--", *command)
        self.assertEqual(rc, 2, out + err)
        self.assertIn("--verify", err)
        self.assertFalse(flag.exists())
        self.assertEqual(self.ledger_bytes(), before)
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--verify", "--", *command)
        self.assertTrue(flag.exists())
        self.assertEqual(self.row("#1")["state"], "DONE")

    def test_when_another_writer_moves_the_row_to_the_requested_state_before_the_lock_verify_never_runs(self):
        flag = self.tmp / "ran.txt"
        command = [sys.executable, "-c", "open(%r, 'w').write('ran')" % str(flag)]
        real_hold_lock, raced = mm_ledger.hold_lock, []

        @contextlib.contextmanager
        def hold_lock_after_a_concurrent_write(task_dir):
            if not raced:
                raced.append(True)
                self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
            with real_hold_lock(task_dir):
                yield

        with mock.patch.object(mm_ledger, "hold_lock", hold_lock_after_a_concurrent_write):
            rc, out, err = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING",
                                   "--verify", "--", *command)
        self.assertEqual(raced, [True])
        self.assertEqual(rc, 2, out + err)
        self.assertIn("--verify", err)
        self.assertFalse(flag.exists())
        moves = [h for h in self.row("#1")["history"] if "to" in h]
        self.assertEqual([(h["to"], h["evidence"]) for h in moves], [("IMPLEMENTING", "")])

    def test_when_set_row_gets_both_verify_and_evidence_it_refuses_before_running_or_writing(self):
        before = self.ledger_bytes()
        flag = self.tmp / "ran.txt"
        command = [sys.executable, "-c", "open(%r, 'w').write('ran')" % str(flag)]
        for state, evidence in (("IMPLEMENTING", "cmd:python -m unittest exit:0"), ("DONE", "human:Test Operator"),
                                ("IMPLEMENTING", "")):
            with self.subTest(state=state, evidence=evidence):
                rc, out, err = self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", state,
                                       "--evidence", evidence, "--verify", "--", *command)
                self.assertEqual(rc, 2, out + err)
                self.assertNotIn("MM-OK", out)
                self.assertIn("--evidence", err)
                self.assertIn("--verify", err)
                self.assertFalse(flag.exists())
                self.assertEqual(self.ledger_bytes(), before)

    def test_when_a_replaced_blocked_reason_is_cleared_by_unblocking_the_history_still_holds_it(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked", "--reason", "which API")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION", "--reason", "which DB")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked", "--reason", "which cache")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked", "--reason", "which cache")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--unblocked")
        row = self.row("#1")
        self.assertEqual((row["state"], row["blocked"], row["blocked_reason"]), ("IMPLEMENTING", False, ""))
        edits = [h["edit"]["blocked_reason"] for h in row["history"] if "blocked_reason" in h.get("edit", {})]
        self.assertEqual(edits, [["which API", "which DB"], ["which DB", "which cache"]])
        self.assertEqual(mm_ledger.history_problems(self.doc()), [])
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked")
        self.assertEqual(self.row("#1")["state"], "NEEDS_DECISION")

    def test_when_a_blocked_row_is_retired_or_split_its_blocked_reason_is_cleared_and_stays_in_history(self):
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked", "--reason", "which API")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "NEEDS_DECISION", "--reason", "which DB")
        self.ok("retire-row", "--task-dir", self.task, "--id", "#1", "--reason", "dropped")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#2", "--blocked", "--reason", "which host")
        self.ok("split-row", "--task-dir", self.task, "--id", "#2", "--item", "Draft", "--item", "Review",
                "--reason", "too big")
        for rid, reasons in (("#1", ["which API", "which DB"]), ("#2", ["which host"])):
            with self.subTest(row=rid):
                row = self.row(rid)
                self.assertEqual((row["state"], row["blocked"], row["blocked_reason"]), ("ABANDONED", False, ""))
                recorded = [h["reason"] for h in row["history"] if h.get("to") == "NEEDS_DECISION"]
                recorded += [h["edit"]["blocked_reason"][1] for h in row["history"]
                             if "blocked_reason" in h.get("edit", {})]
                self.assertEqual(recorded, reasons)
        self.assertEqual(mm_ledger.history_problems(self.doc()), [])
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)

    def test_mark_row_blocked_and_unblocked_returns_to_the_previous_state(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--blocked", "--reason", "waiting on keys")
        row = self.row("#1")
        self.assertEqual((row["state"], row["blocked"], row["blocked_reason"]),
                         ("NEEDS_DECISION", True, "waiting on keys"))
        self.ok("mark-row", "--task-dir", self.task, "--id", "#1", "--unblocked")
        row = self.row("#1")
        self.assertEqual((row["state"], row["blocked"], row["blocked_reason"]), ("IMPLEMENTING", False, ""))

    def test_edit_row_rewords_item_and_keeps_history(self):
        self.ok("edit-row", "--task-dir", self.task, "--id", "#1", "--item", "Build the gadget", "--notes", "n1",
                "--owner", "builder", "--target-date", "2026-10-01", "--test-level", "unit", "--pr", "PR 7",
                "--test-page", "http://localhost:5173/widget")
        row = self.row("#1")
        self.assertEqual((row["item"], row["notes_md"], row["owner"], row["target_date"], row["test_level"],
                          row["pr"], row["test_page"]),
                         ("Build the gadget", "n1", "builder", "2026-10-01", "unit", "PR 7",
                          "http://localhost:5173/widget"))
        edit = row["history"][-1]["edit"]
        self.assertEqual(edit["item"], ["Build the widget", "Build the gadget"])
        self.assertIn("Build the gadget", self.handoff())
        self.assertNotIn("Build the widget", self.handoff())

    def test_edit_row_refuses_to_reword_the_wrapup_row(self):
        rc, _, _ = self.mm("edit-row", "--task-dir", self.task, "--id", "#3", "--item", "Something else")
        self.assertEqual(rc, 5)
        self.assertEqual(self.row("#3")["item"], WRAPUP)

    def test_move_row_reorders_and_keeps_wrapup_last(self):
        self.ok("move-row", "--task-dir", self.task, "--id", "#2", "--before", "#1")
        self.assertEqual(self.ids(), ["#2", "#1", "#3"])
        self.ok("move-row", "--task-dir", self.task, "--id", "#2", "--after", "#1")
        self.assertEqual(self.ids(), ["#1", "#2", "#3"])
        before = self.ledger_bytes()
        self.assertEqual(self.mm("move-row", "--task-dir", self.task, "--id", "#3", "--before", "#1")[0], 5)
        self.assertEqual(self.mm("move-row", "--task-dir", self.task, "--id", "#1", "--after", "#3")[0], 5)
        self.assertEqual(self.ledger_bytes(), before)

    def test_split_row_creates_children_and_retires_parent_with_reason(self):
        self.ok("edit-row", "--task-dir", self.task, "--id", "#1", "--owner", "builder", "--test-level", "unit")
        self.ok("split-row", "--task-dir", self.task, "--id", "#1", "--item", "Part one", "--item", "Part two",
                "--reason", "too big")
        self.assertEqual(self.ids(), ["#1", "#4", "#5", "#2", "#3"])
        parent = self.row("#1")
        self.assertEqual(parent["state"], "ABANDONED")
        self.assertEqual(parent["history"][-1]["reason"], "split into #4, #5: too big")
        for rid, item in (("#4", "Part one"), ("#5", "Part two")):
            child = self.row(rid)
            self.assertEqual((child["item"], child["owner"], child["test_level"], child["state"]),
                             (item, "builder", "unit", "BACKLOG"))
        self.assertEqual(self.mm("split-row", "--task-dir", self.task, "--id", "#2", "--item", "only one",
                                 "--reason", "x")[0], 2)

    def test_retire_row_sets_abandoned_with_reason_and_never_deletes(self):
        n = len(self.ids())
        self.assertNotEqual(self.mm("retire-row", "--task-dir", self.task, "--id", "#2")[0], 0)
        self.ok("retire-row", "--task-dir", self.task, "--id", "#2", "--reason", "not needed")
        row = self.row("#2")
        self.assertEqual(row["state"], "ABANDONED")
        self.assertEqual(row["history"][-1]["reason"], "not needed")
        self.assertEqual(len(self.ids()), n)
        self.assertIn("Write the notes", self.handoff())
        self.assertEqual(self.mm("retire-row", "--task-dir", self.task, "--id", "#3", "--reason", "x")[0], 5)
        self.assertEqual(self.mm("retire-row", "--task-dir", self.task, "--id", "#99", "--reason", "x")[0], 4)

    def test_when_retire_row_meets_an_abandoned_row_with_a_new_reason_it_refuses_and_writes_nothing(self):
        self.ok("retire-row", "--task-dir", self.task, "--id", "#2", "--reason", "not needed")
        before = self.ledger_bytes()
        rc, out, err = self.mm("retire-row", "--task-dir", self.task, "--id", "#2", "--reason", "superseded by #1")
        self.assertEqual(rc, 2, out + err)
        self.assertNotIn("MM-OK", out)
        self.assertIn("edit-row", err)
        self.assertIn("add-decision", err)
        self.assertEqual(self.ledger_bytes(), before)
        self.ok("retire-row", "--task-dir", self.task, "--id", "#2", "--reason", "not needed")
        history = self.row("#2")["history"]
        self.assertEqual([h["reason"] for h in history if h.get("to") == "ABANDONED"], ["not needed"])


class DecisionAndFieldTests(CliCase):
    def setUp(self):
        super().setUp()
        self.scaffold("Build the widget")

    def add_decision(self, text):
        self.ok("add-decision", "--task-dir", self.task, "--status", "FINAL", "--source", "chat", "--date",
                "2026-01-01", "--who", "Test Operator", "--decision", text, "--why", "because")

    def test_supersede_decision_marks_old_and_links_new(self):
        self.add_decision("Use plan A")
        self.add_decision("Use plan B")
        self.assertEqual([d["qid"] for d in self.doc()["decisions"]], ["Q1", "Q2"])
        self.ok("supersede-decision", "--task-dir", self.task, "--qid", "Q1", "--by", "Q2", "--reason",
                "plan A failed")
        old, new = self.doc()["decisions"]
        self.assertEqual(old["status"], "SUPERSEDED")
        text = self.handoff()
        self.assertIn("- **Status:** SUPERSEDED", text)
        self.assertIn("Superseded by Q2: plan A failed", text)
        self.assertIn("Supersedes Q1", text)
        self.assertEqual(self.mm("supersede-decision", "--task-dir", self.task, "--qid", "Q9", "--by", "Q2",
                                 "--reason", "x")[0], 4)

    def test_add_decision_refuses_an_unknown_status(self):
        rc, _, _ = self.mm("add-decision", "--task-dir", self.task, "--status", "MAYBE", "--source", "s",
                           "--date", "2026-01-01", "--who", "w", "--decision", "d", "--why", "y")
        self.assertEqual(rc, 6)

    def test_when_set_field_value_over_400_chars_exits_nonzero(self):
        before = self.ledger_bytes()
        rc, _, _ = self.mm("set-field", "--task-dir", self.task, "--field", "Executive note", "--value", "x" * 401)
        self.assertEqual(rc, 6)
        self.assertEqual(self.ledger_bytes(), before)

    def test_when_set_field_value_over_250_chars_warns_and_writes(self):
        rc, _, err = self.mm("set-field", "--task-dir", self.task, "--field", "Executive note", "--value", "y" * 251)
        self.assertEqual(rc, 0)
        self.assertIn("warning", err)
        self.assertEqual(self.doc()["dashboard_index"]["Executive note"], "y" * 251)

    def test_when_set_field_enum_value_invalid_exits_nonzero(self):
        self.assertEqual(self.mm("set-field", "--task-dir", self.task, "--field", "Status", "--value",
                                 "in-progress")[0], 6)
        self.assertEqual(self.mm("set-field", "--task-dir", self.task, "--field", "No such field", "--value",
                                 "x")[0], 6)
        self.ok("set-field", "--task-dir", self.task, "--field", "Status", "--value", "blocked")

    def test_when_set_field_replaces_value_instead_of_appending(self):
        self.ok("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "alpha-value-1")
        self.ok("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "beta-value-2")
        text = self.handoff()
        self.assertIn("- Next agent action: beta-value-2\n", text)
        self.assertNotIn("alpha-value-1", text)

    def test_set_field_in_section_0b_replaces_the_named_line(self):
        self.ok("set-field", "--task-dir", self.task, "--section", "0b", "--field", "Where I am now", "--value",
                "phase 2")
        self.ok("set-field", "--task-dir", self.task, "--section", "0b", "--field", "Where I am now", "--value",
                "phase 3")
        text = self.handoff()
        self.assertEqual(text.count("**Where I am now:**"), 1)
        self.assertIn("**Where I am now:** phase 3", text)
        self.assertEqual(self.mm("set-field", "--task-dir", self.task, "--section", "0b", "--field", "Mood",
                                 "--value", "x")[0], 6)

    def test_when_section_0_over_16kb_growth_is_refused(self):
        before = self.ledger_bytes()
        big = self.textfile("z" * (17 * 1024))
        rc, _, err = self.mm("set-section", "--task-dir", self.task, "--id", "0b", "--text-file", big)
        self.assertEqual(rc, 6)
        self.assertIn("Section 0", err)
        self.assertEqual(self.ledger_bytes(), before)

    def test_set_section_replaces_each_text_section(self):
        for sid in mm_compile.TEXT_SECTIONS:
            self.ok("set-section", "--task-dir", self.task, "--id", sid, "--text", "first %s text" % sid)
            self.ok("set-section", "--task-dir", self.task, "--id", sid, "--text", "marker %s text" % sid)
            text = self.handoff()
            self.assertIn("marker %s text" % sid, text)
            self.assertNotIn("first %s text" % sid, text)
            key = mm_compile.TEXT_SECTIONS[sid]
            self.assertEqual(self.doc()["passthrough"][key], "marker %s text" % sid)
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)

    def test_set_section_accepts_an_id_read_from_a_crlf_list(self):
        self.ok("set-section", "--task-dir", self.task, "--id", "3\r", "--text", "from a crlf list")
        self.assertIn("from a crlf list", self.handoff())

    def test_crlf_files_keep_cr_in_section_text_and_drop_it_from_one_line_values(self):
        section = self.tmp / "section.txt"
        section.write_bytes(b"crlf marker\r\n")
        self.ok("set-section", "--task-dir", self.task, "--id", "3", "--text-file", section)
        self.assertEqual(self.doc()["passthrough"]["section_3_md"], "crlf marker\r")
        self.assertIn(b"crlf marker\r\n", (self.task / "HANDOFF.md").read_bytes())
        item = self.tmp / "item.txt"
        item.write_bytes(b"crlf item\r\n")
        self.ok("edit-row", "--task-dir", self.task, "--id", "#1", "--item-file", item)
        self.assertEqual(self.row("#1")["item"], "crlf item")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)

    def test_set_section_refuses_text_holding_a_section_heading(self):
        rc, _, _ = self.mm("set-section", "--task-dir", self.task, "--id", "3", "--text",
                           "fine\n## Section 2 Decisions log\nmore")
        self.assertEqual(rc, 6)
        self.assertEqual(self.mm("set-section", "--task-dir", self.task, "--id", "9z", "--text", "x")[0], 6)

    def test_sections_json_prints_only_the_registry(self):
        out, err = self.ok("sections", "--task-dir", self.task, "--json")
        self.assertEqual(err, "")
        secs = json.loads(out)
        self.assertEqual({s["kind"] for s in secs} >= {"text", "fields", "rows", "decisions"}, True)
        headings = {s["heading"] for s in secs}
        for line in self.handoff().splitlines():
            if line.startswith("## "):
                self.assertIn(line, headings)


class BatchAndFileTests(CliCase):
    def setUp(self):
        super().setUp()
        self.scaffold("One", "Two")

    def batch(self, ops):
        path = self.tmp / "ops.json"
        path.write_text(json.dumps(ops), encoding="utf-8")
        return self.mm("batch", "--task-dir", self.task, "--file", path)

    def test_batch_applies_all_ops_under_one_revision_bump(self):
        rev = self.doc()["revision"]
        rc, out, err = self.batch([
            {"op": "add-row", "item": "Three", "user_facing": True},
            {"op": "set-row", "id": "#1", "state": "IMPLEMENTING"},
            {"op": "set-field", "field": "Next agent action", "value": "batch value"},
            {"op": "set-section", "id": "3", "text": "batch section"},
            {"op": "add-decision", "status": "FINAL", "source": "s", "date": "2026-01-01", "who": "w",
             "decision": "batch decision", "why": "y"},
        ])
        self.assertEqual(rc, 0, out + err)
        doc = self.doc()
        self.assertEqual(doc["revision"], rev + 1)
        self.assertEqual([r["id"] for r in doc["rows"]], ["#1", "#2", "#4", "#3"])
        self.assertEqual(doc["rows"][0]["state"], "IMPLEMENTING")
        text = self.handoff()
        for marker in ("batch value", "batch section", "batch decision", "Three"):
            self.assertIn(marker, text)

    def test_batch_with_one_bad_op_changes_nothing(self):
        before = self.ledger_bytes()
        handoff = self.handoff()
        rc, _, err = self.batch([{"op": "retire-row", "id": "#1", "reason": "x"},
                                 {"op": "retire-row", "id": "#99", "reason": "x"}])
        self.assertEqual(rc, 4)
        self.assertIn("op 2", err)
        self.assertEqual(self.ledger_bytes(), before)
        self.assertEqual(self.handoff(), handoff)
        for ops in ([{"op": "compile"}], [{"op": "batch", "file": "x"}], [{"op": "add-row"}],
                    [{"op": "set-row", "id": "#1", "state": "DONE", "verify": True}], {"op": "add-row"}):
            self.assertEqual(self.batch(ops)[0], 2, ops)
        self.assertEqual(self.ledger_bytes(), before)

    def test_every_text_option_accepts_a_file_variant(self):
        cases = {
            ("add-row", "item"): ("add-row", {"item": None}, lambda d: d["rows"][-2]["item"]),
            ("add-row", "notes"): ("add-row", {"item": "x", "notes": None}, lambda d: d["rows"][-2]["notes_md"]),
            ("add-row", "owner"): ("add-row", {"item": "x", "owner": None}, lambda d: d["rows"][-2]["owner"]),
            ("add-row", "target-date"): ("add-row", {"item": "x", "target-date": None},
                                         lambda d: d["rows"][-2]["target_date"]),
            ("add-row", "pr"): ("add-row", {"item": "x", "pr": None}, lambda d: d["rows"][-2]["pr"]),
            ("add-row", "test-page"): ("add-row", {"item": "x", "test-page": None},
                                       lambda d: d["rows"][-2]["test_page"]),
            ("edit-row", "item"): ("edit-row", {"id": "#1", "item": None}, lambda d: d["rows"][0]["item"]),
            ("edit-row", "notes"): ("edit-row", {"id": "#1", "notes": None}, lambda d: d["rows"][0]["notes_md"]),
            ("edit-row", "owner"): ("edit-row", {"id": "#1", "owner": None}, lambda d: d["rows"][0]["owner"]),
            ("edit-row", "target-date"): ("edit-row", {"id": "#1", "target-date": None},
                                          lambda d: d["rows"][0]["target_date"]),
            ("edit-row", "pr"): ("edit-row", {"id": "#1", "pr": None}, lambda d: d["rows"][0]["pr"]),
            ("edit-row", "test-page"): ("edit-row", {"id": "#1", "test-page": None},
                                        lambda d: d["rows"][0]["test_page"]),
            ("split-row", "item"): ("split-row", {"id": "#2", "item": None, "reason": "r"},
                                    lambda d: d["rows"][-3]["item"]),
            ("split-row", "reason"): ("split-row", {"id": "#2", "item": "a", "reason": None},
                                      lambda d: d["rows"][1]["history"][-1]["reason"]),
            ("retire-row", "reason"): ("retire-row", {"id": "#2", "reason": None},
                                       lambda d: d["rows"][1]["history"][-1]["reason"]),
            ("set-row", "evidence"): ("set-row", {"id": "#1", "state": "HUMAN_VERIFIED", "evidence": None},
                                      lambda d: d["rows"][0]["history"][-1]["evidence"]),
            ("set-row", "reason"): ("set-row", {"id": "#1", "state": "ABANDONED", "reason": None},
                                    lambda d: d["rows"][0]["history"][-1]["reason"]),
            ("set-row", "note"): ("set-row", {"id": "#1", "state": "IMPLEMENTING", "note": None},
                                  lambda d: d["rows"][0]["history"][-1]["note"]),
            ("mark-row", "reason"): ("mark-row", {"id": "#1", "blocked": True, "reason": None},
                                     lambda d: d["rows"][0]["blocked_reason"]),
            ("add-decision", "source"): ("add-decision", {"field": "source"}, lambda d: d["decisions"][-1]["source"]),
            ("add-decision", "who"): ("add-decision", {"field": "who"}, lambda d: d["decisions"][-1]["who"]),
            ("add-decision", "decision"): ("add-decision", {"field": "decision"},
                                           lambda d: d["decisions"][-1]["decision"]),
            ("add-decision", "why"): ("add-decision", {"field": "why"}, lambda d: d["decisions"][-1]["why"]),
            ("add-decision", "alternatives"): ("add-decision", {"field": "alternatives"},
                                               lambda d: d["decisions"][-1]["alternatives"]),
            ("supersede-decision", "reason"): ("supersede-decision", {"qid": "Q1", "by": "Q2", "reason": None},
                                               lambda d: d["decisions"][0]["body_lines"][-1]),
            ("set-field", "value"): ("set-field", {"field": "Executive note", "value": None},
                                     lambda d: d["dashboard_index"]["Executive note"]),
            ("set-section", "text"): ("set-section", {"id": "3", "text": None},
                                      lambda d: d["passthrough"]["section_3_md"]),
            ("scaffold", "row"): ("scaffold", {}, None),
            ("inbox-write", "body"): ("inbox-write", None, None),
            ("dispatch", "outcome"): ("dispatch", None, None),
            ("dispatch", "exception-reason"): ("dispatch", None, None),
            ("loop", "reason"): ("loop", None, lambda d: d["loop"]["stopped_reason"]),
        }
        for option in ("row", "action", "next", "dedup", "report"):
            cases[("loop", option)] = ("loop", None, lambda d: d["loop"]["last_tick"]["report"])
        self.assertEqual(set(cases), {(c, o) for c, opts in mm.TEXT_OPTIONS.items() for o in opts})
        decision = {"status": "FINAL", "source": "s", "date": "2026-01-01", "who": "w", "decision": "d", "why": "y"}
        for (command, option), (_, spec, getter) in sorted(cases.items()):
            with self.subTest(command=command, option=option):
                shutil.rmtree(self.task)
                self.scaffold("One", "Two")
                marker = "via-file %s %s \"q\" $HOME `x`" % (command, option)
                path = self.textfile(marker)
                if command == "scaffold":
                    shutil.rmtree(self.task)
                    self.ok("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "p",
                            "--row-file", path)
                    self.assertEqual(self.doc()["rows"][0]["item"], marker)
                    continue
                if spec is None:
                    self.assertIn(marker, self.p7_text_case(command, option, path, marker, getter))
                    continue
                if command == "supersede-decision":
                    for text in ("one", "two"):
                        self.ok("add-decision", "--task-dir", self.task, *sum(
                            (["--" + k, v] for k, v in dict(decision, decision=text).items()), []))
                args = [command, "--task-dir", self.task]
                if command == "split-row":
                    spec = dict(spec)
                    items = spec.pop("item")
                    args += ["--item-file", path, "--item-file", path] if items is None else ["--item", "a", "--item", "b"]
                if command == "add-decision":
                    for key, value in decision.items():
                        if key == spec["field"]:
                            args += ["--%s-file" % key, path]
                        else:
                            args += ["--" + key, value]
                    if spec["field"] == "alternatives":
                        args += ["--alternatives-file", path]
                else:
                    for key, value in spec.items():
                        if value is None:
                            args += ["--%s-file" % key, path]
                        elif value is True:
                            args += ["--" + key]
                        else:
                            args += ["--" + key, value]
                if command == "set-row" and option == "evidence":
                    marker = "human:" + marker
                    path.write_text(marker + "\n", encoding="utf-8", newline="\n")
                self.ok(*args)
                got = getter(self.doc())
                self.assertTrue(got == marker or got.endswith(marker), (got, marker))
        rc, _, _ = self.mm("add-row", "--task-dir", self.task, "--item", "a", "--item-file", self.textfile("b"))
        self.assertEqual(rc, 2)

    def p7_text_case(self, command, option, path, marker, getter):
        """Run one inbox-write, dispatch or loop text option from a file; return where the text landed."""
        if command == "inbox-write":
            sections = "".join("## %s\n- none\n\n" % name for name in mm_inbox.SECTIONS)
            path.write_text(marker + "\n\n" + sections, encoding="utf-8", newline="\n")
            self.ok("inbox-write", "--task-dir", self.task, "--source", "builder", "--status", "completed",
                    "--task-ref", "#1", "--body-file", path)
            entry = next(p for p in (self.task / "inbox").glob("*-builder.md"))
            return entry.read_text(encoding="utf-8")
        if command == "dispatch" and option == "exception-reason":
            prompt = self.textfile("Review the widget.", name="prompt.md")
            self.ok("loop", "on", "--task-dir", self.task, "--approved-by", "Test Operator", "--route", "bg-it:sonnet")
            self.ok("dispatch", "--task-dir", self.task, "--route", "codex-cli", "--model", "reviewer",
                    "--prompt-file", prompt, "--operator-exception", "Test Operator", "--exception-reason-file", path)
            return mm_loop.find_record(mm_loop.read_records(self.task), "d1")["exception"]["reason"]
        if command == "dispatch":
            prompt = self.textfile("Build the widget.", name="prompt.md")
            self.ok("dispatch", "--task-dir", self.task, "--route", "bg-it", "--model", "sonnet",
                    "--prompt-file", prompt, "--approved-by", "Test Operator")
            self.ok("dispatch", "--task-dir", self.task, "--close", "d1", "--outcome-file", path)
            return mm_loop.find_record(mm_loop.read_records(self.task), "d1")["closed"]["outcome"]
        self.ok("loop", "on", "--task-dir", self.task, "--approved-by", "Test Operator", "--route", "bg-it:sonnet")
        if option == "reason":
            self.ok("loop", "off", "--task-dir", self.task, "--reason-file", path)
        else:
            self.ok("loop", "tick", "--task-dir", self.task, "--result", "productive", "--%s-file" % option, path)
        return getter(self.doc())

    def test_text_from_file_keeps_quotes_dollars_and_backticks_exactly(self):
        text = "Write the \"widget\" notes; keep $HOME, `date`, 'quotes', a|b and ünïcødé Ωμέγα literal"
        self.ok("edit-row", "--task-dir", self.task, "--id", "#2", "--item-file", self.textfile(text))
        self.assertEqual(self.row("#2")["item"], text)
        self.assertIn(mm_compile.escape_cell(text), self.handoff())


class CompileCheckTests(CliCase):
    def setUp(self):
        super().setUp()
        self.scaffold("Build the widget", "Write the notes")
        self.ok("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "Close the task")

    def tamper(self, old, new):
        path = self.task / "HANDOFF.md"
        path.write_text(path.read_text(encoding="utf-8").replace(old, new), encoding="utf-8", newline="\n")

    def test_when_handoff_differs_from_ledger_check_exits_1(self):
        self.tamper("Close the task", "Tampered value")
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 1)
        self.assertIn("HANDOFF-EDITED", out)

    def test_when_handoff_hand_edited_compile_refuses_and_names_lost_lines(self):
        self.tamper("Close the task", "Tampered value")
        rc, out, err = self.mm("compile", "--task-dir", self.task)
        self.assertEqual(rc, 8)
        self.assertIn("Tampered value", out + err)
        self.assertIn("Tampered value", self.handoff())
        self.ok("compile", "--task-dir", self.task, "--accept-ledger")
        self.assertIn("Close the task", self.handoff())
        backups = list((self.task / "backups").glob("*-compile/HANDOFF.md"))
        self.assertEqual(len(backups), 1)
        self.assertIn("Tampered value", backups[0].read_text(encoding="utf-8"))
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)

    def test_when_handoff_hand_edited_write_commands_refuse(self):
        self.tamper("Close the task", "Tampered value")
        before = self.ledger_bytes()
        rc, _, err = self.mm("add-row", "--task-dir", self.task, "--item", "x")
        self.assertEqual(rc, 8)
        self.assertIn("HANDOFF.md", err)
        self.assertEqual(self.ledger_bytes(), before)

    def test_when_ledger_ahead_compile_regenerates_handoff(self):
        doc = self.doc()
        doc["rows"][0]["item"] = "Build the gadget"
        mm_ledger.save_ledger(self.task, doc, expected_revision=doc["revision"], updated_by="test")
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 1)
        self.assertIn("LEDGER-AHEAD", out)
        self.ok("compile", "--task-dir", self.task)
        self.assertIn("Build the gadget", self.handoff())
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)

    def test_when_ledger_invalid_check_exits_1_and_lists_problems(self):
        doc = self.doc()
        doc["rows"][0]["state"] = "NOT_A_STATE"
        doc["rows"][1]["blocked"] = "no"
        (self.task / "ledger.json").write_text(json.dumps(doc), encoding="utf-8")
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 1)
        self.assertIn("NOT_A_STATE", out)
        self.assertIn("rows[1].blocked", out)
        (self.task / "ledger.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 1)
        self.assertEqual(self.mm("add-row", "--task-dir", self.task, "--item", "x")[0], 11)

    def test_when_table_cell_over_600_chars_check_exits_3(self):
        doc = self.doc()
        doc["rows"][0]["notes_md"] = "n" * 601
        self.force(doc)
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 3)
        self.assertIn("CELL-OVER-CAP", out)
        self.assertEqual(self.mm("edit-row", "--task-dir", self.task, "--id", "#2", "--notes", "m" * 601)[0], 6)
        self.ok("edit-row", "--task-dir", self.task, "--id", "#2", "--notes", "short")

    def test_when_wrapup_not_last_check_exits_3(self):
        doc = self.doc()
        doc["rows"].insert(1, doc["rows"].pop())
        self.force(doc)
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 3)
        self.assertIn("WRAPUP-NOT-LAST", out)

    def test_check_reports_missing_header_on_pre_existing_folder_as_fixable(self):
        doc = self.doc()
        del doc["compile_record"]
        mm_ledger.save_ledger(self.task, doc, expected_revision=doc["revision"], updated_by="test")
        doc = self.doc()
        (self.task / "HANDOFF.md").write_text(mm_compile.compile_handoff(doc), encoding="utf-8", newline="\n")
        (self.task / "ROADMAP.html").write_text("<html>made by hand</html>\n", encoding="utf-8")
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 3, out)
        self.assertIn("HEADER-MISSING", out)
        self.ok("set-field", "--task-dir", self.task, "--field", "Next agent action", "--value", "next")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        backups = list((self.task / "backups").glob("*-roadmap/ROADMAP.html"))
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "<html>made by hand</html>\n")

    def hand_edit_row(self, rid, **fields):
        """Change ledger.json the way a direct file edit does: no mm.py, no history, no revision bump."""
        doc = self.doc()
        next(r for r in doc["rows"] if r["id"] == rid).update(fields)
        (self.task / "ledger.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                                               encoding="utf-8")

    def test_when_a_row_is_hand_edited_to_done_compile_refuses_and_check_fails(self):
        git = shutil.which("git")
        self.assertIsNotNone(git)
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t" + "@example.invalid",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t" + "@example.invalid", GIT_CONFIG_NOSYSTEM="1")
        run = lambda *a: subprocess.run([git, *a], cwd=self.project, env=env, capture_output=True, text=True,
                                        check=True).stdout
        run("init", "-q")
        run("add", "--", ".private")
        run("commit", "-qm", "seed")
        self.hand_edit_row("#1", state="DONE", status_label="Done")
        handoff = self.handoff()
        rc, out, err = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 1, out + err)
        self.assertIn("STATE-UNRECORDED #1", out)
        self.assertIn("/mm repair", out)
        self.assertNotIn("run mm.py compile", out)
        self.assertIn("INVALID STATE-UNRECORDED #1", self.ok("status", "--task-dir", self.task)[0])
        with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "on"}):
            rc, out, err = self.mm("compile", "--task-dir", self.task)
            self.assertEqual(rc, 11, out + err)
            self.assertIn("/mm repair", out + err)
            self.assertEqual(self.mm("add-row", "--task-dir", self.task, "--item", "late")[0], 11)
        self.assertEqual(self.handoff(), handoff)
        self.assertEqual(run("log", "--format=%s").split(), ["seed"])
        rc, out, err = self.mm("repair", "--task-dir", self.task)
        self.assertEqual(rc, 14, out + err)
        self.assertIn("unproven-state", out)
        self.ok("repair", "--task-dir", self.task, "--apply")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        self.assertEqual(self.row("#1")["history"][-1]["by"], "mm.py repair")

    def test_when_a_hand_edited_history_starts_mid_way_repair_apply_leaves_check_passing(self):
        self.hand_edit_row("#1", state="DEV", status_label="On dev", history=[
            {"at": "2026-01-01T00:00:00+00:00", "from": "PR_READY", "to": "DEV", "by": "someone", "note": "merged"}])
        self.hand_edit_row("#2", state="DONE", status_label="Done", history=[
            {"at": "2026-01-01T00:00:00+00:00", "from": "IMPLEMENTING", "to": "DONE", "by": "someone",
             "note": "", "evidence": "", "reason": ""}])
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertIn("HISTORY-BROKEN #1", out)
        self.ok("repair", "--task-dir", self.task, "--apply")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        first = self.row("#1")["history"][0]
        self.assertEqual((first["by"], first["from"], first["to"]), ("mm.py repair", "BACKLOG", "PR_READY"))
        self.assertEqual(self.row("#1")["state"], "DEV")
        self.assertEqual(self.row("#2")["state"], "REVIEW")

    def test_when_a_hand_edited_green_history_starts_mid_way_repair_moves_it_to_review(self):
        self.hand_edit_row("#1", state="DONE", status_label="Done", history=[
            {"at": "2026-01-01T00:00:00+00:00", "from": "HUMAN_VERIFIED", "to": "DONE", "by": "someone",
             "note": "", "evidence": "", "reason": ""}])
        self.hand_edit_row("#2", state="DONE", status_label="Done", history=[
            {"at": "2026-01-01T00:00:00+00:00", "from": "REVIEW", "to": "DONE", "by": "someone",
             "note": "", "evidence": "cmd:python -m unittest exit:0", "reason": ""}])
        out = self.mm("check", "--task-dir", self.task)[1]
        self.assertIn("HISTORY-BROKEN #1", out)
        self.assertIn("HISTORY-BROKEN #2", out)
        self.ok("repair", "--task-dir", self.task, "--apply")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        self.assertEqual((self.row("#1")["state"], self.row("#2")["state"]), ("REVIEW", "REVIEW"))
        self.assertIn("needs verification", self.ok("status", "--task-dir", self.task)[0])

    def test_when_a_hand_edited_move_has_no_from_state_repair_names_it_and_records_only_real_states(self):
        self.hand_edit_row("#1", state="IMPLEMENTING", status_label="In progress", history=[
            {"at": "2026-01-01T00:00:00+00:00", "to": "IMPLEMENTING", "by": "someone"}])
        self.hand_edit_row("#2", state="DONE", status_label="Done", history=[
            {"at": "2026-01-01T00:00:00+00:00", "to": "DONE", "by": "someone", "evidence": "cmd:t exit:0"}])
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 1, out)
        self.assertIn("HISTORY-BROKEN #1", out)
        self.assertIn("HISTORY-BROKEN #2", out)
        rc, out, err = self.mm("repair", "--task-dir", self.task)
        self.assertEqual(rc, 14, out + err)
        self.assertRegex(out, r"REPAIR unproven-state: .*#1 IMPLEMENTING \(HISTORY-BROKEN\)")
        self.assertRegex(out, r"REPAIR unproven-state: .*#2 DONE -> REVIEW \(HISTORY-BROKEN\)")
        self.ok("repair", "--task-dir", self.task, "--apply")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        self.assertEqual((self.row("#1")["state"], self.row("#2")["state"]), ("IMPLEMENTING", "REVIEW"))
        for rid in ("#1", "#2"):
            for entry in self.row(rid)["history"]:
                if entry["by"] == "mm.py repair":
                    self.assertIn(entry["from"], mm_ledger.STATES, entry)
                    self.assertIn(entry["to"], mm_ledger.STATES, entry)

    def test_when_a_green_has_no_evidence_entry_check_fails_and_names_it(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "IMPLEMENTING")
        doc = self.doc()
        row = doc["rows"][0]
        row["history"].append({"at": "2026-01-01T00:00:00+00:00", "from": "IMPLEMENTING", "to": "DONE",
                               "by": "someone", "note": "", "evidence": "", "reason": ""})
        self.hand_edit_row("#1", state="DONE", status_label="Done", history=row["history"])
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 1, out)
        self.assertIn("GREEN-WITHOUT-EVIDENCE #1", out)
        self.hand_edit_row("#2", state="HUMAN_VERIFIED", status_label="Human verified", history=[
            {"at": "2026-01-01T00:00:00+00:00", "from": "BACKLOG", "to": "HUMAN_VERIFIED", "by": "someone",
             "note": "", "evidence": "cmd:make exit:0", "reason": ""}])
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertIn("GREEN-WITHOUT-EVIDENCE #2", out)

    def test_greens_set_through_mm_py_pass_the_content_check(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--evidence", "cmd:t exit:0")
        self.ok("edit-row", "--task-dir", self.task, "--id", "#2", "--user-facing")
        self.ok("set-row", "--task-dir", self.task, "--id", "#2", "--state", "IMPLEMENTING")
        self.ok("set-row", "--task-dir", self.task, "--id", "#2", "--state", "HUMAN_VERIFIED", "--evidence",
                "human:Test Operator")
        self.ok("set-row", "--task-dir", self.task, "--id", "#2", "--state", "DONE")
        out, _ = self.ok("check", "--task-dir", self.task)
        self.assertIn("MM-CHECK-OK", out)
        self.ok("compile", "--task-dir", self.task)

    def test_when_repair_meets_an_unproven_green_the_row_leaves_green_and_waits_for_verification(self):
        self.hand_edit_row("#1", state="DONE", status_label="Done")
        self.hand_edit_row("#2", state="HUMAN_VERIFIED", status_label="Human verified")
        rc, out, err = self.mm("repair", "--task-dir", self.task)
        self.assertEqual(rc, 14, out + err)
        self.assertRegex(out, r"REPAIR unproven-state: .*#1 DONE -> REVIEW")
        self.ok("repair", "--task-dir", self.task, "--apply")
        for rid, was in (("#1", "DONE"), ("#2", "HUMAN_VERIFIED")):
            row = self.row(rid)
            self.assertEqual((row["state"], row["status_label"]), ("REVIEW", "In review"))
            self.assertEqual((row["history"][-1]["by"], row["history"][-1]["from"]), ("mm.py repair", was))
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        waiting = self.ok("status", "--task-dir", self.task)[0].split("Waiting on the operator:", 1)[1]
        self.assertIn("#1 needs verification", waiting.split("\n\n")[0])
        self.assertIn("#2 needs verification", waiting.split("\n\n")[0])
        self.assertEqual(self.mm("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE")[0], 5)
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--evidence", "cmd:t exit:0")
        self.assertNotIn("#1 needs verification", self.ok("status", "--task-dir", self.task)[0])
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)

    def test_when_repair_takes_a_green_from_a_hand_edited_handoff_the_row_is_not_green(self):
        self.tamper("| #1 | Build the widget | ⚪ Not started |", "| #1 | Build the widget | \U0001f7e2 Done |")
        self.assertNotEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        rc, out, err = self.mm("repair", "--task-dir", self.task, "--decide", "1=handoff")
        self.assertEqual(rc, 14, out + err)
        self.assertIn("REPAIR unverified-green: 1 (#1 DONE -> REVIEW)", out)
        self.ok("repair", "--task-dir", self.task, "--decide", "1=handoff", "--apply")
        self.assertEqual(self.row("#1")["state"], "REVIEW")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        self.assertIn("#1 needs verification", self.ok("status", "--task-dir", self.task)[0])

    def repair_from_handoff(self, old_label, new_label):
        """Hand-edit #1's status in HANDOFF.md, take the HANDOFF side in repair, apply; return the dry-run report."""
        self.tamper("| #1 | Build the widget | %s |" % old_label, "| #1 | Build the widget | %s |" % new_label)
        rc, out, err = self.mm("repair", "--task-dir", self.task, "--decide", "1=handoff")
        self.assertEqual(rc, 14, out + err)
        self.ok("repair", "--task-dir", self.task, "--decide", "1=handoff", "--apply")
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        return out

    def test_when_repair_takes_human_verified_over_a_proven_done_from_handoff_the_row_is_not_green(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--evidence", "cmd:t exit:0")
        out = self.repair_from_handoff("\U0001f7e2 Done", "\U0001f7e2 Human verified")
        self.assertIn("REPAIR unverified-green: 1 (#1 HUMAN_VERIFIED -> REVIEW)", out)
        self.assertEqual(self.row("#1")["state"], "REVIEW")
        self.assertIn("#1 needs verification", self.ok("status", "--task-dir", self.task)[0])

    def test_when_repair_takes_done_over_an_unproven_human_verified_from_handoff_the_row_is_not_green(self):
        self.hand_edit_row("#1", state="HUMAN_VERIFIED", status_label="Human verified")
        out = self.repair_from_handoff("⚪ Not started", "\U0001f7e2 Done")
        self.assertIn("REPAIR unverified-green: 1 (#1 DONE -> REVIEW)", out)
        self.assertEqual(self.row("#1")["state"], "REVIEW")
        self.assertIn("#1 needs verification", self.ok("status", "--task-dir", self.task)[0])

    def test_when_repair_takes_done_over_a_proven_human_verified_from_handoff_the_row_stays_done(self):
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "HUMAN_VERIFIED", "--evidence",
                "human:Test Operator")
        out = self.repair_from_handoff("\U0001f7e2 Human verified", "\U0001f7e2 Done")
        self.assertNotIn("unverified-green", out)
        self.assertEqual(self.row("#1")["state"], "DONE")
        self.assertNotIn("#1 needs verification", self.ok("status", "--task-dir", self.task)[0])

    def test_generated_roadmap_is_refreshed_on_every_write(self):
        self.ok("edit-row", "--task-dir", self.task, "--id", "#1", "--item", "Roadmap marker row")
        roadmap = (self.task / "ROADMAP.html").read_text(encoding="utf-8")
        self.assertIn("Roadmap marker row", roadmap)


class ArchiveStatusTests(CliCase):
    def setUp(self):
        super().setUp()
        self.scaffold("Build the widget", "Write the notes", "Ship it")
        self.ok("set-row", "--task-dir", self.task, "--id", "#1", "--state", "DONE", "--evidence", "cmd:t exit:0")
        self.ok("retire-row", "--task-dir", self.task, "--id", "#2", "--reason", "dropped")
        self.ok("add-decision", "--task-dir", self.task, "--status", "FINAL", "--source", "s", "--date",
                "2026-01-01", "--who", "w", "--decision", "Use plan A", "--why", "y")

    def test_when_archive_dry_run_writes_nothing(self):
        files = {p.name: p.read_bytes() for p in self.task.iterdir() if p.is_file()}
        rc, out, _ = self.mm("archive", "--task-dir", self.task, "--keep-done", "0", "--keep-decisions", "0")
        self.assertEqual(rc, 0)
        self.assertIn("#1", out)
        self.assertEqual({p.name: p.read_bytes() for p in self.task.iterdir() if p.is_file()}, files)

    def test_when_archive_applied_done_rows_move_to_handoff_archive_without_content_loss(self):
        self.ok("archive", "--task-dir", self.task, "--keep-done", "0", "--keep-decisions", "0", "--apply")
        doc = self.doc()
        self.assertEqual([r["id"] for r in doc["rows"]], ["#3", "#4"])
        self.assertEqual([r["id"] for r in doc["archive"]["rows"]], ["#1", "#2"])
        archive = (self.task / "HANDOFF-archive.md").read_text(encoding="utf-8")
        for text in ("Build the widget", "Write the notes", "Use plan A"):
            self.assertIn(text, archive)
            self.assertNotIn(text, self.handoff())
        self.assertIn("HANDOFF-archive.md", self.handoff())
        self.assertEqual(self.mm("check", "--task-dir", self.task)[0], 0)
        self.ok("add-row", "--task-dir", self.task, "--item", "Later")
        self.assertIn("#5", [r["id"] for r in self.doc()["rows"]])

    def test_when_status_runs_it_shows_test_level_and_waiting_on_operator(self):
        self.ok("edit-row", "--task-dir", self.task, "--id", "#3", "--user-facing", "--test-level", "e2e",
                "--pr", "PR 12", "--test-page", "http://localhost:3000/w")
        self.ok("add-row", "--task-dir", self.task, "--item", "Pick an API")
        self.ok("mark-row", "--task-dir", self.task, "--id", "#5", "--blocked", "--reason", "which API")
        out, _ = self.ok("status", "--task-dir", self.task)
        self.assertTrue(out.startswith("\U0001f3a9 PM mode | Task: widget"), out)
        self.assertIn("Mode: attended", out)
        self.assertRegex(out, r"#3 .*e2e.*PR 12.*http://localhost:3000/w")
        waiting = out.split("Waiting on the operator:", 1)[1]
        self.assertIn("#3", waiting.split("\n\n")[0])
        self.assertIn("#5", waiting.split("\n\n")[0])
        self.assertIn("which API", waiting)


class FolderRuleTests(CliCase):
    def test_when_task_is_in_done_folder_write_warns(self):
        self.task = self.project / ".private" / "pm" / "done" / "widget"
        self.scaffold("One")
        rc, _, err = self.mm("add-row", "--task-dir", self.task, "--item", "late")
        self.assertEqual(rc, 0)
        self.assertIn("done/", err)
        self.assertIn("warning", err)

    def test_when_backups_exceed_cap_check_warns(self):
        self.scaffold("One")
        for ts in ("20260101-000001", "20260101-000002", "20260101-000003", "20260101-000004"):
            (self.task / "backups" / ("%s-compile" % ts)).mkdir(parents=True)
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 0)
        self.assertIn("BACKUPS-OVER-CAP", out)
        self.assertIn("prune-backups", out)

    def test_prune_backups_refuses_untracked_files(self):
        git = shutil.which("git")
        self.assertIsNotNone(git)
        self.scaffold("One")
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t" + "@example.invalid",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t" + "@example.invalid", GIT_CONFIG_NOSYSTEM="1")
        run = lambda *a: subprocess.run([git, *a], cwd=self.project, env=env, capture_output=True, check=True)
        run("init", "-q")
        for ts in ("20260101-000001", "20260101-000002", "20260101-000003", "20260101-000004", "20260101-000005"):
            d = self.task / "backups" / ("%s-compile" % ts)
            d.mkdir(parents=True)
            (d / "HANDOFF.md").write_text(ts, encoding="utf-8")
        run("add", "--", ".private/pm/active/widget/backups/20260101-000001-compile")
        run("commit", "-qm", "seed")
        dry_out, _ = self.ok("prune-backups", "--task-dir", self.task)
        self.assertTrue((self.task / "backups" / "20260101-000001-compile").is_dir())
        self.assertIn("20260101-000002-compile", dry_out)
        out, _ = self.ok("prune-backups", "--task-dir", self.task, "--apply")
        self.assertFalse((self.task / "backups" / "20260101-000001-compile").exists())
        self.assertTrue((self.task / "backups" / "20260101-000002-compile" / "HANDOFF.md").is_file())
        self.assertIn("REFUSED", out)
        self.assertIn("20260101-000002-compile", out)
        for ts in ("20260101-000003", "20260101-000004", "20260101-000005"):
            self.assertTrue((self.task / "backups" / ("%s-compile" % ts)).is_dir())

    def test_prune_backups_refuses_a_tracked_backup_with_uncommitted_or_staged_edits(self):
        git = shutil.which("git")
        self.assertIsNotNone(git)
        self.scaffold("One")
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t" + "@example.invalid",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t" + "@example.invalid", GIT_CONFIG_NOSYSTEM="1")
        run = lambda *a: subprocess.run([git, *a], cwd=self.project, env=env, capture_output=True, check=True)
        run("init", "-q")
        names = ["20260101-00000%d-compile" % n for n in range(1, 6)]
        for name in names:
            d = self.task / "backups" / name
            d.mkdir(parents=True)
            (d / "HANDOFF.md").write_text(name + "\n", encoding="utf-8")
        run("add", "--", ".private/pm/active/widget/backups")
        run("commit", "-qm", "seed")
        unstaged = self.task / "backups" / names[1] / "HANDOFF.md"
        unstaged.write_text("operator edit, not staged\n", encoding="utf-8")
        staged = self.task / "backups" / names[2] / "HANDOFF.md"
        staged.write_text("operator edit, staged\n", encoding="utf-8")
        run("add", "--", ".private/pm/active/widget/backups/%s/HANDOFF.md" % names[2])
        extra = self.task / "backups" / names[3] / "notes.md"
        extra.write_text("untracked and unique\n", encoding="utf-8")
        out, _ = self.ok("prune-backups", "--task-dir", self.task, "--keep", "1", "--apply")
        self.assertFalse((self.task / "backups" / names[0]).exists())
        self.assertIn("PRUNED %s" % names[0], out)
        for name in names[1:4]:
            self.assertIn("REFUSED %s" % name, out)
        self.assertEqual(unstaged.read_text(encoding="utf-8"), "operator edit, not staged\n")
        self.assertEqual(staged.read_text(encoding="utf-8"), "operator edit, staged\n")
        self.assertEqual(extra.read_text(encoding="utf-8"), "untracked and unique\n")
        self.assertTrue((self.task / "backups" / names[4]).is_dir())

    def test_when_keep_is_negative_prune_backups_exits_2_and_deletes_nothing(self):
        self.scaffold("One")
        names = ["20260101-00000%d-compile" % n for n in range(1, 5)]
        for name in names:
            (self.task / "backups" / name).mkdir(parents=True)
        rc, out, err = self.mm("prune-backups", "--task-dir", self.task, "--keep", "-1", "--apply")
        self.assertEqual(rc, 2, out + err)
        self.assertIn("--keep", err)
        self.assertEqual(sorted(p.name for p in (self.task / "backups").iterdir()), names)

    def test_prune_backups_refuses_a_backup_holding_an_untracked_directory_link(self):
        git = shutil.which("git")
        self.assertIsNotNone(git)
        self.scaffold("One")
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t" + "@example.invalid",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t" + "@example.invalid", GIT_CONFIG_NOSYSTEM="1")
        run = lambda *a: subprocess.run([git, *a], cwd=self.project, env=env, capture_output=True, check=True)
        run("init", "-q")
        names = ["20260101-00000%d-compile" % n for n in range(1, 5)]
        for name in names:
            (self.task / "backups" / name).mkdir(parents=True)
        (self.task / "backups" / names[1] / "HANDOFF.md").write_text("kept\n", encoding="utf-8")
        (self.task / "backups" / names[2] / "HANDOFF.md").write_text("clean\n", encoding="utf-8")
        (self.task / "backups" / names[3] / "HANDOFF.md").write_text("newest\n", encoding="utf-8")
        run("add", "--", ".private/pm/active/widget/backups")
        run("commit", "-qm", "seed")
        outside = self.tmp / "operator-data"
        outside.mkdir()
        only_link = self.task / "backups" / names[0] / "link"
        mixed_link = self.task / "backups" / names[1] / "link"
        for link in (only_link, mixed_link):
            if os.name == "nt":
                import _winapi
                _winapi.CreateJunction(str(outside), str(link))
            else:
                os.symlink(outside, link, target_is_directory=True)
        out, _ = self.ok("prune-backups", "--task-dir", self.task, "--keep", "1", "--apply")
        for name in names[:2]:
            self.assertIn("REFUSED %s" % name, out)
        self.assertTrue(os.path.lexists(only_link))
        self.assertTrue(os.path.lexists(mixed_link))
        self.assertTrue(outside.is_dir())
        self.assertIn("PRUNED %s" % names[2], out)
        self.assertFalse((self.task / "backups" / names[2]).exists())
        self.assertTrue((self.task / "backups" / names[3]).is_dir())

    def legacy(self):
        self.task.mkdir(parents=True)
        import fixture
        (self.task / "HANDOFF.md").write_text(fixture.HANDOFF_BODY, encoding="utf-8", newline="\n")

    def test_legacy_mode_check_still_round_trips_handoff(self):
        self.legacy()
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 3)
        self.assertIn("legacy folder: run /mm migrate", out)
        self.assertIn("round-trip PASS", out)
        path = self.task / "HANDOFF.md"
        row = "| #2 | Implement atomic writer |"
        dropped = "| id | A real row the parser skips | \U0001f7e1 In progress | agent | none | lost |\n" + row
        path.write_text(path.read_text(encoding="utf-8").replace(row, dropped), encoding="utf-8")
        rc, out, _ = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 1)
        self.assertIn("A real row the parser skips", out)

    def test_write_commands_refuse_legacy_folder_and_name_mm_migrate(self):
        self.legacy()
        before = (self.task / "HANDOFF.md").read_bytes()
        for argv in (["add-row", "--item", "x"], ["set-row", "--id", "#1", "--state", "NOT_A_STATE"],
                     ["set-row"], ["compile"], ["batch", "--file", "missing.json"], ["archive", "--apply"]):
            rc, out, err = self.mm(argv[0], "--task-dir", self.task, *argv[1:])
            self.assertEqual(rc, 4, argv)
            self.assertIn("/mm migrate", out + err)
        self.assertEqual((self.task / "HANDOFF.md").read_bytes(), before)
        self.assertFalse((self.task / "ledger.json").exists())

    def test_absorb_is_not_a_top_level_command(self):
        self.scaffold("One")
        rc, _, _ = self.mm("absorb", "--task-dir", self.task)
        self.assertEqual(rc, 2)
        rc, _, _ = self.mm("normalize", "--task-dir", self.task)
        self.assertEqual(rc, 2)

    def test_every_exit_code_returned_is_documented_in_help(self):
        rc, out, _ = self.mm("--help")
        self.assertEqual(rc, 0)
        documented = {int(m) for m in re.findall(r"^\s*(\d+)\s{2,}\S", out, re.M)}
        self.assertEqual(documented, set(mm.EXIT_CODES))
        sources = [MM_PY] + sorted(SCRIPTS.glob("mm_cli*.py"))
        self.assertGreaterEqual(len(sources), 2)
        used = set()
        for node in (n for src in sources for n in ast.walk(ast.parse(src.read_text(encoding="utf-8")))):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "CliError" and node.args:
                if isinstance(node.args[0], ast.Constant):
                    used.add(node.args[0].value)
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Constant) \
                    and type(node.value.value) is int:
                used.add(node.value.value)
        self.assertTrue(used)
        self.assertLessEqual(used, documented)


if __name__ == "__main__":
    unittest.main()
