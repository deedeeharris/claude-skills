---
name: gated-pipeline
description: Use to take a feature or fix from a raw task or an existing plan to a reviewed PR in any repo using in-session Workflows, with one canonical feature file (PRD and spec in one machine-validated JSON file, generated views and manifest), test-first implementation, cross-family Codex reviews, frozen-command evidence, mandatory completion proof, and CI gates. Trigger on "run the pipeline on X", "execute this plan", "build feature X with the gated pipeline", "design/build/verify/land X", "migrate a v1 plan", or an mm/PM tick that must move a feature forward.
---

# gated-pipeline

Run one feature through four stages, each a Workflow script in `workflows/`. Claude writes and fixes the code; **codex reviews every artifact** through the `codex-review` skill (cross-family: Claude never grades Claude). Each repo describes itself in `.claude/pipeline.yaml` (template: `templates/pipeline.yaml`). This executes one plan; scheduling, multi-day liveness and merging belong to the human or outer orchestrator.

Two contracts exist. `contract: 2` (v2, the default for every new feature) designs the feature as ONE canonical feature file and derives everything else from it by script; it is the only path that yields a `v2/design-gated` proof. `contract: 1` (absent = 1) is the v1 flow (`prd.md`, `spec.md`, hand-written `execution-plan.json`), kept unchanged for features already frozen under it (see Contract 1 (v1) compatibility).

Invoking this skill is the user's opt-in to run the Workflow tool for these stages.

## Before any stage
1. Read the repo's `.claude/pipeline.yaml`. If it is missing, copy `templates/pipeline.yaml` there, fill it from the repo (test commands, branches, lock), and show the user the result before running anything.
2. Read the repo's CLAUDE.md. Its rules win over this skill.
3. Pick a run id and a run directory: `<state_dir>/<feature>/<stage>/<run_id>`, where `state_dir` is an ABSOLUTE path OUTSIDE the repo (default `<home>/.pipeline-state/<repo-name>`). Create it. A run dir inside the repo makes the tree dirty and blocks the suite's clean-tree check unless its prefix is in `clean_ignore`. Every stage run uses a FRESH `run_dir`, including a build rerun after `HEAD_MOVED` or `CI_RED`: each review relay creates its out dir (and the Opus fallback its `<out>-opus/`) with a plain `mkdir` and returns BLOCKED when it already exists, so an older result can never be read as this run's.
4. Pass config values to the workflow through `args`. Workflow scripts cannot read files, so the main session reads the config and passes what the stage needs.
5. Every path arg must be ABSOLUTE and use only letters, digits, space and `._/\:+@-` (no `~`, quotes, `$`, backticks). The workflows single-quote paths into shell commands and refuse anything else with BLOCKED. `review_timeout_seconds` (default 1200) is the per-attempt codex timeout; real reviews of a few files take 10+ minutes. `review_fallback` is `none` (default) or `opus-high` (see Hard rules); any other value is BLOCKED.

6. Before implementation, use the checkout and `work_branch` selected by the orchestrator; an existing checkout is supported and a dedicated feature worktree is optional. Record the original base SHA, check the clean baseline and the correct dev/client environment, and capture the current behaviour. Let the orchestrator coordinate checkout ownership and parallel lanes. Do not weaken guards or verification criteria to get past a blocker.
7. Keep a visible phase list. Read the existing feature failure/checkpoint ledger if one exists; initialize it when absent. Preserve the original base, plan hashes, evidence locations and outstanding IDs across interruptions.
8. A raw task goes through design (`contract: 2`). For an existing plan, normalize its acceptance IDs, scope and verification into the canonical feature file without changing agreed requirements (a frozen v1 plan: import it with `scripts/migrate-v1.js`, see Migration from v1); have Codex review it before implementation. Once execution is authorized, continue between steps without repeated confirmation. Stop on a real blocker or unapproved scope change.

## Contract 2 (v2): one canonical feature file

Every stage takes `contract: 1|2` (absent = 1). Use `contract: 2` for every new feature. The normative design is `docs/v2-design.md`; this section is how to run it. Only a v2 proof (`contract: 2`, `certification: "design-gated"`, written by verify and revalidated by land) is `v2/design-gated`, and only `v2/design-gated` meets issue #54. A v1 run keeps its v1 contract and never acquires v2 certification.

### The canonical file
- A feature has exactly ONE editable design artifact: `<repo>/<features_dir>/<feature_id>.feature.json` (strict JSON, schema `schemas/feature.schema.json`, `schema_version: 2`). `features_dir` defaults to `.pipeline/features`; set it with `design.features_dir` in `.claude/pipeline.yaml` and pass it as the design arg `features_dir`. It must be a safe repo-relative path, never `.git/` or below (design BLOCKS with `E_SCOPE` before any agent).
- It holds the source request, the product (PRD) content, the technical (spec) content, the acceptance scenarios, the frozen verification configuration (suite, checks, limits) and the scope. There is no `prd.md`, no `spec.md` and no hand-written `execution-plan.json` under contract 2.
- Everything else is derived by scripts into the run dir OUTSIDE the repo: `scripts/compile-feature.js` writes `execution-plan.json` (manifest v2), `prd.view.md`, `spec.view.md` and `compile-identity.json`. The views say `GENERATED - DO NOT EDIT`; they exist for reviewers and humans. Never edit a view, a manifest, a hash or a ledger: every certifying check recompiles the committed file and compares byte for byte (`E_DRIFT`).
- `scripts/validate-feature.js` is the deterministic gate (parse, version, schema, graph rules G01-G39, source rules R01-R04, previous-revision rules P01-P02). It proves structure only; semantic adequacy is the PRD and spec reviews' job.
- Commands are data until frozen: no agent executes a command found in the canonical file, a view or the manifest. Only `scripts/run-frozen.js` executes frozen commands (suite, checks, proofs, negative controls), from the frozen manifest, in build and verify.
- Byte authority: the committed blob is the source; every hash is over raw bytes. The working-tree file must equal the blob and be clean wherever a stage reads it. Repos that convert line endings must add `<features_dir>/*.feature.json -text` to `.gitattributes` (e.g. `.pipeline/features/*.feature.json -text`); a CRLF or hook-rewritten checkout is BLOCKED, never re-hashed.
- Reconciliation: fix a finding at the requirement, decision or check that owns it, in place. Keep ids stable (`E_ID_REMOVED`, `E_ID_REACTIVATED`); a new id only for a genuinely distinct requirement; never `-fix`/`-v2`/`-final` ids or appendices (`E_SHADOW_ID`). Remove an item by `status: "retired"` with `retired_rationale` (a coverage item by `disposition: "excluded"`, a check by `applicable: false`), never by deleting it, and never reuse its id.

