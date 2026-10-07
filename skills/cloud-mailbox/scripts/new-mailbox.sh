#!/usr/bin/env bash
# Local (PM) side. Open one mailbox issue for one new cloud worker and render its prompt.
# Prints two lines: `ISSUE <n>` and `PROMPT <path>`. Launch the worker next with launch.ps1 / launch.sh.
#
# usage: new-mailbox.sh --name NAME --task-file FILE [--repo OWNER/REPO] [--label NAME] [--out FILE]
#   NAME      letters, digits, . _ - only (it becomes the session name and the comment tag)
#   FILE      the task text for the worker. Keep it short: the whole prompt travels on a command
#             line (Windows caps that near 32k characters). Put long specs in a committed file and
#             point to it.
set -u
shopt -u patsub_replacement 2>/dev/null || true   # bash 5.2: keep & literal in ${var//pat/rep}
name="" task="" repo="" label="cloud-mailbox" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --task-file) task="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--name must be letters, digits, . _ - only" >&2; exit 2; }
[[ "$name" != *__* ]] || { echo "--name must not contain '__' (reserved for template placeholders)" >&2; exit 2; }
[ -f "$task" ] || { echo "--task-file not found: $task" >&2; exit 2; }
[ -n "$repo" ] || repo=$(gh api 'repos/{owner}/{repo}' --jq .full_name 2>/dev/null) || true
[ -n "$repo" ] || { echo "cannot tell the repo; pass --repo OWNER/REPO" >&2; exit 2; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -n "$out" ] || out="${TMPDIR:-/tmp}/cloud-mailbox-$name-prompt.md"
# The worker obeys [pm] comments only from this account (the one gh is signed in as).
pm=$(gh api user --jq .login 2>/dev/null) || true
[ -n "$pm" ] || { echo "cannot tell your GitHub login (gh api user)" >&2; exit 2; }
# Read everything before writing anything, and never let the output overwrite the task.
text=$(cat "$task") || { echo "cannot read $task" >&2; exit 2; }
[ -n "$text" ] || { echo "task file is empty: $task" >&2; exit 2; }
tpl=$(cat "$here/../templates/worker-prompt.md") || { echo "template missing" >&2; exit 2; }
# -ef compares the files themselves, so case-insensitive file systems and links are covered too.
if [ -e "$out" ] && [ "$task" -ef "$out" ]; then
  echo "--out must not be the task file" >&2; exit 2
fi
# Fail before opening an issue if the prompt cannot be written: render into a temp file next to it.
tmp_out="$out.tmp.$$"
: > "$tmp_out" || { echo "cannot write next to the prompt file $out" >&2; exit 2; }

body=$(mktemp)
printf 'Mailbox for cloud worker `%s`. The worker comments here; the local PM replies with [pm] comments and closes the issue when the work is done.\n' "$name" > "$body"
issue=$(gh api "repos/$repo/issues" -X POST -f "title=cloud mailbox: $name" -F "body=@$body" -f "labels[]=$label" --jq .number)
rc=$?
rm -f "$body"
[ "$rc" -eq 0 ] && [ -n "$issue" ] || { rm -f "$tmp_out"; echo "could not open the issue (does the label '$label' exist? run setup.sh)" >&2; exit 1; }

tpl=${tpl//__REPO__/$repo}
tpl=${tpl//__ISSUE__/$issue}
tpl=${tpl//__NAME__/$name}
tpl=${tpl//__PM__/$pm}
tpl=${tpl//__TASK__/$text}
if ! { printf '%s\n' "$tpl" > "$tmp_out" && mv -f "$tmp_out" "$out"; }; then
  rm -f "$tmp_out"
  echo "issue #$issue was opened but the prompt could not be written to $out; close the issue with close-mailbox.sh" >&2; exit 1
fi
echo "ISSUE $issue"
# On Windows (Git Bash) print a native C:/... path: PowerShell would read /tmp/... as C:\tmp\...
if command -v cygpath >/dev/null 2>&1; then out=$(cygpath -m "$out"); fi
echo "PROMPT $out"
