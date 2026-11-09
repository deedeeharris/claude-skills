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
finding as FAIL (build.js:315, verify.js:250) or as a revise round (design.js:167). Probe against the real
`computeVerdict` (scratchpad `parity-probe.js`):

| Findings | codex path today | fallback today |
|---|---|---|
| implementation MAJOR 0.3 | PASS + 1 confirmed -> FAIL, fix round | PASS |
| implementation MAJOR 0.6 | NEEDS_HUMAN + 1 confirmed -> fix round | NEEDS_HUMAN, none confirmed -> BLOCKED |
| prd/spec lone non-ISO MAJOR | PASS + 1 confirmed -> revise | PASS |

Fix (one gate rule, design section 9): codex-review's verdict decides for both reviewers.
- `run-review.js` adds `gate_trigger: true|false` to each finding in `result.json`
  (`computeTriggers(kind, counted)`, additive field).
- The three codex relays use one sentence: "Put findings whose validation.status is
  "confirmed" AND whose gate_trigger is true in confirmed_findings, every other non-refuted
  finding in other_findings, and copy result.json's verdict_reasons verbatim." Verify's final
  review relay uses it too (its schema gains `other_findings`, `verdict_reasons`).
- `parity()` keeps its trigger rule; stage rules stay as they are (NEEDS_HUMAN without
  confirmed findings is BLOCKED unless disagreement-only). Resulting codex-path changes, written
  into SKILL.md and the report: implementation MAJOR < 0.8 is PASS with the finding in
  `other_findings`; a 0.5-0.8 MAJOR is BLOCKED (human), not a fix round; a lone non-ISO
  prd/spec MAJOR passes. The one intended difference: codex's own `model_verdict`
  (`model_rule_disagreement`) has no fallback counterpart.

New `tests/fallback-parity.test.js` (test-first: the diverging rows fail before the fix):
- Table of finding sets (MINOR-only, NIT-only, MAJOR 0.85/0.6/0.3, one/two/three MAJOR with
  and without ISO property, BLOCKING at 0.3, one refuted MAJOR, mixed) x kinds, each row with a
  hand-written expected stage transition: PASS, author/fix with the listed titles, or BLOCKED.
- Codex side: the real `run-review.js` with `fake-codex.js` on PATH and a new `table`
  scenario (findings + model verdict from `FAKE_CODEX_TABLE`; confirms or refutes each
  validated id as the row says; model verdict = the rule-consistent value). The real
  `result.json` is mapped to the relay reply by the bucket sentence above (the test asserts
  the prompts contain that exact sentence), then fed through `run('design'|'build'|'verify')`.
- Fallback side: the same findings as the Opus reply through the same `run()`.
- Assert codex transition == fallback transition == expected, and equal findings handed to the
  author/fixer. Also: the three `parity()` copies are byte-identical, and `parity()`'s verdict
  equals `computeVerdict(kind, findings with codex's validation states, preVerdict)` for every
  row (BLOCKING/MAJOR `confirmed`, MINOR/NIT `not_required`). One extra row with a disagreeing
  model verdict documents the codex-only path.
- Security has no parity row: the critical/high filter is decided by the model on both paths
  (build.js:277/288/293). One prompt-text assertion instead: both security prompts carry the
  same task text and "ONLY the critical/high findings as blocking".
- After WP4 the same table runs against v2 design (`contract: 2`).

### 1b. Executable long-wait relay test
New `tests/relay-wait.test.js`. It does not ask a model anything; it executes the relay
protocol the prompt prescribes. Its header states that it proves the prescribed commands and
loop work, not that a model obeys them or that a turn end kills a background job.

- Parameterized over the five relay prompts (design codex relay, build review, build security,
  verify final review, verify compliance), taken from `run()` with a scripted boundary. Extract
  the runner or `codex exec` command and the poll loop (`for i in $(seq 1 54); do ls <target> ... sleep 10; done`);
  fail if either cannot be found. Shorten only `seq 1 54` -> `seq 1 N` and `sleep 10` -> `sleep 0.2`.
- `fake-codex.js` gains `FAKE_CODEX_DELAY_MS` (default 0, existing scenarios unchanged), writes
  its pid to `FAKE_CODEX_STATE`, and for raw `codex exec` relays writes a minimal valid
  security/compliance JSON after the delay. The runner gets `--timeout-seconds` far above the
  shortened poll budget, so the deadline path is the poll budget, not the runner's timeout.
- `run-review.js`: `result.json` is written atomically (tmp + rename), and a SIGTERM/SIGINT
  handler kills the tracked codex process group and records outcome `interrupted`.
- Happy path: runner started detached in the background; the poll loop runs as separate
  foreground `bash -c` calls; assert >= 2 calls, runner alive before the result exists,
  `result.json` parsed (PASS), runner exits 0; the relay reply built from it goes through
  `run(stage)` -> stage PASS, no fallback agent call.
