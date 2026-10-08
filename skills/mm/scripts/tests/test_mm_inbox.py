import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import datetime
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import build_pm_dashboard
import mm
import mm_inbox

BODY = """## What was done
- Built the widget.

## What's next
- none

## Blockers
- none

## Files changed
- none

## Evidence
- python -m unittest exit:0

## Notes for PM
- none
"""

CEO_ENTRY = """---
agent: ceo
session: ceo-approved-20260101-093000
started: 20260101-093000
emitted: 20260101-093000
status: completed
task_ref: widget
recommendation_type: reschedule
approved_by: Test Operator
---

""" + BODY


class InboxCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.task = self.tmp / "proj" / ".private" / "pm" / "active" / "widget"
        rc, output = self.mm("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "smoke-project",
                             "--row", "Build the widget")
        self.assertEqual(rc, 0, output)
        self.inbox = self.task / "inbox"

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue() + err.getvalue()

    def body(self, text=BODY, name="body.md"):
        path = self.tmp / name
        path.write_text(text, encoding="utf-8")
        return path

    def write(self, body_path, source="builder"):
        return self.mm("inbox-write", "--task-dir", self.task, "--source", source, "--status", "completed",
                       "--task-ref", "#1", "--agent", "builder", "--session", "s-1",
                       "--started", "2026-01-01T09:00:00+00:00", "--body-file", body_path)

    def entries(self):
        return sorted(p.name for p in self.inbox.glob("*.md") if p.name != "README.md")

    def scan(self):
        return self.mm("inbox-scan", "--task-dir", self.task)


class InboxWriteTests(InboxCase):
    def test_when_inbox_write_runs_file_is_timestamp_named_with_frontmatter_and_six_sections(self):
        rc, output = self.write(self.body())
        self.assertEqual(rc, 0, output)
        names = self.entries()
        self.assertEqual(len(names), 1)
        self.assertRegex(names[0], r"^\d{8}-\d{6}-builder\.md$")
        text = (self.inbox / names[0]).read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        front = text.split("---\n")[1]
        for key in ("agent: builder", "session: s-1", "started: 2026-01-01T09:00:00+00:00", "emitted: ",
                    "status: completed", "task_ref: #1"):
            self.assertIn(key, front)
        positions = [text.index("## " + s) for s in mm_inbox.SECTIONS]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(self.scan()[0], 0)

    def test_when_body_misses_a_section_inbox_write_exits_nonzero_and_writes_nothing(self):
        missing = self.body(BODY.replace("## Evidence\n- python -m unittest exit:0\n\n", ""), "missing.md")
        rc, output = self.write(missing)
        self.assertEqual(rc, 6, output)
        self.assertIn("Evidence", output)
        swapped = BODY.replace("## Blockers", "## TMP").replace("## What's next", "## Blockers").replace(
            "## TMP", "## What's next")
        rc, output = self.write(self.body(swapped, "swapped.md"))
        self.assertEqual(rc, 6, output)
        self.assertEqual(self.entries(), [])

    def test_when_inbox_write_name_collides_it_never_overwrites(self):
        fixed = datetime.datetime(2026, 1, 1, 9, 30, 0).astimezone()
        with mock.patch.object(mm_inbox, "_now", return_value=fixed):
            self.assertEqual(self.write(self.body())[0], 0)
            first = (self.inbox / "20260101-093000-builder.md").read_bytes()
            other = self.body(BODY.replace("Built the widget.", "Built it again."), "other.md")
            rc, output = self.write(other)
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.entries(), ["20260101-093000-builder-2.md", "20260101-093000-builder.md"])
        self.assertEqual((self.inbox / "20260101-093000-builder.md").read_bytes(), first)
        self.assertIn("Built it again.", (self.inbox / "20260101-093000-builder-2.md").read_text(encoding="utf-8"))

    def test_inbox_write_refuses_a_source_that_is_not_a_slug(self):
        rc, output = self.write(self.body(), source="../escape")
        self.assertEqual(rc, 6, output)
        self.assertEqual(self.entries(), [])


