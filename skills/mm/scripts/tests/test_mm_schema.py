import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import json
import re
import shutil
import tempfile
import unittest
from datetime import date, timedelta

import build_pm_dashboard
import mm_compile
import mm_ledger
import mm_schema

SKILL_DIR = pathlib.Path(__file__).resolve().parent.parent.parent


class SchemaSourceTests(unittest.TestCase):
    def test_template_enum_lines_match_schema(self):
        text = (SKILL_DIR / "references" / "handoff-template.md").read_text(encoding="utf-8")
        for field, allowed in mm_schema.ALLOWED.items():
            m = re.search(r"^- %s: (.+)$" % re.escape(field), text, re.M)
            self.assertIsNotNone(m, "template has no enum line for %s" % field)
            values = {v.strip() for v in m.group(1).split("|")}
            self.assertEqual(values, allowed, "template enum line for %s differs from mm_schema" % field)

    def test_builder_and_ledger_use_schema_fields(self):
        self.assertIs(build_pm_dashboard.FIELDS, mm_schema.FIELDS)
        self.assertIs(build_pm_dashboard.ALLOWED, mm_schema.ALLOWED)
        self.assertIs(build_pm_dashboard.MISSING_VALUES, mm_schema.MISSING_VALUES)
        self.assertIs(mm_ledger.DASHBOARD_FIELDS, mm_schema.FIELDS)
        self.assertIs(mm_ledger.STATES, mm_schema.STATES)
        self.assertIs(mm_compile.WRAPUP_LITERALS, mm_schema.WRAPUP_LITERALS)

    def test_canonical_and_legacy_wrapup_literals_are_supported(self):
        canonical = "Wrap up: insights review + move to done/"
        legacy = "Wrap up: insights review + status.md + move to done/"
        self.assertEqual(mm_schema.WRAPUP_LITERAL, canonical)
        self.assertIn(legacy, mm_schema.WRAPUP_LITERALS)
        for literal in (canonical, legacy):
            table = mm_compile.SECTION_1_HEADER + "\n" + mm_compile.SECTION_1_SEP + "\n"
            table += "| #9 | %s | ⚪ Not started | PM | not scheduled | last |" % literal
            rows = mm_compile._parse_rows(table)
            self.assertTrue(rows[0]["is_wrapup"], literal)

    def test_scaffold_defaults_are_valid_enum_values(self):
        for field, allowed in mm_schema.ALLOWED.items():
            self.assertIn(mm_schema.FIELD_DEFAULTS[field], allowed, field)

    def test_every_state_has_a_status_label(self):
        self.assertEqual(set(mm_schema.STATUS_LABELS), set(mm_schema.STATES))


def _task(values):
    return build_pm_dashboard.Task(values=values, handoff_path=pathlib.Path("x/HANDOFF.md"),
                                   project_root=pathlib.Path("x"), inbox_count=0)


class DormancyTests(unittest.TestCase):
    def test_on_demand_task_older_than_14_days_is_stale(self):
        today = date(2026, 9, 25)
        old = (today - timedelta(days=15)).isoformat() + " 10:00"
        fresh = (today - timedelta(days=13)).isoformat() + " 10:00"
        for cadence in ("on-demand", "unknown", "not set"):
            self.assertTrue(build_pm_dashboard.is_stale(
                _task({"Status": "active", "Review cadence": cadence, "Last updated": old}), today), cadence)
            self.assertFalse(build_pm_dashboard.is_stale(
                _task({"Status": "active", "Review cadence": cadence, "Last updated": fresh}), today), cadence)

    def test_done_task_is_never_stale(self):
        today = date(2026, 9, 25)
        task = _task({"Status": "done", "Review cadence": "on-demand", "Last updated": "2020-01-01 00:00"})
        self.assertFalse(build_pm_dashboard.is_stale(task, today))


class DashboardKeysTests(unittest.TestCase):
    def test_dashboard_json_keys_are_unchanged(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        task_dir = tmp / ".private" / "pm" / "active" / "widget"
        task_dir.mkdir(parents=True)
        doc = mm_ledger.new_ledger("widget", "smoke-project")
        (task_dir / "HANDOFF.md").write_text(mm_compile.compile_handoff(doc), encoding="utf-8")
        data = build_pm_dashboard.compute(tmp, build_pm_dashboard.load_tasks(tmp))
        build_pm_dashboard.write_outputs(tmp, data)
        written = json.loads((tmp / ".private" / "pm" / "dashboard.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(written), ["_warning", "counts", "generated_at", "malformed",
                                           "project_name", "project_root", "risks", "tasks"])
        self.assertEqual(sorted(written["counts"]), sorted([
            "active_handoffs", "blocked", "waiting", "overdue", "stale", "total_unprocessed_inbox",
            "malformed", "missing_target_date"]))
        self.assertEqual(sorted(written["risks"]), sorted([
            "blocked", "waiting", "overdue", "stale", "missing_target_date", "malformed_section_0a"]))
        expected_task_keys = sorted(list(build_pm_dashboard.KEYS.values()) + [
            "inbox_count", "handoff_path", "roadmap_path", "malformed_reason", "warnings"])
        self.assertEqual(sorted(written["tasks"][0]), expected_task_keys)
        self.assertEqual(written["tasks"][0]["malformed_reason"], "")


if __name__ == "__main__":
    unittest.main()
