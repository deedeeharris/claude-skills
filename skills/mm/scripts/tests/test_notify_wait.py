import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import json
import os
import shutil
import subprocess
import tempfile
import unittest

PYTHON = sys.executable
SKILL = pathlib.Path(__file__).resolve().parent.parent.parent
HOOK = SKILL / "hooks" / "notify_wait.py"
SECRET = "SENTINEL-Q-7f3a"
FOOTER_WAIT = ("Pick route A or B " + SECRET + "?\n\n```\n━━━ STATUS ━━━\n"
               "PM mode:  mm PM for widget\nBlocked:  operator picks A or B " + SECRET + "\n```")
FOOTER_FREE = FOOTER_WAIT.replace("Blocked:  operator picks A or B " + SECRET, "Blocked:  none")
CODEX_WAIT = "\U0001f3a9 PM mode | Task: widget\n\nShip it now or wait for review " + SECRET + "?"


class NotifyWaitCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = self.tmp / "state"
        self.env = dict(os.environ, MM_STATE_DIR=str(self.state), MM_NTFY_TOPIC="test-topic",
                        MM_NTFY_DRY_RUN="1", PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
        self.repo = self.tmp / "proj"
        (self.repo / ".git").mkdir(parents=True)
        self.task = self.repo / ".private" / "pm" / "active" / "widget"
        self.task.mkdir(parents=True)

    def bind(self, session):
        path = self.state / "sessions" / (session + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"task_dir": str(self.task), "role": "pm"}), encoding="utf-8")

    def run_hook(self, payload, host="claude-code", raw=None):
        base = {"session_id": "s-1", "cwd": str(self.repo), "transcript_path": None}
        base.update(payload)
        proc = subprocess.run([PYTHON, str(HOOK), "--host", host], input=raw if raw is not None else json.dumps(base),
                              capture_output=True, text=True, encoding="utf-8", env=self.env, timeout=60)
        self.assertEqual((proc.returncode, proc.stdout), (0, ""), proc.stderr)

    def stop(self, text, **extra):
        return dict({"hook_event_name": "Stop", "last_assistant_message": text}, **extra)

    def ask(self, **extra):
        return dict({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion",
                     "tool_input": {"questions": [{"question": "Which route? " + SECRET}]}}, **extra)

    def outbox(self):
        path = self.state / "notify" / "outbox.jsonl"
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


class WhenItPingsTests(NotifyWaitCase):
    def test_when_a_pm_turn_ends_blocked_one_ping_names_host_repo_task_time_session_dir_and_resume(self):
        self.run_hook(self.stop(FOOTER_WAIT))
        [req] = self.outbox()
        self.assertEqual(req["url"], "https://ntfy.sh/test-topic")
        self.assertEqual(req["headers"]["Title"], "mm PM waiting - Claude Code")
        self.assertEqual((req["headers"]["Tags"], req["headers"]["Priority"]), ("warning,computer", "high"))
        for needle in ("Claude Code", "Repo: proj", "Task: widget", "Time: ", "Session: s-1",
                       "Dir: " + str(self.repo), "claude --resume s-1"):
            self.assertIn(needle, req["body"])

    def test_when_the_footer_says_blocked_none_no_ping_is_sent(self):
        self.run_hook(self.stop(FOOTER_FREE))
        self.assertEqual(self.outbox(), [])

    def test_when_the_footer_says_pm_mode_no_no_ping_is_sent(self):
        self.run_hook(self.stop(FOOTER_WAIT.replace("mm PM for widget", "no")))
        self.assertEqual(self.outbox(), [])

    def test_when_a_bound_pm_calls_ask_user_question_one_ping_is_sent(self):
        self.bind("s-1")
        self.run_hook(self.ask())
        [req] = self.outbox()
        self.assertIn("Task: widget", req["body"])

    def test_when_an_unbound_non_pm_session_calls_ask_user_question_no_ping_is_sent(self):
        self.run_hook(self.ask())
        self.assertEqual(self.outbox(), [])

    def test_when_a_subagent_stops_blocked_no_ping_is_sent(self):
        self.run_hook(self.stop(FOOTER_WAIT, agent_id="a-1"))
        self.assertEqual(self.outbox(), [])

    def test_when_the_same_wait_repeats_in_one_session_only_one_ping_is_sent(self):
        self.run_hook(self.stop(FOOTER_WAIT))
        self.run_hook(self.stop(FOOTER_WAIT))
        self.assertEqual(len(self.outbox()), 1)

    def test_when_the_topic_is_empty_nothing_is_sent(self):
        self.env["MM_NTFY_TOPIC"] = ""
        self.run_hook(self.stop(FOOTER_WAIT))
        self.assertEqual(self.outbox(), [])

    def test_when_a_codex_pm_ends_on_a_question_the_ping_names_codex_and_codex_resume(self):
        self.run_hook(self.stop(CODEX_WAIT), host="codex")
        [req] = self.outbox()
        self.assertEqual(req["headers"]["Title"], "mm PM waiting - Codex")
        self.assertIn("codex resume s-1", req["body"])

    def test_when_the_payload_is_not_json_the_hook_exits_0_and_prints_nothing(self):
        self.run_hook({}, raw="not json")
        self.assertEqual(self.outbox(), [])


class SecrecyTests(NotifyWaitCase):
    def test_no_request_and_no_state_file_carries_question_blocked_or_reply_text(self):
        self.bind("s-2")
        self.run_hook(self.stop(FOOTER_WAIT))
        self.run_hook(self.ask(session_id="s-2"))
        self.run_hook(self.stop(CODEX_WAIT, session_id="s-3"), host="codex")
        reqs = self.outbox()
        self.assertEqual(len(reqs), 3)
        dumped = json.dumps(reqs, ensure_ascii=False)
        for leak in (SECRET, "Pick route", "operator picks", "Which route", "Ship it"):
            self.assertNotIn(leak, dumped)
        for req in reqs:
            req["headers"]["Title"].encode("ascii")
        for path in (self.state / "notify").iterdir():
            if path.name != "outbox.jsonl":
                self.assertNotIn(SECRET, path.read_text(encoding="utf-8"), path.name)


if __name__ == "__main__":
    unittest.main()