class InboxScanTests(InboxCase):
    def test_when_inbox_has_misnamed_md_scan_reports_it(self):
        (self.inbox / "20260909-1555-builder.md").write_text(CEO_ENTRY, encoding="utf-8")
        (self.inbox / "notes-from-agent.md").write_text(CEO_ENTRY, encoding="utf-8")
        rc, output = self.scan()
        self.assertEqual(rc, 3, output)
        self.assertIn("20260909-1555-builder.md", output)
        self.assertIn("notes-from-agent.md", output)
        self.assertIn("MISNAMED", output)

    def test_when_task_root_has_literal_dollar_paren_file_scan_reports_it(self):
        stray = self.task / "inbox$(date +%s).md"
        stray.write_text("x\n", encoding="utf-8")
        rc, output = self.scan()
        self.assertEqual(rc, 3, output)
        self.assertIn("inbox$(date +%s).md", output)
        self.assertTrue(stray.exists())

    def test_when_task_root_has_an_expanded_inbox_named_file_scan_reports_it(self):
        strays = ["inbox1790445932.md", "inbox-20261001-120000-builder.md", "Inbox_notes.md"]
        for name in strays:
            (self.task / name).write_text("x\n", encoding="utf-8")
        (self.task / "insights.md").write_text("Last promotion review: never\n", encoding="utf-8")
        rc, output = self.scan()
        self.assertEqual(rc, 3, output)
        for name in strays:
            self.assertIn(name, output)
            self.assertTrue((self.task / name).exists())
        self.assertIn("STRAY-INBOX-FILE", output)
        self.assertNotIn("insights.md", output)

    def test_when_inbox_holds_non_markdown_file_scan_reports_it(self):
        (self.inbox / "screenshot.png").write_bytes(b"\x89PNG")
        rc, output = self.scan()
        self.assertEqual(rc, 3, output)
        self.assertIn("screenshot.png", output)
        self.assertIn("NOT-MARKDOWN", output)

    def test_when_an_entry_lacks_frontmatter_or_sections_scan_reports_it(self):
        (self.inbox / "20260101-090000-builder.md").write_text(BODY, encoding="utf-8")
        (self.inbox / "20260101-090001-builder.md").write_text(CEO_ENTRY.replace("## Evidence", "## Proof"),
                                                              encoding="utf-8")
        rc, output = self.scan()
        self.assertEqual(rc, 3, output)
        self.assertIn("20260101-090000-builder.md", output)
        self.assertIn("frontmatter", output)
        self.assertIn("Evidence", output)

    def test_readme_in_inbox_is_not_reported(self):
        self.assertTrue((self.inbox / "README.md").is_file())
        rc, output = self.scan()
        self.assertEqual(rc, 0, output)
        self.assertNotIn("README.md", output)
        self.assertIn("problems=0", output)

    def test_ceo_entry_is_accepted_as_valid(self):
        (self.inbox / "20260101-093000-ceo.md").write_text(CEO_ENTRY, encoding="utf-8")
        rc, output = self.scan()
        self.assertEqual(rc, 0, output)
        self.assertIn("20260101-093000-ceo.md", output)
        self.assertIn("entries=1", output)


