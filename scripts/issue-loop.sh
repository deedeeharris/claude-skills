#!/usr/bin/env bash
# ============================================================
# issue-loop.sh — Auto-fix GitHub issues with 3-session babysitter pipeline
#
# For each open GitHub issue (oldest first):
#   Session 1: Spec + /deep-verify-plan  → .a5c/plans/issue-N-spec.md
#   Session 2: /writing-plans            → .a5c/plans/issue-N-plan.md
#   Session 3: TDD + /verification-before-completion → commits + push
#
# On success  → closes issue, labels "implemented"
# On failure  → labels "needs-review", continues to next issue
# Rate limit  → pauses until reset, retries same session (up to 5×)
# Stops when  → no more open issues (excluding needs-review/in-progress)
#
# USAGE (Git Bash / WSL / Linux / macOS):
#   bash issue-loop.sh              # auto-detects repo root
#
# Copy this script to the root of any git repo and run it.
# Requires: claude CLI, gh CLI, jq, python3
#
# Soft requirements (warnings if missing, not hard failures):
#   superpowers:writing-plans, superpowers:verification-before-completion,
#   deep-verify-plan skill, babysitter:deep-plan-verification process
#
# WARNING: This script runs Claude with --dangerously-skip-permissions,
# which bypasses all permission prompts and gives Claude full access
# to read, write, and execute files on this machine. Only run this
# in a trusted environment on code you own.
# ============================================================

set -euo pipefail

# ── hard dependency checks ───────────────────────────────────
command -v jq      &>/dev/null || { printf "ERROR: 'jq' not found in PATH. Install jq and re-run.\n"; exit 1; }
command -v gh      &>/dev/null || { printf "ERROR: 'gh' not found in PATH. Install GitHub CLI and re-run.\n"; exit 1; }
command -v claude  &>/dev/null || { printf "ERROR: 'claude' not found in PATH. Install Claude CLI and re-run.\n"; exit 1; }
command -v python3 &>/dev/null || { printf "ERROR: 'python3' not found in PATH. Install Python 3 and re-run.\n"; exit 1; }

# ── auto-detect repo root ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || { printf "ERROR: Not inside a git repo\n"; exit 1; })"
REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || { printf "ERROR: gh not configured or no remote\n"; exit 1; })"

LABEL_IN_PROGRESS="in-progress"
LABEL_DONE="implemented"
LABEL_FAILED="needs-review"
RATE_LIMIT_SLEEP=3600        # fallback sleep when reset time cannot be parsed

# ── resume support ───────────────────────────────────────────
# Set START_ISSUE to skip all issues with number < this value.
# Set START_SESSION to skip sessions 1..(N-1) for the first issue processed.
# After the first issue is processed normally, START_SESSION resets to 1.
# Examples:
#   START_ISSUE=5              → start from issue #5 (skip #1–#4)
#   START_ISSUE=3 START_SESSION=3  → skip to Session 3 of issue #3
START_ISSUE=${START_ISSUE:-1}
START_SESSION=${START_SESSION:-1}

# ── colors + logging ─────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

LOG_DIR="$PROJECT_PATH/.a5c/logs"
LOG_FILE="$LOG_DIR/issue-loop-$(date +%Y%m%d-%H%M%S).log"
PLANS_DIR="$PROJECT_PATH/.a5c/plans"

mkdir -p "$LOG_DIR" "$PLANS_DIR"
cd "$PROJECT_PATH"

log() { printf "%b\n" "$1" | tee -a "$LOG_FILE"; }

log ""
log "${BOLD}============================================${NC}"
log "${BOLD}  issue-loop.sh — 3-Session Auto Issue Fixer${NC}"
log "${BOLD}============================================${NC}"
log "  Repo    : ${BLUE}$REPO_SLUG${NC}"
log "  Project : $PROJECT_PATH"
log "  Log     : $LOG_FILE"
log "  Started : $(date '+%Y-%m-%d %H:%M:%S')"
log "${BOLD}============================================${NC}"

# ── soft dependency checks ───────────────────────────────────
warn_dep() {
  local name=$1 path=$2
  if [ ! -e "$path" ]; then
    log "${YELLOW}  ⚠  Soft dep missing: ${BOLD}${name}${NC}${YELLOW} — sessions will still run but skill may not load${NC}"
    log "     Expected at: $path"
  fi
}

