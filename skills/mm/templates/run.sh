#!/usr/bin/env bash
# PM-spawned CC runner — global, args-driven template shipped with the Micromanager (`mm`) skill.
#
# Lives at:  ~/.claude/skills/mm/templates/run.sh
# Tasks do NOT copy this file. Invoke it by absolute path so skill updates propagate.
#
# Usage:
#   run.sh <prompt-abs-path> [<project-root>] [<task-dir>]
#
# Args:
#   $1  ABSOLUTE path to the babysitter prompt .md (required).
#   $2  Optional. Project root (where claude should cd). Default = git toplevel of $1, else <task-dir>.
#       Pass '' (empty) if you only want to override $3.
#   $3  Optional. Task folder where HANDOFF.md / inbox/ / runs/ live.
#       Default = grand-parent of the prompt (assumes <TASK>/prompts/<file>.md).
#
# Env overrides:
#   PROJECT_ROOT          — overrides $2.
#   TASK_DIR              — overrides $3.
#   MM_RUN_AS_ROOT=1 — required to run as uid 0 (refuses otherwise).
#   MM_RUN_DEBUG=1   — log telegram failures + extra diagnostics.
#   IDLE_THRESHOLD_S=480  — kill claude after this many seconds of journal silence.
#   WATCH_INTERVAL_S=30   — watcher poll cadence.
#
# Platform support:
#   Linux  — full support; Bash 4+, GNU coreutils.
#   macOS  — Bash 3.2 OK; uses BSD `stat` fallback. Install jq via Homebrew.
#   WSL / Git Bash on Windows — same as Linux. Run via templates/run.ps1 to spawn a Windows Terminal tab.

set -euo pipefail

# --- Root guard --------------------------------------------------------------
if [ "$(id -u 2>/dev/null || echo 1000)" = "0" ] && [ -z "${MM_RUN_AS_ROOT:-}" ]; then
  echo "❌ Refusing to run as root. Set MM_RUN_AS_ROOT=1 to override." >&2
  exit 1
fi

# --- Resolve args ------------------------------------------------------------

ARG_PROMPT="${1:-}"
ARG_PROJECT_ROOT="${2:-}"
ARG_TASK_DIR="${3:-}"

if [ -z "$ARG_PROMPT" ] || [ ! -f "$ARG_PROMPT" ]; then
  cat <<USAGE >&2
Usage: $0 <prompt-path> [<project-root>] [<task-dir>]

  <prompt-path>    REQUIRED. Absolute path to the babysitter prompt .md file.
  <project-root>   Optional. Repo root the agent should cd into.
                   Default: git toplevel of the task dir, else <task-dir>.
                   Pass '' to skip and still set <task-dir>.
  <task-dir>       Optional. PM task folder containing prompts/ inbox/ runs/ HANDOFF.md.
                   Default: grand-parent of the prompt.

  PROJECT_ROOT and TASK_DIR env vars override the positional defaults.
USAGE
  exit 2
fi

PROMPT_PATH="$(realpath "$ARG_PROMPT")"

# TASK_DIR resolution: env > $3 > derivation.
if [ -n "${TASK_DIR:-}" ]; then
  :
elif [ -n "$ARG_TASK_DIR" ]; then
  TASK_DIR="$ARG_TASK_DIR"
else
  TASK_DIR="$(dirname "$(dirname "$PROMPT_PATH")")"
fi
TASK_DIR="$(realpath "$TASK_DIR")"
RUNS_DIR="$TASK_DIR/runs"
TASK_NAME="$(basename "$TASK_DIR")"

# PROJECT_ROOT resolution: env > $2 > git toplevel > TASK_DIR.
if [ -n "${PROJECT_ROOT:-}" ]; then
  :
elif [ -n "$ARG_PROJECT_ROOT" ]; then
  PROJECT_ROOT="$ARG_PROJECT_ROOT"
elif PROJECT_ROOT_TRY="$(git -C "$TASK_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  PROJECT_ROOT="$PROJECT_ROOT_TRY"
else
  PROJECT_ROOT="$TASK_DIR"
fi
PROJECT_ROOT="$(realpath "$PROJECT_ROOT")"

PROMPT_NAME="$(basename "$PROMPT_PATH" .md)"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$RUNS_DIR/${TS}-${PROMPT_NAME}.log"
RAW_JSONL="$RUNS_DIR/${TS}-${PROMPT_NAME}.jsonl"
mkdir -p "$RUNS_DIR"

cd "$PROJECT_ROOT"

# --- Optional Telegram bookend (skipped if env vars missing) -----------------

