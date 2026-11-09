# Plan: issues #37 and #54

Branch: `claude/charming-pasteur-ncpes9`. Contract: `docs/v2-design.md` (normative). This file
says what gets built, in what order, how each piece is proven, and what stays NOT RUN.

## 0. Baseline (done, before any change)

- HEAD `c186e5f66bdcb0ff10d3f7d31cdb23df3a570425`, Node v22.23.4, no lockfile (zero-dependency skills).
- `node --test skills/gated-pipeline/tests/*.test.js` -> 148/148 pass.
- `node skills/codex-review/tests/run-fake-tests.js --work-dir <scratch>` -> 179 passed, 1 failed:
  case 4 "grandchild process no longer alive" (timeout kill of the process tree). This failure
  predates the change and is recorded as such. It stays visible in the report, with a rerun to
  tell flaky from deterministic, and is never relabelled as a known failure.
- Codex CLI is NOT installed and no OpenAI credential is configured. The user chose "Opus
  fallback only" for the live run. Every real review here is therefore the
  `claude-opus-high (codex unavailable)` fallback, disclosed as such.

## 1. Issue #37

### 1a. Fallback gate thresholds: already fixed, add the missing parity proof
PR #41 (`b7766a2`) gave design/build/verify a `parity()` that applies codex-review's
`computeTriggers`/`computeVerdict` rule. What #37 still asks for and is missing: a test that
the codex path and the fallback path give the SAME gate result for the same findings.

- New `tests/fallback-parity.test.js`: a table of finding sets (MINOR-only, NIT-only,
  MAJOR 0.85 / 0.6 / 0.3, one/two/three MAJOR with and without ISO property, BLOCKING at low
  confidence, mixed) x kinds (`implementation`, `prd`, `spec`). For each row: run
  codex-review's exported `computeVerdict` (findings marked `validation.status: confirmed`,
  the state codex's second pass leaves real findings in), and run each workflow's `parity()`
  (extracted from design.js, build.js and verify.js source text so the test exercises the
  shipped code). Assert equal verdicts and that non-triggering findings land in
  `other_findings`. A drift between the three copies of `parity()` also fails this test.
- Security pass: the codex security rule (FAIL on any high/critical) and the Opus security
  fallback already share one verdict rule in build.js; add one row asserting a `medium`
  finding does not fail either path.

### 1b. Executable long-wait relay test
New `tests/relay-wait.test.js`. It does not ask a model anything; it executes the relay
protocol the prompt prescribes, so the wording and the behaviour are tested together.

- Take the real codex relay prompt from a design run (the existing `run()` harness, scripted
  agent boundary). Extract the runner command line and the poll loop
  (`for i in $(seq 1 54); do ls <target> ... sleep 10; done`) from the prompt text. Fail the
  test if either cannot be found, so a wording change cannot silently skip it.
- Shorten only the timing: rewrite `seq 1 54` -> `seq 1 N` and `sleep 10` -> `sleep 0.2`.
- Point the runner at codex-review's `fake-codex.js` through PATH (as run-fake-tests does), with
  a new `FAKE_CODEX_DELAY_MS` knob in fake-codex.js (default 0, existing scenarios unchanged).
