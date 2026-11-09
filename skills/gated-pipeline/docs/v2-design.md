# gated-pipeline v2: one canonical feature file

Design contract for issue #54. Everything here is normative for the v2 implementation; the
tests and the SKILL.md describe the same contract. v1 (`prd.md` + `spec.md` + hand-written
`execution-plan.json`, manifest `version: 1`) keeps its own path in every stage and in the
validator (section 6.1).

## 1. Authority

- A feature has exactly ONE editable design artifact: the canonical feature file
  `<repo>/<features_dir>/<feature_id>.feature.json`. `features_dir` defaults to
  `.pipeline/features` and is set by `design.features_dir` in `.claude/pipeline.yaml`; it must
  pass the repo-relative path rules of section 3 (`E_UNSAFE_PATH`) and may not be or lie under
  `.git/`. It holds the source request, the product (PRD) content, the technical (spec)
  content, the acceptance scenarios, the frozen verification configuration (suite, checks,
  limits) and the scope.
- Everything else is derived by `scripts/compile-feature.js`, deterministically, into a
  directory OUTSIDE the repo: `execution-plan.json` (manifest v2), `prd.view.md`,
  `spec.view.md`, `compile-identity.json`. Views carry a `GENERATED - DO NOT EDIT` banner and
  are never an input to anything except a reviewer; every certifying check compares them
  byte for byte with a recompile of the source (section 6.2), so an edited view is drift.
- No model authors a manifest, a hash, a view or a ledger. Models author the canonical file;
  scripts derive and write the rest and return the authoritative exit codes.
- Under `contract: 2`, every command that runs or excuses verification (suite, setup, focused
  tests, known failures, checks, budgets, timeouts) comes from the canonical file only; the
  stage arguments that used to carry them are BLOCKED (section 6.1).
- Byte authority: the committed blob (`git cat-file blob <commit>:<path>`, no filters) is the
  authoritative source; every hash is over raw bytes (`Buffer`), never decoded text. The
  working-tree file must equal that blob byte for byte and be clean wherever a stage reads it.
  Repos that convert line endings need `<features_dir>/*.feature.json -text` in
  `.gitattributes`; SKILL.md documents it, and a CRLF or hook-rewritten file is BLOCKED, never
  re-hashed.
- Format: strict JSON (zero dependencies). Long prose lives in strings. Humans read the
  generated Markdown views.

## 2. Canonical file (schema_version 2)

Schema: `schemas/feature.schema.json`, JSON Schema 2020-12. The bundled validator
(`scripts/lib/schema-lite.js`) implements a fixed keyword subset with exactly the 2020-12
semantics (`pattern` is an unanchored ECMA-262 match, so the schema writes `^...$`;
`type: integer` accepts `1.0`); any other keyword in the schema is a setup error (exit 2), so
the contract cannot silently loosen. A vendored copy of the official JSON-Schema-Test-Suite
proves the subset conforms (plan WP1). Every object has `additionalProperties: false`.

```
schema_version: 2                      const
feature_id:     ^[A-Za-z0-9._-]+$
title:          string
source_request: { text } | { ref, sha256, summary }     exactly one form
    text   = the original task, verbatim
    ref    = a non-public location label (never a secret), sha256 = SHA-256 of the exact
             request bytes, summary = what it asks (for confidential requests)
coverage: [ { id: SRC-NNN, excerpt, disposition: covered|excluded,
              requirement_ids[] (covered: >=1), rationale (excluded: required) } ]  minItems 1
product: {
  problem, actors[] (>=1),
  goals[]     { id: GOAL-NNN, statement, source_ids[] (>=1, covered SRC ids),
                status: active|retired, retired_rationale (retired: required) }   minItems 1
  non_goals[] { id: NG-NNN, statement, rationale }
  constraints[] string, risks[] string, success_metrics[] string (>=1)
}
architecture: {
  approach,
  decisions[]  { id: DEC-NNN, decision, rationale }
  invariants[] { id: INV-NNN, statement }
  components[] { id: COMP-<NAME>, name, description, owned_paths[] (>=1), exclusive: bool }
  security: { data_exposure, input_validation, resource_consumption,
              accepted_risks[] { id: RISK-NNN, statement, cites[] } }
}
requirements[] (minItems 1) {
  id: <PREFIX>-NNN  (e.g. AUTH-001; PREFIX = [A-Z][A-Z0-9]*, not GOAL/NG/DEC/INV/SRC/RISK/CHECK/COMP)
  status: active|retired, retired_rationale (retired: required)
  goal_ids[] (active: >=1), statement, priority: P0|P1|P2,
  depends_on[] requirement ids, component_ids[] (active: >=1)
  derived_rationale  (required when no covered SRC lists this active requirement)
  acceptance[] (active requirement: >=1 active) {
    id: <REQ-ID>-ACn, status: active|retired, retired_rationale (retired: required),
    given, when, then,
    verification: {
      kind: runtime|static,
      command   (runtime: required, nonempty single line; static: must be absent)
      expected  { exit_code: 0 }               (runtime: required; const 0)
      evidence  { paths[] (>=1), description } (static: required)
    }
    negative_control: {
      method: isolated_mutation|exempt,        (static: must be exempt)
      description          (always),
      mutation             (isolated_mutation: what to break, in prose),
      exemption_reason     (exempt: required),
      alternate_evidence   { paths[] (>=1), description }  (required when every active
                                                            acceptance of a P0 requirement is exempt)
    }
  }
}
scope: { allowed_paths[] (>=1), protected_paths[], state_paths[], clean_ignore[],
         test_paths[] (>=1 when any isolated_mutation exists) }
suite: { command (single line), unit_command (single line),
         known_failures[] { test_id, reason }, isolated: bool,
         setup_command (single line) | null, timeout_min: int >= 1, live_budget_min: int >= 0 }
limits: { proof_timeout_s: int 1..3600, negative_controls_total_min: int >= 1 }
checks[] {
  id: CHECK-<NAME>, name, applicable: bool, reason (always),
  command (applicable: required, single line), expected { exit_code: 0 } (applicable: required),
  timeout_min: int >= 1 (applicable: required), budget_min: int 0..timeout_min,
  quiet: bool, effort: low|medium|high, environment: string
}
test_plan: string
```

