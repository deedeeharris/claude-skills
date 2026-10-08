#!/usr/bin/env bash
# Regression tests for `setup.sh --status-footer` with a fake `gh` on PATH. No network, no real repo:
# each case runs setup in a fresh throwaway git repo. The settings merge runs once with node and once
# with python (a failing fake `node` on PATH forces the python branch).
# usage: bash tests/setup-status-footer.test.sh     exit: 0 all pass | 1 a test failed
set -u
here="$(cd "$(dirname "$0")" && pwd)"
setup="$here/../scripts/setup.sh"
src="$here/../templates/status-footer"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/nonode"
# The fake gh answers the three calls setup makes: auth status, the repo name, and the label list.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "auth status") ;;
  *labels*) echo cloud-mailbox ;;
  *) echo o/r ;;
esac
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 1\n' > "$work/nonode/node"
chmod +x "$work/bin/gh" "$work/nonode/node"
fails=0
check() { if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }
newrepo() { repo="$work/repo$((++n))"; mkdir -p "$repo/.claude" && git -C "$repo" init -q; }
# runs setup inside $repo; stdout+stderr in $out, exit code in $rc
run() { out=$(cd "$repo" && PATH="$extra$work/bin:$PATH" bash "$setup" "$@" 2>&1); rc=$?; }
cfg() { tr -d '\r' < "$repo/.claude/settings.json"; }
hook_count() { cfg | grep -c 'status-facts\.sh'; }
n=0
fresh='{
  "outputStyle": "Status Footer",
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/status-facts.sh\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}'

for engine in node python; do
  extra=""; [ "$engine" = python ] && extra="$work/nonode:"

  newrepo; run --status-footer
  [ $rc -eq 0 ] && [ "$(cfg)" = "$fresh" ] \
    && cmp -s "$src/status-footer.md" "$repo/.claude/output-styles/status-footer.md" \
    && cmp -s "$src/status-facts.sh" "$repo/.claude/hooks/status-facts.sh" \
    && grep -qF 'git add .claude/skills/cloud-mailbox .claude/output-styles/status-footer.md .claude/hooks/status-facts.sh .claude/settings.json' <<<"$out" \
    && r=ok || r=bad
  check "$r" "$engine: a fresh repo gets both files, the exact settings shape, and all of them in the git add hint"

  run --status-footer
  [ $rc -eq 0 ] && [ "$(hook_count)" -eq 1 ] && [ "$(cfg)" = "$fresh" ] && r=ok || r=bad
  check "$r" "$engine: a second run leaves exactly one footer hook entry"

  newrepo
  cat > "$repo/.claude/settings.json" <<'EOF'
{
  "permissions": { "deny": ["Bash(rm:*)"] },
  "env": { "KEEP_ME": "1" },
  "hooks": {
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo pre" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "echo other" } ] } ]
  }
}
EOF
  run --status-footer --status-footer-tz Europe/Paris
  c=$(cfg)
  [ $rc -eq 0 ] && grep -qF '"Bash(rm:*)"' <<<"$c" && grep -qF '"KEEP_ME": "1"' <<<"$c" \
    && grep -qF '"command": "echo pre"' <<<"$c" && grep -qF '"command": "echo other"' <<<"$c" \
    && [ "$(grep -c '"command":' <<<"$c")" -eq 3 ] && [ "$(hook_count)" -eq 1 ] \
    && grep -qF '"STATUS_FOOTER_TZ": "Europe/Paris"' <<<"$c" && grep -qF '"outputStyle": "Status Footer"' <<<"$c" \
    && r=ok || r=bad
  check "$r" "$engine: existing keys and hooks are kept, the footer hook is added once, --status-footer-tz writes env"

  newrepo; printf '{ "outputStyle": "Explanatory" }\n' > "$repo/.claude/settings.json"
  run --status-footer
  [ $rc -eq 0 ] && grep -qF '"outputStyle": "Explanatory"' <<<"$(cfg)" && grep -q 'WARNING: kept outputStyle "Explanatory"' <<<"$out" \
    && [ "$(hook_count)" -eq 1 ] && r=ok || r=bad
  check "$r" "$engine: a different outputStyle is kept, with a warning, without --force"

  run --status-footer --force
  [ $rc -eq 0 ] && grep -qF '"outputStyle": "Status Footer"' <<<"$(cfg)" && [ "$(hook_count)" -eq 1 ] && r=ok || r=bad
  check "$r" "$engine: --force replaces a different outputStyle"
done
extra=""

newrepo; mkdir -p "$repo/.claude/output-styles"; echo custom > "$repo/.claude/output-styles/status-footer.md"
run --status-footer
[ $rc -eq 0 ] && [ "$(cat "$repo/.claude/output-styles/status-footer.md")" = custom ] \
  && grep -qF '.claude/output-styles/status-footer.md: already in repo (use --force to overwrite)' <<<"$out" && r=ok || r=bad
check "$r" "an existing footer file is kept without --force"

run --status-footer --force
[ $rc -eq 0 ] && cmp -s "$src/status-footer.md" "$repo/.claude/output-styles/status-footer.md" && r=ok || r=bad
check "$r" "--force overwrites an existing footer file"

newrepo; echo '.claude/' > "$repo/.gitignore"
run --status-footer
[ $rc -eq 1 ] && grep -q '^IGNORED by .gitignore' <<<"$out" && grep -q '^  \.claude/hooks/status-facts\.sh$' <<<"$out" \
  && grep -q '^  \.claude/output-styles/status-footer\.md$' <<<"$out" && grep -qF "'!.claude/hooks/'" <<<"$out" && r=ok || r=bad
check "$r" "a .gitignore that hides .claude/ is reported, footer files included, and setup exits 1"

newrepo; run --status-footer-tz UTC
[ $rc -eq 2 ] && grep -q 'needs --status-footer' <<<"$out" && [ ! -e "$repo/.claude/settings.json" ] && r=ok || r=bad
check "$r" "--status-footer-tz without --status-footer is a usage error and writes nothing"

newrepo; run --status-footer --status-footer-tz 'UTC;rm -rf x'
[ $rc -eq 2 ] && grep -q 'must be a zone name' <<<"$out" && [ ! -e "$repo/.claude/settings.json" ] \
  && [ ! -e "$repo/.claude/hooks" ] && r=ok || r=bad
check "$r" "a zone with other characters is a usage error and changes nothing"

[ $fails -eq 0 ] && echo "PASS" || echo "FAIL ($fails)"
[ $fails -eq 0 ]