- Deadline path: delay > poll budget; the harness builds the ERROR reply the prompt prescribes
  (with the run-folder listing) and feeds it through `run(stage)` with `codex_available: true`
  -> BLOCKED, no Opus call. Then kill the runner's process group and assert the runner pid and
  the fake-codex pid are both gone. The fake sleeps in-process (no detached grandchild, unlike
  case 4); the case-4 baseline rerun is reported next to it.
- Deadline premise, measured: a fake `slow-attempts` scenario times out the first review and
  validation attempt and answers the second near 2T. With T = 1 s the runner must exit within
  6T + 3 s, which is the premise of the prompt's `Math.ceil(TIMEOUT_S * 6 / 60) + 5` minutes;
  the formula text is also asserted for the default timeout.

## 2. Issue #54: work packages

Order matters: WP1 is the contract every later package consumes. Every stage keeps its v1
flow; v2 is selected by `contract: 2` (design section 6.1), so all 148 existing tests,
including the 14 `run('design', ...)` calls, run unchanged against v1.

| WP | Content | Files |
|---|---|---|
| #37 | 1a + 1b | `../codex-review/scripts/run-review.js`, `../codex-review/tests/fake-codex.js`, `workflows/{design,build,verify}.js` relay sentence, `tests/{fallback-parity,relay-wait}.test.js` |
| WP1 | Strict JSON parser, schema-lite, graph rules, `validate-feature.js`, `feature.schema.json`, fixtures S01-S16, S20 | `scripts/lib/{strict-json,schema-lite,feature-graph}.js`, `scripts/validate-feature.js`, `schemas/feature.schema.json`, `tests/fixtures/v2/{valid,invalid}/`, `tests/feature-validate.test.js` |
| WP2 | Compiler, projection, escaped views, atomic `--out`, `--check`; manifest v2 schema; Level 2 tests; S17 | `scripts/lib/feature-render.js`, `scripts/compile-feature.js`, `schemas/execution-plan.v2.schema.json`, `tests/feature-compile.test.js` |
| WP3 | Completion v2: `--mode design|approvals`, v2 plan/completion rules, `build_mode` rule, `hash-inputs.js`; v1 differential test; S19 | `scripts/check-completion.js`, `scripts/hash-inputs.js`, `tests/check-completion-v2.test.js` |
| WP4 | design.js `contract: 2` flow (section 5 and 6.2) beside the untouched v1 flow; codex-review `--against` for prd, `inputs` hashes, rubric items | `workflows/design.js`, `../codex-review/scripts/run-review.js`, `../codex-review/rubrics/{prd,spec}.md`, `../codex-review/SKILL.md`, `tests/design-v2.test.js` |
| WP5 | build/verify/land `contract: 2`, build modes, negative-control phase; S18; script-executing stub | `workflows/{build,verify,land}.js`, `tests/stages-v2.test.js`, `tests/helpers/script-stub.js` |
| WP6 | `migrate-v1.js` + fixtures; SKILL.md, template, README, `.gitattributes` note | `scripts/migrate-v1.js`, `tests/migrate-v1.test.js`, `SKILL.md`, `templates/pipeline.yaml` |
| WP7 | Live smoke run (Level 4/5, Opus fallback), sanitized evidence bundle, report | `tests/v2-evidence/`, `tests/v2-verification-report.md` |

### WP1 details
- `strict-json.js`: decodes bytes with `TextDecoder('utf-8', { fatal: true })`, then a
  recursive-descent parser; returns `{ value }` or throws `{ code, path, offset, message }`.
  Rejects invalid UTF-8, a BOM, duplicate keys at any depth, `__proto__`/`constructor`/
  `prototype` keys, trailing commas, comments, NaN/Infinity, lone surrogates in `\u` escapes,
  control characters in strings. Objects are built with `Object.create(null)`.
- `schema-lite.js` supports exactly: `type` (incl. arrays of types), `enum`, `const`,
  `pattern` (anchored, compiled once with the `u` flag), `minLength`, `minItems`, `minimum`,
  `required`, `properties`, `additionalProperties: false`, `items`, `$ref` to `#/$defs/...`,
  `$defs`, `$schema`, `$id`, `title`, `description`. Any other keyword -> setup error (exit 2).
  Conditionals are graph rules, so the subset stays small.
- `feature-graph.js`: every rule in design section 3.4.
- Fixture provenance: each invalid fixture is a minimal text mutation of a valid base (S01, or
  `medium` for graph cases). Its `.expect.json` is
  `{ base, mutation: { find, replace | replace_hex }, exit: 1, codes: [...], paths: [...] }`
  (`replace_hex` for byte-level cases: invalid UTF-8, BOM), codes and paths
  taken from design section 3. The test asserts: base exits 0; base + mutation reproduces the
  fixture bytes; the real CLI (child process, `--repo-path .pipeline/features/<id>.feature.json`)
  gives exactly that exit, those codes and paths. A meta-test asserts every error code in
  design section 3 is expected by at least one fixture. Fixtures and expectations land in a
  test-first commit before the validator code; the report states that order.
