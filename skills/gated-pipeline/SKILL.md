---
name: gated-pipeline
description: Use to take a feature or fix from a raw task or an existing plan to a reviewed PR in any repo using in-session Workflows, with a frozen acceptance inventory, test-first implementation, cross-family Codex reviews, real evidence, mandatory completion proof, and CI gates. Trigger on "run the pipeline on X", "execute this plan", "build feature X with the gated pipeline", "design/build/verify/land X", or an mm/PM tick that must move a feature forward.
---

# gated-pipeline

Run one feature through four stages, each a Workflow script in `workflows/`. Claude writes and fixes the code; **codex reviews every artifact** through the `codex-review` skill (cross-family: Claude never grades Claude). Each repo describes itself in `.claude/pipeline.yaml` (template: `templates/pipeline.yaml`). This executes one plan; scheduling, multi-day liveness and merging belong to the human or outer orchestrator.

Invoking this skill is the user's opt-in to run the Workflow tool for these stages.

## Before any stage
1. Read the repo's `.claude/pipeline.yaml`. If it is missing, copy `templates/pipeline.yaml` there, fill it from the repo (test commands, branches, lock), and show the user the result before running anything.
2. Read the repo's CLAUDE.md. Its rules win over this skill.
3. Pick a run id and a run directory: `<state_dir>/<feature>/<stage>/<run_id>`, where `state_dir` is an ABSOLUTE path OUTSIDE the repo (default `<home>/.pipeline-state/<repo-name>`). Create it. A run dir inside the repo makes the tree dirty and blocks the suite's clean-tree check unless its prefix is in `clean_ignore`.
4. Pass config values to the workflow through `args`. Workflow scripts cannot read files, so the main session reads the config and passes what the stage needs.
5. Every path arg must be ABSOLUTE and use only letters, digits, space and `._/\:+@-` (no `~`, quotes, `$`, backticks). The workflows single-quote paths into shell commands and refuse anything else with BLOCKED. `review_timeout_seconds` (default 1200) is the per-attempt codex timeout; real reviews of a few files take 10+ minutes. `review_fallback` is `none` (default) or `opus-high` (see Hard rules); any other value is BLOCKED.

6. Before implementation, use the checkout and `work_branch` selected by the orchestrator; an existing checkout is supported and a dedicated feature worktree is optional. Record the original base SHA, check the clean baseline and the correct dev/client environment, and capture the current behaviour. Let the orchestrator coordinate checkout ownership and parallel lanes. Do not weaken guards or verification criteria to get past a blocker.
7. Keep a visible phase list. Read the existing feature failure/checkpoint ledger if one exists; initialize it when absent. Preserve the original base, plan hashes, evidence locations and outstanding IDs across interruptions.
8. A raw task goes through design. For an existing plan, normalize its acceptance IDs, scope and verification into the design artifacts without changing agreed requirements; have Codex review them before implementation. Once execution is authorized, continue between steps without repeated confirmation. Stop on a real blocker or unapproved scope change.

## Stage 1: design (`workflows/design.js`)
Task text → `prd.md` → codex PRD review → revise until PASS → `spec.md` plus `execution-plan.json` → codex reviews both against the PRD → revise until PASS → freeze their exact byte hashes. Each acceptance item has a stable ID, proof command and negative control; the inventory records runtime/static evidence kind, allowed/protected paths, and extra-check applicability. Supply `schemas/execution-plan.schema.json` as `execution_schema`. Returns `PASS`, `FAIL` or `BLOCKED`, plus `manifest_path`, `manifest_sha256` and `spec_sha256` on PASS. Carry these values unchanged through completion; never silently replace the plan after review.

```
Workflow({ scriptPath: "<skill-dir>/workflows/design.js", args: {
  feature_id, repo, task, run_dir, review_runner, codex_model, codex_effort,
  review_timeout_seconds, max_rounds, author_effort, execution_schema, review_fallback } })
```

