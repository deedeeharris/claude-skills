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
  content, the acceptance scenarios, the frozen verification configuration and the scope.
- Everything else is derived by `scripts/compile-feature.js`, deterministically, into a
  directory OUTSIDE the repo: `execution-plan.json` (manifest v2), `prd.view.md`,
  `spec.view.md`, `compile-identity.json`. Views carry a `GENERATED - DO NOT EDIT` banner and
  are never an input to anything except a reviewer.
- No model authors a manifest, a hash or a view. Models author the canonical file; scripts
  derive the rest and return the authoritative exit codes.
- Byte authority: the committed blob (`git cat-file blob <commit>:<path>`, no filters) is the
  authoritative source; every hash is over raw bytes (`Buffer`), never decoded text. The
  working-tree file must equal that blob byte for byte and be clean wherever a stage reads it.
  Repos that convert line endings need `<features_dir>/*.feature.json -text` in
  `.gitattributes`; SKILL.md documents it, and a CRLF or hook-rewritten file is BLOCKED, never
  re-hashed.
- Format: strict JSON (zero dependencies). Long prose lives in strings. Humans read the
  generated Markdown views.

## 2. Canonical file (schema_version 2)

Schema: `schemas/feature.schema.json` (JSON Schema 2020-12 keywords, restricted to the subset
the bundled validator supports; an unsupported keyword in the schema is a setup error, so the
contract cannot silently loosen). Every object has `additionalProperties: false`.

```
schema_version: 2                      const
feature_id:     [A-Za-z0-9._-]+
title:          string
source_request: { text } | { ref, sha256, summary }     exactly one form
    text   = the original task, verbatim
    ref    = a non-public location label (never a secret), sha256 = SHA-256 of the exact
             request bytes, summary = what it asks (for confidential requests)
coverage: [ { id: SRC-NNN, excerpt, disposition: covered|excluded,
              requirement_ids[] (covered: >=1), rationale (excluded: required) } ]  minItems 1
product: {
  problem, actors[] (>=1),
  goals[]     { id: GOAL-NNN, statement }                                   minItems 1
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
  acceptance[] (active: >=1) {
    id: <REQ-ID>-ACn, given, when, then,
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
      alternate_evidence   { paths[] (>=1), description }  (required when every acceptance
                                                            of a P0 requirement is exempt)
    }
  }
}
scope: { allowed_paths[] (>=1), protected_paths[], state_paths[], clean_ignore[],
         test_paths[] (>=1 when any isolated_mutation exists) }
checks[] {
  id: CHECK-<NAME>, name, applicable: bool, reason (always),
  command (applicable: required, single line), expected { exit_code: 0 } (applicable: required),
  budget_min: int >= 0, quiet: bool, effort: low|medium|high, environment: string
}
test_plan: string
```

There is no free-prose `procedure` check: a manual check is `applicable: false` with its
reason, and a nonzero expected exit code does not exist (a proof that "expects failure" would
certify a missing test file).

## 3. Deterministic gates (scripts/validate-feature.js)

`node validate-feature.js --file <feature.json> --repo-path <repo-relative path of the file> [--schema <feature.schema.json>] [--source-request <file>]`

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
   `E_CONST`, `E_PATTERN`, `E_MIN_ITEMS`, `E_MIN_LENGTH`, `E_MINIMUM`.
