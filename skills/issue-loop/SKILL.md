---
name: issue-loop
description: Autonomous GitHub issue fixer. For each open issue: Session 1 writes a spec + runs /deep-verify-plan (≥95/100), Session 2 uses /writing-plans to produce a TDD task list, Session 3 implements with TDD + /verification-before-completion then commits and pushes. Quality gates validate each artifact. Loops until no open issues remain. All orchestration events are visible inline in the CC terminal.
---

# Issue Loop

Autonomous GitHub issue fixer running entirely in the CC terminal. Every event — issue selection, session start, gate result, label change — is visible inline as it happens.

**Usage:** `/issue-loop [START_ISSUE=N] [START_SESSION=N]`

**Examples:**
- `/issue-loop` — process all open issues from the beginning
- `/issue-loop START_ISSUE=6` — skip issues #1–#5, start at #6
- `/issue-loop START_ISSUE=6 START_SESSION=3` — resume issue #6 at Session 3

---

## Step 0: Argument Parsing

Parse `$ARGUMENTS`. Extract:
- `START_ISSUE` — default `1`. Skip all issues with number < this value.
- `START_SESSION` — default `1`. For the **first** issue processed, skip sessions before this number. After the first issue completes (or fails), reset `START_SESSION` to `1` for all subsequent issues.

Example: `START_ISSUE=6 START_SESSION=3` → for issue #6 start at Session 3; all later issues start at Session 1.

---

## Step 1: Setup

Run all of the following via Bash before the main loop.

### 1a. Hard dependency check

```bash
command -v jq      &>/dev/null || { echo "ERROR: 'jq' not found. Install jq and re-run."; exit 1; }
command -v gh      &>/dev/null || { echo "ERROR: 'gh' not found. Install GitHub CLI and re-run."; exit 1; }
command -v python3 &>/dev/null || { echo "ERROR: 'python3' not found. Install Python 3 and re-run."; exit 1; }
```

### 1b. Auto-detect project path and repo slug

```bash
PROJECT_PATH="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "ERROR: Not inside a git repo."; exit 1; }
REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || { echo "ERROR: gh not configured or no remote."; exit 1; }
echo "Project : $PROJECT_PATH"
echo "Repo    : $REPO_SLUG"
```

### 1c. Ensure labels exist

```bash
for label in "in-progress" "implemented" "needs-review"; do
  gh label create "$label" --force 2>/dev/null || true
done
```

### 1d. Create directories

```bash
mkdir -p "$PROJECT_PATH/.a5c/plans" "$PROJECT_PATH/.a5c/logs"
```

### 1e. Soft dependency warnings

Check these paths and warn (do not fail) if missing:
- `~/.claude/skills/deep-verify-plan/SKILL.md`
- Superpowers `writing-plans` skill (look in `~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/writing-plans/SKILL.md`)
- Superpowers `verification-before-completion` skill

Warn format: `⚠ Soft dep missing: <name> — sessions will run but skill may not load`

---

## Step 2: Main Loop

Repeat the following until no open issues remain. Track `TOTAL_FIXED=0`, `TOTAL_FAILED=0`, `ITERATION=0`.

### 2a. Get next issue

Run via Bash. Increment `ITERATION`. Print a separator:

```
════════════════════════════════════════════
  Iteration N — fetching next issue...
════════════════════════════════════════════
```

Fetch the next issue (sorted by number ascending, skip those labeled `in-progress` or `needs-review`, skip those with number < `START_ISSUE`):

```bash
gh issue list \
  --state open \
  --limit 50 \
  --json number,title,body,labels \
  --jq "[.[] | select(
          (.labels | map(.name) | (contains([\"in-progress\"]) or contains([\"needs-review\"])) | not)
          and (.number >= $START_ISSUE)
        )] | sort_by(.number) | .[0]"
```

If the result is empty or `null`: print `✓ No more open issues. All done!` with the summary, then exit.

Set from the result: `ISSUE_NUM`, `ISSUE_TITLE`.

