# gated-pipeline v2 verification report (issues #54 and #37)

Status: DRAFT. Structure per `docs/v2-plan.md` section 4. Statuses used: PASS, FAIL, BLOCKED, NOT RUN only.
Every real review in this round is the Opus fallback, labelled `claude-opus-high (codex unavailable)`: the Codex
CLI is not installed and no OpenAI credential is configured (user decision "Opus fallback only"). There is no
cross-family review anywhere in this report.

**Issue #54 stays open.** Release rules 1, 3 and 4 are not met; rule 2 is not met while the pre-existing
codex-review fake-runner case 4 fails (section 9).

## 1. Identity and commands

| Item | Value |
|---|---|
| Code SHA `S` (Levels 0-3 of this report) | `2623746ba7ce95a144e95686e1c76512aba1ffb0` (branch `claude/charming-pasteur-ncpes9`) |
| Baseline | `c186e5f66bdcb0ff10d3f7d31cdb23df3a570425` |
| Node | v22.23.4 (no lockfile, zero dependencies) |
| Validator / schema / compiler / migrator | `validate-feature.js` 1.1.0 (1.0.0 at 62a0712), `schema_version` 2, `feature-render.js` compiler 1.0.0, `migrate-v1.js` 1.0.0 |
| Reviewed feature (E2E-A2, frozen at design commit `b533e04`) | `.pipeline/features/session-login.feature.json`, source sha256 `c96941b81cc8cfeb48a27b677012a9dedd73689747c1aae0c7b6c90aca461a28` |
| Live runs | run at earlier SHAs (5872536, 62a0712, 62e2285, 443eba5), all superseded by `S`; each row names its SHA |
| Pinned workflow scripts (sha256 prefix: design / build / verify / land), all `MATCH` against the detached worktree `/srv/gp-v2/skill` | 5872536: d5f24aa5ad35 / 17bec11cfe9f / 90df69ff586e / c4412681bdd9; 62a0712: 2567a39190a0 / 7e0419e5aaf3 / 1b9b5c59c143 / c4412681bdd9; 62e2285: build 71fccc30f930, verify 489e43f1c583; 443eba5: verify 3b70edff861a; 2623746: 2567a39190a0 / f0cbd52368f8 / 51c4a5175a2b / c4412681bdd9 (source: `identity-*.txt`) |

Commands run for this report (cwd = repo root unless noted; `<scratch>` = a fresh scratch dir, not published):

```
node skills/gated-pipeline/tests/v2-evidence/make-tables.js --run --save-tap <scratch>/tap --table all
node skills/codex-review/tests/run-fake-tests.js --work-dir <scratch>/fake-run1-*      # twice, fresh dirs
git archive c186e5f skills | tar -x -C <scratch>/atc186; node --test --test-reporter=tap tests/<f>.test.js   # per-file baseline
git diff c186e5f..HEAD -- skills/gated-pipeline/tests/workflows.test.js
node scripts/compile-feature.js --file tests/fixtures/v2/valid/S02-unicode-multiline.feature.json --repo <scratch>/det/repo \
     --repo-path .pipeline/features/gruss.feature.json --out <scratch>/det/out1|out2            # cwd / and <scratch>, TZ/LC_ALL varied
git archive 62a0712 skills/gated-pipeline | tar -x -C <scratch>/at62a0712                       # validator as pinned for B/C
node scripts/validate-feature.js --file <seed|frozen> --repo-path ... --source-request ... --source-mode text [--previous <seed>]
node scripts/check-completion.js --mode approvals --repo /srv/gp-v2/b --approvals .../approvals-5.json --source .../rev-4/feature.json
node tests/helpers/v2-metrics.js --run-dir /srv/gp-v2/state/<feature>/design/r<k> --repo /srv/gp-v2/<x> [--commit <design_commit>] --repo-path ...
grep -ciE 'e2e|omission|contradiction|duplicate|seed|inject|defect|stress|weak' <inputs>     # plan 3.4 independence check
node skills/gated-pipeline/tests/v2-evidence/redact-scan.js
```

## 2. Level table (plan 3.1)

### 2.1 Level 0: suites before and after

| Suite | c186e5f (baseline) | 2623746 (`S`) | Note |
|---|---|---|---|
| gated-pipeline, all files | 148/148 PASS | 790/790 PASS (20 files, every file exit 0, no `not ok` line) | per-file table below; TAP sha256 per file in 2.2 |
| codex-review fake runner, run 1 | 179 passed, 1 failed | 200 passed, 1 failed, exit 1 | failing check in both: case 4 "timeout kills process tree", `FAIL - grandchild process no longer alive` |
| codex-review fake runner, run 2 (rerun, fresh work dir) | - | 200 passed, 1 failed, exit 1 | same single failure; both runs list the same 201 checks in the same order (only generated `run_id` strings differ): deterministic, not flaky |

Per-file counts (gated-pipeline):

| File | c186e5f | 2623746 | Change |
|---|---|---|---|
| check-completion.test.js | 92 | 92 | unchanged |
| merge-compliance.test.js | 17 | 17 | unchanged |
| workflows.test.js | 39 | 39 | 37 unchanged + 2 rewritten (section-0 list below) |
| 17 new files (check-completion-v2, design-v2, fallback-parity, feature-compile, feature-validate, git-env, make-tables, migrate-v1, redact-scan, relay-wait, replay, run-frozen, run-workflow, schema-lite-conformance, skill-doc, stages-v2, v2-metrics) | - | 642 | new |
| Total | 148 | 790 | no existing test removed |

Section-0 test changes: `git diff c186e5f..HEAD -- skills/gated-pipeline/tests/workflows.test.js` touches only that
file in one commit (`aee5d96`), 16 insertions / 13 deletions, 98 diff lines, diff sha256
`4887b365ba33dd03f7788558f4f4c00785d616b0a59a2d28bc4bf27a39731582`. Hunks: `@@ -83`, `-139`, `-157`, `-166`, `-335`,
`-451` (mechanical) and `-377`, `-392`, `-400` (the two rewritten tests). No other hunk appears.

| # | Before (c186e5f) | After (2623746) | Reason |
|---|---|---|---|
| 1 | `fallback parity: a design MAJOR blocks only with an ISO property or as the third MAJOR` (expected PASS for a lone non-ISO MAJOR 0.9) | `fallback parity: a lone non-ISO design MAJOR goes to a PRD revise round; an ISO property or the third MAJOR triggers` | #37 decision (b): the fallback reproduces the codex gate (plan 1a row 3) |
| 2 | `fallback parity: build blocks on a verified MAJOR, asks a human for a 0.5-0.8 MAJOR, passes MINOR` (expected BLOCKED/NEEDS_HUMAN for 0.6) | `fallback parity: build blocks on a verified MAJOR, sends a 0.5-0.8 MAJOR to a fix round, passes MINOR` | plan 1a row 2: the fixer prompt carries the finding, as on the codex path |
| 3 | reply constants `finalReview` (:86), `review` (:142), `docReview` (:160), `codeReview` (:169), two local `opusReview` (:338, :454) | each gains `findings: []`, `model_verdict` = its verdict, `outcome: 'ok'`, `unable_to_review: null`; no assertion edited | fields `gateCodex`/`gateFallback` read (design 9) |

The old expectations of 1 and 2 remain executable as `before` rows of `fallback-parity.test.js` (91/91 PASS).

### 2.2 Levels 0-3

The following block is the verbatim output of `make-tables.js --run --table all` at `S` (Level table part; the
fixture-matrix part is section 3). The TAP outputs it hashed were kept byte-exact in a scratch dir.

<!-- generated by tests/v2-evidence/make-tables.js from node --test --test-reporter=tap output; do not edit -->

### Level table (Levels 0-3)

TAP sources (command, exit code, sha256 of the TAP output):
- `node --test --test-reporter=tap tests/check-completion-v2.test.js`: exit 0, sha256 490bdb8dfd51313f5d83a0701b707eedca1f6b55f496ccaa751c9cdd38c8cb26
- `node --test --test-reporter=tap tests/check-completion.test.js`: exit 0, sha256 c5a3090042504be3576d589ae315d6c998c9b784aac4219e0d6ca70bb55b0c47
- `node --test --test-reporter=tap tests/design-v2.test.js`: exit 0, sha256 6e26929a6bbe631bebb2a96a67b2e99ac9e46d6c98462c5e8f7f30e3f5edb835
- `node --test --test-reporter=tap tests/fallback-parity.test.js`: exit 0, sha256 1fd488b50fecf3983d83d65546f22183c30225f0c291cd0da49a5e68e7e2bf25
- `node --test --test-reporter=tap tests/feature-compile.test.js`: exit 0, sha256 c5a5cfe8aa70c45a40a556175889c551b0d592a43fcad637ebbdb47359c5e6e0
- `node --test --test-reporter=tap tests/feature-validate.test.js`: exit 0, sha256 b91e7da1091f773757e4e420c145e2afc054a2657e750a5b3d311a3abc0925a7
- `node --test --test-reporter=tap tests/git-env.test.js`: exit 0, sha256 ab8238c93e2b451871af827e978733ad9a7845f1ebb13900eecfb4d7ef31616b
- `node --test --test-reporter=tap tests/make-tables.test.js`: exit 0, sha256 b5d520106464dcbed2ffc4f1ca6f88f53dbc8653342001e691da9a07f5ec9a20
- `node --test --test-reporter=tap tests/merge-compliance.test.js`: exit 0, sha256 40074602cefd6c6e0055328af0ae95d626de74bdd7dd0c290edc11d97cf128c7
- `node --test --test-reporter=tap tests/migrate-v1.test.js`: exit 0, sha256 10fe8b1ad9b4fd31ca30d01ffb8e5a71db0498cc178fd390417120f3504f644d
- `node --test --test-reporter=tap tests/redact-scan.test.js`: exit 0, sha256 fc896fbe931470396e5cbe4c084ceff4d90fff3d31b2515205a80ce809589f58
- `node --test --test-reporter=tap tests/relay-wait.test.js`: exit 0, sha256 955e68f069b9b8940ce77e9bc4f3b1f2c184acccc523dcfbae5bb23ccf81c5b9
- `node --test --test-reporter=tap tests/replay.test.js`: exit 0, sha256 c49aa46f7a05be00abe98064619c6897ecf73b0e6712a7102278968d2d5f82c4
- `node --test --test-reporter=tap tests/run-frozen.test.js`: exit 0, sha256 881d666712e6fce1a045bfb874ad9eaa0ac36623b4312e62a05bec7608854824
- `node --test --test-reporter=tap tests/run-workflow.test.js`: exit 0, sha256 05a326f9d2bd7a2359ec1bd735bf50eff5c454035e12b5c5d5e69e6dd9e26dcf
- `node --test --test-reporter=tap tests/schema-lite-conformance.test.js`: exit 0, sha256 194a664cb7b5ff1f92b6445119319cadd8fc4f4ce577dc9702948a74dc949157
- `node --test --test-reporter=tap tests/skill-doc.test.js`: exit 0, sha256 e6fec6dd9f05894b27b0005fbaefa0a75969076bf4e0dc6e96ab000cc86f52a8
- `node --test --test-reporter=tap tests/stages-v2.test.js`: exit 0, sha256 fa48a4eaf8465f37193b0a5b6ee7214bba402555186feb308d6662f52e1bd961
- `node --test --test-reporter=tap tests/v2-metrics.test.js`: exit 0, sha256 61a19cf395836f5357cd6412beb6f1fe4a45c7b5b1df8df3cb573639912f4ec1
- `node --test --test-reporter=tap tests/workflows.test.js`: exit 0, sha256 1e6e16caa33fbde6bf748c9c6def279c02bba454a8c0481c82b310116f4c170f
Skill commit: 2623746ba7ce95a144e95686e1c76512aba1ffb0

