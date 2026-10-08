import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import datetime
import io
import json
import os
import re
import shutil
import tempfile
import unittest
from unittest import mock

import mm
import mm_launch
import mm_loop

LAUNCH = "/babysitter:yolo"
PREDATES = ("record predates prompt_path; cannot prove this launch; operator must check the builder by "
            "hand")


def ago(seconds: int) -> str:
    return (datetime.datetime.now().astimezone() - datetime.timedelta(seconds=seconds)).replace(
        microsecond=0).isoformat()


class LivenessCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state"),
                                               "CLAUDE_CONFIG_DIR": str(self.tmp / "claude")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.task = self.tmp / "proj" / ".private" / "pm" / "active" / "widget"
        rc, output = self.mm("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "smoke-project",
                             "--row", "Build the widget")
        self.assertEqual(rc, 0, output)
        prompt = self.tmp / "prompt.md"
        prompt.write_text("Build the widget.\n", encoding="utf-8")
        rc, output = self.mm("dispatch", "--task-dir", self.task, "--route", "bg-it", "--model", "sonnet",
                             "--prompt-file", prompt, "--approved-by", "Test Operator")
        self.assertEqual(rc, 0, output)
        self.transcript = self.tmp / "session.jsonl"
        self.runs = self.tmp / "runs"

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue() + err.getvalue()

    def lines(self, *records):
        """Write a transcript chained the way Claude Code writes one: a record without its own uuid gets
        one, and its parentUuid is the previous record's uuid."""
        out, self.last_uuid = [], None
        for n, record in enumerate(records):
            if "uuid" not in record:
                record = dict(record, uuid="r%d" % n, parentUuid=self.last_uuid)
            self.last_uuid = record["uuid"]
            out.append(record)
        self.transcript.write_text("".join(json.dumps(r) + "\n" for r in out), encoding="utf-8")

    def append(self, *records):
        with open(self.transcript, "a", encoding="utf-8") as fh:
            for n, record in enumerate(records):
                record = dict(record, uuid="a%d-%s" % (n, self.last_uuid), parentUuid=self.last_uuid)
                self.last_uuid = record["uuid"]
                fh.write(json.dumps(record) + "\n")

    def command_record(self, name=LAUNCH):
        """The launched session's command record: stamped now (after every launch time the tests use),
        in session S-1, with this dispatch's prompt copy as its argument, as a real launch writes it."""
        prompt = self.task / self.records()[0]["prompt"]
        return {"type": "user", "timestamp": ago(0), "sessionId": "S-1", "message": {
            "role": "user", "content": "<command-message>yolo</command-message>\n"
            f"<command-name>{name}</command-name>\n<command-args>{prompt}</command-args>"}}

    def tool_use(self):
        return {"type": "assistant", "timestamp": ago(0), "sessionId": "S-1", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "Starting."}, {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}}

    def run_dir(self, process_id, journal_files=3, created=None, named=True):
        """A babysitter run; when the session transcript exists, the launch's chain holds the
        `babysitter run:create` call that created it and the tool_result returning its run id."""
        run = self.runs / ("RUN-" + process_id)
        (run / "journal").mkdir(parents=True)
        (run / "run.json").write_text(json.dumps({"runId": run.name, "processId": process_id,
                                                  "createdAt": created or ago(60)}), encoding="utf-8")
        for n in range(journal_files):
            (run / "journal" / ("%06d.json" % n)).write_text("{}", encoding="utf-8")
        if named and self.transcript.is_file():
            self.append(*run_create(ago(0), run.name))
        return run

    def check(self, launched_ago, *extra):
        return self.mm("launch-check", "--task-dir", self.task, "--dispatch-id", "d1",
                       "--launched-at", ago(launched_ago), *extra)

    def records(self):
        path = self.task / "prompts" / "dispatches.jsonl"
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    def move_task(self, project):
        """Move the project holding the task folder to `project` under the temp folder."""
        target = self.tmp / project
        shutil.move(str(self.task.parents[3]), str(target))
        self.task = target / ".private" / "pm" / "active" / "widget"

    def rewrite(self, change, index=-1):
        records = self.records()
        change(records[index])
        (self.task / "prompts" / "dispatches.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


def run_create(at, run_id, tool_id="t2", command="babysitter run:create --process-id build-widget --json"):
    """The assistant's run:create call and the tool_result that returns the new run id."""
    return ({"type": "assistant", "timestamp": at, "sessionId": "S-1", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": tool_id, "name": "Bash", "input": {"command": command}}]}},
            {"type": "user", "timestamp": at, "sessionId": "S-1", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"runId": run_id})}]}})


