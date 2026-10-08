import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import datetime
import errno
import io
import json
import os
import re
import shutil
import stat
import tempfile
import unittest
from unittest import mock

import mm
import mm_atomic
import mm_cli
import mm_compile
import mm_ledger
import mm_repair

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"
REPAIRABLE = ("pair_ledger_ahead", "rounds_ledger_ahead", "states_and_shapes", "needs_fix", "handoff_ahead")
BACKUP_RE = re.compile(r"^\d{8}-\d{6}-repair$")
UNRECORDED = "{} is not in the backup and was not written by this run; left in place"
CHANGED = "{} is not in the backup and no longer matches this run's recorded write; left in place"
UNPROVEN = ("{} is not in the backup and matches this run's recorded write, but this platform gives no file id "
            "(st_dev, st_ino) to prove it is the same file; left in place")


def tree(folder: pathlib.Path) -> dict:
    return {p.relative_to(folder).as_posix(): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}


class RepairCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.active = self.tmp / "proj" / ".private" / "pm" / "active"
        self.active.mkdir(parents=True)

    def copy(self, name: str, source=None) -> pathlib.Path:
        dst = self.active / name.replace("_", "-")
        shutil.copytree(source or (FIXTURES / "ledgers" / name), dst)
        return dst

    def mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue() + err.getvalue()

    def assert_dry_run_leaves_fixture_byte_identical(self, name):
        task = self.copy(name)
        before = tree(task)
        self.assertNotEqual(self.mm("check", "--task-dir", task)[0], 0)
        rc, output = self.mm("repair", "--task-dir", task)
        self.assertEqual(rc, 14, output)
        self.assertEqual(tree(task), before)

    def assert_apply_yields_valid_ledger_with_zero_drift(self, name):
        task = self.copy(name)
        rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 0, output)
        doc = mm_ledger.load_ledger(task)
        mm_ledger.validate_ledger(doc)
        self.assertEqual({kind for _, kind, _ in mm_compile.diagnose(task, doc)}, {"OK"})
        rc, output = self.mm("check", "--task-dir", task)
        self.assertEqual(rc, 0, output)
        self.assertTrue((task / "HANDOFF.md").read_text(encoding="utf-8").startswith(mm_compile.GENERATED_HEADER))
        rows = doc["rows"]
        self.assertTrue(rows[-1]["is_wrapup"])
        self.assertEqual(sum(1 for r in rows if r["is_wrapup"]), 1)

    def assert_apply_writes_timestamped_backup_first(self, name):
        task = self.copy(name)
        original = tree(task)
        seen = []
        real = mm_repair.write_result

        def spy(folder, *args, **kwargs):
            backups = [d for d in (task / "backups").iterdir() if BACKUP_RE.match(d.name)]
            seen.append([tree(d) for d in backups])
            return real(folder, *args, **kwargs)

        with mock.patch.object(mm_repair, "write_result", side_effect=spy):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 0, output)
        self.assertEqual(len(seen), 1)
        self.assertEqual(len(seen[0]), 1)
        backup = seen[0][0]
        for name_ in ("ledger.json", "HANDOFF.md"):
            self.assertEqual(backup[name_], original[name_])