Every string value is free of U+0000-U+001F except TAB and LF, of U+007F-U+009F and of
U+2028/U+2029 (`E_CONTROL_CHAR`), so no string carries a CR or another line terminator into a
view. There is no free-prose `procedure` check: a manual check is `applicable: false` with its
reason, and a nonzero expected exit code does not exist (a proof that "expects failure" would
certify a missing test file). `budget_min` is the cap on live or paid usage; `timeout_min` is
the hard wall-clock kill (section 6.4).

Repo-level, non-certifying configuration stays in `.claude/pipeline.yaml` and stage args:
`lock_note` (advisory prompt text), `scan_log`/`require_scan_row` (an extra compliance
requirement) and land's `allow_no_ci`. They run no command and excuse no failure; the v2 proof
records them as `repo_config` and land's result adds `allow_no_ci` (section 6.5).

## 3. Deterministic gates (scripts/validate-feature.js)

`node validate-feature.js --file <feature.json> --repo-path <repo-relative path of the file> [--schema <feature.schema.json>] [--source-request <file>] [--previous <feature.json>]`

`--repo-path` is required; `features_dir` is its dirname and its basename must be
`<feature_id>.feature.json` (`E_SCOPE`). Prints one JSON object:
`{ valid, validator_version, schema_version, source_sha256, errors: [ { code, path, id, message } ] }`.
Exit 0 valid, 1 invalid, 2 usage/setup error. It never executes, evaluates or shells out any
string from the file (proof commands are data).

1. Parse (`scripts/lib/strict-json.js`): bytes decoded with `new TextDecoder('utf-8', { fatal: true })`
   (invalid UTF-8 is `E_PARSE`, never U+FFFD), no BOM, RFC 8259 grammar only, DUPLICATE KEYS
   REJECTED (`E_DUP_KEY` with path), no `__proto__`/`constructor`/`prototype` keys.
   Error codes: `E_PARSE`, `E_DUP_KEY`, `E_FORBIDDEN_KEY`.
2. Version: `schema_version` must be 2 (`E_SCHEMA_VERSION`) before anything else is reported.
3. Schema (`scripts/lib/schema-lite.js`): `E_UNKNOWN_FIELD`, `E_TYPE`, `E_REQUIRED`, `E_ENUM`,
   `E_CONST`, `E_PATTERN`, `E_MIN_ITEMS`, `E_MIN_LENGTH`, `E_MINIMUM`, `E_MAXIMUM`.