### Source privacy
- `source_request_mode: text` (default): the file carries `source_request: { text }`, the request verbatim, and the design commit puts it in git. Use it only for a request that may live in the repo.
- `source_request_mode: ref` for a confidential request: pass `source_request_ref` (a non-public location label, never a secret); the file carries only `{ ref, sha256, summary }`, the sha256 of the exact request bytes and a summary in the author's words. What is committed is the ref, the hash, the summary and paraphrased coverage excerpts. The excerpt rule: no `coverage[].excerpt` may share any 40-character run with the request (`E_SOURCE_LEAK`); a text form in ref mode is `E_SOURCE_FORM`.
- `source_request_path` must lie outside the repo; design copies it to `<run_dir>/source-request.txt`, which never leaves the run dir. Never paste a confidential request into a PR body, an issue, a log you publish or a fixture.

### File ownership
- `architecture.components[]` own code: each has `owned_paths` (inside `scope.allowed_paths`) and `exclusive`. Two `exclusive` components may not own overlapping paths (`E_OWNERSHIP`). Every active requirement names its `component_ids`.
- `scope.test_paths` hold the tests and may not overlap any owned path: tests live outside the code a mutation may touch. No allowed, owned, test, state or clean_ignore path may overlap a protected path (`scope.protected_paths` plus `<features_dir>/`; `E_PROTECTED_OVERLAP`), and no state or clean_ignore path may overlap an allowed, owned, test or evidence path (`E_STATE_OVERLAP`).
- A negative control is `isolated_mutation` (prose saying what to break) or `exempt` with its reason (static and live acceptances must be exempt; a P0 requirement whose every acceptance is exempt needs `alternate_evidence`). Verify writes each mutation as a patch and `run-frozen.js` applies it in a throwaway worktree: it may only change files inside the `owned_paths` of that requirement's components, never a file under `test_paths`, never a test the build added and never a file named in the proof command. The baseline proof must pass and the mutated proof must fail.

### Stages under contract 2
- design (`workflows/design.js`): the author writes the canonical file in the checkout; every revision is snapshotted (validate with `--previous`, compile) before a reviewer sees it; the PRD review reads `prd.view.md` against the request, the spec review reads `spec.view.md` plus the manifest against the PRD view; an approval ledger (`approvals-<n>.json`) records every review; `check-completion.js --mode approvals` re-derives it; one design commit touching only the canonical file is made with a compare-and-swap on `work_branch`, then frozen into `<run_dir>/frozen/` and checked with `--mode design`. Returns PASS with the fields of the handoff table below.
- build (`workflows/build.js`): a design preflight (`--mode design`) runs before the implementer; `base_commit` must equal `design_commit`; the suite runs through `run-frozen.js --target suite`; the result carries `build_mode: "v2"`, `plan_identity`, `suite_identity` and hashed `review_files`. Save the raw result as `build_result_path`.
- verify (`workflows/verify.js`): `--mode plan` preflight, each applicable check and every runtime proof through `run-frozen.js`, final review and compliance trace, then the negative controls LAST, then completion v2. A control that would start after `limits.negative_controls_total_min` is NOT RUN, so verify is INCOMPLETE.
- land (`workflows/land.js`): revalidates completion with the frozen dir, the ledger and `--trunk-ref origin/<trunk_branch>`, opens or reuses the PR, watches CI; its result echoes `cross_family`, `fallback_used` and `allow_no_ci`. The human merges.
- Path args under contract 2 are normalized absolute POSIX paths (no `//`, `/./`, `..`, trailing slash or backslash); `run_dir`, `frozen_dir`, the ledger, the build result and any CI log lie outside the repo.