class RepairFixtureTests(RepairCase):
    def test_repair_dry_run_leaves_fixture_byte_identical_pair_ledger_ahead(self):
        self.assert_dry_run_leaves_fixture_byte_identical("pair_ledger_ahead")

    def test_repair_dry_run_leaves_fixture_byte_identical_rounds_ledger_ahead(self):
        self.assert_dry_run_leaves_fixture_byte_identical("rounds_ledger_ahead")

    def test_repair_dry_run_leaves_fixture_byte_identical_states_and_shapes(self):
        self.assert_dry_run_leaves_fixture_byte_identical("states_and_shapes")

    def test_repair_dry_run_leaves_fixture_byte_identical_needs_fix(self):
        self.assert_dry_run_leaves_fixture_byte_identical("needs_fix")

    def test_repair_dry_run_leaves_fixture_byte_identical_handoff_ahead(self):
        self.assert_dry_run_leaves_fixture_byte_identical("handoff_ahead")

    def test_repair_apply_yields_valid_ledger_with_zero_drift_pair_ledger_ahead(self):
        self.assert_apply_yields_valid_ledger_with_zero_drift("pair_ledger_ahead")

    def test_repair_apply_yields_valid_ledger_with_zero_drift_rounds_ledger_ahead(self):
        self.assert_apply_yields_valid_ledger_with_zero_drift("rounds_ledger_ahead")

    def test_repair_apply_yields_valid_ledger_with_zero_drift_states_and_shapes(self):
        self.assert_apply_yields_valid_ledger_with_zero_drift("states_and_shapes")

    def test_repair_apply_yields_valid_ledger_with_zero_drift_needs_fix(self):
        self.assert_apply_yields_valid_ledger_with_zero_drift("needs_fix")

    def test_repair_apply_yields_valid_ledger_with_zero_drift_handoff_ahead(self):
        self.assert_apply_yields_valid_ledger_with_zero_drift("handoff_ahead")

    def test_repair_apply_writes_timestamped_backup_first_pair_ledger_ahead(self):
        self.assert_apply_writes_timestamped_backup_first("pair_ledger_ahead")

    def test_repair_apply_writes_timestamped_backup_first_rounds_ledger_ahead(self):
        self.assert_apply_writes_timestamped_backup_first("rounds_ledger_ahead")

    def test_repair_apply_writes_timestamped_backup_first_states_and_shapes(self):
        self.assert_apply_writes_timestamped_backup_first("states_and_shapes")

    def test_repair_apply_writes_timestamped_backup_first_needs_fix(self):
        self.assert_apply_writes_timestamped_backup_first("needs_fix")

    def test_repair_apply_writes_timestamped_backup_first_handoff_ahead(self):
        self.assert_apply_writes_timestamped_backup_first("handoff_ahead")