DEBUG="${MM_RUN_DEBUG:-0}"
log_debug() { [ "$DEBUG" = "1" ] && echo "[debug] $*" >&2 || true; }

tg_send() {
  local text="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log_debug "Telegram disabled (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset)"
    return 0
  fi
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=$text" || echo "000")
  if [ "$code" != "200" ]; then
    log_debug "Telegram send failed (HTTP $code)"
  fi
}

# Load TELEGRAM_* from common locations.
[ -f ~/.bashrc ]      && eval "$(grep '^export TELEGRAM' ~/.bashrc 2>/dev/null || true)"
[ -f ~/.claude/.env ] && { set -a; . ~/.claude/.env 2>/dev/null || true; set +a; }

tg_send "🤖 Agent — מפעיל ${PROMPT_NAME} (task: ${TASK_NAME}, mode: -p stream-json, headed)"

# --- Banner ------------------------------------------------------------------

echo "============================================================"
echo "🚀 PM auto-launcher — mm/run.sh (global)"
echo "============================================================"
echo "  Task     : $TASK_NAME"
echo "  Prompt   : $PROMPT_PATH"
echo "  Working  : $PROJECT_ROOT"
echo "  Pretty   : $LOG_FILE"
echo "  Raw JSON : $RAW_JSONL"
echo "  Mode     : -p stream-json + jq · --dangerously-skip-permissions"
echo "  Closes   : 5s after the prompt completes (close manually if it hangs)"
echo "============================================================"
echo ""

# --- jq filter for stream-json events ----------------------------------------

JQ_FILTER='
def trunc($n): tostring as $s | if ($s | length) > $n then ($s[0:$n] + "…") else $s end;

# stream_event: emit ONLY incremental text deltas (live typing).
# Tool calls + results come from the full assistant/user messages below — rendering
# them in stream_event AND assistant duplicates output. Heartbeat events
# (`status`, `hook_*`, content_block_start/stop, message_stop, thinking, tool-input
# deltas) are silenced to keep the stream readable.
if (.type == "stream_event") then
  if .event.delta.type? == "text_delta" then .event.delta.text
  else empty end

elif (.type == "assistant") then
  (.message.content // []) | map(
    if .type == "tool_use" then "\n🔧 \(.name)(" + ((.input | tostring) | trunc(120)) + ")\n"
    elif .type == "thinking" then ""
    else empty end                       # text already streamed via text_delta above
  ) | join("")

