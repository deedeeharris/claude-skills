"""Single source for the mm vocabulary.

Section 0A field names, their enum values, the missing-value words, row
states, status labels, test levels, decision statuses, the wrap-up literals,
the generated-file header and the size caps. build_pm_dashboard, mm_ledger,
mm_compile and mm.py import these names; references/handoff-template.md lists
the same enum values (a test compares them).
"""

FIELDS = [
    "Project", "Task", "Status", "Last updated", "Target finish date",
    "Target week", "Deadline type", "Schedule confidence", "At risk",
    "Owner", "Waiting on", "Priority", "Category", "Strategic value",
    "Money value", "Energy cost", "Review cadence", "Next human decision",
    "Next agent action", "Blockers summary", "Executive note",
]

ALLOWED = {
    "Status": {"active", "blocked", "waiting", "paused", "done", "needs-triage"},
    "Deadline type": {"hard", "target", "none"},
    "Schedule confidence": {"high", "medium", "low", "unknown"},
    "At risk": {"yes", "no", "unknown"},
    "Priority": {"1", "2", "3", "4", "5", "unknown", "not set"},
    "Strategic value": {"1", "2", "3", "4", "5", "unknown", "not set"},
    "Money value": {"1", "2", "3", "4", "5", "none", "unknown"},
    "Energy cost": {"low", "medium", "high", "unknown"},
    "Review cadence": {"daily", "weekly", "monthly", "on-demand", "unknown", "not set"},
}

MISSING_VALUES = {"", "none", "unknown", "not set"}

FIELD_DEFAULTS = {field: "unknown" for field in FIELDS}
FIELD_DEFAULTS.update({"Status": "active", "Deadline type": "none", "Waiting on": "none",
                       "Blockers summary": "none", "Next human decision": "none"})

STATES = (
    "BACKLOG", "INVESTIGATING", "NEEDS_DECISION", "SPEC_READY",
    "IMPLEMENTING", "REVIEW", "LOCAL_GREEN", "PR_READY", "DEV",
    "HUMAN_VERIFIED", "DONE", "ABANDONED",
)
TERMINAL = ("DONE", "ABANDONED")

STATUS_LABELS = {
    "BACKLOG": "Not started", "INVESTIGATING": "Investigating",
    "NEEDS_DECISION": "Blocked: needs a decision", "SPEC_READY": "Spec ready",
    "IMPLEMENTING": "In progress", "REVIEW": "In review", "LOCAL_GREEN": "Green locally",
    "PR_READY": "PR ready", "DEV": "On dev", "HUMAN_VERIFIED": "Human verified",
    "DONE": "Done", "ABANDONED": "Abandoned",
}

TEST_LEVELS = ("none", "unit", "integration", "e2e", "manual")

DECISION_STATUSES = ("TBD", "FINAL", "REJECTED", "REDIRECT", "NEEDS CONTEXT", "SUPERSEDED", "IMPORTED")

WRAPUP_LITERAL = "Wrap up: insights review + move to done/"
WRAPUP_LITERALS = (WRAPUP_LITERAL, "Wrap up: insights review + status.md + move to done/")

GENERATED_HEADER = "<!-- GENERATED from ledger.json by mm.py - do not edit -->"
GENERATED_FILES = ("HANDOFF.md", "HANDOFF-archive.md", "ROADMAP.html")

SECTION_0B_FIELDS = (
    "Last updated", "Where I am now", "Next concrete action", "Files to read first",
    "Active blockers", "Recent significant decisions (last 24-48h, with citations)",
    "Inbox status", "DO-NOT (anti-patterns specific to this task)",
)

FIELD_WARN_CHARS = 250
FIELD_FAIL_CHARS = 400
SECTION0_WARN_BYTES = 10 * 1024
SECTION0_FAIL_BYTES = 16 * 1024
CELL_FAIL_CHARS = 600
HANDOFF_WARN_BYTES = 60 * 1024
BACKUPS_KEEP = 3
DORMANT_DAYS = 14

# The archaeology symptoms (history written into the HANDOFF), checked before
# Section 4 Archive by mm.py check and by hooks/check-handoff.py, which keeps
# the same list as a literal; the line-start ones count only there.
ARCHAEOLOGY_SYMPTOMS = (
    "preserved for audit trail",
    "historical note kept for honesty",
    "old content below",
    "initial assessment was",
    "re-diagnosed",
)
ARCHAEOLOGY_LINE_START = ("old content below",)


def is_wrapup_item(item: str) -> bool:
    return any(item.startswith(w) for w in WRAPUP_LITERALS)