class LaunchCheckTests(LivenessCase):
    def test_when_transcript_missing_after_window_launch_check_reports_dead(self):
        rc, output = self.check(5, "--transcript", self.transcript)
        self.assertEqual(rc, 0, output)
        self.assertIn("PENDING", output)
        rc, output = self.check(60, "--transcript", self.transcript)
        self.assertEqual(rc, 1, output)
        self.assertIn("DEAD", output)
        verdicts = [v["verdict"] for v in self.records()[0]["liveness"]]
        self.assertEqual(verdicts, ["PENDING", "DEAD"])

    def test_when_transcript_has_command_record_and_tool_use_launch_check_reports_alive(self):
        self.lines(self.command_record(), self.tool_use())
        rc, output = self.check(20, "--transcript", self.transcript)
        self.assertEqual(rc, 0, output)
        self.assertIn("ALIVE", output)
        self.run_dir("build-widget", journal_files=3)
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(rc, 0, output)
        self.assertIn("ALIVE", output)
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertIn("PENDING", output)
        self.assertIn("journal", output)
        (next(self.runs.iterdir()) / "journal" / "000099.json").write_text("{}", encoding="utf-8")
        rc, output = self.check(700, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(rc, 0, output)
        self.assertIn("ALIVE", output)

    def test_when_transcript_shows_unknown_command_launch_check_reports_dead(self):
        self.lines({"type": "user", "timestamp": ago(0), "message": {"role": "user", "content": "Unknown slash command: yolo"}})
        rc, output = self.check(20, "--transcript", self.transcript)
        self.assertEqual(rc, 1, output)
        self.assertIn("DEAD", output)
        self.assertIn("Unknown", output)

    def test_when_a_later_unrelated_command_is_unknown_the_launch_stays_alive(self):
        self.lines(self.command_record(), self.tool_use())
        self.append({"type": "system", "timestamp": ago(0), "sessionId": "S-1", "subtype": "local_command",
                     "content": "Unknown slash command: frobnicate"},
                    {"type": "user", "timestamp": ago(0), "sessionId": "S-1", "message": {
                        "role": "user", "content": "<command-name>/lint-all</command-name>"}},
                    {"type": "user", "timestamp": ago(0), "sessionId": "S-1", "message": {
                        "role": "user", "content": "Unknown slash command: lint-all"}})
        rc, output = self.check(20, "--transcript", self.transcript)
        self.assertEqual(rc, 0, output)
        self.assertIn("ALIVE", output)

    def test_when_the_launch_commands_own_result_is_unknown_launch_check_reports_dead(self):
        self.lines(self.command_record(), {"type": "system", "timestamp": ago(0), "sessionId": "S-1",
                                           "subtype": "local_command",
                                           "content": "Unknown slash command: babysitter:yolo"})
        rc, output = self.check(20, "--transcript", self.transcript)
        self.assertEqual(rc, 1, output)
        self.assertIn("DEAD", output)
        self.assertIn("Unknown slash command: babysitter:yolo", output)

    def test_when_the_launch_output_shows_an_untrusted_workspace_launch_check_reports_dead_at_once(self):
        log = self.tmp / "launch.log"
        log.write_text("Workspace not trusted. Run `claude` in the repo once and accept the trust prompt, then "
                       "retry.\n", encoding="utf-8")
        rc, output = self.check(5, "--transcript", self.transcript, "--launch-log", log)
        self.assertEqual(rc, 1, output)
        self.assertIn("DEAD", output)
        self.assertIn("Workspace not trusted", output)
        self.assertEqual(self.records()[0]["liveness"][-1]["verdict"], "DEAD")
        log.write_text("Started background session repo | Agent | widget\n", encoding="utf-8")
        rc, output = self.check(5, "--transcript", self.transcript, "--launch-log", log)
        self.assertEqual(rc, 0, output)
        self.assertIn("PENDING", output)

    def test_when_the_launch_log_is_missing_or_unreadable_launch_check_exits_4_and_names_it(self):
        for log in (self.tmp / "no-such-launch.log", self.tmp):
            with self.subTest(log=log):
                rc, output = self.check(5, "--transcript", self.transcript, "--launch-log", log)
                self.assertEqual(rc, 4, output)
                self.assertIn("--launch-log %s" % log, output)
                self.assertIn("cannot read it", output)
                self.assertNotIn("LAUNCH ", output)
                self.assertEqual(self.records()[0]["liveness"], [])

    def test_a_first_check_long_after_the_launch_says_it_came_late(self):
        rc, output = self.check(102, "--transcript", self.transcript)
        self.assertEqual(rc, 1, output)
        self.assertRegex(output, r"first check came at \+10\d s")
        rc, output = self.check(400, "--transcript", self.transcript)
        self.assertNotIn("first check came", output)

    def test_bare_run_dir_alone_is_not_proof_of_life(self):
        self.run_dir("bare-run", journal_files=5)
        rc, output = self.check(60, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(rc, 1, output)
        self.assertIn("DEAD", output)
        self.lines(self.command_record(), self.tool_use())
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(rc, 1, output)
        self.assertIn("bare-run", output)

    def test_codex_events_file_with_turn_started_reports_alive(self):
        events = self.tmp / "events.jsonl"
        prompt = self.tmp / "review.md"
        prompt.write_text("Review the widget.\n", encoding="utf-8")
        rc, output = self.mm("dispatch", "--task-dir", self.task, "--route", "codex-cli", "--model", "reviewer",
                             "--prompt-file", prompt, "--approved-by", "Test Operator")
        self.assertEqual(rc, 0, output)
        base = ["launch-check", "--task-dir", self.task, "--dispatch-id", "d2", "--events", events]
        rc, output = self.mm(*base, "--launched-at", ago(90))
        self.assertEqual(rc, 1, output)
        self.assertIn("DEAD", output)
        events.write_text(json.dumps({"type": "thread.started", "thread_id": "x"}) + "\n", encoding="utf-8")
        rc, output = self.mm(*base, "--launched-at", ago(10))
        self.assertEqual(rc, 0, output)
        self.assertIn("PENDING", output)
        events.write_text(json.dumps({"type": "thread.started"}) + "\n" + json.dumps({"type": "turn.started"})
                          + "\n", encoding="utf-8")
        rc, output = self.mm(*base, "--launched-at", ago(90))
        self.assertEqual(rc, 0, output)
        self.assertIn("ALIVE", output)

    def test_launch_check_on_an_unknown_dispatch_exits_4(self):
        rc, output = self.mm("launch-check", "--task-dir", self.task, "--dispatch-id", "d9")
        self.assertEqual(rc, 4, output)


class CorrelationTests(LivenessCase):
    """A launch is proven only by evidence tied to this dispatch: the command
    record names this dispatch's prompt copy and comes after the launch time,
    the tool_use follows it in the same session, and the run is one this
    session's transcript names."""

    def prompt_path(self):
        return str(self.task / self.records()[0]["prompt"])

    def launch_record(self, at, prompt=None, session="S-1"):
        return {"type": "user", "timestamp": at, "sessionId": session, "message": {
            "role": "user", "content": "<command-message>babysitter:yolo</command-message>\n"
            "<command-name>%s</command-name>\n<command-args>%s</command-args>" % (LAUNCH, prompt or self.prompt_path())}}

    def tool_record(self, at, session="S-1"):
        return {"type": "assistant", "timestamp": at, "sessionId": session, "message": {
            "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}}

    def run_named(self, at, run_id):
        return run_create(at, run_id)

    def verdict(self, output):
        return output.split("LAUNCH ", 1)[1].split()[0]

    def assert_refused(self, rc, output):
        """A --transcript that does not hold this dispatch's launch record is refused: exit 2, no verdict,
        nothing recorded."""
        self.assertEqual(rc, 2, output)
        self.assertIn("does not hold dispatch d1's launch record", output)
        self.assertNotIn("LAUNCH ", output)
        self.assertEqual(self.records()[0]["liveness"], [])

    def test_when_the_tool_use_predates_the_launch_command_it_is_not_proof(self):
        self.lines(self.tool_record(ago(300)), self.launch_record(ago(55)))
        rc, output = self.check(60, "--transcript", self.transcript)
        self.assertEqual(self.verdict(output), "DEAD", output)
        self.assertEqual(rc, 1, output)

    def test_when_the_command_record_names_another_prompt_it_is_not_this_launch(self):
        other = str(self.task / "prompts" / "20260101-000000-d7-other.md")
        self.lines(self.launch_record(ago(55), prompt=other), self.tool_record(ago(50)))
        rc, output = self.check(60, "--transcript", self.transcript)
        self.assert_refused(rc, output)

    def test_when_the_command_record_predates_the_launch_it_is_not_this_launch(self):
        self.lines(self.launch_record(ago(900)), self.tool_record(ago(890)))
        rc, output = self.check(60, "--transcript", self.transcript)
        self.assert_refused(rc, output)

    def test_when_the_session_id_differs_the_evidence_is_ignored(self):
        self.lines(self.launch_record(ago(55), session="S-9"), self.tool_record(ago(50), session="S-9"))
        rc, output = self.check(60, "--transcript", self.transcript, "--session-id", "S-1")
        self.assert_refused(rc, output)
        rc, output = self.check(60, "--transcript", self.transcript, "--session-id", "S-9")
        self.assertEqual(self.verdict(output), "ALIVE", output)

    def test_when_a_run_is_not_named_in_this_sessions_transcript_it_is_not_proof(self):
        self.lines(self.launch_record(ago(395)), self.tool_record(ago(390)))
        self.run_dir("other-work", journal_files=4, created=ago(300), named=False)
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(self.verdict(output), "DEAD", output)
        self.lines(self.launch_record(ago(395)), self.tool_record(ago(390)), *self.run_named(ago(300), "RUN-other-work"))
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(self.verdict(output), "ALIVE", output)

    def test_a_run_without_a_usable_creation_time_is_not_proof(self):
        run = self.run_dir("build-widget", journal_files=4)
        (run / "run.json").write_text(json.dumps({"runId": run.name, "processId": "build-widget"}), encoding="utf-8")
        self.lines(self.launch_record(ago(395)), self.tool_record(ago(390)), *self.run_named(ago(300), run.name))
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(self.verdict(output), "DEAD", output)

    def prompt_record(self, at, text):
        return {"type": "user", "timestamp": at, "sessionId": "S-1", "message": {"role": "user", "content": text}}

    def text_record(self, at, text):
        return {"type": "assistant", "timestamp": at, "sessionId": "S-1", "message": {
            "role": "assistant", "content": [{"type": "text", "text": text}]}}

    def test_a_failed_dispatch_followed_by_an_unrelated_tool_call_and_run_is_dead(self):
        run = self.run_dir("other-work", journal_files=4, created=ago(200), named=False)
        self.lines(*(
            self.launch_record(ago(395)),
            self.text_record(ago(394), "I cannot read that prompt file, so I stop here."),
            self.prompt_record(ago(300), "Unrelated: start the nightly report run."),
            *run_create(ago(250), run.name, tool_id="t9",
                        command="babysitter run:create --process-id nightly-report --json")))
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(self.verdict(output), "DEAD", output)
        self.assertEqual(rc, 1, output)
        self.assertIn("tool_use", output)

    def test_a_run_only_mentioned_after_the_launch_is_not_the_run_it_created(self):
        run = self.run_dir("other-work", journal_files=4, created=ago(200), named=False)
        self.lines(*(
            self.launch_record(ago(395)),
            self.tool_record(ago(390)),
            *run_create(ago(250), run.name, tool_id="t5", command="babysitter run:status %s --json" % run.name)))
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(self.verdict(output), "DEAD", output)
        self.lines(*(
            self.launch_record(ago(395)),
            self.tool_record(ago(390)),
            *run_create(ago(250), run.name, tool_id="t9",
                        command="babysitter run:create --process-id nightly-report --json")))
        rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
        self.assertEqual(self.verdict(output), "ALIVE", output)

    def test_evidence_on_another_branch_of_the_transcript_is_not_this_launch(self):
        records = [self.launch_record(ago(55)), self.text_record(ago(54), "Stopping.")]
        records.append(dict(self.tool_record(ago(50)), uuid="x1", parentUuid="elsewhere"))
        self.lines(*records)
        rc, output = self.check(60, "--transcript", self.transcript)
        self.assertEqual(self.verdict(output), "DEAD", output)

    def unknown_record(self, at, text):
        return {"type": "system", "timestamp": at, "sessionId": "S-1", "subtype": "local_command", "content": text}

    def test_when_an_explicit_transcript_holds_only_an_unknown_command_of_another_launch_it_is_refused(self):
        for at, text in ((ago(0), "Unknown slash command: lint-all"), (ago(0), "Unknown command: /frobnicate"),
                         (ago(0), "Unknown command: yolo-lite"), (ago(0), "Unknown command: /other:yolo"),
                         (ago(900), "Unknown command: /babysitter:yolo")):
            with self.subTest(text=text, at=at):
                self.lines(self.unknown_record(at, text))
                rc, output = self.check(60, "--transcript", self.transcript)
                self.assert_refused(rc, output)

    def test_when_an_explicit_transcript_holds_only_an_undated_unknown_command_of_the_launch_it_is_refused(self):
        for text in ("Unknown command: /babysitter:yolo", "Unknown slash command: yolo"):
            with self.subTest(text=text):
                record = self.unknown_record(ago(0), text)
                del record["timestamp"]
                self.lines(record)
                rc, output = self.check(60, "--transcript", self.transcript)
                self.assert_refused(rc, output)

    def test_when_an_explicit_transcript_shows_the_launch_command_unknown_launch_check_reports_dead(self):
        for text in ("Unknown command: /babysitter:yolo", "Unknown slash command: yolo"):
            with self.subTest(text=text):
                self.lines(self.unknown_record(ago(0), text))
                rc, output = self.check(60, "--transcript", self.transcript)
                self.assertEqual(self.verdict(output), "DEAD", output)
                self.assertEqual(rc, 1, output)
                self.assertIn(text, output)

    def test_when_an_explicit_transcript_cannot_be_read_launch_check_refuses_it_and_names_it(self):
        rc, output = self.check(60, "--transcript", self.tmp)
        self.assertEqual(rc, 2, output)
        self.assertIn("--transcript %s" % self.tmp, output)
        self.assertIn("cannot read it", output)
        self.assertNotIn("LAUNCH ", output)
        self.assertEqual(self.records()[0]["liveness"], [])

    def test_when_the_journal_stops_growing_past_the_stall_limit_the_launch_is_dead(self):
        run = self.run_dir("build-widget", journal_files=3, created=ago(300))
        self.lines(self.launch_record(ago(395)), self.tool_record(ago(390)), *self.run_named(ago(300), run.name))
        start = datetime.datetime.now().astimezone()
        verdicts = []
        for minutes in (0, 10, 61):
            with mock.patch.object(mm_loop, "_now", return_value=start + datetime.timedelta(minutes=minutes)):
                rc, output = self.check(400, "--transcript", self.transcript, "--run-dir", self.runs)
            verdicts.append(self.verdict(output))
        self.assertEqual(verdicts, ["ALIVE", "PENDING", "DEAD"])
        self.assertEqual(rc, 1, output)
        self.assertIn("not grown", output)



class DiscoveryTests(LivenessCase):
    """Without --transcript, launch-check finds the builder's transcript itself: in the Claude Code project
    folder named after the repo holding the task, the one transcript that started at or after the launch and
    holds this dispatch's launch record. None yet, or several, is reported, never guessed."""

    def folder(self, cwd=None):
        """Claude Code's folder for sessions started in cwd: every character but a letter or digit is '-'."""
        path = self.tmp / "claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd or self.tmp / "proj"))
        path.mkdir(parents=True, exist_ok=True)
        return path

    def session(self, path, *records):
        self.transcript = path
        self.lines(*records)
        return path

    def builder(self, path, session="S-1", at=None):
        """A builder's transcript: the launch record naming this dispatch's prompt copy, then a tool_use."""
        return self.session(path, dict(self.command_record(), sessionId=session, timestamp=at or ago(15)),
                            dict(self.tool_use(), sessionId=session, timestamp=at or ago(14)))

    def pm_session(self, path, quoted="Started background session"):
        """The PM's own session: started long before the launch, ran the launch command itself, and was
        written last, so it is the newest file in the folder. `quoted` is the output of a tool it ran after the
        launch, such as the builder's launch record read from the builder's transcript."""
        prompt = self.task / self.records()[0]["prompt"]
        self.session(path, {"type": "user", "timestamp": ago(3600), "sessionId": "PM-0", "message": {
                                "role": "user", "content": "mm update"}},
                     {"type": "assistant", "timestamp": ago(25), "sessionId": "PM-0", "message": {
                         "role": "assistant", "content": [{"type": "tool_use", "id": "p1", "name": "Bash", "input": {
                             "command": 'claude --bg "%s %s"' % (LAUNCH, prompt)}}]}},
                     {"type": "user", "timestamp": ago(0), "sessionId": "PM-0", "message": {"role": "user", "content": [
                         {"type": "tool_result", "tool_use_id": "p1", "content": quoted}]}},
                     dict(self.tool_use(), sessionId="PM-0"))
        newest = datetime.datetime.now().timestamp() + 600
        os.utime(path, (newest, newest))
        return path

    def test_when_a_windows_path_is_slugged_it_matches_claude_codes_project_folder_name(self):
        import mm_transcripts
        self.assertEqual(mm_transcripts.slug(r"D:\work\smoke-example"), "D--work-smoke-example")
        self.assertEqual(mm_transcripts.slug(r"D:\work\my_app\.private\pm"), "D--work-my-app--private-pm")

    def test_when_a_long_path_is_slugged_it_is_cut_at_200_characters_and_given_claude_codes_hash(self):
        """Expected values computed by Claude Code 2.1.283's own slug function, run in node."""
        import mm_transcripts
        long_name = "a-very-long-project-folder-name-"
        self.assertEqual(mm_transcripts.slug("D:\\work\\" + long_name * 7), "D--work-" + long_name * 6 + "-aemy6o")
        self.assertEqual(mm_transcripts.slug("C:\\u\\" + "\u00fcn\u00efcode-\U0001F600-" * 30),
                         "C--u-" + "-n-code----" * 17 + "-n-code-" + "-sojp84")

    def test_when_the_launch_folder_is_long_the_builder_is_found_in_claude_codes_shortened_folder(self):
        import mm_transcripts
        worktree = self.tmp / ("a-very-long-project-folder-name-" * 7)
        cut = re.sub(r"[^A-Za-z0-9]", "-", str(worktree))[:200]
        for suffix in (mm_transcripts.slug(worktree)[201:], "1bunhash"):
            with self.subTest(suffix=suffix):
                folder = self.tmp / "claude" / "projects" / (cut + "-" + suffix)
                folder.mkdir(parents=True)
                self.builder(folder / "builder-session.jsonl")
                rc, output = self.check(20, "--cwd", worktree)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH ALIVE d1", output)
                self.assertIn(folder.name, output)
                shutil.rmtree(folder)

    def test_when_the_pms_own_newer_transcript_sits_beside_the_builders_launch_check_picks_the_builders(self):
        self.builder(self.folder() / "builder-session.jsonl")
        self.session(self.folder() / "other-agent.jsonl", {"type": "user", "timestamp": ago(10), "sessionId": "S-7",
                                                           "message": {"role": "user", "content": "Lint the repo."}},
                     dict(self.tool_use(), sessionId="S-7"))
        self.pm_session(self.folder() / "pm-session.jsonl", quoted=self.command_record()["message"]["content"])
        rc, output = self.check(20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE d1", output)
        self.assertIn("builder-session.jsonl", output)
        self.assertEqual(self.records()[0]["session_id"], "S-1")

    def test_when_the_launch_ran_in_another_folder_cwd_names_it(self):
        worktree = self.tmp / "proj-worktree"
        self.builder(self.folder(worktree) / "builder-session.jsonl")
        rc, output = self.check(20, "--cwd", worktree)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE d1", output)

    def test_when_the_task_moved_after_dispatch_the_builder_is_found_where_the_launch_ran(self):
        original = self.tmp / "proj"
        self.assertEqual(self.records()[0]["launch_cwd"], str(original))
        self.builder(self.folder(original) / "builder-session.jsonl")
        self.move_task("moved proj")
        rc, output = self.check(20, "--cwd", self.tmp / "moved proj")
        self.assertEqual(rc, 1, output)
        self.assertIn("LAUNCH DEAD d1", output)
        self.assertIn(self.folder(self.tmp / "moved proj").name, output)
        rc, output = self.check(20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE d1", output)
        self.assertIn("builder-session.jsonl", output)
        self.assertIn(self.folder(original).name, output)
        self.assertEqual(self.records()[0]["session_id"], "S-1")

    def test_when_an_older_dispatch_record_stores_no_launch_cwd_the_repo_holding_the_task_is_searched(self):
        self.builder(self.folder(self.tmp / "proj") / "builder-session.jsonl")
        self.rewrite(lambda r: r.pop("launch_cwd", None), index=0)
        self.move_task("moved proj")
        rc, output = self.check(20)
        self.assertEqual(rc, 1, output)
        self.assertIn("LAUNCH DEAD d1", output)
        self.assertIn(self.folder(self.tmp / "moved proj").name, output)
        self.builder(self.folder(self.tmp / "moved proj") / "builder-session.jsonl")
        rc, output = self.check(20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE d1", output)
        self.assertIn(self.folder(self.tmp / "moved proj").name, output)

    def test_when_no_builder_transcript_exists_yet_launch_check_reports_pending_with_the_reason(self):
        self.pm_session(self.folder() / "pm-session.jsonl")
        rc, output = self.check(5)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH PENDING d1", output)
        self.assertIn("no transcript that started after the launch holds its launch record yet", output)
        self.assertIn(self.folder().name, output)
        rc, output = self.check(60)
        self.assertEqual(rc, 1, output)
        self.assertIn("LAUNCH DEAD d1", output)
        self.assertIn(self.folder().name, output)
        self.assertEqual([v["verdict"] for v in self.records()[0]["liveness"]], ["PENDING", "DEAD"])

    def test_when_two_transcripts_hold_the_launch_record_launch_check_reports_the_ambiguity(self):
        self.builder(self.folder() / "first.jsonl", session="S-1")
        self.builder(self.folder() / "second.jsonl", session="S-2")
        rc, output = self.check(20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH PENDING d1", output)
        self.assertIn("2 transcripts hold this dispatch's launch record", output)
        self.assertIn("first.jsonl", output)
        self.assertIn("second.jsonl", output)
        self.assertIn("--session-id", output)
        self.assertNotIn("session_id", self.records()[0])
        rc, output = self.check(20, "--session-id", "S-2")
        self.assertIn("LAUNCH ALIVE d1", output)
        self.assertIn("second.jsonl", output)

    def test_when_an_explicit_transcript_lacks_this_launch_record_launch_check_refuses_it(self):
        for quoted in ("Started background session", self.command_record()["message"]["content"],
                       "Unknown slash command: babysitter:yolo"):
            with self.subTest(quoted=quoted):
                pm = self.pm_session(self.folder() / "pm-session.jsonl", quoted=quoted)
                rc, output = self.check(20, "--transcript", pm)
                self.assertEqual(rc, 2, output)
                self.assertIn("does not hold dispatch d1's launch record", output)
                self.assertNotIn("ALIVE", output)
                self.assertEqual(self.records()[0]["liveness"], [])
        (self.tmp / "elsewhere").mkdir()
        builder = self.builder(self.tmp / "elsewhere" / "builder.jsonl")
        rc, output = self.check(20, "--transcript", builder)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE d1", output)


class LaunchFormTests(LivenessCase):
    """A launch that is not a slash command (an overlay launch_override or --launch, such as a plain prompt) is
    proven only by a user record, stamped at or after the launch, holding the whole launch text the dispatch
    record stores; a record that only names the prompt copy is not proof."""

    def dispatch_plain(self, template):
        rc, output = self.mm("dispatch", "--task-dir", self.task, "--route", "bg-it", "--model", "sonnet",
                             "--prompt-file", self.tmp / "prompt.md", "--approved-by", "Test Operator",
                             "--launch", template)
        self.assertEqual(rc, 0, output)
        return self.records()[-1]

    def folder(self, cwd=None):
        path = self.tmp / "claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd or self.tmp / "proj"))
        path.mkdir(parents=True, exist_ok=True)
        return path

    def session(self, name, text, content=None, cwd=None):
        """A session started after the launch in `cwd` (default: the project): one user record, then an
        assistant tool_use chained to it."""
        self.transcript = self.folder(cwd) / name
        self.lines({"type": "user", "timestamp": ago(15), "sessionId": "S-1", "message": {
                        "role": "user", "content": content if content is not None else text}},
                   {"type": "assistant", "timestamp": ago(14), "sessionId": "S-1", "message": {
                       "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}})
        return self.transcript

    def check_id(self, dispatch_id, launched_ago, *extra):
        return self.mm("launch-check", "--task-dir", self.task, "--dispatch-id", dispatch_id,
                       "--launched-at", ago(launched_ago), *extra)

    def test_when_a_non_slash_launch_is_only_named_by_an_unrelated_session_it_is_not_alive(self):
        record = self.dispatch_plain("Read {prompt} and do what it says.")
        copy = self.task / record["prompt"]
        tool_result = [{"type": "tool_result", "tool_use_id": "p1", "content": record["launch"]}]
        for text, content in (("Summarise %s for me." % copy.name, None), ("What is in %s?" % copy, None),
                              ("", tool_result)):
            with self.subTest(text=text or "a tool result quoting the whole launch text"):
                path = self.session("unrelated.jsonl", text, content)
                rc, output = self.check_id(record["id"], 60)
                self.assertNotIn("ALIVE", output)
                self.assertEqual(rc, 1, output)
                self.assertIn("LAUNCH DEAD %s" % record["id"], output)
                path.unlink()
        self.assertNotIn("session_id", self.records()[-1])

    def test_when_a_non_slash_launchs_first_prompt_holds_the_full_launch_text_it_is_alive(self):
        for template in ("Read {prompt} and do what it says.", "Run the prompt in"):
            with self.subTest(template=template):
                record = self.dispatch_plain(template)
                copy = str(self.task / record["prompt"])
                want = template.replace("{prompt}", copy) if "{prompt}" in template else template + " " + copy
                self.assertEqual(record["launch"], want)
                path = self.session("builder.jsonl", record["launch"])
                rc, output = self.check_id(record["id"], 20)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH ALIVE %s" % record["id"], output)
                self.assertIn("builder.jsonl", output)
                self.assertEqual(self.records()[-1]["session_id"], "S-1")
                path.unlink()

    def test_when_the_dispatch_record_stores_no_launch_text_a_record_naming_the_prompt_is_not_proof(self):
        for stored in ("", "Run the prompt in"):
            with self.subTest(stored=stored):
                record = self.dispatch_plain("Run {prompt}")
                records = self.records()
                records[-1]["launch"] = stored
                (self.task / "prompts" / "dispatches.jsonl").write_text(
                    "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
                copy = self.task / record["prompt"]
                path = self.session("builder.jsonl", "Run the prompt in %s" % copy)
                rc, output = self.check_id(record["id"], 60, "--transcript", path)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH PENDING %s" % record["id"], output)
                self.assertIn("stores no launch text", output)
                rc, output = self.check_id(record["id"], 90, "--transcript", path, "--stall-minutes", "1")
                self.assertEqual(rc, 1, output)
                self.assertIn("LAUNCH DEAD %s" % record["id"], output)
                self.assertEqual([v["verdict"] for v in self.records()[-1]["liveness"]], ["PENDING", "DEAD"])
                self.assertNotIn("session_id", self.records()[-1])
                path.unlink()

    def test_when_the_stored_launch_is_only_the_prompt_path_a_record_naming_the_path_is_not_alive(self):
        for template in ("{prompt}", " {prompt}", "{prompt}\n"):
            with self.subTest(template=template):
                record = self.dispatch_plain(template)
                copy = self.task / record["prompt"]
                self.assertEqual(record["launch"], template.replace("{prompt}", str(copy)))
                path = self.session("unrelated.jsonl", "What is in %s?" % copy)
                rc, output = self.check_id(record["id"], 60)
                self.assertNotIn("ALIVE", output)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH PENDING %s" % record["id"], output)
                self.assertIn("stores no launch text", output)
                self.assertNotIn("session_id", self.records()[-1])
                path.unlink()

    def test_when_a_command_launchs_first_prompt_holds_its_full_text_and_a_tool_use_it_is_alive(self):
        record = self.dispatch_plain("run-builder {prompt}")
        self.assertEqual(record["launch"], "run-builder %s" % (self.task / record["prompt"]))
        self.session("builder.jsonl", record["launch"])
        rc, output = self.check_id(record["id"], 20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE %s" % record["id"], output)
        self.assertIn("builder.jsonl", output)
        self.assertEqual(self.records()[-1]["session_id"], "S-1")

    def test_when_no_launch_text_is_stored_and_no_record_names_the_prompt_launch_check_waits_for_the_stall_limit(self):
        record = self.dispatch_plain("Run {prompt}")
        records = self.records()
        records[-1]["launch"] = ""
        (self.task / "prompts" / "dispatches.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        self.folder()
        rc, output = self.check_id(record["id"], 60)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH PENDING %s" % record["id"], output)
        self.assertIn("no transcript that started after the launch holds its launch record", output)
        self.assertIn("stores no launch text", output)
        self.assertIn("DEAD at the stall limit (60 min after the launch)", output)
        rc, output = self.check_id(record["id"], 90, "--stall-minutes", "1")
        self.assertEqual(rc, 1, output)
        self.assertIn("LAUNCH DEAD %s" % record["id"], output)
        self.assertIn("stall limit 1 min", output)
        self.assertEqual([v["verdict"] for v in self.records()[-1]["liveness"]], ["PENDING", "DEAD"])

    def test_when_the_task_moved_after_a_path_only_launch_with_a_space_a_record_quoting_that_path_is_not_alive(self):
        self.move_task("old proj")
        record = self.dispatch_plain("{prompt}")
        self.assertIn(" ", record["launch"])
        self.move_task("proj")
        self.session("unrelated.jsonl", "What is in %s?" % record["launch"], cwd=self.tmp / "old proj")
        rc, output = self.check_id(record["id"], 60)
        self.assertNotIn("ALIVE", output)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH PENDING %s" % record["id"], output)
        self.assertIn("stores no launch text", output)
        self.assertNotIn("session_id", self.records()[-1])

    def test_when_the_task_moved_after_dispatch_the_stored_prompt_path_decides_the_launch_text(self):
        self.move_task("old proj")
        records = [self.dispatch_plain(t) for t in ("{prompt}", "run-builder {prompt}")]
        old = self.task
        self.move_task("proj")
        for record, verdict in zip(records, ("PENDING", "ALIVE")):
            with self.subTest(launch=record["launch"]):
                self.assertEqual(record["prompt_path"], str(old / record["prompt"]))
                self.assertNotEqual(record["prompt_path"], str(self.task / record["prompt"]))
                self.assertIn(record["prompt_path"], record["launch"])
                path = self.session("builder.jsonl", record["launch"], cwd=self.tmp / "old proj")
                rc, output = self.check_id(record["id"], 20)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH %s %s" % (verdict, record["id"]), output)
                path.unlink()

    def test_when_an_older_dispatch_record_stores_no_prompt_path_its_launch_text_is_not_proof(self):
        record = self.dispatch_plain("run-builder {prompt}")
        self.rewrite(lambda r: r.pop("prompt_path", None))
        self.session("builder.jsonl", record["launch"])
        rc, output = self.check_id(record["id"], 60)
        self.assertNotIn("ALIVE", output)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH PENDING %s" % record["id"], output)
        self.assertIn("stores no launch text", output)
        self.assertIn(PREDATES, output)
        rc, output = self.check_id(record["id"], 90, "--stall-minutes", "1")
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH PENDING %s" % record["id"], output)
        self.assertIn(PREDATES, output)
        self.assertEqual([v["verdict"] for v in self.records()[-1]["liveness"]], ["PENDING", "PENDING"])
        self.assertEqual(mm_launch.launch_facts({"launch": "/babysitter:yolo /work/p.md"})["command"],
                         "/babysitter:yolo")

    def test_when_an_older_non_slash_record_without_prompt_path_is_past_the_stall_limit_it_waits_for_the_operator(self):
        record = self.dispatch_plain("run-builder {prompt}")
        self.rewrite(lambda r: r.pop("prompt_path", None))
        self.folder()
        missing = self.tmp / "not-written-yet.jsonl"
        for extra in ((), ("--transcript", missing)):
            with self.subTest(extra=extra):
                rc, output = self.check_id(record["id"], 90 * 60, "--stall-minutes", "1", *extra)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH PENDING %s" % record["id"], output)
                self.assertIn(PREDATES, output)
                self.assertNotIn("LAUNCH DEAD", output)
        self.assertEqual([v["verdict"] for v in self.records()[-1]["liveness"]], ["PENDING", "PENDING"])
        log = self.tmp / "launch.log"
        log.write_text("run-builder: command not found\n", encoding="utf-8")
        rc, output = self.check_id(record["id"], 60, "--launch-log", log)
        self.assertEqual(rc, 1, output)
        self.assertIn("LAUNCH DEAD %s: the launch output says" % record["id"], output)

    def test_when_an_older_non_slash_record_without_prompt_path_is_given_an_existing_transcript_it_is_refused(self):
        record = self.dispatch_plain("run-builder {prompt}")
        self.rewrite(lambda r: r.pop("prompt_path", None))
        unrelated = self.session("unrelated.jsonl", "Summarise the widget notes.")
        builder = self.session("builder.jsonl", record["launch"])
        for path in (unrelated, builder):
            with self.subTest(transcript=path.name):
                rc, output = self.check_id(record["id"], 60, "--transcript", path)
                self.assertEqual(rc, 2, output)
                self.assertNotIn("LAUNCH ", output)
                self.assertIn(str(path), output)
                self.assertIn("no transcript can prove", output)
        unreadable = self.tmp / "a-folder.jsonl"
        unreadable.mkdir()
        rc, output = self.check_id(record["id"], 60, "--transcript", unreadable)
        self.assertEqual(rc, 2, output)
        self.assertNotIn("LAUNCH ", output)
        self.assertIn("--transcript %s: cannot read it" % unreadable, output)
        self.assertEqual(self.records()[-1]["liveness"], [])
        log = self.tmp / "launch.log"
        log.write_text("run-builder: command not found\n", encoding="utf-8")
        rc, output = self.check_id(record["id"], 60, "--launch-log", log, "--transcript", unrelated)
        self.assertEqual(rc, 1, output)
        self.assertIn("LAUNCH DEAD %s: the launch output says" % record["id"], output)
        self.assertEqual([v["verdict"] for v in self.records()[-1]["liveness"]], ["DEAD"])

    def test_when_an_older_slash_command_record_stores_no_prompt_path_its_command_record_still_proves_it(self):
        self.rewrite(lambda r: r.pop("prompt_path", None), index=0)
        self.transcript = self.folder() / "builder.jsonl"
        self.lines(dict(self.command_record(), timestamp=ago(15)), dict(self.tool_use(), timestamp=ago(14)))
        rc, output = self.check_id("d1", 20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE d1", output)
        self.assertNotIn(PREDATES, output)

    def test_when_the_stored_launch_is_only_a_quoted_prompt_path_a_record_quoting_it_is_not_alive(self):
        for template in ('"{prompt}"', "'{prompt}'", ' "{prompt}" ', "`{prompt}`"):
            with self.subTest(template=template):
                record = self.dispatch_plain(template)
                self.assertEqual(record["launch"], template.replace("{prompt}", record["prompt_path"]))
                path = self.session("unrelated.jsonl", "What is in %s?" % record["launch"])
                rc, output = self.check_id(record["id"], 60)
                self.assertNotIn("ALIVE", output)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH PENDING %s" % record["id"], output)
                self.assertIn("stores no launch text", output)
                self.assertNotIn("session_id", self.records()[-1])
                path.unlink()

    def test_when_the_stored_launch_is_only_the_prompt_path_in_other_punctuation_a_record_quoting_it_is_not_alive(self):
        for template in ("\u201c{prompt}\u201d", "\u00ab{prompt}\u00bb", "({prompt})", "<{prompt}>"):
            with self.subTest(template=template):
                record = self.dispatch_plain(template)
                self.assertEqual(record["launch"], template.replace("{prompt}", record["prompt_path"]))
                path = self.session("unrelated.jsonl", "What is in %s?" % record["launch"])
                rc, output = self.check_id(record["id"], 60)
                self.assertNotIn("ALIVE", output)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH PENDING %s" % record["id"], output)
                self.assertIn("stores no launch text", output)
                self.assertNotIn("session_id", self.records()[-1])
                path.unlink()

    def test_when_the_stored_launch_repeats_only_the_prompt_path_a_record_quoting_it_is_not_alive(self):
        for template in ("{prompt} {prompt}", '"{prompt}" ({prompt})'):
            with self.subTest(template=template):
                record = self.dispatch_plain(template)
                self.assertEqual(record["launch"], template.replace("{prompt}", record["prompt_path"]))
                path = self.session("unrelated.jsonl", "What is in %s?" % record["launch"])
                rc, output = self.check_id(record["id"], 60)
                self.assertNotIn("ALIVE", output)
                self.assertEqual(rc, 0, output)
                self.assertIn("LAUNCH PENDING %s" % record["id"], output)
                self.assertIn("stores no launch text", output)
                self.assertNotIn("session_id", self.records()[-1])
                path.unlink()

    def test_when_a_command_launch_repeats_the_prompt_path_its_first_prompt_holding_the_full_text_is_alive(self):
        record = self.dispatch_plain("run-builder {prompt} {prompt}")
        self.assertEqual(record["launch"], "run-builder %s %s" % (record["prompt_path"], record["prompt_path"]))
        self.session("builder.jsonl", record["launch"])
        rc, output = self.check_id(record["id"], 20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE %s" % record["id"], output)
        self.assertIn("builder.jsonl", output)
        self.assertEqual(self.records()[-1]["session_id"], "S-1")

    def test_when_a_command_launch_wraps_the_prompt_path_in_curly_quotes_its_first_prompt_holding_the_full_text_is_alive(self):
        record = self.dispatch_plain("run-builder \u201c{prompt}\u201d")
        self.assertEqual(record["launch"], "run-builder \u201c%s\u201d" % record["prompt_path"])
        self.session("builder.jsonl", record["launch"])
        rc, output = self.check_id(record["id"], 20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE %s" % record["id"], output)
        self.assertIn("builder.jsonl", output)
        self.assertEqual(self.records()[-1]["session_id"], "S-1")

    def test_when_a_command_launch_quotes_the_prompt_path_its_first_prompt_holding_the_full_text_is_alive(self):
        record = self.dispatch_plain('run-builder "{prompt}"')
        self.assertEqual(record["launch"], 'run-builder "%s"' % record["prompt_path"])
        self.session("builder.jsonl", record["launch"])
        rc, output = self.check_id(record["id"], 20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE %s" % record["id"], output)
        self.assertIn("builder.jsonl", output)
        self.assertEqual(self.records()[-1]["session_id"], "S-1")

    def test_when_no_launch_text_is_stored_a_transcript_file_not_written_yet_waits_for_the_stall_limit(self):
        record = self.dispatch_plain("{prompt}")
        missing = self.tmp / "not-written-yet.jsonl"
        rc, output = self.check_id(record["id"], 60, "--transcript", missing)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH PENDING %s" % record["id"], output)
        self.assertIn("stores no launch text", output)
        rc, output = self.check_id(record["id"], 90, "--transcript", missing, "--stall-minutes", "1")
        self.assertEqual(rc, 1, output)
        self.assertIn("LAUNCH DEAD %s" % record["id"], output)
        self.assertIn("stall limit 1 min", output)
        self.assertEqual([v["verdict"] for v in self.records()[-1]["liveness"]], ["PENDING", "DEAD"])

    def test_when_the_launch_starts_with_an_absolute_executable_path_it_is_a_command_launch_not_a_slash_command(self):
        record = self.dispatch_plain("/usr/bin/run {prompt}")
        self.assertEqual(record["launch"], "/usr/bin/run %s" % (self.task / record["prompt"]))
        self.session("builder.jsonl", record["launch"])
        rc, output = self.check_id(record["id"], 20)
        self.assertEqual(rc, 0, output)
        self.assertIn("LAUNCH ALIVE %s" % record["id"], output)
        self.assertIn("builder.jsonl", output)
        for launch, command in (("/babysitter:yolo /work/p.md", "/babysitter:yolo"), ("/lint-all /work/p.md", "/lint-all"),
                                ("/usr/bin/run /work/p.md", ""), ("/opt/run:x /work/p.md", "")):
            with self.subTest(launch=launch):
                self.assertEqual(mm_launch.launch_facts({"launch": launch})["command"], command)


if __name__ == "__main__":
    unittest.main()