elif (.type == "user") then
  (.message.content // []) | map(
    if .type == "tool_result" then
      (if (.is_error // false) then "❌ " else "↩️  " end) + ((.content | tostring) | trunc(140)) + "\n"
    else empty end
  ) | join("")

elif (.type == "system") then
  # Show init banner once; suppress all other system events (status, hook_*, etc).
  if .subtype == "init" then "⚙️  session=\(.session_id // "")\n" else empty end

elif (.type == "result") then
  if (.is_error // false) then "\n❌ ERROR: \(.error // .subtype // "")\n"
  else "\n🏁 \(.subtype // "done")" + (if .total_cost_usd then " · cost=$\(.total_cost_usd)" else "" end) + "\n" end

else empty end
'

# --- Tooling preflight -------------------------------------------------------

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq is required but not on PATH." >&2
  echo "   Linux: sudo apt install jq · macOS: brew install jq · Git Bash: pacman -S jq" >&2
  exit 127
fi

# Resolve `claude` to an absolute path NOW, while we still have a normal PATH.
# When spawned through `setsid` (and especially through ptyxis terminals that
# don't source ~/.bashrc), npm-global/bin can be missing → setsid fails with
# "failed to execute claude: No such file or directory". Resolving up-front
# avoids the issue without forcing the user to mutate PATH.
# Resolution order:
#   1. CLAUDE_BIN env var (explicit override — wins over everything)
#   2. `command -v claude` on PATH
#   3. Common install locations (npm global, homebrew, /usr/local)
if [ -n "${CLAUDE_BIN:-}" ]; then
  : # use override as-is; validated below.
elif CLAUDE_BIN="$(command -v claude 2>/dev/null)"; then
  :
else
  CLAUDE_BIN=""
  for cand in "$HOME/.npm-global/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude"; do
    [ -x "$cand" ] && CLAUDE_BIN="$cand" && break
  done
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "❌ claude CLI not found on PATH or in common locations." >&2
  echo "   Install: npm install -g @anthropic-ai/claude-code" >&2
  echo "   Or set CLAUDE_BIN=/abs/path/to/claude before running." >&2
  exit 127
fi
log_debug "claude binary: $CLAUDE_BIN"

if command -v stdbuf >/dev/null 2>&1; then
  STDBUF_PREFIX=(stdbuf -oL -eL)
else
  STDBUF_PREFIX=()
fi

# --- Watcher knobs -----------------------------------------------------------
WATCH_INTERVAL_S="${WATCH_INTERVAL_S:-30}"
IDLE_THRESHOLD_S="${IDLE_THRESHOLD_S:-480}"
PROJECT_RUNS_DIR="$PROJECT_ROOT/.a5c/runs"
LAUNCH_TS=$(date +%s)

file_mtime() {
  if stat -c %Y "$1" >/dev/null 2>&1; then
    stat -c %Y "$1"
  else
    stat -f %m "$1" 2>/dev/null || echo 0
  fi
}

# Find THIS run's dir.
#   $1 = "strict" → require run.json prompt match (used by post-mortem).
#   $1 = "" or "loose" → during bootstrap, allow newest-dir fallback ONLY when there
#                        is exactly one candidate dir created after launch.
find_run_dir() {
  local mode="${1:-loose}"
  [ -d "$PROJECT_RUNS_DIR" ] || return 0
  local d cts matched="" candidates=()
  for d in "$PROJECT_RUNS_DIR"/*/; do
    [ -d "$d" ] || continue
    cts=$(file_mtime "$d")
    { [ -z "$cts" ] || [ "$cts" -lt "$((LAUNCH_TS - 5))" ]; } && continue
    if [ -f "${d}run.json" ] && grep -q -F "$PROMPT_PATH" "${d}run.json" 2>/dev/null; then
      matched="${d%/}"
      break
    fi
    candidates+=("${d%/}")
  done
  if [ -n "$matched" ]; then
    echo "$matched"
    return 0
  fi
  # No prompt-matched run.json yet.
  # In strict mode (post-mortem) refuse to guess.
  [ "$mode" = "strict" ] && return 0
  # Loose mode: fall back ONLY if there's exactly one post-launch candidate.
  if [ "${#candidates[@]}" -eq 1 ]; then
    echo "${candidates[0]}"
  fi
}

# Recent journal files (cap to last 200 to bound scan time on long runs).
recent_journals() {
  ls "$1/journal/"*.json 2>/dev/null | sort | tail -n 200
}

# Any journal contains a terminal event? Portable loop (BSD xargs lacks -r).
is_run_terminal() {
  local d="$1" jrn
  [ -d "$d/journal" ] || return 1
  while IFS= read -r jrn; do
    [ -n "$jrn" ] || continue
    grep -qE '"type"[[:space:]]*:[[:space:]]*"(RUN_COMPLETED|RUN_FAILED|RUN_FATAL)"' "$jrn" && return 0
  done < <(recent_journals "$d")
  return 1
}

# Most recent journal mtime in the recent set (or 0 if none).
newest_journal_mtime() {
  local d="$1" jrn newest=0 m
  while IFS= read -r jrn; do
    m=$(file_mtime "$jrn")
    [ -n "$m" ] && [ "$m" -gt "$newest" ] && newest="$m"
  done < <(recent_journals "$d")
  echo "$newest"
}

# Which terminal event fired? Severity precedence: fatal > failed > completed
# (so a journal that records both completed and a later failure isn't reported as success).
terminal_kind() {
  local d="$1" jrn kind=""
  while IFS= read -r jrn; do
    if grep -qE '"type"[[:space:]]*:[[:space:]]*"RUN_FATAL"' "$jrn"; then
      echo "fatal"; return
    fi
    grep -qE '"type"[[:space:]]*:[[:space:]]*"RUN_FAILED"' "$jrn" && kind="failed"
    [ -z "$kind" ] && grep -qE '"type"[[:space:]]*:[[:space:]]*"RUN_COMPLETED"' "$jrn" && kind="completed"
  done < <(recent_journals "$d")
  echo "$kind"
}

# --- Run claude (FIFO + direct PID) ------------------------------------------
#
# We need the spawned `claude` PID directly so we can kill it on stall and not
# guess via pgrep. A FIFO bridges claude → our reader pipeline.

FIFO="$RUNS_DIR/.${TS}-${PROMPT_NAME}.fifo"
rm -f "$FIFO"
mkfifo "$FIFO"

# Reader pipeline: tee raw JSONL, render via jq, tee pretty log.
# In debug mode, jq stderr is preserved to a sidecar so silent jq crashes are visible.
JQ_STDERR_SINK=/dev/null
[ "$DEBUG" = "1" ] && JQ_STDERR_SINK="$RUNS_DIR/${TS}-${PROMPT_NAME}.jq.err"
( tee "$RAW_JSONL" < "$FIFO" | jq --unbuffered -rj "$JQ_FILTER" 2>"$JQ_STDERR_SINK" | tee "$LOG_FILE" ) &
READER_PID=$!

# Launch claude in its own process group so we can kill it cleanly.
# Portable session-leader wrapper: use `setsid` (Linux/util-linux) when present,
# else fall back to a tiny perl POSIX::setsid (ships with macOS by default).
if command -v setsid >/dev/null 2>&1; then
  SETSID_CMD=(setsid)
elif command -v perl >/dev/null 2>&1; then
  SETSID_CMD=(perl -e 'use POSIX qw(setsid); setsid; exec @ARGV or die "exec failed: $!"' --)
else
  echo "⚠️  Neither setsid nor perl available — process-group kill will not be reliable." >&2
  SETSID_CMD=()
fi

set +e
"${STDBUF_PREFIX[@]}" "${SETSID_CMD[@]}" "$CLAUDE_BIN" -p \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  "/babysitter:yolo $PROMPT_PATH" > "$FIFO" 2>&1 &
CLAUDE_PID=$!
set -e
log_debug "claude PID=$CLAUDE_PID, reader PID=$READER_PID"

# Drop a runner-meta file so the user can find this run from outside.
META_FILE="$RUNS_DIR/${TS}-${PROMPT_NAME}.meta"
{
  echo "runner_pid=$$"
  echo "claude_pid=$CLAUDE_PID"
  echo "reader_pid=$READER_PID"
  echo "task=$TASK_NAME"
  echo "prompt=$PROMPT_PATH"
  echo "project_root=$PROJECT_ROOT"
  echo "task_dir=$TASK_DIR"
  echo "log_pretty=$LOG_FILE"
  echo "log_raw=$RAW_JSONL"
  echo "fifo=$FIFO"
  echo "started=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)"
} > "$META_FILE"

# --- Liveness watcher --------------------------------------------------------
#
# Always start the watcher (regardless of whether .a5c/runs/ exists yet).
# `find_run_dir` returns empty until the dir appears, and the watcher tolerates that.

WATCHER_KILLED_FLAG="$RUNS_DIR/.${TS}-${PROMPT_NAME}.watcher-killed"
rm -f "$WATCHER_KILLED_FLAG"

(
  # Immediate first check (don't sleep 30s before the first poll).
  first=1
  while kill -0 "$CLAUDE_PID" 2>/dev/null; do
    if [ "$first" = "0" ]; then
      sleep "$WATCH_INTERVAL_S"
    fi
    first=0

    RUN_DIR=$(find_run_dir)
    [ -z "$RUN_DIR" ] && continue

    if is_run_terminal "$RUN_DIR"; then
      log_debug "Watcher: terminal event detected in $RUN_DIR"
      exit 0
    fi

    NOW=$(date +%s)
    JRN_MT=$(newest_journal_mtime "$RUN_DIR")
    if [ "$JRN_MT" = "0" ]; then
      # No journal yet — tolerate up to IDLE_THRESHOLD_S since launch.
      AGE=$((NOW - LAUNCH_TS))
    else
      AGE=$((NOW - JRN_MT))
    fi

    if [ "$AGE" -gt "$IDLE_THRESHOLD_S" ]; then
      echo "" >&2
      echo "🛑 Watcher: no journal write for ${AGE}s (>${IDLE_THRESHOLD_S}s). Killing claude PGID $CLAUDE_PID." >&2
      touch "$WATCHER_KILLED_FLAG"
      kill -TERM -- -"$CLAUDE_PID" 2>/dev/null || kill -TERM "$CLAUDE_PID" 2>/dev/null
      sleep 3
      kill -KILL -- -"$CLAUDE_PID" 2>/dev/null || kill -KILL "$CLAUDE_PID" 2>/dev/null
      exit 1
    fi
  done
) &
WATCHER_PID=$!

# --- Wait for claude, then drain reader --------------------------------------

set +e
wait "$CLAUDE_PID"
EXIT_CODE=$?
set -e

# Reader exits when the FIFO closes (claude is done writing).
wait "$READER_PID" 2>/dev/null
READER_EXIT=$?
if [ "$READER_EXIT" -ne 0 ] && [ "$READER_EXIT" -ne 143 ]; then
  echo "⚠️  Reader pipeline exited code $READER_EXIT (jq/tee crash?). Check $RAW_JSONL." >&2
  [ "$DEBUG" = "1" ] && [ -s "${LOG_FILE%.log}.jq.err" ] && echo "    jq stderr: $(head -1 "${LOG_FILE%.log}.jq.err")" >&2
fi

# Stop watcher.
kill "$WATCHER_PID" 2>/dev/null || true
wait "$WATCHER_PID" 2>/dev/null || true

# Cleanup FIFO.
rm -f "$FIFO"

WATCHER_KILLED=0
[ -f "$WATCHER_KILLED_FLAG" ] && WATCHER_KILLED=1
rm -f "$WATCHER_KILLED_FLAG"

# --- Post-mortem: terminal event? --------------------------------------------
# strict mode: refuse to guess. If we can't find a prompt-matched run.json now,
# treat the run as premature/unknown rather than blaming a sibling concurrent run.

RUN_DIR_FINAL=$(find_run_dir strict)
POST_STATUS="unknown"

# Count post-launch run dirs even without prompt-match — distinguishes
# "this is a non-babysitter prompt" from "babysitter created a dir but
# failed before writing run.json" (init failure).
UNBOUND_CANDIDATES=0
if [ -d "$PROJECT_RUNS_DIR" ]; then
  for _d in "$PROJECT_RUNS_DIR"/*/; do
    [ -d "$_d" ] || continue
    _cts=$(file_mtime "$_d")
    { [ -z "$_cts" ] || [ "$_cts" -lt "$((LAUNCH_TS - 5))" ]; } && continue
    UNBOUND_CANDIDATES=$((UNBOUND_CANDIDATES + 1))
  done
fi

if [ -n "$RUN_DIR_FINAL" ]; then
  TKIND=$(terminal_kind "$RUN_DIR_FINAL")
  case "$TKIND" in
    completed) POST_STATUS="completed" ;;
    failed)    POST_STATUS="failed" ;;
    fatal)     POST_STATUS="fatal" ;;
    "")        POST_STATUS="premature" ;;
  esac
