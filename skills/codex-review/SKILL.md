---
name: codex-review
description: Use to get an independent Codex-powered review of an implementation diff, a PRD, or a spec — "codex review this", "review my changes with codex", "codex-review the PRD/spec", or any request for an out-of-family defect review with a PASS/FAIL/NEEDS_HUMAN verdict.
---

# codex-review

Runs `codex exec` against a rubric and returns a strict, schema-validated verdict:
`PASS`, `FAIL`, or `NEEDS_HUMAN`. Any BLOCKING or MAJOR finding is independently
re-checked against the artifact by a second Codex call before it counts toward the
verdict.

## Prerequisites

- Codex CLI installed (`npm i -g @openai/codex`, or `codex.exe` on PATH) and logged in
  (`codex login`). Check with `codex --version` and `codex exec --help`.
- Node.js >= 18. No npm install needed for this skill itself — it uses only Node
  built-ins.
- Git, for an `implementation` review of uncommitted changes.
- Works on macOS, Linux, and Windows.

## Quick start

```
node "<skill-dir>/scripts/run-review.js" --kind implementation --uncommitted --repo <repo> --out-dir <dir outside the repo>

node "<skill-dir>/scripts/run-review.js" --kind prd --files <prd.md> --out-dir <dir>

node "<skill-dir>/scripts/run-review.js" --kind spec --files <spec.md> --against <prd.md> --out-dir <dir>
```

Use the runner's absolute path. Keep `--out-dir` outside the repository being reviewed.

## Flags

| Flag | Meaning |
|---|---|
| `--kind` | `implementation`, `prd`, or `spec` (required) |
| `--out-dir` | where run artifacts and the log go (required) |
| `--uncommitted` | review staged + unstaged diffs and untracked files; `implementation` only |
| `--files <path...>` | review an explicit file list; required for `prd`/`spec` |
| `--repo <dir>` | repo root passed to Codex as `-C` (default: cwd) |
| `--against <path>` | PRD to trace a spec against; `spec` only |
| `--model <slug>` | override the model picked from `codex debug models` |
| `--effort <level>` | reasoning effort (default `high`) |
| `--timeout-seconds <n>` | per-attempt timeout, doubled on one retry (default 300) |
| `--help` | print usage and exit 0 |

`implementation` requires exactly one of `--uncommitted` / `--files`; `prd` and `spec`
require `--files` and reject `--uncommitted`.

codex-review picks the model from the live catalog (`codex debug models`); never
hardcode a model name against it. When `--model` is given, it is checked against the
catalog's slugs only if the catalog loaded (`usage_error` on an unknown slug); if the
catalog is unavailable, `--model` passes straight through to `codex exec` with no
membership check at all.

The review prompt tells Codex it may read any other file in the repository it needs
for context (callers, types, tests, config), but to report findings only about the
change or the files listed in scope, not about other files read only for context.
This scope restriction is enforced by prompt instruction only — like the
REFUTE-same-location rule below, the runner does not cross-check a reported finding's
location against the declared scope or diff.

## Verdict rule

| Kind | FAIL trigger |
|---|---|
| `implementation` | any BLOCKING, or any MAJOR with confidence >= 0.8 |
| `prd` / `spec` | any BLOCKING, any MAJOR whose `iso_property` is one of the six ISO/IEC/IEEE 29148 gaps (ambiguous, unverifiable, missing_acceptance_criteria, inconsistent, infeasible, incomplete), or 3+ MAJOR findings |

A finding counts toward the table above by severity/confidence/`iso_property`/count
alone, over every finding that is not `refuted` — an `unvalidated` finding (validation
did not run, or did not resolve it) still counts toward a MAJOR-count or ISO-property
trigger and can sit in the same trigger set as a `confirmed` one.

Verdict precedence, checked in this order:
1. The trigger set is non-empty and at least one finding in it is `confirmed` → `FAIL`,
   immediately — even if other findings in that same set are still `unvalidated`. Only
   the `confirmed` findings are named in the reasons.
