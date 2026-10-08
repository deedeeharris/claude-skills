# HANDOFF — demo-task

## Section 0A Dashboard Index

- Project: smoke-project
- Task: demo-task
- Status: active
- Last updated: 2026-08-09 09:00 by fixture
- Target finish date: 2026-09-01
- Target week: 2026-W36
- Deadline type: target
- Schedule confidence: medium
- At risk: no
- Owner: Test Operator
- Waiting on: none
- Priority: 2
- Category: infra
- Strategic value: 3
- Money value: none
- Energy cost: medium
- Review cadence: weekly
- Next human decision: none
- Next agent action: run migrate
- Blockers summary: none
- Executive note: fixture task for ledger-core tests

## Section 0B Session Opener

**Last updated:** 2026-08-09 09:00 by fixture

**Where I am now:** Building ledger — χρειάζεται έλεγχος πριν τη συγχώνευση

**Next concrete action:** run /mm migrate against this fixture

**Files to read first:**
1. `HANDOFF.md` — the file under test

**Active blockers:**
- none

**Recent significant decisions (last 24-48h, with citations):**
- Q1 — ledger is JSON not SQLite (chat, Test Operator 2026-08-03)

**Inbox status:** empty

**DO-NOT (anti-patterns specific to this task):**
- do not edit ledger.json by hand: it is compiled output once migrated

---

## Section 1 Status

| ID | Item | Status | Owner | Target date | Notes |
|----|------|--------|-------|-------------|-------|
| #1 | Wire contract approved by the operator | 🟢 **APPROVED** | operator | 2026-08-04 | see `mm_ledger.py` \| review thread |
| #2 | Implement atomic writer | 🟡 **IN PROGRESS** | agent | 2026-08-10 | temp file beside dest |
| #3 | Decide on SQLite vs JSON | 🔴 **BLOCKED** | operator | not scheduled | waiting on operator call |
| #4 | Draft closing-ritual archive step | ⚪ **DEFERRED BY OPERATOR** | PM | not scheduled | revisit after T1.2 lands |
| #5 | Wrap up: insights review + move to done/ | ⚪ Not started | PM | not scheduled | last item — closing ritual |

---

## Section 2 Decisions log

### Q1: Does the ledger own both HANDOFF and dashboard output?
- **Status:** FINAL
- **Source:** chat, Test Operator 2026-08-03
- **Date:** 2026-08-03
- **Who:** Test Operator
- **Decision:** ledger.json is the single authority; HANDOFF.md and dashboards are compiled views.
- **Why:** avoids two sources of truth drifting apart.

### Q2: Should migration back up the task folder first?
- **Status:** FINAL
- **Source:** chat, Test Operator 2026-08-05
- **Date:** 2026-08-05
- **Who:** Test Operator
- **Decision:** yes, timestamped backup before any write.
- **Why:** migration is destructive if it goes wrong.
- **Consequence:** every migrate run leaves a `<task>.bak-<ts>/` folder behind until pruned.

---

## Section 3 Open questions

### To Test Operator
- **Q3:** should the wrap-up row literal change when both insights.md and status.md exist? — asked 2026-08-06, awaiting reply

---

## Section 4 Archive

- 2026-08-02 — earlier draft of the ledger schema used SQLite; superseded by Q1 above.