4. Graph/cross-field (`scripts/lib/feature-graph.js`):
   - `E_DUP_ID` any ID repeated across the whole file (goals, requirements, acceptance, checks...).
   - `E_ID_FORMAT` acceptance id not prefixed by its requirement id.
   - `E_SHADOW_ID` an ID or title segment like `-fix`, `-v2`, `-final`, `-new`, `-addendum`,
     `-patch`, `-rev<n>` (patch accumulation).
   - `E_DUP_STATEMENT` two requirements whose normalized statements (lowercase, collapsed
     whitespace, stripped punctuation) are identical. (Paraphrased duplicates are a review job.)
   - `E_REF` dangling goal/requirement/component/acceptance/source reference.
   - `E_CYCLE` `depends_on` cycle (message gives the cycle path); `depends_on` on a retired
     requirement is `E_REF`.
   - `E_COVERAGE` an active goal with no active requirement; an active goal whose `source_ids`
     name no covered SRC; an active requirement with no active acceptance; a covered SRC with
     no requirement; an active requirement that no covered SRC lists and that has no
     `derived_rationale`; an excluded SRC with no rationale.
   - `E_PROOF` runtime without command/expected, static without evidence, multi-line command
     (acceptance, check, suite, unit or setup command), command present on static.
   - `E_NEGATIVE_CONTROL` missing mutation/exemption reason; a static acceptance that is not
     `exempt`; a P0 requirement whose every active acceptance is `exempt` without
     `alternate_evidence`; an `isolated_mutation` with empty `scope.test_paths`; an
     `isolated_mutation` whose command equals the command of an applicable check with
     `budget_min > 0` (a live or paid proof is exempt, with its reason).
   - `E_REASON_MISSING` check with empty reason; applicable check without command, expected or
     `timeout_min`; known failure without reason.
   - `E_LIMIT` a check's `budget_min` above its `timeout_min`.
   - `E_CONTROL_CHAR` a string value holding a character section 2 forbids.
   - `E_UNSAFE_PATH` absolute path, `..` segment, backslash, `~`, control chars, or characters
     outside `[A-Za-z0-9._/ +@-]` in any scope/owned/evidence path.
   - `E_PROTECTED_OVERLAP` an allowed, state, clean_ignore, test or owned path equal to, inside,
     or containing a protected path, where protected = `scope.protected_paths` plus the
     `<features_dir>/` prefix.
   - `E_OWNERSHIP` two `exclusive` components owning overlapping paths; an owned path outside
     allowed_paths; a test path equal to, inside or containing an owned path (tests live
     outside the code a mutation may touch).
   - `E_SCOPE` `--repo-path` basename/feature_id mismatch, or `features_dir` unsafe or under
     `.git/`.
   - `E_MIGRATION_TODO` the literal `MIGRATION-TODO` anywhere (section 8).
5. `--source-request <file>`: `source_request.text` must equal the file text (trailing newline
   normalized) or `source_request.sha256` must equal SHA-256 of its bytes. `E_SOURCE_MISMATCH`.
   The design stage always passes it.
6. `--previous <file>` (the previous revision, parsed the same way): every SRC, GOAL,
   requirement, acceptance and check id of the previous file is still present
   (`E_ID_REMOVED`; removal is `status: retired` with its rationale, `disposition: excluded`,
   or `applicable: false`), and nothing retired there is active here (`E_ID_REACTIVATED`).
   Section 5 passes it on every revision.

Diagnostics are sorted (path, code) so output is deterministic.

## 4. Compiler (scripts/compile-feature.js)

`node compile-feature.js --file <feature.json> --repo <abs repo> --repo-path <rel> --out <dir>`
`node compile-feature.js --file <feature.json> --repo <abs repo> --repo-path <rel> --check <dir>`  (drift check)

- `--repo` is used only for containment (realpath), never for git writes; `--file` may be a
  snapshot outside it. Runs the full validator first; invalid -> exit 1, writes nothing.
- `--out` must not exist and must lie outside `realpath(--repo)` (else exit 2). Output is
  written into `<out>.tmp-<pid>-<rand>` and renamed to `<out>` only after every file is written
  and fsynced, so an interrupted compile never leaves a valid-looking directory at `<out>`.
  Writes, with LF newlines, UTF-8, 2-space JSON, keys in schema order (one explicit field list
  per object, never source order), arrays in source order, no timestamps:
  - `execution-plan.json` (manifest v2; shape also in `schemas/execution-plan.v2.schema.json`):
    ```
    { version: 2, feature_id, schema_version: 2, compiler_version,
      source: { path: <repo-path>, sha256: <raw source bytes> },
      spec_sha256: <same as source.sha256, kept for the v1 completion code paths>,
      allowed_paths, protected_paths (source protected_paths + "<features_dir>/"),
      state_paths, clean_ignore, test_paths,
      components: [ { id, owned_paths } ],
      requirements: [ { id: <acceptance id>, requirement_id, component_ids, kind, proof_command,
                        expected, negative_control: { method, description, mutation|exemption_reason } } ],
      suite: { command, unit_command, known_failures: [ { test_id, reason } ], isolated,
               setup_command, timeout_min, live_budget_min },
      limits: { proof_timeout_s, negative_controls_total_min },
      checks: [ { id, name, applicable, reason, command, expected, timeout_min, budget_min, quiet, effort, environment } ],
      views: { prd_projection_sha256, prd_view_sha256, spec_view_sha256 } }
    ```
    `proof_command` is `""` for static. Retired requirements and retired acceptances are
    omitted from `requirements`.
  - PRD projection: the canonical JSON (keys sorted, no whitespace) of exactly these fields:
    `source_request`, `coverage`, `product` (goals with `source_ids` and `status`),
    `architecture.invariants`, `architecture.security.accepted_risks`, and per requirement
    `id, status, retired_rationale, goal_ids, statement, priority, depends_on,
    derived_rationale` and per acceptance `id, status, retired_rationale, given, when, then,
    verification.kind`. `prd_projection_sha256` is its SHA-256. Excluded on purpose: commands,
    evidence paths and negative controls (how a behaviour is proven, judged by the spec gate,
    including every exemption), components, decisions, scope, suite, limits and checks.
  - `prd.view.md` renders exactly the projection; `spec.view.md` renders everything else plus
    requirement ids. Every string is rendered as a blockquote (each line prefixed `> `) with
    ``\ ` * _ # [ ] < > |`` backslash-escaped, so no string can forge a heading, list item or
    table row (strings hold no CR, section 2).
  - `compile-identity.json`: `{ compiler_version, schema_version, feature_id, source_path,
    source_sha256, prd_projection_sha256, files: { <name>: sha256 } }` for the three files above.
- No self-referential hashes: the source hash is of the raw canonical bytes; the manifest
  embeds it; the identity file hashes the outputs; nothing hashes a file containing its own hash.
- `--check <dir>`: recompiles in memory and compares all four files byte for byte, and that
  the directory holds no other file; exit 1 with `E_DRIFT` naming each differing file. A
  hand-edited view or manifest is never treated as authority.
- Same source bytes + same compiler version -> byte-identical output, whatever the input's
  absolute path, cwd, TZ or locale. Reordering keys in the source changes `source.sha256`
  (raw-bytes policy) but not the manifest/view bodies.

## 5. Approval identity (design stage)

- Deterministic steps: every deterministic step a v2 prompt prescribes is one fenced
  ` ```gp-exec ` block that the agent runs verbatim with Bash, reporting stdout and exit code.
  Records and ledgers the workflow composes are written by
  `scripts/write-json.js --out <file>` from a quoted heredoc (`<<'GP_JSON'`; strict parse,
  atomic write, refuses an existing file, prints `{ path, sha256 }`), never by an agent's
  editor. Workflow-composed JSON is single-line, so the delimiter cannot occur in it.