4. Graph/cross-field (`scripts/lib/feature-graph.js`):
   - `E_DUP_ID` any ID repeated across the whole file (goals, requirements, acceptance, checks...).
   - `E_ID_FORMAT` acceptance id not prefixed by its requirement id.
   - `E_SHADOW_ID` an ID or title segment like `-fix`, `-v2`, `-final`, `-new`, `-addendum`,
     `-patch`, `-rev<n>` (patch accumulation).
   - `E_DUP_STATEMENT` two requirements whose normalized statements (lowercase, collapsed
     whitespace, stripped punctuation) are identical. (Paraphrased duplicates are a review job.)
   - `E_REF` dangling goal/requirement/component/acceptance reference.
   - `E_CYCLE` `depends_on` cycle (message gives the cycle path); `depends_on` on a retired
     requirement is `E_REF`.
   - `E_COVERAGE` a goal with no active requirement; an active requirement with no acceptance;
     a covered SRC with no requirement; an excluded SRC with no rationale.
   - `E_PROOF` runtime without command/expected, static without evidence, multi-line command,
     command present on static.
   - `E_NEGATIVE_CONTROL` missing mutation/exemption reason; a static acceptance that is not
     `exempt`; a P0 requirement whose every acceptance is `exempt` without `alternate_evidence`;
     an `isolated_mutation` with empty `scope.test_paths`.
   - `E_REASON_MISSING` check with empty reason; applicable check without command or expected.
   - `E_UNSAFE_PATH` absolute path, `..` segment, backslash, `~`, control chars, or characters
     outside `[A-Za-z0-9._/ +@-]` in any scope/owned/evidence path.
   - `E_PROTECTED_OVERLAP` an allowed, state, clean_ignore, test or owned path equal to, inside,
     or containing a protected path, where protected = `scope.protected_paths` plus the
     `<features_dir>/` prefix.
   - `E_OWNERSHIP` two `exclusive` components owning overlapping paths; an owned path outside
     allowed_paths.
   - `E_SCOPE` `--repo-path` basename/feature_id mismatch, or `features_dir` unsafe or under
     `.git/`.
   - `E_MIGRATION_TODO` the literal `MIGRATION-TODO` anywhere (section 8).
5. `--source-request <file>`: `source_request.text` must equal the file text (trailing newline
   normalized) or `source_request.sha256` must equal SHA-256 of its bytes. `E_SOURCE_MISMATCH`.
   The design stage always passes it.

Diagnostics are sorted (path, code) so output is deterministic.

## 4. Compiler (scripts/compile-feature.js)

`node compile-feature.js --file <feature.json> --repo-path <rel> --out <dir outside repo>`
`node compile-feature.js --file <feature.json> --repo-path <rel> --check <dir>`  (drift check)

- Runs the full validator first; invalid -> exit 1, writes nothing.
- `--out` must not exist. Output is written into `<out>.tmp-<pid>-<rand>` and renamed to
  `<out>` only after every file is written and fsynced, so an interrupted compile never leaves
  a valid-looking directory at `<out>`. Writes, with LF newlines, UTF-8, 2-space JSON, keys in
  schema order (one explicit field list per object, never source order), arrays in source
  order, no timestamps:
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
      checks: [ { id, name, applicable, reason, command, expected, budget_min, quiet, effort, environment } ],
      views: { prd_projection_sha256, prd_view_sha256, spec_view_sha256 } }
    ```
    `proof_command` is `""` for static. Retired requirements are omitted from `requirements`.
  - PRD projection: the canonical JSON (keys sorted, no whitespace) of exactly these fields:
    `source_request`, `coverage`, `product`, `architecture.invariants`,
    `architecture.security.accepted_risks`, and per requirement `id, status, retired_rationale,
    goal_ids, statement, priority, depends_on` and per acceptance `id, given, when, then,
    verification.kind`. `prd_projection_sha256` is its SHA-256. Excluded on purpose: commands,
    evidence paths and negative controls (how a behaviour is proven, judged by the spec gate,
    including every exemption), components, decisions, scope and checks.
  - `prd.view.md` renders exactly the projection; `spec.view.md` renders everything else plus
    requirement ids. Every string is rendered as a blockquote (each line prefixed `> `) with
    ``\ ` * _ # [ ] < > |`` backslash-escaped, so no string can forge a heading, list item or
    table row.
  - `compile-identity.json`: `{ compiler_version, schema_version, feature_id, source_path,
    source_sha256, prd_projection_sha256, files: { <name>: sha256 } }` for the three files above.
- No self-referential hashes: the source hash is of the raw canonical bytes; the manifest
  embeds it; the identity file hashes the outputs; nothing hashes a file containing its own hash.
- `--check <dir>`: recompiles in memory and compares every file byte for byte; exit 1 with
  `E_DRIFT` naming each differing file. A hand-edited view or manifest is never treated as
  authority.
- Same source bytes + same compiler version -> byte-identical output. Reordering keys in the
  source changes `source.sha256` (raw-bytes policy) but not the manifest/view bodies.

## 5. Approval identity (design stage)

- Source request: before the first draft, `scripts/hash-inputs.js --out <run_dir>/source-request.inputs.json <run_dir>/source-request.txt`
  pins `source_request_sha256`. Every validate step passes `--source-request`.