class RepairBehaviourTests(RepairCase):
    def test_repair_ambiguous_choice_exits_15_and_writes_nothing(self):
        task = self.copy("ambiguous_both_ahead")
        before = tree(task)
        for extra in ((), ("--apply",)):
            rc, output = self.mm("repair", "--task-dir", task, *extra)
            self.assertEqual(rc, 15, output)
            self.assertIn("QUESTION 1", output)
            self.assertIn("recommended", output)
            self.assertIn("--decide 1=", output)
            self.assertIn("Q4", output)
            self.assertEqual(tree(task), before)
        rc, output = self.mm("repair", "--task-dir", task, "--apply", "--decide", "1=keep")
        self.assertEqual(rc, 0, output)
        qids = [d["qid"] for d in mm_ledger.load_ledger(task)["decisions"]]
        self.assertEqual(sorted(qids), ["Q1", "Q2", "Q3", "Q4"])
        self.assertEqual(self.mm("check", "--task-dir", task)[0], 0)

    def test_when_row_text_keys_are_null_repair_sets_defaults_and_ledger_validates(self):
        task = self.copy("needs_fix")
        doc = json.loads((task / "ledger.json").read_text(encoding="utf-8"))
        doc["rows"][0]["blocked_reason"] = None
        doc["rows"][0]["history"] = None
        (task / "ledger.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
        rc, output = self.mm("repair", "--task-dir", task)
        self.assertEqual(rc, 14, output)
        self.assertIn("REPAIR null-row-values", output)
        rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 0, output)
        row = mm_ledger.load_ledger(task)["rows"][0]
        self.assertEqual(row["blocked_reason"], "")
        self.assertIsInstance(row["history"], list)
        self.assertEqual(self.mm("check", "--task-dir", task)[0], 0)

    def test_repair_decide_for_an_unknown_question_is_a_usage_error(self):
        task = self.copy("ambiguous_both_ahead")
        before = tree(task)
        for decide in ("7=keep", "1=sideways", "one=keep"):
            rc, output = self.mm("repair", "--task-dir", task, "--apply", "--decide", decide)
            self.assertEqual(rc, 2, output)
        self.assertEqual(tree(task), before)

    def test_repair_dry_run_exits_14_and_prints_report_and_unified_diff(self):
        task = self.copy("states_and_shapes")
        rc, output = self.mm("repair", "--task-dir", task)
        self.assertEqual(rc, 14, output)
        for line in ("--- a/ledger.json", "+++ b/ledger.json", "--- a/HANDOFF.md", "+++ b/HANDOFF.md"):
            self.assertIn(line, output)
        self.assertIn("REPAIR invented-state", output)
        self.assertIn("MM-REPAIR-DRY-RUN", output)

    def test_repair_apply_holds_ledger_lock_and_refuses_when_locked(self):
        task = self.copy("needs_fix")
        lock = task / "ledger.lock"
        lock.write_bytes(mm_ledger._lock_identity_payload())
        before = tree(task)
        rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 10, output)
        self.assertEqual(tree(task), before)
        lock.unlink()
        held = []
        real = mm_repair.write_result

        def spy(folder, *args, **kwargs):
            held.append((task / "ledger.lock").exists())
            return real(folder, *args, **kwargs)

        with mock.patch.object(mm_repair, "write_result", side_effect=spy):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 0, output)
        self.assertEqual(held, [True])
        self.assertFalse(lock.exists())

    def test_repair_on_valid_in_sync_ledger_exits_0_with_no_changes(self):
        task = self.active / "clean-task"
        rc, output = self.mm("scaffold", "--task-dir", task, "--task", "clean-task", "--project", "smoke-project",
                             "--row", "Build the widget")
        self.assertEqual(rc, 0, output)
        before = tree(task)
        for extra in ((), ("--apply",)):
            rc, output = self.mm("repair", "--task-dir", task, *extra)
            self.assertEqual(rc, 0, output)
            self.assertIn("nothing to change", output)
        self.assertEqual(tree(task), before)
        self.assertFalse((task / "backups").exists())

    def test_repair_restores_the_backup_when_the_result_fails_check(self):
        task = self.copy("needs_fix")
        before = tree(task)
        with mock.patch.object(mm_repair, "acceptable", return_value=False):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 1, output)
        after = tree(task)
        for name in ("ledger.json", "HANDOFF.md"):
            self.assertEqual(after[name], before[name])
        self.assertNotIn("ROADMAP.html", after)

    def test_repair_on_legacy_folder_names_mm_migrate(self):
        task = self.copy("legacy_task", FIXTURES / "legacy_task")
        rc, output = self.mm("repair", "--task-dir", task)
        self.assertEqual(rc, 4, output)
        self.assertIn("/mm migrate", output)

    def test_when_absorb_dry_run_reports_decisions_missing_from_ledger(self):
        task = self.copy("handoff_ahead")
        rc, output = self.mm("repair", "--task-dir", task)
        self.assertEqual(rc, 14, output)
        absorb = [l for l in output.splitlines() if l.startswith("REPAIR absorb-decisions")]
        self.assertEqual(len(absorb), 1, output)
        for qid in ("Q4", "Q5", "Q6"):
            self.assertIn(qid, absorb[0])
        self.assertNotIn("Q1", absorb[0])
        self.assertIn("#4", output)

    def test_handoff_ahead_apply_takes_the_newer_handoff_content(self):
        task = self.copy("handoff_ahead")
        self.assertEqual(self.mm("repair", "--task-dir", task, "--apply")[0], 0)
        doc = mm_ledger.load_ledger(task)
        self.assertEqual([r["id"] for r in doc["rows"]], ["#1", "#2", "#4", "#3"])
        self.assertEqual(doc["rows"][1]["state"], "REVIEW")
        self.assertEqual(doc["dashboard_index"]["Next agent action"], "write the results chapter")
        self.assertIn("appendix", doc["passthrough"]["section_3_md"])

    def test_when_normalize_dry_run_lists_every_change_and_writes_nothing(self):
        task = self.copy("states_and_shapes")
        before = tree(task)
        rc, output = self.mm("repair", "--task-dir", task)
        self.assertEqual(rc, 14, output)
        report = {l.split(":")[0]: l for l in output.splitlines() if l.startswith("REPAIR ")}
        expected = {
            "REPAIR invented-state": ("#1", "#2", "#3"),
            "REPAIR state-blocked-pair": ("#4",),
            "REPAIR foreign-row-shape": ("#5",),
            "REPAIR missing-row-keys": ("#5", "#6"),
            "REPAIR bare-date-updated": ("2026-06-10",),
            "REPAIR header-missing": ("HANDOFF.md",),
        }
        for key, ids in expected.items():
            self.assertIn(key, report, output)
            for rid in ids:
                self.assertIn(rid, report[key])
        self.assertEqual(tree(task), before)

    def test_when_normalize_applied_invalid_ledger_becomes_valid(self):
        task = self.copy("states_and_shapes")
        with self.assertRaises(mm_ledger.LedgerValidationError):
            mm_ledger.validate_ledger(json.loads((task / "ledger.json").read_text(encoding="utf-8")))
        rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 0, output)
        doc = mm_ledger.load_ledger(task)
        states = {r["id"]: (r["state"], r["blocked"]) for r in doc["rows"]}
        self.assertEqual(states["#1"], ("IMPLEMENTING", False))
        self.assertEqual(states["#2"], ("BACKLOG", False))
        self.assertEqual(states["#3"], ("IMPLEMENTING", False))
        self.assertEqual(states["#4"], ("NEEDS_DECISION", True))
        foreign = next(r for r in doc["rows"] if r["id"] == "#5")
        self.assertEqual(foreign["item"], "Write the widget docs")
        self.assertEqual(foreign["target_date"], "2026-06-30")
        self.assertEqual(foreign["legacy"], {"title": "Write the widget docs", "due": "2026-06-30"})
        self.assertEqual(next(r for r in doc["rows"] if r["id"] == "#1")["status_label"], "In progress")

    def test_pair_fixture_decisions_are_imported_and_wrapup_moves_last(self):
        task = self.copy("pair_ledger_ahead")
        self.assertEqual(self.mm("repair", "--task-dir", task, "--apply")[0], 0)
        doc = mm_ledger.load_ledger(task)
        self.assertEqual([r["id"] for r in doc["rows"]], ["#1", "#2", "#4", "#3"])
        imported = {d["qid"]: d for d in doc["decisions"] if d.get("status") == "IMPORTED"}
        self.assertEqual(sorted(imported), ["D2", "D3"])
        self.assertEqual(imported["D2"]["provenance"], "chat 2026-02-08")
        handoff = (task / "HANDOFF.md").read_text(encoding="utf-8")
        self.assertIn("### D2: Keep the screenshot path as the fallback", handoff)
        self.assertIn("Measure both paths on ten widgets", handoff)

    def test_rounds_list_becomes_the_rounds_object(self):
        task = self.copy("rounds_ledger_ahead")
        original = json.loads((task / "ledger.json").read_text(encoding="utf-8"))["rounds"]
        self.assertEqual(self.mm("repair", "--task-dir", task, "--apply")[0], 0)
        rounds = mm_ledger.load_ledger(task)["rounds"]
        self.assertEqual(rounds, {"max_rounds": 3, "rubric_sha256": "", "residual": [], "history": original})


