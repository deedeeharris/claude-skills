import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import json
import os
import shutil
import tempfile
import time
import unittest

import mm_ledger


class LedgerSaveLoadTests(unittest.TestCase):
    def setUp(self):
        self.task_dir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.task_dir, ignore_errors=True)

    def test_round_trips_unknown_keys(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["some_future_field"] = {"nested": "value"}

        saved = mm_ledger.save_ledger(
            self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
        )
        self.assertEqual(saved["some_future_field"], {"nested": "value"})
        self.assertEqual(saved["revision"], doc["revision"] + 1)

        loaded = mm_ledger.load_ledger(self.task_dir)
        self.assertEqual(loaded["some_future_field"], {"nested": "value"})
        self.assertEqual(loaded["revision"], saved["revision"])
        self.assertEqual(loaded["task"], "demo-task")

    def test_stale_expected_revision_raises_revision_conflict(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        mm_ledger.save_ledger(
            self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
        )

        with self.assertRaises(mm_ledger.RevisionConflict):
            mm_ledger.save_ledger(
                self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
            )

    def test_is_migrated_reflects_ledger_presence(self):
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        mm_ledger.save_ledger(
            self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
        )
        self.assertTrue(mm_ledger.is_migrated(self.task_dir))

    def test_stale_lock_with_confirmed_dead_pid_is_reclaimed(self):
        # A lock file left behind by a crashed process must not permanently
        # block every future save. "Crashed" is proven here the same way the
        # OS proves it to us: OpenProcess on this pid fails with
        # ERROR_INVALID_PARAMETER (verified empirically on Windows), i.e. the pid plainly does not
        # exist. That is the ONLY case old + reclaim is allowed to fire.
        lock_path = self.task_dir / "ledger.lock"
        dead_identity = {"pid": 999999999, "start_time": 123456789}
        lock_path.write_bytes(json.dumps(dead_identity).encode("utf-8"))
        old_time = time.time() - (mm_ledger._STALE_LOCK_AGE_S + 5)
        os.utime(lock_path, (old_time, old_time))

        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        saved = mm_ledger.save_ledger(
            self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
        )
        self.assertEqual(saved["revision"], doc["revision"] + 1)

    def test_stale_but_live_lock_is_not_stolen(self):
        # RED case for the defect: an OLD lock whose holder is still alive
        # (same pid, same process-start-time -- this test process itself)
        # must NOT be reclaimed just because it is past the age threshold.
        # Before the fix this raced straight past the age check and stole
        # the lock out from under a live, merely-slow holder -- a lost
        # update. Now it must refuse and eventually time out.
        lock_path = self.task_dir / "ledger.lock"
        live_identity = {"pid": os.getpid(), "start_time": mm_ledger._process_start_time(os.getpid())}
        self.assertIsNot(live_identity["start_time"], mm_ledger._PID_DEAD)
        self.assertIsNotNone(live_identity["start_time"])
        lock_path.write_bytes(json.dumps(live_identity).encode("utf-8"))
        old_time = time.time() - (mm_ledger._STALE_LOCK_AGE_S + 5)
        os.utime(lock_path, (old_time, old_time))

        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        with self.assertRaises(mm_ledger.LockTimeout):
            mm_ledger.save_ledger(
                self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
            )
        # And the lock file survives untouched -- it was never stolen.
        self.assertTrue(lock_path.is_file())

    def test_stale_lock_without_identity_is_not_blindly_stolen(self):
        # RED case for the original defect itself: an old lock with no
        # readable identity (predates identity-tagging, or corrupted) is
        # exactly the "cannot tell" case. Age alone used to be enough to
        # reclaim it; now "cannot tell" must mean "assume live, refuse".
        lock_path = self.task_dir / "ledger.lock"
        lock_path.write_bytes(b"")
        old_time = time.time() - (mm_ledger._STALE_LOCK_AGE_S + 5)
        os.utime(lock_path, (old_time, old_time))

        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        with self.assertRaises(mm_ledger.LockTimeout):
            mm_ledger.save_ledger(
                self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
            )


class LedgerStateMachineTests(unittest.TestCase):
    def _row(self, state="BACKLOG"):
        return {
            "id": "#1",
            "item": "x",
            "state": state,
            "blocked": False,
            "blocked_reason": "",
            "status_label": "",
            "owner": "agent",
            "target_date": "",
            "notes_md": "",
            "is_wrapup": False,
            "history": [],
        }

    def test_illegal_transition_raises(self):
        doc = {"rows": [self._row("BACKLOG")]}
        with self.assertRaises(mm_ledger.EvidenceRequired) as ctx:
            mm_ledger.set_row_state(doc, "#1", "DONE", by="test")
        self.assertIsInstance(ctx.exception, mm_ledger.IllegalTransition)
        self.assertEqual(doc["rows"][0]["state"], "BACKLOG")

    def test_legal_transition_appends_history(self):
        doc = {"rows": [self._row("BACKLOG")]}
        mm_ledger.set_row_state(doc, "#1", "IMPLEMENTING", by="test", note="starting")

        row = doc["rows"][0]
        self.assertEqual(row["state"], "IMPLEMENTING")
        self.assertEqual(len(row["history"]), 1)
        self.assertEqual(row["history"][0]["from"], "BACKLOG")
        self.assertEqual(row["history"][0]["to"], "IMPLEMENTING")
        self.assertEqual(row["history"][0]["by"], "test")

    def test_same_state_transition_is_idempotent_noop(self):
        doc = {"rows": [self._row("IMPLEMENTING")]}
        mm_ledger.set_row_state(doc, "#1", "IMPLEMENTING", by="test")
        self.assertEqual(doc["rows"][0]["state"], "IMPLEMENTING")
        self.assertEqual(doc["rows"][0]["history"], [])

        # A retried no-op call must not duplicate history entries either.
        mm_ledger.set_row_state(doc, "#1", "IMPLEMENTING", by="test")
        self.assertEqual(doc["rows"][0]["history"], [])

    def test_terminal_done_only_reopens_to_implementing(self):
        doc = {"rows": [self._row("DONE")]}
        with self.assertRaises(mm_ledger.IllegalTransition):
            mm_ledger.set_row_state(doc, "#1", "REVIEW", by="test")
        mm_ledger.set_row_state(doc, "#1", "IMPLEMENTING", by="test")
        self.assertEqual(doc["rows"][0]["state"], "IMPLEMENTING")

    def test_needs_decision_without_blocked_true_is_rejected(self):
        # RED case: moving into NEEDS_DECISION without saying blocked=True
        # used to succeed and silently leave an unrepresentable pair (state
        # NEEDS_DECISION rendering as the plain yellow glyph, not red).
        doc = {"rows": [self._row("BACKLOG")]}
        with self.assertRaises(mm_ledger.IllegalStateBlockedCombo):
            mm_ledger.set_row_state(doc, "#1", "NEEDS_DECISION", by="test")
        # And nothing was mutated on the rejected attempt.
        self.assertEqual(doc["rows"][0]["state"], "BACKLOG")

    def test_needs_decision_with_blocked_true_is_accepted(self):
        # GREEN case: the one representable shape for NEEDS_DECISION.
        doc = {"rows": [self._row("BACKLOG")]}
        mm_ledger.set_row_state(doc, "#1", "NEEDS_DECISION", by="test", blocked=True)
        self.assertEqual(doc["rows"][0]["state"], "NEEDS_DECISION")
        self.assertTrue(doc["rows"][0]["blocked"])

    def test_leaving_needs_decision_without_clearing_blocked_is_rejected(self):
        # RED case: unblocking must explicitly clear `blocked`, or the row
        # ends up IMPLEMENTING+blocked=True -- also unrepresentable (it would
        # render red, and re-parsing red always yields NEEDS_DECISION).
        doc = {"rows": [self._row("NEEDS_DECISION")]}
        doc["rows"][0]["blocked"] = True
        with self.assertRaises(mm_ledger.IllegalStateBlockedCombo):
            mm_ledger.set_row_state(doc, "#1", "IMPLEMENTING", by="test")
        self.assertEqual(doc["rows"][0]["state"], "NEEDS_DECISION")

    def test_leaving_needs_decision_with_blocked_false_is_accepted(self):
        # GREEN case: unblocking is legal once `blocked` is explicitly cleared.
        doc = {"rows": [self._row("NEEDS_DECISION")]}
        doc["rows"][0]["blocked"] = True
        mm_ledger.set_row_state(doc, "#1", "IMPLEMENTING", by="test", blocked=False)
        self.assertEqual(doc["rows"][0]["state"], "IMPLEMENTING")
        self.assertFalse(doc["rows"][0]["blocked"])


class LedgerEvidenceRuleTests(unittest.TestCase):
    def _doc(self, *rows):
        base = {"item": "x", "blocked": False, "blocked_reason": "", "status_label": "", "owner": "",
                "target_date": "", "notes_md": "", "is_wrapup": False, "history": []}
        return {"rows": [dict(base, **r) for r in rows]}

    def test_backlog_to_done_with_passing_cmd_evidence_is_allowed_and_recorded(self):
        doc = self._doc({"id": "#1", "state": "BACKLOG"})
        mm_ledger.set_row_state(doc, "#1", "DONE", by="t", evidence="cmd:python -m unittest exit:0")
        row = doc["rows"][0]
        self.assertEqual(row["state"], "DONE")
        self.assertEqual(row["history"][-1]["evidence"], "cmd:python -m unittest exit:0")
        self.assertEqual(row["status_label"], "Done")

    def test_cmd_evidence_with_nonzero_exit_is_refused(self):
        doc = self._doc({"id": "#1", "state": "REVIEW"})
        with self.assertRaises(mm_ledger.EvidenceRefused):
            mm_ledger.set_row_state(doc, "#1", "DONE", by="t", evidence="cmd:pytest exit:1")
        self.assertEqual(doc["rows"][0]["state"], "REVIEW")

    def test_agent_claim_without_evidence_prefix_is_refused(self):
        doc = self._doc({"id": "#1", "state": "REVIEW"})
        with self.assertRaises(mm_ledger.EvidenceRefused):
            mm_ledger.set_row_state(doc, "#1", "DONE", by="t", evidence="the agent says it passed")

    def test_user_facing_row_reaches_done_only_through_human_verified(self):
        doc = self._doc({"id": "#1", "state": "IMPLEMENTING", "user_facing": True})
        with self.assertRaises(mm_ledger.IllegalTransition):
            mm_ledger.set_row_state(doc, "#1", "DONE", by="t", evidence="cmd:check exit:0")
        with self.assertRaises(mm_ledger.EvidenceRequired):
            mm_ledger.set_row_state(doc, "#1", "HUMAN_VERIFIED", by="t", evidence="cmd:check exit:0")
        mm_ledger.set_row_state(doc, "#1", "HUMAN_VERIFIED", by="t", evidence="human:Test Operator")
        mm_ledger.set_row_state(doc, "#1", "DONE", by="t")
        self.assertEqual(doc["rows"][0]["state"], "DONE")

    def test_abandoned_needs_a_reason(self):
        doc = self._doc({"id": "#1", "state": "BACKLOG"})
        with self.assertRaises(mm_ledger.ReasonRequired):
            mm_ledger.set_row_state(doc, "#1", "ABANDONED", by="t")
        mm_ledger.set_row_state(doc, "#1", "ABANDONED", by="t", reason="dropped")
        self.assertEqual(doc["rows"][0]["history"][-1]["reason"], "dropped")

    def test_wrapup_row_waits_for_every_other_row(self):
        doc = self._doc({"id": "#1", "state": "IMPLEMENTING"},
                        {"id": "#2", "state": "BACKLOG", "is_wrapup": True})
        with self.assertRaises(mm_ledger.IllegalTransition):
            mm_ledger.set_row_state(doc, "#2", "DONE", by="t", evidence="human:Test Operator")
        mm_ledger.set_row_state(doc, "#1", "ABANDONED", by="t", reason="out of scope")
        mm_ledger.set_row_state(doc, "#2", "DONE", by="t", evidence="human:Test Operator")
        self.assertEqual(doc["rows"][1]["state"], "DONE")

    def test_run_by_mm_evidence_is_accepted(self):
        doc = self._doc({"id": "#1", "state": "IMPLEMENTING"})
        mm_ledger.set_row_state(doc, "#1", "DONE", by="t", evidence="run by mm: python -c pass exit:0")
        self.assertEqual(doc["rows"][0]["state"], "DONE")

    def test_when_a_recorded_move_lacks_a_from_or_to_state_the_walk_never_accepts_it(self):
        at = "2026-01-01T00:00:00+00:00"
        doc = self._doc(
            {"id": "#1", "state": "DONE", "history": [
                {"at": at, "by": "migrate", "to": None},
                {"at": at, "from": None, "to": "DONE", "by": "someone", "evidence": "cmd:t exit:0"}]},
            {"id": "#2", "state": "IMPLEMENTING", "history": [
                {"at": at, "from": "BACKLOG", "to": None, "by": "mm.py repair"},
                {"at": at, "to": "IMPLEMENTING", "by": "someone"}]},
            {"id": "#3", "state": "REVIEW", "history": [
                {"at": at, "from": "BACKLOG", "to": "IMPLEMENTING", "by": "someone"},
                {"at": at, "from": "IMPLEMENTING", "by": "someone"},
                {"at": at, "from": "IMPLEMENTING", "to": "REVIEW", "by": "someone"}]})
        self.assertEqual([(rid, code) for rid, code, _ in mm_ledger.history_problems(doc)],
                         [("#1", "HISTORY-BROKEN"), ("#2", "HISTORY-BROKEN"), ("#3", "HISTORY-BROKEN")])


class LedgerLockTests(unittest.TestCase):
    def test_held_lock_lets_save_ledger_write_without_relocking(self):
        task_dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, task_dir, True)
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        with mm_ledger.hold_lock(task_dir):
            self.assertTrue((task_dir / "ledger.lock").is_file())
            saved = mm_ledger.save_ledger(task_dir, doc, expected_revision=0, updated_by="t", lock_held=True)
        self.assertEqual(saved["revision"], 1)
        self.assertFalse((task_dir / "ledger.lock").exists())

    def test_optional_fields_are_type_checked(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["rows"] = [{
            "id": "#1", "item": "x", "state": "BACKLOG", "blocked": False, "blocked_reason": "",
            "status_label": "", "owner": "", "target_date": "", "notes_md": "", "is_wrapup": False,
            "history": [], "user_facing": "yes", "test_level": "smoke",
        }]
        with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
            mm_ledger.validate_ledger(doc)
        self.assertIn("user_facing", str(ctx.exception))
        self.assertIn("test_level", str(ctx.exception))


class LedgerSchemaValidationTests(unittest.TestCase):
    def setUp(self):
        self.task_dir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.task_dir, ignore_errors=True)

    def test_valid_ledger_passes(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        mm_ledger.validate_ledger(doc)  # must not raise

    def test_missing_required_top_level_key_is_rejected(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        del doc["passthrough"]
        with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
            mm_ledger.validate_ledger(doc)
        self.assertIn("passthrough", str(ctx.exception))

    def test_wrong_type_for_revision_is_rejected(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["revision"] = "0"
        with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
            mm_ledger.validate_ledger(doc)
        self.assertIn("revision", str(ctx.exception))
        self.assertIn("int", str(ctx.exception))

    def test_bool_masquerading_as_revision_int_is_rejected(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["revision"] = True
        with self.assertRaises(mm_ledger.LedgerValidationError):
            mm_ledger.validate_ledger(doc)

    def test_bad_state_enum_value_is_rejected(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["rows"] = [{
            "id": "#1", "item": "x", "state": "MADE_UP_STATE", "blocked": False,
            "blocked_reason": "", "status_label": "", "owner": "", "target_date": "",
            "notes_md": "", "is_wrapup": False, "history": [],
        }]
        with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
            mm_ledger.validate_ledger(doc)
        self.assertIn("MADE_UP_STATE", str(ctx.exception))

    def test_duplicate_row_id_is_rejected(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        row = {
            "id": "#1", "item": "x", "state": "BACKLOG", "blocked": False,
            "blocked_reason": "", "status_label": "", "owner": "", "target_date": "",
            "notes_md": "", "is_wrapup": False, "history": [],
        }
        doc["rows"] = [dict(row), dict(row)]
        with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
            mm_ledger.validate_ledger(doc)
        self.assertIn("duplicates", str(ctx.exception))

    def test_illegal_state_blocked_pair_is_rejected(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["rows"] = [{
            "id": "#1", "item": "x", "state": "NEEDS_DECISION", "blocked": False,
            "blocked_reason": "", "status_label": "", "owner": "", "target_date": "",
            "notes_md": "", "is_wrapup": False, "history": [],
        }]
        with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
            mm_ledger.validate_ledger(doc)
        self.assertIn("unrepresentable pair", str(ctx.exception))

    def test_missing_required_row_key_is_rejected_with_location(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["rows"] = [{"id": "#1", "item": "x"}]
        with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
            mm_ledger.validate_ledger(doc)
        self.assertIn("rows[0]", str(ctx.exception))
        self.assertIn("state", str(ctx.exception))

    def test_unknown_top_level_and_row_keys_are_preserved_not_stripped(self):
        # Schema validation must never destroy an unmodelled passthrough
        # region -- it only checks the keys it knows about.
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["rows"] = [{
            "id": "#1", "item": "x", "state": "BACKLOG", "blocked": False,
            "blocked_reason": "", "status_label": "", "owner": "", "target_date": "",
            "notes_md": "", "is_wrapup": False, "history": [],
            "future_row_field": "unmodelled-blob",
        }]
        doc["future_top_level_field"] = "also-unmodelled"
        mm_ledger.validate_ledger(doc)  # must not raise

        saved = mm_ledger.save_ledger(
            self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
        )
        self.assertEqual(saved["future_top_level_field"], "also-unmodelled")
        self.assertEqual(saved["rows"][0]["future_row_field"], "unmodelled-blob")

        loaded = mm_ledger.load_ledger(self.task_dir)
        self.assertEqual(loaded["future_top_level_field"], "also-unmodelled")
        self.assertEqual(loaded["rows"][0]["future_row_field"], "unmodelled-blob")

    def test_invalid_ledger_on_disk_is_rejected_on_load(self):
        (self.task_dir / "ledger.json").write_text('{"not": "a ledger"}', encoding="utf-8")
        with self.assertRaises(mm_ledger.LedgerValidationError):
            mm_ledger.load_ledger(self.task_dir)

    def test_save_ledger_refuses_to_write_an_invalid_doc(self):
        doc = mm_ledger.new_ledger("demo-task", "smoke-project")
        doc["rows"] = [{
            "id": "#1", "item": "x", "state": "NOT_A_STATE", "blocked": False,
            "blocked_reason": "", "status_label": "", "owner": "", "target_date": "",
            "notes_md": "", "is_wrapup": False, "history": [],
        }]
        with self.assertRaises(mm_ledger.LedgerValidationError):
            mm_ledger.save_ledger(
                self.task_dir, doc, expected_revision=doc["revision"], updated_by="test"
            )
        # Nothing was written -- the ledger file must not exist.
        self.assertFalse((self.task_dir / "ledger.json").is_file())


class GlyphRoundTripTests(unittest.TestCase):
    def test_every_glyph_round_trips(self):
        for glyph, (state, blocked) in mm_ledger.GLYPH_TO_STATE.items():
            got = mm_ledger.state_to_glyph(state, blocked)
            self.assertEqual(got, glyph, f"{glyph!r} -> {state}/{blocked} -> {got!r}")

    def test_red_glyph_is_needs_decision_blocked_true(self):
        state, blocked = mm_ledger.GLYPH_TO_STATE["\U0001f534"]
        self.assertEqual(state, "NEEDS_DECISION")
        self.assertTrue(blocked)
        self.assertEqual(mm_ledger.state_to_glyph(state, blocked), "\U0001f534")


if __name__ == "__main__":
    unittest.main()
