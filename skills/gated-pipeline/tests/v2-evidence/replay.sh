#!/usr/bin/env bash
# Offline replay of the v2 evidence bundle (plan section 4, "Evidence bundle"; WP7). Skeleton: the evidence files
# it reads are written by the evidence commit, after the live runs; until then it stops at the first missing one
# and names it.
#
# Steps, each stopping the replay with a clear message and a nonzero exit:
#   1. index.json and the toy repo bundle it names must exist beside this script (exit 3 when missing);
#   2. every file listed in index.json hashes to its recorded sha256; a withheld file (failed redaction, kept
#      out of the bundle with its hash and reason) is reported UNVERIFIABLE, never fetched or edited (exit 4 on
#      a mismatch or a missing listed file);
#   3. the neutral root (/srv/gp-v2, the root the live runs used, so no path is rewritten) must be absent or
#      empty; the bundle is cloned to clone.to (the checkout path the live run used, under the root) on clone.branch,
#      and the listed byte-exact copies are restored to their
#      recorded absolute paths under the root (exit 5 on a setup failure);
#   4. check-completion.js reruns --mode approvals, --mode design and the completion validation with the
#      argument lists recorded in index.json (exit 0 expected for each; exit 6 otherwise);
#   5. redact-scan.js runs over this repository's branch diff and the bundle (exit 7 on a finding).
#
# index.json shape (written by the evidence commit):
#   { "root": "/srv/gp-v2", "bundle": "<file beside this script>", "clone": { "to": "<abs path under root>", "branch": "<branch>" },
#     "files": [ { "path": "<path beside this script>", "sha256": "<hex>", "restore_to": "<abs path under root>" | null,
#                  "withheld": false } | { "path": ..., "sha256": ..., "withheld": true, "reason": "..." } ],
#     "replay": { "approvals": [ <check-completion.js args> ], "design": [ ... ], "completion": [ ... ] } }
#
# usage: replay.sh            (no arguments; reads only files beside it, needs no network)
set -euo pipefail

# Never let an inherited git environment aim the clone or the validators at another repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR
for v in $(env | sed -n 's/^\(GIT_CONFIG[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

EVID="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$(cd "$EVID/../.." && pwd)"
CHECKER="$SKILL/scripts/check-completion.js"
SCANNER="$EVID/redact-scan.js"
INDEX="$EVID/index.json"

die() { local code="$1"; shift; echo "replay: $*" >&2; exit "$code"; }
json() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), j); if (v === undefined || v === null) process.exit(1); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));' "$INDEX" "$1"; }

command -v node >/dev/null || die 5 "node is required"
command -v git >/dev/null || die 5 "git is required"
test -f "$CHECKER" || die 5 "missing $CHECKER"

# ---- 1. the evidence files ------------------------------------------------------------------------------------
test -f "$INDEX" || die 3 "missing evidence file tests/v2-evidence/index.json (written by the evidence commit, plan WP7 step 4)"
BUNDLE_NAME="$(json bundle)" || die 3 "index.json names no bundle"
BUNDLE="$EVID/$BUNDLE_NAME"
test -f "$BUNDLE" || die 3 "missing evidence file tests/v2-evidence/$BUNDLE_NAME (the toy repo git bundle)"
ROOT="$(json root)" || die 3 "index.json names no root"
test "$ROOT" = /srv/gp-v2 || die 3 "index.json root is $ROOT, not the neutral root /srv/gp-v2"
for mode in approvals design completion; do json "replay.$mode" >/dev/null || die 3 "index.json has no replay.$mode argument list"; done

# ---- 2. hashes ------------------------------------------------------------------------------------------------
node - "$INDEX" "$EVID" <<'NODE' || die 4 "the evidence files do not match index.json"
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [index, evid] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(index, 'utf8'));
let bad = 0;
for (const f of j.files || []) {
  if (f.withheld) { console.log(`UNVERIFIABLE ${f.path}: withheld (${f.reason || 'no reason recorded'}), sha256 ${f.sha256}`); continue; }
  const p = path.join(evid, f.path);
  if (!fs.existsSync(p)) { console.log(`MISSING ${f.path}`); bad++; continue; }
  const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (h !== f.sha256) { console.log(`MISMATCH ${f.path}: ${h} != ${f.sha256}`); bad++; } else console.log(`ok ${f.path} ${h}`);
}
process.exit(bad ? 1 : 0);
NODE

# ---- 3. clone and restore under the neutral root ----------------------------------------------------------------
if [ -e "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then die 5 "$ROOT exists and is not empty; replay needs a fresh neutral root"; fi
mkdir -p "$ROOT" || die 5 "cannot create $ROOT"
CLONE_TO="$(json clone.to)" || die 3 "index.json names no clone.to"
CLONE_BRANCH="$(json clone.branch)" || die 3 "index.json names no clone.branch"
case "$CLONE_TO" in "$ROOT"/*) ;; *) die 5 "clone.to $CLONE_TO is outside $ROOT";; esac
git clone -q -b "$CLONE_BRANCH" "$BUNDLE" "$CLONE_TO" || die 5 "git clone of the bundle failed"
node - "$INDEX" "$EVID" "$ROOT" <<'NODE' || die 5 "restoring the evidence copies failed"
const fs = require('fs'), path = require('path');
const [index, evid, root] = process.argv.slice(2);
for (const f of JSON.parse(fs.readFileSync(index, 'utf8')).files || []) {
  if (f.withheld || !f.restore_to) continue;
  const to = path.resolve(f.restore_to);
  if (!to.startsWith(root + '/')) { console.error(`restore_to ${f.restore_to} is outside ${root}`); process.exit(1); }
  if (fs.existsSync(to)) { console.error(`restore_to ${to} already exists`); process.exit(1); }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(evid, f.path), to);
  console.log(`restored ${f.path} -> ${to}`);
}
NODE

# ---- 4. the validators, offline ------------------------------------------------------------------------------
for mode in approvals design completion; do
  mapfile -d '' ARGS < <(node -e 'for (const a of JSON.parse(process.argv[1])) process.stdout.write(String(a) + "\0")' "$(json "replay.$mode")")
  echo "replay $mode: node scripts/check-completion.js ${ARGS[*]}"
  set +e
  node "$CHECKER" "${ARGS[@]}"
  rc=$?
  set -e
  echo "replay $mode: exit $rc"
  [ "$rc" -eq 0 ] || die 6 "check-completion ($mode) exited $rc, expected 0"
done

# ---- 5. redaction ---------------------------------------------------------------------------------------------
set +e
node "$SCANNER" --bundle "$BUNDLE"
rc=$?
set -e
[ "$rc" -eq 0 ] || die 7 "redact-scan exited $rc"
echo "replay: all steps passed"
