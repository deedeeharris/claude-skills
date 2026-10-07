#!/usr/bin/env bash
# Post a comment on a mailbox issue, from either side. REST only (works inside cloud sessions,
# where `gh issue comment` fails because the GitHub proxy blocks GraphQL).
# The body comes from a file, so quotes, backticks and newlines survive untouched.
# First line convention: worker comments start with [cloud:<name>] <TYPE>, PM comments with [pm].
#
# usage: post.sh --repo OWNER/REPO --issue N --file BODY_FILE
set -u
repo="" issue="" file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --issue) issue="$2"; shift 2 ;;
    --file) file="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] && [ -n "$issue" ] && [ -f "$file" ] || { echo "usage: post.sh --repo OWNER/REPO --issue N --file BODY_FILE" >&2; exit 2; }
gh api "repos/$repo/issues/$issue/comments" -X POST -F "body=@$file" --jq '"posted \(.created_at) \(.html_url)"'