class BackupAndRestoreTests(RepairCase):
    FROZEN = datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)

    def test_when_two_backups_land_in_the_same_second_the_first_is_kept(self):
        task = self.copy("needs_fix")
        with mock.patch.object(mm_repair, "_now", return_value=self.FROZEN):
            first = mm_repair.backup(task, {"ledger.json": b"first"}, "repair")
            second = mm_repair.backup(task, {"ledger.json": b"second"}, "repair")
        self.assertEqual(first.name, "20260102-030405-repair")
        self.assertNotEqual(first, second)
        self.assertEqual((first / "ledger.json").read_bytes(), b"first")
        self.assertEqual((second / "ledger.json").read_bytes(), b"second")
        self.assertEqual(mm_cli.BACKUP_DIR_RE.match(second.name).group(1), "repair")
        original = (task / "HANDOFF.md").read_bytes()
        one = mm_cli._backup(task, "compile", ["HANDOFF.md"], self.FROZEN)
        (task / "HANDOFF.md").write_bytes(b"changed\n")
        two = mm_cli._backup(task, "compile", ["HANDOFF.md"], self.FROZEN)
        self.assertNotEqual(one, two)
        self.assertEqual((one / "HANDOFF.md").read_bytes(), original)
        self.assertEqual((two / "HANDOFF.md").read_bytes(), b"changed\n")
        self.assertEqual(mm_cli.BACKUP_DIR_RE.match(two.name).group(1), "compile")

    def _fail_write_and_lock(self, task):
        ledger = task / "ledger.json"
        self.addCleanup(lambda: ledger.exists() and os.chmod(ledger, stat.S_IWRITE | stat.S_IREAD))

        def broken_write(folder, ledger_text, files):
            (folder / "ledger.json").write_bytes(ledger_text.encode("utf-8")[:40])
            os.chmod(folder / "ledger.json", stat.S_IREAD)
            raise RuntimeError("disk full")
        return broken_write

    def test_when_the_restore_itself_fails_repair_exits_18_and_never_claims_restored(self):
        task = self.copy("needs_fix")
        with mock.patch.object(mm_repair, "write_result", self._fail_write_and_lock(task)):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 18, output)
        self.assertNotIn("were restored", output)
        self.assertIn("restore failed", output)
        self.assertRegex(output, r"backups[/\\]\d{8}-\d{6}-repair")

    def test_when_restored_bytes_do_not_verify_repair_exits_18(self):
        task = self.copy("needs_fix")
        real = mm_atomic.atomic_write_bytes

        def corrupting(path, data, **kwargs):
            real(path, data[:-1], **kwargs)

        with mock.patch.object(mm_repair, "acceptable", return_value=False), \
                mock.patch.object(mm_atomic, "atomic_write_bytes", corrupting):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 18, output)
        self.assertNotIn("were restored", output)
        self.assertIn("did not verify", output)

    def test_when_the_restore_succeeds_it_says_restored_and_verified(self):
        task = self.copy("needs_fix")
        before = tree(task)
        with mock.patch.object(mm_repair, "write_result", side_effect=RuntimeError("disk full")):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 1, output)
        self.assertIn("restored and verified", output)
        after = tree(task)
        for name in ("ledger.json", "HANDOFF.md"):
            self.assertEqual(after[name], before[name])

    def test_when_the_dry_run_result_fails_check_it_exits_17_and_does_not_invite_apply(self):
        task = self.copy("needs_fix")
        before = tree(task)
        with mock.patch.object(mm_repair, "acceptable", return_value=False):
            rc, output = self.mm("repair", "--task-dir", task)
        self.assertEqual(rc, 17, output)
        self.assertNotIn("--apply", output)
        self.assertIn("NOT acceptable", output)
        self.assertEqual(tree(task), before)
        legacy = self.copy("legacy_task", FIXTURES / "legacy_task")
        with mock.patch.object(mm_repair, "acceptable", return_value=False):
            rc, output = self.mm("migrate", "--task-dir", legacy)
        self.assertEqual(rc, 17, output)
        self.assertNotIn("--apply", output)

    def test_when_another_writer_makes_a_file_the_backup_lacks_restore_leaves_it_and_names_it(self):
        racer = b"<!-- ROADMAP.html of another writer -->\n"
        real = mm_repair.write_result

        def create_then_fail(folder, *args, **kwargs):
            (folder / "ROADMAP.html").write_bytes(racer)
            raise RuntimeError("disk full")

        def write_then_change(folder, *args, **kwargs):
            real(folder, *args, **kwargs)
            (folder / "ROADMAP.html").write_bytes(racer)

        for label, write, acceptable, said in (
                ("created while the write failed", create_then_fail, True, UNRECORDED.format("ROADMAP.html")),
                ("changed after this run wrote it", write_then_change, False, CHANGED.format("ROADMAP.html"))):
            with self.subTest(case=label):
                shutil.rmtree(self.active / "needs-fix", ignore_errors=True)
                task = self.copy("needs_fix")
                before = tree(task)
                self.assertNotIn("ROADMAP.html", before)
                with mock.patch.object(mm_repair, "write_result", side_effect=write), \
                        mock.patch.object(mm_repair, "acceptable", return_value=acceptable):
                    rc, output = self.mm("repair", "--task-dir", task, "--apply")
                self.assertEqual(rc, 1, output)
                self.assertEqual((task / "ROADMAP.html").read_bytes(), racer)
                for name in ("ledger.json", "HANDOFF.md"):
                    self.assertEqual((task / name).read_bytes(), before[name])
                self.assertIn("restored and verified", output)
                self.assertIn(said, output)
                self.assertNotIn("not created by this run", output)

    def test_when_a_failed_repair_wrote_a_file_the_backup_lacks_restore_removes_it(self):
        task = self.copy("needs_fix")
        before = tree(task)
        with mock.patch.object(mm_repair, "acceptable", return_value=False):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 1, output)
        self.assertFalse((task / "ROADMAP.html").exists())
        self.assertEqual({k: v for k, v in tree(task).items() if not k.startswith("backups/")}, before)
        self.assertIn("restored and verified", output)
        self.assertNotIn("not created by this run", output)
        self.assertNotIn("left in place", output)

    def test_restore_removes_a_file_only_while_it_still_matches_what_this_run_wrote(self):
        folder = self.tmp / "restore-unit"
        folder.mkdir()
        (folder / "ledger.json").write_bytes(b"{}\n")
        data = mm_repair.read_folder(folder)
        backup = mm_repair.backup(folder, data, "repair")
        with mm_atomic.journal() as created:
            mm_atomic.atomic_write_many([(folder / "ROADMAP.html", "this run\n"),
                                         (folder / "HANDOFF-archive.md", "this run\n")])
        (folder / "HANDOFF-archive.md").write_bytes(b"another writer\n")
        (folder / "HANDOFF.md").write_bytes(b"another writer\n")
        left = mm_repair.restore(folder, data, backup, created=created)
        self.assertEqual(left, [("HANDOFF.md", "unrecorded"), ("HANDOFF-archive.md", "changed")])
        self.assertFalse((folder / "ROADMAP.html").exists())
        self.assertEqual((folder / "HANDOFF-archive.md").read_bytes(), b"another writer\n")
        self.assertEqual((folder / "HANDOFF.md").read_bytes(), b"another writer\n")
        self.assertEqual((folder / "ledger.json").read_bytes(), b"{}\n")
        (folder / "ROADMAP.html").write_bytes(b"another writer\n")
        self.assertEqual(mm_repair.restore(folder, data, backup), [("HANDOFF.md", "unrecorded"),
                                                                    ("HANDOFF-archive.md", "unrecorded"),
                                                                    ("ROADMAP.html", "unrecorded")])
        self.assertTrue((folder / "ROADMAP.html").exists())

    def test_when_a_rollback_cannot_remove_a_file_this_run_created_restore_still_removes_it(self):
        folder = self.tmp / "rollback-unit"
        folder.mkdir()
        (folder / "ledger.json").write_bytes(b"{}\n")
        (folder / "HANDOFF.md").write_bytes(b"original\n")
        data = mm_repair.read_folder(folder)
        backup = mm_repair.backup(folder, data, "repair")
        created_path, failing_path = folder / "ROADMAP.html", folder / "HANDOFF.md"
        real_replace, real_unlink = os.replace, pathlib.Path.unlink

        def replace_spy(src, dst, *args, **kwargs):
            if pathlib.Path(dst) == failing_path:
                raise OSError(errno.EIO, "simulated replace failure")
            return real_replace(src, dst, *args, **kwargs)

        def unlink_spy(path, *args, **kwargs):
            if path == created_path:
                raise PermissionError("simulated sharing violation")
            return real_unlink(path, *args, **kwargs)

        with mm_atomic.journal() as created:
            with mock.patch("os.replace", side_effect=replace_spy), \
                    mock.patch.object(pathlib.Path, "unlink", unlink_spy):
                with self.assertRaises(mm_atomic.AtomicWriteError):
                    mm_atomic.atomic_write_many([(created_path, "this run\n"), (failing_path, "this run\n")])
        self.assertTrue(created_path.exists())
        self.assertEqual(failing_path.read_bytes(), b"original\n")
        self.assertEqual(mm_repair.restore(folder, data, backup, created=created), [])
        self.assertFalse(created_path.exists())
        self.assertEqual(failing_path.read_bytes(), b"original\n")
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["HANDOFF.md", "backups", "ledger.json"])

    def test_when_the_platform_gives_no_file_id_restore_leaves_a_file_this_run_wrote_and_names_it(self):
        task = self.copy("needs_fix")
        real_fstat = os.fstat

        class NoFileId:
            st_dev = 0
            st_ino = 0

            def __init__(self, st):
                self.st = st

            def __getattr__(self, name):
                return getattr(self.st, name)

        with mock.patch.object(mm_repair, "acceptable", return_value=False), \
                mock.patch("os.fstat", side_effect=lambda fd: NoFileId(real_fstat(fd))):
            rc, output = self.mm("repair", "--task-dir", task, "--apply")
        self.assertEqual(rc, 1, output)
        self.assertTrue((task / "ROADMAP.html").exists())
        self.assertIn("restored and verified", output)
        self.assertIn(UNPROVEN.format("ROADMAP.html"), output)

    def test_when_another_writer_creates_a_file_the_backup_lacks_before_the_write_it_is_never_overwritten(self):
        racer = b"<!-- ROADMAP.html of another writer -->\n"
        real_write, real_stage = mm_repair.write_result, mm_atomic._stage_text

        def appear(task):
            if not (task / "ROADMAP.html").exists():
                (task / "ROADMAP.html").write_bytes(racer)

        def before_the_write(folder, *args, **kwargs):
            appear(folder)
            return real_write(folder, *args, **kwargs)

        def while_staging(tmp, *args, **kwargs):
            if pathlib.Path(tmp).name.startswith("ROADMAP.html.tmp-"):
                appear(pathlib.Path(tmp).parent)
            return real_stage(tmp, *args, **kwargs)

        for label, patcher in (("after the backup", lambda: mock.patch.object(mm_repair, "write_result",
                                                                               side_effect=before_the_write)),
                               ("while its temp file is staged", lambda: mock.patch.object(
                                   mm_atomic, "_stage_text", side_effect=while_staging))):
            with self.subTest(racer=label):
                shutil.rmtree(self.active / "needs-fix", ignore_errors=True)
                task = self.copy("needs_fix")
                before = tree(task)
                with patcher():
                    rc, output = self.mm("repair", "--task-dir", task, "--apply")
                self.assertEqual(rc, 1, output)
                self.assertEqual((task / "ROADMAP.html").read_bytes(), racer)
                for name in ("ledger.json", "HANDOFF.md"):
                    self.assertEqual((task / name).read_bytes(), before[name])
                self.assertIn("appeared after the backup", output)
                self.assertIn("restored and verified", output)
                self.assertIn(UNRECORDED.format("ROADMAP.html"), output)
                self.assertEqual([p.name for p in task.iterdir() if ".tmp-" in p.name], [])


