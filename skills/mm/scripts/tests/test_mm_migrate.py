import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import contextlib

import fixture
import mm
import mm_atomic
import mm_compile
import mm_ledger
import mm_migrate


def _task_dir(root):
    return root / ".private" / "pm" / "active" / "demo-task"


# Genuine, CURRENT content loss (not a stale byte-exact assumption): Section
# 1's header-guard (`cells[0].lower() == "id"`) treats ANY row whose ID cell
# literally reads "id" (case-insensitive) as a repeated table header and
# silently drops it from parse_handoff's row list -- verified empirically
# against the real, unmodified mm_compile.py. The dropped row's whole line
# (including its status-glyph emoji) never reaches the recompiled output.
_ROW_DROP_MANGLE = (
    "| #2 | Implement atomic writer | \U0001f7e1 **IN PROGRESS** | agent | 2026-08-10 | temp file beside dest |",
    "| #2 | Implement atomic writer | \U0001f7e1 **IN PROGRESS** | agent | 2026-08-10 | temp file beside dest |\n"
    "| id | Duplicate-looking row that is actually real data | \U0001f7e1 **SHOULD SURVIVE** | agent | 2026-08-11 | must not vanish |",
)


def _snapshot(task_dir: pathlib.Path):
    entries = {}
    for path in task_dir.rglob("*"):
        if path.is_file():
            stat = path.stat()
            entries[str(path)] = (stat.st_mtime_ns, path.read_bytes())
    return entries


class MigrateDryRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dry_run_writes_zero_files(self):
        before = _snapshot(self.task_dir)
        before_listing = sorted(str(p) for p in self.task_dir.rglob("*"))

        rc = mm_migrate.main(["--task-dir", str(self.task_dir)])

        self.assertEqual(rc, 5)
        after = _snapshot(self.task_dir)
        after_listing = sorted(str(p) for p in self.task_dir.rglob("*"))
        self.assertEqual(before_listing, after_listing)
        self.assertEqual(before, after)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))

    def test_section_1_preamble_and_postamble_survive_migration(self):
        # Real bug found (this round) while dry-running mm_migrate against
        # every real folder under .private/pm/active: _build_doc built
        # doc["passthrough"] without section_1_preamble_md/postamble_md, so
        # any HANDOFF with free prose before/after the Section 1 table (a
        # status narrative, a sub-heading -- real shape, seen on
        # a real analytics task) lost that prose silently on
        # migration. This is exactly the class of defect DECISION 1's
        # completeness gate exists to catch -- it did, correctly, refusing
        # with rc=2. Fixed in _build_doc; this pins the fix.
        mangled = fixture.HANDOFF_BODY.replace(
            "## Section 1 Status\n\n| ID |",
            "## Section 1 Status\n\n### Where things stand\nImplementation narrative that must survive.\n\n| ID |",
        ).replace(
            "| #5 | Wrap up: insights review + move to done/ | ⚪ Not started | PM | not scheduled | last item — closing ritual |\n\n---",
            "| #5 | Wrap up: insights review + move to done/ | ⚪ Not started | PM | not scheduled | last item — closing ritual |\n\n"
            "Trailing note after the table that must also survive.\n\n---",
        )
        self.assertNotEqual(mangled, fixture.HANDOFF_BODY)
        (self.task_dir / "HANDOFF.md").write_text(mangled, encoding="utf-8", newline="\n")

        rc = mm_migrate.main(["--task-dir", str(self.task_dir)])

        self.assertEqual(rc, 5)


class MigrateApplyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)
        self.original_text = (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_apply_creates_backup_pre_migration_and_ledger(self):
        # DECISION 2 (this round): no more two-file transaction, and no more
        # whole-folder timestamped copytree backup either -- the contract's
        # step 1 is "write HANDOFF.pre-migration.md if it does not already
        # exist", nothing heavier. The ledger is the durable authority; the
        # pre-migration copy is what a human recovers from if they ever need
        # the pre-migration original.
        rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        self.assertEqual(rc, 0)

        self.assertTrue(mm_ledger.is_migrated(self.task_dir))

        pre_migration = self.task_dir / "HANDOFF.pre-migration.md"
        self.assertTrue(pre_migration.is_file())
        self.assertEqual(pre_migration.read_text(encoding="utf-8"), self.original_text)

        recompiled = (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8")
        self.assertTrue(recompiled.startswith(mm_compile.GENERATED_HEADER + "\n"))
        self.assertTrue(mm_compile.semantic_equal(mm_compile.strip_generated_header(recompiled),
                                                  pre_migration.read_text(encoding="utf-8")))

    def test_second_apply_is_byte_for_byte_noop(self):
        rc1 = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        self.assertEqual(rc1, 0)

        before = _snapshot(self.task_dir)
        before_listing = sorted(str(p) for p in self.task_dir.parent.rglob("*"))

        rc2 = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        self.assertEqual(rc2, 4)

        after = _snapshot(self.task_dir)
        after_listing = sorted(str(p) for p in self.task_dir.parent.rglob("*"))
        self.assertEqual(before_listing, after_listing)
        self.assertEqual(before, after)


class MigrateRoundTripRefusalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_mangled_handoff_that_cannot_round_trip_exits_2_and_writes_nothing(self):
        # STALE FIXTURE, rebuilt (this round): the old mangle added an extra
        # decision field interleaved with the canonical ones -- that is
        # exactly what mm_compile's body_lines passthrough is DESIGNED to
        # preserve (SHARED INVARIANT 1: operator-invented extra fields
        # round-trip verbatim in original order), so it became representable
        # once the compiler grew that robustness and this test started
        # failing for the wrong reason: the tool now correctly PROCEEDS on
        # input the test claimed was unrepresentable.
        #
        # DECISION 1's bar is CONTENT-COMPLETE, not byte-exact, so the
        # correct red case is no longer "any formatting mismatch" -- it is
        # genuine CONTENT LOSS: a line present in the original that is
        # nowhere in the recompiled output. _ROW_DROP_MANGLE is exactly that,
        # verified against today's real mm_compile.py (see its comment).
        mangled = fixture.HANDOFF_BODY.replace(*_ROW_DROP_MANGLE)
        self.assertNotEqual(mangled, fixture.HANDOFF_BODY)
        (self.task_dir / "HANDOFF.md").write_text(mangled, encoding="utf-8", newline="\n")

        before_listing = sorted(str(p) for p in self.task_dir.rglob("*"))

        rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])

        self.assertEqual(rc, 2)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        after_listing = sorted(str(p) for p in self.task_dir.rglob("*"))
        self.assertEqual(before_listing, after_listing)

    def test_no_section_0a_exits_3(self):
        mangled = fixture.HANDOFF_BODY.replace(
            "## Section 0A Dashboard Index", "## Section 0 Session opener (legacy)"
        )
        (self.task_dir / "HANDOFF.md").write_text(mangled, encoding="utf-8", newline="\n")

        before_listing = sorted(str(p) for p in self.task_dir.rglob("*"))

        rc = mm_migrate.main(["--task-dir", str(self.task_dir)])

        self.assertEqual(rc, 3)
        after_listing = sorted(str(p) for p in self.task_dir.rglob("*"))
        self.assertEqual(before_listing, after_listing)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))


class MigrateAlreadyMigratedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_third_run_reports_already_migrated(self):
        mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        self.assertEqual(rc, 4)
        self.assertTrue(mm_ledger.is_migrated(self.task_dir))


class MigrateIndependentWriteFailureTests(unittest.TestCase):
    """DECISION 2 (this round): no more two-file transaction. ledger.json and
    HANDOFF.md are now two INDEPENDENT atomic writes (mm_atomic.atomic_write_text,
    single temp-beside-dest + fsync + os.replace each) -- the ledger is the
    only authority; HANDOFF.md is a regenerable derived view of it, so it
    does not need to be transactional with its source. Each write's failure
    gets its own exit code and its own recovery story."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)
        self.original_text = (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ledger_write_failure_leaves_nothing_new_and_returns_6(self):
        real_write = mm_atomic.atomic_write_text

        def flaky_write(path, text, **kwargs):
            if pathlib.Path(path).name == "ledger.json":
                raise mm_atomic.AtomicWriteError("simulated ledger write failure")
            return real_write(path, text, **kwargs)

        with mock.patch("mm_atomic.atomic_write_text", side_effect=flaky_write):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])

        self.assertEqual(rc, 6)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        self.assertFalse((self.task_dir / "ledger.json").exists())
        # Step 3 (HANDOFF.md regeneration) never runs if step 2 fails --
        # HANDOFF.md must read exactly as it did before this run.
        self.assertEqual(
            (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8"), self.original_text
        )
        leftovers = list(self.task_dir.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])

    def test_handoff_regen_failure_after_ledger_write_leaves_ledger_and_backup_intact_returns_7(self):
        """The interrupted-regeneration path. ledger.json (step 2) lands for
        real; HANDOFF.md's regeneration (step 3) is the one that fails.
        Prove: the ledger survives, correct and readable; the pre-migration
        backup survives; HANDOFF.md itself is untouched by the failed write;
        and the exit code (7) says this is recoverable, not corrupt."""
        real_write = mm_atomic.atomic_write_text

        def flaky_write(path, text, **kwargs):
            if pathlib.Path(path).name == "HANDOFF.md":
                raise mm_atomic.AtomicWriteError("simulated handoff regeneration failure")
            return real_write(path, text, **kwargs)

        with mock.patch("mm_atomic.atomic_write_text", side_effect=flaky_write):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])

        self.assertEqual(rc, 7)

        # The ledger -- the only authority -- survived step 2 untouched.
        self.assertTrue(mm_ledger.is_migrated(self.task_dir))
        ledger = mm_ledger.load_ledger(self.task_dir)
        self.assertEqual(ledger["revision"], 1)

        # Step 1's backup survived (it was written before either atomic
        # write was attempted).
        pre_migration = self.task_dir / "HANDOFF.pre-migration.md"
        self.assertTrue(pre_migration.is_file())
        self.assertEqual(pre_migration.read_text(encoding="utf-8"), self.original_text)

        # HANDOFF.md's failed write never landed -- still the original.
        self.assertEqual(
            (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8"), self.original_text
        )

        leftovers = list(self.task_dir.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])

        # N5: re-running migrate on a migrated folder never rewrites
        # HANDOFF.md (exit 4). The documented recovery is mm.py compile
        # --accept-ledger, which backs the file up first; the ledger already
        # holds every line (the completeness check passed).
        rc2 = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        self.assertEqual(rc2, 4)
        self.assertEqual((self.task_dir / "HANDOFF.md").read_text(encoding="utf-8"), self.original_text)
        with mock.patch.dict("os.environ", {"MM_AUTO_COMMIT": "off"}), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc3 = mm.main(["compile", "--task-dir", str(self.task_dir), "--accept-ledger"])
        self.assertEqual(rc3, 0)
        healed_ledger = mm_ledger.load_ledger(self.task_dir)
        self.assertEqual(
            (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8"),
            mm_compile.render_files(healed_ledger)["HANDOFF.md"],
        )


class MigrateWrapupWarningTests(unittest.TestCase):
    """(d) the wrap-up validator's result must drive real output, not be
    computed and discarded. RED: fixture with no wrap-up row -> warning
    printed. GREEN: fixture with wrap-up row (the default fixture) -> no
    warning."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_capturing_stdout(self, task_dir):
        buf = io.StringIO()
        old_stdout = sys.stdout
        sys.stdout = buf
        try:
            rc = mm_migrate.main(["--task-dir", str(task_dir)])
        finally:
            sys.stdout = old_stdout
        return rc, buf.getvalue()

    def test_missing_wrapup_row_prints_warning(self):
        root = fixture.make_fixture_repo(self.tmp)
        task_dir = _task_dir(root)
        no_wrapup = fixture.HANDOFF_BODY.replace(
            "| #5 | Wrap up: insights review + move to done/ | ⚪ Not started | PM | not scheduled | last item — closing ritual |\n",
            "",
        )
        self.assertNotEqual(no_wrapup, fixture.HANDOFF_BODY)
        (task_dir / "HANDOFF.md").write_text(no_wrapup, encoding="utf-8", newline="\n")

        rc, out = self._run_capturing_stdout(task_dir)

        self.assertEqual(rc, 5)
        self.assertIn("WARNING", out)
        self.assertIn("no wrap-up row found", out)

    def test_present_wrapup_row_prints_no_warning(self):
        root = fixture.make_fixture_repo(self.tmp)
        task_dir = _task_dir(root)

        rc, out = self._run_capturing_stdout(task_dir)

        self.assertEqual(rc, 5)
        self.assertNotIn("WARNING", out)


