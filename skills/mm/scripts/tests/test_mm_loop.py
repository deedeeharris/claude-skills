import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import mm
import mm_ledger


class LoopCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.task = self.tmp / "proj" / ".private" / "pm" / "active" / "widget"
        self.ok("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "smoke-project",
                "--row", "Build the widget", "--row", "Choose the widget colour")
        self.prompt = self.tmp / "prompt.md"
        self.prompt.write_bytes("Build the widget.\r\nKeep \"quotes\", $HOME and `ticks`; Ωμέγα.\n".encode("utf-8"))

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue() + err.getvalue()

    def ok(self, *argv):
        rc, output = self.mm(*argv)
        self.assertEqual(rc, 0, output)
        return output

    def doc(self):
        return mm_ledger.load_ledger(self.task)

    def dispatch(self, route="bg-it", model="sonnet", *extra):
        return self.mm("dispatch", "--task-dir", self.task, "--route", route, "--model", model,
                       "--prompt-file", self.prompt, *extra)

    def records(self):
        path = self.task / "prompts" / "dispatches.jsonl"
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    def loop_on(self, *extra):
        return self.ok("loop", "on", "--task-dir", self.task, "--approved-by", "Test Operator",
                       "--route", "bg-it:sonnet", "--cadence", "60m", *extra)

    def tree_names(self):
        return {p.name for p in self.task.rglob("*")}


class DispatchTests(LoopCase):
    def test_when_attended_dispatch_without_operator_approval_exits_nonzero(self):
        rc, output = self.dispatch()
        self.assertEqual(rc, 9, output)
        self.assertEqual(self.records(), [])
        self.assertEqual([p.name for p in (self.task / "prompts").iterdir()], ["README.md"])
        rc, output = self.dispatch("bg-it", "sonnet", "--approved-by", "Test Operator")
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.records()[0]["approval"], "operator: Test Operator")

    def test_when_loop_on_dispatch_outside_approved_list_exits_nonzero(self):
        self.loop_on()
        for route, model in (("codex-cli", "reviewer"), ("bg-it", "opus")):
            rc, output = self.dispatch(route, model)
            self.assertEqual(rc, 9, output)
            self.assertIn("approved list", output)
        self.assertEqual(self.records(), [])

    def test_when_unattended_approved_by_does_not_bypass_the_approved_list(self):
        self.loop_on()
        rc, output = self.dispatch("codex-cli", "reviewer", "--approved-by", "Test Operator")
        self.assertEqual(rc, 9, output)
        self.assertIn("approved list", output)
        self.assertIn("--operator-exception", output)
        self.assertEqual(self.records(), [])

    def test_an_off_list_dispatch_needs_a_recorded_operator_exception(self):
        self.loop_on()
        rc, output = self.dispatch("codex-cli", "reviewer", "--operator-exception", "Test Operator")
        self.assertEqual(rc, 2, output)
        self.assertIn("--exception-reason", output)
        self.assertEqual(self.records(), [])
        rc, output = self.dispatch("codex-cli", "reviewer", "--operator-exception", "Test Operator",
                                   "--exception-reason", "the operator said yes to this review in chat")
        self.assertEqual(rc, 0, output)
        record = self.records()[0]
        self.assertTrue(record["approval"].startswith("operator exception: Test Operator"), record["approval"])
        self.assertEqual(record["exception"]["by"], "Test Operator")
        self.assertEqual(record["exception"]["reason"], "the operator said yes to this review in chat")
        self.assertEqual(record["exception"]["route"], "codex-cli:reviewer")
        self.assertIn("EXCEPTION", output)
        self.ok("loop", "off", "--task-dir", self.task, "--reason", "back to attended")
        rc, output = self.dispatch("codex-cli", "reviewer", "--operator-exception", "Test Operator",
                                   "--exception-reason", "x")
        self.assertEqual(rc, 2, output)
        self.assertIn("unattended", output)

    def test_when_loop_on_dispatch_inside_approved_list_is_recorded(self):
        self.loop_on()
        rc, output = self.dispatch()
        self.assertEqual(rc, 0, output)
        record = self.records()[0]
        self.assertEqual((record["id"], record["route"], record["model"], record["mode"]),
                         ("d1", "bg-it", "sonnet", "unattended"))
        self.assertIn("approved list", record["approval"])
        self.assertIn("babysitter:yolo", record["launch"])
        self.assertIn("MM-DISPATCH-OK d1", output)

    def test_dispatch_record_saves_exact_prompt_copy(self):
        rc, output = self.dispatch("bg-it", "sonnet", "--approved-by", "Test Operator", "--row", "#1")
        self.assertEqual(rc, 0, output)
        record = self.records()[0]
        copy = self.task / record["prompt"]
        self.assertTrue(copy.is_file())
        self.assertEqual(copy.read_bytes(), self.prompt.read_bytes())
        self.assertEqual(copy.parent, self.task / "prompts")
        self.assertEqual(record["row"], "#1")
        self.assertEqual(len(record["prompt_sha256"]), 64)
        self.assertIn(str(copy), record["launch"])
        rc, output = self.dispatch("bg-it", "sonnet", "--approved-by", "Test Operator")
        self.assertEqual(rc, 0, output)
        self.assertEqual([r["id"] for r in self.records()], ["d1", "d2"])
        self.assertNotEqual(self.records()[1]["prompt"], record["prompt"])

    def test_dispatch_close_marks_the_record_finished(self):
        self.dispatch("bg-it", "sonnet", "--approved-by", "Test Operator")
        self.ok("dispatch", "--task-dir", self.task, "--close", "d1", "--outcome", "inbox entry received")
        self.assertEqual(self.records()[0]["closed"]["outcome"], "inbox entry received")
        rc, output = self.mm("dispatch", "--task-dir", self.task, "--close", "d7", "--outcome", "x")
        self.assertEqual(rc, 4, output)