- Happy path: start the runner as a background child process; run the poll loop as separate
  foreground `bash -c` invocations, at least two needed (delay > one loop's duration); assert
  >= 2 foreground calls, the child is still alive before the result exists, the result.json is
  read and parsed with verdict PASS, and the child exits 0 after that.
- Deadline path: a delay longer than the total poll budget; after the bounded loops the
  harness reports `ERROR` with the run folder listing (the relay's prompted behaviour), and the
  child is killed and reaped (no orphan left).
- The deadline is computed exactly as the prompt computes it (`Math.ceil(TIMEOUT_S * 6 / 60) + 5`
  minutes), asserted for the default timeout, so a prompt change is noticed.

## 2. Issue #54: work packages

Order matters: WP1 is the contract every later package consumes.

| WP | Content | Files |
|---|---|---|
| WP1 | Strict JSON parser, schema-lite validator, graph rules, `validate-feature.js`, `feature.schema.json`, fixtures S01-S14, S17-S20 deterministic part, tests | `scripts/lib/{strict-json,schema-lite,feature-graph,feature-render}.js`, `scripts/validate-feature.js`, `schemas/feature.schema.json`, `tests/fixtures/v2/{valid,invalid}/`, `tests/feature-validate.test.js` |
| WP2 | Compiler + `--check` drift mode, determinism tests (Level 2), marker-never-executed test | `scripts/compile-feature.js`, `tests/feature-compile.test.js` |
| WP3 | Completion v2: `--mode design`, v2 identity/check/negative-control rules in plan and completion modes; v1 path byte-for-byte unchanged in behaviour | `scripts/check-completion.js`, `tests/check-completion-v2.test.js` |
| WP4 | design.js v2 (one canonical file, validate before review, PRD review `--against` source request, spec review on views of the same revision, approval identities, reconciliation prompts, seed draft arg, commit + compile at freeze); codex-review `--against` for prd + rubric | `workflows/design.js`, `../codex-review/scripts/run-review.js`, `../codex-review/rubrics/{prd,spec}.md`, `../codex-review/SKILL.md`, tests |
| WP5 | build.js design preflight + charge-only mode; verify.js frozen checks + negative-control phase; land.js v2 args passthrough | `workflows/{build,verify,land}.js`, `tests/stages-v2.test.js` |
| WP6 | `migrate-v1.js` + fixtures; SKILL.md, template, README entry, docs | `scripts/migrate-v1.js`, `tests/migrate-v1.test.js`, `SKILL.md`, `templates/pipeline.yaml` |
| WP7 | Live smoke run (Level 4, Opus fallback) and the evidence report | `tests/v2-verification-report.md` |

### WP1 details
- `strict-json.js`: a recursive-descent parser over a JS string; returns `{ value }` or throws
  `{ code, path, offset, message }`. It rejects duplicate keys at any depth (S03),
  `__proto__`/`constructor`/`prototype` keys, a BOM, trailing commas, comments, NaN/Infinity,
  lone surrogates in `\u` escapes, and control characters in strings. Objects are built with
  `Object.create(null)` and copied out in key order. Unicode round-trips (S02).
- `schema-lite.js` supports exactly: `type` (incl. arrays of types), `enum`, `const`,
  `pattern` (anchored, compiled once with the `u` flag), `minLength`, `minItems`, `minimum`,
  `required`, `properties`, `additionalProperties: false`, `items`, `$ref` to `#/$defs/...`,
  `$defs`, `$schema`, `$id`, `title`, `description`. Any other keyword in the schema -> setup
  error (exit 2). Conditionals (runtime vs static, retired vs active, applicable vs not) are
  graph rules, not schema keywords, so the subset stays small.
- `feature-graph.js`: every rule in design section 3.4, each with a fixture.
- Fixture format: `tests/fixtures/v2/invalid/S05-dup-requirement-id.feature.json` +
  `.expect.json` `{ exit: 1, codes: ["E_DUP_ID"], paths: [...] }`. The test runs the real CLI
  (child process) on every fixture and compares exit code, codes and paths exactly. Valid
  fixtures: S01 minimal, S02 unicode/multiline, S13 not-applicable check with reason, plus
  `medium.feature.json` and `multi-component.feature.json` for Level 2.
- S15 (prose contradiction) and S16 (paraphrased duplicate): fixtures that PASS the
  deterministic gate on purpose (the test asserts exit 0, so nobody can later claim schema
  catches them), and that are seeded into the live run's design review (WP7).

### WP2 details
- Output ordering is schema order, produced by one explicit field list per object in
  `feature-render.js` (no `Object.keys` order on parsed input).
- Tests: compile each valid fixture twice into two fresh dirs, compare bytes and identity
  hashes; key-reordered copy of a fixture -> different source hash, identical manifest body
  except `source.sha256`/`spec_sha256` and identical views; edit one byte of a generated
  view/manifest -> `--check` exits 1 with `E_DRIFT` naming that file; a fixture whose proof
  command is `node -e "require('fs').writeFileSync('<marker>','x')"` -> validate and compile
  leave no marker; `--out` inside a repo or non-empty -> exit 2.

### WP3 details
- Version dispatch on `manifest.version`. v1 keeps today's code path; the existing 148 tests
  are the regression proof and are not edited except where a helper must be shared.
- v2 additions: `--mode design --commit <sha>`; identity checks (git show of `source.path` at the
  commit/reviewed sha hashes to `source.sha256`, recompile in-process reproduces the manifest
  bytes, versions match); build result `plan_identity`; check records vs frozen checks; negative
  control records; canonical file path never in the reviewed diff (protected).

### WP4 details
- Args: v2 design needs `work_branch` and `source_request_path` (the main session writes the task
  text there, outside the repo). Optional `seed_feature_path` (absolute; copied as the first draft
  instead of authoring, for migrations and for the live-run seeded scenarios) and `features_dir`.
- Loop: draft -> validate (repair up to `max_rounds` on deterministic errors; review never sees
  an invalid file) -> compile rev-k -> PRD review (against source request) -> revise/rereview ->
  spec review (views of the same rev) -> on any spec-round revision, compare `prd_view_sha256`;
  changed -> PRD review reruns -> freeze when design section 5 holds -> commit the canonical
  file with an explicit pathspec -> compile frozen -> `--mode design` preflight on the design commit.
- Every hash in the result comes from script output relayed by a low-effort agent; the
  workflow checks hex shape and that the freeze preflight reproduced them. The completion
  validator recomputes all of them later, so a relay mistake cannot certify.
- codex-review: allow `--against` for `prd` (source request). PRD rubric gains "every item of
  the reference request is covered by a requirement or explicitly excluded with a reason".
  The fake test suite gets a case for it.

### WP5 details
- build: design-gated when `manifest_path` is given. Requires `manifest_sha256` and `spec_path`
  (the canonical file). Preflight agent runs `--mode design --commit <HEAD>` before the
  implementer; BLOCKED on any failure. Result gets `plan_identity`. Without a manifest: the
  `charge-only` mode, stamped on the result.
- verify: plan preflight output includes `manifest_version` and, for v2, `frozen_checks`;
  args.checks compared by the workflow (deep equality over the frozen fields) BEFORE any check
  runs. Negative-control phase per design section 6. Old v1 behaviour unchanged for v1 manifests.
- land: passes the v2 manifest; completion revalidation does the rest. No PR logic change.

### WP6 details
- migrate-v1: exact acceptance-id/proof mapping, `MIGRATION-TODO` for anything underivable;
  report JSON lists every todo with a reason; validator rejects the token (`E_MIGRATION_TODO`).
- SKILL.md rewritten for v2 stage args and the canonical-file rule; v1 compatibility section;
  rollback (`git revert` of the design commit; the run dirs are outside the repo); resume
  (reload the frozen identity from design's result; never recompile into the frozen dir).

## 3. Verification plan (maps to issue #54 levels)

| Level | How | Runnable here? |
|---|---|---|
| 0 | Full gated-pipeline node tests + codex-review fake runner, before and after | yes |
| 1 | Fixture matrix S01-S20 through the real CLI; table of expected vs actual + stopping gate | yes (S15/S16 deterministic part = PASS by design; semantic part in Level 4) |
| 2 | Compiler determinism, reorder policy, drift, no-execution marker, unsafe paths | yes |
| 3 | Mocked agent-boundary workflow tests (labelled mocked): invalid spec stops before review, PRD PASS + invalid spec cannot freeze, stale PRD approval reruns, fallback disclosure, build drift BLOCKED, verify altered checks BLOCKED, land refusal paths | yes |
| 4 | REAL Workflow runs on a disposable local synthetic repo (toy Node HTTP auth service, local fake users, `node --test` suite, local bare remote) | partially: see below |
| 5 | Novice-agent run, Windows paths, 3 synthetic requests x 3 rounds metrics | partially |

Level 4 plan (each a real `Workflow({ scriptPath: <skill>/workflows/<stage>.js })` call from the
main session, Opus fallback reviewers, all outputs kept under the scratchpad):
- E2E-A happy path: design -> build -> verify -> land up to completion revalidation. The PR/CI
  part is NOT RUN: this session may not create a GitHub repo, and no disposable remote repo is
  authorized. Land is expected to return BLOCKED at the PR step; that is reported, not hidden.
- E2E-B omission: `seed_feature_path` = a draft omitting invalid-login, source request asks for
  both. Expect the PRD review to cite the source request and the revised file to add it.
- E2E-C contradiction: seed "lock after 3 failures" + "never lock". Expect a non-PASS PRD/spec
  review citing both IDs. Whatever the reviewer actually returns is recorded.
- E2E-D drift stress: covered by B/C revisions plus the final file check (one definition per ID,
  no shadow IDs, `--check` clean). Three rounds are not forced artificially; actual round count
  is reported.
- E2E-E approval/code drift: after the real design freeze, mutate (in copies) the canonical file,
  a proof command, the manifest, and an implementation file; run the real preflights; each must
  fail. Then restore and show they pass.
- E2E-F negative control: the real verify's negative-control phase on the toy service.
- E2E-G resume/migration: rerun verify from design's persisted identity; run completion against
  a v1 fixture plan (v1 rules) and migrate-v1 on it (draft fails validation by design).
- E2E-H failure propagation: failing suite / missing proof log via completion runs on real
  artifacts; a security high and a red CI in live runs are NOT RUN (cost, no CI) unless time allows.
- Every scenario not run stays in the report as NOT RUN with its blocker. Issue #54 stays open:
  its release rule needs real Codex reviews and a real PR/CI, both NOT RUN here.

## 4. Commits

One commit per WP (tests in the same commit), plus one for #37, plus the report. Explicit
pathspecs. Push to `claude/charming-pasteur-ncpes9`. No PR unless the user asks.

## 5. Risks and mitigations

- Workflow scripts cannot read files or hash: every identity is computed by scripts, relayed,
  and recomputed by the completion validator, so a relay error blocks rather than certifies.
- Long live run cost/time: one feature, small toy repo, `max_rounds` 3, `review_timeout_seconds`
  default; stop and report rather than loop.
- Breaking existing users: v1 manifests keep v1 rules; design.js v2 is the only behavioural break
  (it no longer writes prd.md/spec.md). Called out in SKILL.md and the report.