```
Workflow({ scriptPath: "<skill-dir>/workflows/design.js", args: {
  contract: 2, feature_id, repo, work_branch, run_dir, review_runner, completion_runner, source_request_path,
  source_request_mode, source_request_ref, features_dir, previous_design, seed_feature_path, recover,
  codex_model, codex_effort, review_timeout_seconds, max_rounds, author_effort, review_fallback, security_docs } })
Workflow({ scriptPath: "<skill-dir>/workflows/build.js", args: {
  contract: 2, feature_id, repo, work_branch, run_dir, review_runner, security_schema, completion_runner,
  frozen_dir, manifest_path, manifest_sha256, spec_path, design_commit, approvals_path, approvals_sha256, base_commit,
  ci_failure_log_path, codex_model, codex_effort, impl_effort, max_fix_rounds, lock_note, review_timeout_seconds,
  review_fallback, security_docs, security_checklist } })
Workflow({ scriptPath: "<skill-dir>/workflows/verify.js", args: {
  contract: 2, feature_id, repo, work_branch, run_dir, review_runner, spec_path, compliance_schema, manifest_path,
  manifest_sha256, build_result_path, completion_runner, frozen_dir, design_commit, approvals_path, approvals_sha256,
  base_commit, reviewed_sha, files, deleted, codex_model, codex_effort, review_timeout_seconds, review_fallback,
  scan_log, require_scan_row } })
Workflow({ scriptPath: "<skill-dir>/workflows/land.js", args: {
  contract: 2, feature_id, repo, work_branch, trunk_branch, title, body_path, reviewed_sha, completion_runner,
  manifest_path, manifest_sha256, spec_path, build_result_path, verify_result_path, proof_path, frozen_dir,
  approvals_path, approvals_sha256, ci_wait_min, allow_no_ci } })
```

### v2 args: design
| Arg | Required | Value |
|---|---|---|
| `contract` | required | `2` |
| `feature_id` | required | letters, digits, `._-`; the file is `<features_dir>/<feature_id>.feature.json` |
| `repo` | required | absolute path of the checkout |
| `work_branch` | required | the branch checked out in `repo`; the design commit lands on it |
| `run_dir` | required | a FRESH absolute dir outside the repo (it must not exist yet) |
| `review_runner` | required | absolute path of codex-review's `scripts/run-review.js` |
| `completion_runner` | required | absolute path of this skill's `scripts/check-completion.js`; the other scripts are found next to it |
| `source_request_path` | required | absolute path of the raw request, outside the repo |
| `source_request_mode` | optional | `text` (default) or `ref` (see Source privacy) |
| `source_request_ref` | optional | ref mode only, required there: the label `source_request.ref` must carry |
| `features_dir` | optional | from `design.features_dir`; default `.pipeline/features` |
| `previous_design` | optional | `{ commit, repo_path }` of this feature's earlier frozen design; required whenever one exists (scope change) |
| `seed_feature_path` | optional | absolute path of a prepared canonical file (e.g. a filled migration draft) copied into the checkout instead of a fresh draft |
| `recover` | optional | `true`: freeze a run that died after its design commit, with the same `run_dir` (see Resume) |
| `codex_model`, `codex_effort`, `review_timeout_seconds`, `max_rounds`, `author_effort`, `review_fallback`, `security_docs` | optional | as in v1 |

### v2 args: build
| Arg | Required | Value |
|---|---|---|
| `contract` | required | `2` |
| `feature_id`, `repo`, `work_branch` | required | as for design |
| `run_dir` | required | a FRESH absolute dir outside the repo, for every build run |
| `review_runner` | required | as for design |
| `security_schema` | required | `<skill-dir>/schemas/security.schema.json` |
| `completion_runner` | required | as for design |
| `frozen_dir` | required | design `frozen_dir` |
| `manifest_path` | required | design `manifest_path` (`<frozen_dir>/execution-plan.json`) |
| `manifest_sha256` | required | design `manifest_sha256` |
| `spec_path` | required | design `feature_path` (the canonical file in the checkout) |
| `design_commit` | required | design `design_commit` |
| `approvals_path` | required | design `approvals_path` |
| `approvals_sha256` | required | design `approvals_sha256` |
| `base_commit` | required | design `design_commit` (must be equal) |
| `ci_failure_log_path` | optional | absolute path, outside the repo, of a saved CI failure log (CI_RED/HEAD_MOVED loop); context only |
| `codex_model`, `codex_effort`, `impl_effort`, `max_fix_rounds`, `lock_note`, `review_timeout_seconds`, `review_fallback`, `security_docs`, `security_checklist` | optional | as in v1 |

