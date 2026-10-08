#!/usr/bin/env bash
# Regression tests for templates/status-footer/status-facts.sh against throwaway git repos.
# No network: the "remote" is a local bare repo.
# usage: bash tests/status-facts.test.sh     exit: 0 all pass | 1 a test failed
set -u
here="$(cd "$(dirname "$0")" && pwd)"
hook="$here/../templates/status-footer/status-facts.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Fixed identity and no personal git config, so a signing or hook setting cannot break the setup.
export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset STATUS_FOOTER_TZ
git init -q --bare -b main "$work/origin.git"
git clone -q "$work/origin.git" "$work/clone" 2>/dev/null
git -C "$work/clone" commit -q --allow-empty -m one
git -C "$work/clone" push -q -u origin main 2>/dev/null
git -C "$work/clone" commit -q --allow-empty -m two
git -C "$work/clone" worktree add -q -b feat "$work/wt"
git clone -q "$work/origin.git" "$work/detached" 2>/dev/null
git -C "$work/detached" checkout -q --detach HEAD
sha=$(git -C "$work/detached" rev-parse --short HEAD)
mkdir "$work/plain"

fails=0
check() { if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }
# Runs the hook in DIR as Claude Code would (payload on stdin, CLAUDE_PROJECT_DIR set); sets out and rc.
run() { local d="$1"; shift; out=$(echo '{"prompt":"hi"}' | env CLAUDE_PROJECT_DIR="$d" "$@" bash "$hook"); rc=$?; }
has() { grep -qE "$1" <<<"$out"; }
stamp='[A-Z][a-z]{2} [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}'

t0=$(date +%s%N); run "$work/clone"; t1=$(date +%s%N)
[ $rc -eq 0 ] && has '^Session facts, measured now - copy these into the Status Footer' && has "^Time: $stamp [^ ]+$" \
  && has '^Branch: main - 1 ahead, 0 behind origin/main$' && has '^Worktree: .+/clone \(main checkout\)$' && r=ok || r=bad
check "$r" "a branch one commit ahead of its upstream: header, time, ahead/behind, main checkout"
# BSD date (macOS) has no %N and prints a literal N: skip the timing there.
if [[ "$t0$t1" =~ ^[0-9]+$ ]]; then
  ms=$(( (t1 - t0) / 1000000 ))
  [ $ms -lt 2000 ] && r=ok || r=bad
  check "$r" "the hook finishes in under 2 s (took $ms ms)"
else
  echo "skip the hook timing: this date has no nanoseconds"
fi

# A tag with the branch's name makes `symbolic-ref --short` answer "heads/main".
git -C "$work/clone" tag main
run "$work/clone"
[ $rc -eq 0 ] && has '^Branch: main - 1 ahead, 0 behind origin/main$' && r=ok || r=bad
check "$r" "a tag named like the branch: plain branch name, upstream still found"
git -C "$work/clone" tag -d main >/dev/null

run "$work/wt"
[ $rc -eq 0 ] && has '^Branch: feat$' && has '^Worktree: .+/wt \(linked worktree\)$' && r=ok || r=bad
check "$r" "a linked worktree on a branch with no upstream: plain branch name, linked worktree"

run "$work/detached"
[ $rc -eq 0 ] && has "^Branch: detached at $sha\$" && has '^Worktree: .+/detached \(main checkout\)$' && r=ok || r=bad
check "$r" "a detached HEAD: names the short commit"

out=$(cd "$work/plain" && echo '{}' | env -u CLAUDE_PROJECT_DIR bash "$hook"); rc=$?
[ $rc -eq 0 ] && has "^Time: $stamp" && has '^Branch: - \(not a git repo\)$' && has '^Worktree: - \(not a git repo: .+plain\)$' && r=ok || r=bad
check "$r" "outside a git repo, with CLAUDE_PROJECT_DIR unset: falls back to the working directory and says so"

# git older than 2.31 does not fail on --path-format: rev-parse echoes the unknown option and exits 0.
# A wrapper renames the option to one no git knows, which reproduces that on any version.
mkdir "$work/oldgit"
printf '#!/usr/bin/env bash\na=(); for x; do [ "$x" = --path-format=absolute ] && x=--no-such-path-format; a+=("$x"); done\nexec "%s" "${a[@]}"\n' \
  "$(command -v git)" > "$work/oldgit/git"
chmod +x "$work/oldgit/git"
run "$work/clone" PATH="$work/oldgit:$PATH"
[ $rc -eq 0 ] && has '^Worktree: .+/clone \(main checkout\)$' && ! has 'no-such-path-format' && r=ok || r=bad
check "$r" "git without --path-format: real worktree path, still the main checkout"

run "$work/clone" STATUS_FOOTER_TZ=UTC
[ $rc -eq 0 ] && has "^Time: $stamp UTC\$" && r=ok || r=bad
check "$r" "STATUS_FOOTER_TZ=UTC: time in UTC, no fallback note"

run "$work/clone" STATUS_FOOTER_TZ=Bogus/Zone
[ $rc -eq 0 ] && has "^Time: $stamp UTC \(zone Bogus/Zone is not available here, so this is UTC\)\$" && r=ok || r=bad
check "$r" "an unknown STATUS_FOOTER_TZ: UTC, and the line says the zone was not available"

# Only where the machine has a zone database (Linux, macOS); Git Bash on Windows has none.
if [ -f "${TZDIR:-/usr/share/zoneinfo}/Europe/Paris" ]; then
  run "$work/clone" STATUS_FOOTER_TZ=Europe/Paris
  [ $rc -eq 0 ] && has "^Time: $stamp CES?T\$" && r=ok || r=bad
  check "$r" "a real zone name: local time there, with its abbreviation"
else
  echo "skip a real zone name: no zone database on this machine"
fi

[ $fails -eq 0 ] && echo "PASS" || echo "FAIL ($fails)"
[ $fails -eq 0 ]