- Valid fixtures: S01 minimal, S02 unicode/multiline, S13 not-applicable check, S15/S16
  (semantic cases, exit 0 asserted so nobody can claim schema catches them), plus `medium` and
  `multi-component` for Level 2.

### WP2 details
- Output order: one explicit field list per object in `feature-render.js`.
- Tests (Level 2 rows in section 3.3): determinism on S01/medium/multi-component (two fresh
  dirs, bytes and identity hashes equal); reorder policy (source hash differs, bodies equal);
  S17 (one byte edited in each generated file -> `--check` exit 1 `E_DRIFT` naming it);
  marker command as data never runs (validate and compile); `--out` inside the repo or
  existing -> exit 2; an interrupted compile (test-only env hook `GP_COMPILE_ABORT_AFTER=<n>`,
  documented in the script) leaves no `<out>`; leaf-mutation test (every leaf of the three
  fixtures mutated: each mutation changes >= 1 view, every projection leaf changes
  `prd_projection_sha256`, no spec-only leaf does); escaping (a statement holding
  `\n### AUTH-003` renders no line starting with `#`); bijection (manifest requirement and check
  ids map one-to-one onto active canonical acceptances and checks, no extras or gaps);
  manifests validate against `execution-plan.v2.schema.json` with schema-lite.

### WP3 details
- Dispatch on `manifest.version`; v1 keeps today's code path. The only v1 addition: a build
  result stamped `build_mode: "charge-only"` is rejected (unstamped results unchanged).
- Differential test: run `check-completion.js` from `git show c186e5f:<path>` and the new one
  on every v1 fixture of `check-completion.test.js` plus mutated variants; stdout (minus
  `proof_sha256`), stderr and exit codes must match byte for byte, the proof file minus
  `checked_at` too.
- v2: `--mode approvals` and `--mode design` per design 5 and 6.2; `--spec` admitted inside the
  repo only as `realpath(<repo>/<source.path>)` for a v2 manifest, clean, equal to the blob;
  blobs read with `git cat-file blob` into Buffers (the existing static-evidence `git show`
  helper decodes utf8 and is not reused); the reads/recheck loop covers the canonical file and
  approvals; v2 completion rules per design 6.5. `hash-inputs.js --out|--verify`.
- S19 here: edit, commit, recompile and re-hash the canonical file after freeze ->
  `--mode design` exit 1 (no approval covers the bytes); dirty-only edit -> exit 1 (not clean).
  Also: CRLF checkout and a pre-commit hook that reformats the file -> BLOCKED, not re-hashed.

### WP4 details
- `contract: 2` args per design 6.2. The v1 flow (`task`, `prd.md`, `spec.md`) is left as is.
- Loop: pin source request -> draft (or copy `seed_feature_path`) -> validate (repair up to
  `max_rounds` on deterministic errors) -> snapshot rev-k -> PRD review (chain: validate &&
  compile --check && review) -> revise/rereview -> spec review on the same rev -> any spec-round
  revision that changes `prd_projection_sha256` reruns the PRD review -> `--mode approvals` on
  the final bytes -> commit (`git commit --only`) -> save blob, compile frozen ->
  `--mode design` -> freeze only on exit 0 and when its echoed approval records equal the
  workflow's own ledger.
- Every hash in the result is printed by a script and relayed by a low-effort agent. The
  workflow checks hex shape and equality with the freeze preflight; `--mode design`,
  `--mode plan` and completion re-derive approvals, source, manifest and views from snapshots
  and git, so a relay mistake BLOCKS. A forged review file is not caught (design section 10).
- codex-review: `--against` allowed for `prd`; `inputs` with sha256 in `result.json`, rechecked
  at the end of the run; fake suite cases for both. PRD rubric: "every item of the reference
  request is covered by a requirement or explicitly excluded with a reason". Spec rubric:
  "every negative-control exemption is judged; an unjustified one is a MAJOR with iso_property
  unverifiable".
- Tests (`tests/design-v2.test.js`, mocked, plus the script-executing stub of WP5 for every
  validate/compile/approvals step): the Level 3 design rows of section 3.3.

### WP5 details
- build, verify, land per design 6.3-6.6: three build modes (`v1`, `v2`, `charge-only`),
  `base_commit == design_commit`, verify's frozen checks with stamped records, the
  negative-control phase last, land's `--trunk-ref`.
- `tests/helpers/script-stub.js`: for deterministic steps it extracts the
  `node .../{validate-feature,compile-feature,check-completion,hash-inputs}.js ...` command from
  the prompt (failing if absent), runs it against v2 fixtures in a temp git repo, and replies
  with the script's real output and exit code. Model steps keep scripted replies. All labelled
  mocked.
- S18 here: verify `contract: 2` with a `checks` arg changing command, expected, budget or
  applicability (four cases) -> BLOCKED with zero agent calls; a verify result whose stamped
  check record differs from the manifest -> completion exit 1.

### WP6 details
- migrate-v1: exact acceptance-id/proof mapping, `MIGRATION-TODO` for anything underivable;
  report JSON lists every todo with a reason; validator rejects the token (`E_MIGRATION_TODO`).