| Level | Row | Status | Tests ok/total | Exit code | Artifact | Skill commit |
|---|---|---|---|---|---|---|
| 0 | check-completion-v2.test.js | PASS | 110/110 | 0 | check-completion-v2.test.js (TAP sha256 490bdb8dfd51) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | check-completion.test.js | PASS | 92/92 | 0 | check-completion.test.js (TAP sha256 c5a309004250) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | design-v2.test.js | PASS | 51/51 | 0 | design-v2.test.js (TAP sha256 6e26929a6bbe) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | fallback-parity.test.js | PASS | 91/91 | 0 | fallback-parity.test.js (TAP sha256 1fd488b50fec) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | feature-compile.test.js | PASS | 17/17 | 0 | feature-compile.test.js (TAP sha256 c5a5cfe8aa70) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | feature-validate.test.js | PASS | 152/152 | 0 | feature-validate.test.js (TAP sha256 b91e7da1091f) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | git-env.test.js | PASS | 2/2 | 0 | git-env.test.js (TAP sha256 ab8238c93e2b) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | make-tables.test.js | PASS | 5/5 | 0 | make-tables.test.js (TAP sha256 b5d520106464) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | merge-compliance.test.js | PASS | 17/17 | 0 | merge-compliance.test.js (TAP sha256 40074602cefd) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | migrate-v1.test.js | PASS | 13/13 | 0 | migrate-v1.test.js (TAP sha256 10fe8b1ad9b4) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | redact-scan.test.js | PASS | 5/5 | 0 | redact-scan.test.js (TAP sha256 fc896fbe9314) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | relay-wait.test.js | PASS | 13/13 | 0 | relay-wait.test.js (TAP sha256 955e68f069b9) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | replay.test.js | PASS | 1/1 | 0 | replay.test.js (TAP sha256 c49aa46f7a05) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | run-frozen.test.js | PASS | 38/38 | 0 | run-frozen.test.js (TAP sha256 881d666712e6) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | run-workflow.test.js | PASS | 8/8 | 0 | run-workflow.test.js (TAP sha256 05a326f9d2bd) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | schema-lite-conformance.test.js | PASS | 4/4 | 0 | schema-lite-conformance.test.js (TAP sha256 194a664cb7b5) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | skill-doc.test.js | PASS | 9/9 | 0 | skill-doc.test.js (TAP sha256 e6fec6dd9f05) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | stages-v2.test.js | PASS | 121/121 | 0 | stages-v2.test.js (TAP sha256 fa48a4eaf846) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | v2-metrics.test.js | PASS | 2/2 | 0 | v2-metrics.test.js (TAP sha256 61a19cf39583) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 0 | workflows.test.js | PASS | 39/39 | 0 | workflows.test.js (TAP sha256 1e6e16caa33f) | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S01 | PASS | 1/1 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S02 | PASS | 2/2 | 0, 0 | feature-validate.test.js, feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S03 | PASS | 10/10 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S04 | PASS | 3/3 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S05 | PASS | 4/4 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S06 | PASS | 9/9 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S07 | PASS | 7/7 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S08 | PASS | 2/2 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S09 | PASS | 3/3 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S10 | PASS | 6/6 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S11 | PASS | 8/8 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S12 | PASS | 15/15 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S13 | PASS | 2/2 | 0, 0 | feature-validate.test.js, feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S14 | PASS | 11/11 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S15 | PASS | 1/1 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S16 | PASS | 1/1 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S17 | PASS | 1/1 | 0 | feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S18 | PASS | 33/33 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S19a | PASS | 4/4 | 0 | check-completion-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S19b | PASS | 1/1 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | S20 | PASS | 7/7 | 0, 0 | feature-validate.test.js, feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | X01 | PASS | 13/13 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | X02 | PASS | 5/5 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | X03 | PASS | 9/9 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | X04 | PASS | 7/7 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | X05 | PASS | 6/6 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | X06 | PASS | 5/5 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 1 | X07 | PASS | 2/2 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.1 | PASS | 1/1 | 0 | feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.2 | PASS | 1/1 | 0 | feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.3 | PASS | 1/1 | 0 | feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.4 | PASS | 7/7 | 0, 0 | check-completion-v2.test.js, feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.5 | PASS | 1/1 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.6 | PASS | 1/1 | 0 | feature-compile.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.7 | PASS | 2/2 | 0, 0 | feature-compile.test.js, feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 2 | L2.8 (via X03, S10) | PASS | 15/15 | 0 | feature-validate.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.1 | PASS | 1/1 | 0 | design-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.2 | PASS | 1/1 | 0 | design-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.3 | PASS | 8/8 | 0 | design-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.4 | PASS | 1/1 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.5 | PASS | 2/2 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.6 | PASS | 5/5 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.7 | PASS | 2/2 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.8 | PASS | 4/4 | 0, 0 | design-v2.test.js, stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.9 | PASS | 3/3 | 0, 0 | design-v2.test.js, stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.10 | PASS | 2/2 | 0 | design-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.11 | PASS | 2/2 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.12 | PASS | 2/2 | 0, 0 | check-completion-v2.test.js, stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.13 | PASS | 2/2 | 0 | stages-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |
| 3 | L3.14 | PASS | 1/1 | 0 | check-completion-v2.test.js | 2623746ba7ce95a144e95686e1c76512aba1ffb0 |

Levels 4 and 5 are live rows; they are not derivable from TAP and are added from the live evidence.


### 2.3 Levels 4 and 5 (live and manual rows)