class InboxCountTests(InboxCase):
    def setUp(self):
        super().setUp()
        (self.inbox / "20260101-093000-ceo.md").write_text(CEO_ENTRY, encoding="utf-8")
        (self.inbox / "notes-from-agent.md").write_text(CEO_ENTRY, encoding="utf-8")
        (self.task / "inbox1790454807.md").write_text(CEO_ENTRY, encoding="utf-8")
        rc, output = self.mm("inbox-scan", "--task-dir", self.task)
        self.assertIn("MM-INBOX-SCAN entries=1 problems=2", output)

    def test_status_counts_entries_and_problems_as_inbox_scan_does(self):
        rc, output = self.mm("status", "--task-dir", self.task)
        self.assertEqual(rc, 0, output)
        self.assertIn("Inbox: 1 unprocessed entries, 2 scan problems", output)

    def test_dashboard_counts_entries_and_problems_as_inbox_scan_does(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(build_pm_dashboard.build_and_write(self.tmp / "proj", no_commit=True), 0)
        self.assertIn("1 total unprocessed inbox, 2 inbox scan problems", out.getvalue())
        pm = self.tmp / "proj" / ".private" / "pm"
        markdown = (pm / "DASHBOARD.md").read_text(encoding="utf-8")
        self.assertIn("- Total unprocessed inbox count: 1", markdown)
        self.assertIn("- Inbox scan problems: 2", markdown)
        page = (pm / "DASHBOARD.html").read_text(encoding="utf-8")
        self.assertIn("<span>Inbox problems</span><strong>2</strong>", page)
        task = json.loads((pm / "dashboard.json").read_text(encoding="utf-8"))["tasks"][0]
        self.assertEqual(task["inbox_count"], 1)
        self.assertIn("inbox: 2 scan problems (mm.py inbox-scan lists them)", task["warnings"])


class ClosedTaskInboxTests(InboxCase):
    def setUp(self):
        super().setUp()
        self.closed = self.task.parent.parent / "done" / "gadget"
        rc, output = self.mm("scaffold", "--task-dir", self.closed, "--task", "gadget", "--project", "smoke-project",
                             "--row", "Build the gadget")
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.mm("inbox-scan", "--task-dir", self.task)[0], 0)

    def closed_updated(self, days_ago):
        path = self.closed / "ledger.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        stamp = datetime.datetime.now().astimezone() - datetime.timedelta(days=days_ago)
        doc["updated"] = stamp.replace(microsecond=0).isoformat()
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    def test_when_an_entry_reaches_a_recently_closed_task_inbox_scan_reports_it_loudly(self):
        (self.closed / "inbox" / "20260101-093000-late.md").write_text(CEO_ENTRY, encoding="utf-8")
        self.closed_updated(13)
        rc, output = self.mm("inbox-scan", "--task-dir", self.task)
        self.assertEqual(rc, 3, output)
        self.assertIn("INBOX-CLOSED-TASK done/gadget/inbox/20260101-093000-late.md: ", output)
        self.assertIn("closed-task-files=1", output)

    def test_when_an_entry_lands_on_the_old_active_path_after_the_move_inbox_scan_reports_it(self):
        stray = self.task.parent / "gadget" / "inbox"
        stray.mkdir(parents=True)
        (stray / "20260101-093000-late.md").write_text(CEO_ENTRY, encoding="utf-8")
        rc, output = self.mm("inbox-scan", "--task-dir", self.task)
        self.assertEqual(rc, 3, output)
        self.assertIn("INBOX-CLOSED-TASK active/gadget/inbox/20260101-093000-late.md: ", output)

    def test_when_an_entry_lands_on_the_old_active_path_inbox_scan_of_the_closed_task_reports_it_once(self):
        stray = self.task.parent / "gadget" / "inbox"
        stray.mkdir(parents=True)
        (stray / "20260101-093000-late.md").write_text(CEO_ENTRY, encoding="utf-8")
        for scanned in (self.closed, stray.parent):
            rc, output = self.mm("inbox-scan", "--task-dir", scanned)
            self.assertEqual(rc, 3, output)
            self.assertIn("INBOX-CLOSED-TASK active/gadget/inbox/20260101-093000-late.md: ", output)
            self.assertEqual(output.count("20260101-093000-late.md"), 1, output)

    def test_when_an_entry_reaches_the_closed_task_inbox_scan_of_that_task_reports_it_once(self):
        (self.closed / "inbox" / "20260101-093000-late.md").write_text(CEO_ENTRY, encoding="utf-8")
        rc, output = self.mm("inbox-scan", "--task-dir", self.closed)
        self.assertEqual(rc, 3, output)
        self.assertIn("INBOX-CLOSED-TASK done/gadget/inbox/20260101-093000-late.md: ", output)
        self.assertEqual(output.count("20260101-093000-late.md"), 1, output)
        (self.closed / "inbox" / "late-notes.txt").write_text("stray\n", encoding="utf-8")
        rc, output = self.mm("inbox-scan", "--task-dir", self.closed)
        self.assertEqual(rc, 3, output)
        self.assertIn("INBOX-CLOSED-TASK done/gadget/inbox/late-notes.txt: ", output)
        self.assertEqual(output.count("late-notes.txt"), 1, output)
        self.assertIn("MM-INBOX-SCAN entries=0 problems=0 closed-task-files=2", output)

    def test_when_a_late_entry_reaches_the_closed_task_status_counts_it_as_inbox_scan_does(self):
        (self.closed / "inbox" / "20260101-093000-late.md").write_text(CEO_ENTRY, encoding="utf-8")
        for scanned in (self.closed, self.task):
            with self.subTest(task=scanned.name):
                self.assertIn("MM-INBOX-SCAN entries=0 problems=0 closed-task-files=1",
                              self.mm("inbox-scan", "--task-dir", scanned)[1])
                rc, output = self.mm("status", "--task-dir", scanned)
                self.assertEqual(rc, 0, output)
                self.assertIn("Inbox: 0 unprocessed entries, 0 scan problems, 1 closed-task files", output)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build_pm_dashboard.build_and_write(self.tmp / "proj", no_commit=True), 0)
        task = json.loads((self.task.parent.parent / "dashboard.json").read_text(encoding="utf-8"))["tasks"][0]
        self.assertEqual(task["inbox_count"], 0)
        self.assertIn("inbox: 1 files of recently closed tasks (mm.py inbox-scan lists them)", task["warnings"])

    def test_a_task_closed_longer_ago_than_the_window_is_not_rescanned(self):
        (self.closed / "inbox" / "20260101-093000-late.md").write_text(CEO_ENTRY, encoding="utf-8")
        self.closed_updated(mm_inbox.CLOSED_RECHECK_DAYS + 1)
        rc, output = self.mm("inbox-scan", "--task-dir", self.task)
        self.assertEqual(rc, 0, output)
        self.assertNotIn("INBOX-CLOSED-TASK", output)


