# What a generated HANDOFF.md looks like

Load this to see the shape `mm.py` renders from a ledger, or to look up the Section 0A field names and enum values. Nobody writes this file by hand: `mm.py scaffold` creates it, every `mm.py` write regenerates it, and the first line of every generated copy is the header `<!-- GENERATED from ledger.json by mm.py - do not edit -->`. The enum lines below are the values `set-field` accepts; they equal `scripts/mm_schema.py`, and a test compares them.

Section 0A is the only part the repo dashboard parses. Every field appears, in this order, and a missing value is written as `none`, `unknown` or `not set`. Section 0B holds the session opener. `### Loop` appears at the end of 0B once unattended mode has been switched on.

## Template

```markdown
<!-- GENERATED from ledger.json by mm.py - do not edit -->
# HANDOFF — <TASK>

## Section 0A Dashboard Index

- Project: <repo/project name>
- Task: <TASK>
- Status: active | blocked | waiting | paused | done | needs-triage
- Last updated: <YYYY-MM-DD HH:MM> by <agent or human>
- Target finish date: <exact readable date | none | unknown | not set>
- Target week: <exact readable week range | none | unknown | not set>
- Deadline type: hard | target | none
- Schedule confidence: high | medium | low | unknown
- At risk: yes | no | unknown
- Owner: <person/agent | unknown | not set>
- Waiting on: <person/team/none/unknown/not set>
- Priority: 1 | 2 | 3 | 4 | 5 | unknown | not set
- Category: <category | unknown | not set>
- Strategic value: 1 | 2 | 3 | 4 | 5 | unknown | not set
- Money value: 1 | 2 | 3 | 4 | 5 | none | unknown
- Energy cost: low | medium | high | unknown
- Review cadence: daily | weekly | monthly | on-demand | unknown | not set
- Next human decision: <concise decision needed | none | unknown | not set>
- Next agent action: <concise next action | none | unknown | not set>
- Blockers summary: <concise blockers | none | unknown | not set>
- Executive note: <short executive-facing note>

## Section 0B Session Opener

**Last updated:** <YYYY-MM-DD HH:MM> by <agent or human>

**Where I am now:** <one line — phase + headline state>

**Next concrete action:** <what should happen next, specific>

**Files to read first:**
1. `<path>` — <why>
2. `<path>` — <why>

**Active blockers:**
- <one-liner per blocker, with "waiting on X since DATE">

**Recent significant decisions (last 24-48h, with citations):**
- <Q-id> — <decision> (<source>, <date>)

**Inbox status:** <N unprocessed entries at `<pm_root>/<TASK>/inbox/` | empty | last consumed <YYYY-MM-DD>>

**DO-NOT (anti-patterns specific to this task):**
- <anti-pattern>: <why>

---

## Section 1 Status

| ID | Item | Status | Owner | Target date | Notes |
|----|------|--------|-------|-------------|-------|
| #1 | <short name> | 🟢 Done / 🟡 In progress / 🔴 Blocked / ⚪ Not started | <agent or person> | <exact date or not scheduled> | <one line> |
| #N | Wrap up: insights review + move to done/ | ⚪ Not started | PM | not scheduled | last row: run the closing ritual (mm.py close) |

`mm.py scaffold` plants the wrap-up row last, and `add-row` always inserts before it. Folders that carry the older `Wrap up: insights review + status.md + move to done/` string keep working; closing fires on either form.

---

## Section 2 Decisions log

### Q1: <question>
- **Status:** TBD / FINAL / REJECTED / REDIRECT / NEEDS CONTEXT
- **Source:** <citation>
- **Date:** <YYYY-MM-DD>
- **Who:** <name>
- **Decision:** <verbatim or paraphrase>
- **Why:** <reasoning>

---

## Section 3 Open questions

### To <stakeholder name>
- **Q\<n\>:** <question> — asked <date>, awaiting reply

---

## Section 4 Archive

(Closed items, superseded decisions, stale questions. `mm.py archive` moves finished rows and old decisions to HANDOFF-archive.md and adds a pointer line here.)
```

The planted wrap-up row text is exactly `Wrap up: insights review + move to done/`.
