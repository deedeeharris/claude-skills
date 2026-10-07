#!/usr/bin/env bash
# Cloud (worker) side. Wait, spending no model tokens, until the PM posts a comment starting with
# [pm] on this worker's mailbox issue. Prints the oldest unhandled [pm] comment and exits 0.
# Run it as a background command and end the turn; its exit wakes the worker.
# REST only: the cloud's GitHub proxy blocks GraphQL.
#
# Only comments written by the PM's GitHub account (--pm) count: anyone can comment on a public
# repo, and a body that merely starts with [pm] proves nothing.
# Comments are tracked by id, not by time, so two comments in the same second are both delivered.
# A state file keeps the id of the last [pm] comment handed out; without it, every [pm] comment on
# the issue counts as unhandled.
#
# usage: worker-wait.sh --repo OWNER/REPO --issue N --pm LOGIN [--interval SEC] [--max-hours H] [--state FILE]
# exit:  0 [pm] comment printed | 3 max-hours reached, nothing new | 2 usage error
set -u
repo="" issue="" pm="" interval=60 max_hours=2 state=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --issue) issue="$2"; shift 2 ;;
    --pm) pm="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --max-hours) max_hours="$2"; shift 2 ;;
    --state) state="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] && [ -n "$issue" ] && [ -n "$pm" ] || { echo "usage: worker-wait.sh --repo OWNER/REPO --issue N --pm LOGIN" >&2; exit 2; }
[ -n "$state" ] || state="${TMPDIR:-/tmp}/cloud-mailbox-$issue.last"
touch "$state" 2>/dev/null || { echo "cannot write state file $state; without it a PM comment could be delivered twice" >&2; exit 2; }
last=$(cat "$state" 2>/dev/null || true)
[[ "$last" =~ ^[0-9]+$ ]] || last=0

deadline=$(( $(date +%s) + max_hours * 3600 ))
while true; do
  # --paginate runs the filter per page; sort the ids across pages and take the oldest unhandled one.
  next=$(gh api --paginate "repos/$repo/issues/$issue/comments?per_page=100" \
    --jq ".[] | select(.user.login == \"$pm\" and (.body|startswith(\"[pm]\")) and .id > $last) | .id" 2>/dev/null | sort -n | head -1)
  # A failed body fetch falls through to the deadline check below and is retried next round.
  [[ "$next" =~ ^[0-9]+$ ]] || next=""   # an API error can print its JSON where an id should be
  if [ -n "$next" ] && body=$(gh api "repos/$repo/issues/comments/$next" --jq .body); then
    printf '%s\n' "$next" > "$state" || { echo "could not record comment $next in $state; not delivering it" >&2; exit 2; }
    printf '%s\n' "$body"
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep "$interval"
done
echo "no [pm] comment within $max_hours h" >&2
exit 3
