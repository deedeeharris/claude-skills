---
name: bh
description: Use when asked to hunt bugs, find and fix bugs, audit code quality, or run /bh. Launches the generic/bug-hunter babysitter process on the current repo. Supports yolo (auto-fix) and interactive (breakpoints) modes.
---

# Bug Hunter

Scan any repo for bugs across 6 categories, verify with weighted expert voting (3 specialist judges with domain-weighted confidence scoring and expert veto), deduplicate, prove, fix in batches with TDD, run conventions + code review + DoD gate, regression-check, commit, and re-scan until clean.

## CRITICAL RULES — BABYSITTER ENFORCEMENT

**You MUST use babysitter orchestration for the ENTIRE run. This is NON-NEGOTIABLE.**

- Do NOT execute any bug hunting phase yourself — not scan, not verify, not fix, not commit
- Do NOT skip babysitter because "it's simpler to just do it"
- Do NOT rationalize bypassing orchestration for any reason
- Do NOT execute agent tasks directly after receiving scan results — post them back via task:post and let babysitter dispatch the next phase
- If babysitter setup fails, fix the setup — do NOT fall back to manual execution
- After EVERY task:post, STOP the session. The hook will call you back for the next phase.

### Short-Circuit Detection

If you find yourself doing ANY of these, you are short-circuiting babysitter. STOP and correct course:

| What you're doing | What you SHOULD do |
|---|---|
| Running an Agent to scan AND then running another Agent to verify in the same session | Post scan results via task:post, STOP. Babysitter dispatches verify on next iteration. |
| Fixing bugs directly after seeing scan results | Post scan results via task:post, STOP. Let babysitter drive dedup -> verify -> prove -> fix pipeline. |
| Calling run:iterate, performing the task, AND calling run:iterate again in the same session | Perform ONE task, post result, STOP. Hook triggers next iteration. |
| Deciding "the remaining phases aren't needed" | ALL phases exist for a reason. The weighted expert vote catches false positives. Regression checks catch broken fixes. You cannot skip them. |
| "I'll just do the fixes quickly since I already have the results" | The process has dedup, 5-judge verify, prove, TDD, conventions, review, DoD, regression check, and build gates between scan and fix. Skipping them defeats the entire purpose. |

### The Rule: One Task Per Session

```
Session N:   run:iterate → get pending task → execute task → task:post → STOP
Session N+1: (hook calls you) → run:iterate → get pending task → execute task → task:post → STOP
Session N+2: (hook calls you) → run:iterate → ...
```

You NEVER execute more than one process phase per session. The babysitter journal records every phase transition. If a phase is missing from the journal, the process is broken.

## Modes

| Mode | Command | autoFix | Breakpoints | Description |
|------|---------|---------|-------------|-------------|
| **Yolo** (default) | `/bh` or `/bh yolo` | true | None | Fully autonomous, fixes everything |
| **Interactive** | `/bh interactive` | false | Before each fix batch + before each commit | User reviews and approves each step |

## How to Run

**Yolo mode** (default) — invoke `babysitter:yolo`:
```
/babysitter:yolo Run the generic/bug-hunter process.
  Process file: ~/.a5c/processes/bug-hunter.js
  Inputs: projectDir=<CWD>, autoFix=true, maxIterations=3
```

**Interactive mode** — invoke `babysitter:call`:
```
/babysitter:call Run the generic/bug-hunter process.
  Process file: ~/.a5c/processes/bug-hunter.js
  Inputs: projectDir=<CWD>, autoFix=false, maxIterations=3
```

## Process Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `projectDir` | CWD | Path to the repo root |
| `buildCmd` | auto-detect | Override build command |
| `testCmd` | auto-detect | Override test command |
| `maxIterations` | 3 | Max scan-fix-rescan cycles |
| `maxBatchSize` | 8 | Max bugs per fix batch |
| `categories` | all 6 | Which bug categories to scan |
| `autoFix` | true | true=yolo (no breakpoints), false=interactive (breakpoints before fix/commit) |
| `fixConfidenceTarget` | 85 | Target confidence score (0-100) for fix correctness |
| `maxFixAttempts` | 3 | Max re-fix attempts per batch if confidence is below target |
| `tdd` | true | Enforce red→green→refactor on every fix |
| `conventionsCmd` | auto-detect | Override conventions check command (auto-detects ESLint, Prettier, tsc) |
| `codeReviewAngles` | see defaults | List of review perspectives to run in parallel (see Code Review section) |
| `dodQuestions` | see defaults | Yes/no DoD checklist — all must be YES before commit |