- Revision snapshots: revision k is copied byte for byte to `<run_dir>/rev-k/feature.json` and
  compiled into `<run_dir>/rev-k/out/` before it is reviewed. Reviewers read only rev-k files.
- One command chain per review, so no reviewer starts on an invalid or drifted revision
  whatever the relay reports: `validate-feature.js ... && compile-feature.js ... --check <rev-k/out> && <review>`,
  where `<review>` is `run-review.js` or, for the fallback, `hash-inputs.js --out`.
- Review inputs are hashed by a script, never by the reviewer: codex-review's `run-review.js`
  writes `inputs: [ { role: files|against, path, sha256 } ]` into `result.json` (computed from
  the bytes it passes to codex; a change before the run ends is a setup error, exit 2). The Opus
  fallback runs `hash-inputs.js --out <review_dir>/inputs.json <files...>` before reviewing and
  `hash-inputs.js --verify <review_dir>/inputs.json` after; these hashes are script-written but
  agent-invoked, and the report says so.
- PRD review input: `rev-k/out/prd.view.md`, `--against <run_dir>/source-request.txt`
  (codex-review accepts `--against` for `prd`). Spec review input: `rev-k/out/spec.view.md` +
  `rev-k/out/execution-plan.json`, `--against rev-k/out/prd.view.md`.
- Approval ledger `<run_dir>/approvals.json`: the workflow composes one record per review
  `{ gate, round, rev, rev_dir, verdict, reviewer, review_dir, result_path|inputs_path,
  source_sha256, prd_projection_sha256, spec_view_sha256, manifest_sha256, source_request_sha256,
  schema_version, compiler_version }` and an agent writes it verbatim. The workflow computes
  each verdict itself (codex: `result.json` verdict via the relay; fallback: section 9 rule).
- `check-completion.js --mode approvals --approvals <file> --source <file>` (read-only, no
  git; every `rev_dir`/`review_dir` must be absolute and outside the repo) re-derives every
  record from the snapshots: rev-k bytes hash to `source_sha256`; recompiling rev-k reproduces the view/manifest/projection hashes; the
  review's recorded input hashes equal the rev-k files and the pinned source request; a codex
  record's verdict equals its `result.json`. It then applies the freeze rule and prints
  `{ approvals_sha256, records: [ { gate, round, rev, verdict } ], rule }`; the workflow
  requires the echoed records to equal its in-memory ledger.
- Freeze rule, for the final bytes F given by `--source`: the latest spec review is a PASS on
  a revision whose bytes equal F; and the latest PRD review whose `prd_projection_sha256`
  equals F's projection is a PASS with the pinned `source_request_sha256`. A spec-round edit
  that changes the projection therefore invalidates the PRD approval and the PRD review reruns
  before the spec review continues. The output names the rule that carried the PRD approval
  (`same-revision` or `unchanged-prd-projection`). A PASS for revision A is never combined
  with a PASS for revision B otherwise.
- Revisions follow the reconciliation rules (section 7). After every edit: validate, compile,
  snapshot, and only then review.

## 6. Stage integration

### 6.1 Contract selection
Every stage takes `contract: 1|2` (absent = 1). `contract: 1` is today's behaviour, unchanged,
including v1 design (`task`, `prd.md`, `spec.md`). `contract: 2` requires the v2 args below;
mixing (`contract: 2` with `task` or `charge`, `contract: 1` with a v2 manifest) is BLOCKED.
Nothing upgrades a v1 plan silently: `--mode plan|completion` on a v2 manifest without
`--approvals` fails, and a v1 manifest under `contract: 2` fails.

### 6.2 design (contract 2)
Args: `work_branch`, `source_request_path` (outside the repo; copied to
`<run_dir>/source-request.txt`), optional `seed_feature_path`, `features_dir`. At start a
script records `start_head` (work_branch HEAD). It authors the canonical file in the
checkout, loops per section 5, runs `--mode approvals` on the final bytes, then commits
exactly that path (`git commit --only -- <path>`), saves the committed blob
(`git cat-file blob`) to `<run_dir>/frozen-source.feature.json`, compiles it into
`<run_dir>/frozen/`, and runs `--mode design` (below) with `--expect-parent <start_head>`
(design only: `design_commit^` must equal it, a compare-and-swap that BLOCKS a second writer
that moved the branch). Freeze happens only on its exit 0. Returns `feature_path`,
`feature_repo_path`, `design_commit`, `source_sha256`, `prd_projection_sha256`, `manifest_path`, `manifest_sha256`, `prd_view_path`,
`spec_view_path`, `approvals_path`, `approvals_sha256`, `approval_rule`.

