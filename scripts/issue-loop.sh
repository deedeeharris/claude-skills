#!/bin/bash
# ============================================================
# issue-loop.sh — Auto-fix GitHub issues with babysitter + TDD
#
# For each open GitHub issue (oldest first):
#   Session 1: /babysitter:yolo — create & deep-verify a plan
#   Session 2: /babysitter:yolo — TDD implementation, commit+push
#
# On success  → closes issue, labels "implemented"
# On failure  → labels "needs-review", continues to next issue
# Stops when  → no more open issues (excluding needs-review/in-progress)
#
# USAGE (Git Bash / WSL):
#   bash issue-loop.sh              # auto-detects repo root
#
# Copy this script to the root of any git repo and run it.
# Requires: claude CLI, gh CLI, jq
#
# WARNING: This script runs Claude with --dangerously-skip-permissions,
# which bypasses all permission prompts and gives Claude full access
# to read, write, and execute files on this machine. Only run this
# in a trusted environment on code you own.
# ============================================================

set -euo pipefail

# ── dependency checks ────────────────────────────────────────
command -v jq     &>/dev/null || { echo "ERROR: 'jq' not found in PATH. Install jq and re-run."; exit 1; }
command -v gh     &>/dev/null || { echo "ERROR: 'gh' not found in PATH. Install GitHub CLI and re-run."; exit 1; }
command -v claude &>/dev/null || { echo "ERROR: 'claude' not found in PATH. Install Claude CLI and re-run."; exit 1; }

# ── auto-detect repo root ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || { echo "ERROR: Not inside a git repo"; exit 1; })"
REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || { echo "ERROR: gh not configured or no remote"; exit 1; })"

SLEEP_BETWEEN_SESSIONS=900   # 15 min between plan session and implement session
LABEL_IN_PROGRESS="in-progress"
LABEL_DONE="implemented"
LABEL_FAILED="needs-review"

# ── colors + logging ─────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

LOG_DIR="$PROJECT_PATH/.a5c/logs"
LOG_FILE="$LOG_DIR/issue-loop-$(date +%Y%m%d-%H%M%S).log"
PLANS_DIR="$PROJECT_PATH/.a5c/plans"

mkdir -p "$LOG_DIR" "$PLANS_DIR"
cd "$PROJECT_PATH"

log() { echo -e "$1" | tee -a "$LOG_FILE"; }

log ""
log "${BOLD}============================================${NC}"
log "${BOLD}  issue-loop.sh — Auto Issue Fixer${NC}"
log "${BOLD}============================================${NC}"
log "  Repo    : ${BLUE}$REPO_SLUG${NC}"
log "  Project : $PROJECT_PATH"
log "  Log     : $LOG_FILE"
log "  Started : $(date '+%Y-%m-%d %H:%M:%S')"
log "${BOLD}============================================${NC}"

# ── ensure labels exist in repo ──────────────────────────────
for label in "$LABEL_IN_PROGRESS" "$LABEL_DONE" "$LABEL_FAILED"; do
  gh label create "$label" --force 2>/dev/null || true
done

