# Plan: issues #37 and #54

Branch: `claude/charming-pasteur-ncpes9`. Contract: `docs/v2-design.md` (normative). This file
says what gets built, in what order, how each piece is proven, and what stays NOT RUN.

## 0. Baseline (done, before any change)

- HEAD `c186e5f66bdcb0ff10d3f7d31cdb23df3a570425`, Node v22.23.4, no lockfile (zero-dependency skills).
- `node --test skills/gated-pipeline/tests/*.test.js` -> 148/148 pass.
- `node skills/codex-review/tests/run-fake-tests.js --work-dir <scratch>` -> 179 passed, 1 failed:
  case 4 "grandchild process no longer alive" (timeout kill of a detached grandchild, which
  leads its own process group). This failure predates the change and is recorded as such. It
  stays visible in the report, with a rerun to tell flaky from deterministic, and is never
  relabelled as a known failure.
- Codex CLI is NOT installed and no OpenAI credential is configured. The user chose "Opus
  fallback only" for the live run. Every real review here is therefore the
  `claude-opus-high (codex unavailable)` fallback, disclosed as such.
- Test-count rule: no existing test is edited or removed. The report shows before/after counts
  per file (gated-pipeline 148 -> 148 + new; fake runner 179/1 -> 179/1 + new). Any existing
  test that must change is listed with its reason and its replacement.

## 1. Issue #37

### 1a. Fallback gate parity: NOT already fixed
PR #41 (`b7766a2`) made the Opus fallback apply codex-review's trigger rule through `parity()`.
The gate result still differs from the codex path, because the codex relay puts EVERY
validated-confirmed BLOCKING/MAJOR into `confirmed_findings` (design.js:149, build.js:258,
verify.js:239 "Return ONLY confirmed findings"), and the workflows treat PASS + any confirmed
finding as FAIL (build.js:315, verify.js:250) or as a revise round (design.js:167), while
`parity()` confirms only triggers. Probe against the real `computeVerdict` (scratchpad
`parity-probe.js`):

| Findings | codex path today | fallback today | both after the fix |
|---|---|---|---|
| implementation MAJOR 0.3 | PASS + 1 confirmed -> FAIL, fix round | PASS | fix round |
| implementation MAJOR 0.6 | NEEDS_HUMAN + 1 confirmed -> fix round | NEEDS_HUMAN, none confirmed -> BLOCKED | fix round |
| prd/spec lone non-ISO MAJOR | PASS + 1 confirmed -> revise | PASS | revise |
| MINOR only | PASS | PASS | PASS |