`check-completion.js --mode design --repo --feature-id --manifest --manifest-sha256 --spec <canonical file> --commit <design_commit> --approvals <file> --approvals-sha256 <hex> [--expect-parent <sha>] [--out <file>]`:
read-only; manifest hash matches; the blob `<commit>:<source.path>` (read as a Buffer) hashes
to `source.sha256`; `--spec` equals `realpath(<repo>/<source.path>)` (the only in-repo path
`outside()` admits, and only for a v2 manifest), its bytes equal the blob and `git status`
shows it clean; recompiling the blob reproduces the manifest bytes; versions match;
`git diff-tree --root --no-renames --name-only <commit>` is exactly `[source.path]` and the
commit has one parent; and the approvals check passes with F = the blob. `--out`
writes this output as the preflight record.

### 6.3 build
- `contract: 2` (design-gated) needs `manifest_path`, `manifest_sha256`, `spec_path` (canonical
  file), `design_commit`, `approvals_path`, `approvals_sha256`, and `base_commit` equal to
  `design_commit` (BLOCKED otherwise, before any agent). Before the implementer, a preflight
  runs `--mode design --commit <design_commit> --out <run_dir>/design-preflight.json` and checks
  `git merge-base --is-ancestor <design_commit> HEAD`; any failure is BLOCKED. `clean_ignore`
  comes from the preflight output (the manifest); a `clean_ignore` arg is BLOCKED. Result carries
  `build_mode: "v2"`, `plan_identity { design_commit, source_sha256, manifest_sha256,
  approvals_sha256, preflight_path, preflight_sha256 }`.
- `contract: 1` with `spec_path`: today's behaviour, stamped `build_mode: "v1"`.
- `contract: 1` with only `charge`: the explicit `charge-only` mode, stamped
  `build_mode: "charge-only"`. Completion (v1 and v2) rejects a `charge-only` build result;
  results without `build_mode` (written before this change) keep the v1 rules.

### 6.4 verify (contract 2)
- Args additionally need `design_commit`, `approvals_path`, `approvals_sha256`; `checks`,
  `clean_ignore` and `state_paths` args are forbidden (BLOCKED before any agent): the manifest
  is their only source.
- Plan preflight `--mode plan` (v2; also takes `--commit <design_commit> --approvals
  --approvals-sha256`) returns `manifest_version` and `frozen_checks` (the
  applicable manifest checks verbatim); the workflow BLOCKS unless version is 2 and every id
  matches `CHECK-<NAME>`. Each check prompt is built ONLY from its frozen check (command
  verbatim, budget, quiet, effort, environment); evidence paths use the check `id`. The workflow
  script stamps `{ check_id, name, command, expected, budget_min, quiet, effort, environment }` into
  each record; the agent adds `exit_code`, `minutes_used`, `evidence_path`, `evidence_sha256`
  and the pinned-state fields. A proof or check command containing the absolute repo path is
  BLOCKED.
- Negative-control phase: runs LAST, after checks, acceptance proofs, final review and the
  compliance trace are captured and hashed. Per `isolated_mutation` acceptance, in a
  throwaway worktree of `reviewed_sha` at `<run_dir>/negative/<id>/wt` with cwd = that worktree:
  run `isolated_setup` (the build arg, also accepted by verify v2) if configured, run the
  unmodified proof (baseline), apply the mutation
  as a patch saved to `<run_dir>/negative/<id>/mutation.patch`, run the proof again, remove the
  worktree. Record `{ id, head_sha, cwd, setup, baseline_exit_code, baseline_log_path,
  baseline_log_sha256, mutation_patch_path, mutation_patch_sha256, mutated_paths, exit_code,
  log_path, log_sha256 }`. Then rerun the pinned-state check and `git status` on the work
  checkout.

### 6.5 check-completion v2 (manifest `version: 2`)
Inputs add `--approvals`, `--approvals-sha256` and, from land, `--trunk-ref`.
All v1 checks, plus:
- identity: everything `--mode design` checks, plus the blob `<reviewed_sha>:<source.path>`
  equals the design blob; the manifest validates against `execution-plan.v2.schema.json`;