class LoopTests(LoopCase):
    def test_loop_on_requires_approved_by_and_route_list(self):
        for argv in ((), ("--approved-by", "Test Operator"), ("--route", "bg-it:sonnet")):
            rc, output = self.mm("loop", "on", "--task-dir", self.task, *argv)
            self.assertEqual(rc, 9, output)
        rc, output = self.mm("loop", "on", "--task-dir", self.task, "--approved-by", "Test Operator",
                             "--route", "bg-it")
        self.assertEqual(rc, 6, output)
        self.assertNotIn("loop", self.doc())
        self.loop_on()
        self.ok("loop", "on", "--task-dir", self.task, "--cron-id", "cron-7", "--owner-session", "s-1")
        loop = self.doc()["loop"]
        self.assertEqual((loop["cron_id"], loop["owner_session"], loop["routes"]), ("cron-7", "s-1", ["bg-it:sonnet"]))

    def test_loop_state_is_stored_in_ledger_and_compiled_into_handoff(self):
        output = self.loop_on()
        self.assertIn("mm tick", output)
        loop = self.doc()["loop"]
        self.assertEqual(loop["mode"], "unattended")
        self.assertEqual(loop["approved_by"], "Test Operator")
        self.assertEqual(loop["routes"], ["bg-it:sonnet"])
        self.assertEqual((loop["noop_count"], loop["noop_cap"], loop["cadence"]), (0, 5, "60m"))
        handoff = (self.task / "HANDOFF.md").read_text(encoding="utf-8")
        self.assertIn("### Loop", handoff)
        self.assertIn("Loop: unattended | routes bg-it:sonnet | no-ops 0/5 | last tick never", handoff)
        self.ok("loop", "tick", "--task-dir", self.task, "--result", "noop")
        self.assertIn("no-ops 1/5", (self.task / "HANDOFF.md").read_text(encoding="utf-8"))
        status = self.ok("loop", "status", "--task-dir", self.task)
        self.assertIn("Loop: unattended", status)
        self.assertEqual(self.ok("check", "--task-dir", self.task).strip().splitlines()[-1], "MM-CHECK-OK")

    def test_loop_never_creates_loop_md_or_loop_json(self):
        self.loop_on()
        for _ in range(2):
            self.ok("loop", "tick", "--task-dir", self.task, "--result", "noop")
        self.ok("loop", "tick", "--task-dir", self.task, "--result", "productive", "--action", "ran the tests")
        self.ok("loop", "off", "--task-dir", self.task, "--reason", "operator stopped it")
        names = self.tree_names() | {p.name for p in self.tmp.rglob("*")}
        self.assertNotIn("LOOP.md", names)
        self.assertNotIn("loop" + ".json", names)
        self.assertEqual(self.doc()["loop"]["mode"], "off")

    def test_when_five_noop_ticks_loop_turns_itself_off(self):
        self.loop_on()
        for n in range(1, 5):
            output = self.ok("loop", "tick", "--task-dir", self.task, "--result", "noop")
            self.assertNotIn("MM-LOOP-OFF", output)
            self.assertEqual(self.doc()["loop"]["noop_count"], n)
        output = self.ok("loop", "tick", "--task-dir", self.task, "--result", "noop")
        self.assertIn("MM-LOOP-OFF", output)
        self.assertIn("CronDelete", output)
        loop = self.doc()["loop"]
        self.assertEqual(loop["mode"], "off")
        self.assertIn("no-op cap", loop["stopped_reason"])
        rc, output = self.dispatch()
        self.assertEqual(rc, 9, output)

    def test_productive_tick_resets_the_noop_count_and_a_failed_check_stops_the_loop(self):
        self.loop_on()
        self.ok("loop", "tick", "--task-dir", self.task, "--result", "noop")
        self.ok("loop", "tick", "--task-dir", self.task, "--result", "productive")
        self.assertEqual(self.doc()["loop"]["noop_count"], 0)
        rc, output = self.mm("loop", "tick", "--task-dir", self.task, "--result", "stopped")
        self.assertEqual(rc, 2, output)
        output = self.ok("loop", "tick", "--task-dir", self.task, "--result", "stopped", "--reason", "check failed")
        self.assertIn("MM-LOOP-OFF", output)
        self.assertEqual(self.doc()["loop"]["stopped_reason"], "check failed")

    def test_single_cron_owner_duplicates_are_reported_for_deletion(self):
        self.loop_on()
        prompt = "mm tick " + str(self.task.absolute())
        crons = self.tmp / "crons.json"

        def plan(*records):
            crons.write_text(json.dumps(list(records)), encoding="utf-8")
            return self.ok("loop", "tick", "--task-dir", self.task, "--begin", "--crons-file", crons)

        out = plan({"id": "a", "prompt": prompt}, {"id": "b", "prompt": prompt},
                   {"id": "c", "prompt": "mm tick /some/other/task"})
        self.assertIn("CRON-ADOPT a", out)
        self.assertIn("CRON-DELETE b", out)
        self.assertNotIn("CRON-DELETE c", out)
        self.ok("loop", "on", "--task-dir", self.task, "--cron-id", "b")
        out = plan({"id": "a", "prompt": prompt}, {"id": "b", "prompt": "  " + prompt + " "})
        self.assertIn("CRON-KEEP b", out)
        self.assertIn("CRON-DELETE a", out)
        out = plan({"id": "c", "prompt": "mm tick /some/other/task"})
        self.assertIn("CRON-CREATE " + prompt, out)
        self.ok("loop", "off", "--task-dir", self.task)
        out = plan({"id": "b", "prompt": prompt})
        self.assertIn("MM-LOOP-OFF", out)
        self.assertIn("CRON-DELETE b", out)

    def test_tick_report_lists_rows_dispatches_noops_and_blockers(self):
        self.ok("mark-row", "--task-dir", self.task, "--id", "#2", "--blocked", "--reason", "which colour?")
        self.loop_on()
        rc, output = self.dispatch()
        self.assertEqual(rc, 0, output)
        output = self.ok("loop", "tick", "--task-dir", self.task, "--result", "noop", "--row", "#1",
                         "--action", "no-op: d1 still running", "--next", "check d1 again",
                         "--dedup", "deleted cron b")
        report = self.doc()["loop"]["last_tick"]["report"]
        self.assertEqual(self.doc()["loop"]["last_tick"]["result"], "noop")
        for text in ("widget", "#1", "no-op: d1 still running", "d1 bg-it:sonnet", "No-ops: 1/5", "#2",
                     "which colour?", "deleted cron b", "check d1 again"):
            self.assertIn(text, report)
            self.assertIn(text, output)

    def test_loop_on_records_host_rule_conflicts_and_operator_answers(self):
        rule = "CLAUDE.md:157: requires a per-task LOOP.md => follow the skill; no LOOP.md"
        self.loop_on("--host-rule", rule, "--host-rule", "AGENTS.md:9: cadence 30m => keep 60m")
        rules = self.doc()["loop"]["host_rules"]
        self.assertEqual(rules[0], {"source": "CLAUDE.md:157", "conflict": "requires a per-task LOOP.md",
                                    "answer": "follow the skill; no LOOP.md"})
        self.assertEqual(rules[1]["answer"], "keep 60m")
        rc, output = self.mm("loop", "on", "--task-dir", self.task, "--host-rule", "no arrow here")
        self.assertEqual(rc, 6, output)
        self.ok("loop", "on", "--task-dir", self.task, "--host-rule", "CLAUDE.md:12: notify on Telegram => no notifier")
        self.assertEqual(len(self.doc()["loop"]["host_rules"]), 3)
        self.assertIn("CLAUDE.md:157", self.ok("loop", "status", "--task-dir", self.task))


if __name__ == "__main__":
    unittest.main()