Set file paths:
```
BRIEF_FILE = $PROJECT_PATH/.a5c/plans/issue-N-brief.md
SPEC_FILE  = $PROJECT_PATH/.a5c/plans/issue-N-spec.md
PLAN_FILE  = $PROJECT_PATH/.a5c/plans/issue-N-plan.md
```

Print:
```
  Issue #N: <title>
  Brief : $BRIEF_FILE
  Spec  : $SPEC_FILE
  Plan  : $PLAN_FILE
```

### 2b. Write brief file

Use Bash to write the issue brief:
```bash
{
  printf "# Issue #%s: %s\n\n## Body\n\n%s\n" \
    "$ISSUE_NUM" \
    "$(echo "$ISSUE_JSON" | jq -r '.title')" \
    "$(echo "$ISSUE_JSON" | jq -r '.body // "(no body)"')"
} > "$BRIEF_FILE"
```

### 2c. Label in-progress + record start SHA

```bash
gh issue edit "$ISSUE_NUM" --add-label "in-progress" 2>/dev/null || true
IMPL_START_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
```

### 2d. Determine effective start session

For this issue only: if `ISSUE_NUM == START_ISSUE` and `START_SESSION > 1`, set `EFFECTIVE_START_SESSION = START_SESSION`. Otherwise `EFFECTIVE_START_SESSION = 1`.

Create a TaskCreate task: `Issue #N — Session 1: Spec + Deep-Verify`.

---

### Session 1: Spec + Deep-Verify