class MigrateUnicodeSafeStdoutTests(unittest.TestCase):
    """(c) a console on a legacy codepage (for example cp1252) must
    not crash when mm_migrate prints handoff content containing status
    glyphs like the green-circle emoji."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_raw_cp1252_stream_cannot_encode_green_circle_glyph(self):
        # RED baseline: prove the underlying failure is real -- a bare
        # cp1252 text stream really cannot encode the emoji handoff rows
        # carry, absent mm_migrate's stdout-safety fix.
        buf = io.BytesIO()
        raw = io.TextIOWrapper(buf, encoding="cp1252", errors="strict")
        with self.assertRaises(UnicodeEncodeError):
            print("\U0001f7e2 DONE", file=raw)
            raw.flush()

    def test_diff_printer_does_not_crash_on_cp1252_console(self):
        # STALE FIXTURE, rebuilt (this round) -- same root cause as
        # MigrateRoundTripRefusalTests' fixture: an embedded "|" inside a
        # row's Notes tail is exactly what mm_compile is DESIGNED to survive
        # (the Notes cell is captured as one verbatim tail regardless of
        # embedded pipes), so this mangle stopped forcing a failure and the
        # test was asserting rc==2 on a run that now correctly returns 0 --
        # never reaching the print path it exists to exercise at all. Rebuilt
        # around genuine content loss (_ROW_DROP_MANGLE) so the completeness
        # report is actually printed, and its missing-line entry carries the
        # emoji status glyph this test is about.
        mangled = fixture.HANDOFF_BODY.replace(*_ROW_DROP_MANGLE)
        self.assertNotEqual(mangled, fixture.HANDOFF_BODY)
        (self.task_dir / "HANDOFF.md").write_text(mangled, encoding="utf-8", newline="\n")

        buf = io.BytesIO()
        cp1252_stdout = io.TextIOWrapper(buf, encoding="cp1252", errors="strict")
        old_stdout = sys.stdout
        sys.stdout = cp1252_stdout
        try:
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        finally:
            cp1252_stdout.flush()
            sys.stdout = old_stdout

        self.assertEqual(rc, 2)
        printed = buf.getvalue().decode("utf-8", errors="replace")
        self.assertIn("MM-MIGRATE-COMPLETENESS-FAIL", printed)
        self.assertIn("\U0001f7e1", printed)


class MigrateCallsThroughToSharedCompletenessCheckTests(unittest.TestCase):
    """(e) cleanup: mm_migrate no longer carries its own copy of the
    completeness gate -- it calls mm_compile.content_complete /
    mm_compile._print_completeness_report directly. These pin the WIRING
    (that migrate actually calls the shared implementation and surfaces
    whatever it reports), not the gate's own sensitivity -- that unit-level
    coverage belongs to mm_compile's own test suite now, the one place the
    contract is implemented."""

    def test_content_complete_is_called_and_its_report_drives_the_exit_code(self):
        sentinel = mm_compile.CompletenessReport(
            passed=False, missing_lines=["sentinel missing line"], missing_lines_total=1,
            missing_row_ids={"SENTINEL-ID"},
        )
        with mock.patch("mm_compile.content_complete", return_value=sentinel) as mocked:
            buf = io.StringIO()
            old_stdout = sys.stdout
            sys.stdout = buf
            try:
                tmp = pathlib.Path(tempfile.mkdtemp())
                try:
                    root = fixture.make_fixture_repo(tmp)
                    task_dir = _task_dir(root)
                    rc = mm_migrate.main(["--task-dir", str(task_dir), "--apply"])
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
            finally:
                sys.stdout = old_stdout
        self.assertEqual(rc, 2)
        self.assertTrue(mocked.called)
        printed = buf.getvalue()
        self.assertIn("sentinel missing line", printed)
        self.assertIn("SENTINEL-ID", printed)


class MigrateBackupIntegrityTests(unittest.TestCase):
    """(a) the pre-migration backup must be an atomic write that is verified
    immediately after writing -- an unverified backup is not a backup."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)
        self.original_text = (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_verify_helper_catches_a_write_that_lands_wrong_content(self):
        # RED at the unit level, independent of main(): simulate a write
        # that reports success but leaves the wrong bytes on disk (the
        # class of failure an interrupted/corrupted copy produces) -- prove
        # the mandatory verify-read actually catches it.
        dest = self.tmp / "HANDOFF.pre-migration.md"

        def corrupt_write(handle, data):
            handle.write(b"CORRUPTED, NOT THE SOURCE")

        with mock.patch.object(mm_migrate, "_write_and_sync", side_effect=corrupt_write):
            err = mm_migrate._exclusive_backup_with_verify("the real source content\n", dest)

        self.assertIsNotNone(err)
        self.assertIn("verify", err[0].lower())

    def test_verify_helper_passes_on_a_real_write(self):
        dest = self.tmp / "HANDOFF.pre-migration.md"
        err = mm_migrate._exclusive_backup_with_verify("the real source content\n", dest)
        self.assertIsNone(err)
        self.assertEqual(dest.read_text(encoding="utf-8"), "the real source content\n")

    def test_apply_returns_9_when_backup_write_itself_fails(self):
        # An "interrupted backup" surfacing as the write never completing: the exclusive create fails.
        real_open = os.open

        def flaky(path, *args, **kwargs):
            if pathlib.Path(path).name == "HANDOFF.pre-migration.md":
                raise PermissionError("simulated interrupted backup write")
            return real_open(path, *args, **kwargs)

        with mock.patch("os.open", side_effect=flaky):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])

        self.assertEqual(rc, 9)
        self.assertFalse((self.task_dir / "HANDOFF.pre-migration.md").exists())
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        self.assertFalse((self.task_dir / "ledger.json").exists())
        self.assertEqual(
            (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8"), self.original_text
        )
        leftovers = list(self.task_dir.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])

    def test_apply_returns_9_when_backup_write_lands_corrupted_content(self):
        # An "interrupted backup" surfacing as the write completing but with
        # the wrong bytes on disk -- the verify-read is what catches this
        # one, not the write call itself.
        def corrupt_only_backup(handle, data):
            handle.write(b"CORRUPTED, NOT THE SOURCE")

        with mock.patch.object(mm_migrate, "_write_and_sync", side_effect=corrupt_only_backup):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])

        self.assertEqual(rc, 9)
        self.assertEqual((self.task_dir / "HANDOFF.pre-migration.md").read_bytes(), b"CORRUPTED, NOT THE SOURCE")
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        self.assertFalse((self.task_dir / "ledger.json").exists())
        self.assertEqual(
            (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8"), self.original_text
        )


class MigrateToctouTests(unittest.TestCase):
    """(b) the completeness gate passing must not be trusted as still true
    by the time the write happens. Hook into _report (called after the gate,
    before the apply-gate / first write) to mutate HANDOFF.md mid-run,
    proving the re-hash immediately before commit catches it for real."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)
        self.original_text = (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_toctou_abort_when_handoff_changes_between_check_and_commit(self):
        real_report = mm_migrate._report

        def racing_report(task_dir, doc):
            # Simulate a concurrent editor writing to HANDOFF.md in the
            # window between the completeness check (already passed by the
            # time _report runs) and the commit (which happens after this
            # returns).
            handoff_path = task_dir / "HANDOFF.md"
            handoff_path.write_text(
                handoff_path.read_text(encoding="utf-8") + "\nrace: edited between check and commit\n",
                encoding="utf-8", newline="\n",
            )
            return real_report(task_dir, doc)

        with mock.patch("mm_migrate._report", side_effect=racing_report):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])

        self.assertEqual(rc, 10)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        self.assertFalse((self.task_dir / "ledger.json").exists())
        # Nothing was written at all -- not even the pre-migration backup --
        # because the TOCTOU check runs before STEP 1.
        self.assertFalse((self.task_dir / "HANDOFF.pre-migration.md").exists())
        self.assertIn(
            "race: edited between check and commit",
            (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8"),
        )

    def test_dry_run_is_unaffected_by_toctou_check(self):
        # The TOCTOU check only runs on the --apply path (it guards the
        # commit, and a dry run never commits) -- confirm a dry run still
        # reports 5 even though the file is read twice internally would be
        # impossible to trigger without --apply in the first place.
        rc = mm_migrate.main(["--task-dir", str(self.task_dir)])
        self.assertEqual(rc, 5)


class MigrateStalenessSelfHealTests(unittest.TestCase):
    """N5: once ledger.json exists, migrate never rewrites HANDOFF.md, not
    even a stale or hand-edited one: it exits 4 ('already migrated, use /mm
    repair') with or without --apply and writes nothing. Drift in a ledger
    folder belongs to mm.py check, compile and repair."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)
        rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        assert rc == 0, f"fixture setup: expected fresh apply to succeed, got rc={rc}"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _drift_handoff(self):
        handoff_path = self.task_dir / "HANDOFF.md"
        handoff_path.write_text(
            handoff_path.read_text(encoding="utf-8") + "\nhand-edited after migration, drifted from ledger\n",
            encoding="utf-8",
            newline="\n",
        )

    def test_stale_handoff_dry_run_returns_4_and_writes_nothing(self):
        self._drift_handoff()
        before = _snapshot(self.task_dir)

        rc = mm_migrate.main(["--task-dir", str(self.task_dir)])

        self.assertEqual(rc, 4)
        self.assertEqual(_snapshot(self.task_dir), before)

    def test_stale_handoff_apply_returns_4_and_writes_nothing(self):
        self._drift_handoff()
        before = _snapshot(self.task_dir)

        rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])

        self.assertEqual(rc, 4)
        self.assertEqual(_snapshot(self.task_dir), before)

    def test_not_stale_is_still_a_pure_noop(self):
        # No drift: the pre-existing "already migrated" no-op contract must
        # be unaffected by adding staleness detection.
        before = _snapshot(self.task_dir)

        rc = mm_migrate.main(["--task-dir", str(self.task_dir)])

        self.assertEqual(rc, 4)
        self.assertEqual(_snapshot(self.task_dir), before)