class InboxArchiveTests(InboxCase):
    def test_inbox_archive_moves_to_processed_year_month_and_never_deletes(self):
        (self.inbox / "20260101-093000-ceo.md").write_text(CEO_ENTRY, encoding="utf-8")
        (self.inbox / "20260214-100000-builder.md").write_text(CEO_ENTRY, encoding="utf-8")
        (self.inbox / "notes-from-agent.md").write_text("stray\n", encoding="utf-8")
        existing = self.inbox / "processed" / "2026-01" / "20260101-093000-ceo.md"
        existing.parent.mkdir(parents=True)
        existing.write_text("already archived\n", encoding="utf-8")
        rc, output = self.mm("inbox-archive", "--task-dir", self.task, "--all")
        self.assertEqual(rc, 3, output)
        self.assertIn("LEFT inbox/notes-from-agent.md", output)
        self.assertEqual(existing.read_text(encoding="utf-8"), "already archived\n")
        self.assertTrue((self.inbox / "processed" / "2026-01" / "20260101-093000-ceo-2.md").is_file())
        self.assertTrue((self.inbox / "processed" / "2026-02" / "20260214-100000-builder.md").is_file())
        self.assertTrue((self.inbox / "notes-from-agent.md").is_file())
        self.assertTrue((self.inbox / "README.md").is_file())
        self.assertEqual(self.entries(), ["notes-from-agent.md"])
        rc, output = self.mm("inbox-archive", "--task-dir", self.task, "--entry", "notes-from-agent.md")
        self.assertEqual(rc, 0, output)
        month = datetime.datetime.now().strftime("%Y-%m")
        self.assertTrue((self.inbox / "processed" / month / "notes-from-agent.md").is_file())
        self.assertEqual(self.entries(), [])
        rc, output = self.mm("inbox-archive", "--task-dir", self.task, "--entry", "gone.md")
        self.assertEqual(rc, 4, output)

    def test_when_inbox_archive_all_leaves_problem_files_it_exits_3(self):
        (self.inbox / "20260214-100000-builder.md").write_text(CEO_ENTRY, encoding="utf-8")
        (self.inbox / "notes-from-agent.md").write_text("stray\n", encoding="utf-8")
        rc, output = self.mm("inbox-archive", "--task-dir", self.task, "--all")
        self.assertEqual(rc, 3, output)
        self.assertIn("LEFT inbox/notes-from-agent.md", output)
        self.assertTrue((self.inbox / "processed" / "2026-02" / "20260214-100000-builder.md").is_file())
        (self.inbox / "notes-from-agent.md").unlink()
        (self.inbox / "20260215-100000-builder.md").write_text(CEO_ENTRY, encoding="utf-8")
        rc, output = self.mm("inbox-archive", "--task-dir", self.task, "--all")
        self.assertEqual(rc, 0, output)

    def test_check_warns_when_the_inbox_is_over_50_mb(self):
        with mock.patch.object(mm_inbox, "INBOX_WARN_BYTES", 10):
            (self.inbox / "big.bin").write_bytes(b"x" * 64)
            rc, output = self.mm("check", "--task-dir", self.task)
        self.assertEqual(rc, 0, output)
        self.assertIn("INBOX-LARGE", output)


if __name__ == "__main__":
    unittest.main()
