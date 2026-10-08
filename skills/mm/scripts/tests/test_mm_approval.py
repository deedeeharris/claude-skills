import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import datetime
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import mm
import mm_runtime

MM_PY = pathlib.Path(__file__).resolve().parent.parent / "mm.py"
RECORD_FIELDS = {"id", "task", "task_dir", "row", "route", "model", "worker", "launch", "prompt_path",
                 "prompt_sha256", "prompt_bytes", "operator", "channel", "session", "approved_at", "expires_at",
                 "consumed_at", "consumed_by"}


class ApprovalCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state"),
                                               "PYTHONDONTWRITEBYTECODE": "1"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.overlay = self.tmp / "mm.local.md"
        self.overlay.write_text("# overlay\n\n```yaml\noperator_name: Test Operator\nauto_commit: off\n```\n",
                                encoding="utf-8")
        overlay = mock.patch.object(mm_runtime, "OVERLAY", self.overlay, create=True)
        overlay.start()
        self.addCleanup(overlay.stop)
        self.task = self.tmp / "proj" / ".private" / "pm" / "active" / "widget"
        self.ok("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "smoke-project",
                "--row", "Build the widget", "--row", "Choose the widget colour")
        self.prompt = self.tmp / "prompt.md"
        self.prompt.write_bytes("Build the widget.\r\nKeep \"quotes\" and $HOME; Ωμέγα.\n".encode("utf-8"))

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        rc, out, err = self.mm(*argv)
        self.assertEqual(rc, 0, out + err)
        return out

    def approve(self, *extra, row="#1", route="bg-it", model="sonnet", worker="bg"):
        return self.mm("approve-dispatch", "--task-dir", self.task, "--row", row, "--route", route, "--model", model,
                       "--worker", worker, "--prompt-file", self.prompt, *extra)

    def approved(self, *extra, **fields):
        rc, out, err = self.approve(*extra, **fields)
        self.assertEqual(rc, 0, out + err)
        return self.approvals()[-1]

    def dispatch(self, *extra, row="#1", route="bg-it", model="sonnet"):
        return self.mm("dispatch", "--task-dir", self.task, "--route", route, "--model", model,
                       "--prompt-file", self.prompt, "--row", row, *extra)

    def approvals(self):
        path = self.task / "prompts" / "approvals.jsonl"
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    def records(self):
        path = self.task / "prompts" / "dispatches.jsonl"
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    def prompt_names(self):
        return sorted(p.name for p in (self.task / "prompts").iterdir())

    def loop_on(self):
        self.ok("loop", "on", "--task-dir", self.task, "--approved-by", "Test Operator", "--route", "bg-it:sonnet")

    def assert_refused(self, result, code, needle):
        rc, out, err = result
        self.assertEqual(rc, code, out + err)
        self.assertIn(needle, out + err)