2. Else the trigger set is non-empty and every finding in it is `unvalidated` →
   `NEEDS_HUMAN` (`validation_unavailable`).
3. Else the trigger set is non-empty (a defensive fallback for a validation state not
   covered above; not reachable with the only two statuses a trigger can hold in
   practice, since `refuted` is already excluded from the set) → `NEEDS_HUMAN`.
4. Else no trigger fired, but some non-refuted BLOCKING/MAJOR finding sits at confidence
   0.5-0.8 (below the `implementation` FAIL floor, or just under full confidence for
   `prd`/`spec`) → `NEEDS_HUMAN`.
5. Else the model's own self-reported verdict (always taken from the review call, before
   validation) disagrees with what this same rule computes from the same non-refuted
   findings → `NEEDS_HUMAN` (`model_rule_disagreement`). A `refuted` finding is excluded
   from this comparison exactly as from every step above — it can still surface a
   genuine model/rule disagreement (e.g. the model said FAIL pre-validation and the
   finding it based that on is later refuted), but it can never by itself flip a `PASS`
   the rule would otherwise reach into `NEEDS_HUMAN`.
6. Else `PASS`.

Findings below the FAIL threshold are still reported in `result.json`; a `refuted`
finding is also still reported, marked `refuted`, and never counted at any step above.

Exit codes: `0` PASS, `1` FAIL, `3` NEEDS_HUMAN (`refused`/`timeout`/`invalid_output`/
`codex_error`/`unable_to_review`/`model_rule_disagreement`/etc.), `2` usage, setup, or
scope error (`usage_error`/`scope_error`/`catalog_error`/`codex_not_found`/`runner_error`).

## Output layout

`<out-dir>/<run-id>/` holds, each conditional as noted (never guaranteed as a flat list):

- `review-1.prompt.md` is written once the review attempt is actually reached — after the
  model catalog call and model/effort resolution, and after scope (`--files`/`--against`
  existence, or the `--uncommitted` git calls) has resolved successfully. A run directory
  can exist with none of the `review-*`/`validate-*` files at all: a `catalog_error` (no
  `--model` given and the catalog is unavailable or has no eligible model) or a
  `scope_error` (a missing `--files`/`--against` path, or a failed git call while building
  `--uncommitted` scope) is thrown after `makeRunDir()` but before the first review attempt,
  leaving only `catalog.stdout.txt`/`catalog.stderr.txt` (if the catalog call itself ran)
  and `result.json` in that run directory. `review-1.stdout.txt` / `review-1.stderr.txt` are written once a codex process
  is spawned, including a spawn failure — with one exception: on Windows, resolving which
  codex executable to invoke can itself fail (no `codex.exe`/`codex.cmd` found) before any
  process is spawned, so that attempt's `stdout.txt`/`stderr.txt` are never written and the
  run exits `codex_not_found`. `review-1.out.json` is written by codex itself, not the
  runner, so it can exist on disk even when that attempt's exit code is nonzero or its
  content fails schema validation — the file existing is never proof the attempt was
  accepted. The runner only accepts an attempt as `ok` when it exited 0 and the file is
  non-empty, valid JSON, and matches the review shape; a timeout or a refusal commonly, but
  not necessarily, leaves no `out.json`. `review-2.*` follows the same rules, written only
  if attempt 1 timed out (retried at double timeout) or was refused (retried unchanged).
- `catalog.stdout.txt` / `catalog.stderr.txt`, best-effort (write failures are swallowed).
  Whether these appear on `codex_not_found` is platform-dependent: on Windows, resolving the
  codex executable for the catalog call fails before any process is spawned, so neither file
  is written; on macOS/Linux, the catalog call always assumes `codex` is on PATH and spawns
  it regardless, so a missing codex still produces a failed spawn attempt and both files ARE
  written (empty stdout, the spawn error as stderr) even though the run later exits
  `codex_not_found` once the review call hits the same missing executable.
