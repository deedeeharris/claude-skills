---
name: gated-pipeline
description: Use to take a feature or fix from a raw task to a reviewed PR in ANY repo by running in-session Workflows (not background sessions) — PRD → codex review → spec → codex review → implementation (Opus, medium effort, test-first) → codex review → fix loop → full suite → PR to the integration branch. Trigger on "run the pipeline on X", "build feature X with the gated pipeline", "design/build/verify/land X", or an mm/PM tick that has to move a feature forward.
---

# gated-pipeline

One feature at a time goes through four stages, each a Workflow script in `workflows/`. Claude writes and fixes the code; **codex reviews every artifact** through the global `codex-review` skill (cross-family: Claude never grades Claude). Each repo describes itself in `.claude/pipeline.yaml` (template: `templates/pipeline.yaml`).

Invoking this skill is the user's opt-in to run the Workflow tool for these stages.

## Before any stage
1. Read the repo's `.claude/pipeline.yaml`. If it is missing, copy `templates/pipeline.yaml` there, fill it from the repo (test commands, branches, lock), and show the user the result before running anything.
2. Read the repo's CLAUDE.md. Its rules win over this skill.
3. Pick a run id and a run directory: `<state_dir>/<feature>/<stage>/<run_id>`, where `state_dir` is an ABSOLUTE path OUTSIDE the repo (default `<home>/.pipeline-state/<repo-name>`). Create it. A run dir inside the repo makes the tree dirty and blocks the suite's clean-tree check unless its prefix is in `clean_ignore`.
4. Pass config values to the workflow through `args`. Workflow scripts cannot read files, so the main session reads the config and passes what the stage needs.
5. Every path arg must be ABSOLUTE and use only letters, digits, space and `._/\:+@-` (no `~`, quotes, `$`, backticks). The workflows single-quote paths into shell commands and refuse anything else with BLOCKED. `review_timeout_seconds` (default 1200) is the per-attempt codex timeout; real reviews of a few files take 10+ minutes.

## Stage 1: design (`workflows/design.js`)
Task text → `prd.md` → codex PRD review → revise until PASS → `spec.md` (acceptance checks, each with a proof command and a negative control, plus a live/paid budget when one is needed) → codex spec review (traced against the PRD) → revise until PASS. Returns `PASS`, `FAIL` (still failing after `max_rounds` reviews) or `BLOCKED` (codex error/cap/NEEDS_HUMAN, a refusal, or a blocked command).

```
Workflow({ scriptPath: "<skill-dir>/workflows/design.js", args: {
  feature_id, repo, task, run_dir, review_runner, codex_model, codex_effort,
  review_timeout_seconds, max_rounds, author_effort } })
```