- Source request: before the first draft, `scripts/hash-inputs.js --out <run_dir>/source-request.inputs.json <run_dir>/source-request.txt`
  pins `source_request_sha256`. Every validate step passes `--source-request`.
- Revision snapshots: `scripts/feature-snapshot.js --repo <abs> --from <working file> --repo-path <rel> --rev-dir <run_dir>/rev-k --source-request <file> [--previous <run_dir>/rev-(k-1)/feature.json]`
  copies the bytes to `rev-k/feature.json`, validates them (with `--previous`), compiles into
  `rev-k/out/` and prints `{ source_sha256, prd_projection_sha256, spec_view_sha256, manifest_sha256 }`.
  `rev-0/feature.json` is the canonical file's blob at `start_head` when it exists (6.2), so ID
  continuity also holds across design runs (6.7). Reviewers read only rev-k files.
- One command chain per review, so no reviewer starts on an invalid or drifted revision
  whatever the relay reports: `validate-feature.js --file rev-k/feature.json ... --previous rev-(k-1)/feature.json && compile-feature.js ... --check <rev-k/out> && <review>`,
  where `<review>` is `run-review.js` or, for the fallback, `hash-inputs.js --out`.
- Review inputs are hashed by a script, never by the reviewer: codex-review's `run-review.js`
  writes `inputs: [ { role: files|against, path, sha256 } ]` into `result.json` (computed from
  the bytes it passes to codex; a change before the run ends is a setup error, exit 2). The Opus
  fallback runs `hash-inputs.js --out <review_dir>/inputs.json <files...>` before reviewing and
  `hash-inputs.js --verify <review_dir>/inputs.json` after, and the workflow has its structured
  reply written verbatim by `write-json.js` to `<review_dir>/fallback-review.json`. These files
  are script-written but agent-invoked, and the report says so.
- PRD review input: `rev-k/out/prd.view.md`, `--against <run_dir>/source-request.txt`
  (codex-review accepts `--against` for `prd`). Spec review input: `rev-k/out/spec.view.md` +
  `rev-k/out/execution-plan.json`, `--against rev-k/out/prd.view.md`.
- Approval ledger `<run_dir>/approvals.json`, written by `write-json.js` after every review:
  `{ run_dir, start_head, source_request_path, source_request_sha256, records: [ { gate, round,
  rev, rev_dir, verdict, reviewer, review_dir, result_path | inputs_path + fallback_review_path +
  fallback_review_sha256, source_sha256, prd_projection_sha256, spec_view_sha256,
  manifest_sha256, source_request_sha256, schema_version, compiler_version } ] }`. The workflow
  computes each verdict with the section 9 rule.
