# gated-pipeline v2: one canonical feature file

Design contract for issue #54. Everything here is normative for the v2 implementation; the
tests and the SKILL.md describe the same contract. v1 (`prd.md` + `spec.md` + hand-written
`execution-plan.json`, manifest `version: 1`) keeps its own validator path unchanged.

## 1. Authority

- A feature has exactly ONE editable design artifact: the canonical feature file
  `<repo>/.pipeline/features/<feature_id>.feature.json` (directory configurable through
  `design.features_dir` in `.claude/pipeline.yaml`, repo-relative). It holds the source
  request, the product (PRD) content, the technical (spec) content, the acceptance scenarios,
  the frozen verification configuration and the scope.
- Everything else is derived by `scripts/compile-feature.js`, deterministically, into a
  directory OUTSIDE the repo: `execution-plan.json` (manifest v2), `prd.view.md`,
  `spec.view.md`, `compile-identity.json`. Views carry a `GENERATED - DO NOT EDIT` banner and
  are never an input to anything except a reviewer.
- No model authors a manifest, a hash or a view. Models author the canonical file; scripts
  derive the rest and return the authoritative exit codes.
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
      expected  { exit_code: int }            (runtime: required)
      evidence  { paths[] (>=1), description } (static: required)
    }
    negative_control: {
      method: isolated_mutation|exempt,
      description          (always),
      mutation             (isolated_mutation: what to break, in prose),
      exemption_reason     (exempt: required)
    }
  }
}
scope: { allowed_paths[] (>=1), protected_paths[], state_paths[], clean_ignore[] }
checks[] {
  id: CHECK-<NAME>, name, applicable: bool, reason (always),
  command (applicable: required) | procedure (alternative to command for manual-style checks),
  expected (applicable: required), budget_min: int >= 0, quiet: bool, effort: low|medium|high,
  environment: string
}
test_plan: string
```

## 3. Deterministic gates (scripts/validate-feature.js)

`node validate-feature.js --file <feature.json> [--schema <feature.schema.json>] [--source-request <file>]`

Prints one JSON object: `{ valid, validator_version, schema_version, source_sha256, errors: [ { code, path, id, message } ] }`.
Exit 0 valid, 1 invalid, 2 usage/setup error. It never executes, evaluates or shells out any
string from the file (proof commands are data).

1. Parse (`scripts/lib/strict-json.js`): UTF-8, no BOM, RFC 8259 grammar only, DUPLICATE KEYS
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
   - `E_NEGATIVE_CONTROL` missing mutation/exemption reason; a P0 requirement whose every
     acceptance is `exempt` needs `exemption_reason` of >= 20 chars on each.
   - `E_REASON_MISSING` check with empty reason; applicable check without command/procedure
     or expected.
   - `E_UNSAFE_PATH` absolute path, `..` segment, backslash, `~`, control chars, or characters
     outside `[A-Za-z0-9._/ +@-]` in any scope/owned/evidence path.
   - `E_PROTECTED_OVERLAP` an allowed, state, clean_ignore or owned path equal to, inside, or
     containing a protected path.
   - `E_OWNERSHIP` two `exclusive` components owning overlapping paths; an owned path outside
     allowed_paths.
   - `E_SCOPE` the canonical file itself listed in allowed/state/clean_ignore paths (it is
     always protected; the compiler adds it).
5. `--source-request <file>`: `source_request.text` must equal the file text (trailing newline
   normalized) or `source_request.sha256` must equal SHA-256 of its bytes. `E_SOURCE_MISMATCH`.

Diagnostics are sorted (path, code) so output is deterministic.

## 4. Compiler (scripts/compile-feature.js)

`node compile-feature.js --file <feature.json> --repo-path <repo-relative path of the file> --out <dir outside repo>`
`node compile-feature.js --file <feature.json> --repo-path <rel> --check <dir>`  (drift check)

- Runs the full validator first; invalid -> exit 1, writes nothing.
- `--out` must not exist or be empty. Writes, with LF newlines, UTF-8, 2-space JSON, keys in
  schema order (never source order), arrays in source order, no timestamps:
  - `execution-plan.json` (manifest v2):
    ```
    { version: 2, feature_id, schema_version: 2, compiler_version,
      source: { path: <repo-path>, sha256: <raw source bytes> },
      spec_sha256: <same as source.sha256, kept for the v1 completion code paths>,
      allowed_paths, protected_paths (source protected_paths + the canonical file path),
      state_paths, clean_ignore,
      requirements: [ { id: <acceptance id>, requirement_id, kind, proof_command, expected,
                        negative_control: { method, description, mutation|exemption_reason } } ],
      checks: [ { id, name, applicable, reason, command, procedure, expected, budget_min, quiet, effort, environment } ],
      views: { prd_view_sha256, spec_view_sha256 } }
    ```
    `proof_command` is `""` for static. Retired requirements are omitted from `requirements`.
  - `prd.view.md`: source request (or ref+hash+summary), coverage table, problem, actors,
    goals, non-goals, constraints, risks, success metrics, and each active requirement's
    id/statement/priority/goal links/acceptance given-when-then. A pure function of
    `source_request`, `coverage`, `product` and the product-facing requirement fields.
  - `spec.view.md`: architecture, components, security, each requirement's dependencies,
    components, verification and negative control, scope, checks, test plan.
  - `compile-identity.json`: `{ compiler_version, schema_version, feature_id, source_path,
    source_sha256, files: { <name>: sha256 } }` for the three files above.
- No self-referential hashes: the source hash is of the raw canonical bytes; the manifest
  embeds it; the identity file hashes the outputs; nothing hashes a file containing its own hash.
- `--check <dir>`: recompiles in memory and compares every file byte for byte; exit 1 with
  `E_DRIFT` naming each differing file. A hand-edited view or manifest is never treated as
  authority.
- Same source bytes + same compiler version -> byte-identical output. Reordering keys in the
  source changes `source.sha256` (raw-bytes policy) but not the manifest/view bodies.

## 5. Approval identity (design stage)

- PRD review input: `prd.view.md` compiled from revision k, `--against <run_dir>/source-request.txt`
  (the main session writes the task text there before design; codex-review accepts `--against`
  for `prd`). The reviewer checks coverage of the original request, not just internal quality.
- Spec review input: `spec.view.md` + `execution-plan.json` of revision k, `--against prd.view.md`
  of revision k.
- Each approval records `{ gate, round, source_sha256, prd_view_sha256, spec_view_sha256,
  schema_version, compiler_version, verdict, reviewer }`.
- Freeze requires: a spec PASS whose `source_sha256` equals the final source hash, and a PRD
  PASS whose `prd_view_sha256` equals the final `prd_view_sha256` (validated partial-review
  rule: the PRD view is a deterministic function of the product sections, so an unchanged
  view proves product scope did not change). If a spec-round revision changes the PRD view,
  the PRD approval is invalid and the PRD review reruns before the spec review continues.
  A PASS for revision A is never combined with a PASS for revision B unless that rule holds,
  and the result records which rule carried it.
- Revisions follow the reconciliation rules (section 7). After every edit: validate, compile,
  and only then review.

## 6. Stage integration

- design: authors the canonical file in the repo checkout on `work_branch`, runs the gates,
  reviews, and at freeze commits exactly that one path (explicit pathspec) and compiles into
  `<run_dir>/frozen/`. Returns `feature_path`, `feature_repo_path`, `design_commit`,
  `source_sha256`, `spec_sha256` (= source), `manifest_path`, `manifest_sha256`,
  `prd_view_path`, `spec_view_path`, `approvals`. Build's `base_commit` is `design_commit`, so
  the canonical file predates the reviewed range and any later change to it is a protected-path
  violation.
- `check-completion.js --mode design --repo --feature-id --manifest --manifest-sha256 --spec <canonical file> --commit <sha>`:
  read-only; manifest hash matches; the file at `<commit>:<source.path>` (git show) hashes to
  `source.sha256`; recompiling those bytes reproduces the manifest bytes exactly; schema and
  compiler versions match. Used by build (before implementation, at HEAD) and by verify's plan
  preflight. `--mode plan` and `--mode completion` on a v2 manifest perform the same identity
  checks against `reviewed-sha`.
- build: with `manifest_path` + `manifest_sha256` + `spec_path` (canonical file) it is a
  design-gated run and preflights `--mode design` BEFORE the implementer starts; drift is
  BLOCKED. Its result carries `plan_identity { manifest_sha256, source_sha256, design_commit }`.
  A run with only `charge` (no manifest) is the explicit `charge-only` mode: allowed, stamped
  `certification: "charge-only"`, and v2 completion rejects it.
- verify: plan preflight returns the manifest version and, for v2, the frozen applicable
  checks. `args.checks` may be omitted (the frozen checks are used) or must deep-equal them;
  any difference in command, expected, budget_min, quiet, effort or applicability is BLOCKED
  before anything runs. A negative-control phase runs each `isolated_mutation` control in a
  throwaway worktree of `reviewed_sha` under `<run_dir>/negative/<id>/wt`, applies the
  mutation there only, runs the proof command, records `{ id, exit_code, log_path,
  log_sha256, head_sha }`, removes the worktree, and confirms the work checkout's HEAD and
  status are unchanged. The mutated run must FAIL (exit code different from expected).
- check-completion v2 (manifest `version: 2`): all v1 checks, plus source identity (above),
  build `plan_identity` match, each verify check record's `command`/`expected` equal to the
  frozen check, and a negative-control record per `isolated_mutation` acceptance with an exit
  code different from `expected.exit_code` and a valid log hash. `exempt` controls are copied
  into the proof as recorded exemptions.
- land: unchanged gates; its completion revalidation runs the v2 rules.
- v1 manifests (`version: 1`) keep the v1 rules exactly. Nothing upgrades a v1 plan silently.

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

## 10. What each layer proves

- Parser/schema/graph tests: structure only.
- Model reviews (codex, or the disclosed Opus fallback): semantic adequacy (missing intent,
  contradictions in prose, paraphrased duplicates). Schema validation never claims these.
- Live end-to-end runs: actual agentic behaviour. Mocked workflow tests are labelled mocked.