# ── helpers ──────────────────────────────────────────────────
get_next_issue() {
  # Returns JSON of oldest open issue that doesn't have skip labels
  # jq filter: exclude issues that have any of the skip labels
  gh issue list \
    --state open \
    --limit 50 \
    --json number,title,body,labels \
    --jq "[.[] | select(.labels | map(.name) | (contains([\"$LABEL_IN_PROGRESS\"]) or contains([\"$LABEL_FAILED\"])) | not)] | sort_by(.number) | .[0]" \
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

  log ""
  log "${BOLD}${BLUE}  ▶ $session_label${NC}"
  log "    Started : $(date '+%Y-%m-%d %H:%M:%S')"
  log "    Prompt  : ${prompt:0:120}..."
  log ""

  local session_start; session_start=$(date +%s)
  stdbuf -oL -eL claude --dangerously-skip-permissions -p "/babysitter:yolo $prompt" 2>&1 | tee -a "$LOG_FILE"
  local exit_code=${PIPESTATUS[0]}
  local duration=$(( $(date +%s) - session_start ))

  if [ $exit_code -eq 0 ]; then
    log "${GREEN}  ✓ $session_label DONE${NC} (${duration}s)"
  else
    log "${RED}  ✗ $session_label FAILED${NC} (exit $exit_code, ${duration}s)"
  fi

  return $exit_code
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
  PLAN_FILE=".a5c/plans/issue-${ISSUE_NUM}.md"
  BRIEF_FILE=".a5c/plans/issue-${ISSUE_NUM}-brief.md"

  # Write issue content to a file — avoids ALL shell escaping/injection problems
  # when the title/body contains quotes, backticks, $ etc.
  {
    echo "# Issue #${ISSUE_NUM}: $(echo "$ISSUE_JSON" | jq -r '.title')"
    echo ""
    echo "## Body"
    echo ""
    echo "$ISSUE_JSON" | jq -r '.body // "(no body)"'
  } > "$BRIEF_FILE"

  log ""
  log "  ${BOLD}Issue #${ISSUE_NUM}:${NC} $ISSUE_TITLE"
  log "  Brief     : $BRIEF_FILE"
  log "  Plan file : $PLAN_FILE"

  # Mark in-progress
  label_issue "$ISSUE_NUM" "$LABEL_IN_PROGRESS"

  ISSUE_START=$(date +%s)

  # ── SESSION 1: Plan + deep-verify ──────────────────────────
  # Pass file paths instead of raw content — safe from escaping issues
  SESSION1_PROMPT="You are fixing GitHub issue #${ISSUE_NUM} from repo ${REPO_SLUG}. The issue summary is in the file ${BRIEF_FILE}. Your task for this session: (1) Read the brief at ${BRIEF_FILE} and the full issue with: gh issue view ${ISSUE_NUM} (2) Thoroughly explore the codebase to understand the root cause. (3) Write a comprehensive implementation plan to ${PLAN_FILE}. The plan must include: root cause analysis, exact files and line numbers to change, specific code changes needed, TDD test strategy (what tests to write first), edge cases, and rollback plan. (4) Run /deep-verify-plan on the plan iteratively until the quality score reaches 95/100. Keep improving the plan until it passes. Save the final verified plan back to ${PLAN_FILE}."

  if run_session "Session 1 / Issue #${ISSUE_NUM}: Plan + Deep-Verify" "$SESSION1_PROMPT"; then
    SESSION1_OK=true
  else
    SESSION1_OK=false
  fi

  if [ "$SESSION1_OK" = false ]; then
    log "${RED}  Session 1 failed for issue #${ISSUE_NUM} — labeling needs-review, skipping to next${NC}"
    label_issue "$ISSUE_NUM" "$LABEL_FAILED" "$LABEL_IN_PROGRESS"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
    continue
  fi

  # Sleep between sessions
  log ""
  log "${YELLOW}  Sleeping ${SLEEP_BETWEEN_SESSIONS}s before implementation session...${NC}"
  sleep "$SLEEP_BETWEEN_SESSIONS"
  log "${YELLOW}  Sleep done. Starting implementation.${NC}"

  # ── SESSION 2: TDD implementation ──────────────────────────
  SESSION2_PROMPT="You are implementing the fix for GitHub issue #${ISSUE_NUM} from repo ${REPO_SLUG}. The issue summary is at ${BRIEF_FILE}. The verified implementation plan is at ${PLAN_FILE}. Your task: (1) Read ${BRIEF_FILE} and ${PLAN_FILE} carefully. (2) Read the full issue with: gh issue view ${ISSUE_NUM} (3) Implement using strict TDD: write a failing test first, then implement the fix to make it pass, for each change. (4) Commit after each passing test group with a clear message referencing issue #${ISSUE_NUM}. (5) Push after every commit. (6) Maintain babysitter quality score above 95. (7) Run the full test suite before finishing. (8) All changes must be production-ready, with no regressions. Do not close the issue yourself — the runner will close it on success."

  if run_session "Session 2 / Issue #${ISSUE_NUM}: TDD Implementation" "$SESSION2_PROMPT"; then
    ISSUE_DURATION=$(( $(date +%s) - ISSUE_START ))
    log ""
    log "${GREEN}${BOLD}  ✓ Issue #${ISSUE_NUM} FIXED${NC} in ${ISSUE_DURATION}s"
    gh issue close "$ISSUE_NUM" \
      --comment "Automatically fixed via TDD implementation session. Plan: \`${PLAN_FILE}\`." \
      2>/dev/null || true
    label_issue "$ISSUE_NUM" "$LABEL_DONE" "$LABEL_IN_PROGRESS"
    TOTAL_FIXED=$((TOTAL_FIXED + 1))
  else
    log "${RED}  Session 2 failed for issue #${ISSUE_NUM} — labeling needs-review${NC}"
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
