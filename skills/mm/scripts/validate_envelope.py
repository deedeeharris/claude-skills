"""
CLI wrapper for mm_envelope.validate_envelope.

Usage:
    python3 <mm>/scripts/validate_envelope.py <path>

Exit codes (T2.5 — an agent declaring its own failure is not a successful
phase; same rule SSSF states, applied to this validator):
  0 -> envelope present, schema-valid, AND status == "completed"
       (safe to accept — the PM may flip the row green)
  1 -> envelope missing, malformed, or schema-invalid
       (a broken report — required key missing, bad JSON, status outside
       the enum, etc.)
  2 -> envelope present and schema-valid, but status is "failed" / "blocked"
       (or any other non-"completed" value)
       (a legitimate report of unsuccessful work — distinct from exit 1 on
       purpose, so the operator can tell "the agent told me it failed" from
       "the agent produced garbage")

The absence of the envelope file is itself the failure signal (exit 1) — a
missing file NEVER exits 0, under any flag.
"""
import pathlib
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mm_envelope import validate_envelope
from mm_gates import run_gates

COMPLETED_STATUS = "completed"


def main(argv):
    # On Windows locale.getpreferredencoding() is often a legacy code page; content here (notes,
    # summaries, paths) contains em-dashes and Hebrew. Force UTF-8 stdout
    # explicitly rather than trusting the console codepage.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if len(argv) == 2 and argv[1] in ("-h", "--help"):
        print("usage: validate_envelope.py <path>")
        print(__doc__.strip())
        return 0

    if len(argv) != 2:
        print("usage: validate_envelope.py <path>")
        return 1

    path = pathlib.Path(argv[1])

    if not path.is_file():
        print(f"MISSING ENVELOPE: {path} \u2014 session did not complete")
        return 1

    checks, status = validate_envelope(path)
    ok, checks = run_gates(checks)

    for c in checks:
        item_status = "OK" if c["ok"] else "FAIL"
        print(f"[{item_status}] {c['item']}: {c['note']}")

    if not ok:
        print(
            "RESULT: schema-invalid \u2014 exit 1 "
            "(broken report; do not accept, do not flip the row)"
        )
        return 1

    if status == COMPLETED_STATUS:
        print("RESULT: schema-valid, status=completed \u2014 exit 0 (safe to accept)")
        return 0

    print(
        f"RESULT: schema-valid, status={status!r} \u2014 exit 2 "
        "(legitimate report of unsuccessful work, NOT a broken report; "
        "route the row to blocked, do not flip it green)"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