class MigrateSection153Tests(unittest.TestCase):
    """PLAN Section 15.3: the four August defects and N1, N5."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)
        self.original_bytes = (self.task_dir / "HANDOFF.md").read_bytes()
        patcher = mock.patch.dict("os.environ", {"MM_AUTO_COMMIT": "off"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_mm(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue() + err.getvalue()

    def test_stale_preexisting_backup_is_refused_not_trusted(self):
        stale = self.task_dir / "HANDOFF.pre-migration.md"
        stale.write_text("# HANDOFF from an older run\n", encoding="utf-8", newline="\n")
        before = _snapshot(self.task_dir)
        for argv in ([], ["--apply"]):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = mm_migrate.main(["--task-dir", str(self.task_dir)] + argv)
            self.assertEqual(rc, 11)
            self.assertIn("HANDOFF.pre-migration.md", out.getvalue())
            self.assertEqual(_snapshot(self.task_dir), before)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        stale.write_bytes(self.original_bytes)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"]), 0)
        self.assertEqual(stale.read_bytes(), self.original_bytes)

    def test_migrate_writes_ledger_through_save_ledger_lock(self):
        lock = self.task_dir / "ledger.lock"
        seen = {}
        real_save = mm_ledger.save_ledger
        real_write = mm_migrate._write_handoff

        def save_spy(task_dir, doc, **kwargs):
            seen["save_lock"] = lock.exists()
            seen["lock_held"] = kwargs.get("lock_held")
            seen["expected_revision"] = kwargs.get("expected_revision")
            return real_save(task_dir, doc, **kwargs)

        def write_spy(path, text):
            seen["handoff_lock"] = lock.exists()
            return real_write(path, text)

        with mock.patch("mm_ledger.save_ledger", side_effect=save_spy), \
                mock.patch("mm_migrate._write_handoff", side_effect=write_spy), \
                contextlib.redirect_stdout(io.StringIO()):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        self.assertEqual(rc, 0)
        self.assertEqual(seen, {"save_lock": True, "lock_held": True, "expected_revision": 0,
                                "handoff_lock": True})
        self.assertFalse(lock.exists())
        self.assertEqual(mm_ledger.load_ledger(self.task_dir)["revision"], 1)

    def test_migrate_refuses_while_the_ledger_lock_is_held(self):
        lock = self.task_dir / "ledger.lock"
        lock.write_bytes(mm_ledger._lock_identity_payload())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"])
        self.assertEqual(rc, 12)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))

    def test_invalid_ledger_exits_with_distinct_code_not_1(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"]), 0)
        path = self.task_dir / "ledger.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["rows"][0]["state"] = "NOT_A_STATE"
        path.write_text(json.dumps(doc), encoding="utf-8")
        for body in (None, "{not json"):
            if body is not None:
                path.write_text(body, encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = mm_migrate.main(["--task-dir", str(self.task_dir)])
            self.assertEqual(rc, 11)
            self.assertIn("/mm repair", out.getvalue())
            rc, output = self.run_mm("migrate", "--task-dir", self.task_dir)
            self.assertEqual(rc, 11, output)
            self.assertIn("/mm repair", output)

    def test_migrate_on_migrated_folder_never_rewrites_handoff(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mm_migrate.main(["--task-dir", str(self.task_dir), "--apply"]), 0)
        handoff = self.task_dir / "HANDOFF.md"
        handoff.write_text(handoff.read_text(encoding="utf-8") + "\nhand edit after migration\n",
                           encoding="utf-8", newline="\n")
        edited = handoff.read_bytes()
        for argv in ([], ["--apply"]):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = mm_migrate.main(["--task-dir", str(self.task_dir)] + argv)
            self.assertEqual(rc, 4)
            self.assertIn("/mm repair", out.getvalue())
            rc, output = self.run_mm("migrate", "--task-dir", self.task_dir, *argv)
            self.assertEqual(rc, 4, output)
            self.assertIn("/mm repair", output)
            self.assertEqual(handoff.read_bytes(), edited)


_CANONICAL_HEADINGS = (("0A", "Dashboard Index"), ("0B", "Session Opener"), ("1", "Status"),
                       ("2", "Decisions log"), ("3", "Open questions"), ("4", "Archive"))
_HEADING_FORMS = {
    "hyphen": "## Section {n} - {t}",
    "em dash": "## Section {n} \u2014 {t}",
    "section sign": "## \u00a7 {n} {t}",
    "section sign em dash": "## \u00a7 {n} \u2014 {t}",
    "code-page mojibake": "## \u05b2\u00a7 {n} {t}",
}
_WRAPUP_LINE = ("| #5 | Wrap up: insights review + move to done/ | \u26aa Not started | PM | not scheduled | "
                "last item \u2014 closing ritual |\n")
_LOOSE_0A = (
    "  Rationale: a continuation paragraph written under the last field.\n"
    "- Side note: a field-like line whose name is not a 0A field\n"
    "- Status: waiting\n"
    "\n"
    "## Section 0A-history Previous values (not parsed)\n"
    "\n"
    "- (superseded) an older Last updated value, 2026-08-01 by fixture\n"
)
_LOOSE_0A_LINES = [line for line in _LOOSE_0A.splitlines() if line.strip()]


def _with_loose_0a(body):
    anchor = "- Executive note: fixture task for ledger-core tests\n"
    return body.replace(anchor, anchor + _LOOSE_0A)


class MigrateLegacyShapeTests(unittest.TestCase):
    """Round 21: legacy shapes that migrate refused, or accepted wrongly.
    Each test writes a synthetic HANDOFF that reproduces one shape."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = fixture.make_fixture_repo(self.tmp)
        self.task_dir = _task_dir(self.root)
        patcher = mock.patch.dict("os.environ", {"MM_AUTO_COMMIT": "off"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, body):
        data = body.encode("utf-8") if isinstance(body, str) else body
        (self.task_dir / "HANDOFF.md").write_bytes(data)

    def migrate(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            rc = mm_migrate.main(["--task-dir", str(self.task_dir)] + list(argv))
        return rc, out.getvalue()

    def run_mm(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            rc = mm.main([str(a) for a in argv])
        return rc, out.getvalue()

    def assert_refused_writing_nothing(self, marker, code):
        before = _snapshot(self.task_dir)
        for argv in ([], ["--apply"]):
            rc, out = self.migrate(*argv)
            self.assertEqual(rc, code, out)
            self.assertIn(marker, out)
            self.assertNotIn("Safe to re-run", out)
            self.assertEqual(_snapshot(self.task_dir), before)
        for argv in ([], ["--apply"]):
            rc, out = self.run_mm("migrate", "--task-dir", self.task_dir, *argv)
            self.assertEqual(rc, 1, out)
            self.assertIn(marker, out)
            self.assertNotIn("Safe to re-run", out)
            self.assertEqual(_snapshot(self.task_dir), before)
        self.assertFalse(mm_ledger.is_migrated(self.task_dir))
        return out

    def test_when_headings_use_dash_or_section_sign_forms_migrate_recognizes_each_section(self):
        for form_name, form in _HEADING_FORMS.items():
            with self.subTest(form=form_name):
                body = fixture.HANDOFF_BODY
                for n, title in _CANONICAL_HEADINGS:
                    body = body.replace(f"## Section {n} {title}\n", form.format(n=n, t=title) + "\n")
                body = body.replace("### To Test Operator",
                                    "## Kept inside Section 3\nprose under it\n\n### To Test Operator")
                self.assertNotIn("## Section 1 Status", body)
                self.write(body)
                slices = mm_compile.parse_handoff(body)
                self.assertEqual([r["id"] for r in slices["rows"]], ["#1", "#2", "#3", "#4", "#5"])
                self.assertEqual([d["qid"] for d in slices["decisions"]], ["Q1", "Q2"])
                self.assertEqual(slices["dashboard_index"].get("Task"), "demo-task")
                self.assertIn("## Kept inside Section 3\nprose under it", slices["section_3_md"])
                self.assertIn("earlier draft of the ledger schema", slices["section_4_md"])
                rc, out = self.migrate("--apply")
                self.assertEqual(rc, 0, out)
                handoff = (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8")
                for n, title in _CANONICAL_HEADINGS:
                    self.assertIn(f"\n## Section {n} {title}\n", handoff)
                self.assertNotIn("\u00a7", handoff)
                shutil.rmtree(self.task_dir)
                self.task_dir.mkdir()

    def test_when_a_numbered_heading_has_another_title_it_stays_text_of_the_section_it_is_in(self):
        body = fixture.HANDOFF_BODY.replace("\n\n---\n\n## Section 2 Decisions log",
                                            "\n\n## \u00a7 2 Parking lot\nan idea parked here\n\n---\n\n"
                                            "## Section 2 Decisions log")
        slices = mm_compile.parse_handoff(body)
        self.assertIn("## \u00a7 2 Parking lot\nan idea parked here", slices["section_1_postamble_md"])
        self.assertEqual([d["qid"] for d in slices["decisions"]], ["Q1", "Q2"])

    def test_when_section_0a_holds_loose_text_migrate_carries_it_verbatim_to_the_archive(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        rc, out = self.run_mm("check", "--task-dir", self.task_dir)
        self.assertIn("round-trip PASS", out)
        rc, out = self.run_mm("migrate", "--task-dir", self.task_dir)
        self.assertEqual(rc, 14, out)
        self.assertIn("+++ b/HANDOFF-archive.md", out)
        rc, out = self.migrate("--apply")
        self.assertEqual(rc, 0, out)
        self.assertIn("HANDOFF-archive.md", out)
        doc = mm_ledger.load_ledger(self.task_dir)
        self.assertEqual(doc["dashboard_index"]["Status"], "active")
        archive = (self.task_dir / "HANDOFF-archive.md").read_text(encoding="utf-8")
        self.assertTrue(archive.startswith(mm_compile.GENERATED_HEADER + "\n"))
        carried = archive.split("\n## Carried from Section 0A at migration\n", 1)[1]
        self.assertIn(_LOOSE_0A.strip("\n"), carried)
        handoff = (self.task_dir / "HANDOFF.md").read_text(encoding="utf-8")
        section_0 = handoff.split("\n---\n", 1)[0]
        for line in _LOOSE_0A_LINES:
            self.assertNotIn(line, section_0)
        self.assertIn("HANDOFF-archive.md", handoff.split("## Section 4 Archive", 1)[1])
        rc, out = self.run_mm("check", "--task-dir", self.task_dir)
        self.assertEqual(rc, 0, out)

    def test_when_0b_and_1_headings_are_absent_0a_loose_text_ends_at_the_next_section(self):
        body = _with_loose_0a(fixture.HANDOFF_BODY).replace("## Section 0B Session Opener\n", "## Opener\n")
        body = body.replace("## Section 1 Status\n", "## Status table\n")
        slices = mm_compile.parse_handoff(body)
        self.assertIn("## Status table", slices["section_0a_loose_md"])
        self.assertNotIn("Q1: Does the ledger own", slices["section_0a_loose_md"])
        self.assertNotIn("should the wrap-up row literal change", slices["section_0a_loose_md"])
        doc = mm_migrate._build_doc(self.task_dir, slices)
        archive = mm_compile.compile_archive(doc)
        self.assertEqual(archive.count("should the wrap-up row literal change"), 0)
        self.assertTrue(mm_compile.complete_against(body, doc).passed)

    def test_when_the_carried_0a_text_misses_a_line_the_completeness_guard_still_fails(self):
        body = _with_loose_0a(fixture.HANDOFF_BODY)
        doc = mm_migrate._build_doc(self.task_dir, mm_compile.parse_handoff(body))

        def report():
            return mm_compile.content_complete(body, mm_compile.compile_handoff(doc), mm_compile.compile_archive(doc))

        self.assertTrue(report().passed)
        carried = doc["archive"]["carried_0a_md"]
        doc["archive"]["carried_0a_md"] = carried.replace(_LOOSE_0A_LINES[0] + "\n", "")
        self.assertFalse(report().passed)
        self.assertEqual(report().missing_lines_by_section["0a"], [_LOOSE_0A_LINES[0].strip()])
        moved = "- 2026-08-02 \u2014 earlier draft of the ledger schema used SQLite; superseded by Q1 above."
        doc["passthrough"]["section_4_md"] = ""
        doc["archive"]["carried_0a_md"] = carried + "\n" + moved
        self.assertFalse(report().passed)
        self.assertEqual(report().missing_lines_by_section, {"4": [moved]})

    def test_when_loose_0a_text_needs_the_archive_and_one_exists_migrate_refuses(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        (self.task_dir / "HANDOFF-archive.md").write_text("# an older hand-kept archive\n", encoding="utf-8",
                                                          newline="\n")
        out = self.assert_refused_writing_nothing("MM-MIGRATE-ARCHIVE-EXISTS", 16)
        self.assertIn("HANDOFF-archive.md", out)

    def test_when_section_1_has_no_wrapup_row_migrate_adds_the_standard_one(self):
        self.write(fixture.HANDOFF_BODY.replace(_WRAPUP_LINE, ""))
        rc, out = self.run_mm("migrate", "--task-dir", self.task_dir)
        self.assertEqual(rc, 14, out)
        self.assertIn("adds the standard wrap-up row", out)
        self.assertNotIn("after migration", out)
        rc, out = self.run_mm("migrate", "--task-dir", self.task_dir, "--apply")
        self.assertEqual(rc, 0, out)
        rows = mm_ledger.load_ledger(self.task_dir)["rows"]
        self.assertEqual([r["id"] for r in rows], ["#1", "#2", "#3", "#4", "#5"])
        self.assertEqual((rows[-1]["item"], rows[-1]["owner"], rows[-1]["is_wrapup"], rows[-1]["state"]),
                         (mm_ledger.mm_schema.WRAPUP_LITERAL, "PM", True, "BACKLOG"))
        self.assertEqual(sum(1 for r in rows if r["is_wrapup"]), 1)
        self.assertEqual(self.run_mm("check", "--task-dir", self.task_dir)[0], 0)

    def test_when_row_ids_repeat_migrate_refuses_up_front_naming_each_id_and_its_lines(self):
        extra = "| #2 | A second row that reuses the id | \u26aa Not started | agent | not scheduled | dup |\n"
        body = fixture.HANDOFF_BODY.replace(_WRAPUP_LINE, extra + _WRAPUP_LINE)
        self.write(body)
        lines = [i for i, line in enumerate(body.split("\n"), 1) if line.startswith("| #2 |")]
        self.assertEqual(len(lines), 2)
        out = self.assert_refused_writing_nothing("MM-MIGRATE-DUPLICATE-ROW-ID", 13)
        self.assertIn(f"'#2' on lines {lines[0]}, {lines[1]}", out)
        self.assertNotIn("'#1'", out)

    def test_when_a_line_holds_a_lone_carriage_return_migrate_refuses_and_names_it(self):
        body = fixture.HANDOFF_BODY.replace("run /mm migrate against this fixture", "run tools\\\run.py first")
        self.write(body.encode("utf-8"))
        line = next(i for i, text in enumerate(body.split("\n"), 1) if "\r" in text)
        out = self.assert_refused_writing_nothing("MM-MIGRATE-STRAY-CR", 15)
        self.assertIn(str(self.task_dir / "HANDOFF.md"), out)
        rc, out = self.run_mm("migrate", "--task-dir", self.task_dir)
        self.assertIn(f"MM-MIGRATE-STRAY-CR {self.task_dir / 'HANDOFF.md'} ", out)
        self.assertIn(f"line {line}:", out)
        self.assertIn("tools\\<CR>un.py", out)

    def test_when_0a_text_holds_a_numbered_heading_with_another_title_migrate_refuses_naming_it(self):
        forms = ("## Section 0B Session Opener (read this first)", "## \u00a7 1 \u2014 Status table",
                 "## \u05b2\u00a7 0 Resume anchor", "## Section 0.1 Current plan")
        for heading in forms:
            with self.subTest(heading=heading):
                body = fixture.HANDOFF_BODY.replace("## Section 0B Session Opener\n", heading + "\n")
                self.write(body)
                line = body.split("\n").index(heading) + 1
                out = self.assert_refused_writing_nothing("MM-MIGRATE-NONCANONICAL-SECTION-HEADING", 17)
                self.assertIn(f"line {line}: {heading}", out)
                self.assertIn("## Section 0B Session Opener", out)
                self.assertIn("rename", out)

    def test_when_0a_text_holds_a_plain_heading_or_a_0a_history_heading_migrate_still_carries_it(self):
        body = _with_loose_0a(fixture.HANDOFF_BODY).replace(
            "  Rationale:", "## OWNER NOTE 2026-08-01, kept with the dashboard\n  Rationale:")
        self.write(body)
        rc, out = self.migrate()
        self.assertEqual(rc, 5, out)
        self.assertNotIn("MM-MIGRATE-NONCANONICAL-SECTION-HEADING", out)

    def test_when_the_archive_appears_between_the_check_and_the_write_migrate_writes_nothing(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        original = (self.task_dir / "HANDOFF.md").read_bytes()
        racer = b"# written by another writer after the check\n"
        real_commit = mm_migrate._commit

        def racing_commit(task_dir, *args, **kwargs):
            (pathlib.Path(task_dir) / "HANDOFF-archive.md").write_bytes(racer)
            return real_commit(task_dir, *args, **kwargs)

        with mock.patch.object(mm_migrate, "_commit", side_effect=racing_commit):
            rc, out = self.migrate("--apply")
        self.assertEqual(rc, 16, out)
        self.assertIn("MM-MIGRATE-ARCHIVE-EXISTS", out)
        self.assertEqual((self.task_dir / "HANDOFF-archive.md").read_bytes(), racer)
        self.assertEqual((self.task_dir / "HANDOFF.md").read_bytes(), original)
        self.assertEqual(sorted(p.name for p in self.task_dir.iterdir()), ["HANDOFF-archive.md", "HANDOFF.md"])
        (self.task_dir / "HANDOFF-archive.md").unlink()
        with mock.patch.object(mm_migrate, "_commit", side_effect=racing_commit):
            rc, out = self.run_mm("migrate", "--task-dir", self.task_dir, "--apply")
        self.assertEqual(rc, 1, out)
        self.assertIn("MM-MIGRATE-ARCHIVE-EXISTS", out)
        self.assertEqual((self.task_dir / "HANDOFF-archive.md").read_bytes(), racer)
        self.assertEqual((self.task_dir / "HANDOFF.md").read_bytes(), original)
        self.assertFalse((self.task_dir / "ledger.json").exists())
        self.assertFalse((self.task_dir / "ROADMAP.html").exists())

    def test_when_the_pre_migration_backup_appears_before_migrate_creates_it_the_file_stays_and_migrate_stops(self):
        racer = b"# HANDOFF.pre-migration.md of another writer\n"
        backup = self.task_dir / "HANDOFF.pre-migration.md"
        real_open, real_write, real_record = os.open, mm_atomic.atomic_write_text, mm_compile.record_compile

        def appear():
            if not backup.exists():
                backup.write_bytes(racer)

        def open_spy(path, *args, **kwargs):
            if pathlib.Path(path).name == backup.name:
                appear()
            return real_open(path, *args, **kwargs)

        def write_spy(path, *args, **kwargs):
            if pathlib.Path(path).name == backup.name:
                appear()
            return real_write(path, *args, **kwargs)

        def after_the_checks(*args, **kwargs):
            appear()
            return real_record(*args, **kwargs)

        hooks = {"just before the write": lambda: [mock.patch("os.open", side_effect=open_spy),
                                                   mock.patch("mm_atomic.atomic_write_text", side_effect=write_spy)],
                 "after the checks": lambda: [mock.patch("mm_compile.record_compile", side_effect=after_the_checks)]}
        for loose in (False, True):
            for label, patchers in hooks.items():
                with self.subTest(hook=label, loose_0a=loose):
                    shutil.rmtree(self.task_dir)
                    self.task_dir.mkdir()
                    self.write(_with_loose_0a(fixture.HANDOFF_BODY) if loose else fixture.HANDOFF_BODY)
                    original = (self.task_dir / "HANDOFF.md").read_bytes()
                    with contextlib.ExitStack() as stack:
                        for patcher in patchers():
                            stack.enter_context(patcher)
                        rc, out = self.migrate("--apply")
                    self.assertEqual(rc, 11, out)
                    self.assertIn(f"MM-MIGRATE-STALE-BACKUP {backup} appeared after the checks", out)
                    self.assertEqual(backup.read_bytes(), racer)
                    self.assertEqual((self.task_dir / "HANDOFF.md").read_bytes(), original)
                    self.assertFalse((self.task_dir / "ledger.json").exists())
                    self.assertFalse((self.task_dir / "ROADMAP.html").exists())
                    self.assertNotIn("Safe to re-run", out)
                    if loose:
                        self.assert_archive_left_and_named(out)
                    else:
                        self.assertIn("Nothing written", out)
                        self.assertEqual(sorted(p.name for p in self.task_dir.iterdir()),
                                         ["HANDOFF.md", "HANDOFF.pre-migration.md"])

    def test_when_the_pre_migration_backup_write_fails_after_its_create_the_file_stays_and_is_named(self):
        backup = self.task_dir / "HANDOFF.pre-migration.md"
        for loose in (False, True):
            with self.subTest(loose_0a=loose):
                shutil.rmtree(self.task_dir)
                self.task_dir.mkdir()
                self.write(_with_loose_0a(fixture.HANDOFF_BODY) if loose else fixture.HANDOFF_BODY)
                original = (self.task_dir / "HANDOFF.md").read_bytes()
                real = mm_migrate._write_and_sync
                failing = OSError("simulated disk full")

                def fail_for_backup(handle, data):
                    if data == original:
                        raise failing
                    return real(handle, data)

                with mock.patch.object(mm_migrate, "_write_and_sync", side_effect=fail_for_backup):
                    rc, out = self.migrate("--apply")
                self.assertEqual(rc, 9, out)
                self.assertTrue(backup.is_file())
                self.assertIn(f"Partial state: {backup} was created by this migration and is left in place", out)
                self.assertIn("MM-MIGRATE-STALE-BACKUP", out)
                self.assertNotIn("Safe to re-run", out)
                self.assertNotIn("othing written", out)
                self.assertEqual((self.task_dir / "HANDOFF.md").read_bytes(), original)
                self.assertFalse((self.task_dir / "ledger.json").exists())
                if loose:
                    self.assert_archive_left_and_named(out)

    def test_when_handoff_uses_crlf_direct_apply_writes_a_byte_equal_pre_migration_backup(self):
        self.write(fixture.HANDOFF_BODY.replace("\n", "\r\n"))
        original = (self.task_dir / "HANDOFF.md").read_bytes()
        self.assertIn(b"\r\n", original)
        rc, out = self.migrate("--apply")
        self.assertEqual(rc, 0, out)
        self.assertEqual((self.task_dir / "HANDOFF.pre-migration.md").read_bytes(), original)
        self.assertTrue(mm_ledger.is_migrated(self.task_dir))

    def assert_archive_left_and_named(self, out, archive_bytes=None):
        archive = self.task_dir / "HANDOFF-archive.md"
        self.assertTrue(archive.is_file(), out)
        if archive_bytes is not None:
            self.assertEqual(archive.read_bytes(), archive_bytes)
        self.assertIn(f"{archive} was written by this migration and is left in place", out)
        self.assertIn("MM-MIGRATE-ARCHIVE-EXISTS", out)
        self.assertNotIn("othing written", out)
        self.assertNotIn("Safe to re-run", out)
        self.assertFalse((self.task_dir / "ledger.json").exists())
        self.assertFalse((self.task_dir / "ROADMAP.html").exists())

    def test_when_a_write_after_the_archive_create_fails_nothing_is_deleted_and_the_partial_state_is_named(self):
        racer = b"# another writer replaced the archive after migrate created it\n"

        def replace_then_fail(*args, **kwargs):
            (self.task_dir / "HANDOFF-archive.md").write_bytes(racer)
            raise OSError("simulated ledger write failure")

        for label, patcher, code, left in (
                ("ledger", mock.patch("mm_ledger.save_ledger", side_effect=OSError("simulated")), 6, None),
                ("ledger after a replace", mock.patch("mm_ledger.save_ledger", side_effect=replace_then_fail), 6,
                 racer),
                ("backup", mock.patch.object(mm_migrate, "_exclusive_backup_with_verify",
                                             return_value=("simulated backup failure", False)), 9, None)):
            with self.subTest(failure=label):
                shutil.rmtree(self.task_dir)
                self.task_dir.mkdir()
                self.write(_with_loose_0a(fixture.HANDOFF_BODY))
                original = (self.task_dir / "HANDOFF.md").read_bytes()
                with patcher:
                    rc, out = self.migrate("--apply")
                self.assertEqual(rc, code, out)
                self.assert_archive_left_and_named(out, left)
                self.assertIn("ledger.json, HANDOFF.md and ROADMAP.html were not written", out)
                self.assertEqual((self.task_dir / "HANDOFF.md").read_bytes(), original)

    def test_when_the_archive_write_fails_after_its_create_the_partial_file_stays_and_is_named(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        with mock.patch.object(mm_migrate, "_write_and_sync", side_effect=OSError("simulated disk full")):
            rc, out = self.migrate("--apply")
        self.assertEqual(rc, 6, out)
        self.assertIn("MM-MIGRATE-ARCHIVE-WRITE-FAILED", out)
        self.assertIn("incomplete", out)
        self.assert_archive_left_and_named(out)

    def test_when_the_archive_create_itself_fails_no_file_is_left_and_nothing_written_is_true(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        real_open = os.open

        def refuse_archive(path, *args, **kwargs):
            if str(path).endswith("HANDOFF-archive.md"):
                raise PermissionError("simulated: access denied")
            return real_open(path, *args, **kwargs)

        with mock.patch("os.open", side_effect=refuse_archive):
            rc, out = self.migrate("--apply")
        self.assertEqual(rc, 6, out)
        self.assertIn("MM-MIGRATE-ARCHIVE-WRITE-FAILED", out)
        self.assertIn("Nothing written", out)
        self.assertEqual(sorted(p.name for p in self.task_dir.iterdir()), ["HANDOFF.md"])

    def test_when_regeneration_fails_after_the_ledger_the_report_names_what_was_and_was_not_written(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        with mock.patch.object(mm_migrate, "_write_handoff", return_value=OSError("simulated")):
            rc, out = self.migrate("--apply")
        self.assertEqual(rc, 7, out)
        self.assertIn("written: HANDOFF-archive.md; not written: HANDOFF.md, ROADMAP.html", out)
        self.assertNotIn("the generated files were not written", out)
        self.assertTrue((self.task_dir / "HANDOFF-archive.md").is_file())

    def test_when_mm_py_apply_fails_after_the_archive_create_restore_leaves_the_archive_and_says_so(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        original = (self.task_dir / "HANDOFF.md").read_bytes()
        racer = b"# another writer replaced the archive after migrate created it\n"

        def replace_then_fail(*args, **kwargs):
            (self.task_dir / "HANDOFF-archive.md").write_bytes(racer)
            raise OSError("simulated ledger write failure")

        with mock.patch("mm_ledger.save_ledger", side_effect=replace_then_fail):
            rc, out = self.run_mm("migrate", "--task-dir", self.task_dir, "--apply")
        self.assertEqual(rc, 1, out)
        self.assertEqual((self.task_dir / "HANDOFF-archive.md").read_bytes(), racer)
        self.assertEqual((self.task_dir / "HANDOFF.md").read_bytes(), original)
        self.assertFalse((self.task_dir / "ledger.json").exists())
        self.assertIn("restored and verified", out)
        self.assertIn("HANDOFF-archive.md is not in the backup and was left in place", out)
        self.assertNotIn("othing written", out)

    def test_when_an_indented_numbered_heading_sits_in_0a_migrate_refuses_naming_it(self):
        for heading in ("   ## \u00a7 1 - Status table", " ## Section 0B Session Opener",
                        "  ## \u05b2\u00a7 2 Decisions"):
            with self.subTest(heading=heading):
                body = fixture.HANDOFF_BODY.replace("## Section 0B Session Opener\n", heading + "\n", 1)
                self.write(body)
                line = body.split("\n").index(heading) + 1
                out = self.assert_refused_writing_nothing("MM-MIGRATE-NONCANONICAL-SECTION-HEADING", 17)
                self.assertIn(f"line {line}: {heading}", out)

    def test_when_0a_uses_crlf_the_carried_block_keeps_every_terminator(self):
        anchor = "- Executive note: fixture task for ledger-core tests\n"
        loose = "\n  Rationale: first paragraph.\n\n- (superseded) an older value\n\n\n"
        body = fixture.HANDOFF_BODY.replace(anchor + "\n", anchor + loose).replace("\n", "\r\n")
        expected = "\r\n\r\n  Rationale: first paragraph.\r\n\r\n- (superseded) an older value\r\n\r\n\r\n"
        self.assertEqual(mm_compile.parse_handoff(body)["section_0a_loose_md"], expected)
        self.write(body)
        rc, out = self.run_mm("migrate", "--task-dir", self.task_dir, "--apply")
        self.assertEqual(rc, 0, out)
        self.assertEqual(mm_ledger.load_ledger(self.task_dir)["archive"]["carried_0a_md"], expected)
        archive = (self.task_dir / "HANDOFF-archive.md").read_bytes().decode("utf-8")
        self.assertIn(mm_compile.CARRIED_0A_HEADING + "\n\n" + expected, archive)

    def test_when_0a_loose_text_has_blank_line_edges_the_carried_block_is_the_exact_slice(self):
        anchor = "- Executive note: fixture task for ledger-core tests\n"
        loose = "\n\n  Rationale: first paragraph.\n\n\n- (superseded) an older value\n\n\n"
        body = fixture.HANDOFF_BODY.replace(anchor + "\n", anchor + loose)
        self.assertIn("\n\n\n## Section 0B Session Opener", body)
        slices = mm_compile.parse_handoff(body)
        expected = "\n\n\n  Rationale: first paragraph.\n\n\n- (superseded) an older value\n\n\n"
        self.assertEqual(slices["section_0a_loose_md"], expected)
        self.write(body)
        rc, out = self.migrate("--apply")
        self.assertEqual(rc, 0, out)
        self.assertEqual(mm_ledger.load_ledger(self.task_dir)["archive"]["carried_0a_md"], expected)
        archive = (self.task_dir / "HANDOFF-archive.md").read_text(encoding="utf-8")
        self.assertIn(mm_compile.CARRIED_0A_HEADING + "\n\n" + expected, archive)
        self.assertEqual(mm_compile.parse_handoff(fixture.HANDOFF_BODY)["section_0a_loose_md"], "")

    def test_when_carried_0a_md_is_not_text_check_reports_an_invalid_ledger(self):
        self.write(_with_loose_0a(fixture.HANDOFF_BODY))
        self.assertEqual(self.migrate("--apply")[0], 0)
        path = self.task_dir / "ledger.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        for bad in (5, ["a list"], None):
            with self.subTest(value=bad):
                doc["archive"]["carried_0a_md"] = bad
                with self.assertRaises(mm_ledger.LedgerValidationError) as ctx:
                    mm_ledger.validate_ledger(doc)
                self.assertIn("carried_0a_md", str(ctx.exception))
                path.write_text(json.dumps(doc), encoding="utf-8")
                rc, out = self.run_mm("check", "--task-dir", self.task_dir)
                self.assertEqual(rc, 1, out)
                self.assertIn("INVALID ledger.json", out)
                self.assertIn("carried_0a_md", out)


if __name__ == "__main__":
    unittest.main()