Every live call is a real `Workflow` call with `contract: 2` from the detached worktree `/srv/gp-v2/skill`, toy repo
clones `/srv/gp-v2/{a,b,c}`, state under `/srv/gp-v2/state`. Agent calls are counted from the Workflow journal (stage
calls only; the harness's own setup/persist calls are excluded). Token use: not measured.

| Level | Row | Status | Workflow result | Run at | Wall time | Agent calls | Artifact |
|---|---|---|---|---|---|---|---|
| 4a | environment check (worktree clean, clones clean, inputs present) | PASS | ok | 62a0712 | - | 1 | `smoke1b-result.json` |
| 4a | first attempt, designs A, B, C | BLOCKED | BLOCKED at `start` (live bug 1) | 5872536, superseded | - | - | `/srv/gp-v2/state-attempt1-5872536/*/design/r1.result.json` |
| 4a | E2E-B omission (design) | PASS | design PASS | 62a0712, superseded | 21m31s (ceiling 40) | 26 | section 5.3; `/srv/gp-v2/state/feat-7f3a/design/r1.result.json` |
| 4a | E2E-C contradiction (design) | PASS | design FAIL at `prd review` (no freeze) | 62a0712, superseded | 16m33s (ceiling 40) | 23 | section 7.1; `/srv/gp-v2/state/feat-2c9e/design/r1.result.json` |
| 4a | E2E-A attempt 1 design | PASS | PASS | 62a0712, superseded | 27m19s | 25 | `/srv/gp-v2/state/session-login/design/r1.result.json` |
| 4a | E2E-A attempt 1 build | BLOCKED | BLOCKED at `fix` round 1 (real security finding vs active non-goals) | 62a0712, superseded | 10m00s | 9 | section 6.1 |
| 4a | E2E-A2 design (`previous_design` = attempt-1 design commit) | PASS | PASS | 62a0712, superseded | 28m18s | 20 | `smoke2-result.json`; `/srv/gp-v2/state/session-login/design/r2.result.json` |
| 4a | E2E-A2 build | PASS | PASS | 62a0712, superseded | 12m41s | 9 | section 6.2; `/srv/gp-v2/state/session-login/build/r2.result.json` |
| 4a | E2E-A2 verify r2 | BLOCKED | BLOCKED at `plan preflight` (live bug 2) | 62a0712, superseded | 1m21s | 1 | `/srv/gp-v2/state/session-login/verify/r2.result.json` |
| 4a | E2E-A2 verify r3 | BLOCKED | BLOCKED at `negative controls` (live bug 3) | 62e2285, superseded | 18m09s | 25 | `smoke3-result.json`; `.../verify/r3.result.json` |
| 4a | E2E-A2 verify r4 | BLOCKED | INCOMPLETE at `negative controls` (robustness gap 4; failed closed) | 443eba5, superseded | 15m46s | 20 | `smoke4-result.json`; `.../verify/r4.result.json` |
| 4a | E2E-A2 verify and land at `S`; E2E-E drift; E2E-F negative control | NOT RUN (pending in this draft) | - | - | - | - | section "E2E-A2 verify/land and E2E-E (pending live run)" |
| 4a | E2E-H failure injection | NOT RUN | - | - | - | - | time: the 4-CPU host runs 2 agents at a time |
| 4a | E2E-G resume and migration (live) | NOT RUN | - | - | - | - | time |
| 4a | E2E-D drift stress | NOT RUN | - | - | - | - | time |
| 4a | E2E-E2 rev-B recovery (so L2.5 live column) | NOT RUN | - | - | - | - | leftover time only (plan 3.4 item 9); none left |
| 4a | E2E-C2 paraphrased duplicate (S16-semantic) | NOT RUN | - | - | - | - | time |
| 4a | E2E-F2 weak negative control | NOT RUN | - | - | - | - | time (deterministic L3.13 is PASS, mocked) |
| 4b | real Codex PRD/spec/implementation reviews | NOT RUN | - | - | - | - | Codex not installed, no OpenAI key (user decision) |
| 4c | test PR and CI on a disposable remote | NOT RUN | - | - | - | - | this session cannot create GitHub repositories; the toy `origin` is a local bare repo (`/srv/gp-v2/remote.git`), so land stops at the PR step |
| 5.1 | novice agent with SKILL.md only | NOT RUN | - | - | - | - | not run in this round |
| 5.2 | POSIX path matrix (spaces, Unicode in repo, state_dir and worktree) | NOT RUN | - | - | - | - | no dedicated test exists; only L2.1 compiles under a path holding a space and `ü` |
| 5.3 | Windows paths | NOT RUN | - | - | - | - | no Windows host |
| 5.4 | v1 import (`migrate-v1`) | PASS | migrate-v1.test.js 13/13 | 2623746 | - | - | fixtures `conflict, exact, lost, overlap, provenance, reqform, todo, unmapped-test`; preservation test: inputs byte-unchanged, v1 completion still passes |
| 5.5 | 3 requests x 3+ rounds metrics study | NOT RUN | - | - | - | - | cost; `v2-metrics.js` over the live design runs is in section 5.4 as supplementary data |


## 3. Fixture matrix (plan 3.2)

Verbatim second part of the same `make-tables.js` output. Every row: expected exit and codes equal the observed
ones (the fixture test asserts equality), gate as listed.

### Fixture matrix (plan 3.2)

TAP sources (command, exit code, sha256 of the TAP output):
- `node --test --test-reporter=tap tests/check-completion-v2.test.js`: exit 0, sha256 490bdb8dfd51313f5d83a0701b707eedca1f6b55f496ccaa751c9cdd38c8cb26
- `node --test --test-reporter=tap tests/check-completion.test.js`: exit 0, sha256 c5a3090042504be3576d589ae315d6c998c9b784aac4219e0d6ca70bb55b0c47
- `node --test --test-reporter=tap tests/design-v2.test.js`: exit 0, sha256 6e26929a6bbe631bebb2a96a67b2e99ac9e46d6c98462c5e8f7f30e3f5edb835
- `node --test --test-reporter=tap tests/fallback-parity.test.js`: exit 0, sha256 1fd488b50fecf3983d83d65546f22183c30225f0c291cd0da49a5e68e7e2bf25
- `node --test --test-reporter=tap tests/feature-compile.test.js`: exit 0, sha256 c5a5cfe8aa70c45a40a556175889c551b0d592a43fcad637ebbdb47359c5e6e0
- `node --test --test-reporter=tap tests/feature-validate.test.js`: exit 0, sha256 b91e7da1091f773757e4e420c145e2afc054a2657e750a5b3d311a3abc0925a7
- `node --test --test-reporter=tap tests/git-env.test.js`: exit 0, sha256 ab8238c93e2b451871af827e978733ad9a7845f1ebb13900eecfb4d7ef31616b
- `node --test --test-reporter=tap tests/make-tables.test.js`: exit 0, sha256 b5d520106464dcbed2ffc4f1ca6f88f53dbc8653342001e691da9a07f5ec9a20
- `node --test --test-reporter=tap tests/merge-compliance.test.js`: exit 0, sha256 40074602cefd6c6e0055328af0ae95d626de74bdd7dd0c290edc11d97cf128c7
- `node --test --test-reporter=tap tests/migrate-v1.test.js`: exit 0, sha256 10fe8b1ad9b4fd31ca30d01ffb8e5a71db0498cc178fd390417120f3504f644d
- `node --test --test-reporter=tap tests/redact-scan.test.js`: exit 0, sha256 fc896fbe931470396e5cbe4c084ceff4d90fff3d31b2515205a80ce809589f58
- `node --test --test-reporter=tap tests/relay-wait.test.js`: exit 0, sha256 955e68f069b9b8940ce77e9bc4f3b1f2c184acccc523dcfbae5bb23ccf81c5b9
- `node --test --test-reporter=tap tests/replay.test.js`: exit 0, sha256 c49aa46f7a05be00abe98064619c6897ecf73b0e6712a7102278968d2d5f82c4
- `node --test --test-reporter=tap tests/run-frozen.test.js`: exit 0, sha256 881d666712e6fce1a045bfb874ad9eaa0ac36623b4312e62a05bec7608854824
- `node --test --test-reporter=tap tests/run-workflow.test.js`: exit 0, sha256 05a326f9d2bd7a2359ec1bd735bf50eff5c454035e12b5c5d5e69e6dd9e26dcf
- `node --test --test-reporter=tap tests/schema-lite-conformance.test.js`: exit 0, sha256 194a664cb7b5ff1f92b6445119319cadd8fc4f4ce577dc9702948a74dc949157
- `node --test --test-reporter=tap tests/skill-doc.test.js`: exit 0, sha256 e6fec6dd9f05894b27b0005fbaefa0a75969076bf4e0dc6e96ab000cc86f52a8
- `node --test --test-reporter=tap tests/stages-v2.test.js`: exit 0, sha256 fa48a4eaf8465f37193b0a5b6ee7214bba402555186feb308d6662f52e1bd961
- `node --test --test-reporter=tap tests/v2-metrics.test.js`: exit 0, sha256 61a19cf395836f5357cd6412beb6f1fe4a45c7b5b1df8df3cb573639912f4ec1
- `node --test --test-reporter=tap tests/workflows.test.js`: exit 0, sha256 1e6e16caa33fbde6bf748c9c6def279c02bba454a8c0481c82b310116f4c170f
Skill commit: 2623746ba7ce95a144e95686e1c76512aba1ffb0

Observed values are the ones the passing fixture test asserted equal to the expectation; FAIL or NOT RUN replaces them otherwise.

| Case | Fixture | Variant | Expected exit | Expected codes | Rules | Gate | Test | Observed exit | Observed codes |
|---|---|---|---|---|---|---|---|---|---|
| L2 | valid/medium.feature.json | graph base for Level 1 and Level 2 | 0 | - | - | - | PASS | 0 | - |
| L2 | valid/multi-component.feature.json | several components, exclusive and shared | 0 | - | - | - | PASS | 0 | - |
| S01 | valid/S01-minimal.feature.json | minimal | 0 | - | - | - | PASS | 0 | - |
| S02 | valid/S02-unicode-multiline.feature.json | unicode and multi-line strings | 0 | - | - | - | PASS | 0 | - |
| S03 | invalid/S03-bom.feature.json | byte order mark | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |
| S03 | invalid/S03-comment.feature.json | comment | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |
| S03 | invalid/S03-cr-escape.feature.json | \r escape in a string | 1 | E_CONTROL_CHAR | G31 | graph | PASS | 1 | E_CONTROL_CHAR |
| S03 | invalid/S03-dup-key.feature.json | duplicate key | 1 | E_DUP_KEY | - | parse | PASS | 1 | E_DUP_KEY |
| S03 | invalid/S03-invalid-utf8.feature.json | invalid UTF-8 byte | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |
| S03 | invalid/S03-lone-surrogate.feature.json | lone surrogate escape | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |
| S03 | invalid/S03-nan.feature.json | NaN literal | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |
| S03 | invalid/S03-raw-control-char.feature.json | raw control character in a string | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |
| S03 | invalid/S03-trailing-comma.feature.json | trailing comma | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |
| S04 | invalid/S04-schema-version.feature.json | schema_version 3 | 1 | E_SCHEMA_VERSION | - | version | PASS | 1 | E_SCHEMA_VERSION |
| S04 | invalid/S04-unknown-field.feature.json | unknown field | 1 | E_UNKNOWN_FIELD | - | schema | PASS | 1 | E_UNKNOWN_FIELD |
| S04 | invalid/S04-wrong-type.feature.json | wrong type | 1 | E_TYPE | - | schema | PASS | 1 | E_TYPE |
| S05 | invalid/S05-dup-acceptance.feature.json | duplicate acceptance id | 1 | E_DUP_ID | G01 | graph | PASS | 1 | E_DUP_ID |
| S05 | invalid/S05-dup-check.feature.json | duplicate check id | 1 | E_DUP_ID | G01 | graph | PASS | 1 | E_DUP_ID |
| S05 | invalid/S05-dup-goal.feature.json | duplicate goal id | 1 | E_DUP_ID | G01 | graph | PASS | 1 | E_DUP_ID |
| S05 | invalid/S05-dup-requirement.feature.json | duplicate requirement id | 1 | E_DUP_ID | G01 | graph | PASS | 1 | E_DUP_ID |
| S06 | invalid/S06-no-expected.feature.json | runtime acceptance without expected | 1 | E_PROOF | G18 | graph | PASS | 1 | E_PROOF |
| S06 | invalid/S06-no-given.feature.json | acceptance without given | 1 | E_REQUIRED | - | schema | PASS | 1 | E_REQUIRED |
| S06 | invalid/S06-no-statement.feature.json | requirement without statement | 1 | E_REQUIRED | - | schema | PASS | 1 | E_REQUIRED |
| S06 | invalid/S06-no-then.feature.json | acceptance without then | 1 | E_REQUIRED | - | schema | PASS | 1 | E_REQUIRED |
| S06 | invalid/S06-no-when.feature.json | acceptance without when | 1 | E_REQUIRED | - | schema | PASS | 1 | E_REQUIRED |
| S06 | invalid/S06-runtime-no-command.feature.json | runtime acceptance without command | 1 | E_PROOF | G18 | graph | PASS | 1 | E_PROOF |
| S06 | invalid/S06-source-both-forms.feature.json | source_request with both forms | 1 | E_SOURCE_FORM | G08 | graph | PASS | 1 | E_SOURCE_FORM |
| S06 | invalid/S06-source-no-form.feature.json | source_request with no form | 1 | E_SOURCE_FORM | G08 | graph | PASS | 1 | E_SOURCE_FORM |
| S06 | invalid/S06-source-ref-no-summary.feature.json | ref form without summary | 1 | E_SOURCE_FORM | G08 | graph | PASS | 1 | E_SOURCE_FORM |
| S07 | invalid/S07-unknown-check-id.feature.json | unknown check_id | 1 | E_REF | G05 | graph | PASS | 1 | E_REF |
| S07 | invalid/S07-unknown-cite.feature.json | unknown id cited by an accepted risk | 1 | E_REF | G05 | graph | PASS | 1 | E_REF |
| S07 | invalid/S07-unknown-component.feature.json | unknown component | 1 | E_REF | G05 | graph | PASS | 1 | E_REF |
| S07 | invalid/S07-unknown-depends-on.feature.json | unknown depends_on | 1 | E_REF | G05 | graph | PASS | 1 | E_REF |
| S07 | invalid/S07-unknown-goal.feature.json | unknown goal | 1 | E_REF | G05 | graph | PASS | 1 | E_REF |
| S07 | invalid/S07-unknown-requirement.feature.json | unknown requirement in coverage | 1 | E_REF | G05 | graph | PASS | 1 | E_REF |
| S07 | invalid/S07-unknown-source.feature.json | unknown source id | 1 | E_REF | G05 | graph | PASS | 1 | E_REF |
| S08 | invalid/S08-cycle.feature.json | depends_on cycle | 1 | E_CYCLE | G07 | graph | PASS | 1 | E_CYCLE |
| S08 | invalid/S08-depends-on-retired.feature.json | depends_on a retired requirement | 1 | E_REF | G06 | graph | PASS | 1 | E_REF |
| S09 | invalid/S09-exclusive-overlap.feature.json | overlapping exclusive owners | 1 | E_OWNERSHIP | G35 | graph | PASS | 1 | E_OWNERSHIP |
| S09 | invalid/S09-owned-outside-allowed.feature.json | owned path outside allowed | 1 | E_OWNERSHIP | G36 | graph | PASS | 1 | E_OWNERSHIP |
| S09 | invalid/S09-test-inside-owned.feature.json | test path inside an owned path | 1 | E_OWNERSHIP | G37 | graph | PASS | 1 | E_OWNERSHIP |
| S10 | invalid/S10-allowed-inside-protected.feature.json | allowed path inside protected | 1 | E_PROTECTED_OVERLAP | G33 | graph | PASS | 1 | E_PROTECTED_OVERLAP |
| S10 | invalid/S10-clean-ignore-owned.feature.json | clean_ignore containing an owned path | 1 | E_STATE_OVERLAP | G34 | graph | PASS | 1 | E_STATE_OVERLAP |
| S10 | invalid/S10-owned-inside-protected.feature.json | owned path inside protected | 1 | E_PROTECTED_OVERLAP | G33 | graph | PASS | 1 | E_PROTECTED_OVERLAP |
| S10 | invalid/S10-state-contains-features-dir.feature.json | state path containing features_dir | 1 | E_PROTECTED_OVERLAP | G33 | graph | PASS | 1 | E_PROTECTED_OVERLAP |
| S10 | invalid/S10-state-equals-allowed.feature.json | state path equal to an allowed path | 1 | E_STATE_OVERLAP | G34 | graph | PASS | 1 | E_STATE_OVERLAP |
| S10 | invalid/S10-state-inside-test.feature.json | state path inside a test path (the test path is outside allowed_paths) | 1 | E_STATE_OVERLAP | G34 | graph | PASS | 1 | E_STATE_OVERLAP |
| S11 | invalid/S11-check-no-reason.feature.json | check without reason | 1 | E_REASON_MISSING | G27 | graph | PASS | 1 | E_REASON_MISSING |
| S11 | invalid/S11-exempt-no-reason.feature.json | exempt without exemption_reason | 1 | E_NEGATIVE_CONTROL | G23 | graph | PASS | 1 | E_NEGATIVE_CONTROL |
| S11 | invalid/S11-known-failure-no-reason.feature.json | known failure without reason | 1 | E_REASON_MISSING | G29 | graph | PASS | 1 | E_REASON_MISSING |
| S11 | invalid/S11-live-isolated-mutation.feature.json | live acceptance with isolated_mutation | 1 | E_NEGATIVE_CONTROL | G24 | graph | PASS | 1 | E_NEGATIVE_CONTROL |
| S11 | invalid/S11-retired-acceptance-no-rationale.feature.json | retired acceptance with empty retired_rationale | 1 | E_REASON_MISSING | G17 | graph | PASS | 1 | E_REASON_MISSING |
| S11 | invalid/S11-retired-goal-no-rationale.feature.json | retired goal without retired_rationale | 1 | E_REASON_MISSING | G17 | graph | PASS | 1 | E_REASON_MISSING |
| S11 | invalid/S11-retired-invariant-no-rationale.feature.json | retired invariant without retired_rationale | 1 | E_REASON_MISSING | G17 | graph | PASS | 1 | E_REASON_MISSING |
| S11 | invalid/S11-retired-requirement-no-rationale.feature.json | retired requirement without retired_rationale | 1 | E_REASON_MISSING | G17 | graph | PASS | 1 | E_REASON_MISSING |
| S12 | invalid/S12-blank-suite-command.feature.json | whitespace-only suite command | 1 | E_PROOF | G20 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-blank-unit-command.feature.json | whitespace-only unit command | 1 | E_PROOF | G20 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-budget-above-timeout.feature.json | budget_min above timeout_min | 1 | E_LIMIT | G30 | graph | PASS | 1 | E_LIMIT |
| S12 | invalid/S12-check-no-command.feature.json | applicable check without command | 1 | E_REASON_MISSING | G28 | graph | PASS | 1 | E_REASON_MISSING |
| S12 | invalid/S12-empty-setup-command.feature.json | empty setup command | 1 | E_PROOF | G20 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-exit-code-1.feature.json | expected exit_code 1 | 1 | E_CONST | - | schema | PASS | 1 | E_CONST |
| S12 | invalid/S12-kind-manual.feature.json | unsupported kind manual | 1 | E_ENUM | - | schema | PASS | 1 | E_ENUM |
| S12 | invalid/S12-live-command-differs.feature.json | live command differing from its check | 1 | E_PROOF | G21 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-live-no-check-id.feature.json | live acceptance without check_id | 1 | E_PROOF | G21 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-multiline-command.feature.json | multi-line acceptance command | 1 | E_PROOF | G20 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-multiline-suite-command.feature.json | multi-line suite command | 1 | E_PROOF | G20 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-proof-over-one-call.feature.json | proof_timeout_s whose one proof cannot finish inside one foreground call | 1 | E_LIMIT | G40 | graph | PASS | 1 | E_LIMIT |
| S12 | invalid/S12-static-with-command.feature.json | static acceptance with command | 1 | E_PROOF | G19 | graph | PASS | 1 | E_PROOF |
| S12 | invalid/S12-suite-over-one-call.feature.json | suite timeout_min whose run cannot finish inside one foreground call | 1 | E_LIMIT | G40 | graph | PASS | 1 | E_LIMIT |
| S12 | invalid/S12-undeclared-live.feature.json | live: false with the command of a budgeted check | 1 | E_PROOF | G22 | graph | PASS | 1 | E_PROOF |
| S13 | valid/S13-not-applicable-check.feature.json | not-applicable check with reason | 0 | - | - | - | PASS | 0 | - |
| S14 | invalid/S14-covered-src-no-requirement.feature.json | covered SRC without requirement | 1 | E_COVERAGE | G09 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-empty-component-ids.feature.json | active requirement with empty component_ids | 1 | E_COVERAGE | G14 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-empty-goal-ids.feature.json | active requirement with empty goal_ids | 1 | E_COVERAGE | G13 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-excluded-src-no-rationale.feature.json | excluded SRC without rationale | 1 | E_COVERAGE | G10 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-goal-without-requirement.feature.json | goal without requirement | 1 | E_COVERAGE | G11 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-goal-without-source.feature.json | goal whose source_ids name only an excluded SRC | 1 | E_COVERAGE | G12 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-only-retired-component.feature.json | active requirement whose only component is retired | 1 | E_COVERAGE | G14 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-only-retired-goal.feature.json | active requirement whose only goal is retired | 1 | E_COVERAGE | G13 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-requirement-no-acceptance.feature.json | requirement without active acceptance | 1 | E_COVERAGE | G15 | graph | PASS | 1 | E_COVERAGE |
| S14 | invalid/S14-requirement-not-sourced.feature.json | requirement listed by no SRC, no derived_rationale | 1 | E_COVERAGE | G16 | graph | PASS | 1 | E_COVERAGE |
| S15 | valid/S15-contradiction.feature.json | contradiction (semantic, review gate) | 0 | - | - | - | PASS | 0 | - |
| S16 | valid/S16-paraphrase.feature.json | paraphrased duplicate (semantic, review gate) | 0 | - | - | - | PASS | 0 | - |
| S20 | invalid/S20-isolated-empty-test-paths.feature.json | isolated_mutation with empty test_paths | 1 | E_NEGATIVE_CONTROL | G26 | graph | PASS | 1 | E_NEGATIVE_CONTROL |
| S20 | invalid/S20-isolated-no-mutation.feature.json | isolated_mutation without mutation | 1 | E_NEGATIVE_CONTROL | G23 | graph | PASS | 1 | E_NEGATIVE_CONTROL |
| S20 | invalid/S20-no-control-description.feature.json | negative control without description | 1 | E_REQUIRED | - | schema | PASS | 1 | E_REQUIRED |
| S20 | invalid/S20-p0-all-exempt.feature.json | P0 all-exempt without alternate evidence | 1 | E_NEGATIVE_CONTROL | G25 | graph | PASS | 1 | E_NEGATIVE_CONTROL |
| S20 | valid/S20-alternate-evidence.feature.json | P0 all-exempt with alternate evidence | 0 | - | - | - | PASS | 0 | - |
| X01 | previous/X01-reactivated-non-goal.feature.json | retired non-goal active again | 1 | E_ID_REACTIVATED | P02 | previous rule | PASS | 1 | E_ID_REACTIVATED |
| X01 | previous/X01-reactivated-src.feature.json | excluded SRC covered again | 1 | E_ID_REACTIVATED | P02 | previous rule | PASS | 1 | E_ID_REACTIVATED |
| X01 | previous/X01-removed-acceptance.feature.json | acceptance removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-check.feature.json | check removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-component.feature.json | component removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-decision.feature.json | decision removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-goal.feature.json | goal removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-invariant.feature.json | invariant removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-non-goal.feature.json | non-goal removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-requirement.feature.json | requirement removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-risk.feature.json | accepted risk removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X01 | previous/X01-removed-src.feature.json | SRC removed | 1 | E_ID_REMOVED | P01 | previous rule | PASS | 1 | E_ID_REMOVED |
| X02 | invalid/X02-dup-statement.feature.json | identical normalized statements | 1 | E_DUP_STATEMENT | G04 | graph | PASS | 1 | E_DUP_STATEMENT |
| X02 | invalid/X02-shadow-fix.feature.json | id segment -FIX | 1 | E_SHADOW_ID | G03 | graph | PASS | 1 | E_SHADOW_ID |
| X02 | invalid/X02-shadow-rev2.feature.json | id segment -REV2 | 1 | E_SHADOW_ID | G03 | graph | PASS | 1 | E_SHADOW_ID |
| X02 | invalid/X02-shadow-v2.feature.json | id segment -V2 | 1 | E_SHADOW_ID | G03 | graph | PASS | 1 | E_SHADOW_ID |
| X02 | invalid/X02-title-final.feature.json | title segment -final | 1 | E_SHADOW_ID | G03 | graph | PASS | 1 | E_SHADOW_ID |
| X03 | invalid/X03-absolute.feature.json | absolute path | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-backslash.feature.json | backslash | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-control-char.feature.json | control character (TAB) | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-dotdot.feature.json | .. segment in an owned path | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-evidence-absolute.feature.json | absolute evidence path | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-git-allowed.feature.json | allowed path under .git/ | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-git-owned.feature.json | owned path with a .GIT segment | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-non-ascii.feature.json | non-ASCII character | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X03 | invalid/X03-tilde.feature.json | tilde | 1 | E_UNSAFE_PATH | G32 | graph | PASS | 1 | E_UNSAFE_PATH |
| X04 | invalid/X04-acceptance-prefix.feature.json | acceptance id not prefixed by its requirement | 1 | E_ID_FORMAT | G02 | graph | PASS | 1 | E_ID_FORMAT |
| X04 | invalid/X04-basename-mismatch.feature.json | --repo-path basename differs from feature_id | 1 | E_SCOPE | G38 | graph | PASS | 1 | E_SCOPE |
| X04 | invalid/X04-check-id-dotdot.feature.json | check id CHECK-../x | 1 | E_PATTERN | - | schema | PASS | 1 | E_PATTERN |
| X04 | invalid/X04-feature-id-dots.feature.json | feature_id made only of dots | 1 | E_SCOPE | G38 | graph | PASS | 1 | E_SCOPE |
| X04 | invalid/X04-features-dir-under-git.feature.json | features_dir under .git/ | 1 | E_SCOPE | G38 | graph | PASS | 1 | E_SCOPE |
| X04 | invalid/X04-lowercase-component.feature.json | lower-case component id | 1 | E_PATTERN | - | schema | PASS | 1 | E_PATTERN |
| X04 | invalid/X04-proto-key.feature.json | __proto__ key | 1 | E_FORBIDDEN_KEY | - | parse | PASS | 1 | E_FORBIDDEN_KEY |
| X05 | invalid/X05-goal-source-ids-empty.feature.json | goal source_ids empty (minItems 1) | 1 | E_MIN_ITEMS | - | schema | PASS | 1 | E_MIN_ITEMS |
| X05 | invalid/X05-maximum.feature.json | maximum | 1 | E_MAXIMUM | - | schema | PASS | 1 | E_MAXIMUM |
| X05 | invalid/X05-min-items.feature.json | minItems | 1 | E_MIN_ITEMS | - | schema | PASS | 1 | E_MIN_ITEMS |
| X05 | invalid/X05-min-length.feature.json | minLength | 1 | E_MIN_LENGTH | - | schema | PASS | 1 | E_MIN_LENGTH |
| X05 | invalid/X05-minimum.feature.json | minimum | 1 | E_MINIMUM | - | schema | PASS | 1 | E_MINIMUM |
| X05 | invalid/X05-pattern.feature.json | pattern | 1 | E_PATTERN | - | schema | PASS | 1 | E_PATTERN |
| X06 | invalid/X06-excerpt-leak.feature.json | ref-mode excerpt holding 40 code points of the request | 1 | E_SOURCE_LEAK | R04 | source rule | PASS | 1 | E_SOURCE_LEAK |
| X06 | invalid/X06-ref-sha-mismatch.feature.json | ref sha256 differs from the request bytes | 1 | E_SOURCE_MISMATCH | R02 | source rule | PASS | 1 | E_SOURCE_MISMATCH |
| X06 | invalid/X06-text-form-ref-mode.feature.json | text form in ref mode | 1 | E_SOURCE_FORM | R03 | source rule | PASS | 1 | E_SOURCE_FORM |
| X06 | invalid/X06-text-mismatch.feature.json | text differs from the request | 1 | E_SOURCE_MISMATCH | R01 | source rule | PASS | 1 | E_SOURCE_MISMATCH |
| X06 | valid/X06-ref.feature.json | valid ref form in ref mode | 0 | - | - | - | PASS | 0 | - |
| X07 | invalid/X07-migration-todo.feature.json | MIGRATION-TODO in a statement | 1 | E_MIGRATION_TODO | G39 | graph | PASS | 1 | E_MIGRATION_TODO |

Cases without a fixture file (stage and mode tests):

| Case | Status | Tests ok/total | Artifact |
|---|---|---|---|
| S17 | PASS | 1/1 | feature-compile.test.js |
| S18 | PASS | 33/33 | stages-v2.test.js |
| S19a | PASS | 4/4 | check-completion-v2.test.js |
| S19b | PASS | 1/1 | stages-v2.test.js |

## 4. Determinism (L2.1)

Test: `feature-compile.test.js: L2.1 determinism: two checkouts at different absolute paths, cwd, TZ and LC_ALL compile
byte-identical outputs` - PASS at `S` (TAP sha256 `c5a5cfe8aa70c45a40a556175889c551b0d592a43fcad637ebbdb47359c5e6e0`).
It compiles the 3 specs `S01-minimal`, `medium`, `multi-component` in two checkouts (one under `nested dir ü/deeper`),
cwd = repo vs checkout root, `TZ=UTC LC_ALL=C` vs `TZ=Pacific/Chatham LC_ALL=tr_TR.UTF-8`, `--file` absolute vs
relative; asserts the four files byte-equal, the six printed hashes equal, an in-process third render equal, and no
absolute checkout path in any output. The test prints no hashes, so one extra compile pair was run by hand:

Fixture `valid/S02-unicode-multiline.feature.json` (sha256 `c339b63cdf312a02a03611ce21c32bf3442f3535221345dc0bc6bd58431e8501`),
two fresh `--out` dirs; run 1 cwd `/`, `TZ=UTC LC_ALL=C`; run 2 cwd = the scratch dir, `TZ=Asia/Tokyo LC_ALL=en_US.UTF-8`;
both exit 0, stdout identical except the `out` field.

| File | out1 sha256 | out2 sha256 |
|---|---|---|
| execution-plan.json | b87c5fcfc9e99da65df9ade501497bd3ed1a5a9f1a5213e08fccd386ebf8401b | b87c5fcfc9e99da65df9ade501497bd3ed1a5a9f1a5213e08fccd386ebf8401b |
| prd.view.md | 02a4a20ccfb9a8283cd06afbe8694ea0897c2f011f89b0571c3ebbe2a538de25 | 02a4a20ccfb9a8283cd06afbe8694ea0897c2f011f89b0571c3ebbe2a538de25 |
| spec.view.md | d0e292f94e5d923e98b868d5d165304b4d7b7d4baa0aa54ce4c8ed74c4d1d1eb | d0e292f94e5d923e98b868d5d165304b4d7b7d4baa0aa54ce4c8ed74c4d1d1eb |
| compile-identity.json | c70d37fa7b172441df0f5c0a3fd3e3b32327d761e973a050a4e484bdf399c98b | c70d37fa7b172441df0f5c0a3fd3e3b32327d761e973a050a4e484bdf399c98b |

Printed `prd_projection_sha256` (both runs): `a72cda5d93a38f1fd0d98a69a06641dfa190752917d82b729127b6381d28ef75`. Status: PASS.

## 5. Review verdicts

### 5.1 Plan review (before any code)

Three multi-lens rounds, then a main-session decision round (16 decisions applied to design and plan, no addenda),
then a blocking-only convergence gate. Dispositions: the "Review log" at the end of `docs/v2-plan.md`
(134 lines; 139 ACCEPTED and 5 PARTIAL dispositions, none rejected; PARTIAL lines name what remains).
Sources: `wj1kmo2qp.output` (rounds 1-3), `wbvw5885f.output` (revision and gate).

| Round | Findings | BLOCKING / MAJOR / MINOR | Outcome |
|---|---|---|---|
| r1 | 48 | 7 / 30 / 11 | revised |
| r2 | 47 | 2 / 30 / 15 | revised |
| r3 | 46 | 3 / 18 / 25 | round cap reached with open serious findings; returned to the main session |
| decision round | 16 decisions | - | applied in place to `v2-design.md` and `v2-plan.md` |
| gate 1 | 2 BLOCKING (`v2-suite-exit-code-not-bound`, `relay-gp-exec-single-block-vs-foreground-polling`) | 2 / - / - | both ACCEPTED and fixed; gate judged the plan implementable |
| gate 2 | 1 BLOCKING (`approvals-codex-verdict-equality-contradiction`) | 1 / - / - | ACCEPTED, design 5 split runner consistency from the gate verdict; no third gate round is recorded |

### 5.2 Whole-change code review (WP7 step 2)

Reviewer `claude-opus-high (codex unavailable)`, two lenses (A, B), on the change up to `698827c`; 11 findings, 0 BLOCKING, 3 MAJOR,
all FIXED with tests (source: `code-review-result.json`; final check at `5872536`: suites green except fake-runner
case 4, redaction scan clean).

| Id | Severity | Problem (one line) | Disposition |
|---|---|---|---|
| A1 | MAJOR | The #37 parity suite for contract-2 build/verify never ran: its eval'd slice lacked `gitEnv`, the describe threw, and TAP still said `# fail 0`, exit 0 | FIXED `7fe8e15` (slice gets `gitEnv`, build failure is a failing test, 28-row count test, make-tables fails a Level 0 row on any `not ok`) |
| A2 | MINOR | Contract-2 implementer/fixer prompts still asked for a model-written execution ledger | FIXED `e326213` |
| A3 | MINOR | SKILL.md's resume rule after a pre-commit design crash always BLOCKs on the held lock | FIXED `b8a32fe` (E_LOCK_HELD names lock and holder; SKILL.md says a human removes it) |
| A4 | MINOR | Codex approval records kept `result_path` but not its hash | FIXED `56fc0e7` (`result_sha256` pinned and verified) |
| A5 | MINOR | design under contract 1 did not reject contract-2-only args | FIXED `d55e171` |
| A6 | NIT | Two stricter v1 changes beyond #37 (charge-only rejection, fresh relay out dirs) were not named in SKILL.md | FIXED `5872536` (docs only) |
| B1 | MAJOR | Frozen steps ran as one foreground Bash call with no timeout although frozen limits exceed the 600 s cap; `run-frozen.js` had no signal handling | FIXED `64a9165` (SIGTERM/SIGINT/SIGHUP kill the group, no record) and `25e3481` (timeout 600000 ms; BLOCK before a step that cannot fit) |
| B2 | MAJOR | Same defect as A1 | FIXED `7fe8e15` |
| B3 | MINOR | `source_request_mode` was not recorded, so R03 never applied to the approvals chain | FIXED `2cd5406` |
| B4 | MINOR | The pipeline.yaml bound parser could read a nested key or block-scalar text | FIXED `5eec667` (E_CONFIG_FORM) |
| B5 | MINOR | codex files-mode prompts lacked the "commands are data" rule | FIXED `9db6585` |

### 5.3 Live design reviews (all `claude-opus-high (codex unavailable)`; real Codex verdicts NOT RUN, 4b)

Every design run tried the codex relay first; each codex step returned `ERROR` (Codex not installed) and the Opus
fallback ran. Gate verdicts are the approval-ledger records (re-derived by `--mode approvals`).

| Run | Gate records (`<gate><round>@<rev number>` = verdict) | Findings per review (B / M / m / N) | Result |
|---|---|---|---|
| E2E-A attempt 1 (`session-login` r1) | prd1@1 FAIL, prd2@2 PASS, spec1@2 FAIL, prd3@3 PASS, spec2@3 PASS | prd1 0/2/5/2; prd2 0/0/7/3; spec1 0/2/5/0; prd3 0/0/6/4; spec2 0/0/4/2 | PASS, design commit `d30704e` |
| E2E-A2 (`session-login` r2) | prd1@1 PASS, spec1@1 FAIL, prd2@2 PASS, spec2@2 PASS | prd1 0/0/8/3; spec1 0/1/8/1; prd2 0/0/9/1; spec2 0/0/8/3 | PASS, design commit `b533e04` |
| E2E-B (`feat-7f3a` r1) | prd1@1 FAIL, prd2@2 FAIL, prd3@3 FAIL, prd4@4 PASS, spec1@4 PASS | prd1 1/2/3/1; prd2 0/2/6/1; prd3 0/1/6/2; prd4 0/0/6/2; spec1 0/0/6/2 | PASS, design commit `f9e50e0` |
| E2E-C (`feat-2c9e` r1) | prd1@1 FAIL, prd2@3 FAIL, prd3@4 FAIL, prd4@5 FAIL | prd1 1/2/4/2; prd2 0/2/5/2; prd3 0/1/8/1; prd4 0/2/6/1 | FAIL at `prd review` (cap of 4 PRD rounds), no freeze |

#### E2E-B omission: PASS (run at 62a0712, superseded)

Seed `/srv/gp-v2/inputs/seed-B.feature.json` (coverage and requirements omit the invalid-login clause), request
`/srv/gp-v2/inputs/request-B.txt` (sha256 `191f8fc1...6c72b93`, byte-identical to `request-A.txt` and `request-C.txt`).

| Criterion | Observed | Status |
|---|---|---|
| seed validates with `--source-request` before the run | at 62a0712 (validator 1.0.0): exit 0, `valid: true`, source sha256 `85f3cb54d76e82ab21f1ad0eedcd1195c18205a3bd67fac971e356cb29b7ea1f`. At `S` (1.1.0): exit 1, `E_LIMIT` G40 `/suite/timeout_min` (rule added after the run, live bug 2) | PASS (at the pinned SHA) |
| round 1 non-PASS citing the source request | prd1 gate FAIL; finding 1 BLOCKING 0.95 `incomplete` "Request item '401 with the same generic error body' is neither covered nor excluded"; detail quotes the request clause "wrong password or unknown user return 401 with the same generic error body" and notes SRC-001..SRC-005 do not cover it | PASS |
| round 1 approval `source_sha256` == sha256(seed) | `approvals-1.json` record 1 `source_sha256` = `85f3cb54...b7ea1f` = `sha256sum seed-B.feature.json` | PASS |
| frozen file has an invalid-login requirement | `git show f9e50e0:.pipeline/features/feat-7f3a.feature.json` (sha256 `174123fc8e3626a5ef170b0c48ccb7e25a9ee2a72882a409cf312634e48deb75`): LOGIN-003 active, "A well-formed POST /login whose password is wrong for a registered user, or whose username is not registered, returns 401 with the JSON body {"error":"invalid credentials"}; the two cases return byte-identical bodies. ..." | PASS |
| original ids kept (`--previous` held) | all 31 seed ids present; 10 added (SRC-006, RISK-002, LOGIN-003, LOGIN-003-AC1, LOGIN-004, LOGIN-004-AC1, LOGIN-004-AC2, RATE-001-AC3, RATE-001-AC4, RATE-001-AC5); `validate-feature.js --previous seed-B.feature.json --source-request request-B.txt` on the frozen file at 62a0712: exit 0 | PASS |
| freeze re-check | `check-completion.js --mode approvals` on `approvals-5.json`: 62a0712 exit 0 (PASS, rule `same-revision`); `S` exit 1 `E_APPROVALS` "rev-1 does not validate: E_LIMIT /suite/timeout_min" (G40 again) | run at 62a0712, superseded |

Rev diff (seed -> frozen): ids only added, none removed or renamed; LOGIN-003 is the new 401 requirement and RATE-001
was rewritten to define a failed attempt as a LOGIN-003 401 with a sliding 60 s window.


#### Semantic independence check (plan 3.4), scenarios B and C

Fixed word list: `e2e|omission|contradiction|duplicate|seed|inject|defect|stress|weak` (case-insensitive).

| Check | Inputs | Hits | Status |
|---|---|---|---|
| (2) scenario-specific inputs, full list | `seed-B.feature.json`, `seed-C.feature.json`, `request-B.txt`, `request-C.txt`, both run dirs' `source-request.txt`, feature ids `feat-7f3a` / `feat-2c9e`, branches `feat/f7f3a` / `feat/f2c9e`, run dirs `/srv/gp-v2/state/feat-7f3a/design/r1` / `/srv/gp-v2/state/feat-2c9e/design/r1` | 0 in every input | PASS |
| (1) differential, as planned (control prompt rendered by `run-workflow.js` from `S` for a neutral feature) | - | - | NOT RUN |
| (1') differential from the journals (substitute) | the 18 B/C reviewer prompts (codex and Opus, PRD and spec) diffed line-by-line against E2E-A's round-1 prompt of the same step, after replacing the feature id, repo dir, branch, rev/round numbers and sha256 values with placeholders | 18 differing lines (each the validate/compile/hash-check command line, which also names the repo clone); 0 hits | PASS (substitute method, labelled) |
| stock baseline | the same full prompts | Opus PRD review prompts 2 hits each (`duplicate`, `defect`), Opus spec prompts 1 (`defect`), codex prompts 0, identical in the A control | data |

#### E2E-B and E2E-C reviewer findings (verbatim fields)

E2E-B (`feat-7f3a`), in review order:

| Review | Severity | Confidence | iso_property | Title |
|---|---|---|---|---|
| prd 1 | BLOCKING | 0.95 | incomplete | Request item '401 with the same generic error body' is neither covered nor excluded |
| prd 1 | MAJOR | 0.85 | incomplete | Input-validation security statement changes user-visible behaviour with no requirement or response defined |
| prd 1 | MAJOR | 0.8 | ambiguous | 'Failed login attempt' and the window semantics are undefined in RATE-001 |
| prd 1 | MINOR | 0.7 | incomplete | Session map grows without bound; resource_consumption only bounds failure counters |
| prd 1 | MINOR | 0.6 | ambiguous | LOG-001-AC1 refers to a 'logger' that does not exist in the repo |
| prd 1 | MINOR | 0.55 | null | Controllable clock needed by RATE-001 ACs is an unnamed interface dependency |
| prd 1 | NIT | 0.6 | null | LOGIN-002 duplicates DEC-001 and puts an implementation choice into a requirement |
| prd 2 | MAJOR | 0.75 | inconsistent | Fixed-window decision lets 5 failures within 60 s go unlimited, contradicting the request and RATE-001-AC1 |
| prd 2 | MAJOR | 0.7 | null | Derived success-resets-count rule contradicts the request and has no rationale |
| prd 2 | MINOR | 0.65 | ambiguous | Unclear whether a 200 login also closes the open window |
| prd 2 | MINOR | 0.65 | inconsistent | RATE-001 says every request for a limited username gets 429, but LOGIN-004 answers malformed ones 400 |
| prd 2 | MINOR | 0.7 | incomplete | resource_consumption statement leaves out the session token map and relies on pruning no requirement asks for |
| prd 2 | MINOR | 0.6 | incomplete | Acceptance scenarios rely on a 'controllable clock' that no requirement or constraint defines |
| prd 2 | MINOR | 0.65 | ambiguous | LOG-001 acceptance refers to a 'logger' the repo does not have |
| prd 2 | MINOR | 0.55 | null | LOGIN-004 is a derived requirement traced only to 'Add focused tests' |
| prd 2 | NIT | 0.6 | unverifiable | LOGIN-002 repeats DEC-001 and its implementation clause cannot be checked |
| prd 3 | MAJOR | 0.75 | incomplete | No-logging requirement and its test leave out the 400 (malformed body) path, which is where a password is most likely to reach a log |
| prd 3 | MINOR | 0.6 | inconsistent | The precedence between 400, 429 and 401 is stated as absolute rules that contradict each other |
| prd 3 | MINOR | 0.75 | incomplete | The resource_consumption statement leaves out the token map, which grows without bound |
| prd 3 | MINOR | 0.55 | incomplete | The memory bound for failure records depends on cleanup no requirement asks for |
| prd 3 | MINOR | 0.6 | unverifiable | RATE-002-AC1 still passes if the limiter does nothing, and its clock wording is vague |
| prd 3 | MINOR | 0.6 | ambiguous | LOG-001-AC1 refers to a logger the repo does not have and does not say which output is captured |
| prd 3 | MINOR | 0.7 | null | Derived requirement LOGIN-004 is traced to the request item "Add focused tests", which is not where it comes from |
| prd 3 | NIT | 0.7 | null | The fixed-window figure in DEC-002's rationale is wrong |
| prd 3 | NIT | 0.5 | null | The "operator" actor is listed but no goal or requirement refers to it |
| prd 4 | MINOR | 0.8 | inconsistent | RATE-001 / INV-002 say every attempt for a limited username gets 429, but LOGIN-004 answers malformed ones 400 first |
| prd 4 | MINOR | 0.6 | unverifiable | The memory bound for failure records depends on pruning idle usernames, which no requirement states or tests |
| prd 4 | MINOR | 0.6 | incomplete | Issued tokens are kept in an unbounded in-memory map that nothing reads, and the resource section leaves this out |
| prd 4 | MINOR | 0.7 | null | LOGIN-004 is a derived requirement traced only to "Add focused tests", with no rationale of its own |
| prd 4 | MINOR | 0.6 | ambiguous | LOG-001-AC1 captures "logger output", but the repo has no logger and "log output" is never defined |
| prd 4 | MINOR | 0.5 | null | The accepted timing difference lets a client tell which usernames exist, despite the security section's no-enumeration framing |
| prd 4 | NIT | 0.6 | ambiguous | RATE-002-AC1's "current 60 seconds" reads like a fixed window and gives no clock |
| prd 4 | NIT | 0.5 | incomplete | Behavior for non-POST methods on /login and the "operator" actor are left undefined |
| spec 1 | MINOR | 0.7 | incomplete | Logger component src/log.js is new, not in the approach, and has no capture seam for LOG-001-AC1 |
| spec 1 | MINOR | 0.65 | unverifiable | INV-002 and the 'before the store is consulted' clauses have no proof |
| spec 1 | MINOR | 0.6 | unverifiable | The 'from crypto.randomBytes' part of LOGIN-002 is not verified |
| spec 1 | MINOR | 0.55 | ambiguous | LOGIN-004-AC1 mutation assumes validation lives in src/login.js, but the approach does not say so |
| spec 1 | MINOR | 0.6 | inconsistent | RATE-001 'every POST /login ... is answered 429' conflicts with LOGIN-004's 400-before-limiter rule |
| spec 1 | MINOR | 0.7 | null | No ranked cut list |
| spec 1 | NIT | 0.8 | null | Spec view shows protected_paths: none, but the manifest protects .pipeline/features/ |
| spec 1 | NIT | 0.6 | null | CHECK-SYNTAX covers only src/server.js |

E2E-C (`feat-2c9e`) reviewer findings are listed in section 7.1.

### 5.4 Supplementary metrics (row 5.5 tool over the live design runs, at `S`)

`node tests/helpers/v2-metrics.js --run-dir <run dir> --repo <clone> [--commit <design commit>] --repo-path <rel>`,
all exit 0. Supplementary data only; row 5.5 itself is NOT RUN.

| Metric | A r1 (`d30704e`) | A r2 (`b533e04`) | B r1 (`f9e50e0`) | C r1 (no commit) |
|---|---|---|---|---|
| revisions | 3 | 3 | 4 | 5 |
| authoritative_files | PASS (1 file) | PASS (1 file) | PASS (1 file) | NOT RUN (no design commit) |
| shadow_requirements | PASS (0) | PASS (0) | PASS (0) | PASS (0) |
| duplicate_requirements | PASS (0) | PASS (0) | PASS (0) | PASS (0) |
| unresolved_references | PASS (0) | PASS (0) | PASS (0) | PASS (0) |
| approval_hash_consistency | PASS (5 records) | PASS (4 records) | PASS (5 records) | PASS (4 records) |
| approvals_validator (`--mode approvals` at `S`) | PASS | PASS | FAIL: exit 1, G40 at `S` (exit 0 at 62a0712, section 5.3) | NOT RUN (no spec record) |
| reviewer_rounds | PASS (prd FAIL/PASS/PASS; spec FAIL/PASS) | PASS (prd PASS/PASS; spec FAIL/PASS) | PASS (prd FAIL/FAIL/FAIL/PASS; spec PASS) | FAIL (prd FAIL x4) |
| summary | 7 PASS | 7 PASS | 6 PASS, 1 FAIL | 4 PASS, 1 FAIL, 2 NOT RUN |

## 6. E2E-A happy path

### 6.1 Attempt 1 (run at 62a0712, superseded)

| Step | Observed | Status |
|---|---|---|
| design | PASS; design commit `d30704e519a9bc44ba968b08a0f182ce760ed3d0` on start_head `ee05971`; source sha256 `60dcbe41...b82f72b`; manifest `b4d900d9...443e71`; approvals `a777e5cf...893a7db4`; request sha256 `191f8fc1...6c72b93` | PASS |
| build implement | commit `4cb8264` on base `d30704e` (base == design_commit) | PASS |
| build review 1 | Opus implementation review: 1 MINOR | data |
| build security 1 | Opus security FAIL, 1 `high`: "Unbounded synchronous scrypt per POST /login: rotating usernames bypasses the only limiter and blocks the event loop (API4 unrestricted resource consumption, plus unlimited password spraying)" at `src/login.js:102-113`, `src/server.js:27-30`, `src/users.js:10-12` | data (a real finding) |
| build fix 1 | fixer returned blocked: the fix needs a global scrypt bound, but NG-003 ("Per-IP or global rate limiting.") and NG-004 ("Changing password hashing or verification in src/users.js.") are active non-goals; it refused unapproved scope expansion and asked the owner to accept RISK-001 or reopen the design | BLOCKED (stage `fix`, round 1) |

The pipeline behaved as designed: a real `high` security finding against active non-goals stopped the build instead
of being fixed out of scope. The design was reopened as E2E-A2.

### 6.2 E2E-A2 design and build (run at 62a0712, superseded)

| Step | Observed | Status |
|---|---|---|
| design | `previous_design` = { `d30704e`, `.pipeline/features/session-login.feature.json` }; start_head `ee05971`; design commit `b533e049860fc9c108d75770cdcd451e7484c1dc`; request `request-A2.txt` sha256 `e700dd61fea11b4b7aed0b14c22b488cda8b82b14308471c0d1afccd9674efd7` | PASS |
| frozen identity | source `c96941b81cc8cfeb48a27b677012a9dedd73689747c1aae0c7b6c90aca461a28`; manifest `2fcf1619a89b6343435b8b4c55cec755e08d29092739c782bdc4c1664f43dbdd`; approvals `9025dd456920872209ad19027736827564c6784a09283155c49f028e152713e6` | data |
| build preflight | `plan_identity` carries the same design_commit, source, manifest and approvals hashes; preflight sha256 `81d7f4c2...a9e96` | PASS |
| base == design_commit | `base_commit` `b533e04` == `design_commit`; `build_mode` `v2` | PASS |
| implement | one commit `c150ac42cd1ae866a7d0f559358aed31108a953f` on `b533e04` (README.md, src/login.js, src/server.js, src/users.js, six new test files) | PASS |
| implementation review 1 | Opus, 0 findings, verdict PASS | PASS |
| security 1 | Opus, verdict PASS, 0 blocking | PASS |
| suite (run-frozen) | `npm test`, `exit_code` 0, `timed_out` false, record sha256 `e9f983310f3caeedd3a9ae59e60ac9f17c2120cb418e862f4efd3ab1c821f706`, log sha256 `6717ee9016f0cc2dd418224023b62f85e0f4bb8c73f8beeab2057eb29b254898`, head before = after = `c150ac4`, status clean | PASS |
| reviewers / cross-family | every step `claude-opus-high (codex unavailable)`, `fallback_used: true` | data (no cross-family review) |
| test-first sub-row | `/srv/gp-v2/state/session-login/build/r2/implement/`: `red.txt` sha256 `c8b2333921669fa53926f2471c75fd2f4969f8e5514b95b7aadeda1cce37cb16` (8 entries, 0 pass, 8 fail; first error `Cannot find module '../src/login.js'`), `green.txt` `cdaa85e1f3e7df37956c518d77f39d2720656d9b40439838c12e55817c9119d7` (27/27), `full-suite.txt` `06992a901b9ed438d314132db7abdbe64ac9a581770777beb6a170a5ed92dba2` (32/32). The red log names no commit, and `b533e04..c150ac4` is a single commit, so no commit before the implementation holds the failing tests. Not yet bundled byte-exact in `tests/v2-evidence/` | FAIL (criterion "failing at a commit before the implementation" not shown) |

### 6.3 E2E-A2 verify attempts r2-r4 (all at `reviewed_sha` `c150ac4`, base `b533e04`)

| Run | Run at | Observed | Status |
|---|---|---|---|
| r2 | 62a0712 | plan preflight PASS (28 runtime acceptances, `proof_timeout_s` 120, 0 checks, 0 live); stage BLOCKED: "acceptance proofs (28 x proof_timeout_s 120, in one block) can take up to 3780 s and cannot finish inside one foreground Bash call (600 s); shorten its frozen limit" | BLOCKED (live bug 2) |
| r3 | 62e2285 | proofs in 7 batches; final review (2 findings: 1 MINOR, 1 NIT) and compliance PASS; 10 negative controls recorded (LOGIN-001-AC1 .. LOGIN-003-AC5); LOGIN-003-AC6 relay stopped: "Step 1 says the UTF-8 bytes of .../execution-plan.json hash to c6e96c6a... Running sha256sum on that file gives 2fcf1619..." | BLOCKED (live bug 3) |
| r4 | 443eba5 | proofs in 7 batches; final review (3 MINOR), compliance PASS; 5 negative controls recorded; LOGIN-003-AC1's relay returned an invented stdout (`observed_exit_code`, `verdict: "PASS"`, `patch_sha256` `2212f7ad...`) instead of run-frozen's record line, while the record on disk holds `baseline_exit_code` 0, `exit_code` 1, `mutation_patch_sha256` `ed8665e0...` (= sha256 of its `mutation.patch`); verify returned INCOMPLETE "negative control LOGIN-003-AC1 did not run (refused patch, or the checkout moved)" | BLOCKED (workflow INCOMPLETE; failed closed; robustness gap 4) |

## E2E-A2 verify/land and E2E-E (pending live run)

<!-- PLACEHOLDER: filled in by the main session after the live run at S (verify r5 onward, land with
     --trunk-ref origin/main up to the PR step, E2E-E drift rows, E2E-F negative-control row, evidence bundle
     and replay.sh output). Nothing below this comment is evidence yet. -->

## 7. Failure-injection transcripts

| Scenario (plan section 4 item 7) | Live | Mocked / deterministic (at `S`) |
|---|---|---|
| semantic contradiction (E2E-C) | PASS, section 7.1 | S15 structural PASS |
| stale hash (E2E-E) | NOT RUN in this draft (pending section) | S17 PASS, L2.4 PASS, L3.12 PASS |
| failed suite (E2E-H) | NOT RUN (time) | L3.7 PASS (run-frozen record with exit 1 -> fix round, never PASS; hand-made `passed: true` -> completion exit 1) |
| missing acceptance proof (E2E-H) | NOT RUN (time) | L3.6 PASS, L3.9 PASS |
| unreviewed commit (E2E-E) | NOT RUN in this draft (pending section) | L3.8 PASS |
| rejected negative-control mutation (E2E-F2) | NOT RUN (time) | L3.13 PASS (mocked, not on live artifacts) |
| invented relay stdout (not planned; observed) | verify r4 failed closed, section 6.3 | fixed in `2623746` with tests `cf78515` |

### 7.1 E2E-C contradiction: PASS (run at 62a0712, superseded)

Seed `/srv/gp-v2/inputs/seed-C.feature.json` (sha256 `385b62c56feeb8cf8014ba96c39228c644b48f9532f9d49d015da082724563ee`)
holds LOCK-001 "An account is locked after 3 failed login attempts." and LOCK-002 "Accounts are never locked after
failed login attempts.", both active. It validated with `--source-request` at 62a0712 (exit 0).

| Criterion | Observed | Status |
|---|---|---|
| a review cites both ids | prd1 (rev-1) finding 1 BLOCKING 0.97 `inconsistent` "LOCK-001 and LOCK-002 directly contradict each other (and LOCK-001 contradicts LOGIN-001/RATE-001)", location "requirements 6 LOCK-001 vs requirements 7 LOCK-002 (also LOGIN-001, RATE-001-AC2)" | PASS |
| no freeze while both active | LOCK-001/LOCK-002 per revision: rev-1 active/active; rev-2 to rev-5 retired/active. The stage never froze: no `frozen/` dir under the run dir, no design commit in `/srv/gp-v2/c` (its only commit is `ee05971`; the feature file is untracked), lock released (`GP_LOCK_RELEASED`) | PASS |
| stage outcome | FAIL at `prd review`, `rounds` prd 4 / spec 0, rev 5; the last PRD review still had 2 MAJOR (timing-based username disclosure vs the security claim; fixed vs sliding window undefined) | data |
| invalid revision never reviewed (live L3.1 corroboration) | rev-2 failed the validator (`E_REASON_MISSING` G17, retired LOCK-001-AC1 without `retired_rationale`); a repair agent fixed it and rev-3 went to review | data |

E2E-C (`feat-2c9e`) reviewer findings, verbatim fields, in review order:

| Review | Severity | Confidence | iso_property | Title |
|---|---|---|---|---|
| prd 1 | BLOCKING | 0.97 | inconsistent | LOCK-001 and LOCK-002 directly contradict each other (and LOCK-001 contradicts LOGIN-001/RATE-001) |
| prd 1 | MAJOR | 0.9 | null | LOCK-001 is a derived requirement with no request item behind it that changes user-visible behavior |
| prd 1 | MAJOR | 0.7 | incomplete | input_validation security statement sets user-visible rejection behavior with no requirement, status code or acceptance |
| prd 1 | MINOR | 0.65 | ambiguous | Rate-limit counting rules are underspecified (unknown usernames, success reset, 429 attempts, 429 body) |
| prd 1 | MINOR | 0.6 | ambiguous | data_exposure claim that usernames are not revealed does not hold for timing; scrypt statement is ambiguous |
| prd 1 | MINOR | 0.6 | incomplete | Acceptance scenarios rely on a "controllable clock" that no requirement or decision defines |
| prd 1 | MINOR | 0.55 | incomplete | In-memory token map grows without bound; not covered by resource_consumption |
| prd 1 | NIT | 0.6 | ambiguous | LOG-001-AC1 references a "logger" the service does not have |
| prd 1 | NIT | 0.5 | null | LOGIN-002 duplicates DEC-001 and LOCK-002 traces to the wrong goal |
| prd 2 | MAJOR | 0.65 | ambiguous | RATE-001 does not say whether unknown-username failures count, so 429 vs 401 can reveal which usernames exist |
| prd 2 | MAJOR | 0.6 | unverifiable | No acceptance scenario pins the 5-failure threshold, so an off-by-one limiter passes |
| prd 2 | MINOR | 0.7 | ambiguous | Window semantics after the limit expires are undefined (fixed vs sliding; do failures during the lock count) |
| prd 2 | MINOR | 0.8 | inconsistent | Security statement claims usernames are not revealed, but unknown-user logins skip scrypt (timing oracle) |
| prd 2 | MINOR | 0.75 | null | LOCK-002 duplicates RATE-001-AC2, and its 'no lock state' clause is unverified |
| prd 2 | MINOR | 0.7 | null | Acceptance scenarios depend on a 'controllable clock' and a 'logger' that neither exist nor are specified |
| prd 2 | MINOR | 0.6 | incomplete | Session token map grows without bound; resource_consumption omits it |
| prd 2 | NIT | 0.6 | unverifiable | LOGIN-002 restates DEC-001's implementation choice as a requirement; 'from crypto.randomBytes' cannot be tested at runtime |
| prd 2 | NIT | 0.5 | null | Actor 'operator' is not used by any requirement; non-POST /login and content-type handling are unspecified |
| prd 3 | MAJOR | 0.75 | unverifiable | LOG-001 acceptance does not check that submitted wrong passwords stay out of logs |
| prd 3 | MINOR | 0.75 | ambiguous | Window semantics (fixed from first failure vs sliding) are ambiguous |
| prd 3 | MINOR | 0.7 | ambiguous | Whether a successful login resets the failure count is unspecified |
| prd 3 | MINOR | 0.8 | ambiguous | 429 response body is undefined |
| prd 3 | MINOR | 0.75 | incomplete | Security claim that usernames are not revealed ignores the timing difference in the existing store |
| prd 3 | MINOR | 0.65 | incomplete | Session token map grows without bound and is missing from resource_consumption |
| prd 3 | MINOR | 0.6 | null | LOCK-002 duplicates RATE-001, and its 'no lock state' clause has no test |
| prd 3 | MINOR | 0.5 | inconsistent | RATE-001 'with any password' conflicts with INPUT-001 for a limited username sending a malformed body |
| prd 3 | MINOR | 0.55 | incomplete | Targeted 60-second lockout of legitimate users is not stated as an accepted risk |
| prd 3 | NIT | 0.6 | null | Acceptance relies on a 'controllable clock' and a 'logger' that the service does not have |
| prd 4 | MAJOR | 0.85 | inconsistent | Security statement claims the 401 answers do not reveal which usernames exist, but the response time does |
| prd 4 | MAJOR | 0.6 | ambiguous | The rate-limit window is not defined as fixed or sliding, and no acceptance scenario tells the two apart |
| prd 4 | MINOR | 0.7 | ambiguous | Whether a successful login resets the failure counter is unspecified |
| prd 4 | MINOR | 0.7 | incomplete | LOG-001's acceptance scenario leaves out the 400 path and refers to a logger the repo does not have |
| prd 4 | MINOR | 0.65 | incomplete | The session map grows without bound and resource_consumption does not mention it |
| prd 4 | MINOR | 0.6 | missing_acceptance_criteria | LOCK-002 largely repeats RATE-001-AC2, and its 'no lock state' clause has no acceptance criterion |
| prd 4 | MINOR | 0.55 | unverifiable | LOGIN-002 makes an implementation detail a requirement, and its scenario cannot check it |
| prd 4 | MINOR | 0.5 | null | The acceptance scenarios need a controllable clock, which no requirement or dependency names |
| prd 4 | NIT | 0.5 | null | The 'operator' actor appears in no goal or requirement |

### 7.2 Findings from the live runs, each fixed test-first

| # | Found in | Problem | Test commit | Fix commit |
|---|---|---|---|---|
| 1 | first attempt (5872536), designs A, B, C | the start block made the fresh `run_dir` with a plain `mkdir` whose parent did not exist; it failed (`mkdir: cannot create directory '/srv/gp-v2/state/<feature>/design/r1': No such file or directory`) and was reported as `GP_RUN_DIR_EXISTS` | `b844c8f` | `62a0712` (parent with `mkdir -p`, run_dir with plain `mkdir`; `GP_RUN_DIR_EXISTS` only for an existing run_dir, `GP_RUN_DIR_PARENT` / `GP_RUN_DIR_CREATE` otherwise) |
| 2 | E2E-A2 verify r2 (62a0712) | all 28 acceptance proofs ran in one block, worst case 3780 s, more than one 600 s foreground call | `40428cf` | `62e2285` (sequential proof batches, each its own agent call and block; new validator rule G40 `E_LIMIT` for a suite or proof that cannot fit one call) |
| 3 | E2E-A2 verify r3 (62e2285) | the negative-control prompt stated the manifest file hash and the mutation-string hash ambiguously; the agent compared the wrong pair and stopped | `a82f94d` | `443eba5` |
| 4 | E2E-A2 verify r4 (443eba5) | a negative-control relay paraphrased (invented) run-frozen's stdout; the workflow failed closed (INCOMPLETE) although a valid record was on disk | `cf78515` | `2623746` (one read-only readback of the record; accepted only if it exists, its hash is printed, it names the target, was made on the clean reviewed commit and, for a negative control, its `mutation_patch_sha256` equals the printed patch hash) |
| - | implementation, before the live runs | an agent's exported `GIT_DIR` made a test's git calls rewrite the repository's `.git/config`; no commit was affected | `66c1009` (git calls in tests strip `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_CONFIG*`; `git-env.test.js` points them at a decoy repo and asserts it stays byte-identical, with a positive control) | same commit |

After each fix Levels 0-3 were rerun; section 2 is the run at `S`. G40 makes the B and C seeds and the B ledger
invalid at `S` (suite `timeout_min` 10); they were valid at their pinned SHA 62a0712.

## 8. Limitations, NOT RUN rows and closure blockers

| Item | Status | Blocker / note |
|---|---|---|
| Level 4b real Codex reviews | NOT RUN | Codex not installed, no OpenAI key; user decision. Every review is the Opus fallback |
| cross-family code review | NOT RUN | only Opus reviewed the change (section 5.2) |
| Level 4c PR/CI on a disposable remote | NOT RUN | session cannot create GitHub repos; toy `origin` is a local bare repo, land stops at the PR step |
| E2E-H, E2E-G (live), E2E-D, E2E-E2, E2E-C2, E2E-F2 | NOT RUN | time (4-CPU host, 2 agents at a time) |
| 5.1 novice agent, 5.2 POSIX path matrix, 5.3 Windows, 5.5 metrics study | NOT RUN | 5.1 not run; 5.2 no dedicated test; 5.3 no Windows host; 5.5 cost (supplementary metrics in 5.4) |
| plan 3.4 differential prompt grep as specified | NOT RUN | a journal-based substitute ran (section 5.3, PASS) |
| agent-call ceilings (2 x mocked count) | NOT RUN | not derived; observed counts and wall times are in 2.3; every run stayed within its fixed minute ceiling |
| evidence bundle (`tests/v2-evidence/index.json`, toy `git bundle`) and `replay.sh` output | NOT RUN in this draft | depends on the E2E-A chain; pending section |
| codex-review fake runner case 4 | FAIL | pre-existing at c186e5f; deterministic (2/2 reruns); not relabelled |
| network access and cost of a live check | not enforced by any script | only measured wall time is (design 10); ceilings are environment-level |
| contract 1 build/verify review relays | attested | unchanged by design |
| failing test ids behind a nonzero suite exit | attested | the exit code is bound to the run-frozen record; the ids are model-parsed from the log (design 10) |
| red/green test-first notes | attested | under contract 2 they certify nothing (`e326213`); section 6.2 sub-row FAIL |

Closure blockers for #54: release rules 1, 2, 3, 4 (section 9). Issue #54 stays open.

## 9. Mapping tables

### Definition of done

| DoD item | Evidence | Status |
|---|---|---|
| One authoritative file | design-v2: Opus and codex happy paths write one canonical file, design commit holds only it | PASS |
| | 5.1 novice agent | NOT RUN |
| | 5.5 metric `authoritative_files` on A r1, A r2, B (supplementary) | PASS |
| Complete deterministic contract | S03-S14, S17-S20, X01-X07 | PASS |
| | L3.1 (plus live corroboration in E2E-C rev-2) | PASS |
| Full traceability | S14; L2.6 | PASS |
| Review completeness | L3.3 (PRD `--against`, spec inputs, approvals binding) | PASS |
| | E2E-B omission (62a0712) | PASS |
| | S15 live = E2E-C (62a0712) | PASS |
| | S16-semantic (E2E-C2) | NOT RUN |
| No patch accumulation | X01, X02 | PASS |
| | E2E-D | NOT RUN |
| Frozen check behavior | S18; L3.6; L3.7 | PASS |
| Safe negative controls | L3.13 | PASS |
| | E2E-F | NOT RUN in this draft (pending section) |
| | E2E-F2 | NOT RUN |
| Identity protection | S17, S19a, S19b | PASS |
| | L2.5 (mocked) | PASS |
| | L2.5 live column (E2E-E2) | NOT RUN |
| | E2E-E | NOT RUN in this draft (pending section) |
| Regression safety | Level 0 gated-pipeline 790/790, section-0 diff limited to the listed hunks | PASS |
| | 1a decision (b): `fallback-parity.test.js` 91/91 | PASS |
| | codex-review fake runner (case 4, pre-existing) | FAIL |
| Backwards compatibility | WP3 differential: `v1 differential: 99 cases give byte-identical stdout ... under c186e5f and now` | PASS |
| | E2E-G | NOT RUN |
| | 5.4 migrate-v1 | PASS |
| Public example safety | redaction scan 1 and 2 (section 10) | PASS |
| | planted-string test `redact-scan.test.js` 5/5 | PASS |
| | scan 3 over the toy repo bundle | NOT RUN (no bundle yet) |

### Invariants

| # | Design section | Enforced / tested by | Status |
|---|---|---|---|
| 1 authoritative state | 1 | design-v2 one-file tests | PASS |
| | | compile banner test: no test of that name found | NOT RUN |
| 2 format | 1, 2 | feature-validate 152/152, schema-lite-conformance 4/4 | PASS |
| 3 stable IDs | 3.6, 6.2, 7 | X01; L3.3; L3.11; design-v2 rev-0 test | PASS |
| | | E2E-B `--previous` held (62a0712) | PASS |
| | | E2E-D | NOT RUN |
| 4 no patch accumulation | 3 (G03, G04), 7 | X02 | PASS |
| | | E2E-D | NOT RUN |
| 5 distinct gates, one artifact | 4, 5 | feature-compile leaf-mutation test; L3.3; `--mode approvals` tests in check-completion-v2 | PASS |
| 6 no self-certifying evidence | 1, 6.5, 9, 10 | L3.1; S18; L3.4; L3.6; L3.7; fallback-parity relay rows | PASS |
| | | live: verify r4 refused an invented relay stdout (failed closed) | PASS |
| | | v1 relays | attested (limitation) |
| 7 snapshot identity | 4, 6.2, 6.5 | L2.1-L2.5; S19a, S19b | PASS |
| 8 safe process execution | 3, 6.4 | L2.7; run-frozen 38/38 (kill at limit, signals, budget, live link); S18 | PASS |
| | | network and cost ceilings | NOT RUN (environment-level, no script enforces them) |
| 9 protected paths | 2, 3 (G33, G34) | S10; X03; L3.8 | PASS |
| 10 backward compatibility | 6.1, 8 | WP3 v1 differential; 5.4 | PASS |
| 11 workflows remain orchestration | 6 | design-v2 51/51, stages-v2 121/121, workflows 39/39 | PASS |
| 12 minimal design output | 4 | L2.4 | PASS |

### Release rule

| Rule | Planned step | Observed | Status |
|---|---|---|---|
| 1 code review confirms architecture and invariants | WP7 step 2 (Opus fallback only) | Opus two-lens review: 11 findings, all fixed (5.2) | PASS (Opus review) |
| | | cross-family review | NOT RUN: rule not met, closure blocker |
| 2 fixture matrix, regression suite, failure injection on a pinned commit | Levels 0-3 on `S` | gated-pipeline 790/790; fixture matrix all PASS | PASS |
| | | codex-review fake runner case 4 (pre-existing, deterministic) | FAIL: rule not met, closure blocker |
| 3 real E2E with no critical scenario NOT RUN | 3.4; 4b, 4c | B, C PASS; A chain incomplete in this draft; 4b, 4c, E2E-H, E2E-G, E2E-D NOT RUN | NOT RUN: rule not met, closure blocker |
| 4 source -> plan -> SHA -> proof -> CI traceable | E2E-A; CI | source, plan and reviewed SHA traceable through A2 build (6.2); proof pending; CI NOT RUN | NOT RUN: rule not met for CI, closure blocker |
| 5 migration/rollback/instructions complete | WP6, `skill-doc.test.js`; 5.1; 5.4 | skill-doc 9/9, 5.4 PASS | PASS |
| | | 5.1 | NOT RUN |
| 6 safeguards unchanged or stronger | 1a decision (b); Level 0 with the section-0 changes | fallback-parity 91/91; section-0 diff as listed | PASS |

## 10. Redaction

`node skills/gated-pipeline/tests/v2-evidence/redact-scan.js` at `S` (default base c186e5f), exit 0:

```
redact-scan 1.0.0
patterns: skills/gated-pipeline/tests/v2-evidence/redact-patterns.json (sha256 e2ae727afe83717236f28fed7ebd125e82a6e6cc84020ba802be59354d44205b)
allowlisted path: skills/gated-pipeline/tests/v2-evidence/redact-patterns.json
scan 1: added lines of git diff -U0 c186e5f..HEAD: 38386 added lines, 0 finding(s)
scan 2: whole files at HEAD touched by git diff c186e5f..HEAD: 372 files, 0 binary skipped, 0 finding(s)
result: CLEAN
```

The scan covers committed changes only. This report, uncommitted when drafted, was checked by committing it in a
throwaway clone at `S` and running the clone's scanner there: scan 1 39179 added lines, 0 findings; scan 2 373 files,
0 findings; CLEAN. Scan 3 (toy repo bundle): NOT RUN, no bundle yet.
