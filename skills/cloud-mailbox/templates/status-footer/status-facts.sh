#!/usr/bin/env bash
# UserPromptSubmit hook for the Status Footer output style. Measures the facts a model would
# otherwise guess (time, branch, worktree) and prints them; Claude Code adds a UserPromptSubmit
# hook's plain stdout to the model's context, and the style tells the model to copy them verbatim.
# Needs only bash, git and date, so the same file runs in a Linux cloud worker and in Git Bash.
# At most four git calls and no pipes: every process costs time on Windows, and this runs on
# every prompt.
#
# Directory: $CLAUDE_PROJECT_DIR, or $PWD when that is unset.
# Time zone: $STATUS_FOOTER_TZ (an IANA name such as Europe/Paris); unset means the system zone.
#            A name this machine has no zone file for is reported in UTC, and the line says so.
#
# usage: status-facts.sh < hook-payload     exit: always 0 (a hook must never break a turn)
set -u
# The payload is not needed; read it so the writer never blocks on a full pipe.
[ -t 0 ] || cat >/dev/null
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
fmt='%a %Y-%m-%d %H:%M %Z'
# Read-only git, taking no optional lock, so it never waits on or blocks a git command in flight.
g() { GIT_OPTIONAL_LOCKS=0 git -C "$dir" "$@" 2>/dev/null; }

# Time. date does not fail on an unknown zone, it prints UTC under the zone's name, so the zone
# file is checked first. UTC itself needs no file.
tz="${STATUS_FOOTER_TZ:-}"
case "$tz" in
  "") now=$(date +"$fmt") ;;
  UTC|Etc/UTC) now=$(date -u +"$fmt") ;;
  /*|*..*) now="" ;;
  *) [ -f "${TZDIR:-/usr/share/zoneinfo}/$tz" ] && now=$(TZ="$tz" date +"$fmt") || now="" ;;
esac
[ -n "$now" ] || now="$(date -u +"$fmt") (zone $tz is not available here, so this is UTC)"

echo "Session facts, measured now - copy these into the Status Footer and do not recall them from memory:"
echo "Time: $now"

# Top level, own git dir, shared git dir: one line each. Fails outside a repository. git older
# than 2.31 has no --path-format: it echoes the option back and still exits 0, so a first line
# starting with "--" means "retry without it". Its relative paths still compare right.
if paths=$(g rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir) && [ "${paths#--}" = "$paths" ]; then :
elif ! paths=$(g rev-parse --show-toplevel --git-dir --git-common-dir); then
  echo "Branch: - (not a git repo)"
  echo "Worktree: - (not a git repo: $dir)"
  exit 0
fi
{ read -r top; read -r gitdir; read -r common; } <<<"$paths"

# Branch, or the commit a detached HEAD points at. Ahead/behind only when an upstream is set.
if branch=$(g symbolic-ref -q --short HEAD); then
  IFS='|' read -r up track <<<"$(g for-each-ref --format='%(upstream:short)|%(upstream:track,nobracket)' "refs/heads/$branch")"
  if [ -n "$up" ]; then
    # track reads "ahead 1, behind 2", "ahead 1", "behind 2", "gone", or nothing when level.
    ahead=0 behind=0
    [[ $track =~ ahead\ ([0-9]+) ]] && ahead=${BASH_REMATCH[1]}
    [[ $track =~ behind\ ([0-9]+) ]] && behind=${BASH_REMATCH[1]}
    if [ "$track" = gone ]; then branch="$branch - upstream $up is gone"
    else branch="$branch - $ahead ahead, $behind behind $up"; fi
  fi
else
  branch="detached at $(g rev-parse --short HEAD)"
fi
echo "Branch: $branch"

# A linked worktree has its own git dir inside the shared one; the main checkout's are the same.
if [ "$gitdir" = "$common" ]; then kind="main checkout"; else kind="linked worktree"; fi
echo "Worktree: $top ($kind)"
exit 0