Decision record. Equal gates can be reached two ways: (a) loosen the codex path to the
runner's bare verdict, or (b) make the fallback reproduce the codex path. Chosen: (b). #37
asks for "the same gate result" and calls the conservative direction right ("never lets a
change through that Codex would block"); #54 requires existing cross-family gates to stay
"unchanged or demonstrably stronger" (release rule 6). (b) changes no codex-path outcome, and
the fallback becomes stricter than today (PR #41 lets a MAJOR < 0.8 through). (a) would need an
explicit user decision and is not taken.

Fix (design section 9):
- The three workflows get byte-identical copies of `computeTriggers`/`computeVerdict` (same
  text as `run-review.js`) and two functions over them. `gateFallback(kind, reply)`: BLOCKING/
  MAJOR findings get validation `confirmed`, MINOR/NIT `not_required`; verdict =
  `computeVerdict(kind, findings, 'PASS')` (the disagreement branch is reachable only when the
  rule says PASS, so the fallback never disagrees with itself); `confirmed_findings` = the
  BLOCKING/MAJOR, `other_findings` = the rest. `gateCodex(kind, reply)`: the relay schema copies
  per finding `id, severity, confidence, iso_property, validation_status, claim, evidence,
  location` plus `verdict, verdict_reasons, model_verdict` with no judgement; the workflow
  recomputes the verdict and BLOCKS on a mismatch (relay inconsistency), then buckets:
  confirmed = `validation_status == "confirmed"`, other = every other non-refuted finding.
  Verify's final-review relay uses the same schema. Stage rules stay as they are.
- `run-review.js` gains no field for #37 (its verdict code is unchanged).
- SKILL.md states the rule and the one difference (design section 9).

New `tests/helpers/run-workflow.js` (workflows.test.js stays untouched): a copy of `run()` whose
replies are values or `(prompt, options, calls) => reply` functions (async allowed). From WP1 on
it also validates every reply against `options.schema` with schema-lite. One test shows it and
the original `run()` give identical calls and results for the v1 design happy path.

New `tests/fallback-parity.test.js` (test-first: the three diverging rows fail before the fix):
- A hand-written table per kind. Columns: findings as reported (severity, confidence,
  iso_property); codex validation state per BLOCKING/MAJOR; `model_verdict` = the
  pre-validation rule over the findings as reported (what a consistent model says); fallback
  input = the reported findings minus those codex refuted (the reviewer is told to drop what
  does not hold); expected codex transition; expected fallback transition. Rows: MINOR-only,
  NIT-only, MAJOR 0.85/0.6/0.3, one/two/three MAJOR with and without ISO property, BLOCKING at
  0.3, mixed, prd three-MAJOR-one-refuted (both sides: revise with the two confirmed MAJORs), and
  per kind a lone refuted trigger with and without an accompanying MINOR. The lone-refuted rows
  are the documented difference: codex NEEDS_HUMAN (`model_rule_disagreement`) -> BLOCKED, or
  with the MINOR a fix/revise round in design/build and BLOCKED in verify; fallback PASS. Every
  other row has equal expected columns. No input is chosen to make rows agree.
- Codex side: the real `run-review.js` with `fake-codex.js` on PATH and a new `table`
  scenario (`FAKE_CODEX_TABLE`: findings, model verdict, CONFIRMED/REFUTED per validated id).
  The relay reply is a pure field projection of the real `result.json` (no bucketing in the
  test), fed through `run-workflow.js` for design, build and verify.
- Fallback side: the fallback input as the Opus reply through the same helper.
- Assert: transitions equal the expected columns; where both sides continue, the author/fixer
  gets the same findings; the four `computeVerdict` copies (three workflows,
  `scripts/lib/gate-rule.js` from WP3) are byte-identical to `run-review.js`'s; an old-style
  relay reply (verdict inconsistent with its findings) -> BLOCKED (relay inconsistency).
- Security has no parity row: the critical/high filter is decided by the model on both paths
  (build.js:277/288/293). One prompt-text assertion instead: both security prompts carry the
  same task text and "ONLY the critical/high findings as blocking".
- After WP4/WP5 the same table runs against v2 design, build and verify (`contract: 2`).

### 1b. Executable long-wait relay test
New `tests/relay-wait.test.js`. It does not ask a model anything; it executes the relay
protocol the prompt prescribes. Its header states that it proves the prescribed commands and
loop work, not that a model obeys them or that a turn end kills a background job.

- Parameterized over the five relay prompts (design codex relay, build review, build security,
  verify final review, verify compliance), taken from `run-workflow.js` with scripted
  boundaries. In a real temp git repo with base and head commits, the harness extracts and
  runs, in prompt order, every numbered setup step (out dir, patch, `worktree add`, `apply
  --index`, `prompt.md` write), the availability probes, the runner or `codex exec` command, the
  poll loop and the cleanup step, with the real `review_runner` and the fake codex on PATH; it
  fails if any step cannot be found. Only `seq 1 54` -> `seq 1 N` and `sleep 10` -> `sleep 0.2`
  are shortened. Worktrees are removed afterwards.
- `fake-codex.js`: `FAKE_CODEX_DELAY_MS` (default 0, existing scenarios unchanged); pid to
  `FAKE_CODEX_STATE`; a `--version` branch that touches no counter; raw security/compliance
  JSON chosen by the `--output-schema` basename, outside the review/validate counters. The
  runner gets `--timeout-seconds` far above the shortened poll budget.
- Fresh result location (prompt change in all five relays): the first setup step creates the
  out dir with `mkdir` (no `-p`) and reports blocked if it exists, so a glob or fixed name can
  only match this run's output. SKILL.md: every stage run uses a fresh `run_dir`, including a
  build rerun after `HEAD_MOVED`.
- `run-review.js`: `result.json` is written atomically (tmp + rename); a SIGTERM/SIGINT handler
  kills the tracked codex process group, records outcome `interrupted` and appends a log line.
- Happy path: runner started detached; the poll loop runs as separate foreground `bash -c`
  calls; assert >= 2 calls, runner alive before the result exists, `result.json` of the new run
  parsed (PASS), runner exits 0; the relay reply goes through `run(stage)` -> stage PASS, no
  fallback agent call.
- Stale cases: an existing out dir holding a PASS `result.json`, and an existing
  `security.json`/`compliance.json` -> the setup step fails, the reply is BLOCKED, no stale PASS
  reaches the stage.
- Deadline path: delay > poll budget; the harness builds the ERROR reply the prompt prescribes
  (with the run-folder listing) and feeds it through `run(stage)` with `codex_available: true`
  -> BLOCKED, no Opus call. Then SIGTERM to the runner pid only: the fake pid is gone within the
  5 s grace, `result.json` parses whole with outcome `interrupted`, and a log line was appended.
  A SIGKILL case is documented as orphaning (the fake survives; the test then kills it and
  records that). The case-4 baseline rerun is reported next to it.
- Deadline premise, measured at the worst case: a fake `slow-attempts` scenario times out both
  attempts of review and validation and ignores SIGTERM. With T = 1 s the runner must exit
  within 6T + 4 x 5 s + the git/catalog allowance; the test asserts that and that this bound
  fits inside `Math.ceil(TIMEOUT_S * 6 / 60) + 5` minutes at the default timeout. For the raw
  `codex exec` relays it asserts from the prompt text that `1800 + 60` s < 32 minutes.
- Rerun against the contract-2 design and verify relays after WP4/WP5.

## 2. Issue #54: work packages

Order matters: WP1 is the contract every later package consumes. Every stage keeps its v1
flow; v2 is selected by `contract: 2` (design section 6.1), so all 148 existing tests,
including the 14 `run('design', ...)` calls, run unchanged against v1.

| WP | Content | Files |
|---|---|---|
| #37 | 1a + 1b | `../codex-review/scripts/run-review.js`, `../codex-review/tests/fake-codex.js`, `workflows/{design,build,verify}.js` (gate functions, relay schema, fresh out dir), `tests/{fallback-parity,relay-wait}.test.js`, `tests/helpers/run-workflow.js` |
| WP1 | Strict JSON parser, schema-lite (2020-12 subset), graph rules incl. `--previous`, `validate-feature.js`, `feature.schema.json`, fixtures, conformance suite | `scripts/lib/{strict-json,schema-lite,feature-graph}.js`, `scripts/validate-feature.js`, `schemas/feature.schema.json`, `tests/fixtures/v2/{valid,invalid,previous}/`, `tests/vendor/json-schema-test-suite/`, `tests/{feature-validate,schema-lite-conformance}.test.js` |
| WP2 | Compiler, projection, escaped views, atomic `--out`, `--check`; manifest v2 schema; Level 2 tests; S17 | `scripts/lib/feature-render.js`, `scripts/compile-feature.js`, `schemas/execution-plan.v2.schema.json`, `tests/feature-compile.test.js` |
| WP3 | Completion v2 and its modes; `hash-inputs.js`, `write-json.js`, `feature-snapshot.js`, `run-frozen.js`, `lib/gate-rule.js`; script-executing stub; v1 differential test; S19a | `scripts/check-completion.js`, `scripts/{hash-inputs,write-json,feature-snapshot,run-frozen}.js`, `scripts/lib/gate-rule.js`, `tests/helpers/{script-stub,v1-completion-cases}.js`, `tests/{check-completion-v2,run-frozen}.test.js` |
| WP4 | design.js `contract: 2` flow (section 5 and 6.2) beside the untouched v1 flow; codex-review `--against` for prd, `inputs` hashes, rubric items | `workflows/design.js`, `../codex-review/scripts/run-review.js`, `../codex-review/rubrics/{prd,spec}.md`, `../codex-review/SKILL.md`, `tests/design-v2.test.js` |
| WP5 | build/verify/land `contract: 2`, build modes, run-frozen execution, negative-control phase; S18; S19b | `workflows/{build,verify,land}.js`, `tests/stages-v2.test.js` |
| WP6 | `migrate-v1.js` + fixtures; SKILL.md, template, README, `.gitattributes` note | `scripts/migrate-v1.js`, `tests/migrate-v1.test.js`, `SKILL.md`, `templates/pipeline.yaml` |
| WP7 | Code review, live smoke run (Level 4/5, Opus fallback), evidence bundle, report | `tests/v2-evidence/`, `tests/v2-verification-report.md` |

### WP1 details
- `strict-json.js`: decodes bytes with `TextDecoder('utf-8', { fatal: true })`, then a
  recursive-descent parser; returns `{ value }` or throws `{ code, path, offset, message }`.
  Rejects invalid UTF-8, a BOM, duplicate keys at any depth, `__proto__`/`constructor`/
  `prototype` keys, trailing commas, comments, NaN/Infinity, lone surrogates in `\u` escapes,
  control characters in strings. Objects are built with `Object.create(null)`.
- `schema-lite.js` supports exactly: `type` (incl. arrays of types), `enum`, `const`,
  `pattern`, `minLength`, `minItems`, `minimum`, `maximum`, `required`, `properties`,
  `additionalProperties: false`, `items`, `$ref` to `#/$defs/...`, `$defs`, `$schema`, `$id`,
  `title`, `description`, each with its 2020-12 meaning (`pattern` unanchored, compiled once
  with the `u` flag; the schema writes `^...$`). Any other keyword -> setup error (exit 2).
  Conditionals are graph rules, so the subset stays small.
- Conformance: the draft2020-12 files `type, enum, const, pattern, minLength, minItems,
  minimum, maximum, required, properties, additionalProperties, items, ref, defs` of the
  official JSON-Schema-Test-Suite, vendored once at a pinned upstream commit with its LICENSE
  and the commit SHA (data, no dependency). Every case whose schema uses only the subset must
  give the suite's `valid`; every case using another keyword must give the setup error; the
  test prints both counts.
- `feature-graph.js`: every rule in design section 3.4 and the `--previous` rules of 3.6.
- Fixture provenance: each invalid fixture is a minimal text mutation of a valid base (S01, or
  `medium` for graph cases). Its `.expect.json` is
  `{ base, mutation: { find, replace | replace_hex }, exit: 1, codes: [...], paths: [...] }`
  (`replace_hex` for byte-level cases: invalid UTF-8, BOM), codes and paths taken from design
  section 3. `--previous` fixtures are pairs (`previous`, mutation of it). The test asserts:
  base exits 0; base + mutation reproduces the fixture bytes; the real CLI (child process,
  `--repo-path .pipeline/features/<id>.feature.json`) gives exactly that exit, those codes and
  paths. A meta-test asserts every error code is expected by at least one fixture; its code
  list is a literal copied from design section 3 (comment names the section), asserted equal to
  the list parsed from `v2-design.md`, never imported from the validator. Fixtures and
  expectations land in a test-first commit before the validator code; the report states that
  order.
- Valid fixtures: S01 minimal, S02 unicode/multiline, S13 not-applicable check, S15/S16
  (semantic cases, exit 0 asserted so nobody can claim schema catches them), plus `medium` and
  `multi-component` for Level 2.
- `run-workflow.js` gains reply validation against `options.schema` (schema-lite).

### WP2 details
- Output order: one explicit field list per object in `feature-render.js`.
- Tests (Level 2 rows in section 3.3): determinism on S01/medium/multi-component, compiled from
  two checkouts at different absolute paths with different cwd, `TZ` and `LC_ALL` (bytes and
  identity hashes equal); reorder policy (source hash differs, bodies equal); S17 (one byte
  edited in each of the four files, plus an extra file -> `--check` exit 1 `E_DRIFT` naming
  it); marker command as data never runs (validate and compile); `--out` inside `--repo` or
  existing -> exit 2; an interrupted compile (test-only env hook `GP_COMPILE_ABORT_AFTER=<n>`,
  documented in the script) leaves no `<out>`; leaf-mutation test (every leaf of the three
  fixtures mutated: each mutation changes >= 1 view; every leaf in the projection list changes
  `prd_projection_sha256`, no other leaf does; the list is a literal copied from design
  section 4 and asserted equal to the list parsed from `v2-design.md`, never feature-render's
  own); escaping (a statement holding `\n### AUTH-003` renders no line starting with `#`;
  `\r`, `\r\n` and U+0085 are `E_CONTROL_CHAR` before any view exists); bijection (manifest
  requirement and check ids map one-to-one onto active canonical acceptances and checks, no
  extras or gaps); manifests validate against `execution-plan.v2.schema.json` with schema-lite.

### WP3 details
- Dispatch on `manifest.version`; v1 keeps today's code path. The only v1 addition: a build
  result stamped `build_mode: "charge-only"` is rejected (unstamped results unchanged).
- Differential test: `tests/helpers/v1-completion-cases.js` holds a stated copy of
  `check-completion.test.js`'s `fixture()` and a named list of case mutations, one per existing
  test that runs the CLI (each mapped to its original test name), plus extra mutated variants.
  The test runs `check-completion.js` from `git show c186e5f:<path>` and the new one on every
  case; stdout (minus `proof_sha256`), stderr and exit codes must match byte for byte, the proof
  file minus `checked_at` too. The report gives the case count and the mapping.
- v2: `--mode approvals`, `--mode design` and the v2 plan/completion rules per design 5, 6.2,
  6.4 and 6.5; `--spec` admitted inside the repo only as `realpath(<repo>/<source.path>)` for a
  v2 manifest, clean, equal to the blob; blobs read with `git cat-file blob` into Buffers (the
  existing static-evidence `git show` helper decodes utf8 and is not reused); the reads/recheck
  loop covers the canonical file, approvals, review files and run-frozen records;
  `certification()` also strips `trunk_qualification`.
- Scripts: `hash-inputs.js --out|--verify`; `write-json.js`; `feature-snapshot.js`;
  `run-frozen.js` (tests: exact manifest command executed and no other, manifest hash mismatch
  -> exit 1, absolute repo path refused, a hanging command is killed with its group at the limit
  and recorded `timed_out`, negative patch derivation rejects rename/delete/mode/binary, a patch
  that does not apply -> exit 1); `scripts/lib/gate-rule.js` (byte-identity test with
  `run-review.js`).
- `tests/helpers/script-stub.js`: finds each prompt's `gp-exec` block (failing if a
  deterministic step has none), runs it with bash in the temp repo (cp, `write-json.js`,
  `git add`/`commit`/`cat-file`, the node scripts), and replies with the real stdout and exit
  code. Model steps keep scripted replies. All labelled mocked. Every v2 workflow test uses it.
- Tests (`tests/check-completion-v2.test.js`): S19a (edit, commit, recompile and re-hash the
  canonical file after freeze -> `--mode design` exit 1; dirty-only edit -> exit 1; CRLF
  checkout and a reformatting pre-commit hook -> exit 1, not re-hashed); a first-time
  (untracked) canonical file plus an unrelated staged file -> the design commit holds only the
  canonical path and the other file stays staged, and `--mode design` passes; an edited frozen
  view -> `--mode design`, `--mode plan` and completion exit 1 `E_DRIFT`; trunk: verify's proof
  then land's revalidation with `--trunk-ref` -> exit 0, trunk moved in between -> exit 0, a
  pre-design commit not on trunk -> exit 1; freeze-rule and approvals rows of L3.3; an edited
  `fallback-review.json` -> `--mode approvals` exit 1; suite identity: stamped suite command
  differs from the manifest -> exit 1, a failure listed only in the build's
  `known_failures_seen` -> exit 1; the L3.13 negative-control rows; a fallback-reviewed build ->
  proof `cross_family: false`.

### WP4 details
- `contract: 2` args per design 6.2. The v1 flow (`task`, `prd.md`, `spec.md`) is left as is.
- Loop: pin source request, `start-head.json`, `rev-0` -> draft (or copy `seed_feature_path`)
  -> `feature-snapshot.js` (validate with `--previous`, repair up to `max_rounds` on
  deterministic errors) -> PRD review (chain: validate && compile --check && review) ->
  revise/rereview -> spec review on the same rev -> rerun the PRD review whenever the current
  projection differs from the latest PRD review's -> `--mode approvals` on the last snapshot +
  `cmp` -> `git add -- <path> && git commit --only` -> save blob, compile frozen ->
  `--mode design` -> freeze only on exit 0 and when its echoed approval records equal the
  workflow's own ledger. Every deterministic step is a `gp-exec` block; every ledger write and
  every fallback reply is written by `write-json.js`. `recover: true` per design 6.2.
- Every hash in the result is printed by a script and relayed by a low-effort agent. The
  workflow checks hex shape and equality with the freeze preflight; `--mode design`,
  `--mode plan` and completion re-derive approvals, verdicts, source, manifest and views from
  snapshots, review files and git, so a relay mistake BLOCKS. A forged review file is not
  caught (design section 10).
- codex-review: `--against` allowed for `prd`; `inputs` with sha256 in `result.json`, rechecked
  at the end of the run; fake suite cases for both. PRD rubric: "every item of the reference
  request is covered by a requirement or explicitly excluded with a reason, and every derived
  requirement's rationale holds". Spec rubric: "every negative-control exemption and every
  known suite failure is judged; an unjustified one is a MAJOR with iso_property
  unverifiable".
- Tests (`tests/design-v2.test.js`, mocked, with `run-workflow.js` and `script-stub.js` for
  every deterministic step): the Level 3 design rows of section 3.3.

### WP5 details
- build, verify, land per design 6.3-6.6: three build modes (`v1`, `v2`, `charge-only`),
  `base_commit == design_commit`, suite/checks/proofs/negative controls through `run-frozen.js`,
  the negative-control phase last, land's `--trunk-ref`.
- S18 here: build and verify `contract: 2` with each forbidden arg of design 6.1 (`checks`
  changing command, expected, budget or applicability; `suite_cmd`, `unit_cmd`,
  `known_failures`, `isolated_setup`, `suite_isolated`, `live_budget_min`, `clean_ignore`,
  `state_paths`) -> BLOCKED with zero agent calls. A plan-preflight relay that returns an
  altered check command -> no check prompt carries a command and the stub shows run-frozen
  executing the manifest's bytes. A verify result whose check record differs from the manifest
  -> completion exit 1.
- S19b here: the S19a committed and dirty edits -> build, verify and land (stub) each BLOCKED
  before their first side effect.

### WP6 details
- migrate-v1 per design 8: exact acceptance-id/proof mapping, `MIGRATION-TODO` for anything
  underivable; the report's `todos`, `conflicts`, `unmapped_tests`, `lost` and
  `provenance_missing`, each with a fixture; validator rejects the token (`E_MIGRATION_TODO`).
  Preservation test: hash the v1 inputs before and after migration (equal), then run the v1
  completion on the original run unchanged (exit 0).
- SKILL.md: v2 stage args, `contract`, the forbidden-arg list, the canonical-file rule,
  `.gitattributes -text`, only `v2/design-gated` meets #54, the #37 gate rule; v1 compatibility
  section; rollback (`git revert` of the design commit; run dirs are outside the repo); resume
  (a new Workflow call with a fresh `run_dir` from the persisted result, never
  `resumeFromRunId` for gated stages, never recompile into the frozen dir, design `recover:
  true`); scope change = new design on a fresh branch (design 6.7). pipeline.yaml:
  `design.features_dir`; under v2 the canonical file replaces `tests:` (suite, unit, known
  failures, setup), `verify_checks`, `clean_ignore` and `state.paths`.

### WP7 details
1. All code committed (SHA `S`); Levels 0-3 run on `S`.
2. Code review of `git diff c186e5f..S` against the single-source architecture and the 12
   invariants by an Opus subagent, labelled `claude-opus-high (codex unavailable)`; findings and
   dispositions go into the report. Release rule 1 asks for a code review "confirming" the
   design; a fallback-only review does not meet it (section 4).
3. Ask the user once whether a disposable GitHub repo can be attached (`add_repo`) for 4c;
   otherwise 4c stays NOT RUN.
4. Level 4/5 per section 3.4; evidence bundle and report per section 4.

## 3. Verification plan (maps to issue #54 levels)

Allowed statuses everywhere: PASS, FAIL, BLOCKED, NOT RUN. A row with parts is split into
sub-rows, each with one status.

### 3.1 Levels
| Level | How | Expected status here |
|---|---|---|
| 0 | Both suites before and after; counts per file; case-4 rerun | runnable |
| 1 | Fixture matrix 3.2 through the real CLIs and stages | runnable |
| 2 | Rows L2.* in 3.3 | runnable |
| 3 | Rows L3.* in 3.3, mocked (scripted model replies + script-executing stub) | runnable |
| 4a | Real Workflow runs, Opus fallback, scenarios 3.4 | runnable within budget |
| 4b | Real Codex PRD/spec/implementation reviews | NOT RUN: Codex not installed, no OpenAI key (user decision) |
| 4c | Test PR and CI on an authorized disposable remote | NOT RUN unless the user attaches a disposable repo when asked (WP7 step 3): this session cannot create GitHub repositories |
| 5.1 | Novice agent: fresh subagent given only SKILL.md and a raw task on the toy repo, design stage. The toy repo's `.claude/pipeline.yaml` is seeded with `design.features_dir: .git/features`, so the first design call BLOCKS (`E_SCOPE`); the main session corrects it after the novice reports. Criteria: finds the config, reports that blocker with its code and the fix, then writes exactly one file under `features_dir`, no `prd.md`/`spec.md`, no needless confirmation requests; transcript kept | runnable within budget |
| 5.2 | POSIX path matrix: deterministic test with repo, `state_dir` and worktree paths containing spaces and Unicode, an executable proof script; expected: scripts work, workflows accept spaces and BLOCK non-SAFE characters with their reason | runnable |
| 5.3 | Windows paths | NOT RUN: no Windows host |
| 5.4 | v1 import: `migrate-v1` on synthetic v1 fixtures: exact mapping, todo, conflict, unmapped-test, lost-detail and provenance reports, inputs byte-unchanged, original v1 run still completes | runnable |
| 5.5 | Three synthetic requests x 3+ rounds with metrics | NOT RUN: cost; `tests/helpers/v2-metrics.js` computes the metric list (authoritative files = 1, shadow/duplicate requirements, unresolved references, approval-hash consistency, PASS/FAIL/NOT_RUN checks, reviewer rounds) over the live design runs of 3.4, reported as supplementary data |

### 3.2 Fixture matrix (Level 1)
Each variant is its own fixture. "Gate" is what stops it; the report adds the observed exit
code and gate per row.

| Case | Fixtures (variants) | Command / stage | Expected | Gate |
|---|---|---|---|---|
| S01 | valid/S01-minimal | validate, compile | exit 0 | - |
| S02 | valid/S02-unicode-multiline | validate, compile | exit 0; every string appears escaped in a view and re-parses equal | - |
| S03 | dup-key, trailing-comma, invalid-utf8, bom, `\r` escape in a string | validate | 1, `E_DUP_KEY` / `E_PARSE` / `E_CONTROL_CHAR` | parse / graph |
| S04 | schema-version, unknown-field, wrong-type | validate | 1, `E_SCHEMA_VERSION` / `E_UNKNOWN_FIELD` / `E_TYPE` | version / schema |
| S05 | dup requirement, goal, acceptance, check id | validate | 1, `E_DUP_ID` | graph |
| S06 | no statement, no `given`, no `when`, no `then`, no expected, runtime without command | validate | 1, `E_REQUIRED` / `E_PROOF` | schema / graph |
| S07 | unknown goal, unknown depends_on, unknown component, unknown source id | validate | 1, `E_REF` | graph |
| S08 | cycle, depends_on retired | validate | 1, `E_CYCLE` (path in message) / `E_REF` | graph |
| S09 | overlapping exclusive owners, test path inside an owned path | validate | 1, `E_OWNERSHIP` | graph |
| S10 | allowed inside protected, owned path inside protected, state path containing `features_dir` | validate | 1, `E_PROTECTED_OVERLAP` | graph |
| S11 | check without reason, exempt without reason, known failure without reason, isolated_mutation on a live-check proof | validate | 1, `E_REASON_MISSING` / `E_NEGATIVE_CONTROL` | graph |
| S12 | multi-line command, multi-line suite command, exit_code 1, static with command, unsupported kind (`manual`), budget above timeout | validate | 1, `E_PROOF` / `E_CONST` / `E_ENUM` / `E_LIMIT` | schema / graph |
| S13 | valid/S13-not-applicable-check | validate, compile | exit 0; manifest has `applicable: false` + reason | - |
| S14 | goal without requirement, goal without source, covered SRC without requirement, requirement without acceptance, requirement listed by no SRC and without `derived_rationale` | validate | 1, `E_COVERAGE` | graph |
| S15 | valid/S15-contradiction | validate; live E2E-C | exit 0; semantic part per E2E-C | design review |
| S16 | valid/S16-paraphrase | validate; live E2E-C2 | exit 0; semantic part per E2E-C2 | design review |
| S17 | each of the four frozen files edited, extra file (WP2) | compile `--check`; `--mode design`; build preflight (stub) | 1, `E_DRIFT`; build BLOCKED before implementer | compile integrity / build preflight |
| S18 | each forbidden arg of design 6.1, `checks` x4 (WP5) | build and verify `contract: 2` | BLOCKED, 0 agent calls | stage arg check |
| S19a | committed edit, dirty edit, CRLF, hook rewrite (WP3) | `--mode design` | exit 1 | design preflight |
| S19b | committed edit, dirty edit (WP5) | build, verify, land (stub) | each stage BLOCKED before its first side effect | build / verify / land preflight |
| S20 | no control description, P0 all-exempt without alternate evidence; valid with alternate evidence | validate | 1, `E_REQUIRED` / `E_NEGATIVE_CONTROL`; valid case exit 0 with the exemption in the manifest | schema / graph |
| X01 | `--previous` pairs: removed requirement, removed goal, removed acceptance, removed check, removed SRC, retired -> active (invariant 3, beyond S01-S20) | validate `--previous` | 1, `E_ID_REMOVED` / `E_ID_REACTIVATED` | graph |

### 3.3 Level 2 and Level 3 checklist
One row per issue bullet; the report keeps the same ids.

| Id | Issue bullet | Test (file: name) |
|---|---|---|
| L2.1 | byte-identical recompile, 3 specs | feature-compile: determinism (two checkouts, cwd, TZ, LC_ALL) |
| L2.2 | reordered mappings, hashing policy | feature-compile: reorder policy |
| L2.3 | identity fields, no self-referential hash | feature-compile: identity fields |
| L2.4 | edited generated file rejected, never authority | feature-compile: S17; check-completion-v2: edited frozen view or manifest -> design/plan/completion `E_DRIFT` |
| L2.5 | change after approval invalidates; reapproval propagates | stages-v2: freeze rev A, edit a proof command, rev A's approvals/proof rejected by design/plan/completion modes and `--previous-proof`; design again to rev B on a fresh branch (design 6.7); build/verify/land results and proof carry rev B hashes (live once in E2E-E) |
| L2.6 | one canonical owner per id | feature-compile: bijection |
| L2.7 | proof commands never executed | feature-validate + feature-compile: marker |
| L2.8 | unsafe paths, protected conflicts | fixtures S10, `E_UNSAFE_PATH` set |
| L3.1 | invalid spec stops design before review | design-v2: invalid draft, no reviewer call (stub runs the validator) |
| L3.2 | PRD PASS + invalid spec graph cannot freeze | design-v2: spec-round edit breaks the graph |
| L3.3 | omission revised at the same id; stale approval invalid; reviews rerun | design-v2: projection change reruns PRD; wrong or reused relayed `prd_view`/projection hash -> BLOCKED; a revision deletes a requirement -> BLOCKED before review (`E_ID_REMOVED`); PRD PASS on P1 -> FAIL on P2 -> back to P1 requires a fresh PRD PASS; PRD FAIL then spec PASS on unchanged bytes -> no freeze; `source_request.text` edited after the PRD PASS -> BLOCKED |
| L3.4 | fallback disclosed; cap not hidden | existing v1 tests + design-v2/stages-v2 equivalents; proof `cross_family: false` |
| L3.5 | build gets the frozen hash; changed hash BLOCKED | stages-v2: manifest hash, base != design_commit, design commit with an extra file, pre-design commit not on trunk |
| L3.6 | verify: altered checks, stale manifest, missing run log, mismatched reviewed SHA | stages-v2: S18, relay-altered check command not executed, stale manifest, missing ledger file, wrong reviewed_sha |
| L3.7 | suite/security regression; reviewer PASS does not trump a failed proof | stages-v2: v2 build with a failing suite -> fix round, then FAIL; a failing test excused only by a `known_failures` arg -> BLOCKED (arg forbidden), and a hand-made build result excusing it -> completion exit 1; security high -> fix round; verify with a FAIL acceptance record and clean reviews -> INCOMPLETE at stage `completion` (real check-completion through the stub), and land then refuses |
| L3.8 | land refuses unreviewed commit, altered evidence, red/pending CI; never merges | existing land tests + stages-v2 `contract: 2` |
| L3.9 | crash after each gate, resume | stages-v2: after design, build, verify: a new call with a fresh run_dir from the persisted result keeps source hash and base, refuses to recompile into the frozen dir, never reuses a partial ledger; a verify replayed from the first run's cached preflight/check replies (the `resumeFromRunId` model) after an evidence log or canonical-file edit -> completion BLOCKED; design-v2: killed after the commit and before freeze -> `recover: true` freezes with the recorded start_head, and a recovery whose HEAD moved -> BLOCKED |
| L3.10 | concurrent writers, atomic writes | design-v2: branch moved before commit -> CAS BLOCKED; feature-compile: interrupted compile; write-json refuses an existing file |
| L3.11 | scope expansion -> reapproval | stages-v2: new design on a fresh branch (design 6.7), `rev-0` = old blob, old proof rejected |
| L3.12 | generated-only change never authoritative | stages-v2: edited view in the frozen dir -> build BLOCKED at preflight, verify plan preflight and completion exit 1 (`E_DRIFT`) |
| L3.13 | negative-control rules | check-completion-v2: env failure (baseline red), null exit, 127, timed-out mutation (a hanging mutation through run-frozen ends within the limit), deleting the test file, co-located test edited (in `tests_added`), reported `mutated_paths` differing from the patch, patch that does not apply, patch outside owned paths, weak control (mutated exit 0) -> all rejected |
| L3.14 | charge-only cannot certify | check-completion-v2: stamped charge-only rejected under v1 and v2 |

### 3.4 Level 4 plan (real Workflow calls, Opus fallback)
Setup:
- Pinning: all code is committed first (SHA `S`, WP7). Every live call runs from a detached
  worktree `git worktree add --detach /srv/gp-v2/skill S` (scriptPath and every script path
  inside it). Before its first Workflow call each scenario records `S`, an empty
  `git status --porcelain` of that worktree and the validator/compiler versions. Any code change
  after a live run means: rerun Levels 0-3 on the new SHA and the affected scenarios, or label
  the row "run at <sha>, superseded".
- Toy repo: a disposable synthetic Node HTTP auth service (local fake users, `node --test`
  suite, local bare remote as `origin`) at `/srv/gp-v2/base`; run dirs and state under
  `/srv/gp-v2/state`. Each scenario is a real
  `Workflow({ scriptPath: /srv/gp-v2/skill/skills/gated-pipeline/workflows/<stage>.js })` call
  with `contract: 2`, unless labelled "deterministic on live artifacts".
- Independence of semantic scenarios (B, C, C2, D, F2): a fresh clone of the base repo with no
  other feature file; a neutral random feature_id, title, branch and run_dir (e.g.
  `feat-7f3a`); seeds kept outside the repo. Before judging, a grep over the reviewer prompts in
  the Workflow journal and every reviewer-visible input file for
  `e2e|omission|contradiction|duplicate|seed|inject|defect|stress|weak` must return nothing;
  the grep and its output are quoted in the report. Reviewer findings are recorded verbatim
  before the main session interprets them.
- Ceilings: per scenario an agent-call ceiling = 2 x the agent-call count of the same path in
  the mocked WP4/WP5 tests (printed next to it) and a minute ceiling; agent calls are the cost
  unit (token usage is reported where the Workflow result shows it, else "not measured"). A
  scenario that hits a ceiling is BLOCKED (budget). Total: 8 h wall clock. The mandatory set
  (B, C, A, E, H, F, G) has ceilings summing to 7 h; D gets the last hour; C2 and F2 run only on
  leftover time, else NOT RUN.
- Dependency: E, F, G and H use A's artifacts. If A does not reach land's PR step with
  completion revalidated, they are BLOCKED (dependency: A), never fed mocked artifacts.

Run order:
1. E2E-B omission (design only; 40 min). Seed: the full request in `source_request.text`;
   coverage and requirements omit invalid login; the seed validates (exit 0 with
   `--source-request`) before the run. PASS = round 1 is non-PASS citing the source request,
   round 1's approval `source_sha256` == sha256(seed), and the frozen file has an invalid-login
   requirement with the original ids kept (`--previous` held). Report the finding and the rev
   diff.
2. E2E-C contradiction (design only; 40 min). Seed: "lock after 3 failures" and "never lock".
   PASS = no freeze while both are active, and a review cites both ids. FAIL = freeze with both
   active. The actual reviewer output is recorded either way.
3. E2E-A happy path (150 min; build `max_fix_rounds` 2): design -> build -> verify -> land.
   Land runs completion revalidation with `--trunk-ref origin/main`, then BLOCKED at the PR step
   (no GitHub repo; Level 4c). All stage results carry the same source/manifest/approvals
   hashes; base_commit == design_commit; the proof says `cross_family: false`.
4. E2E-E drift (each a disposable branch of A's repo with the mutation COMMITTED unless noted;
   45 min): canonical file edited -> real build BLOCKED at the design preflight; canonical file
   dirty only -> build BLOCKED (not clean); frozen manifest byte edited (outside the repo, no
   commit) -> build BLOCKED; verify with an altered `checks` arg (no commit) -> BLOCKED, 0 agent
   calls; implementation commit after `reviewed_sha` -> verify HEAD_MOVED and real land refuses
   at completion (the "unreviewed commit" transcript). Recovery: a proof command change goes
   through a new design (rev B), then build/verify/land carry rev B and rev A's proof fails
   `--previous-proof`.
5. E2E-H failure propagation (75 min), each injection on its own branch of A's repo, with its
   stopping stage asserted:
   - failing suite: a seeded failing test (not a known failure) committed after the design
     commit. Expected: build round-1 suite log shows it, a fix round follows, and the result is
     either PASS with the seeded test file byte-identical in the final reviewed commit
     (`git diff <design_commit>..<reviewed_sha> -- <test>` empty) or FAIL; never READY.
   - security high: a commit after the design commit that logs the password. Expected: the
     round-1 security result quotes that line and FAILs, a fix round removes it, the next
     security pass PASSes; a fix that leaves it -> FAIL.
   - missing runtime proof log: a proof log deleted after verify. Expected: land BLOCKED at
     completion; recovery = verify rerun with a fresh run_dir, then land's completion passes.
   - red CI: NOT RUN (no CI host).
6. E2E-F negative control (from A; 35 min): >= 1 `isolated_mutation` record, baseline green,
   mutated red with the failing assertion quoted from its log, work checkout pinned and
   unchanged, exempt count reported; the frozen `mutation` text is shown next to
   `mutation.patch` with a recorded judgement of whether they match.
7. E2E-G resume and migration (35 min): a new Workflow call runs build from A's persisted design
   result only; a verify run is killed by the main session (stopping the running Workflow) once
   its journal shows the checks phase complete; the partial run dir is shown; verify is rerun as
   a new call with a fresh run_dir from the persisted build result, and its design preflight
   output is byte-identical to the original; both keep `source_sha256` and `base_commit`. Once,
   deliberately, `resumeFromRunId` on a killed verify after an evidence log was edited ->
   completion BLOCKED (the forbidden path, shown to fail closed). Verify `contract: 2` with a v1
   manifest -> BLOCKED with the migration message; migrate-v1 draft fails validation with
   `E_MIGRATION_TODO` (deterministic).
8. E2E-D drift stress (60 min; else NOT RUN): three chained design runs per design 6.7, each on
   a fresh branch: run k is seeded with run k-1's frozen file plus defect k (1: missing
   invalid-login case, 2: undefined timeout, 3: conflicting retry policy). PASS = each defect is
   attributed to a quoted reviewer finding in its own run; one definition per id, no shadow ids,
   `--check` clean, `--previous` held across all revisions and runs; both final approvals on the
   final `source_sha256`; every decision of every revision checked against the final
   requirements by the main session, with each mismatch quoted, and a mismatch the final reviews
   did not flag is FAIL. The observed round counts are reported as data. Never reported as
   covered by B/C.
