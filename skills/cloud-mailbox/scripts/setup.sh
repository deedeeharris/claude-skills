#!/usr/bin/env bash
# One-time setup of a repo for cloud workers. Run from anywhere inside the repo, locally.
#   1. checks `gh` is signed in and can reach the repo
#   2. creates the `cloud-mailbox` issue label
#   3. copies this skill, plus any skills you name, into the repo's .claude/skills/ (cloud sessions load
#      only skills committed to the repo, never your personal ones)
#   4. with --env / --autocompact, writes the repo's cloud defaults into .claude/settings.json
#   5. reports every seeded file .gitignore would hide from git
# It never commits or pushes. Review `git status`, commit, and push before launching a worker: the
# cloud clones the pushed branch.
#
# usage: setup.sh [--skill NAME]... [--skills-dir DIR] [--env ENV_ID] [--autocompact TOKENS] [--label NAME] [--force]
#   --skill NAME        a skill folder under --skills-dir to seed (repeatable)
#   --skills-dir        where your skills live (default ~/.claude/skills)
#   --env ENV_ID        an Anthropic-hosted environment id (env_...). Find it by running /remote-env in a
#                       local Claude Code session: it prints the name and id of the one you pick.
#   --autocompact N     auto-compact window in tokens, a plain integer from 100000 to 1000000 (e.g. 500000).
#                       Written as env CLAUDE_CODE_AUTO_COMPACT_WINDOW, which outranks /autocompact and the
#                       autoCompactWindow setting. Applies locally and in single-repo cloud sessions.
#   --force             overwrite skill folders that already exist in the repo
set -u
skills=() skills_dir="$HOME/.claude/skills" env_id="" window="" label="cloud-mailbox" force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skill) skills+=("$2"); shift 2 ;;
    --skills-dir) skills_dir="$2"; shift 2 ;;
    --env) env_id="$2"; shift 2 ;;
    --autocompact) window="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --force) force=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Validate input before changing anything.
if [ -n "$env_id" ]; then
  case "$env_id" in
    env_*) ;;
    ccpool_*) echo "self-hosted ccpool_ ids are ignored in project settings; pass them with claude --cloud --environment instead" >&2; exit 2 ;;
    *) echo "--env must be an env_... id (run /remote-env locally to see it)" >&2; exit 2 ;;
  esac
fi
if [ -n "$window" ]; then
  # Claude Code reads only a plain integer here: "500k" would mean 500 and clamp to the minimum.
  [[ "$window" =~ ^[0-9]+$ ]] && [ "$window" -ge 100000 ] && [ "$window" -le 1000000 ] \
    || { echo "--autocompact must be a plain integer from 100000 to 1000000 (e.g. 500000)" >&2; exit 2; }
fi
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "run this inside a git repo" >&2; exit 2; }
cd "$root" || exit 2

# 1. GitHub access
gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: run gh auth login" >&2; exit 2; }
repo=$(gh api 'repos/{owner}/{repo}' --jq .full_name 2>/dev/null) || { echo "gh cannot see this repo's GitHub remote" >&2; exit 2; }
echo "repo: $repo"

# 2. label (exact-name match over the list, so any characters in the name are safe)
if gh api --paginate "repos/$repo/labels?per_page=100" --jq '.[].name' 2>/dev/null | grep -Fxq -- "$label"; then
  echo "label '$label': exists"
else
  gh api "repos/$repo/labels" -X POST -f "name=$label" -f color=5319e7 \
    -f "description=One issue per Claude Code cloud worker: its mailbox to the local session" >/dev/null \
    && echo "label '$label': created" || { echo "could not create label '$label'" >&2; exit 1; }
fi

# 3. seed skills
mkdir -p .claude/skills
failed=0 seeded=()
seed() { # $1 source dir, $2 name
  local dst=".claude/skills/$2"
  # A skill name is one folder name: no path separators, no . or .. (keeps rm/cp inside .claude/skills).
  if [[ ! "$2" =~ ^[A-Za-z0-9._-]+$ ]] || [ "$2" = "." ] || [ "$2" = ".." ]; then
    echo "skill '$2': not a plain folder name, skipped" >&2; failed=1; return
  fi
  [ -f "$1/SKILL.md" ] || { echo "skill $2: no SKILL.md in $1, skipped" >&2; failed=1; return; }
  seeded+=("$dst")
  if [ -e "$dst" ]; then
    # Running the copy that already lives in this repo: source and destination are the same folder.
    if [ "$1" -ef "$dst" ]; then echo "skill $2: already in repo (this copy)"; return; fi
    [ "$force" -eq 1 ] || { echo "skill $2: already in repo (use --force to overwrite)"; return; }
    rm -rf -- "$dst"
  fi
  if cp -RL "$1" "$dst"; then echo "skill $2: copied"; else echo "skill $2: copy FAILED" >&2; failed=1; fi
}
seed "$here" cloud-mailbox
for s in "${skills[@]+"${skills[@]}"}"; do seed "$skills_dir/$s" "$s"; done
[ "$failed" -eq 0 ] || { echo "some skills were not seeded; fix the above and run again" >&2; exit 1; }

# 4. repo settings for cloud sessions (merged into any existing .claude/settings.json)
if [ -n "$env_id" ] || [ -n "$window" ]; then
  merge='
    const fs = require("fs"), [p, id, win] = process.argv.slice(1);
    let s = {}; if (fs.existsSync(p)) s = JSON.parse(fs.readFileSync(p, "utf8"));
    if (id) s.remote = Object.assign({}, s.remote, { defaultEnvironmentId: id });
    if (win) s.env = Object.assign({}, s.env, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: win });
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");'
  pymerge='
import json, os, sys
p, i, w = sys.argv[1], sys.argv[2], sys.argv[3]
s = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}
if i: s.setdefault("remote", {})["defaultEnvironmentId"] = i
if w: s.setdefault("env", {})["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = w
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2) + "\n")'
  if node -e 1 >/dev/null 2>&1; then node -e "$merge" .claude/settings.json "$env_id" "$window"
  elif python3 -c 1 >/dev/null 2>&1; then python3 -c "$pymerge" .claude/settings.json "$env_id" "$window"
  elif python -c 1 >/dev/null 2>&1; then python -c "$pymerge" .claude/settings.json "$env_id" "$window"
  else echo "need node or python to edit .claude/settings.json" >&2; exit 2; fi
  [ $? -eq 0 ] || { echo "could not update .claude/settings.json (malformed JSON or not writable); nothing changed" >&2; exit 1; }
  [ -n "$env_id" ] && echo "cloud environment: .claude/settings.json remote.defaultEnvironmentId = $env_id"
  [ -n "$window" ] && echo "auto-compact: .claude/settings.json env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = $window"
fi

# 5. every seeded file and the settings file must be visible to git, or the cloud never gets them
hidden=$(git ls-files --others --ignored --exclude-standard -- "${seeded[@]}" .claude/settings.json 2>/dev/null)
if [ -n "$hidden" ]; then
  echo "IGNORED by .gitignore (the cloud would not get these):"
  printf '%s\n' "$hidden" | sed 's/^/  /'
  echo "Fix: in .gitignore, ignore '.claude/*' (not '.claude/'), add '!.claude/skills/' and '!.claude/settings.json',"
  echo "and remove any rule that hides files inside the skills. Then run setup again."
  exit 1
fi
echo
echo "Next: review, then commit and push:"
echo "  git add ${seeded[*]} $( [ -n "$env_id$window" ] && echo .claude/settings.json ) && git commit -m 'chore: cloud worker setup' && git push"