## Stage 2: build (`workflows/build.js`)
An Opus implementer works test-first: failing test, code, passing test, checkpoint, commit with explicit pathspecs on the work branch. Then codex reviews the changed files. A fix agent addresses the **confirmed** findings, and codex re-reviews. This repeats up to `max_fix_rounds` times. After codex PASSes the review, a codex SECURITY pass runs (`codex exec` with `schemas/security.schema.json`; any high/critical finding goes back to the fix loop). `security_schema: "<skill-dir>/schemas/security.schema.json"` is REQUIRED. Then the suite command runs LAST, and a failure feeds back into the fix loop. The implementer reports `base_commit` (HEAD before it started) and any deleted files. Codex reviews the WHOLE change `base_commit..<head pinned at review time>`, with its file list taken from git (never from the agents' reports, which are only cross-checked), and never whole files, so old unrelated defects are not charged to the feature: the change is replayed as uncommitted edits in a throwaway worktree at `base_commit` (`<run_dir>/review-N/wt`, removed afterwards) and the runner reviews it with `--uncommitted`. Keep `run_dir` OUTSIDE the repo so that worktree never nests inside the work tree. A NEEDS_HUMAN verdict that still carries confirmed findings goes into the fix loop like a FAIL. So does one whose ONLY reason is `model_rule_disagreement` (codex's own verdict disagreed with the runner's rule) and that lists findings: those findings go to the fixer (or, in design, the author). Any other NEEDS_HUMAN without confirmed findings is BLOCKED. Returns `PASS`, `FAIL` (rounds exhausted) or `BLOCKED` (an agent hit a blocked command, a refusal, or missing input). The suite must run to completion on that same pinned commit; `known_failures` are EXACT test ids (a list, or one per line) and excuse only a completed run with no non-test failure (coverage, lint, post-test step). The security pass and verify's compliance trace run codex in an isolated checkout of the reviewed commit. The suite, every verify check and the compliance trace must run with HEAD at the reviewed commit and a clean work tree before AND after (prefixes in `clean_ignore` are tolerated); otherwise build is BLOCKED and verify returns `HEAD_MOVED`. The result's `reviewed_sha` is the commit to pass to verify and land.

```
Workflow({ scriptPath: "<skill-dir>/workflows/build.js", args: {
  feature_id, repo, work_branch, spec_path, charge, run_dir, review_runner,
  codex_model, codex_effort, impl_effort, max_fix_rounds, unit_cmd, suite_cmd,
  lock_note, live_budget_min, known_failures, clean_ignore, suite_isolated, isolated_setup,
  security_schema, review_timeout_seconds, base_commit, review_fallback } })
```
When re-running build after land returns `HEAD_MOVED` or `CI_RED`, pass the feature's ORIGINAL `base_commit` (from the first build result) so every commit since then is inside the reviewed range.

## Stage 3: verify (`workflows/verify.js`, mandatory)
Run configured extra checks, then execute the frozen acceptance proof commands on the clean reviewed commit and save a per-ID ledger. Static acceptance uses source evidence; runtime acceptance needs actual command output. Run the final Codex defect review and independent SPEC-COMPLIANCE trace with `schemas/compliance.schema.json`, returning a positive trace for EVERY acceptance ID. Then run `scripts/check-completion.js` against the actual inventory, spec, Git diff and evidence files. Even `checks: []` must run acceptance/compliance/completion. Return `PASS`, `INCOMPLETE`, `FAIL`, `HEAD_MOVED` or `BLOCKED`; PASS includes `verify_result_path` and `completion.proof_path`.

Service boot/connectivity, success/failure/edge cases, side-effect readback, lint and types are required when applicable to the frozen spec. Mark truly inapplicable checks with a reason in the inventory; inability to run an applicable check is incomplete. Live/paid proofs reuse outputs from budgeted configured checks and never run unbudgeted calls in the acceptance phase. Run live batches one at a time and only on a quiet machine when configured.

```
Workflow({ scriptPath: "<skill-dir>/workflows/verify.js", args: {
  feature_id, repo, work_branch, run_dir, review_runner, files, deleted, base_commit, reviewed_sha, clean_ignore,
  spec_path, compliance_schema, checks, codex_model, codex_effort, review_timeout_seconds,
  manifest_path, manifest_sha256, build_result_path, completion_runner, review_fallback } })
```
`base_commit` and `reviewed_sha` are REQUIRED (pass build's values straight through); the final review and the compliance trace cover the whole change `base_commit..reviewed_sha`. `files`/`deleted` are informational and must be repo-relative. A check with no `budget_min > 0` may make no live or paid calls.

## Stage 4: land (`workflows/land.js`)
First re-run the deterministic completion validator with the frozen plan hash and the saved build/verify artifacts. A failed validation blocks before any PR action. Then open the PR from `work_branch` to `trunk_branch` (or reuses an open one), watches CI, re-runs only a clearly flaky failure once, and returns `READY_FOR_HUMAN_MERGE` (only when the PR head is `reviewed_sha`, or later commits touch nothing but `state_paths`), `HEAD_MOVED` (an unreviewed change landed after review: go back to stage 2), `CI_PENDING`, `CI_RED` (go back to stage 2 with the failing log as the charge) or `BLOCKED`. The main session writes the PR body (spec, completion evidence, known baseline failures, verdicts, test counts, and concrete human validation steps) to `body_path` first. **The human merges.** Never merge, never enable auto-merge, never push the trunk.

```
Workflow({ scriptPath: "<skill-dir>/workflows/land.js", args: {
  feature_id, repo, work_branch, trunk_branch, title, body_path, reviewed_sha, state_paths, ci_wait_min, allow_no_ci,
  manifest_path, manifest_sha256, spec_path, build_result_path, verify_result_path, completion_runner, proof_path } })
```
A PR with no checks is `CI_PENDING` (CI may not have registered yet) unless `allow_no_ci: true` says the repo has no CI.

## Completion contract

Set `completion_runner` to the included `scripts/check-completion.js`. Save build's raw result as `build_result_path` before verify. Pass design's unchanged manifest path/hash to verify and land. Pass verify's `verify_result_path` and `completion.proof_path` as land's `verify_result_path` and `proof_path`. Feature IDs use letters, digits and `._-`.

The read-only `--mode plan` preflight validates the frozen manifest/spec before verify executes commands. Completion reads the real files and Git state: exact unique acceptance IDs, PASS evidence for every applicable item, captured output hashes, valid static file/line references, completed suite, separate passing reviews, and the authoritative `base_commit..reviewed_sha` file list against allowed/protected scope. A runtime requirement cannot pass using a source reference alone; a static requirement needs a source reference. Empty, missing, failed or stale evidence blocks completion. Known baseline failures remain explicitly qualified in the proof; they are never described as an entirely green suite.

Capture `suite.log_path/log_sha256`, each configured check's `evidence_path/evidence_sha256`, and each runtime acceptance's `command/exit_code/log_path/log_sha256/head_sha` when the command finishes. Store output outside the target repo. The compliance schema also requires `file/line`; use null for unused runtime/static fields. Hash exact saved bytes, not a summary. Supply only applicable checks to `verify.checks`; keep justified inapplicable checks in the frozen inventory, without dispatching them.

Land revalidates with `--previous-proof`: changing a captured log or build/verify result after verification invalidates the proof. The validator never executes supplied proof commands. It verifies identities, file existence, output integrity and scope; command/exit-code reports still come from the host agents. Hashes cannot authenticate a fabricated run or prove that a source reference semantically satisfies the requirement; independent Codex compliance provides that separate assessment.

State exceptions must be frozen as optional `state_paths` and `clean_ignore` in the manifest, using narrow repo-relative state prefixes. They must not overlap protected paths. Land uses these frozen paths and rejects a differing `state_paths` argument. Allow later state-only commits only when every intervening commit touches those approved paths; a code edit followed by a revert still invalidates readiness. Keep verification on the clean reviewed commit. Prefer outside-repo state; never hide production code, specs, tests or evidence behind a state exception. The human merges; completion certifies the reviewed branch commit, not a future merged state.

## Checkpoints, scope and resume

Keep `execution-ledger.json` in the build run directory with one entry per acceptance ID: status, command, exit code, output path/hash and commit. Write checkpoints atomically after each verified step, preserve failed/interrupted outputs, and record decisions taken without explicit input. These checkpoints are agent obligations; the skill does not provide a background scheduler or guarantee process survival.

After interruption, load the frozen plan, original base SHA and ledger; confirm the orchestrator-selected checkout/branch/environment and run an applicable smoke check. Resume the first unproven item. Retain previous evidence only while its plan identity and tested code remain applicable; always re-run final-commit proofs and checks. A missing required runner, suite, service or evidence is a blocker, never permission to substitute a passing mock harness. Use representative synthetic or approved anonymized data for runtime checks.

For necessary scope expansion, stop before editing the extra paths. Obtain authorization if existing task authorization does not cover the change, amend the spec/inventory, rerun the design review, pin new hashes and rerun affected evidence/reviews. Never silently add allowed paths to make completion pass. Provide a concrete human handoff: what to open or run and the expected behaviour, alongside the proof and PR.

## Assumption the checks rely on
The clean-tree checks compare HEAD and `git status` at the START and END of each test run; they cannot see a checkout that another process swaps and restores mid-run. So **nothing else may write to the work checkout while a stage runs**. Have the orchestrator serialize writers in a shared checkout or choose separate checkouts for concurrent lanes; dedicated feature worktrees are optional. Set `suite_isolated: true` to run the suite in a fresh worktree of the reviewed commit, which removes this assumption for the suite.

## Hard rules (every stage, every repo)
- Reviews are cross-family by default: codex reviews every artifact. A capped codex (usage cap, quota error) is NOT a reason to switch reviewer: the stage returns BLOCKED and you WAIT for the cap to reset.
- The one exception is codex NOT AVAILABLE in the environment (`codex --version` or `node <review_runner> --help` cannot run or exits non-zero). Every codex relay checks this first and reports `codex_available`. Only when it is `false` AND the repo config sets `reviews.review_fallback: opus-high` (passed as the `review_fallback` arg) does Claude Opus 5.5 at high effort run the same review, with the same schema and scope (design: the doc against the PRD; build: the whole change in the throwaway worktree, plus security; verify: final review and compliance trace). That result is stamped `reviewer: "claude-opus-high (codex unavailable)"` and must never be reported as a codex verdict. With `review_fallback: none` (the default), unavailable codex is BLOCKED.
- Every codex relay starts codex with the Bash tool's `run_in_background`, then WAITS IN THE FOREGROUND with repeated bounded foreground poll loops (at most 9 minutes per Bash call) until the result file exists or the time limit passes. A relay that ends its turn while codex runs kills the review.
- Never deploy, run Terraform against real state, publish packages, or touch production resources without the user's explicit yes.
- No `git add -A` or `.`; use explicit pathspecs. Never `git rm` or glob deletes. Delete only literal paths you created. Never `--no-verify`. Scan the diff for secrets before every commit.
- Live or paid test runs need a hard budget from the spec or config, plus a ledger in the run dir.
- If a command is blocked, or the API refuses an agent (a safety-filter refusal), STOP that stage and report. Never route around it with a different wording or tool.
- Agents report test numbers they observed, never estimates. A skipped check is reported as NOT RUN, never as a pass.

## After a workflow returns
Stamp the time on the result (scripts cannot read the clock), write `result.json` into the run dir, update the repo's state (see `state.mode` in config), and tell the user in plain words: what passed, what failed, what is next. Every review result carries `reviewer` (`codex`, or `claude-opus-high (codex unavailable)`; design reports the final one on `prd.reviewer` and `spec.reviewer`). Every stage result also carries `reviewers` (one `{ step, reviewer }` per review round, e.g. `prd review 1`, `review 2`, `security 2`, `final review`, `compliance`) and `fallback_used`. A later codex PASS does not erase an earlier fallback round, so read `reviewers`, not only the final review: if `fallback_used` is true, say so explicitly, name EVERY step the Opus fallback reviewed, and do not call the result cross-family reviewed.

**Where state lives matters for land.** Prefer a `state_dir` OUTSIDE the repo. If the repo keeps state on the work branch (a harness), committing it after build moves the branch past `reviewed_sha`; land then accepts the PR only if every later commit touches nothing but the paths in `state_paths` (repo-relative prefixes, e.g. the state directory), and returns `HEAD_MOVED` otherwise. PR titles may only use letters, digits, spaces and `._,:;()#/+@-`.