9. E2E-C2 paraphrased duplicate (S16; design only; leftover time, else NOT RUN). PASS = a review
   names the duplicate and the frozen file keeps one definition.
10. E2E-F2 weak negative control (leftover time, else NOT RUN): a design seeded with a control
    whose mutation does not touch the tested behaviour. The report records which outcome
    happened: the spec review flagged it (PASS), completion rejected the mutated exit 0 (PASS),
    or the patch diverged from the prose and certified (FAIL). The deterministic version (L3.13
    on live artifacts) is reported separately and labelled as such.

Issue #54 stays open: its release rule needs a cross-family code review, real Codex reviews
and a real PR/CI (section 4, release rules 1, 3 and 4).

## 4. Evidence report (WP7)

`tests/v2-verification-report.md`, one section per issue bullet, each citing its artifact:
1. Code SHA `S`, Node version, schema/compiler versions, reviewed feature sha256, command list
   (from the report run's own transcript).
2. Level table 3.1 with one status per sub-row, exit codes, artifact paths and a "skill commit"
   column.
3. Fixture matrix 3.2: expected vs actual exit code and gate.
4. Determinism: manifest and view hashes from two compiles (L2.1 output).
5. Review verdicts: the Opus fallback PRD/spec verdicts and findings, every one labelled
   `claude-opus-high (codex unavailable)`; real Codex verdicts NOT RUN (4b).
6. One complete E2E-A run: request, source digest, reviewed commit, test output hashes,
   completion certificate; PR/CI NOT RUN (4c).
7. Failure-injection transcripts: semantic contradiction (E2E-C), stale hash (E2E-E), failed
   suite (E2E-H), missing acceptance proof (E2E-H), unreviewed commit (E2E-E), rejected
   negative-control mutation (E2E-F2, or L3.13 on live artifacts, labelled).
8. Limitations, every NOT RUN row with its blocker, and the closure blockers.

Tables 2 and 3 are generated by `tests/v2-evidence/make-tables.js` from
`node --test --test-reporter=tap` output, never typed; the command and the output's sha256
stand beside each table. The report also carries three mapping tables, statuses limited to the
four allowed:

Definition of done:
| DoD item | Evidence |
|---|---|
| One authoritative file | design 1; design-v2 (one file written); 5.1; 5.5 metric |
| Complete deterministic contract | S03-S14, S17-S20, X01; L3.1 |
| Full traceability | S14; L2.6 |
| Review completeness | WP4 PRD `--against`, spec inputs; E2E-B; S15/S16 live |
| No patch accumulation | `E_SHADOW_ID`, X01; E2E-D |
| Frozen check behavior | S18; L3.6; L3.7 |
| Safe negative controls | L3.13; E2E-F, E2E-F2 |
| Identity protection | S17, S19a/b; L2.5; E2E-E |
| Regression safety | Level 0; 1a decision (b); no existing test changed |
| Backwards compatibility | WP3 differential; E2E-G; 5.4 |
| Public example safety | redaction grep over the branch diff |

Invariants:
| # | Design section | Enforced / tested by |
|---|---|---|
| 1 authoritative state | 1 | design-v2; compile banner test |
| 2 format | 1, 2 | WP1 parser and conformance tests |
| 3 stable IDs | 3.6, 7 | X01; L3.3; E2E-B/D |
| 4 no patch accumulation | 3 (`E_SHADOW_ID`), 7 | S05; E2E-D |
| 5 distinct gates, one artifact | 5 (freeze rule) | L3.3; `--mode approvals` tests |
| 6 no self-certifying evidence | 1, 9, 10 | L3.1; S18; verdict recomputation tests |
| 7 snapshot identity | 4, 6.2, 6.5 | L2.1-L2.5; S19a/b |
| 8 safe process execution | 3, 6.4 (`run-frozen.js`) | L2.7; run-frozen tests; S18 |
| 9 protected paths | 3 (`E_PROTECTED_OVERLAP`) | S10; L2.8 |
| 10 backward compatibility | 6.1, 8 | WP3 differential; 5.4 |
| 11 workflows remain orchestration | 6 | WP4/WP5 tests on the four workflows |
| 12 minimal design output | 4 | L2.4 |

Release rule:
| Rule | Planned step | Expected |
|---|---|---|
| 1 code review confirms architecture and invariants | WP7 step 2 (Opus fallback only) | not met: no cross-family review; closure blocker |
| 2 fixture matrix, regression suite, failure injection on a pinned commit | Levels 0-3 on `S` | runnable |
| 3 real E2E with no critical scenario NOT RUN | 3.4; 4b, 4c NOT RUN | not met; closure blocker |
| 4 source -> plan -> SHA -> proof -> CI traceable | E2E-A; CI NOT RUN | not met for CI; closure blocker |
| 5 migration/rollback/instructions complete | WP6 | runnable |
| 6 safeguards unchanged or stronger | 1a decision (b); Level 0 | runnable |

Evidence bundle: live runs use the neutral root `/srv/gp-v2/`, so no path is rewritten.
`tests/v2-evidence/` holds byte-exact copies of the E2E-A chain (stage results, approvals,
review `result.json`/`inputs.json`/`fallback-review.json`, run-frozen records and full logs,
proofs) and a `git bundle` of the toy repo; `index.json` lists each file with its sha256.
`tests/v2-evidence/replay.sh` clones the bundle to the same root and reruns `--mode approvals`,
`--mode design` and the completion validation offline (exit 0 expected), then the redaction
grep; its output is quoted in the report. Redaction: no `/tmp/claude-`, `/root/`, `/home/`,
session links, `session_`/`env_` ids or host names, checked by a grep over every file in
`git diff --name-only c186e5f..HEAD`, whose output is quoted in the report. A byte-exact file
that fails the grep is withheld, never edited: `index.json` keeps its sha256 and the reason,
and replay marks it unverifiable.

## 5. Commits

One commit for #37; for WP1 a test-first commit (fixtures, expectations) then the code commit;
one commit per later WP (tests in the same commit). The last code commit is `S`; then one
evidence commit that touches only `tests/v2-evidence/` and `tests/v2-verification-report.md`
(asserted with `git diff --name-only S..HEAD`). Explicit pathspecs. Push to
`claude/charming-pasteur-ncpes9`. No PR unless the user asks.

## 6. Risks and mitigations

- Workflow scripts cannot read files or hash: every identity is printed by a script, relayed,
  and re-derived by a later script (approvals, design, plan, completion modes); every frozen
  command is executed by `run-frozen.js` from the hash-checked manifest; review verdicts are
  recomputed from review files. A relay error blocks rather than certifies. Forged files are out
  of reach (design section 10).
- Live run cost/time: the ceilings, priorities and dependency rule of 3.4; stop and report
  rather than loop.
- Breaking existing users: none by default (`contract` absent = 1). Deliberate changes, called
  out in SKILL.md and the report: the fallback gate becomes as strict as the codex path (1a; no
  codex-path outcome changes), relays refuse an existing out dir (1b), and a stamped charge-only
  build is rejected.

## Review log

One line per finding: id: round, lens, severity, decision - what changed or why.

- 37-parity-test-wrong-layer: r1, coverage, BLOCKING, ACCEPTED - 1a rewritten: probe-confirmed divergence, stage-level parity test through `run()`; "already fixed" removed (gate rule itself revised in r2).
- approval-identity-relay-uncertified: r1, coverage, BLOCKING, ACCEPTED - design 5: rev-k snapshots, script-hashed review inputs, approvals ledger, `--mode approvals` before freeze; L3.3 relay-error test.
- existing-design-tests-v1-break: r1, coverage, MAJOR, ACCEPTED - option (a): `contract` arg keeps the v1 design flow, all 14 design tests run unchanged; before/after counts rule in section 0.
- e2e-d-downgraded: r1, coverage, MAJOR, ACCEPTED - E2E-D is a dedicated seeded scenario with pass criteria, else NOT RUN (structure revised in r2).
- evidence-report-unspecified: r1, coverage, MAJOR, ACCEPTED - section 4 checklist of the 8 issue bullets, four statuses only, 4b/4c NOT RUN rows, unreviewed-commit and weak-control scenarios, redaction grep.
- level3-gaps: r1, coverage, MAJOR, ACCEPTED - checklist 3.3 L3.1-L3.14; atomic compile (design 4) and CAS design commit (design 6.2).
- fixture-matrix-mapping: r1, coverage, MAJOR, ACCEPTED - table 3.2 with one fixture per variant, command, expected and gate; S18 decided by a no-agent arg check; S16 live as E2E-C2.
- level2-reapproval-propagation: r1, coverage, MAJOR, ACCEPTED - L2.5 propagation test (mocked, live in E2E-E) and L2.6 bijection test.
- build-mode-v1-v2-ambiguity: r1, coverage, MAJOR, ACCEPTED - design 6.3: build modes v1/v2/charge-only stamped, v2 requires base == design_commit; manifest v2 schema added (WP2) and checked in completion.
- level5-handwave: r1, coverage, MAJOR, ACCEPTED - Level 5 split into 5.1-5.5 with method and status; Windows and the 3x3 metrics NOT RUN with reasons.
- e2e-scripts-not-stages: r1, coverage, MAJOR, ACCEPTED - E2E-E/G/H use real stage calls on committed mutations; script-only items labelled.
- 37-relay-wait-and-security-row-tautological: r1, coverage, MINOR, ACCEPTED - ERROR reply fed through `run()` (BLOCKED, no Opus); honest test header; security row replaced by a prompt-text assertion.
- approval-identity-relay-only: r1, feasibility, BLOCKING, ACCEPTED - same mechanism as above; `--approvals` required by design/plan/completion v2; fallback hashes disclosed as agent-invoked.
- spec-arg-inside-repo-rejected: r1, feasibility, MAJOR, ACCEPTED - design 6.2: `--spec` admitted in-repo only as the v2 canonical path, clean and equal to the blob; E2E-E commits its mutations and adds a dirty-only case.
- design-v1-tests-break: r1, feasibility, MAJOR, ACCEPTED - v1 design kept behind `contract`; #37 tests run on the unchanged v1 flow and again on v2 after WP4/WP5.
- relay-wait-orphan-and-error-claim: r1, feasibility, MAJOR, ACCEPTED - fake pid recorded, SIGTERM handler in run-review.js, atomic result.json, ERROR step labelled and run through the workflow.
- base-commit-design-commit-binding: r1, feasibility, MAJOR, ACCEPTED - base_commit == design_commit enforced in build and completion; preflight at design_commit plus ancestry; L3.5 tests.
- negative-control-any-exit-certifies: r1, feasibility, MAJOR, ACCEPTED - design 6.4/6.5 record with baseline, patch, mutated_paths and exit-code rules.
- source-bytes-identity: r1, feasibility, MAJOR, ACCEPTED - fatal TextDecoder, Buffer blobs via `git cat-file blob`, frozen set compiled from the blob, `.gitattributes -text`, CRLF/hook tests.
- validator-lacks-repo-path: r1, feasibility, MINOR, ACCEPTED - required `--repo-path`; features_dir derived from it and protected as a prefix.
- fixture-wp-ordering: r1, feasibility, MINOR, ACCEPTED - S17 in WP2, S19 in WP3/WP5, S18 in WP5; WP1 keeps S01-S16, S20.
- invalid-file-review-relay: r1, feasibility, MINOR, ACCEPTED - design 5: validate && compile --check && review chain; asserted via the script-executing stub.
- approval-identity-never-checked-downstream: r1, adversary, BLOCKING, ACCEPTED - approvals re-derived in `--mode design`, `--mode plan` and completion v2; S19 committed-edit case BLOCKED.
- design-commit-and-pre-base-commits-escape-review: r1, adversary, BLOCKING, ACCEPTED - design 6.2/6.5: design commit touches only the canonical path, CAS on its parent, base == design_commit, empty `trunk..design_commit^` via land's `--trunk-ref`.
- negative-control-vacuous-pass: r1, adversary, BLOCKING, ACCEPTED - baseline run, saved patch, owned-path and test-path limits, integer exit codes excluding 124/126/127/>=128; L3.13 fixtures.
- charge-only-and-v1-certify-unlabelled: r1, adversary, MAJOR, PARTIAL - build_mode stamp, charge-only rejected in v1 and v2, plan_identity bound to the preflight record, v2 proofs labelled; remains: v1 proofs get no label (absence of `contract` means v1) to keep v1 output byte-identical.
- prd-view-partial-review-unsound: r1, adversary, MAJOR, ACCEPTED - design 4: explicit `prd_projection_sha256` field list (invariants and accepted risks in, negative controls out with reason), escaped views, leaf-mutation test.
- runtime-expected-exit-code-fail-open: r1, adversary, MAJOR, ACCEPTED - `expected.exit_code` const 0 for acceptances and checks; static acceptance must be exempt.
- frozen-checks-partially-enforced: r1, adversary, MAJOR, ACCEPTED - checks args forbidden in v2, stamped records with budget/settings, id-based paths, `minutes_used <= budget_min`, `procedure` removed.
- spec-arg-authority-and-blob-vs-worktree: r1, adversary, MINOR, ACCEPTED - v1 keeps `outside()`; blob is authority; working tree must equal it and be clean (stricter than "never hashed").
- canonical-dir-protection-gaps: r1, adversary, MINOR, ACCEPTED - whole `<features_dir>/` prefix protected and checked before review; features_dir validated, not under `.git/`.
- exemptions-unreviewed-and-e2e-f-skippable: r1, adversary, MINOR, ACCEPTED - spec rubric item for exemptions, `alternate_evidence` for all-exempt P0, E2E-F requires >= 1 isolated_mutation record and reports the exempt count.
- parity-test-compares-verdict-not-gate: r1, rigor, BLOCKING, ACCEPTED - codex side runs the real run-review.js with fake-codex; gate-outcome parity with an independent expected column.
- approval-hashes-relay-trusted: r1, rigor, MAJOR, ACCEPTED - same approvals mechanism; the "cannot certify" claim now names what is and is not caught (design 10).
- v1-design-tests-silently-rewritten: r1, rigor, MAJOR, ACCEPTED - no design test is rewritten (v1 kept); WP3 differential test against `c186e5f`'s check-completion.js.
- e2e-d-impossible-with-max-rounds-3: r1, rigor, MAJOR, ACCEPTED - see e2e-d-downgraded and e2e-d-rewards-missed-defects.
- seeded-scenarios-not-bound-or-judged: r1, rigor, MAJOR, ACCEPTED - seeds validated before the run, round-1 hash bound to the seed, PASS/FAIL criteria for B/C/C2.
- e2e-e-mutations-invisible-to-preflight: r1, rigor, MAJOR, ACCEPTED - committed mutations on disposable branches through the owning stage, dirty-only case, labels for completion-only items.
- negative-control-could-pass-on-crash: r1, rigor, MAJOR, PARTIAL - patch saved and hashed, limited to owned non-test paths, baseline green, crash-type exit codes rejected, failing assertion quoted in E2E-F; remains: a mutation that crashes owned code with exit 1 still counts mechanically (stated as attested evidence, design 6.5).
- fixture-expectations-provenance: r1, rigor, MAJOR, ACCEPTED - base + mutation fixtures, base must pass, expectations from design 3 committed test-first, meta-test over all codes.
- level2-3-bullets-omitted: r1, rigor, MAJOR, ACCEPTED - see level3-gaps; every Level 2/3 bullet has a row in 3.3.
- level4-no-budget-ephemeral-evidence: r1, rigor, MAJOR, ACCEPTED - per-scenario and total ceilings, BLOCKED (budget), committed bundle with an index of hashes (made byte-exact in r2).
- relay-wait-test-overclaims: r1, rigor, MINOR, ACCEPTED - five relay prompts, run() feedback, process kill and pid check, runner timeout above the budget, measured premise (worst case in r2).
- v2-unfrozen-build-args-certify: r2, coverage, BLOCKING, ACCEPTED - design 2 `suite` + `limits` + check `timeout_min`; 6.1 forbids suite_cmd/unit_cmd/known_failures/isolated_setup/suite_isolated/live_budget_min; build stamps `suite_identity`; completion requires suite failures to be a subset of the manifest's known-failure ids; S18 and L3.7 extended.
- 37-gate-change-weakens-codex-path-vs-54: r2, coverage, MAJOR, ACCEPTED - 1a decision record: option (b), the fallback reproduces the codex path, so no codex outcome weakens; no user choice needed since (b) satisfies both issues; (a) would need one.
- id-continuity-across-revisions-unenforced: r2, coverage, MAJOR, ACCEPTED - design 3.6 `--previous` with `E_ID_REMOVED`/`E_ID_REACTIVATED` on every revision, `rev-0` = start_head blob, rechecked in `--mode approvals`; status on goals and acceptances; X01 fixtures, L3.3 row. `E_ID_REPURPOSED` (marked optional) not added.
- frozen-view-drift-not-checked: r2, coverage, MAJOR, ACCEPTED - `--frozen-dir` on `--mode design`/`plan`/completion runs the `compile --check` comparison over all four files; S17, L2.4, L3.12 aligned.
- workflow-native-resume-untested: r2, coverage, MAJOR, ACCEPTED - design 6.1 forbids `resumeFromRunId` for gated stages (SKILL.md) and requires fresh run dirs; design 6.2 `recover: true`; L3.9 replay and recovery rows; E2E-G kill mechanism and one deliberate resume.
- traceability-source-goal-edge-missing: r2, coverage, MAJOR, ACCEPTED - `goals[].source_ids`, `derived_rationale`, new `E_COVERAGE` cases, projection includes both; S14 variants; PRD rubric item.
- schema-lite-not-2020-12-conformant: r2, coverage, MAJOR, ACCEPTED - standard semantics (unanchored `pattern`, `^...$` in the schema), vendored JSON-Schema-Test-Suite conformance test (WP1), deviation rule in design 2.
- dod-invariants-release-rule-unmapped: r2, coverage, MAJOR, ACCEPTED - section 4 DoD (11), invariant (12) and release-rule (6) tables; WP7 step 2 code review (Opus fallback, labelled); rule 1 named as a closure blocker.
- live-evidence-not-pinned-to-skill-commit: r2, coverage, MAJOR, ACCEPTED - 3.4 pinning: code SHA `S`, detached skill worktree, per-scenario SHA and clean status, rerun-or-superseded rule; report "skill commit" column; section 5 evidence-only commit.
- migration-conflict-and-preservation-unplanned: r2, coverage, MAJOR, ACCEPTED - design 8 report `conflicts`/`unmapped_tests`/`lost`/`provenance_missing`; WP6 fixtures and preservation test; 5.4 criteria.
- evidence-bundle-trims-exact-output: r2, coverage, MINOR, ACCEPTED - byte-exact files under a neutral root, no trimming or rewriting; redaction grep over the whole branch diff; failing files withheld with their hash.
- small-coverage-gaps: r2, coverage, MINOR, ACCEPTED - S06/S10/S12 variants; 5.1 seeded `E_SCOPE` failure; E2E-D decisions-vs-final check; E2E-H stopping stages and recovery; WP7 asks the user once about a repo for 4c; run-workflow.js validates replies against `options.schema`.
- v2-land-previous-proof-mismatch: r2, feasibility, MAJOR, ACCEPTED - design 6.5: `design_commit`/`design_paths` in every v2 proof, `trunk_qualification` stripped by `certification()`, land requires it non-null; WP3 trunk tests.
- relay-wait-harness-setup-steps: r2, feasibility, MAJOR, ACCEPTED - 1b runs every numbered setup step in a real temp repo with the real runner; fake-codex `--version` branch and schema-basename selection outside the counters.
- level3-mocks-dont-run-scripts: r1, rigor, MAJOR, ACCEPTED; r2, feasibility, MAJOR, ACCEPTED - deterministic steps are `gp-exec` blocks (cp, write-json, git, node scripts) the stub executes whole; script-stub.js moved to WP3; S19 split into S19a (WP3) and S19b (WP5).
- contract-git-commands-wrong: r2, feasibility, MAJOR, ACCEPTED - design 6.2: `git add -- <path> && git commit --only`, `git diff-tree --root --no-commit-id --no-renames --name-only -r -z` plus `rev-list --parents`; WP3 first-time file test (both failures reproduced in a scratch repo).
- compile-approvals-missing-repo-and-source-args: r2, feasibility, MAJOR, ACCEPTED - `--repo` on compile-feature and `--mode approvals`; `--source` is the last rev snapshot, `cmp` with the working file before commit; committed bytes bound by `--mode design`.
- source-request-not-pinned: r1, adversary, MINOR, ACCEPTED; r2, feasibility, MINOR, ACCEPTED - `--mode approvals` re-hashes the PRD review's recorded `against` file against the ledger and `source-request.inputs.json` and runs the `--source-request` rule on F; L3.3 edited-text case.
- differential-test-fixture-source: r2, feasibility, MINOR, ACCEPTED - `tests/helpers/v1-completion-cases.js` with a stated copy of `fixture()` and a named case list mapped to original test names.
- run-harness-static-replies: r2, feasibility, MINOR, ACCEPTED - `tests/helpers/run-workflow.js` in the #37 package, workflows.test.js untouched, identity test against the original `run()`.
- negative-phase-ordering-endpoint-check: r1, adversary, MINOR, ACCEPTED; r2, feasibility, MINOR, ACCEPTED - the absolute-repo-path rule moves to `--mode plan` v2 over every frozen command, rechecked by completion and refused by run-frozen.js.
- verify-check-record-interface: r1, feasibility, MAJOR, ACCEPTED; r2, feasibility, MINOR, ACCEPTED - checks, proofs, suite and negative controls run through `run-frozen.js` from the hash-checked manifest; the relayed list carries ids and labels only.
- parity-table-refuted-row-fallback-input: r2, feasibility, MINOR, ACCEPTED - fallback input = codex findings minus refuted ones; prd three-MAJOR-one-refuted row added (revise on both sides under rule (b)). Correction: the existing fake scenario gives NEEDS_HUMAN, not PASS (run-fake-tests.js:465).
- v2-unfrozen-suite-and-setup-args: r2, adversary, BLOCKING, ACCEPTED - same change as v2-unfrozen-build-args-certify; `lock_note`, `scan_log`/`require_scan_row` and `allow_no_ci` declared repo-level non-certifying config and recorded in the proof/land result (design 2).
- frozen-checks-relay-executes-before-catch: r2, adversary, MAJOR, ACCEPTED - `run-frozen.js` executes only manifest bytes; WP5 test with a relay-altered command.
- 37-fix-weakens-codex-gate: r2, adversary, MAJOR, ACCEPTED - same decision as 37-gate-change-weakens-codex-path-vs-54; codex buckets and PASS+confirmed->FAIL kept; "deliberate codex-path change" removed from section 6.
- fallback-verdicts-not-rederivable: r2, adversary, MAJOR, ACCEPTED - `fallback-review.json` written by write-json with its hash in the record; `--mode approvals` recomputes fallback and codex verdicts with `lib/gate-rule.js`; design 10 says what stays attested.
- prd-approval-shopping: r2, adversary, MAJOR, ACCEPTED - freeze rule uses the LATEST PRD review overall; rerun trigger defined against it; L3.3 revert and FAIL-then-spec-PASS rows.
- mutated-paths-self-reported: r2, adversary, MAJOR, PARTIAL - paths re-derived from patch bytes, apply check on reviewed_sha via a temp index, `tests_added` excluded, test/owned overlap is `E_OWNERSHIP`; L3.13 rows. Remains: an undeclared, untouched test file inside owned code is not caught (stated in design 6.5).
- negative-control-unbounded: r2, adversary, MAJOR, ACCEPTED - `limits.proof_timeout_s` and `negative_controls_total_min`, run-frozen kills the group, live-check proofs must be exempt (`E_NEGATIVE_CONTROL`); hanging-mutation row in L3.13.
- design-commit-only-fails-new-file: r2, adversary, MAJOR, ACCEPTED - see contract-git-commands-wrong; failure after the commit handled by `recover: true`, never reset or stacked (design 6.2).
- trunk-ref-breaks-previous-proof: r2, adversary, MAJOR, ACCEPTED - same change as v2-land-previous-proof-mismatch.
- frozen-views-not-checked: r2, adversary, MINOR, ACCEPTED - same change as frozen-view-drift-not-checked.
- view-escaping-bare-cr: r2, adversary, MINOR, ACCEPTED - `E_CONTROL_CHAR` (C0 except TAB/LF, C1, U+2028/2029); S03 variant; escaping test covers `\r`, `\r\n`, U+0085.
- v2-proof-hides-fallback: r2, adversary, MINOR, ACCEPTED - proof records `reviewers`, `fallback_used`, `cross_family`; land echoes them; L3.4 and WP3 test.
- parity-test-modelverdict: r1, feasibility, MINOR, ACCEPTED; r2, rigor, MAJOR, ACCEPTED - hand-written `model_verdict` column = pre-validation rule; refuted-trigger rows per kind; lone-refuted divergence listed as the documented `model_rule_disagreement` difference; computeVerdict unchanged.
- parity-codex-side-bucket-is-test-code: r2, rigor, MAJOR, ACCEPTED - bucketing moved into the workflow (`gateCodex`), relay is a field copy, verdict recomputed and inconsistent replies BLOCKED; old-style relay row.
- relay-wait-stale-result: r2, rigor, MAJOR, ACCEPTED - relays create the out dir with plain `mkdir` and block if it exists; fresh run_dir per stage run (SKILL.md); stale-folder and stale-file cases.
- e2e-d-rewards-missed-defects: r2, rigor, MAJOR, ACCEPTED - option A: three chained design runs, one defect each; PASS = attributed findings; round counts reported as data.
- semantic-scenarios-primed-or-contaminated: r2, rigor, MAJOR, ACCEPTED - fresh clone per scenario, neutral names, seeds outside the repo, zero-hit grep quoted, verbatim findings first.
- live-runs-not-pinned-to-a-commit: r2, rigor, MAJOR, ACCEPTED - same change as live-evidence-not-pinned-to-skill-commit.
- evidence-bundle-not-reverifiable: r2, rigor, MAJOR, ACCEPTED - neutral root, byte-exact chain, `git bundle`, `replay.sh` offline revalidation, tables generated from TAP output with hashes.
- level4-budget-arithmetic: r2, rigor, MAJOR, PARTIAL - mandatory set fits 7 h, D the last hour, C2/F2 leftover only; call ceilings 2x the mocked call count; dependency rule on A; E2E-G kill mechanism named. Remains: no token-denominated ceiling (stage scripts cannot read usage); agent calls are the cost unit and tokens are reported only where shown.
- live-failure-scenarios-pass-criteria-gaps: r2, rigor, MINOR, ACCEPTED - E2E-H seeded test byte-identical, quoted security line; E2E-F/F2 mutation text beside the patch with a judgement; F2 outcome recorded, divergence = FAIL.
- relay-wait-signal-and-premise: r2, rigor, MINOR, ACCEPTED - SIGTERM to the runner pid only with `interrupted` outcome and log line; SIGKILL documented; worst-case premise; 1800+60 s check; rerun on v2 relays.
- l3-7-expected-status-wrong: r2, rigor, MINOR, ACCEPTED - expectation is INCOMPLETE at `completion` via the real check-completion through the stub (verify.js:288-289, 315), then land refuses.
- oracle-lists-must-be-independent: r2, rigor, MINOR, ACCEPTED - error-code and projection lists are literals from design 3/4, asserted equal to lists parsed from v2-design.md; determinism across checkouts, cwd, TZ, LC_ALL.