- build: `build_mode == "v2"`; `build.base_commit` resolves to `plan_identity.design_commit`;
  `plan_identity` equals the manifest/approvals values; `preflight_path` hashes to
  `preflight_sha256` and its content equals a fresh `--mode design` output (which carries no
  timestamp);
- with `--trunk-ref`: `git rev-list <trunk-ref>..design_commit^` is empty (no commit before the
  design commit escapes review); the proof records `design_commit` and `design_paths`, and the
  PR change = `design_paths` + `changed_files` + state-only paths;
- checks: records matched by `check_id`; the applicable id set equals the manifest's; stamped
  fields deep-equal the manifest check; integer `exit_code === 0`; `minutes_used <= budget_min`
  when `budget_min > 0`;
- negative controls, one record per `isolated_mutation` acceptance: integer exit codes;
  baseline exit 0; mutated exit not 0, not 124/126/127 and below 128; patch nonempty and its
  hash matches; `mutated_paths` nonempty, all inside an `owned_paths` entry of that
  requirement's components, none under `test_paths` and none named in the proof command; all
  logs hashed. These records are attested evidence, not semantic proof. `exempt` controls are
  copied into the proof as recorded exemptions with their reasons and counts;
- the proof and land's result carry `contract: 2` and `certification: "design-gated"`. v1
  proofs are byte-for-byte unchanged (no `contract` field means v1). Only `v2/design-gated`
  satisfies #54.

### 6.6 land
Unchanged gates. With `contract: 2` it passes `--approvals`, `--approvals-sha256`
and `--trunk-ref origin/<trunk_branch>` (after `git fetch`) to completion revalidation.

### 6.7 Scope change after freeze
An authorized change to the canonical file after freeze is a new design run on a fresh work
branch from the trunk: new revision, new approvals, new design commit. Prior implementation
work is re-applied on top of the new design commit, so it falls inside the new reviewed range.
Old proofs fail `--previous-proof` and the identity checks.

## 7. Reconciliation rules (author prompts)

- Fix a finding at the requirement/decision that owns it, in place. Keep IDs stable.
- New ID only for a genuinely distinct requirement. Never add `-fix`/`-v2`/`-final` IDs,
  "additional requirements" sections, or appendices.
- Remove a requirement by setting `status: retired` with `retired_rationale`; never reuse its ID.
- After editing, check every reference to the changed ID (depends_on, coverage, components).
- Never edit generated views or the manifest; never write a hash.

## 8. Migration (scripts/migrate-v1.js)

`node migrate-v1.js --manifest <v1 execution-plan.json> --spec <spec.md> [--prd <prd.md>] --feature-id <id> --out <draft.json>`

Read-only on its inputs. Writes a DRAFT v2 file plus `<out>.report.json`: exact acceptance ID
and proof-command mapping from the v1 manifest, scope/check copies, and every field it could
not derive marked with the literal `MIGRATION-TODO` (the validator rejects that token:
`E_MIGRATION_TODO`). The draft never validates until a human or authorized review fills it;
exit 0 means "draft written", never "certified".

## 9. What stays exactly as it was

Cross-family review with disclosed fallback (`reviewers`, `fallback_used`), foreground relay
waits, base..reviewed whole-change review in a throwaway worktree, test-first build, security
pass, suite last on the pinned commit, clean-tree/HEAD pinning, known-failure qualification,
completion proof revalidated by land with `--previous-proof`, CI handling, human merge.
One gate rule for both reviewers (#37): codex-review's `computeVerdict` decides; only findings
that are validated-confirmed AND triggering (`gate_trigger: true` in `result.json`, or the
same rule applied to fallback findings) are `confirmed_findings`; a NEEDS_HUMAN with none is
BLOCKED unless its only reason is `model_rule_disagreement`.

## 10. What each layer proves

- Parser/schema/graph tests: structure only.
- Model reviews (codex, or the disclosed Opus fallback): semantic adequacy (missing intent,
  contradictions in prose, paraphrased duplicates). Schema validation never claims these.
- Approval and completion checks: relayed hashes and stale combinations are caught by scripts
  that re-derive them; a deliberately forged review file or evidence log is not (host
  attestation, as in v1).
- Live end-to-end runs: actual agentic behaviour. Mocked workflow tests are labelled mocked.