## Steps

1. Check branch health (`BRANCH PRE-CHECK`)
2. Detect the current project's `projectDir`, `buildCmd`, `conventionsCmd` (check CLAUDE.md, package.json, .eslintrc, etc.)
3. Parse mode from user args: "interactive" -> autoFix=false, otherwise autoFix=true
4. Create inputs JSON at `.a5c/processes/bug-hunter-inputs.json`
5. Invoke `babysitter:yolo` (autoFix=true) or `babysitter:call` (autoFix=false)
6. Let babysitter drive the ENTIRE flow — every phase is a separate babysitter task

## What the Process Does

```
BRANCH PRE-CHECK
→ DETECT
→ SCAN (6 categories IN PARALLEL)
→ DEDUP
→ VERIFY (weighted expert vote)
→ PROVE
→ [BREAKPOINT if interactive]
→ TDD: write failing test that reproduces the exact bug (RED)
→ FIX the bug (GREEN)
→ REFACTOR + verify test still passes
→ SCORE FIX CONFIDENCE (4-dimension)
   → [if confidence < target: RE-FIX with feedback, up to maxFixAttempts]
   → [if plateau detected: accept (yolo) or breakpoint (interactive)]
→ CONVENTIONS GATE (ESLint + Prettier + tsc + project check)
→ REGRESSION CHECK + COMPILE GATE (parallel)
→ BUILD+TEST (hard shell gate)
→ CODE REVIEW (3 angles IN PARALLEL, autonomous)
→ [BREAKPOINT if interactive]
→ DoD BINARY GATE (all yes/no must be YES)
→ [BREAKPOINT if interactive]
→ COMMIT (with bug IDs)
→ RE-SCAN (modified files only)
→ LOOP until clean or maxIterations
→ REPORT (with confidence scores + DoD results)
```

Each arrow (`->`) is a separate babysitter task. Each task is dispatched by babysitter, executed by you, and posted back via `task:post`. You never skip ahead.

---

## Phase Details

### Branch Pre-Check

Before anything else, verify:
- Working tree is clean (no uncommitted changes that could be clobbered)
- Current branch is not main/master directly (warn if so)
- No unresolved merge conflicts

If any check fails: report and halt. Do not proceed with a dirty state.

---

### Weighted Expert Voting (Verify Phase)

Replaces simple majority voting with domain-weighted confidence scoring. Three specialist judges evaluate each finding independently:

| Judge | Expertise | Expert Categories |
|-------|-----------|-------------------|
| **Software Engineer** | Code correctness, logic, edge cases, error handling, test coverage | logic, error-handling, test-gaps, conventions, contract-drift |
| **Data/Infrastructure Engineer** | Data integrity, SQL, pipelines, resource configuration | sql-logic, data-integrity, resource-config, pipeline-logic |
| **Security & Systems Specialist** | Security, memory safety, concurrency, performance | security, memory-lifecycle, performance, thread-safety |

**Scoring**: Each judge assigns a confidence score (0-100) per finding. The judge whose expertise matches the finding's category gets **double weight (×2)**.

**Classification**:

| Condition | Result | Action |
|-----------|--------|--------|
| Domain expert scores ≥80 | **Verified** (expert veto) | Proceeds to PROVE, regardless of other scores |
| Weighted average ≥50 | **Verified** | Proceeds to PROVE |
| Weighted average 30-49 | **Needs Attention** | Included in report with expert reasoning, but NOT auto-fixed |
| Weighted average <30 | **Dismissed** | Filtered out as false positive |