- `check-completion.js --mode approvals --repo <abs> --approvals <file> --source <run_dir>/rev-k/feature.json`
  (read-only, no git; every path absolute and outside `realpath(--repo)`; `--source` must be a
  rev snapshot named by a ledger record) re-derives every record: rev-k bytes hash to
  `source_sha256`; recompiling rev-k reproduces the view/manifest/projection hashes; the
  review's recorded input hashes equal the rev-k files; the PRD review's recorded `against`
  input is `source_request_path`, which hashes to the ledger's, every record's and
  `source-request.inputs.json`'s `source_request_sha256`, and F passes the validator's
  `--source-request` rule against it; a codex record's verdict equals its `result.json` verdict
  and the section 9 recomputation from its findings and `model_verdict`; a fallback record's
  `fallback-review.json` hashes to the recorded value and the section 9 recomputation from it
  (`scripts/lib/gate-rule.js`) gives the recorded verdict; consecutive snapshots rev-0 ... F
  pass the `--previous` rule. It then applies the freeze rule and prints
  `{ approvals_sha256, records: [ { gate, round, rev, verdict } ], rule }`; the workflow
  requires the echoed records to equal its in-memory ledger. In the same `gp-exec` block, before
  the commit, the design agent runs `cmp` between `--source` and the working file. Binding to
  the committed bytes is `--mode design`'s job (F = blob).
- Freeze rule, for the final bytes F: the LATEST spec review in ledger order is a PASS on a
  revision whose bytes equal F; and the LATEST PRD review in ledger order is a PASS, its
  `prd_projection_sha256` equals F's projection and its `source_request_sha256` is the pinned
  one. Any later PRD non-PASS, on any projection, voids an earlier PRD PASS. The workflow reruns
  the PRD review whenever F's projection differs from the projection of the latest PRD review,
  before the spec review continues. The output names the rule that carried the PRD approval
  (`same-revision` or `unchanged-prd-projection`). A PASS for revision A is never combined
  with a PASS for revision B otherwise.
- Revisions follow the reconciliation rules (section 7). After every edit: snapshot (validate,
  compile), and only then review.

## 6. Stage integration

### 6.1 Contract selection
Every stage takes `contract: 1|2` (absent = 1). `contract: 1` is today's behaviour, unchanged,
including v1 design (`task`, `prd.md`, `spec.md`). `contract: 2` requires the v2 args below;
mixing (`contract: 2` with `task` or `charge`, `contract: 1` with a v2 manifest) is BLOCKED.
Under `contract: 2` these args are BLOCKED before any agent in every stage that accepts them:
`checks`, `clean_ignore`, `state_paths`, `suite_cmd`, `unit_cmd`, `known_failures`,
`isolated_setup`, `suite_isolated`, `live_budget_min`; the manifest is their only source.
Nothing upgrades a v1 plan silently: `--mode plan|completion` on a v2 manifest without
`--approvals` fails, and a v1 manifest under `contract: 2` fails.

Resume: a gated stage is never resumed with the Workflow runtime's `resumeFromRunId` (its
cached agent replies would replay stale preflight, check and review results); SKILL.md forbids
it. An interrupted stage is rerun as a new Workflow call with a fresh `run_dir`, from the
persisted result of the previous stage (design: 6.2 recovery). Every stage run uses a fresh
`run_dir`. Certifying scripts re-derive identity live, so a replay that slips through still
BLOCKS at completion.

### 6.2 design (contract 2)
Args: `work_branch`, `source_request_path` (outside the repo; copied to
`<run_dir>/source-request.txt`), optional `seed_feature_path`, `features_dir`, optional
`recover: true`. At start a `gp-exec` block writes `<run_dir>/start-head.json`
(`{ start_head }`, the work_branch HEAD) and saves `<start_head>:<path>`, when it exists, as
`rev-0/feature.json`. The stage authors the canonical file in the checkout, loops per section 5,
runs `--mode approvals` on the last snapshot (plus `cmp` with the working file), then commits
exactly that path: `git add -- <path> && git commit --only -m <msg> -- <path>` (other staged
files stay staged and uncommitted; hooks run, and a hook that rewrites the file is caught
below). It saves the committed blob (`git cat-file blob <design_commit>:<path>`) to
`<run_dir>/frozen-source.feature.json`, compiles it into `<run_dir>/frozen/`, and runs
`--mode design` (below) with `--expect-parent <start_head>` (design only: `design_commit^`
must equal it, a compare-and-swap that BLOCKS a second writer that moved the branch). Freeze
happens only on its exit 0 and when its echoed approval records equal the ledger. Returns
`feature_path`, `feature_repo_path`, `design_commit`, `source_sha256`, `prd_projection_sha256`,
`frozen_dir`, `manifest_path` (`<frozen_dir>/execution-plan.json`), `manifest_sha256`,
`prd_view_path`, `spec_view_path`, `approvals_path`, `approvals_sha256`, `approval_rule`.