- `validate-1.*` / `validate-2.*`, under the same per-attempt and retry conditions as
  `review-*`, only when at least one BLOCKING/MAJOR finding needs validation; omitted
  entirely when the review returned none.
- `result.json` (verdict, reasons, findings with their validation status, counts),
  best-effort, written once the run directory exists — an error raised before that
  point (most `usage_error`s, a bad `--out-dir`) leaves no `result.json`.

`<out-dir>/codex-review-log.jsonl` gets one line per run, appended best-effort, as soon
as `--out-dir` itself resolved to a writable directory — even a `usage_error` raised
after that point still gets exactly one line.

## Validation pass

Every BLOCKING/MAJOR finding is sent back to Codex in one batched call, which must
open the artifact itself and CONFIRM or REFUTE each one with a quote. Refuted findings
stay in `result.json`, marked `refuted`, and never count toward the verdict. Before
acting on a BLOCKING finding, re-read its `validation.status` yourself — `confirmed`
only.

A REFUTE is only valid when the evidence is about the same requirement or location the
finding names; evidence about a different part of the artifact never refutes it, and an
unclear reading should CONFIRM rather than REFUTE. This rule is enforced by prompt
instruction only — `validation.schema.json` returns just `id`/`status`/`evidence`, with
no location field for the runner to cross-check against the finding's own location, so
there is nothing for the code (or a fake-suite case) to verify here.

## Timing

Worst case for the two codex calls themselves (review, and validation if triggered) is
2 x (T + 2T) = 6T, T = `--timeout-seconds` (default 300s = up to 1800s). Only a timeout
doubles the next attempt's budget; a refusal retries at the unchanged timeout. On top of
that 6T, every run also pays up to 30s for the model catalog call (`codex debug models`,
made unconditionally whether or not `--model` is given), and an `implementation` review of
`--uncommitted` scope pays up to three further sequential 30s budgets (staged diff,
unstaged diff, untracked file list) while building scope — up to 6T + 120s total in that
case, or 6T + 30s for a `--files`-based review (`prd`, `spec`, or an `implementation`
review of an explicit file list, which makes no git calls). Run this in the background, or
lower `--timeout-seconds`, under any tool with a shorter cap.

## Failure modes

NEEDS_HUMAN, exit `3`:

| Outcome | Meaning |
|---|---|
| `refused` | the final attempt's output matched a refusal pattern, and attempt 1 either also refused (retried unchanged) or timed out (retried at double timeout) |
| `timeout` | the final attempt timed out — attempt 1 may have gotten a real response (a refusal) and only attempt 2 failed to respond in time; `timeout` is reported whenever the last attempt itself timed out, regardless of attempt 1's outcome |
| `invalid_output` | exit 0 but the output file was empty, invalid JSON, or failed schema-shape validation |
| `codex_error` | codex exited non-zero for a reason that is not a timeout and not a recognized refusal |

Setup, scope, or usage error, exit `2`:

| Outcome | Meaning |
|---|---|
| `codex_not_found` | no usable `codex` on PATH (see Prerequisites) |
| `empty_scope` | `--uncommitted` found no staged/unstaged diff and no untracked files |
| `usage_error` | bad or missing CLI arguments: unknown flag, missing `--kind`/`--out-dir`, `--files` given with no paths, wrong `--uncommitted`/`--files` combination for the kind, an unparseable `--timeout-seconds`, or a `--model` not present in a catalog that did load |
| `scope_error` | a `--files`/`--against` path does not exist, or a `git diff` / `git diff --staged` / `git ls-files` call failed while building the `--uncommitted` scope |
| `catalog_error` | no `--model` was given and the live model catalog is unavailable or has no eligible model |
| `runner_error` | any other unexpected exception |

## Tests

```
node tests/run-fake-tests.js --work-dir <scratch dir>   # offline, stubs codex, no network
node tests/run-real-acceptance.js --work-dir <scratch>  # 4 live codex exec runs
```