**Skip if** `EFFECTIVE_START_SESSION > 1`. In that case, validate the existing spec at `SPEC_FILE` using [Gate 1](#gate-1--spec-validation) and skip to Session 2 if valid; if invalid, label `needs-review`, remove `in-progress`, increment `TOTAL_FAILED`, continue to next issue.

**Otherwise**, dispatch via Agent tool:

```
Agent(
  subagent_type: "general-purpose",
  description: "Issue #N — Session 1: Spec + Deep-Verify",
  prompt: <SESSION 1 PROMPT — see Session Prompts section below>
)
```

After the agent completes:
- Run [Gate 1](#gate-1--spec-validation) on `SPEC_FILE`.
- **Gate 1 FAIL** or agent returned indicating rate-limit exhaustion → check output for rate limit signals (`you've hit your usage limit`, `rate limit`, `quota exceeded`). If rate-limited: remove `in-progress` label (do NOT add `needs-review`), skip to next issue. Otherwise (genuine failure): label `needs-review`, remove `in-progress`, increment `TOTAL_FAILED`, continue to next issue.
- **Gate 1 PASS** → proceed to Session 2.

Update task to completed.

---

### Session 2: Writing Plans

Create a TaskCreate task: `Issue #N — Session 2: Writing Plans`.

**Skip if** `EFFECTIVE_START_SESSION > 2`. In that case, validate the existing plan at `PLAN_FILE` using [Gate 2](#gate-2--plan-validation); if invalid, label `needs-review`, remove `in-progress`, increment `TOTAL_FAILED`, continue.

**Otherwise**, dispatch via Agent tool:

```
Agent(
  subagent_type: "general-purpose",
  description: "Issue #N — Session 2: Writing Plans",
  prompt: <SESSION 2 PROMPT — see Session Prompts section below>
)
```

After the agent completes:
- Run [Gate 2](#gate-2--plan-validation) on `PLAN_FILE` (with `SPEC_FILE` for drift check).
- **Gate 2 FAIL**: label `needs-review`, remove `in-progress`, increment `TOTAL_FAILED`, continue to next issue.
- **Gate 2 PASS** → proceed to Session 3.

Update task to completed.

**After processing the resume issue, reset `START_SESSION = 1` for all subsequent issues.**

---

### Session 3: TDD Implementation

Create a TaskCreate task: `Issue #N — Session 3: TDD Implementation`.

Dispatch via Agent tool:

```
Agent(
  subagent_type: "general-purpose",
  description: "Issue #N — Session 3: TDD Implementation",
  prompt: <SESSION 3 PROMPT — see Session Prompts section below>
)
```

After the agent completes:
- Run [Gate 3](#gate-3--implementation-validation) with `IMPL_START_SHA`.
- **Gate 3 PASS**:
  ```bash
  gh issue close "$ISSUE_NUM" \
    --comment "Automatically fixed via 3-session issue-loop skill. Spec: \`.a5c/plans/issue-N-spec.md\` | Plan: \`.a5c/plans/issue-N-plan.md\`." \
    2>/dev/null || true
  gh issue edit "$ISSUE_NUM" --add-label "implemented" --remove-label "in-progress" 2>/dev/null || true
  ```
  Print: `✓ Issue #N FIXED`. Increment `TOTAL_FIXED`.
- **Gate 3 FAIL**: label `needs-review`, remove `in-progress`, increment `TOTAL_FAILED`. Print: `✗ Issue #N failed — needs-review`.

Update task to completed.

---

## Step 3: Loop End / Summary

When `get_next_issue` returns nothing, print:

```
════════════════════════════════════════════
  Fixed  : N  |  Failed : N  |  Iterations: N
════════════════════════════════════════════
```

---

## Session Prompts

Substitute `{ISSUE_NUM}`, `{REPO_SLUG}`, `{BRIEF_FILE}`, `{SPEC_FILE}`, `{PLAN_FILE}` before dispatching.

### Session 1 Prompt

```
You are writing a verified spec for GitHub issue #{ISSUE_NUM} from repo {REPO_SLUG}. The issue brief is at {BRIEF_FILE}.

Your tasks:
(1) Read {BRIEF_FILE} and the full issue with: gh issue view {ISSUE_NUM}
(2) Thoroughly explore the codebase to understand context and root cause.
(3) Write a comprehensive spec to {SPEC_FILE}. The spec must include:
    ## Problem (root cause analysis with exact file:line references)
    ## Acceptance Criteria (numbered, testable)
    ## Proposed Solution (architecture and approach)
    ## Edge Cases & Out of Scope
    ## Test Strategy (what to test and how)
(4) Run babysitter to deeply verify the spec using the deep-verify-plan skill. Invoke it like this:
    /babysitter:yolo Run the deep-plan-verification process via the /deep-verify-plan skill.
      Process file: ~/.a5c/processes/deep-plan-verification.js
      Inputs: planFile={SPEC_FILE}, projectRoot={PROJECT_PATH}, requireApproval=false,
              taskDescription=Deep spec verification for issue #{ISSUE_NUM} — improve quality to 95/100 across 8 dimensions
    Wait for babysitter to complete (it will iterate automatically until score >= 95).
    Save the final verified spec back to {SPEC_FILE}.

Do NOT write any implementation code — this session is spec-only.
```

### Session 2 Prompt

```
You are writing an implementation plan for GitHub issue #{ISSUE_NUM} from repo {REPO_SLUG}. The issue brief is at {BRIEF_FILE}. The verified spec is at {SPEC_FILE}.

Your tasks:
(1) Read {BRIEF_FILE} and {SPEC_FILE} carefully.
(2) Invoke the writing-plans skill explicitly using the Skill tool:
    Skill("superpowers:writing-plans")
    Follow its instructions to convert the spec into a detailed TDD implementation plan.
(3) Save the final plan to {PLAN_FILE}.

The plan must:
- Use checkbox (- [ ]) syntax for every step
- Include exact file paths
- Include real code for every code step (no placeholders)
- Specify exact test commands with expected output
- Include commit steps after each passing test group

Quality bar: minimum 5 task blocks, no TBD/TODO/FIXME anywhere.

Do NOT write any implementation code — plan only.
```

### Session 3 Prompt

```
You are implementing the fix for GitHub issue #{ISSUE_NUM} from repo {REPO_SLUG}.
- Issue brief : {BRIEF_FILE}
- Verified spec: {SPEC_FILE}
- Implementation plan: {PLAN_FILE}

Your tasks:
(1) Read {BRIEF_FILE}, {SPEC_FILE}, and {PLAN_FILE} carefully. Also run: gh issue view {ISSUE_NUM}
(2) Before writing any code, run /coding-standards to load the team coding standards — all code you write MUST comply with those standards.
(3) Execute the plan using strict TDD: for each task, write a failing test first, then implement the minimum code to make it pass.
(4) TESTING STRATEGY — detect whether the issue touches frontend (any .tsx/.ts React files, UI components, pages, hooks):
    - If YES: write Playwright CLI tests using 'npx playwright test' (write test files under frontend/tests/ or e2e/, run with 'npx playwright test').
    - If backend only: use pytest.
    - If both: use both.
(5) Commit after each passing test group with a clear message referencing issue #{ISSUE_NUM}.
(6) Push after every commit.
(7) Maintain babysitter quality score above 95 throughout.
(8) Run the full test suite before finishing.
(9) Invoke the verification-before-completion skill explicitly as the final QA gate:
    Skill("superpowers:verification-before-completion")
    Follow its instructions exactly. Fix every issue it raises before continuing.
(10) All changes must be production-ready with no regressions.

Do NOT close the issue yourself — the runner closes it on success.
```

---

## Quality Gates

### Gate 1 — Spec Validation

Run via Bash after Session 1:

```bash
# Hard fail: file missing or empty
[ -s "$SPEC_FILE" ] || { echo "✗ Gate 1 FAIL: spec file missing or empty"; exit 1; }

# Hard fail: too short
char_count=$(wc -c < "$SPEC_FILE")
[ "$char_count" -lt 800 ] && { echo "✗ Gate 1 FAIL: spec too short (${char_count} chars < 800)"; exit 1; }

# Warnings: expected section headings
missing=()
grep -qi "## .*problem\|## .*root cause\|## .*issue" "$SPEC_FILE" || missing+=("Problem/Root Cause")
grep -qi "## .*accept\|## .*criteria\|## .*done\|## .*goal" "$SPEC_FILE" || missing+=("Acceptance Criteria/Goal")
grep -qi "## .*edge\|## .*corner\|## .*scope\|## .*out.of" "$SPEC_FILE" || missing+=("Edge Cases/Scope")
[ ${#missing[@]} -gt 0 ] && echo "⚠ Gate 1 WARNING: possible missing sections: ${missing[*]} (continuing — babysitter may use different headings)"

echo "✓ Gate 1 PASS: spec looks valid (${char_count} chars)"
```

### Gate 2 — Plan Validation

Run via Bash after Session 2. Inline Python for placeholder check:

```bash
# Hard fail: file missing
[ -s "$PLAN_FILE" ] || { echo "✗ Gate 2 FAIL: plan file missing or empty"; exit 1; }

# Hard fail: too few task items
task_count=$(grep -cE '^\s*-\s*\[[ x]\]' "$PLAN_FILE" 2>/dev/null || echo 0)
list_count=$(grep -cE '^\s*-\s+\S'       "$PLAN_FILE" 2>/dev/null || echo 0)
if [ "$task_count" -lt 3 ] && [ "$list_count" -lt 5 ]; then
  echo "✗ Gate 2 FAIL: plan has only ${task_count} checkbox / ${list_count} list items"
  exit 1
fi

# Placeholder check via Python (strips code fences; ignores negation context)
py_out=$(python3 - "$PLAN_FILE" 2>&1 <<'PYEOF'
import sys, re
content = open(sys.argv[1], encoding='utf-8', errors='replace').read()
content = re.sub(r'```[\s\S]*?```', '', content)
bad = []
for line in content.split('\n'):
    if re.match(r'^\s*-\s*\[[ x]\]', line):
        continue
    if re.search(r'\b(no|zero|without|not found|none|absence of|free of)\b.{0,60}\b(TBD|TODO|FIXME)\b', line, re.IGNORECASE):
        continue
    if re.search(r'\b(TBD|TODO|FIXME)\b.{0,60}\b(not found|none found|free|clean|absent|zero|0)\b', line, re.IGNORECASE):
        continue
    if re.search(r'\b(TBD|TODO|FIXME)\b|implement later|fill in', line, re.IGNORECASE):
        print(f'  placeholder: {line.strip()[:120]}', file=sys.stderr)
        bad.append(line)
if bad:
    sys.exit(1)
PYEOF
)
if [ $? -ne 0 ]; then
  echo "✗ Gate 2 FAIL: plan contains placeholder text (TBD/TODO/FIXME)"
  [ -n "$py_out" ] && echo "$py_out"
  exit 1
fi

# Drift check: spec file paths vs plan (warning only)
if [ -s "$SPEC_FILE" ]; then
  matched=0 total=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    total=$((total + 1))
    grep -qF "$f" "$PLAN_FILE" 2>/dev/null && matched=$((matched + 1))
  done < <(grep -oE '[a-zA-Z0-9_/-]+\.[a-zA-Z]{2,4}' "$SPEC_FILE" 2>/dev/null | grep -vE '^\.' | sort -u | head -20)
  if [ "$total" -gt 0 ] && [ "$matched" -eq 0 ]; then
    echo "⚠ Gate 2 WARNING: plan references none of the ${total} file paths mentioned in spec — possible drift"
  elif [ "$total" -gt 0 ]; then
    echo "✓ Gate 2: plan covers ${matched}/${total} file paths from spec"
  fi
fi

echo "✓ Gate 2 PASS: plan looks valid (${task_count} task items)"
```

### Gate 3 — Implementation Validation

Run via Bash after Session 3:

```bash
# Hard fail: no new commits
current_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
if [ -z "$current_sha" ] || [ "$current_sha" = "$IMPL_START_SHA" ]; then
  echo "✗ Gate 3 FAIL: no new commits since session start"
  exit 1
fi
new_commits=$(git log --oneline "${IMPL_START_SHA}..HEAD" 2>/dev/null | wc -l || echo 0)
echo "✓ Gate 3 PASS: ${new_commits} new commit(s)"

# Push any unpushed commits
if git rev-parse -q --verify "@{u}" >/dev/null 2>&1; then
  unpushed=$(git log --oneline "@{u}..HEAD" 2>/dev/null | wc -l || echo 0)
else
  unpushed=$(git log --oneline "origin/HEAD..HEAD" 2>/dev/null | wc -l || echo 0)
fi
if [ "$unpushed" -gt 0 ]; then
  echo "↑ Pushing ${unpushed} unpushed commit(s)..."
  git push 2>/dev/null && echo "✓ Push successful" || echo "⚠ Push failed — may need manual push"
fi
```

---

## Failure Handling

| Scenario | Behavior |
|---|---|
| Gate 1 fail | Label `needs-review`, remove `in-progress`, `TOTAL_FAILED++`, continue to next issue |
| Gate 2 fail | Label `needs-review`, remove `in-progress`, `TOTAL_FAILED++`, continue to next issue |
| Gate 3 fail | Label `needs-review`, remove `in-progress`, `TOTAL_FAILED++`, continue to next issue |
| Agent output contains rate-limit signal | Remove `in-progress`, do NOT label `needs-review`, skip issue and continue |
| No open issues | Exit cleanly with summary |

**Rate-limit detection in agent output:** look for any of these patterns in the agent's response:
- `you've hit your usage limit` / `you've hit your session limit`
- `rate limit` / `rate-limited`
- `usage limit reached` / `quota exceeded`
- `limit.*reset`

If detected, the issue is skipped without the `needs-review` label (it will be retried next time you run `/issue-loop`).

---

## Notes

- The skill auto-detects repo root and slug — works in any git repo with a GitHub remote.
- All orchestration (issue selection, session start, gate result, label changes) is printed inline in the CC terminal.
- Babysitter sessions handle quality convergence internally (score ≥ 95) using the babysitter:yolo process.
- `START_SESSION` only applies to the first issue processed; all subsequent issues always start at Session 1.
