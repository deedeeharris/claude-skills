#!/usr/bin/env bash
# Local (PM) side. Wait, spending no model tokens, until a cloud worker comments on any open
# mailbox issue of the repo. Prints one line per new worker comment and exits 0.
# Comments starting with [pm] are the PM's own and never wake it.
# Run it as a background command; its exit wakes the session. Relaunch it after every wake.
#
# Workers post through the repo owner's GitHub account, so only comments by --author count
# (default: the account gh is signed in as); anyone else commenting on a public repo is ignored.
# Comments are tracked by id per issue, not by time, so none is lost or reported twice. A mailbox
# with no saved id reports every worker comment it has, so a reply posted before the waiter
# started is still delivered.
#
# usage: pm-wait.sh [--repo OWNER/REPO] [--author LOGIN] [--label NAME] [--interval SEC] [--max-hours H] [--state FILE]
# exit:  0 new worker comment(s) printed | 3 max-hours reached, nothing new | 2 usage or setup error
set -u
repo="" author="" label="cloud-mailbox" interval=60 max_hours=12 state=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --author) author="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --max-hours) max_hours="$2"; shift 2 ;;
    --state) state="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] || repo=$(gh api 'repos/{owner}/{repo}' --jq .full_name 2>/dev/null) || true
[ -n "$repo" ] || { echo "cannot tell the repo; pass --repo OWNER/REPO" >&2; exit 2; }
[ -n "$author" ] || author=$(gh api user --jq .login 2>/dev/null) || true
[ -n "$author" ] || { echo "cannot tell your GitHub login; pass --author LOGIN" >&2; exit 2; }
if [ -z "$state" ]; then
  gd=$(git rev-parse --git-common-dir 2>/dev/null) || { echo "not in a git repo; pass --state FILE" >&2; exit 2; }
  state="$gd/cloud-mailbox.ids"
fi
touch "$state" || { echo "cannot write state file $state" >&2; exit 2; }

# One line per repo and issue: "<owner/repo> <issue> <last reported comment id>".
last_id() { awk -v r="$repo" -v n="$1" '$1 == r && $2 == n { v = $3 } END { print (v == "" ? 0 : v) }' "$state"; }
# Apply every "<issue> <id>" update of one round in a single file replace: either all cursors move
# (and the comments are printed) or none do (and they are delivered next time).
save_ids() {
  local tmp="$state.tmp"
  awk -v r="$repo" -v ups="$1" '
    BEGIN { n = split(ups, a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") { split(a[i], p, " "); up[p[1]] = p[2] } }
    !($1 == r && ($2 in up))' "$state" > "$tmp" \
  && printf '%s\n' "$1" | awk -v r="$repo" 'NF == 2 { print r, $1, $2 }' >> "$tmp" \
  && mv -f "$tmp" "$state"
}

deadline=$(( $(date +%s) + max_hours * 3600 ))
while true; do
  out="" updates=""
  # Query fields go through -f so gh URL-encodes them (a label such as R&D stays one value).
  for n in $(gh api --method GET --paginate "repos/$repo/issues" -f "labels=$label" -f state=open -f per_page=100 \
               --jq '.[] | select(.pull_request|not) | .number' 2>/dev/null); do
    since=$(last_id "$n")
    rows=$(gh api --paginate "repos/$repo/issues/$n/comments?per_page=100" \
      --jq ".[] | select(.user.login == \"$author\" and (.body|startswith(\"[pm]\")|not) and .id > $since) | [.id, .created_at, .html_url, (.body|split(\"\n\")[0])] | @tsv" 2>/dev/null) || continue
    [ -n "$rows" ] || continue
    rows=$(printf '%s\n' "$rows" | sort -n)
    while IFS=$'\t' read -r id at url first; do
      out="${out}MAILBOX #$n $at $url $first"$'\n'
    done <<< "$rows"
    updates="${updates}$n $(printf '%s\n' "$rows" | tail -1 | cut -f1)"$'\n'
  done
  if [ -n "$out" ]; then
    save_ids "$updates" || { echo "cannot update state file $state; nothing marked as read, the comments will be reported next run" >&2; exit 2; }
    printf '%s' "$out"; exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep "$interval"
done
echo "no worker comment within $max_hours h" >&2
exit 3
