#!/usr/bin/env bash
# macOS / Linux. Start one Claude Code cloud session from the current, pushed branch, detached, with
# no terminal window left open. `claude --cloud` refuses to run without a terminal, so it runs under
# `script`, which gives it a pseudo-terminal; its screen output goes to the log.
# NOTE: written for macOS and Linux but only the Windows launcher (launch.ps1) has been tested.
# The cloud environment comes from `remote.defaultEnvironmentId` (repo .claude/settings.json wins over
# the user's /remote-env pick); this script does not choose one.
#
# usage: launch.sh --prompt-file FILE --name NAME [--repo-dir DIR] [--log-dir DIR]
set -u
prompt="" name="" dir="." logdir="${TMPDIR:-/tmp}/cloud-mailbox"
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file) prompt="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --repo-dir) dir="$2"; shift 2 ;;
    --log-dir) logdir="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--name must be letters, digits, . _ - only" >&2; exit 2; }
[ -f "$prompt" ] || { echo "--prompt-file not found: $prompt" >&2; exit 2; }
prompt="$(cd "$(dirname "$prompt")" && pwd)/$(basename "$prompt")"   # absolute, before the cd below
command -v script >/dev/null || { echo "'script' (util-linux / BSD) is required" >&2; exit 2; }
cd "$dir" || exit 2
branch=$(git rev-parse --abbrev-ref HEAD) || exit 2
git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || { echo "branch '$branch' has no upstream; push it first" >&2; exit 1; }
ahead=$(git rev-list --count '@{u}..HEAD')
[ "$ahead" -eq 0 ] || { echo "branch '$branch' is $ahead commit(s) ahead of its upstream; push first, the cloud clones the remote branch" >&2; exit 1; }
mkdir -p "$logdir"
log="$logdir/launch-$name.log"

# Pass the prompt through the environment so no shell ever re-parses its text.
export CM_PROMPT CM_NAME="$name"
CM_PROMPT=$(cat "$prompt") || { echo "cannot read $prompt" >&2; exit 2; }
[ -n "$CM_PROMPT" ] || { echo "prompt file is empty: $prompt" >&2; exit 2; }
if script --version 2>/dev/null | grep -q util-linux; then
  nohup script -qec 'claude --cloud "$CM_PROMPT" -n "$CM_NAME"; echo "===EXIT=== $?"' "$log" </dev/null >/dev/null 2>&1 &
else
  nohup script -q "$log" bash -c 'claude --cloud "$CM_PROMPT" -n "$CM_NAME"; echo "===EXIT=== $?"' </dev/null >/dev/null 2>&1 &
fi
echo "LAUNCHED name=$name pid=$! branch=$branch log=$log"