Recovery (`recover: true`, same `run_dir`, for a run that died after the commit and before
freeze): no authoring or review. It needs `start-head.json` and the ledger, work_branch HEAD
with exactly one parent equal to `start_head`, a HEAD commit that touches only the canonical
path, and that path's blob equal to the last approved snapshot. It then runs the blob save, the
compile (`--check` instead when `<run_dir>/frozen/` already exists) and `--mode design`
exactly as above. Anything else is BLOCKED. The workflow never resets, amends or stacks a
second design commit; the human reverts the design commit and reruns design.

`check-completion.js --mode design --repo --feature-id --frozen-dir <dir> --manifest-sha256 --spec <canonical file> --commit <design_commit> --approvals <file> --approvals-sha256 <hex> [--expect-parent <sha>] [--out <file>]`:
read-only; `<frozen-dir>/execution-plan.json` hashes to `--manifest-sha256`; the blob
`<commit>:<source.path>` (read as a Buffer) hashes to `source.sha256`; `--spec` equals
`realpath(<repo>/<source.path>)` (the only in-repo path `outside()` admits, and only for a v2
manifest), its bytes equal the blob and `git status` shows it clean; the `compile --check`
comparison of the blob against `--frozen-dir` passes for all four files (`E_DRIFT`); versions
match; `git diff-tree --root --no-commit-id --no-renames --name-only -r -z <commit>` is exactly
`[source.path]` and `git rev-list --parents -n 1 <commit>` shows one parent; the ledger's
`rev-0` snapshot, when present, equals the blob `<commit>^:<source.path>`; and the approvals
check passes with F = the blob. `--out` writes this output, including
`design_paths: [source.path]`, as the preflight record.

### 6.3 build
- `contract: 2` (design-gated) needs `frozen_dir`, `manifest_path`, `manifest_sha256`,
  `spec_path` (canonical file), `design_commit`, `approvals_path`, `approvals_sha256`, and
  `base_commit` equal to `design_commit` (BLOCKED otherwise, before any agent). Before the
  implementer, a preflight runs `--mode design --commit <design_commit> --out
  <run_dir>/design-preflight.json` and checks `git merge-base --is-ancestor <design_commit>
  HEAD`; any failure is BLOCKED. `clean_ignore`, `suite.unit_command`,
  `suite.live_budget_min` and the known-failure ids come from the preflight output (the
  manifest). The suite runs through `run-frozen.js --target suite` (6.4), in a fresh worktree
  after `--target setup` when `suite.isolated`. Result carries `build_mode: "v2"`,
  `plan_identity { design_commit, source_sha256, manifest_sha256, approvals_sha256,
  preflight_path, preflight_sha256 }` and `suite_identity { command, known_failure_ids,
  isolated, setup_command, timeout_min, record_path, record_sha256 }`.
- `contract: 1` with `spec_path`: today's behaviour, stamped `build_mode: "v1"`.
- `contract: 1` with only `charge`: the explicit `charge-only` mode, stamped
  `build_mode: "charge-only"`. Completion (v1 and v2) rejects a `charge-only` build result;
  results without `build_mode` (written before this change) keep the v1 rules.

### 6.4 verify (contract 2)
- Args additionally need `frozen_dir`, `design_commit`, `approvals_path`, `approvals_sha256`
  (forbidden args: 6.1).
- Plan preflight `--mode plan` (v2; also takes `--frozen-dir --commit <design_commit>
  --approvals --approvals-sha256`) fails when any proof, check, suite, unit or setup command
  contains `realpath(--repo)` or the `--repo` spelling, and returns `manifest_version` and, per
  applicable check, `id, name, quiet, effort, budget_min, timeout_min`; the workflow BLOCKS
  unless version is 2 and every id matches `CHECK-<NAME>`. That relayed list only labels
  agents, sets the quiet wait and names budgets; it never carries a command.
- `scripts/run-frozen.js --repo <abs> --frozen-dir <dir> --manifest-sha256 <h> --reviewed-sha <sha> --target check:<ID>|proof:<ACC-ID>|suite|setup|negative:<ACC-ID> --out-dir <dir> [--patch <file>] [--ledger <file>]`
  is the only way a v2 stage executes a frozen command. It re-hashes the manifest; checks that
  the checkout (the repo, or the fresh worktree it creates for isolated suites and negative
  controls) is at `reviewed_sha` and clean before and after; runs exactly the manifest's command
  with `/bin/sh -c` in its own process group, cwd = that checkout, under the manifest limit
  (check/suite `timeout_min`, proofs `limits.proof_timeout_s`): SIGTERM to the group at the
  limit, SIGKILL 10 s later; and refuses a command containing the repo's absolute path. It
  writes the full log and `<out-dir>/<target>.record.json` `{ target, command, cwd, head_before,
  head_after, status_before, status_after, timeout_s, budget_min, elapsed_s, exit_code, signal,
  timed_out, log_path, log_sha256 }`, prints `{ record_path, record_sha256, exit_code }`, and
  for `proof:` appends the record to the acceptance ledger (atomic rewrite). It never takes a
  command string.
