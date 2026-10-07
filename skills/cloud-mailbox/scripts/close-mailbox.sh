#!/usr/bin/env bash
# Local (PM) side only. Close a worker's mailbox issue once the worker has posted BYE.
# Workers never close their own issue: their only GitHub write is comments on it.
#
# usage: close-mailbox.sh --repo OWNER/REPO --issue N [--note TEXT]
set -u
repo="" issue="" note=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --issue) issue="$2"; shift 2 ;;
    --note) note="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] && [ -n "$issue" ] || { echo "usage: close-mailbox.sh --repo OWNER/REPO --issue N [--note TEXT]" >&2; exit 2; }
if [ -n "$note" ]; then
  f=$(mktemp)
  printf '[pm] CLOSED\n\n%s\n' "$note" > "$f"
  gh api "repos/$repo/issues/$issue/comments" -X POST -F "body=@$f" --jq '"posted \(.created_at)"'
  rc=$?
  rm -f "$f"
  [ "$rc" -eq 0 ] || exit 1
fi
gh api "repos/$repo/issues/$issue" -X PATCH -f state=closed -f state_reason=completed --jq '"issue #\(.number) \(.state)"'