## Stage 2: build (`workflows/build.js`)
An Opus implementer works test-first: failing test, code, passing test, commit with explicit pathspecs on the work branch. Then codex reviews the changed files. A fix agent addresses the **confirmed** findings, and codex re-reviews. This repeats up to `max_fix_rounds` times. After codex PASSes the review, a codex SECURITY pass runs (`codex exec` with `schemas/security.schema.json`; any high/critical finding goes back to the fix loop). Pass `security_schema: "<skill-dir>/schemas/security.schema.json"` to enable it. Then the suite command runs LAST, and a failure feeds back into the fix loop. The implementer reports `base_commit` (HEAD before it started) and any deleted files. Codex reviews the WHOLE change `base_commit..<head pinned at review time>`, with its file list taken from git (never from the agents' reports, which are only cross-checked), and never whole files, so old unrelated defects are not charged to the feature: the change is replayed as uncommitted edits in a throwaway worktree at `base_commit` (`<run_dir>/review-N/wt`, removed afterwards) and the runner reviews it with `--uncommitted`. Keep `run_dir` OUTSIDE the repo so that worktree never nests inside the work tree. A NEEDS_HUMAN verdict that still carries confirmed findings goes into the fix loop like a FAIL. So does one whose ONLY reason is `model_rule_disagreement` (codex's own verdict disagreed with the runner's rule) and that lists findings: those findings go to the fixer (or, in design, the author). Any other NEEDS_HUMAN without confirmed findings is BLOCKED. Returns `PASS`, `FAIL` (rounds exhausted) or `BLOCKED` (an agent hit a blocked command, a refusal, or missing input). The suite must run to completion on that same pinned commit; `known_failures` are EXACT test ids (a list, or one per line) and excuse only a completed run with no non-test failure (coverage, lint, post-test step). The security pass and verify's compliance trace run codex in an isolated checkout of the reviewed commit. The suite, every verify check and the compliance trace must run with HEAD at the reviewed commit and a clean work tree before AND after (prefixes in `clean_ignore` are tolerated); otherwise build is BLOCKED and verify returns `HEAD_MOVED`. The result's `reviewed_sha` is the commit to pass to verify and land.

```
Workflow({ scriptPath: "<skill-dir>/workflows/build.js", args: {
  feature_id, repo, work_branch, spec_path, charge, run_dir, review_runner,
  codex_model, codex_effort, impl_effort, max_fix_rounds, unit_cmd, suite_cmd,
  lock_note, live_budget_min, known_failures, clean_ignore, suite_isolated, isolated_setup,
  security_schema, review_timeout_seconds, base_commit } })
```
When re-running build after land returns `HEAD_MOVED` or `CI_RED`, pass the feature's ORIGINAL `base_commit` (from the first build result) so every commit since then is inside the reviewed range.

## Stage 3: verify (`workflows/verify.js`, optional per feature)
Runs the repo's extra checks from config: visual QA, live or paid test batches each with a hard minute cap, a works-locally smoke test. Then a final codex defect review of the whole change, and a codex SPEC-COMPLIANCE trace (`codex exec` with `schemas/compliance.schema.json`) that maps every spec requirement to code and a test. Returns `PASS`, `INCOMPLETE` (a check FAILed or was NOT_RUN), `FAIL`, `HEAD_MOVED` (the branch is no longer at `reviewed_sha`: re-run build) or `BLOCKED`. Run live batches one at a time and only on a quiet machine when the config says so.

```
Workflow({ scriptPath: "<skill-dir>/workflows/verify.js", args: {
  feature_id, repo, work_branch, run_dir, review_runner, files, deleted, base_commit, reviewed_sha, clean_ignore,
  spec_path, compliance_schema, checks, codex_model, codex_effort, review_timeout_seconds } })
```
`base_commit` and `reviewed_sha` are REQUIRED (pass build's values straight through); the final review and the compliance trace cover the whole change `base_commit..reviewed_sha`. `files`/`deleted` are informational and must be repo-relative. A check with no `budget_min > 0` may make no live or paid calls.

## Stage 4: land (`workflows/land.js`)
Opens the PR from `work_branch` to `trunk_branch` (or reuses an open one), watches CI, re-runs only a clearly flaky failure once, and returns `READY_FOR_HUMAN_MERGE` (only when the PR head is `reviewed_sha`, or later commits touch nothing but `state_paths`), `HEAD_MOVED` (an unreviewed change landed after review: go back to stage 2), `CI_PENDING`, `CI_RED` (go back to stage 2 with the failing log as the charge) or `BLOCKED`. The main session writes the PR body (spec, verdicts, test counts) to `body_path` first. **The human merges.** Never merge, never enable auto-merge, never push the trunk.

```
Workflow({ scriptPath: "<skill-dir>/workflows/land.js", args: {
  feature_id, repo, work_branch, trunk_branch, title, body_path, reviewed_sha, state_paths, ci_wait_min, allow_no_ci } })
```
A PR with no checks is `CI_PENDING` (CI may not have registered yet) unless `allow_no_ci: true` says the repo has no CI.

## Assumption the checks rely on
The clean-tree checks compare HEAD and `git status` at the START and END of each test run; they cannot see a checkout that another process swaps and restores mid-run. So **nothing else may write to the work checkout while a stage runs** (one feature per worktree; parallel lanes in their own worktrees). Set `suite_isolated: true` to run the suite in a fresh worktree of the reviewed commit, which removes this assumption for the suite.

## Hard rules (every stage, every repo)
- Reviews are cross-family: codex first; if codex is capped, use the fallback in config (for example agy); if every option is capped, WAIT. Never a Claude review of Claude-built code.
- Never deploy, run Terraform against real state, publish packages, or touch production resources without the user's explicit yes.
- No `git add -A` or `.`; use explicit pathspecs. Never `git rm` or glob deletes. Delete only literal paths you created. Never `--no-verify`. Scan the diff for secrets before every commit.
- Live or paid test runs need a hard budget from the spec or config, plus a ledger in the run dir.
- If a command is blocked, or the API refuses an agent (a safety-filter refusal), STOP that stage and report. Never route around it with a different wording or tool.
- Agents report test numbers they observed, never estimates. A skipped check is reported as NOT RUN, never as a pass.

## After a workflow returns
Stamp the time on the result (scripts cannot read the clock), write `result.json` into the run dir, update the repo's state (see `state.mode` in config), and tell the user in plain words: what passed, what failed, what is next.

**Where state lives matters for land.** Prefer a `state_dir` OUTSIDE the repo. If the repo keeps state on the work branch (a harness), committing it after build moves the branch past `reviewed_sha`; land then accepts the PR only if every later commit touches nothing but the paths in `state_paths` (repo-relative prefixes, e.g. the state directory), and returns `HEAD_MOVED` otherwise. PR titles may only use letters, digits, spaces and `._,:;()#/+@-`.
