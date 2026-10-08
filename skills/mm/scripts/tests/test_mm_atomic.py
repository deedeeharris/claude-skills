import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import os
import shutil
import tempfile
import unittest
from unittest import mock

import mm_atomic


class AtomicWriteTextTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_round_trip_utf8_unicode_and_lf_only_bytes(self):
        path = self.tmpdir / "out.txt"
        text = (
            "em-dash — greek δοκιμή "
            "emoji \U0001f7e2\nsecond line\n"
        )

        mm_atomic.atomic_write_text(path, text)

        raw = path.read_bytes()
        # newline="\n" must stop Windows' universal-newline layer from
        # translating our LF into CRLF on write -- this is the whole reason
        # atomic_write_text takes newline explicitly instead of using the
        # open() default.
        self.assertNotIn(b"\r", raw)
        got = path.read_text(encoding="utf-8")
        self.assertEqual(got, text)

    def test_replace_failure_leaves_original_byte_identical(self):
        path = self.tmpdir / "target.txt"
        original = "original content — keep me"
        mm_atomic.atomic_write_text(path, original)
        original_bytes = path.read_bytes()

        def flaky_replace(src, dst):
            err = OSError("simulated sharing violation")
            err.winerror = 32
            raise err

        with mock.patch("mm_atomic.os.replace", side_effect=flaky_replace):
            with self.assertRaises(mm_atomic.AtomicWriteError):
                mm_atomic.atomic_write_text(
                    path, "new content", retries=2, retry_delay_s=0.01
                )

        self.assertEqual(path.read_bytes(), original_bytes)
        leftovers = list(self.tmpdir.glob("target.txt.tmp-*"))
        self.assertEqual(leftovers, [])


class AtomicWriteManyTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_restores_already_replaced_files_on_partial_failure(self):
        path_a = self.tmpdir / "a.txt"
        path_b = self.tmpdir / "b.txt"
        mm_atomic.atomic_write_text(path_a, "original a")
        mm_atomic.atomic_write_text(path_b, "original b")

        real_replace = os.replace
        calls = {"n": 0}

        def flaky_replace(src, dst):
            calls["n"] += 1
            if calls["n"] == 2:
                err = OSError("simulated sharing violation")
                err.winerror = 32
                raise err
            return real_replace(src, dst)

        with mock.patch("mm_atomic.os.replace", side_effect=flaky_replace):
            with self.assertRaises(mm_atomic.AtomicWriteError):
                mm_atomic.atomic_write_many(
                    [(path_a, "new a"), (path_b, "new b")],
                    retries=1,
                    retry_delay_s=0.01,
                )

        self.assertEqual(path_a.read_text(encoding="utf-8"), "original a")
        self.assertEqual(path_b.read_text(encoding="utf-8"), "original b")
        leftovers = list(self.tmpdir.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])

    def test_all_files_written_on_success(self):
        path_a = self.tmpdir / "a.txt"
        path_b = self.tmpdir / "b.txt"

        mm_atomic.atomic_write_many([(path_a, "content a"), (path_b, "content b")])

        self.assertEqual(path_a.read_text(encoding="utf-8"), "content a")
        self.assertEqual(path_b.read_text(encoding="utf-8"), "content b")

    def test_newly_created_file_removed_on_partial_failure(self):
        # Neither destination exists yet -- prior value is absent for both,
        # so a partial failure must leave NEITHER file behind, not just
        # restore the ones that had prior content.
        path_a = self.tmpdir / "new_a.txt"
        path_b = self.tmpdir / "new_b.txt"

        real_replace = os.replace
        calls = {"n": 0}

        def flaky_replace(src, dst):
            calls["n"] += 1
            if calls["n"] == 2:
                err = OSError("simulated sharing violation")
                err.winerror = 32
                raise err
            return real_replace(src, dst)

        with mock.patch("mm_atomic.os.replace", side_effect=flaky_replace):
            with self.assertRaises(mm_atomic.AtomicWriteError):
                mm_atomic.atomic_write_many(
                    [(path_a, "new a"), (path_b, "new b")],
                    retries=1,
                    retry_delay_s=0.01,
                )

        self.assertFalse(path_a.exists())
        leftovers = list(self.tmpdir.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])

    def test_staging_failure_removes_partial_temp_file(self):
        # If fsync fails on the second item's temp file, that temp file was
        # already created on disk by open()/write() before the failure --
        # it must still be cleaned up, not just temp files from prior
        # successfully-staged items.
        path_a = self.tmpdir / "a.txt"
        path_b = self.tmpdir / "b.txt"

        real_fsync = os.fsync
        calls = {"n": 0}

        def flaky_fsync(fd):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("simulated fsync failure")
            return real_fsync(fd)

        with mock.patch("mm_atomic.os.fsync", side_effect=flaky_fsync):
            with self.assertRaises(OSError):
                mm_atomic.atomic_write_many([(path_a, "a"), (path_b, "b")])

        leftovers = list(self.tmpdir.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
