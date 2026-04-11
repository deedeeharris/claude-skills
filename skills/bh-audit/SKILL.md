---
name: bh-audit
description: Use when asked to audit code for bugs without fixing them. Scans the repo with 3 independent expert judges (weighted scoring + expert veto), proves root causes, and generates a report. NEVER modifies code — read-only audit.
---

# Bug Hunter Audit (Read-Only)

Scan any repo for bugs, verify with 3 independent parallel expert judges (weighted scoring + expert veto), deduplicate, prove root cause, and generate a report.

**This skill is STRICTLY READ-ONLY. It NEVER fixes, edits, or commits anything.**

## Difference from `/bh`

| | `/bh` (bug-hunter) | `/bh-audit` (this skill) |
|---|---|---|
| Finds bugs | Yes | Yes |
| Fixes bugs | Yes (TDD + auto-fix) | **NEVER** |
| Creates commits | Yes | **NEVER** |
| Code review gate | Yes | No (nothing to review) |
| DoD gate | Yes | No (nothing to verify) |
| Output | Fixed code + report | Report only |

Use `/bh` when you want bugs found AND fixed.
Use `/bh-audit` when you want bugs found and reported — a human decides what to do.

## CRITICAL CONSTRAINT: NO MODIFICATIONS

**This skill MUST NOT:**
- Fix any bug
- Edit any source file
- Write any code changes
- Create any commits
- Run ESLint --fix, prettier --write, or any auto-fix tool
- Suggest inline code fixes in the report

**This skill MUST ONLY:**
- Read and scan source files
- Run tests (read-only — to detect failures)
- Verify findings with expert judges
- Prove root causes
- Generate a markdown report

## How to Run

```
/babysitter:call Run the generic/bh-audit process.
  Process file: processes/bh-audit.js (or ~/.a5c/processes/bh-audit.js)
  Inputs: projectDir=<CWD>, scanTarget=both
```

## Process Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `projectDir` | CWD | Path to the repo root |
| `testCmd` | auto-detect | Override test command |
| `categories` | all 6 | Bug categories to scan |
| `scanTarget` | `both` | `current` / `dev` / `both` |
| `severityFilter` | `low` | Minimum severity to include |
| `maxFindings` | 30 | Max findings per scan |

## Categories

### Standard
`logic`, `security`, `memory-lifecycle`, `error-handling`, `performance`, `thread-safety`

### Extended (data/pipeline projects)
`sql-logic`, `data-integrity`, `resource-config`, `pipeline-logic`, `test-gaps`, `conventions`, `contract-drift`

## Process Flow

```
DETECT project
-> [SETUP DEV WORKTREE if scanning dev]
-> RUN TESTS (detect failures)
-> SCAN (N categories IN PARALLEL)
-> DEDUP
-> VERIFY (3 independent expert judges IN PARALLEL)
   |-- Judge 1: Software Engineer     (separate agent)
   |-- Judge 2: Data/Infra Engineer   (separate agent)
   |-- Judge 3: Security Specialist   (separate agent)
-> MERGE SCORES (weighted average + expert veto)
-> PROVE ROOT CAUSE
-> REPORT (markdown + Hebrew summary)
-> [CLEANUP WORKTREE]
```

## Weighted Expert Voting

Each judge runs as a **separate parallel agent** with its own context — true independence.

| Judge | Expert Categories |
|-------|-------------------|
| Software Engineer | logic, error-handling, test-gaps, conventions, contract-drift |
| Data/Infrastructure Engineer | sql-logic, data-integrity, resource-config, pipeline-logic |
| Security & Systems Specialist | security, memory-lifecycle, performance, thread-safety |

### Classification

| Condition | Result |
|-----------|--------|
| Domain expert >=80 | **Verified** (expert veto) |
| Weighted average >=50 | **Verified** |
| Weighted average 30-49 | **Needs Attention** |
| Weighted average <30 | **Dismissed** |

## Report Output

Saved to `<projectDir>/BH-AUDIT-REPORT.md`:
- Summary stats per scan target
- Verified bugs by severity with root cause, impact, judge scores
- Needs Attention section with expert reasoning
- Dismissed count
- Hebrew summary for notifications

Each finding tagged `[current]` or `[dev]` by source branch.