class ApproveDispatchTests(ApprovalCase):
    def test_when_approve_dispatch_runs_attended_it_writes_one_record_with_the_prompt_sha256_and_resolved_launch(self):
        rc, out, err = self.approve()
        self.assertEqual(rc, 0, out + err)
        records = self.approvals()
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(set(record), RECORD_FIELDS)
        digest = hashlib.sha256(self.prompt.read_bytes()).hexdigest()
        self.assertEqual(record["prompt_sha256"], digest)
        self.assertEqual(record["prompt_bytes"], len(self.prompt.read_bytes()))
        self.assertEqual(record["launch"], "/babysitter:yolo {prompt}")
        self.assertEqual((record["id"], record["task"], record["task_dir"], record["row"], record["route"],
                          record["model"], record["worker"], record["operator"], record["channel"]),
                         ("a1", "widget", str(self.task), "#1", "bg-it", "sonnet", "bg", "Test Operator", "cli"))
        self.assertTrue(pathlib.Path(record["prompt_path"]).is_absolute())
        self.assertEqual((record["consumed_at"], record["consumed_by"], record["session"]), (None, None, None))
        approved = datetime.datetime.fromisoformat(record["approved_at"])
        expires = datetime.datetime.fromisoformat(record["expires_at"])
        self.assertIsNotNone(approved.tzinfo)
        self.assertEqual(expires - approved, datetime.timedelta(minutes=15))
        self.assertEqual(out.strip(), f"MM-APPROVAL-OK a1 sha256={digest[:12]} expires {record['expires_at']}")
        second = self.approved("--launch", "codex exec {prompt}", "--session", "s-1", "--channel", "cc-dialog",
                               "--operator", "Other Operator", "--ttl-minutes", "30")
        self.assertEqual((second["id"], second["launch"], second["session"], second["channel"], second["operator"]),
                         ("a2", "codex exec {prompt}", "s-1", "cc-dialog", "Other Operator"))
        third = self.approved(route="codex-cli", model="reviewer", worker="codex")
        self.assertEqual((third["id"], third["launch"]), ("a3", ""))

    def test_when_approve_dispatch_dry_run_json_runs_it_returns_the_record_and_writes_nothing(self):
        before = sorted(p.as_posix() for p in self.task.rglob("*"))
        rc, out, err = self.approve("--dry-run", "--json", "--channel", "cc-dialog", "--session", "s-9")
        self.assertEqual(rc, 0, out + err)
        doc = json.loads(out)
        self.assertEqual(set(doc), {"schema", "dry_run", "record"})
        self.assertEqual((doc["schema"], doc["dry_run"]), ("mm.approval/1", True))
        self.assertEqual(set(doc["record"]), RECORD_FIELDS)
        self.assertEqual((doc["record"]["id"], doc["record"]["channel"], doc["record"]["session"],
                          doc["record"]["launch"]), ("a1", "cc-dialog", "s-9", "/babysitter:yolo {prompt}"))
        self.assertEqual(doc["record"]["prompt_sha256"], hashlib.sha256(self.prompt.read_bytes()).hexdigest())
        self.assertEqual(sorted(p.as_posix() for p in self.task.rglob("*")), before)
        rc, out, err = self.approve("--json")
        self.assertEqual(rc, 0, out + err)
        doc = json.loads(out)
        self.assertEqual((doc["dry_run"], doc["record"]), (False, self.approvals()[0]))

    def test_when_approve_dispatch_runs_unattended_it_exits_2(self):
        self.loop_on()
        rc, out, err = self.approve()
        self.assertEqual(rc, 2, out + err)
        self.assertIn("unattended", out + err)
        self.assertEqual(self.approvals(), [])

    def test_when_expect_sha256_differs_from_the_file_it_exits_9_prompt_changed(self):
        self.assert_refused(self.approve("--expect-sha256", "0" * 64), 9, "MM-APPROVAL-REFUSED PROMPT-CHANGED")
        self.assertEqual(self.approvals(), [])
        digest = hashlib.sha256(self.prompt.read_bytes()).hexdigest()
        self.assertEqual(self.approved("--expect-sha256", digest)["prompt_sha256"], digest)

    def test_when_no_operator_is_given_and_the_overlay_has_none_it_exits_2(self):
        self.overlay.write_text("# overlay\n\n```yaml\nauto_commit: off\n```\n", encoding="utf-8")
        self.assert_refused(self.approve(), 2, "--operator")
        self.overlay.unlink()
        self.assert_refused(self.approve(), 2, "--operator")
        self.assertEqual(self.approvals(), [])
        self.assertEqual(self.approved("--operator", "Named Operator")["operator"], "Named Operator")

    def test_when_approvals_jsonl_is_malformed_approve_dispatch_exits_22(self):
        path = self.task / "prompts" / "approvals.jsonl"
        for text in ("{not json\n", "[1, 2]\n", '{"no_id": true}\n'):
            path.write_text(text, encoding="utf-8")
            self.assert_refused(self.approve(), 22, "approvals.jsonl")
            self.assert_refused(self.approve("--dry-run", "--json"), 22, "approvals.jsonl")
            self.assertEqual(path.read_text(encoding="utf-8"), text)

    def test_when_approve_dispatch_targets_a_legacy_folder_it_exits_4(self):
        legacy = self.tmp / "proj" / ".private" / "pm" / "active" / "old"
        legacy.mkdir(parents=True)
        (legacy / "HANDOFF.md").write_text("# HANDOFF - old\n", encoding="utf-8")
        rc, out, err = self.mm("approve-dispatch", "--task-dir", legacy, "--row", "#1", "--route", "bg-it",
                               "--model", "sonnet", "--worker", "bg", "--prompt-file", self.prompt)
        self.assertEqual(rc, 4, out + err)
        self.assertIn("/mm migrate", out + err)
        self.assertFalse((legacy / "prompts").exists())

    def test_when_the_row_is_not_in_the_ledger_or_the_prompt_is_unreadable_approve_dispatch_refuses(self):
        self.assert_refused(self.approve(row="#99"), 2, "#99")
        rc, out, err = self.mm("approve-dispatch", "--task-dir", self.task, "--row", "#1", "--route", "bg-it",
                               "--model", "sonnet", "--worker", "bg", "--prompt-file", self.tmp / "missing.md")
        self.assertEqual(rc, 4, out + err)
        self.assertEqual(self.approvals(), [])

    def test_when_ttl_is_outside_1_to_1440_or_the_worker_is_unknown_approve_dispatch_exits_2(self):
        for ttl in ("0", "1441", "x"):
            rc, out, err = self.approve("--ttl-minutes", ttl)
            self.assertEqual(rc, 2, ttl + out + err)
        rc, out, err = self.approve(worker="robot")
        self.assertEqual(rc, 2, out + err)
        self.assertEqual(self.approvals(), [])
        self.assertEqual(self.approved("--ttl-minutes", "1440")["id"], "a1")

    def test_when_the_ledger_lock_is_held_approve_dispatch_exits_10(self):
        lock = self.task / "ledger.lock"
        lock.write_text("held by a test\n", encoding="utf-8")
        self.addCleanup(lambda: lock.unlink() if lock.exists() else None)
        self.assert_refused(self.approve(), 10, "ledger.lock")
        self.assertEqual(self.approvals(), [])