- SKILL.md: v2 stage args, `contract`, the canonical-file rule, `.gitattributes -text`, only
  `v2/design-gated` meets #54, the #37 gate rule; v1 compatibility section; rollback
  (`git revert` of the design commit; run dirs are outside the repo); resume (reload the
  frozen identity from design's result; never recompile into the frozen dir); scope change =
  new design on a fresh branch (design 6.7). pipeline.yaml: `design.features_dir`; v2 ignores
  `verify_checks`, `clean_ignore`, `state.paths` (the manifest is their only source).

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
| 4c | Test PR and CI on an authorized disposable remote | NOT RUN: this session cannot create GitHub repositories |
| 5.1 | Novice agent: fresh subagent given only SKILL.md and a raw task on the toy repo, design stage; criteria: finds the config, writes exactly one file under `features_dir`, no `prd.md`/`spec.md`, failures reported intelligibly, no needless confirmation requests; transcript kept | runnable within budget |
| 5.2 | POSIX path matrix: deterministic test with repo, `state_dir` and worktree paths containing spaces and Unicode, an executable proof script; expected: scripts work, workflows accept spaces and BLOCK non-SAFE characters with their reason | runnable |
| 5.3 | Windows paths | NOT RUN: no Windows host |
| 5.4 | v1 import: `migrate-v1` on synthetic v1 fixtures, exact mapping and todo report | runnable |
| 5.5 | Three synthetic requests x 3+ rounds with metrics | NOT RUN: cost; `tests/helpers/v2-metrics.js` computes the metric list (authoritative files = 1, shadow/duplicate requirements, unresolved references, approval-hash consistency, PASS/FAIL/NOT_RUN checks, reviewer rounds) over the live design runs of 3.4, reported as supplementary data |

### 3.2 Fixture matrix (Level 1)
Each variant is its own fixture. "Gate" is what stops it; the report adds the observed exit
code and gate per row.

| Case | Fixtures (variants) | Command / stage | Expected | Gate |
|---|---|---|---|---|
| S01 | valid/S01-minimal | validate, compile | exit 0 | - |
| S02 | valid/S02-unicode-multiline | validate, compile | exit 0; every string appears escaped in a view and re-parses equal | - |
| S03 | dup-key, trailing-comma, invalid-utf8, bom | validate | 1, `E_DUP_KEY` / `E_PARSE` | parse |
| S04 | schema-version, unknown-field, wrong-type | validate | 1, `E_SCHEMA_VERSION` / `E_UNKNOWN_FIELD` / `E_TYPE` | version / schema |
| S05 | dup requirement, goal, acceptance, check id | validate | 1, `E_DUP_ID` | graph |
| S06 | no statement, no `then`, no expected, runtime without command | validate | 1, `E_REQUIRED` / `E_PROOF` | schema / graph |
| S07 | unknown goal, unknown depends_on, unknown component | validate | 1, `E_REF` | graph |
| S08 | cycle, depends_on retired | validate | 1, `E_CYCLE` (path in message) / `E_REF` | graph |
| S09 | overlapping exclusive owners | validate | 1, `E_OWNERSHIP` | graph |
| S10 | allowed inside protected, state path containing `features_dir` | validate | 1, `E_PROTECTED_OVERLAP` | graph |
| S11 | check without reason, exempt without reason | validate | 1, `E_REASON_MISSING` / `E_NEGATIVE_CONTROL` | graph |
| S12 | multi-line command, exit_code 1, static with command | validate | 1, `E_PROOF` / `E_CONST` | schema / graph |
| S13 | valid/S13-not-applicable-check | validate, compile | exit 0; manifest has `applicable: false` + reason | - |
| S14 | goal without requirement, covered SRC without requirement, requirement without acceptance | validate | 1, `E_COVERAGE` | graph |
| S15 | valid/S15-contradiction | validate; live E2E-C | exit 0; semantic part per E2E-C | design review |
| S16 | valid/S16-paraphrase | validate; live E2E-C2 | exit 0; semantic part per E2E-C2 | design review |
| S17 | edited view, edited manifest (WP2) | compile `--check`; build preflight (stub) | 1, `E_DRIFT`; build BLOCKED before implementer | compile integrity / build preflight |
| S18 | checks arg x4 (WP5) | verify `contract: 2` | BLOCKED, 0 agent calls | verify arg check |
| S19 | committed edit, dirty edit (WP3) | `--mode design`; build, verify, land (stub) | exit 1; each stage BLOCKED before its first side effect | build / verify / land preflight |
| S20 | no control description, P0 all-exempt without alternate evidence; valid with alternate evidence | validate | 1, `E_REQUIRED` / `E_NEGATIVE_CONTROL`; valid case exit 0 with the exemption in the manifest | schema / graph |

### 3.3 Level 2 and Level 3 checklist
One row per issue bullet; the report keeps the same ids.

| Id | Issue bullet | Test (file: name) |
|---|---|---|
| L2.1 | byte-identical recompile, 3 specs | feature-compile: determinism |
| L2.2 | reordered mappings, hashing policy | feature-compile: reorder policy |
| L2.3 | identity fields, no self-referential hash | feature-compile: identity fields |
| L2.4 | edited generated file rejected, never authority | feature-compile: S17; check-completion-v2: hand-edited manifest |
| L2.5 | change after approval invalidates; reapproval propagates | stages-v2: freeze rev A, edit a proof command, rev A's approvals/proof rejected by design/plan/completion modes and `--previous-proof`; design again to rev B on a fresh branch (design 6.7); build/verify/land results and proof carry rev B hashes (live once in E2E-E) |
| L2.6 | one canonical owner per id | feature-compile: bijection |
| L2.7 | proof commands never executed | feature-validate + feature-compile: marker |
| L2.8 | unsafe paths, protected conflicts | fixtures S10, `E_UNSAFE_PATH` set |
| L3.1 | invalid spec stops design before review | design-v2: invalid draft, no reviewer call (stub runs the validator) |
| L3.2 | PRD PASS + invalid spec graph cannot freeze | design-v2: spec-round edit breaks the graph |
| L3.3 | omission revised at the same id; stale approval invalid; reviews rerun | design-v2: projection change reruns PRD; wrong or reused relayed `prd_view`/projection hash -> BLOCKED |
| L3.4 | fallback disclosed; cap not hidden | existing v1 tests + design-v2/stages-v2 equivalents |
| L3.5 | build gets the frozen hash; changed hash BLOCKED | stages-v2: manifest hash, base != design_commit, design commit with an extra file, pre-design commit not on trunk |
| L3.6 | verify: altered checks, stale manifest, missing run log, mismatched reviewed SHA | stages-v2: S18, stale manifest, missing ledger file, wrong reviewed_sha |
| L3.7 | suite/security regression; reviewer PASS does not trump a failed proof | stages-v2: v2 build with failing suite, security high; verify with a FAIL acceptance record and clean reviews -> FAIL |
| L3.8 | land refuses unreviewed commit, altered evidence, red/pending CI; never merges | existing land tests + stages-v2 `contract: 2` |
| L3.9 | crash after each gate, resume | stages-v2: after design, build, verify: resume from the persisted result keeps source hash and base, refuses to recompile into the frozen dir, a new verify run dir never reuses a partial ledger |
| L3.10 | concurrent writers, atomic writes | design-v2: branch moved before commit -> CAS BLOCKED; feature-compile: interrupted compile |
| L3.11 | scope expansion -> reapproval | stages-v2: new design on a fresh branch (design 6.7), old proof rejected |
| L3.12 | generated-only change never authoritative | stages-v2: edited view in the frozen dir -> plan/design modes reject |
| L3.13 | negative-control rules | check-completion-v2: env failure (baseline red), null exit, 127, deleting the test file, patch outside owned paths, weak control (mutated exit 0) -> all rejected |
| L3.14 | charge-only cannot certify | check-completion-v2: stamped charge-only rejected under v1 and v2 |

### 3.4 Level 4 plan (real Workflow calls, Opus fallback)
Toy repo: a disposable local synthetic Node HTTP auth service (local fake users, `node --test`
suite, local bare remote as `origin`). Each scenario is a real
`Workflow({ scriptPath: <skill>/workflows/<stage>.js })` call from the main session with
`contract: 2`, unless labelled "deterministic on live artifacts". Hard ceilings: 8 h wall
clock for all of Level 4; per scenario a ceiling on agent calls and minutes, below. A scenario
that hits its ceiling is BLOCKED (budget). Run order (cheapest semantic evidence first):

1. E2E-B omission (design only; <= 25 agent calls, 60 min). Seed: the full request in
   `source_request.text`; coverage and requirements omit invalid login; the seed validates
   (exit 0 with `--source-request`) before the run. PASS = round 1 is non-PASS citing the source
   request, round 1's approval `source_sha256` == sha256(seed), and the frozen file has an
   invalid-login requirement with the original ids kept. Report the finding and the rev diff.
2. E2E-C contradiction (design only; same ceiling). Seed: "lock after 3 failures" and "never
   lock". PASS = no freeze while both are active, and a review cites both ids. FAIL = freeze
   with both active. The actual reviewer output is recorded either way.
3. E2E-C2 paraphrased duplicate (S16; design only; same ceiling). PASS = a review names the
   duplicate and the frozen file keeps one definition.
4. E2E-A happy path (<= 120 calls, 180 min; build `max_fix_rounds` 2): design -> build ->
   verify -> land. Land runs completion revalidation with `--trunk-ref origin/main`, then
   BLOCKED at the PR step (no GitHub repo; Level 4c). All stage results carry the same
   source/manifest/approvals hashes; base_commit == design_commit.
5. E2E-E drift (each a disposable branch of A's repo with the mutation COMMITTED unless noted;
   <= 40 calls, 60 min): canonical file edited -> real build BLOCKED at the design preflight;
   canonical file dirty only -> build BLOCKED (not clean); frozen manifest byte edited (outside
   the repo, no commit) -> build BLOCKED; verify with an altered `checks` arg (no commit) ->
   BLOCKED, 0 agent calls; implementation commit
   after `reviewed_sha` -> verify HEAD_MOVED and real land refuses at completion (the
   "unreviewed commit" transcript). Recovery: a proof command change goes through a new design
   (rev B), then build/verify/land carry rev B and rev A's proof fails `--previous-proof`.
6. E2E-F negative control (from A; <= 30 calls, 45 min): >= 1 `isolated_mutation` record,
   baseline green, mutated red with the failing assertion quoted from its log, work checkout
   pinned and unchanged, exempt count reported.
7. E2E-G resume and migration (<= 30 calls, 45 min): a new Workflow call runs build from A's
   persisted design result only; verify is stopped after its checks phase and rerun in a new
   run dir from the persisted build result; both keep the original `source_sha256` and
   `base_commit`. Verify `contract: 2` with a v1 manifest -> BLOCKED with the migration message;
   migrate-v1 draft fails validation with `E_MIGRATION_TODO` (deterministic).
8. E2E-H failure propagation (<= 60 calls, 90 min): failing suite through a real build (a seeded
   failing test not in `known_failures`) -> fix round or FAIL, no READY; a security high seeded
   as a commit after the design commit (password logged) -> real build security FAIL, then fixed
   or FAIL; a deleted runtime proof log -> real land BLOCKED at completion; red CI NOT RUN
   (no CI host).
9. E2E-D drift stress (<= 60 calls, 90 min; only if budget remains, else NOT RUN): seed with
   all three defects (missing invalid-login, undefined timeout, conflicting retry policy),
   `max_rounds` 5. PASS = at least three feedback rounds before approval, one definition per
   id, no shadow ids, `--check` clean, both final approvals on the final `source_sha256`
   (`same-revision` rule or a recorded projection rule). Per-round findings and rev diffs kept.
   Never reported as covered by B/C.
10. E2E-F2 weak negative control (only if budget remains, else NOT RUN): a design seeded with a
    control whose mutation does not touch the tested behaviour. Either the spec review flags it
    or completion rejects the mutated exit 0; both are recorded. The deterministic version
    (L3.13 on live artifacts) is reported separately and labelled as such.

Issue #54 stays open: its release rule needs real Codex reviews and a real PR/CI (4b, 4c).

## 4. Evidence report (WP7)

`tests/v2-verification-report.md`, one section per issue bullet, each citing its artifact:
1. Commit SHA, Node version, schema/compiler versions, reviewed feature sha256, command list
   (from the report run's own transcript).
2. Level table 3.1 with one status per sub-row, exit codes, artifact paths.
3. Fixture matrix 3.2: expected vs actual exit code and gate (test output).
4. Determinism: manifest and view hashes from two compiles (L2.1 output).
5. Review verdicts: the Opus fallback PRD/spec verdicts and findings, every one labelled
   `claude-opus-high (codex unavailable)`; real Codex verdicts NOT RUN (4b).
6. One complete E2E-A run: request, source digest, reviewed commit, test output hashes,
   completion certificate; PR/CI NOT RUN (4c).
7. Failure-injection transcripts: semantic contradiction (E2E-C), stale hash (E2E-E), failed
   suite (E2E-H), missing acceptance proof (E2E-H), unreviewed commit (E2E-E), rejected
   negative-control mutation (E2E-F2, or L3.13 on live artifacts, labelled).
8. Limitations and every NOT RUN row with its blocker.

Evidence bundle: `tests/v2-evidence/` holds stage result JSONs, review `result.json`/
`inputs.json` files, approvals, proofs and logs trimmed to the asserted lines, with paths
rewritten to `<toy-repo>/` and `<run>/`; `index.json` lists each file's original and bundle
sha256. Redaction before commit: no `/tmp/claude-`, `/root/`, session links, `session_`/`env_`
ids or host names; a grep for those patterns over the report and bundle must return nothing,
and its output is quoted in the report.

## 5. Commits

One commit for #37; for WP1 a test-first commit (fixtures, expectations) then the code commit;
one commit per later WP (tests in the same commit); then the evidence bundle and report.
Explicit pathspecs. Push to `claude/charming-pasteur-ncpes9`. No PR unless the user asks.

## 6. Risks and mitigations

- Workflow scripts cannot read files or hash: every identity is printed by a script, relayed,
  and re-derived by a later script (approvals, design, plan, completion modes), so a relay
  error blocks rather than certifies. Forged files are out of reach (design section 10).
- Live run cost/time: the ceilings and order of 3.4; stop and report rather than loop.
- Breaking existing users: none by default (`contract` absent = 1). Deliberate changes, called
  out in SKILL.md and the report: the #37 codex-path gate change (1a) and the rejection of a
  stamped charge-only build.

## Review log

One line per finding: id: round, lens, severity, decision - what changed or why.

- 37-parity-test-wrong-layer: r1, coverage, BLOCKING, ACCEPTED - 1a rewritten: probe-confirmed divergence, one gate rule via `gate_trigger`, stage-level parity test through `run()`; "already fixed" removed.
- approval-identity-relay-uncertified: r1, coverage, BLOCKING, ACCEPTED - design 5: rev-k snapshots, script-hashed review inputs, approvals ledger, `--mode approvals` before freeze; L3.3 relay-error test.
- existing-design-tests-v1-break: r1, coverage, MAJOR, ACCEPTED - option (a): `contract` arg keeps the v1 design flow, all 14 design tests run unchanged; before/after counts rule in section 0.
- e2e-d-downgraded: r1, coverage, MAJOR, ACCEPTED - E2E-D is a dedicated seeded run with `max_rounds` 5 and pass criteria, else NOT RUN.
- evidence-report-unspecified: r1, coverage, MAJOR, ACCEPTED - section 4 checklist of the 8 issue bullets, four statuses only, 4b/4c NOT RUN rows, unreviewed-commit and weak-control scenarios, redaction grep.
- level3-gaps: r1, coverage, MAJOR, ACCEPTED - checklist 3.3 L3.1-L3.14; atomic compile (design 4) and CAS design commit (design 6.2).
- fixture-matrix-mapping: r1, coverage, MAJOR, ACCEPTED - table 3.2 with one fixture per variant, command, expected and gate; S18 decided by a no-agent arg check; S16 live as E2E-C2.
- level2-reapproval-propagation: r1, coverage, MAJOR, ACCEPTED - L2.5 propagation test (mocked, live in E2E-E) and L2.6 bijection test.
- build-mode-v1-v2-ambiguity: r1, coverage, MAJOR, ACCEPTED - design 6.3: build modes v1/v2/charge-only stamped, v2 requires base == design_commit; manifest v2 schema added (WP2) and checked in completion.
- level5-handwave: r1, coverage, MAJOR, ACCEPTED - Level 5 split into 5.1-5.5 with method and status; Windows and the 3x3 metrics NOT RUN with reasons.
- e2e-scripts-not-stages: r1, coverage, MAJOR, ACCEPTED - E2E-E/G/H use real stage calls on committed mutations; script-only items labelled.
- 37-relay-wait-and-security-row-tautological: r1, coverage, MINOR, ACCEPTED - ERROR reply fed through `run()` (BLOCKED, no Opus); honest test header; process-group kill; security row replaced by a prompt-text assertion.
- approval-identity-relay-only: r1, feasibility, BLOCKING, ACCEPTED - same mechanism as above; `--approvals` required by design/plan/completion v2; fallback hashes disclosed as agent-invoked.
- spec-arg-inside-repo-rejected: r1, feasibility, MAJOR, ACCEPTED - design 6.2: `--spec` admitted in-repo only as the v2 canonical path, clean and equal to the blob; E2E-E commits its mutations and adds a dirty-only case.
- design-v1-tests-break: r1, feasibility, MAJOR, ACCEPTED - v1 design kept behind `contract`; #37 tests run on the unchanged v1 flow and again on v2 after WP4.
- relay-wait-orphan-and-error-claim: r1, feasibility, MAJOR, ACCEPTED - fake pid recorded, SIGTERM handler in run-review.js, atomic result.json, ERROR step labelled and run through the workflow.
- verify-check-record-interface: r1, feasibility, MAJOR, ACCEPTED - design 6.4/6.5: v2 forbids `checks`/`clean_ignore`/`state_paths` args, prompts from frozen checks, stamped records matched by id; `procedure` removed.
- base-commit-design-commit-binding: r1, feasibility, MAJOR, ACCEPTED - base_commit == design_commit enforced in build and completion; preflight at design_commit plus ancestry; L3.5 tests.
- negative-control-any-exit-certifies: r1, feasibility, MAJOR, ACCEPTED - design 6.4/6.5 record with baseline, patch, mutated_paths and exit-code rules.
- source-bytes-identity: r1, feasibility, MAJOR, ACCEPTED - fatal TextDecoder, Buffer blobs via `git cat-file blob`, frozen set compiled from the blob, `.gitattributes -text`, CRLF/hook tests.
- validator-lacks-repo-path: r1, feasibility, MINOR, ACCEPTED - required `--repo-path`; features_dir derived from it and protected as a prefix.
- fixture-wp-ordering: r1, feasibility, MINOR, ACCEPTED - S17 in WP2, S19 in WP3, S18 in WP5; WP1 keeps S01-S16, S20.
- parity-test-modelverdict: r1, feasibility, MINOR, ACCEPTED - model verdict = rule-consistent value, codex validation states, stage-level comparison, security row reworded.
- invalid-file-review-relay: r1, feasibility, MINOR, ACCEPTED - design 5: validate && compile --check && review chain; asserted via the script-executing stub.
- approval-identity-never-checked-downstream: r1, adversary, BLOCKING, ACCEPTED - approvals re-derived in `--mode design`, `--mode plan` and completion v2; S19 committed-edit case BLOCKED (WP3, 3.2).
- design-commit-and-pre-base-commits-escape-review: r1, adversary, BLOCKING, ACCEPTED - design 6.2/6.5: design commit touches only the canonical path, CAS on its parent, base == design_commit, empty `trunk..design_commit^` via land's `--trunk-ref`.
- negative-control-vacuous-pass: r1, adversary, BLOCKING, ACCEPTED - baseline run, saved patch, owned-path and test-path limits, integer exit codes excluding 124/126/127/>=128; L3.13 fixtures.
- charge-only-and-v1-certify-unlabelled: r1, adversary, MAJOR, PARTIAL - build_mode stamp, charge-only rejected in v1 and v2, plan_identity bound to the preflight record, v2 proofs labelled; remains: v1 proofs get no label (absence of `contract` means v1) to keep v1 output byte-identical.
- prd-view-partial-review-unsound: r1, adversary, MAJOR, ACCEPTED - design 4: explicit `prd_projection_sha256` field list (invariants and accepted risks in, negative controls out with reason), escaped views, leaf-mutation test.
- runtime-expected-exit-code-fail-open: r1, adversary, MAJOR, ACCEPTED - `expected.exit_code` const 0 for acceptances and checks; static acceptance must be exempt.
- frozen-checks-partially-enforced: r1, adversary, MAJOR, ACCEPTED - checks args forbidden in v2, stamped records with budget/settings, id-based paths, `minutes_used <= budget_min`, `procedure` removed.
- spec-arg-authority-and-blob-vs-worktree: r1, adversary, MINOR, ACCEPTED - v1 keeps `outside()`; blob is authority; working tree must equal it and be clean (stricter than "never hashed").
- canonical-dir-protection-gaps: r1, adversary, MINOR, ACCEPTED - whole `<features_dir>/` prefix protected and checked before review; features_dir validated, not under `.git/`.
- source-request-not-pinned: r1, adversary, MINOR, ACCEPTED - source request hashed by script at start, `--source-request` on every validate, hash in every approval and in the freeze rule.
- exemptions-unreviewed-and-e2e-f-skippable: r1, adversary, MINOR, ACCEPTED - spec rubric item for exemptions, `alternate_evidence` for all-exempt P0, E2E-F requires >= 1 isolated_mutation record and reports the exempt count.
- negative-phase-ordering-endpoint-check: r1, adversary, MINOR, ACCEPTED - phase runs last, cwd = worktree recorded, pinned check after, commands with the absolute repo path BLOCKED.
- parity-test-compares-verdict-not-gate: r1, rigor, BLOCKING, ACCEPTED - codex side runs the real run-review.js with fake-codex; gate-outcome parity with an independent expected column.
- approval-hashes-relay-trusted: r1, rigor, MAJOR, ACCEPTED - same approvals mechanism; the "cannot certify" claim now names what is and is not caught (design 10).
- v1-design-tests-silently-rewritten: r1, rigor, MAJOR, ACCEPTED - no design test is rewritten (v1 kept); WP3 differential test against `c186e5f`'s check-completion.js.
- e2e-d-impossible-with-max-rounds-3: r1, rigor, MAJOR, ACCEPTED - see e2e-d-downgraded.
- seeded-scenarios-not-bound-or-judged: r1, rigor, MAJOR, ACCEPTED - seeds validated before the run, round-1 hash bound to the seed, PASS/FAIL criteria for B/C/C2.
- e2e-e-mutations-invisible-to-preflight: r1, rigor, MAJOR, ACCEPTED - committed mutations on disposable branches through the owning stage, dirty-only case, labels for completion-only items.
- negative-control-could-pass-on-crash: r1, rigor, MAJOR, PARTIAL - patch saved and hashed, limited to owned non-test paths, baseline green, crash-type exit codes rejected, failing assertion quoted in E2E-F; remains: a mutation that crashes owned code with exit 1 still counts mechanically (stated as attested evidence, design 6.5).
- fixture-expectations-provenance: r1, rigor, MAJOR, ACCEPTED - base + mutation fixtures, base must pass, expectations from design 3 committed test-first, meta-test over all codes.
- level3-mocks-dont-run-scripts: r1, rigor, MAJOR, ACCEPTED - `tests/helpers/script-stub.js` runs the real scripts for deterministic steps.
- level2-3-bullets-omitted: r1, rigor, MAJOR, ACCEPTED - see level3-gaps; every Level 2/3 bullet has a row in 3.3.
- level4-no-budget-ephemeral-evidence: r1, rigor, MAJOR, ACCEPTED - run order with per-scenario and total ceilings, BLOCKED (budget), sanitized committed bundle with an index of hashes.
- relay-wait-test-overclaims: r1, rigor, MINOR, ACCEPTED - five relay prompts, run() feedback, pgid kill and pid check, runner timeout above the budget, measured 6T premise.