### v2 args: verify
| Arg | Required | Value |
|---|---|---|
| `contract` | required | `2` |
| `feature_id`, `repo`, `work_branch`, `review_runner`, `completion_runner` | required | as for build |
| `run_dir` | required | a FRESH absolute dir outside the repo |
| `compliance_schema` | required | `<skill-dir>/schemas/compliance.schema.json` |
| `spec_path` | required | design `feature_path` |
| `frozen_dir`, `manifest_path`, `manifest_sha256`, `design_commit`, `approvals_path`, `approvals_sha256` | required | the design values, unchanged |
| `build_result_path` | required | the saved raw build result |
| `base_commit` | required | design `design_commit` (build's `base_commit`) |
| `reviewed_sha` | required | build `reviewed_sha` |
| `files`, `deleted` | optional | informational, repo-relative |
| `codex_model`, `codex_effort`, `review_timeout_seconds`, `review_fallback`, `scan_log`, `require_scan_row` | optional | as in v1; `scan_log`/`require_scan_row` are recorded as `repo_config` |

### v2 args: land
| Arg | Required | Value |
|---|---|---|
| `contract` | required | `2` |
| `feature_id`, `repo`, `work_branch`, `completion_runner` | required | as for build |
| `trunk_branch` | required | the PR target |
| `title` | required | letters, digits, spaces and `._,:;()#/+@-` |
| `body_path` | required | the PR body the main session wrote |
| `reviewed_sha` | required | build `reviewed_sha` |
| `spec_path` | required | design `feature_path` |
| `frozen_dir`, `manifest_path`, `manifest_sha256`, `approvals_path`, `approvals_sha256` | required | the design values, unchanged |
| `build_result_path` | required | the saved raw build result |
| `verify_result_path` | required | verify `verify_result_path` |
| `proof_path` | required | verify `completion.proof_path` |
| `ci_wait_min`, `allow_no_ci` | optional | as in v1 |

### v2 forbidden args
`checks`, `clean_ignore`, `state_paths`, `suite_cmd`, `unit_cmd`, `known_failures`, `isolated_setup`, `suite_isolated`, `live_budget_min` are BLOCKED under contract 2 before any agent, in every stage that accepts them: the frozen manifest is their only source.
Mixing contracts is BLOCKED too: `contract: 2` with `task` or `charge` (CI failure context goes in `ci_failure_log_path`), a v2-only arg (`frozen_dir`, `design_commit`, `approvals_path`, `approvals_sha256`, `ci_failure_log_path`) without `contract: 2`, and a v1 manifest under `contract: 2` or a v2 manifest under `contract: 1`.

### v2 stage handoff
Persist each stage's raw result (`result.json` in its run dir) and pass these values on unchanged:

| Field | From | build | verify | land |
|---|---|---|---|---|
| `feature_path` | design | `spec_path` | `spec_path` | `spec_path` |
| `design_commit` | design | `design_commit`, `base_commit` | `design_commit`, `base_commit` | - |
| `frozen_dir` | design | `frozen_dir` | `frozen_dir` | `frozen_dir` |
| `manifest_path` | design | `manifest_path` | `manifest_path` | `manifest_path` |
| `manifest_sha256` | design | `manifest_sha256` | `manifest_sha256` | `manifest_sha256` |
| `approvals_path` | design | `approvals_path` | `approvals_path` | `approvals_path` |
| `approvals_sha256` | design | `approvals_sha256` | `approvals_sha256` | `approvals_sha256` |
| `reviewed_sha` | build | - | `reviewed_sha` | `reviewed_sha` |
| saved raw result | build | - | `build_result_path` | `build_result_path` |
| `verify_result_path` | verify | - | - | `verify_result_path` |
| `completion.proof_path` | verify | - | - | `proof_path` |

Design also returns `feature_repo_path`, `source_sha256`, `prd_projection_sha256`, `prd_view_path`, `spec_view_path`, `approval_rule` and the ledger `records`: report them, and keep `design_commit` and `feature_repo_path` as the `previous_design` of any later scope change.

### CI_RED and HEAD_MOVED
When land returns `CI_RED`, or verify returns `HEAD_MOVED`, the main session saves the failing CI log (or the verify reason) to a file OUTSIDE the repo and reruns build `contract: 2` with the same frozen args, `base_commit == design_commit`, a fresh `run_dir` and `ci_failure_log_path` set to that file; then verify and land again, each with a fresh `run_dir`. The implementer and fixer get the log as context only ("the frozen canonical file is the only authority"): it never changes a command, a known failure or the scope, and the build result records `ci_failure_log { path, sha256 }`, which certifies nothing. A fix that needs a different command, check or scope is a scope change (below), never an edit of the frozen file.

### Repo config under contract 2
The canonical file replaces `tests.suite_cmd`, `tests.unit_cmd`, `tests.isolated_setup`, `tests.suite_isolated` and `verify_checks`: the author copies what applies into `suite` and `checks`, and the stages never read those config keys. `tests.known_failures`, `tests.clean_ignore` and `state.paths` stay in `.claude/pipeline.yaml` as the repo owner's UPPER BOUND: each is written as a one-line JSON array (`clean_ignore: ["tmp/"]`, a trailing `# comment` is allowed), and the canonical file's `suite.known_failures[].test_id`, `scope.clean_ignore` and `scope.state_paths` must each be a subset of it, read from the pipeline.yaml blob at the design commit (`E_CONFIG_BOUND`; another form is a setup error). `lock_note`, `scan_log`/`require_scan_row` and `allow_no_ci` stay repo config and stage args; they run no command and excuse no failure, and the proof records them as `repo_config`.

### Resume, interruption and rollback
- Never resume a gated stage with the Workflow runtime's `resumeFromRunId`: its cached agent replies would replay stale preflight, check and review results. Rerun an interrupted stage as a NEW Workflow call with a fresh `run_dir`, from the persisted result of the previous stage (the handoff values above). Never recompile into an existing frozen dir and never reuse a partial ledger. Certifying scripts re-derive identity live, so a replay that slips through still ends verify INCOMPLETE at stage `completion` and land refuses.
- design interrupted before its commit: rerun it with a fresh `run_dir` (pass `previous_design` if an earlier frozen design exists). Design interrupted after the commit and before freeze: rerun with `recover: true` and the SAME `run_dir`; it only re-checks the commit, the ledger and the lock and freezes. Anything else is BLOCKED; the workflow never resets, amends or stacks a second design commit.
- Stale lock: design holds `<git-dir>/gp-design-<feature_id>.lock` (content: its `run_dir`) for the whole run and removes it on PASS or BLOCKED. A lock left by a crashed run blocks every other design run of that feature (`E_LOCK_HELD`) until `recover: true` with that `run_dir` completes, or a human who has confirmed that no design run is alive removes it.
- Rollback: the design commit touches only the canonical file, so `git revert <design_commit>` removes the design; implementation commits are reverted the same way, never with a reset of a shared branch. Run dirs, views, manifests and evidence live outside the repo; deleting a run dir loses the evidence of that run, not repo state.
- Scope change after freeze: an authorized change to the canonical file is a NEW design run on a fresh work branch from the trunk with `previous_design` = the earlier `{ commit: design_commit, repo_path: feature_repo_path }`: new revision, new approvals, new design commit. The `--previous` rules bind it to every old id (retire, never remove). Re-apply prior implementation work on top of the new design commit so it falls inside the new reviewed range; old proofs no longer revalidate.

### Migration from v1
`scripts/migrate-v1.js` imports a v1 plan read-only:

```
node <skill-dir>/scripts/migrate-v1.js --manifest <v1 execution-plan.json> --spec <spec.md> [--prd <prd.md>] \
  [--source-request <original request>] --feature-id <id> --out <draft.feature.json>
```
It writes a DRAFT canonical file and `<out>.report.json` and never changes its inputs, so the v1 run still completes under contract 1. The acceptance ids and proof commands map exactly from the v1 manifest, listed in `mapping`: an id of the v2 form `<REQ>-ACn` is kept, an id of the requirement form `<REQ>` becomes `<REQ>-ACn` with the first `n` no other v1 id uses (`AUTH-001` next to `AUTH-001-AC1` becomes `AUTH-001-AC2`), and any other id becomes `MIG-NNN-AC1` with the first free `NNN`. The scope lists and checks are copied, and every field it cannot derive holds the literal `MIGRATION-TODO` as the whole field value, whatever its type (including each requirement's `depends_on` and `suite.known_failures`, which v1 kept in pipeline.yaml). The validator rejects the token: `E_MIGRATION_TODO` for a string field, a schema code (`E_TYPE`, `E_ENUM`) for a typed one, and the schema errors come first, so `E_MIGRATION_TODO` shows once the typed todos are filled. The report lists `todos`, `conflicts` (ids in only one of spec.md and the manifest, differing proof commands, a spec.md that does not hash to `spec_sha256`, and `scope_overlap` entries), `unmapped_tests`, `lost` (sections with no v2 field) and `provenance_missing` (no prd.md or no original request). A manifest outside the v1 schema (an unknown key, an empty `allowed_paths`) is refused with exit 2, as is any write error; exit 0 means "draft written", never "certified". A human or an authorized review resolves every report entry, then the filled file goes through a full v2 design run (`seed_feature_path`), with its own reviews and approvals. v1 lets a protected path sit inside an allowed one and a state path inside an allowed one; v2 rejects both (`E_PROTECTED_OVERLAP` G33, `E_STATE_OVERLAP` G34), the report lists each as a `scope_overlap` conflict with its rule, and the scope lists must be narrowed while filling the draft.

## Contract 1 (v1) compatibility

`contract: 1` (or no `contract` arg) is the v1 flow, unchanged apart from the #37 gate rule (Hard rules): `prd.md` + `spec.md` + a hand-written `execution-plan.json` (manifest `version: 1`, schema `schemas/execution-plan.schema.json`). Use it only to finish a feature that was frozen under v1. Its proofs carry no `contract` field and are never `v2/design-gated`. Build with `spec_path` is stamped `build_mode: "v1"`; build with only `charge` is the explicit `charge-only` mode (`build_mode: "charge-only"`), whose result completion rejects. Nothing upgrades a v1 plan silently: a v1 manifest under `contract: 2` fails, and a v2 manifest without its ledger fails completion. To move a v1 feature to v2, migrate it (Migration from v1) and run a v2 design.

### Stage 1 (v1): design (`workflows/design.js`)
Task text → `prd.md` → codex PRD review → revise until PASS → `spec.md` plus `execution-plan.json` → codex reviews both against the PRD → revise until PASS → freeze their exact byte hashes. Each acceptance item has a stable ID, proof command and negative control; the inventory records runtime/static evidence kind, allowed/protected paths, and extra-check applicability. Supply `schemas/execution-plan.schema.json` as `execution_schema`. Returns `PASS`, `FAIL` or `BLOCKED`, plus `manifest_path`, `manifest_sha256` and `spec_sha256` on PASS. Carry these values unchanged through completion; never silently replace the plan after review.

```
Workflow({ scriptPath: "<skill-dir>/workflows/design.js", args: {
  feature_id, repo, task, run_dir, review_runner, codex_model, codex_effort,
  review_timeout_seconds, max_rounds, author_effort, execution_schema, review_fallback, security_docs } })
```

### Stage 2 (v1): build (`workflows/build.js`)
An Opus implementer works test-first: failing test, code, passing test, checkpoint, commit with explicit pathspecs on the work branch. Then codex reviews the changed files. A fix agent addresses the **confirmed** findings, and codex re-reviews. This repeats up to `max_fix_rounds` times. After codex PASSes the review, a codex SECURITY pass runs (`codex exec` with `schemas/security.schema.json`; any high/critical finding goes back to the fix loop). `security_schema: "<skill-dir>/schemas/security.schema.json"` is REQUIRED. Then the suite command runs LAST, and a failure feeds back into the fix loop. The implementer reports `base_commit` (HEAD before it started) and any deleted files. Codex reviews the WHOLE change `base_commit..<head pinned at review time>`, with its file list taken from git (never from the agents' reports, which are only cross-checked), and never whole files, so old unrelated defects are not charged to the feature: the change is replayed as uncommitted edits in a throwaway worktree at `base_commit` (`<run_dir>/review-N/wt`, removed afterwards) and the runner reviews it with `--uncommitted`. Keep `run_dir` OUTSIDE the repo so that worktree never nests inside the work tree. A NEEDS_HUMAN verdict that still carries confirmed findings goes into the fix loop like a FAIL. So does one whose ONLY reason is `model_rule_disagreement` (codex's own verdict disagreed with the runner's rule) and that lists findings: those findings go to the fixer (or, in design, the author). Any other NEEDS_HUMAN without confirmed findings is BLOCKED. Returns `PASS`, `FAIL` (rounds exhausted) or `BLOCKED` (an agent hit a blocked command, a refusal, or missing input). The suite must run to completion on that same pinned commit; `known_failures` are EXACT test ids (a list, or one per line) and excuse only a completed run with no non-test failure (coverage, lint, post-test step). The security pass and verify's compliance trace run codex in an isolated checkout of the reviewed commit. The suite, every verify check and the compliance trace must run with HEAD at the reviewed commit and a clean work tree before AND after (prefixes in `clean_ignore` are tolerated); otherwise build is BLOCKED and verify returns `HEAD_MOVED`. The result's `reviewed_sha` is the commit to pass to verify and land.

```
Workflow({ scriptPath: "<skill-dir>/workflows/build.js", args: {
  feature_id, repo, work_branch, spec_path, charge, run_dir, review_runner,
  codex_model, codex_effort, impl_effort, max_fix_rounds, unit_cmd, suite_cmd,
  lock_note, live_budget_min, known_failures, clean_ignore, suite_isolated, isolated_setup,
  security_schema, review_timeout_seconds, base_commit, review_fallback, security_docs, security_checklist } })
```
When re-running build after land returns `HEAD_MOVED` or `CI_RED`, pass the feature's ORIGINAL `base_commit` (from the first build result) so every commit since then is inside the reviewed range.

### Stage 3 (v1): verify (`workflows/verify.js`, mandatory)
Run configured extra checks, then execute the frozen acceptance proof commands on the clean reviewed commit and save a per-ID ledger. Static acceptance uses source evidence; runtime acceptance needs actual command output. Run the final Codex defect review and independent SPEC-COMPLIANCE trace with `schemas/compliance.schema.json`, returning a positive trace for EVERY acceptance ID. Then run `scripts/check-completion.js` against the actual inventory, spec, Git diff and evidence files. Even `checks: []` must run acceptance/compliance/completion. Return `PASS`, `INCOMPLETE`, `FAIL`, `HEAD_MOVED` or `BLOCKED`; PASS includes `verify_result_path` and `completion.proof_path`.

Service boot/connectivity, success/failure/edge cases, side-effect readback, lint and types are required when applicable to the frozen spec. Mark truly inapplicable checks with a reason in the inventory; inability to run an applicable check is incomplete. Live/paid proofs reuse outputs from budgeted configured checks and never run unbudgeted calls in the acceptance phase. Run live batches one at a time and only on a quiet machine when configured.

```
Workflow({ scriptPath: "<skill-dir>/workflows/verify.js", args: {
  feature_id, repo, work_branch, run_dir, review_runner, files, deleted, base_commit, reviewed_sha, clean_ignore,
  spec_path, compliance_schema, checks, codex_model, codex_effort, review_timeout_seconds,
  manifest_path, manifest_sha256, build_result_path, completion_runner, review_fallback, scan_log, require_scan_row } })
```
`base_commit` and `reviewed_sha` are REQUIRED (pass build's values straight through); the final review and the compliance trace cover the whole change `base_commit..reviewed_sha`. `files`/`deleted` are informational and must be repo-relative. A check with no `budget_min > 0` may make no live or paid calls.

### Stage 4 (v1): land (`workflows/land.js`)
First re-run the deterministic completion validator with the frozen plan hash and the saved build/verify artifacts. A failed validation blocks before any PR action. Then open the PR from `work_branch` to `trunk_branch` (or reuses an open one), watches CI, re-runs only a clearly flaky failure once, and returns `READY_FOR_HUMAN_MERGE` (only when the PR head is `reviewed_sha`, or later commits touch nothing but `state_paths`), `HEAD_MOVED` (an unreviewed change landed after review: go back to stage 2), `CI_PENDING`, `CI_RED` (go back to stage 2 with the failing log as the charge) or `BLOCKED`. The main session writes the PR body (spec, completion evidence, known baseline failures, verdicts, test counts, and concrete human validation steps) to `body_path` first. **The human merges.** Never merge, never enable auto-merge, never push the trunk.

```
Workflow({ scriptPath: "<skill-dir>/workflows/land.js", args: {
  feature_id, repo, work_branch, trunk_branch, title, body_path, reviewed_sha, state_paths, ci_wait_min, allow_no_ci,
  manifest_path, manifest_sha256, spec_path, build_result_path, verify_result_path, completion_runner, proof_path } })
```
A PR with no checks is `CI_PENDING` (CI may not have registered yet) unless `allow_no_ci: true` says the repo has no CI.

### Completion contract (v1)

Set `completion_runner` to the included `scripts/check-completion.js`. Save build's raw result as `build_result_path` before verify. Pass design's unchanged manifest path/hash to verify and land. Pass verify's `verify_result_path` and `completion.proof_path` as land's `verify_result_path` and `proof_path`. Feature IDs use letters, digits and `._-`.

The read-only `--mode plan` preflight validates the frozen manifest/spec before verify executes commands. Completion reads the real files and Git state: exact unique acceptance IDs, PASS evidence for every applicable item, captured output hashes, valid static file/line references, completed suite, separate passing reviews, and the authoritative `base_commit..reviewed_sha` file list against allowed/protected scope. A runtime requirement cannot pass using a source reference alone; a static requirement needs a source reference. Empty, missing, failed or stale evidence blocks completion. Known baseline failures remain explicitly qualified in the proof; they are never described as an entirely green suite.

Capture `suite.log_path/log_sha256`, each configured check's `evidence_path/evidence_sha256`, and each runtime acceptance's `command/exit_code/log_path/log_sha256/head_sha` when the command finishes. Store output outside the target repo. The compliance schema also requires `file/line`; use null for unused runtime/static fields. Hash exact saved bytes, not a summary. Supply only applicable checks to `verify.checks`; keep justified inapplicable checks in the frozen inventory, without dispatching them.

When codex ran the compliance trace, verify runs `scripts/merge-compliance.js` (found next to `completion_runner`) before the validator. The relay agent can flatten codex's evidence records to strings or re-escape a copied command, so the merger copies the requirements from codex's own `compliance/compliance.json` into `verify-result.json` (the relayed copy is kept as `verify-result.relay.json`). It takes a re-escaped runtime command from the acceptance ledger only when id, log path, log hash and exit code all match. It makes a static path inside the compliance checkout repo-relative. It leaves out any other record the validator would reject by shape, and lists each change in the compliance note. It refuses (exit 1) unless codex said PASS with no findings, every ID passed, and the ID lists match. It never changes a verdict.

Land revalidates with `--previous-proof`: changing a captured log or build/verify result after verification invalidates the proof. The validator never executes supplied proof commands. It verifies identities, file existence, output integrity and scope; command/exit-code reports still come from the host agents. Hashes cannot authenticate a fabricated run or prove that a source reference semantically satisfies the requirement; independent Codex compliance provides that separate assessment.

State exceptions must be frozen as optional `state_paths` and `clean_ignore` in the manifest, using narrow repo-relative state prefixes. They must not overlap protected paths. Land uses these frozen paths and rejects a differing `state_paths` argument. Allow later state-only commits only when every intervening commit touches those approved paths; a code edit followed by a revert still invalidates readiness. Keep verification on the clean reviewed commit. Prefer outside-repo state; never hide production code, specs, tests or evidence behind a state exception. The human merges; completion certifies the reviewed branch commit, not a future merged state.

### Checkpoints, scope and resume (v1)

Keep `execution-ledger.json` in the build run directory with one entry per acceptance ID: status, command, exit code, output path/hash and commit. Write checkpoints atomically after each verified step, preserve failed/interrupted outputs, and record decisions taken without explicit input. These checkpoints are agent obligations; the skill does not provide a background scheduler or guarantee process survival.

After interruption, load the frozen plan, original base SHA and ledger; confirm the orchestrator-selected checkout/branch/environment and run an applicable smoke check. Resume the first unproven item. Retain previous evidence only while its plan identity and tested code remain applicable; always re-run final-commit proofs and checks. A missing required runner, suite, service or evidence is a blocker, never permission to substitute a passing mock harness. Use representative synthetic or approved anonymized data for runtime checks.

For necessary scope expansion, stop before editing the extra paths. Obtain authorization if existing task authorization does not cover the change, amend the spec/inventory, rerun the design review, pin new hashes and rerun affected evidence/reviews. Never silently add allowed paths to make completion pass. Provide a concrete human handoff: what to open or run and the expected behaviour, alongside the proof and PR.

## Security scans
The optional `security:` block in `.claude/pipeline.yaml` makes the security handling repo-owned. The repo's own OWASP checklist and CLAUDE.md win over this skill's defaults; leave the block out and every stage behaves as before.
- `security.docs` -> `security_docs` (design, build): ABSOLUTE paths to the threat model and accepted-risk docs. Design's spec must carry a Security considerations section (data exposure and authorization scope, input validation and length limits, resource consumption with a server-side bound such as a rate limit or result cap, and accepted risks that cite these docs instead of assuming them).
- `security.checklist` -> `security_checklist` (build): ABSOLUTE path to the repo's OWASP checklist. The security pass (codex and the Opus fallback) reads the docs and checklist first and covers the OWASP Top 10 and OWASP API Security Top 10 (including API4 unrestricted resource consumption). Client-side controls are not security controls, and an accepted risk elsewhere (e.g. same-origin content that can call the app's API with the user's credentials) widens the attack surface of every new endpoint. The verdict rule is unchanged: FAIL on any critical or high finding.
- `security.scan_log` + `security.require_scan_row` -> `scan_log`, `require_scan_row` (verify): with `require_scan_row: true`, the compliance trace must cite a dated scan-log row covering the change at `reviewed_sha` (file:line) or report a blocking finding. `scan_log` is repo-relative; `require_scan_row` without it is BLOCKED. The row is part of the change, so list `scan_log` in the frozen inventory's `allowed_paths`.

All three path args go through the same safe-path checks as every other path; an unsafe one is BLOCKED before any agent runs.

## Assumption the checks rely on
The clean-tree checks compare HEAD and `git status` at the START and END of each test run; they cannot see a checkout that another process swaps and restores mid-run. So **nothing else may write to the work checkout while a stage runs**. Have the orchestrator serialize writers in a shared checkout or choose separate checkouts for concurrent lanes; dedicated feature worktrees are optional. Set `suite_isolated: true` to run the suite in a fresh worktree of the reviewed commit, which removes this assumption for the suite.

## Hard rules (every stage, every repo)
- Reviews are cross-family by default: codex reviews every artifact. A capped codex (usage cap, quota error) is NOT a reason to switch reviewer: the stage returns BLOCKED and you WAIT for the cap to reset.
- The one exception is codex NOT AVAILABLE in the environment (`codex --version` or `node <review_runner> --help` cannot run or exits non-zero). Every codex relay checks this first and reports `codex_available`. Only when it is `false` AND the repo config sets `reviews.review_fallback: opus-high` (passed as the `review_fallback` arg) does Claude Opus 5.5 at high effort run the same review, with the same schema and scope (design: the doc against the PRD; build: the whole change in the throwaway worktree, plus security; verify: final review and compliance trace). Same review also means the same verdict rule: the Opus reviewer reads the codex-review rubric for the kind (`<codex-review>/rubrics/<kind>.md`, located next to `review_runner`), grades findings BLOCKING/MAJOR/MINOR/NIT with a confidence, and the workflow (never the model) applies the gate rule below, so MINOR and NIT findings are reported but never block. That result is stamped `reviewer: "claude-opus-high (codex unavailable)"` and must never be reported as a codex verdict. With `review_fallback: none` (the default), unavailable codex is BLOCKED.
- One gate rule for both reviewers (#37), equal to the codex path: the verdict is codex-review's `computeVerdict` (the workflows carry byte-identical copies of `computeTriggers`/`computeVerdict`); `confirmed_findings` = every validated-confirmed BLOCKING/MAJOR and `other_findings` = every other non-refuted finding; a PASS with any confirmed finding is FAIL (a fix or revise round), and a NEEDS_HUMAN with none is BLOCKED unless its only reason is `model_rule_disagreement` with findings listed (design and build send those on; verify BLOCKS). The workflow decides the buckets, not the relay: the codex relay copies `result.json` field by field (every finding's `id`, `severity`, `confidence`, `iso_property`, `validation.status`, `claim`, `evidence`, `location`, plus `verdict`, `verdict_reasons`, `model_verdict`, `outcome`, `unable_to_review`, `validation.outcome`, `run_dir` and its `result_sha256`). A reply without `findings` or `model_verdict`, one whose verdict differs from what its findings give, or a PASS whose `outcome` is not `ok` or whose `unable_to_review` is set is BLOCKED. The Opus fallback self-validates: every BLOCKING/MAJOR it reports counts as confirmed (ids `F1, F2, ...`). This is stricter than before for the fallback: a confirmed MAJOR below the trigger threshold, or one in the 0.5-0.8 band, now goes to a fix/revise round instead of passing or stopping. Two documented differences remain, both on the codex path only and both unchanged: (1) `model_rule_disagreement`, including a trigger that codex's validation refuted after the model judged it, is stricter there (BLOCKED, or a round on the remaining findings, where the fallback PASSes); (2) findings codex could not validate (the validation call failed or omitted an id): an unvalidated non-trigger MAJOR goes to `other_findings`, so codex can PASS where the fallback goes to a fix/revise round, and an unvalidated trigger gives NEEDS_HUMAN, so codex BLOCKS where the fallback goes to a fix round.
- Every review relay runs fixed, role-tagged blocks (` ```gp-exec <role> `) verbatim, in order: `setup` (availability probes, the fresh out dir, the review checkout), `start` (with the Bash tool's `run_in_background`; it writes `runner.pid`), `poll` (a bounded foreground loop of at most 9 minutes, repeated while it exits 1, at most the K times the prompt states), `cleanup` (once: SIGTERM to the `runner.pid` process if it is still alive, wait up to 10 s, remove the checkout, list the run folder). It WAITS IN THE FOREGROUND and never ends its turn between `start` and `cleanup`; a relay that ends its turn while codex runs kills the review. With no result after K polls it reports ERROR with the run-folder listing (BLOCKED, never a fallback). The Opus fallback runs only its `setup` and `cleanup`. The runner writes `result.json` atomically, and a SIGTERM/SIGINT to it stops its codex process group and records outcome `interrupted`. `tests/relay-wait.test.js` executes these blocks against the real runner and a fake codex; it proves the commands and the loop, not that a model obeys them.
- Never deploy, run Terraform against real state, publish packages, or touch production resources without the user's explicit yes.
- No `git add -A` or `.`; use explicit pathspecs. Never `git rm` or glob deletes. Delete only literal paths you created. Never `--no-verify`. Scan the diff for secrets before every commit.
- Live or paid test runs need a hard budget from the spec or config, plus a ledger in the run dir.
- If a command is blocked, or the API refuses an agent (a safety-filter refusal), STOP that stage and report. Never route around it with a different wording or tool.
- Agents report test numbers they observed, never estimates. A skipped check is reported as NOT RUN, never as a pass.

## After a workflow returns
Stamp the time on the result (scripts cannot read the clock), write `result.json` into the run dir, update the repo's state (see `state.mode` in config), and tell the user in plain words: what passed, what failed, what is next. Every review result carries `reviewer` (`codex`, or `claude-opus-high (codex unavailable)`; design reports the final one on `prd.reviewer` and `spec.reviewer`). Every stage result also carries `reviewers` (one `{ step, reviewer }` per review round, e.g. `prd review 1`, `review 2`, `security 2`, `final review`, `compliance`) and `fallback_used`. A later codex PASS does not erase an earlier fallback round, so read `reviewers`, not only the final review: if `fallback_used` is true, say so explicitly, name EVERY step the Opus fallback reviewed, and do not call the result cross-family reviewed.

Under `contract: 2` also report `certification` (land: `design-gated`), `cross_family` and `fallback_used` from the proof (they cover the PRD and spec approval reviews as well as build and verify), and the design's `approval_rule`. A migrated draft, a design BLOCKED on a deterministic gate, or a verify INCOMPLETE is never described as certified.

**Where state lives matters for land.** Prefer a `state_dir` OUTSIDE the repo. If the repo keeps state on the work branch (a harness), committing it after build moves the branch past `reviewed_sha`; land then accepts the PR only if every later commit touches nothing but the paths in `state_paths` (repo-relative prefixes, e.g. the state directory), and returns `HEAD_MOVED` otherwise. PR titles may only use letters, digits, spaces and `._,:;()#/+@-`.