- Checks: each check agent waits for a quiet machine when `quiet`, then runs
  `run-frozen.js --target check:<ID>`; evidence paths use the check `id`; the agent reports
  `record_path`, `record_sha256`, `minutes_used` and the pinned-state fields. Acceptance proofs
  run as `--target proof:<id>` for every runtime acceptance.
- Negative-control phase: runs LAST, after checks, acceptance proofs, final review and the
  compliance trace are captured and hashed. Per `isolated_mutation` acceptance the agent writes
  a patch from the frozen `mutation` prose to `<run_dir>/negative/<id>/mutation.patch` and runs
  `run-frozen.js --target negative:<id> --patch <file>`, which creates a throwaway worktree of
  `reviewed_sha` at `<run_dir>/negative/<id>/wt`, runs `suite.setup_command` if set, runs the
  unmodified proof (baseline), derives `mutated_paths` from the patch's `diff --git` headers
  (rejecting renames, deletions, mode changes and binary hunks), applies it after
  `git apply --check`, runs the proof again, and removes the worktree. Each run is bounded by
  `limits.proof_timeout_s`; a run that would start after `limits.negative_controls_total_min`
  of phase time is NOT RUN. The record adds `{ id, setup, baseline_exit_code,
  baseline_log_path, baseline_log_sha256, baseline_timed_out, mutation_patch_path,
  mutation_patch_sha256, mutated_paths, phase_elapsed_s }`. Then the pinned-state check and
  `git status` on the work checkout run again.

### 6.5 check-completion v2 (manifest `version: 2`)
Inputs add `--frozen-dir`, `--approvals`, `--approvals-sha256` and, from land, `--trunk-ref`.
All v1 checks, plus:
- identity: everything `--mode design` checks, plus the blob `<reviewed_sha>:<source.path>`
  equals the design blob; the manifest validates against `execution-plan.v2.schema.json`; the
  absolute-repo-path rule of `--mode plan`;
- build: `build_mode == "v2"`; `build.base_commit` resolves to `plan_identity.design_commit`;
  `plan_identity` equals the manifest/approvals values; `preflight_path` hashes to
  `preflight_sha256` and its content equals a fresh `--mode design` output (which carries no
  timestamp); `suite_identity` deep-equals the manifest `suite` (command, known-failure ids,
  isolated, setup_command, timeout_min) and its record (hash, command, head = reviewed_sha,
  not timed out); the suite's failures are a subset of the manifest's known-failure ids and
  equal `known_failures_seen`;
- checks: one run-frozen record per applicable check, matched by `check_id`, hash as recorded;
  the applicable id set equals the manifest's; command, `timeout_min` and `budget_min` equal
  the manifest check; integer `exit_code === 0`; not timed out; head = reviewed_sha, clean
  before and after; `minutes_used <= budget_min` when `budget_min > 0`;
- proofs: every runtime ledger record comes from a run-frozen record whose command equals the
  acceptance's `proof_command`;
- negative controls, one record per `isolated_mutation` acceptance: integer exit codes; baseline
  exit 0 and not timed out; mutated exit not 0, not 124/126/127, below 128, not timed out;
  patch nonempty and its hash matches; `mutated_paths` re-derived from the patch bytes equal the
  recorded list; the patch applies to `reviewed_sha` without touching any work tree
  (`GIT_INDEX_FILE=<tmp> git read-tree <reviewed_sha> && git apply --cached --check`); every
  mutated path is inside an `owned_paths` entry of that requirement's components, none under
  `test_paths`, none in any `tests_added` of the build history and none named in the proof
  command; `phase_elapsed_s` within the total limit; all logs hashed. These records are
  attested evidence, not semantic proof (an undeclared test file inside owned code is not
  caught). `exempt` controls are copied into the proof as recorded exemptions with their
  reasons and counts;
- every v2 proof records `design_commit` and `design_paths` (from the preflight), `reviewers`
  (per approval gate from the ledger, plus build and verify `reviewers`), `fallback_used`,
  `cross_family` (false when any of those reviews was the Opus fallback) and `repo_config`;
- with `--trunk-ref`: `git rev-list <trunk-ref>..design_commit^` is empty (no commit before the
  design commit escapes review), recorded as `trunk_qualification { ref, sha,
  pre_design_range_empty: true, pr_paths }` with `pr_paths` = `design_paths` + `changed_files`
  + state-only paths; without it `trunk_qualification: null`. `certification()` strips
  `trunk_qualification` together with `checked_at`, `actual_head` and the two state
  qualifications, so verify's proof and land's revalidation compare equal while the trunk
  result is still checked live;
- the proof and land's result carry `contract: 2` and `certification: "design-gated"`. v1
  proofs are byte-for-byte unchanged (no `contract` field means v1). Only `v2/design-gated`
  satisfies #54.