elif [ "$UNBOUND_CANDIDATES" -gt 0 ]; then
  # .a5c/runs/<id>/ exists but no run.json bound to our prompt — likely an init
  # failure (babysitter started but never finalized metadata).
  POST_STATUS="unbound"
fi

# --- Banner + telegram + auto-close ------------------------------------------

echo ""
echo "============================================================"
if [ "$WATCHER_KILLED" -eq 1 ]; then
  echo "🛑 Stuck — watcher killed claude after ${IDLE_THRESHOLD_S}s of journal silence."
  STATUS="🛑 stuck (watcher killed)"
elif [ "$POST_STATUS" = "premature" ]; then
  echo "⚠️  PREMATURE EXIT — claude exited code $EXIT_CODE but no RUN_COMPLETED/RUN_FAILED in the journal."
  echo "   Run dir: $RUN_DIR_FINAL"
  echo "   Use /babysitter:resume to pick up where it stopped."
  STATUS="⚠️ premature exit"
elif [ "$POST_STATUS" = "completed" ]; then
  echo "✅ Done (RUN_COMPLETED). Closing in 5s…"
  STATUS="✅ completed"
elif [ "$POST_STATUS" = "failed" ] || [ "$POST_STATUS" = "fatal" ]; then
  POST_STATUS_UPPER=$(printf '%s' "$POST_STATUS" | tr '[:lower:]' '[:upper:]')
  echo "❌ RUN_${POST_STATUS_UPPER} in journal. Closing in 5s…"
  STATUS="❌ $POST_STATUS"
elif [ "$POST_STATUS" = "unbound" ]; then
  echo "⚠️  UNBOUND RUN — $UNBOUND_CANDIDATES post-launch dir(s) under $PROJECT_RUNS_DIR but none has a run.json matching this prompt."
  echo "   Likely a babysitter init failure. Inspect candidate dirs manually."
  echo "   Runner meta: $META_FILE"
  STATUS="⚠️ unbound run"
elif [ "$EXIT_CODE" -eq 0 ]; then
  echo "✅ Done (exit 0, no .a5c/runs detected — non-babysitter prompt). Closing in 5s…"
  STATUS="✅ done"
else
  echo "⚠️  Exited with code $EXIT_CODE. Closing in 5s…"
  STATUS="⚠️ exit $EXIT_CODE"
fi
echo "  Pretty log: $LOG_FILE"
echo "  Raw JSONL : $RAW_JSONL"
[ -n "$RUN_DIR_FINAL" ] && echo "  Run dir   : $RUN_DIR_FINAL"
echo "============================================================"

tg_send "🤖 Agent — ${PROMPT_NAME} ${STATUS}"

sleep 5
exit "$EXIT_CODE"