SP_BASE=$(ls -d "$HOME/.claude/plugins/cache/claude-plugins-official/superpowers"/*/skills 2>/dev/null \
           | sort -V | tail -1 || echo "")

warn_dep "superpowers:writing-plans"                  "${SP_BASE}/writing-plans/SKILL.md"
warn_dep "superpowers:verification-before-completion" "${SP_BASE}/verification-before-completion/SKILL.md"
warn_dep "/deep-verify-plan skill"                    "$HOME/.claude/skills/deep-verify-plan/SKILL.md"

# ── ensure labels exist in repo ──────────────────────────────
for label in "$LABEL_IN_PROGRESS" "$LABEL_DONE" "$LABEL_FAILED"; do
  gh label create "$label" --force 2>/dev/null || true
done

# ── rate-limit helpers ───────────────────────────────────────

# Multi-pattern rate limit detection — Claude Code expresses this in several ways
# Note: Claude uses Unicode right-single-quote (') in "You've" — use .{0,2} to match any apostrophe variant
is_rate_limited() {
  grep -qiE "(you.{0,2}ve hit your (usage |session )?limit|hit your.*limit|rate.?limit(ed)?|usage limit reached|quota exceeded|limit.{0,30}reset)" "$1" 2>/dev/null
}

# Parse "Xpm" / "X:XXam" reset time from output file, return seconds to sleep
parse_reset_seconds() {
  local output_file=$1
  local reset_str
  reset_str=$(grep -oiE '[0-9]{1,2}(:[0-9]{2})?[ap]m' "$output_file" 2>/dev/null | head -1)
  [ -z "$reset_str" ] && { echo $RATE_LIMIT_SLEEP; return; }
  python3 - "$reset_str" <<'PYEOF'
import sys, re
from datetime import datetime, timezone, timedelta
reset_str = sys.argv[1].lower()
try:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Asia/Jerusalem")
    now = datetime.now(tz)
except Exception:
    tz = timezone(timedelta(hours=3))
    now = datetime.now(tz)
m = re.match(r'(\d+)(?::(\d+))?(am|pm)', reset_str)
if not m:
    print(3600); sys.exit()
hour, minute, period = int(m.group(1)), int(m.group(2) or 0), m.group(3)
if period == 'pm' and hour != 12: hour += 12
elif period == 'am' and hour == 12: hour = 0
reset = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
if reset <= now:
    reset = reset + timedelta(days=1)
diff = int((reset - now).total_seconds()) + 120
print(max(diff, 60))
PYEOF
}

# ── quality gates ────────────────────────────────────────────

# Gate 1: spec file exists, has expected sections, is substantial enough
validate_spec() {
  local spec_file=$1
  if [ ! -s "$spec_file" ]; then
    log "${RED}  ✗ Gate 1 FAIL: spec file missing or empty: $spec_file${NC}"
    return 1
  fi
  local char_count
  char_count=$(wc -c < "$spec_file")
  if [ "$char_count" -lt 800 ]; then
    log "${RED}  ✗ Gate 1 FAIL: spec too short (${char_count} chars < 800). Not a real spec.${NC}"
    return 1
  fi
  local missing_sections=()
  grep -qi "## .*problem\|## .*root cause\|## .*issue" "$spec_file" || missing_sections+=("Problem/Root Cause")
  grep -qi "## .*accept\|## .*criteria\|## .*done\|## .*goal" "$spec_file" || missing_sections+=("Acceptance Criteria/Goal")
  grep -qi "## .*edge\|## .*corner\|## .*scope\|## .*out.of" "$spec_file" || missing_sections+=("Edge Cases/Scope")
  if [ ${#missing_sections[@]} -gt 0 ]; then
    log "${YELLOW}  ⚠ Gate 1 WARNING: spec may be missing sections: ${missing_sections[*]}${NC}"
    log "     (continuing — babysitter may have used different headings)"
  fi
  log "${GREEN}  ✓ Gate 1 PASS: spec file looks valid (${char_count} chars)${NC}"
  return 0
}

# Gate 2: plan file exists, substantial, has task items, no placeholders, not drifted from spec
validate_plan() {
  local plan_file=$1
  local spec_file=${2:-}   # optional: used for drift check

  if [ ! -s "$plan_file" ]; then
    log "${RED}  ✗ Gate 2 FAIL: plan file missing or empty: $plan_file${NC}"
    return 1
  fi

  local task_count list_count
  # Count checkbox items (- [ ]) AND plain list items (fallback for different plan styles)
  task_count=$(grep -cE '^\s*-\s*\[[ x]\]' "$plan_file" 2>/dev/null || echo 0)
  list_count=$(grep -cE '^\s*-\s+\S' "$plan_file" 2>/dev/null || echo 0)
  if [ "$task_count" -lt 3 ] && [ "$list_count" -lt 5 ]; then
    log "${RED}  ✗ Gate 2 FAIL: plan has only ${task_count} checkbox items / ${list_count} list items. Incomplete plan.${NC}"
    return 1
  fi

  # Placeholder check via Python: strips code fences and negation context before flagging.
  # Pure grep would false-positive on "zero TBD/TODO/FIXME" (summary prose) or grep commands
  # inside code blocks that search for those words — both of which /writing-plans produces.
  local _py_stderr
  _py_stderr=$(python3 - "$plan_file" 2>&1 <<'PYEOF'
import sys, re
content = open(sys.argv[1], encoding='utf-8', errors='replace').read()
# Strip fenced code blocks (```...```) — their content is commands, not placeholders
content = re.sub(r'```[\s\S]*?```', '', content)
bad = []
for line in content.split('\n'):
    # Skip checklist lines (- [ ] / - [x]) — may reference these words in task names
    if re.match(r'^\s*-\s*\[[ x]\]', line):
        continue
    # Skip negation context: "no/zero/without TBD", "TBD not found", "zero TODO", etc.
    if re.search(r'\b(no|zero|without|not found|none|absence of|free of)\b.{0,60}\b(TBD|TODO|FIXME)\b', line, re.IGNORECASE):
        continue
    if re.search(r'\b(TBD|TODO|FIXME)\b.{0,60}\b(not found|none found|free|clean|absent|zero|0)\b', line, re.IGNORECASE):
        continue
    # Real placeholder — flag it
    if re.search(r'\b(TBD|TODO|FIXME)\b|implement later|fill in', line, re.IGNORECASE):
        print(f'  placeholder: {line.strip()[:120]}', file=sys.stderr)
        bad.append(line)
if bad:
    sys.exit(1)
PYEOF
  )
  if [ $? -ne 0 ]; then
    log "${RED}  ✗ Gate 2 FAIL: plan contains placeholder text (TBD/TODO/FIXME).${NC}"
    [ -n "$_py_stderr" ] && log "$_py_stderr"
    return 1
  fi

  # Drift check: at least some file paths from spec should appear in plan
  if [ -n "$spec_file" ] && [ -s "$spec_file" ]; then
    local matched=0 total=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      total=$((total + 1))
      grep -qF "$f" "$plan_file" 2>/dev/null && matched=$((matched + 1))
    done < <(grep -oE '[a-zA-Z0-9_/-]+\.[a-zA-Z]{2,4}' "$spec_file" 2>/dev/null | grep -vE '^\.' | sort -u | head -20)
    if [ "$total" -gt 0 ] && [ "$matched" -eq 0 ]; then
      log "${YELLOW}  ⚠ Gate 2 WARNING: plan references none of the ${total} file paths mentioned in spec — possible spec/plan drift${NC}"
    elif [ "$total" -gt 0 ]; then
      log "${GREEN}  ✓ Gate 2: plan covers ${matched}/${total} file paths from spec${NC}"
    fi
  fi

  log "${GREEN}  ✓ Gate 2 PASS: plan looks valid (${task_count} task items)${NC}"
  return 0
}

# Gate 3: implementation produced new commits, pushed, and no test failures in output
validate_implementation() {
  local start_sha=$1
  local output_file=${2:-}   # optional: session output file for test result check

  local current_sha
  current_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$current_sha" ] || [ "$current_sha" = "$start_sha" ]; then
    log "${RED}  ✗ Gate 3 FAIL: no new commits since session start. Nothing was implemented.${NC}"
    return 1
  fi
  local new_commits
  new_commits=$(git log --oneline "${start_sha}..HEAD" 2>/dev/null | wc -l || echo 0)
  log "${GREEN}  ✓ Gate 3 PASS: ${new_commits} new commit(s) since session start${NC}"

  # Test result check: scan session output for failure signals
  if [ -n "$output_file" ] && [ -s "$output_file" ]; then
    local fail_count pass_count
    fail_count=$(grep -cE '\b(FAILED|ERROR)\b|[0-9]+ failed|test.*failed|AssertionError' "$output_file" 2>/dev/null || echo 0)
    pass_count=$(grep -cE '[0-9]+ passed|\bPASSED\b|all tests pass(ed)?|✓ [0-9]+' "$output_file" 2>/dev/null || echo 0)
    if [ "$fail_count" -gt 0 ] && [ "$pass_count" -eq 0 ]; then
      log "${RED}  ✗ Gate 3 FAIL: test failures detected in session output (${fail_count} failure signals, 0 pass signals)${NC}"
      return 1
    elif [ "$fail_count" -gt 0 ]; then
      log "${YELLOW}  ⚠ Gate 3 WARNING: mixed test signals (${fail_count} fail / ${pass_count} pass) — review manually${NC}"
    elif [ "$pass_count" -gt 0 ]; then
      log "${GREEN}  ✓ Gate 3: ${pass_count} test-pass signal(s) found in output${NC}"
    fi
  fi

  # Push any unpushed commits (handle branches without upstream)
  local unpushed
  if git rev-parse -q --verify "@{u}" >/dev/null 2>&1; then
    unpushed=$(git log --oneline "@{u}..HEAD" 2>/dev/null | wc -l || echo 0)
  else
    unpushed=$(git log --oneline "origin/HEAD..HEAD" 2>/dev/null | wc -l || echo 0)
  fi
  if [ "$unpushed" -gt 0 ]; then
    log "${YELLOW}  ↑ Pushing ${unpushed} unpushed commit(s)...${NC}"
    git push 2>/dev/null && log "${GREEN}  ✓ Push successful${NC}" || \
      log "${YELLOW}  ⚠ Push failed — will continue (may need manual push)${NC}"
  fi
  return 0
}

# ── helpers ──────────────────────────────────────────────────
get_next_issue() {
  gh issue list \
    --state open \
    --limit 50 \
    --json number,title,body,labels \
    --jq "[.[] | select(
            (.labels | map(.name) | (contains([\"$LABEL_IN_PROGRESS\"]) or contains([\"$LABEL_FAILED\"])) | not)
            and (.number >= $START_ISSUE)
          )] | sort_by(.number) | .[0]" \
    2>/dev/null || echo "null"
}

label_issue() {
  local num=$1 add=$2 remove=${3:-}
  if [ -n "$add" ]; then
    gh issue edit "$num" --add-label "$add" 2>/dev/null || true
  fi
  if [ -n "$remove" ]; then
    gh issue edit "$num" --remove-label "$remove" 2>/dev/null || true
  fi
}

run_session() {
  local session_label=$1
  local prompt=$2
  local save_output=${3:-}   # optional: path to save session output for post-analysis

  log ""
  log "${BOLD}${BLUE}  ▶ $session_label${NC}"
  log "    Started : $(date '+%Y-%m-%d %H:%M:%S')"
  log "    Prompt  : ${prompt:0:120}..."
  log ""

  local session_start; session_start=$(date +%s)
  local tmp_out; tmp_out=$(mktemp)

  claude --dangerously-skip-permissions -p "/babysitter:yolo $prompt" 2>&1 | tee -a "$LOG_FILE" | tee "$tmp_out"
  local exit_code=${PIPESTATUS[0]}
  local duration=$(( $(date +%s) - session_start ))

  # Detect rate limit — return 42, caller will sleep+retry
  if is_rate_limited "$tmp_out"; then
    RATE_LIMIT_SLEEP=$(parse_reset_seconds "$tmp_out")
    rm -f "$tmp_out"
    log "${YELLOW}  ⏸  Rate limited — resets in ${RATE_LIMIT_SLEEP}s. Will retry.${NC}"
    return 42
  fi

  # Save output for gate analysis if requested
  if [ -n "$save_output" ]; then
    cp "$tmp_out" "$save_output" 2>/dev/null || true
  fi
  rm -f "$tmp_out"

  if [ $exit_code -eq 0 ]; then
    log "${GREEN}  ✓ $session_label DONE${NC} (${duration}s)"
  else
    log "${RED}  ✗ $session_label FAILED${NC} (exit $exit_code, ${duration}s)"
  fi

  return $exit_code
}

run_with_retry() {
  local session_label=$1
  local prompt=$2
  local save_output=${3:-}   # forwarded to run_session
  local max_rl_retries=5
  local rl_attempts=0

  while [ $rl_attempts -le $max_rl_retries ]; do
    local rc=0
    run_session "$session_label" "$prompt" "$save_output" || rc=$?  # || prevents set -e from killing the script
    if [ $rc -eq 42 ]; then
      rl_attempts=$((rl_attempts + 1))
      log "${YELLOW}  ⏸  Rate limit hit (attempt $rl_attempts/$max_rl_retries). Sleeping ${RATE_LIMIT_SLEEP}s...${NC}"
      log "  Will resume at: $(date -d "+${RATE_LIMIT_SLEEP} seconds" '+%Y-%m-%d %H:%M:%S' 2>/dev/null \
            || date -v +${RATE_LIMIT_SLEEP}S '+%Y-%m-%d %H:%M:%S' 2>/dev/null \
            || echo '(unknown)')"
      sleep "$RATE_LIMIT_SLEEP"
      log "${YELLOW}  Retrying: $session_label${NC}"
    else
      return $rc
    fi
  done

  log "${RED}  Max rate-limit retries ($max_rl_retries) exceeded for: $session_label${NC}"
  return 43   # 43 = rate-limit exhaustion (distinct from session failure = 1)
}

# ── main loop ────────────────────────────────────────────────
ITERATION=0
TOTAL_FIXED=0
TOTAL_FAILED=0
LOOP_START=$(date +%s)

while true; do
  ITERATION=$((ITERATION + 1))

  log ""
  log "${BOLD}════════════════════════════════════════════${NC}"
  log "${BOLD}  Iteration $ITERATION — fetching next issue...${NC}"
  log "${BOLD}════════════════════════════════════════════${NC}"

  ISSUE_JSON=$(get_next_issue)

  if [ -z "$ISSUE_JSON" ] || [ "$ISSUE_JSON" = "null" ]; then
    log ""
    log "${GREEN}${BOLD}  No more open issues. All done!${NC}"
    break
  fi

  ISSUE_NUM=$(echo "$ISSUE_JSON" | jq -r '.number')
  ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')


  BRIEF_FILE="$PLANS_DIR/issue-${ISSUE_NUM}-brief.md"
  SPEC_FILE="$PLANS_DIR/issue-${ISSUE_NUM}-spec.md"
  PLAN_FILE="$PLANS_DIR/issue-${ISSUE_NUM}-plan.md"

  # Write issue content to a file — avoids shell escaping/injection problems
  {
    printf "# Issue #%s: %s\n\n## Body\n\n%s\n" \
      "$ISSUE_NUM" \
      "$(echo "$ISSUE_JSON" | jq -r '.title')" \
      "$(echo "$ISSUE_JSON" | jq -r '.body // "(no body)"')"
  } > "$BRIEF_FILE"

  log ""
  log "  ${BOLD}Issue #${ISSUE_NUM}:${NC} $ISSUE_TITLE"
  log "  Brief     : $BRIEF_FILE"
  log "  Spec file : $SPEC_FILE"
  log "  Plan file : $PLAN_FILE"

  # Mark in-progress
  label_issue "$ISSUE_NUM" "$LABEL_IN_PROGRESS"

  ISSUE_START=$(date +%s)
  IMPL_START_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

  # Determine the effective start session for this issue (only applies to the first issue processed)
  EFFECTIVE_START_SESSION=1
  if [ "$ISSUE_NUM" -eq "$START_ISSUE" ] && [ "$START_SESSION" -gt 1 ]; then
    EFFECTIVE_START_SESSION=$START_SESSION
    log "  ${YELLOW}Resuming issue #${ISSUE_NUM} from Session ${EFFECTIVE_START_SESSION} (START_SESSION=${START_SESSION})${NC}"
  fi

  # ──────────────────────────────────────────────────────────────
  # SESSION 1: Spec + /deep-verify-plan
  # ──────────────────────────────────────────────────────────────
  SESSION1_PROMPT="You are writing a verified spec for GitHub issue #${ISSUE_NUM} from repo ${REPO_SLUG}. The issue brief is at ${BRIEF_FILE}. Your tasks: (1) Read ${BRIEF_FILE} and the full issue with: gh issue view ${ISSUE_NUM} (2) Thoroughly explore the codebase to understand context and root cause. (3) Write a comprehensive spec to ${SPEC_FILE}. The spec must include: ## Problem (root cause analysis with exact file:line references), ## Acceptance Criteria (numbered, testable), ## Proposed Solution (architecture and approach), ## Edge Cases & Out of Scope, ## Test Strategy (what to test and how). (4) Run /deep-verify-plan on the spec iteratively until quality score reaches 95/100. Keep improving until it passes. Save the final verified spec back to ${SPEC_FILE}. Do NOT write any implementation code — this session is spec-only."

  log ""
  log "${BOLD}  ── Session 1: Spec + Deep-Verify ──${NC}"

  if [ "$EFFECTIVE_START_SESSION" -gt 1 ]; then
    log "  ${YELLOW}  Skipping Session 1 (resuming from Session ${EFFECTIVE_START_SESSION}) — using existing spec: ${SPEC_FILE}${NC}"
    if ! validate_spec "$SPEC_FILE"; then
      log "${RED}  Resume failed: existing spec invalid — re-run without START_SESSION to rebuild.${NC}"
      label_issue "$ISSUE_NUM" "$LABEL_FAILED" "$LABEL_IN_PROGRESS"
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      continue
    fi
  else
    S1_RC=0
    run_with_retry "Session 1 / Issue #${ISSUE_NUM}: Spec + Deep-Verify" "$SESSION1_PROMPT" || S1_RC=$?
    if [ $S1_RC -eq 43 ]; then
      log "${YELLOW}  ⏸  Session 1 rate-limit exhausted for issue #${ISSUE_NUM} — skipping (not marking failed)${NC}"
      label_issue "$ISSUE_NUM" "" "$LABEL_IN_PROGRESS"
      continue
    fi
    if ! { [ $S1_RC -eq 0 ] && validate_spec "$SPEC_FILE"; }; then
      log "${RED}  Session 1 failed for issue #${ISSUE_NUM} — labeling needs-review${NC}"
      label_issue "$ISSUE_NUM" "$LABEL_FAILED" "$LABEL_IN_PROGRESS"
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      continue
    fi
  fi

  # ──────────────────────────────────────────────────────────────
  # SESSION 2: /writing-plans — implementation plan
  # ──────────────────────────────────────────────────────────────
  SESSION2_PROMPT="You are writing an implementation plan for GitHub issue #${ISSUE_NUM} from repo ${REPO_SLUG}. The issue brief is at ${BRIEF_FILE}. The verified spec is at ${SPEC_FILE}. Your tasks: (1) Read ${BRIEF_FILE} and ${SPEC_FILE} carefully. (2) Use /writing-plans to convert the spec into a detailed TDD implementation plan. (3) Save the final plan to ${PLAN_FILE}. The plan must: use checkbox (- [ ]) syntax for every step, include exact file paths, include real code for every code step (no placeholders), specify exact test commands with expected output, include commit steps after each passing test group. Quality bar: minimum 5 task blocks, no TBD/TODO/FIXME anywhere. Do NOT write any implementation code — plan only."

  log ""
  log "${BOLD}  ── Session 2: /writing-plans ──${NC}"

  if [ "$EFFECTIVE_START_SESSION" -gt 2 ]; then
    log "  ${YELLOW}  Skipping Session 2 (resuming from Session ${EFFECTIVE_START_SESSION}) — using existing plan: ${PLAN_FILE}${NC}"
    if ! validate_plan "$PLAN_FILE" "$SPEC_FILE"; then
      log "${RED}  Resume failed: existing plan invalid — re-run without START_SESSION to rebuild.${NC}"
      label_issue "$ISSUE_NUM" "$LABEL_FAILED" "$LABEL_IN_PROGRESS"
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      continue
    fi
  else
    S2_RC=0
    run_with_retry "Session 2 / Issue #${ISSUE_NUM}: Writing Plans" "$SESSION2_PROMPT" || S2_RC=$?
    if [ $S2_RC -eq 43 ]; then
      log "${YELLOW}  ⏸  Session 2 rate-limit exhausted for issue #${ISSUE_NUM} — skipping (not marking failed)${NC}"
      label_issue "$ISSUE_NUM" "" "$LABEL_IN_PROGRESS"
      continue
    fi
    if ! { [ $S2_RC -eq 0 ] && validate_plan "$PLAN_FILE" "$SPEC_FILE"; }; then
      log "${RED}  Session 2 failed for issue #${ISSUE_NUM} — labeling needs-review${NC}"
      label_issue "$ISSUE_NUM" "$LABEL_FAILED" "$LABEL_IN_PROGRESS"
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      continue
    fi
  fi

  # After the resume issue, all subsequent issues start from Session 1
  START_SESSION=1

  # ──────────────────────────────────────────────────────────────
  # SESSION 3: TDD implementation + /verification-before-completion
  # ──────────────────────────────────────────────────────────────
  SESSION3_PROMPT="You are implementing the fix for GitHub issue #${ISSUE_NUM} from repo ${REPO_SLUG}. The issue brief is at ${BRIEF_FILE}. The verified spec is at ${SPEC_FILE}. The implementation plan is at ${PLAN_FILE}. Your tasks: (1) Read ${BRIEF_FILE}, ${SPEC_FILE}, and ${PLAN_FILE} carefully. Also run: gh issue view ${ISSUE_NUM} (2) Before writing any code, run /ems-coding-standards to load the team coding standards — all code you write MUST comply with those standards (naming, file size, interfaces over types, no comments, etc.). (3) Execute the plan using strict TDD: for each task, write a failing test first, then implement the minimum code to make it pass. (4) TESTING STRATEGY — detect whether the issue touches frontend (any .tsx/.ts React files, UI components, pages, hooks): if YES, write Playwright CLI tests using 'npx playwright test' (NOT the old playwright-skill executor — use the standard CLI with @playwright/test, write test files under frontend/tests/ or e2e/, run with 'npx playwright test'). If the issue touches backend only, use pytest. If it touches both, use both. (5) Commit after each passing test group with a clear message referencing issue #${ISSUE_NUM}. (6) Push after every commit. (7) Maintain babysitter quality score above 95 throughout. (8) Run the full test suite before finishing. (9) Run /verification-before-completion as the final QA gate — fix any issues it raises. (10) All changes must be production-ready with no regressions. Do NOT close the issue yourself — the runner closes it on success."

  log ""
  log "${BOLD}  ── Session 3: TDD + /verification-before-completion ──${NC}"

  S3_OUTPUT="$PLANS_DIR/issue-${ISSUE_NUM}-session3-output.txt"
  S3_RC=0
  run_with_retry "Session 3 / Issue #${ISSUE_NUM}: TDD Implementation" "$SESSION3_PROMPT" "$S3_OUTPUT" || S3_RC=$?
  if [ $S3_RC -eq 43 ]; then
    log "${YELLOW}  ⏸  Session 3 rate-limit exhausted for issue #${ISSUE_NUM} — skipping (not marking failed)${NC}"
    label_issue "$ISSUE_NUM" "" "$LABEL_IN_PROGRESS"
    continue
  fi
  if [ $S3_RC -eq 0 ] && validate_implementation "$IMPL_START_SHA" "$S3_OUTPUT"; then
    ISSUE_DURATION=$(( $(date +%s) - ISSUE_START ))
    log ""
    log "${GREEN}${BOLD}  ✓ Issue #${ISSUE_NUM} FIXED${NC} in ${ISSUE_DURATION}s"
    gh issue close "$ISSUE_NUM" \
      --comment "Automatically fixed via 3-session babysitter pipeline. Spec: \`${SPEC_FILE}\` | Plan: \`${PLAN_FILE}\`." \
      2>/dev/null || true
    label_issue "$ISSUE_NUM" "$LABEL_DONE" "$LABEL_IN_PROGRESS"
    TOTAL_FIXED=$((TOTAL_FIXED + 1))
  else
    log "${RED}  Session 3 failed for issue #${ISSUE_NUM} — labeling needs-review${NC}"
    label_issue "$ISSUE_NUM" "$LABEL_FAILED" "$LABEL_IN_PROGRESS"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi

done

# ── Summary ──────────────────────────────────────────────────
LOOP_DURATION=$(( $(date +%s) - LOOP_START ))
log ""
log "${BOLD}════════════════════════════════════════════${NC}"
log "  ${GREEN}Fixed : $TOTAL_FIXED${NC}  |  ${RED}Failed : $TOTAL_FAILED${NC}  |  Iterations : $ITERATION"
log "  Duration : ${LOOP_DURATION}s"
log "  Log      : $LOG_FILE"
log "${BOLD}════════════════════════════════════════════${NC}"

[ $TOTAL_FAILED -eq 0 ]