### 6.6 land
Unchanged gates. With `contract: 2` it passes `--frozen-dir`, `--approvals`,
`--approvals-sha256` and `--trunk-ref origin/<trunk_branch>` (after `git fetch`) to completion
revalidation, requires `trunk_qualification` to be non-null in the written proof, and its
result echoes `cross_family`, `fallback_used` and `allow_no_ci`.

### 6.7 Scope change after freeze
An authorized change to the canonical file after freeze is a new design run on a fresh work
branch from the trunk: new revision, new approvals, new design commit; its `rev-0` is the
previous frozen blob, so the `--previous` rule binds the new revision to the old ids. Prior
implementation work is re-applied on top of the new design commit, so it falls inside the new
reviewed range. Old proofs fail `--previous-proof` and the identity checks.

## 7. Reconciliation rules (author prompts, enforced where mechanical)

- Fix a finding at the requirement/decision that owns it, in place. Keep IDs stable
  (enforced: `E_ID_REMOVED`, `E_ID_REACTIVATED` on every revision).
- New ID only for a genuinely distinct requirement. Never add `-fix`/`-v2`/`-final` IDs,
  "additional requirements" sections, or appendices (`E_SHADOW_ID`).
- Remove a goal, requirement or acceptance by setting `status: retired` with
  `retired_rationale`; never reuse its ID.
- After editing, check every reference to the changed ID (depends_on, coverage, components).
- Never edit generated views or the manifest; never write a hash.

## 8. Migration (scripts/migrate-v1.js)

`node migrate-v1.js --manifest <v1 execution-plan.json> --spec <spec.md> [--prd <prd.md>] --feature-id <id> --out <draft.json>`

Read-only on its inputs (their bytes are unchanged afterwards, and a frozen v1 run still
completes under contract 1). Writes a DRAFT v2 file plus `<out>.report.json`
`{ todos[], conflicts[], unmapped_tests[], lost[], provenance_missing }`: exact acceptance ID
and proof-command mapping from the v1 manifest, scope/check copies, and every field it could
not derive marked with the literal `MIGRATION-TODO` (the validator rejects that token:
`E_MIGRATION_TODO`). `conflicts` lists acceptance ids present in only one of `spec.md` and the
manifest and proof commands that differ between them; `unmapped_tests` lists test files named
by `spec.md` or a manifest command that map to no acceptance; `lost` lists `spec.md`/`prd.md`
sections with no v2 field; `provenance_missing` is true when there is no `prd.md` or no
original request. The draft never validates until a human or authorized review fills it;
exit 0 means "draft written", never "certified".

## 9. What stays exactly as it was

Cross-family review with disclosed fallback (`reviewers`, `fallback_used`), foreground relay
waits, base..reviewed whole-change review in a throwaway worktree, test-first build, security
pass, suite last on the pinned commit, clean-tree/HEAD pinning, known-failure qualification,
completion proof revalidated by land with `--previous-proof`, CI handling, human merge.

One gate rule for both reviewers (#37), equal to today's codex path: the verdict is
codex-review's `computeVerdict`; `confirmed_findings` = every validated-confirmed
BLOCKING/MAJOR, every other non-refuted finding goes to `other_findings`; a PASS with any
confirmed finding is FAIL; a NEEDS_HUMAN with none is BLOCKED unless its only reason is
`model_rule_disagreement` with other findings listed (design and build send those on; verify
BLOCKS). The workflow decides the buckets, not the relay: the codex relay copies each
`result.json` finding's `id, severity, confidence, iso_property, validation.status, claim,
evidence, location` plus `verdict, verdict_reasons, model_verdict`, and the workflow recomputes
the verdict with its copy of `computeVerdict`, BLOCKING a reply whose recomputed verdict
differs (relay inconsistency). The fallback reviewer self-validates, so each reported
BLOCKING/MAJOR counts as `confirmed` and each MINOR/NIT as `not_required`; the same function
decides its verdict (model verdict = the rule's own, so it never disagrees). The copies of
`computeTriggers`/`computeVerdict` in the three workflows and in `scripts/lib/gate-rule.js` are
byte-identical to `run-review.js`'s. The one difference: `model_rule_disagreement` (including a
trigger that codex's validation refuted after the model judged it) exists only on the codex
path, and only makes that path stricter.

## 10. What each layer proves

- Parser/schema/graph tests: structure only.
- Model reviews (codex, or the disclosed Opus fallback): semantic adequacy (missing intent,
  contradictions in prose, paraphrased duplicates). Schema validation never claims these.
- Approval and completion checks: relayed hashes, relayed verdicts and stale combinations are
  caught by scripts that re-derive them from snapshots, review files and git. Files that are
  script-written but agent-invoked (`inputs.json`, `fallback-review.json`, run-frozen records)
  and evidence logs are host attestations, as in v1: a deliberately forged one is not caught.
- Live end-to-end runs: actual agentic behaviour. Mocked workflow tests are labelled mocked.