class ApprovalConsumptionTests(ApprovalCase):
    def test_when_dispatch_uses_a_matching_approval_it_records_the_dispatch_and_consumes_the_approval(self):
        approval = self.approved()
        rc, out, err = self.dispatch("--approval-id", "a1", "--worker", "bg")
        self.assertEqual(rc, 0, out + err)
        self.assertIn("MM-DISPATCH-OK d1 bg-it:sonnet (attended; approval a1: Test Operator via cli at", out)
        [record] = self.records()
        self.assertEqual(record["approval"], f"approval a1: Test Operator via cli at {approval['approved_at']}")
        self.assertEqual((record["approval_id"], record["worker"], record["mode"], record["row"]),
                         ("a1", "bg", "attended", "#1"))
        self.assertEqual(record["prompt_sha256"], approval["prompt_sha256"])
        self.assertIn("babysitter:yolo", record["launch"])
        [consumed] = self.approvals()
        self.assertEqual(consumed["consumed_by"], "d1")
        self.assertIsNotNone(datetime.datetime.fromisoformat(consumed["consumed_at"]).tzinfo)
        self.assertEqual({k: v for k, v in consumed.items() if not k.startswith("consumed")},
                         {k: v for k, v in approval.items() if not k.startswith("consumed")})

    def test_when_the_prompt_changed_after_approval_dispatch_exits_9_prompt_changed_and_writes_nothing(self):
        self.approved()
        names = self.prompt_names()
        self.prompt.write_bytes(self.prompt.read_bytes() + b"one more line\n")
        self.assert_refused(self.dispatch("--approval-id", "a1", "--worker", "bg"), 9,
                            "MM-APPROVAL-REFUSED PROMPT-CHANGED")
        self.assertEqual(self.records(), [])
        self.assertIsNone(self.approvals()[0]["consumed_at"])
        self.assertEqual(self.prompt_names(), names)

    def test_when_an_approval_is_reused_dispatch_exits_9_consumed(self):
        self.approved()
        self.ok("dispatch", "--task-dir", self.task, "--route", "bg-it", "--model", "sonnet", "--prompt-file",
                self.prompt, "--row", "#1", "--approval-id", "a1", "--worker", "bg")
        self.assert_refused(self.dispatch("--approval-id", "a1", "--worker", "bg"), 9, "MM-APPROVAL-REFUSED CONSUMED")
        self.assertEqual([r["id"] for r in self.records()], ["d1"])
        self.assertEqual(self.approvals()[0]["consumed_by"], "d1")
        self.assert_refused(self.dispatch("--approval-id", "a7", "--worker", "bg"), 9, "MM-APPROVAL-REFUSED UNKNOWN")

    def test_when_an_approval_expired_dispatch_exits_9_expired(self):
        approval = self.approved("--ttl-minutes", "1")
        later = datetime.datetime.fromisoformat(approval["expires_at"]) + datetime.timedelta(seconds=1)
        with mock.patch.object(mm_runtime, "_clock", return_value=later, create=True):
            self.assert_refused(self.dispatch("--approval-id", "a1", "--worker", "bg"), 9,
                                "MM-APPROVAL-REFUSED EXPIRED")
        self.assertEqual(self.records(), [])
        self.assertIsNone(self.approvals()[0]["consumed_at"])

    def test_when_route_model_row_or_worker_differs_dispatch_exits_9_mismatch_naming_the_field(self):
        cases = (("row", {"row": "#2"}, "bg"), ("route", {"route": "claude-bg"}, "bg"),
                 ("model", {"model": "opus"}, "bg"), ("worker", {}, "subagent"))
        for n, (field, change, worker) in enumerate(cases, 1):
            self.approved()
            self.assert_refused(self.dispatch("--approval-id", f"a{n}", "--worker", worker, **change), 9,
                                f"MM-APPROVAL-REFUSED MISMATCH:{field}")
        self.assertEqual(self.records(), [])
        self.assertEqual([a["consumed_at"] for a in self.approvals()], [None] * 4)

    def test_when_an_approval_made_in_one_worktree_copy_is_used_in_another_dispatch_exits_9_mismatch_task_dir(self):
        repo = self.tmp / "proj"

        def git(*argv):
            proc = subprocess.run(["git", "-c", "user.name=Test Operator",
                                   "-c", "user.email=operator" + "@example.invalid", *argv],
                                  cwd=str(repo), capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", stdin=subprocess.DEVNULL)
            self.assertEqual(proc.returncode, 0, "git %s: %s" % (" ".join(argv), proc.stderr))

        self.approved()
        git("init", "-q", "-b", "main")
        git("add", "-A")
        git("commit", "-qm", "task with approval a1")
        git("worktree", "add", "-q", "-b", "copy-b", str(self.tmp / "proj-b"))
        copy_b = self.tmp / "proj-b" / ".private" / "pm" / "active" / "widget"
        names = sorted(p.name for p in (copy_b / "prompts").iterdir())
        self.assert_refused(self.mm("dispatch", "--task-dir", copy_b, "--route", "bg-it", "--model", "sonnet",
                                    "--prompt-file", self.prompt, "--row", "#1", "--approval-id", "a1", "--worker",
                                    "bg"), 9, "MM-APPROVAL-REFUSED MISMATCH:task_dir")
        self.assertEqual(sorted(p.name for p in (copy_b / "prompts").iterdir()), names)
        [copied] = [json.loads(l) for l in (copy_b / "prompts" / "approvals.jsonl").read_text(encoding="utf-8")
                    .splitlines() if l.strip()]
        self.assertIsNone(copied["consumed_at"])
        rc, out, err = self.dispatch("--approval-id", "a1", "--worker", "bg")
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(self.approvals()[0]["consumed_by"], "d1")

    def test_when_dispatch_launch_differs_from_the_approved_launch_dispatch_exits_9_mismatch_launch(self):
        self.approved("--launch", "claude --bg {prompt}")
        self.assert_refused(self.dispatch("--approval-id", "a1", "--worker", "bg", "--launch", "other {prompt}"), 9,
                            "MM-APPROVAL-REFUSED MISMATCH:launch")
        self.assert_refused(self.dispatch("--approval-id", "a1", "--worker", "bg"), 9,
                            "MM-APPROVAL-REFUSED MISMATCH:launch")
        self.assertEqual(self.records(), [])
        rc, out, err = self.dispatch("--approval-id", "a1", "--worker", "bg", "--launch", "claude --bg {prompt}")
        self.assertEqual(rc, 0, out + err)
        self.assertTrue(self.records()[0]["launch"].startswith("claude --bg "))

    def test_when_neither_command_gives_launch_on_a_bg_route_the_default_template_matches(self):
        self.assertEqual(self.approved()["launch"], "/babysitter:yolo {prompt}")
        rc, out, err = self.dispatch("--approval-id", "a1", "--worker", "bg")
        self.assertEqual(rc, 0, out + err)
        record = self.records()[0]
        self.assertEqual(record["launch"], "/babysitter:yolo " + record["prompt_path"])

    def test_when_two_dispatches_race_for_one_approval_exactly_one_records_a_dispatch(self):
        self.approved()
        argv = [sys.executable, str(MM_PY), "dispatch", "--task-dir", str(self.task), "--route", "bg-it",
                "--model", "sonnet", "--prompt-file", str(self.prompt), "--row", "#1", "--approval-id", "a1",
                "--worker", "bg"]
        procs = [subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
                 for _ in range(2)]
        results = [(p.wait(timeout=120), p.stdout.read().decode("utf-8", "replace") +
                    p.stderr.read().decode("utf-8", "replace")) for p in procs]
        for p in procs:
            p.stdout.close()
            p.stderr.close()
        codes = sorted(code for code, _ in results)
        self.assertEqual(codes[0], 0, results)
        self.assertIn(codes[1], (9, 10), results)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.approvals()[0]["consumed_by"], self.records()[0]["id"])

    def test_when_approval_id_and_approved_by_are_both_given_dispatch_exits_2(self):
        self.approved()
        self.assert_refused(self.dispatch("--approval-id", "a1", "--worker", "bg", "--approved-by", "Test Operator"),
                            2, "--approved-by")
        self.assertEqual(self.records(), [])
        self.assertIsNone(self.approvals()[0]["consumed_at"])

    def test_when_approval_id_is_given_without_worker_dispatch_exits_2(self):
        self.approved()
        self.assert_refused(self.dispatch("--approval-id", "a1"), 2, "--worker")
        self.assertEqual(self.records(), [])
        self.assertIsNone(self.approvals()[0]["consumed_at"])

    def test_when_dispatch_gets_worker_without_approval_id_it_records_the_worker(self):
        rc, out, err = self.dispatch("--approved-by", "Test Operator", "--worker", "subagent")
        self.assertEqual(rc, 0, out + err)
        record = self.records()[0]
        self.assertEqual((record["worker"], record["approval"]), ("subagent", "operator: Test Operator"))
        self.assertNotIn("approval_id", record)

    def test_when_close_runs_on_a_task_with_approvals_jsonl_it_succeeds(self):
        self.approved()
        self.ok("dispatch", "--task-dir", self.task, "--route", "bg-it", "--model", "sonnet", "--prompt-file",
                self.prompt, "--row", "#1", "--approval-id", "a1", "--worker", "bg")
        self.approved(row="#2")
        self.ok("dispatch", "--task-dir", self.task, "--close", "d1", "--outcome", "built")
        for rid in ("#1", "#2"):
            self.ok("retire-row", "--task-dir", self.task, "--id", rid, "--reason", "deferred at close: trial ends")
        self.ok("close", "--task-dir", self.task, "--operator", "Test Operator", "--apply")
        done = self.tmp / "proj" / ".private" / "pm" / "done" / "widget"
        self.assertFalse(self.task.exists())
        kept = [json.loads(l) for l in (done / "prompts" / "approvals.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([(a["id"], a["consumed_by"]) for a in kept], [("a1", "d1"), ("a2", None)])


class UnattendedApprovalTests(ApprovalCase):
    def test_when_approval_id_is_given_in_unattended_mode_dispatch_exits_2(self):
        self.approved()
        self.loop_on()
        self.assert_refused(self.dispatch("--approval-id", "a1", "--worker", "bg"), 2, "unattended")
        self.assertEqual(self.records(), [])
        self.assertIsNone(self.approvals()[0]["consumed_at"])
        rc, out, err = self.dispatch()
        self.assertEqual(rc, 0, out + err)
        self.assertIn("approved list", self.records()[0]["approval"])


if __name__ == "__main__":
    unittest.main()