**Why 3 judges instead of 5**: Using 3 specialized judges with domain weighting produces better signal than 5 generalist perspectives simulated by a single agent. The expert veto mechanism ensures that a domain specialist's high-confidence finding cannot be overruled by non-experts, solving the key weakness of simple majority voting where critical domain-specific bugs get dismissed.

**Evidence requirement**: Each verified finding still requires 2+ independent evidence signals (code reading, caller analysis, framework docs, test coverage).

---

### TDD Gate

Enforced on EVERY fix batch. No exceptions.

1. **RED** — Write a failing test that directly reproduces the exact proven bug. The test must fail before the fix is applied.
2. **GREEN** — Apply the fix. The test must now pass.
3. **REFACTOR** — Clean up without changing behavior. Verify test still passes and no other tests broke.

Only proceed to SCORE after the test is green.

No-cheat rules:
- Never write the test after the fix
- Never silence errors with `eslint-disable`, `as any`, or empty catch blocks
- Never delete a failing test

---

### Conventions Gate

Auto-detect from project config, run all that apply:

| Tool | Detection | Command |
|------|-----------|---------|
| ESLint | `.eslintrc*` / `eslint` in package.json | `eslint . --max-warnings 0` |
| Prettier | `.prettierrc*` / `prettier` in package.json | `prettier --check .` |
| TypeScript | `tsconfig.json` | `tsc --noEmit` |
| Project check | `check` script in package.json | `npm run check` |

All must pass. Any failure blocks progress — do not proceed to regression check.

---

### Code Review

Three angles run **in parallel**, all autonomous (no human input needed):

| Angle | Focus |
|-------|-------|
| **General** | Correctness, logic errors, edge cases, null safety, error handling |
| **Security** | Injection, auth bypass, data exposure, unsafe operations, OWASP top 10 |
| **Quality** | Readability, duplication, naming, unnecessary complexity, maintainability |

Each reviewer produces: PASS / WARN / BLOCK + findings list.

- **BLOCK** from any angle → feed findings back as fix context, re-fix, re-review (counts against `maxFixAttempts`)
- **WARN** → logged in report, does not block
- **PASS** → proceed to DoD

Override via `codeReviewAngles` input to add a project-specific fourth angle.

---

### DoD Binary Gate

All questions must be answered YES. A single NO blocks the commit and feeds back as fix context.

Default 10 questions:

1. Does every fix address its proven root cause — not just a symptom?
2. Was a failing test written before the fix was applied (TDD red step)?
3. Do all new tests pass?
4. Are there zero regressions in the existing test suite?
5. Does the build compile with zero errors and zero warnings?
6. Do all conventions checks pass (ESLint, Prettier, tsc, project check)?
7. Is the fix confidence score at or above the target?
8. Did all code review angles pass or warn (no BLOCKs)?
9. Are all affected code paths covered by the fix?
10. Is the fix safe — no broken callers, no unintended API surface changes?

Override or extend via `dodQuestions` input.

---

## Fix Confidence Scoring

After each fix batch, an agent scores every fix across 4 dimensions:

| Dimension | Weight | What It Measures |
|-----------|--------|------------------|
| Root Cause Match | 40% | Does the fix address the exact proven root cause, not just a symptom? |
| Completeness | 25% | Are all code paths where the bug manifests covered? |
| Correctness | 20% | Is the fix itself correct? No new logic errors? |
| Safety | 15% | Could the fix break callers or change public API? |

### When to Use Which Target

| Target | When | Use Case |
|--------|------|----------|
| **70** | Quick scans, low-risk internal tools | "Fix the obvious stuff" |
| **80** | Standard development, most repos | "Good enough for a PR" |
| **85** | **Default** — production code, typical audits | "Confident the fixes are correct" |
| **90** | Security-critical, payment systems, compliance | "High assurance" |
| **95** | Rarely — beware of plateaus and diminishing returns | Only if every fix MUST be perfect |

### Convergence Behavior

- If overall confidence >= target after first attempt: move on (no re-fix needed)
- If below target: low-confidence fixes are fed back as specific feedback to the next attempt
- If improvement plateaus (< 5 points between attempts): accept and move on (yolo) or breakpoint (interactive)
- Max attempts prevents infinite loops (default: 3)