class MigrateWrapperTests(RepairCase):
    def test_migrate_dry_run_on_legacy_fixture_exits_14_and_writes_nothing(self):
        task = self.copy("legacy_task", FIXTURES / "legacy_task")
        before = tree(task)
        rc, output = self.mm("migrate", "--task-dir", task)
        self.assertEqual(rc, 14, output)
        self.assertIn("+++ b/ledger.json", output)
        self.assertIn("--- a/HANDOFF.md", output)
        self.assertEqual(tree(task), before)

    def test_migrate_apply_converts_legacy_fixture_to_valid_ledger_with_header(self):
        task = self.copy("legacy_task", FIXTURES / "legacy_task")
        original = (task / "HANDOFF.md").read_bytes()
        rc, output = self.mm("migrate", "--task-dir", task, "--apply")
        self.assertEqual(rc, 0, output)
        doc = mm_ledger.load_ledger(task)
        self.assertEqual([r["id"] for r in doc["rows"]], ["#1", "#2", "#3", "#4", "#5"])
        self.assertTrue((task / "HANDOFF.md").read_text(encoding="utf-8").startswith(mm_compile.GENERATED_HEADER))
        self.assertEqual(self.mm("check", "--task-dir", task)[0], 0)
        backups = [d for d in (task / "backups").iterdir() if re.match(r"^\d{8}-\d{6}-migrate$", d.name)]
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "HANDOFF.md").read_bytes(), original)
        self.assertFalse((task / "HANDOFF.pre-migration.md").exists())

    def test_migrate_on_a_ledger_folder_names_mm_repair(self):
        task = self.copy("needs_fix")
        rc, output = self.mm("migrate", "--task-dir", task, "--apply")
        self.assertEqual(rc, 11, output)
        self.assertIn("/mm repair", output)
        task = self.active / "clean-task"
        self.assertEqual(self.mm("scaffold", "--task-dir", task, "--task", "clean-task", "--project", "p")[0], 0)
        rc, output = self.mm("migrate", "--task-dir", task)
        self.assertEqual(rc, 4, output)
        self.assertIn("/mm repair", output)

    def test_when_migrate_apply_fails_restore_removes_its_own_ledger_and_keeps_another_writers_file(self):
        task = self.copy("legacy_task", FIXTURES / "legacy_task")
        original = (task / "HANDOFF.md").read_bytes()
        racer = b"<!-- ROADMAP.html of another writer -->\n"

        def create_then_fail(path, text):
            (task / "ROADMAP.html").write_bytes(racer)
            return OSError("simulated")

        with mock.patch("mm_migrate._write_handoff", side_effect=create_then_fail):
            rc, output = self.mm("migrate", "--task-dir", task, "--apply")
        self.assertEqual(rc, 1, output)
        self.assertFalse((task / "ledger.json").exists())
        self.assertEqual((task / "ROADMAP.html").read_bytes(), racer)
        self.assertEqual((task / "HANDOFF.md").read_bytes(), original)
        self.assertIn("restored and verified", output)
        self.assertIn(UNRECORDED.format("ROADMAP.html"), output)
        self.assertNotIn("ledger.json is not in the backup", output)

    def test_when_another_writer_creates_a_file_before_migrate_writes_it_it_is_never_overwritten(self):
        task = self.copy("legacy_task", FIXTURES / "legacy_task")
        original = (task / "HANDOFF.md").read_bytes()
        racer = b"<!-- ROADMAP.html of another writer -->\n"
        real_record = mm_compile.record_compile

        def after_the_checks(*args, **kwargs):
            (task / "ROADMAP.html").write_bytes(racer)
            return real_record(*args, **kwargs)

        with mock.patch("mm_compile.record_compile", side_effect=after_the_checks):
            rc, output = self.mm("migrate", "--task-dir", task, "--apply")
        self.assertEqual(rc, 1, output)
        self.assertEqual((task / "ROADMAP.html").read_bytes(), racer)
        self.assertFalse((task / "ledger.json").exists())
        self.assertEqual((task / "HANDOFF.md").read_bytes(), original)
        self.assertIn("appeared after the backup", output)
        self.assertIn("restored and verified", output)
        self.assertIn(UNRECORDED.format("ROADMAP.html"), output)
        self.assertEqual([p.name for p in task.iterdir() if ".tmp-" in p.name], [])


if __name__ == "__main__":
    unittest.main()
