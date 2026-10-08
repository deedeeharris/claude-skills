"""Generic unittest discovery runner for the mm skill's script tests.

Usage: python3 <mm>/scripts/tests/run_all.py
Exit 0 = all tests passed. Exit 1 = any failure or error.

Write this once; it must never need editing as later items add test files —
it discovers every test_*.py in this directory, it does not enumerate them.
"""

import pathlib
import sys
import unittest

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS_DIR = HERE.parent

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _iter_tests(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _iter_tests(item)
        else:
            yield item


def main() -> int:
    loader = unittest.TestLoader()
    suite = loader.discover(
        start_dir=str(HERE), pattern="test_*.py", top_level_dir=str(HERE)
    )

    # Collect module names BEFORE running: TestSuite.run() clears its
    # internal references to already-executed tests (to free them for GC),
    # so walking the suite after run() sees None instead of the test cases.
    modules = sorted({test.__class__.__module__ for test in _iter_tests(suite)})

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    print(f"mm test runner: modules={', '.join(modules) if modules else 'none'}")
    print(
        f"mm test runner: ran={result.testsRun} "
        f"failures={len(result.failures)} errors={len(result.errors)}"
    )

    if result.testsRun == 0:
        print("mm test runner: ERROR - zero tests discovered, treating as failure")
        return 1

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
