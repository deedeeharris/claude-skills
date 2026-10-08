"""
BG envelope schema and validator.

Every background session's LAST act is to write the envelope JSON file at
<pm_root>/<TASK>/inbox/envelopes/<session_slug>.envelope.json. Its ABSENCE
is itself the failure signal — the done-marker. There is no other
completion proof, and the PM never flips a Section 1 row green without it.

validate_envelope returns (checks, status) — checks is a GateCheck list (see
mm_gates.py), status is the raw `doc["status"]` string if the file parsed to a
JSON object and the key is present, else None. It never raises on a malformed
or missing file — the caller decides what red means.

Schema-valid (all checks ok) is NOT success-evidence: "blocked" and "failed"
are valid enum members, so a schema-valid envelope can still report failed
work. Callers that need to know whether the work itself succeeded must check
`status == "completed"` in addition to the checks — see validate_envelope.py,
which turns that distinction into a third exit code (T2.5 / SSSF: an agent
declaring its own failure is not a successful phase).
"""
import json
import pathlib

REQUIRED_KEYS = (
    "schema_version",
    "session",
    "task",
    "emitted",
    "status",
    "summary",
    "artifacts",
    "changed_files",
    "commit_message",
    "notes_for_next_agent",
    "human_action",
)

STATUS_VALUES = ("completed", "blocked", "failed")

LIST_KEYS = ("artifacts", "changed_files")

SUMMARY_MAX_CHARS = 400


def validate_envelope(path):
    path = pathlib.Path(path)

    if not path.is_file():
        return [{"item": "envelope file", "ok": False, "note": f"missing: {path}"}], None

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return [{"item": "envelope file", "ok": False, "note": f"unreadable: {e}"}], None

    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        return [{"item": "envelope json", "ok": False, "note": f"invalid json: {e}"}], None

    if not isinstance(doc, dict):
        return [
            {
                "item": "envelope json",
                "ok": False,
                "note": f"top-level value is not an object: {type(doc).__name__}",
            }
        ], None

    checks = []
    for key in REQUIRED_KEYS:
        if key in doc:
            checks.append(
                {"item": f"key:{key}", "ok": True, "note": f"present: {doc[key]!r}"}
            )
        else:
            checks.append(
                {"item": f"key:{key}", "ok": False, "note": f"missing required key: {key}"}
            )

    if "status" in doc:
        if doc["status"] in STATUS_VALUES:
            checks.append(
                {"item": "status enum", "ok": True, "note": f"status={doc['status']}"}
            )
        else:
            checks.append(
                {
                    "item": "status enum",
                    "ok": False,
                    "note": f"status {doc['status']!r} not in {STATUS_VALUES}",
                }
            )

    summary = doc.get("summary")
    if isinstance(summary, str):
        checks.append(
            {
                "item": "summary length",
                "ok": len(summary) <= SUMMARY_MAX_CHARS,
                "note": f"{len(summary)} chars (cap {SUMMARY_MAX_CHARS})",
            }
        )

    for list_key in LIST_KEYS:
        if list_key in doc:
            val = doc[list_key]
            if isinstance(val, list) and all(isinstance(x, str) for x in val):
                checks.append(
                    {
                        "item": f"{list_key} type",
                        "ok": True,
                        "note": f"list of {len(val)} strings",
                    }
                )
            else:
                checks.append(
                    {
                        "item": f"{list_key} type",
                        "ok": False,
                        "note": f"{list_key} must be a list of strings, got {val!r}",
                    }
                )

    if (
        doc.get("status") == "completed"
        and isinstance(doc.get("changed_files"), list)
        and len(doc["changed_files"]) == 0
    ):
        checks.append(
            {
                "item": "changed_files warning",
                "ok": True,
                "note": "WARNING: status=completed with empty changed_files",
            }
        )

    return checks, doc.get("status")
