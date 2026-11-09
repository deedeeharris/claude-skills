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
  stage arguments that used to carry them are BLOCKED (section 6.1). Its exception lists are
  bounded by repo-owner configuration (section 2, upper bound).
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
LC = status: active|retired, retired_rationale (retired: required)   lifecycle of every id'd item
schema_version: 2                      const
feature_id:     ^[A-Za-z0-9._-]+$
title:          string
source_request: { text } | { ref, sha256, summary }     exactly one form, chosen by the
                                                        design arg source_request_mode (3.5)
    text   = the original task, verbatim
    ref    = a non-public location label (never a secret), sha256 = SHA-256 of the exact
             request bytes, summary = what it asks (for confidential requests)
coverage: [ { id: SRC-NNN, excerpt, disposition: covered|excluded,
              requirement_ids[] (covered: >=1), rationale (excluded: required) } ]  minItems 1
product: {
  problem, actors[] (>=1),
  goals[]     { id: GOAL-NNN, statement, source_ids[] (>=1, covered SRC ids), LC }  minItems 1
  non_goals[] { id: NG-NNN, statement, rationale, LC }
  constraints[] string, risks[] string, success_metrics[] string (>=1)
}
architecture: {
  approach,
  decisions[]  { id: DEC-NNN, decision, rationale, LC }
  invariants[] { id: INV-NNN, statement, LC }
  components[] { id: COMP-[A-Z0-9][A-Z0-9-]*, name, description, owned_paths[] (>=1),
                 exclusive: bool, LC }
  security: { data_exposure, input_validation, resource_consumption,
              accepted_risks[] { id: RISK-NNN, statement, cites[], LC } }
}
requirements[] (minItems 1) {
  id: <PREFIX>-NNN  (e.g. AUTH-001; PREFIX = [A-Z][A-Z0-9]*, not GOAL/NG/DEC/INV/SRC/RISK/CHECK/COMP)
  LC, goal_ids[] (active: >=1), statement, priority: P0|P1|P2,
  depends_on[] requirement ids, component_ids[] (active: >=1)
  derived_rationale  (required when no covered SRC lists this active requirement)
  acceptance[] (active requirement: >=1 active) {
    id: <REQ-ID>-ACn, LC, given, when, then,
    verification: {
      kind: runtime|static,
      live      bool (runtime: required; static: must be absent) - true = live or paid call
      check_id  (live: required) the applicable check with budget_min > 0 that runs it
      command   (runtime: required, nonempty single line; live: equal to that check's command;
                 static: must be absent)
      expected  { exit_code: 0 }               (runtime: required; const 0)
      evidence  { paths[] (>=1), description } (static: required)
    }
    negative_control: {
      method: isolated_mutation|exempt,        (static or live: must be exempt)
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
  id: CHECK-[A-Z0-9][A-Z0-9-]*, name, applicable: bool, reason (always),
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
certify a missing test file). A check with `budget_min > 0` is live or paid: `budget_min` is
its kill limit and the cap on its measured time; every other check is killed at `timeout_min`
(section 6.4). The schema states no conditional: every "(...: required)", conditional `>=1`,
"must be absent", "must be exempt", "equal to" and "exactly one form" above is a graph rule
with its own id and code (section 3, table 4).

Upper bound for model-authored exceptions: `scope.state_paths`, `scope.clean_ignore` and the
`suite.known_failures[].test_id` values must each be a subset (exact string equality) of the
repo owner's list in `.claude/pipeline.yaml` (`state.paths`, `tests.clean_ignore`,
`tests.known_failures`) as read from the blob `<design_commit>:.claude/pipeline.yaml` (the
design commit touches only the canonical file, so this is the pre-design config). Under
`contract: 2` each of the three keys is written as a one-line JSON array
(`clean_ignore: ["tmp/"]`); `--mode design` extracts it with a fixed line rule (the key line
inside its parent block, strict-json on the value). An absent file or key is the empty list;
any other form is a setup error (exit 2); an entry outside the bound is `E_CONFIG_BOUND`. The
bound and the config blob's sha256 are part of the `--mode design` output.

Repo-level, non-certifying configuration stays in `.claude/pipeline.yaml` and stage args:
`lock_note` (advisory prompt text), `scan_log`/`require_scan_row` (an extra compliance
requirement) and land's `allow_no_ci`. They run no command and excuse no failure; the v2 proof
records them as `repo_config` and land's result adds `allow_no_ci` (section 6.5).

## 3. Deterministic gates (scripts/validate-feature.js)

`node validate-feature.js --file <feature.json> --repo-path <repo-relative path of the file> [--schema <feature.schema.json>] [--source-request <file> [--source-mode text|ref]] [--previous <feature.json>]`

`--repo-path` is required; `features_dir` is its dirname and its basename must be
`<feature_id>.feature.json` (`E_SCOPE`). Prints one JSON object:
`{ valid, validator_version, schema_version, source_sha256, errors: [ { code, rule, path, id, message } ] }`
(`rule` is null for parse, version and schema codes). Exit 0 valid, 1 invalid, 2 usage/setup error. It never executes, evaluates or shells out any
string from the file (proof commands are data).

1. Parse (`scripts/lib/strict-json.js`): bytes decoded with `new TextDecoder('utf-8', { fatal: true })`
   (invalid UTF-8 is `E_PARSE`, never U+FFFD), no BOM, RFC 8259 grammar only, DUPLICATE KEYS
   REJECTED (`E_DUP_KEY` with path), no `__proto__`/`constructor`/`prototype` keys.
   Error codes: `E_PARSE`, `E_DUP_KEY`, `E_FORBIDDEN_KEY`.
2. Version: `schema_version` must be 2 (`E_SCHEMA_VERSION`) before anything else is reported.
3. Schema (`scripts/lib/schema-lite.js`): `E_UNKNOWN_FIELD`, `E_TYPE`, `E_REQUIRED`, `E_ENUM`,
   `E_CONST`, `E_PATTERN`, `E_MIN_ITEMS`, `E_MIN_LENGTH`, `E_MINIMUM`, `E_MAXIMUM`.
4. Graph/cross-field rules (`scripts/lib/feature-graph.js`). Each rule has an id; a
   diagnostic carries `rule` beside `code`. "Path overlap" = equal to, inside, or containing.

   | Rule | Error when | Code |
   |---|---|---|
   | G01 | any id repeated across the whole file | `E_DUP_ID` |
   | G02 | acceptance id not `<its requirement id>-ACn` | `E_ID_FORMAT` |
   | G03 | an id or title segment `-fix`, `-v2`, `-final`, `-new`, `-addendum`, `-patch`, `-rev<n>` | `E_SHADOW_ID` |
   | G04 | two requirements with identical normalized statements (lowercase, collapsed whitespace, no punctuation; paraphrases are a review job) | `E_DUP_STATEMENT` |
   | G05 | dangling goal/requirement/component/acceptance/source/`check_id` reference | `E_REF` |
   | G06 | `depends_on` naming a retired requirement | `E_REF` |
   | G07 | `depends_on` cycle (message gives the path) | `E_CYCLE` |
   | G08 | `source_request` with zero or both forms, or a ref form missing `ref`, `sha256` or `summary` | `E_SOURCE_FORM` |
   | G09 | covered SRC with no `requirement_ids` | `E_COVERAGE` |
   | G10 | excluded SRC with no rationale | `E_COVERAGE` |
   | G11 | active goal with no active requirement | `E_COVERAGE` |
   | G12 | active goal whose `source_ids` name no covered SRC | `E_COVERAGE` |
   | G13 | active requirement with empty `goal_ids` | `E_COVERAGE` |
   | G14 | active requirement with empty `component_ids` | `E_COVERAGE` |
   | G15 | active requirement with no active acceptance | `E_COVERAGE` |
   | G16 | active requirement listed by no covered SRC and without `derived_rationale` | `E_COVERAGE` |
   | G17 | a retired item (any `LC`) with empty or missing `retired_rationale` | `E_REASON_MISSING` |
   | G18 | runtime acceptance without command or expected, or without `live` | `E_PROOF` |
   | G19 | static acceptance with command or `live`, or without evidence | `E_PROOF` |
   | G20 | multi-line acceptance, check, suite, unit or setup command | `E_PROOF` |
   | G21 | `live: true` without `check_id`, naming a check that is not applicable or has `budget_min` 0, or with a command different from that check's | `E_PROOF` |
   | G22 | `live: false` acceptance whose command equals an applicable check's with `budget_min > 0` (undeclared live) | `E_PROOF` |
   | G23 | `isolated_mutation` without mutation, `exempt` without `exemption_reason` | `E_NEGATIVE_CONTROL` |
   | G24 | a static or `live` acceptance whose control is not `exempt` | `E_NEGATIVE_CONTROL` |
   | G25 | P0 requirement whose every active acceptance is `exempt`, without `alternate_evidence` | `E_NEGATIVE_CONTROL` |
   | G26 | an `isolated_mutation` while `scope.test_paths` is empty | `E_NEGATIVE_CONTROL` |
   | G27 | check with empty reason | `E_REASON_MISSING` |
   | G28 | applicable check without command, expected or `timeout_min` | `E_REASON_MISSING` |
   | G29 | known failure without reason | `E_REASON_MISSING` |
   | G30 | `budget_min` above `timeout_min` | `E_LIMIT` |
   | G31 | a string holding a character section 2 forbids | `E_CONTROL_CHAR` |
   | G32 | scope/owned/evidence path absolute, with a `..` segment, backslash, `~`, control char or a character outside `[A-Za-z0-9._/ +@-]` | `E_UNSAFE_PATH` |
   | G33 | allowed, state, clean_ignore, test or owned path overlapping a protected path (`scope.protected_paths` + `<features_dir>/`) | `E_PROTECTED_OVERLAP` |
   | G34 | state or clean_ignore path overlapping an allowed, owned, test, evidence or alternate-evidence path | `E_STATE_OVERLAP` |
   | G35 | two `exclusive` components with overlapping owned paths | `E_OWNERSHIP` |
   | G36 | owned path outside `allowed_paths` | `E_OWNERSHIP` |
   | G37 | test path overlapping an owned path (tests live outside the code a mutation may touch) | `E_OWNERSHIP` |
   | G38 | `--repo-path` basename/feature_id mismatch, or `features_dir` unsafe or under `.git/` | `E_SCOPE` |
   | G39 | the literal `MIGRATION-TODO` anywhere (section 8) | `E_MIGRATION_TODO` |
5. `--source-request <file>` (the design stage always passes it, with `--source-mode`, default
   `text`):

   | Rule | Error when | Code |
   |---|---|---|
   | R01 | text form: `source_request.text` differs from the file text (trailing newline normalized) | `E_SOURCE_MISMATCH` |
   | R02 | ref form: `source_request.sha256` differs from SHA-256 of the file bytes | `E_SOURCE_MISMATCH` |
   | R03 | the form differs from `--source-mode` (text mode needs `text`; ref mode forbids it) | `E_SOURCE_FORM` |
   | R04 | ref mode: a `coverage[].excerpt` contains any 40-code-point substring of the file text | `E_SOURCE_LEAK` |
6. `--previous <file>` (the previous revision, parsed the same way; section 5 passes it on
   every revision):

   | Rule | Error when | Code |
   |---|---|---|
   | P01 | an SRC, GOAL, NG, DEC, INV, COMP, RISK, requirement, acceptance or check id of the previous file is missing (removal is `status: retired` with its rationale, `disposition: excluded`, or `applicable: false`) | `E_ID_REMOVED` |
   | P02 | an item retired (or excluded) there is active here | `E_ID_REACTIVATED` |

Diagnostics are sorted (path, code, rule) so output is deterministic.

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
      requirements: [ { id: <acceptance id>, requirement_id, component_ids, kind, live, check_id,
                        proof_command, expected, evidence_paths, alternate_evidence_paths,
                        negative_control: { method, description, mutation|exemption_reason } } ],
      suite: { command, unit_command, known_failures: [ { test_id, reason } ], isolated,
               setup_command, timeout_min, live_budget_min },
      limits: { proof_timeout_s, negative_controls_total_min },
      checks: [ { id, name, applicable, reason, command, expected, timeout_min, budget_min, quiet, effort, environment } ],
      views: { prd_projection_sha256, prd_view_sha256, spec_view_sha256 } }
    ```
    `proof_command` is `""` for static, `live`/`check_id` are `false`/`null` there, and
    `evidence_paths`/`alternate_evidence_paths` are `[]` when absent. Retired requirements and
    retired acceptances are omitted from `requirements`.
  - PRD projection: the canonical JSON (keys sorted, no whitespace) of exactly these fields:
    `source_request`, `coverage`, `product` (all of it), `architecture.decisions`,
    `architecture.invariants`, `architecture.security` (all fields), and per requirement
    `id, status, retired_rationale, goal_ids, statement, priority, depends_on,
    derived_rationale` and per acceptance `id, status, retired_rationale, given, when, then,
    verification.kind`. `prd_projection_sha256` is its SHA-256. Excluded on purpose: commands,
    `live`/`check_id`, evidence paths and negative controls (how a behaviour is proven, judged
    by the spec gate, including every exemption), `approach`, components, scope, suite, limits
    and checks. Decisions and security are in because they can change user-visible behaviour
    (a timeout value, what an endpoint returns).
  - `prd.view.md` is a function of the projection alone: it renders every projection leaf and
    nothing else (asserted by the leaf test, plan WP2); `spec.view.md` renders everything else
    plus requirement ids. Every string is rendered as a blockquote (each line prefixed `> `) with
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
  ` ```gp-exec ` block that the agent runs verbatim with Bash in the foreground, reporting
  stdout and exit code. A review relay (v1 and v2, plan 1b) is instead a fixed sequence of
  role-tagged blocks, info string `gp-exec <role>`, each run verbatim in this order:
  `setup` (availability probes, plain `mkdir` of a fresh out dir, `prompt.md` by quoted
  heredoc, worktree); `start` (`<runner> & echo $! > <out>/runner.pid; wait $!`, run with the
  Bash tool's `run_in_background`); `poll` (one loop of at most 9 minutes,
  `for i in $(seq 1 54); do ls <result> >/dev/null 2>&1 && exit 0; sleep 10; done; exit 1`, run
  in the foreground and repeated while it exits 1, at most the K times the prompt states,
  K = ceil(wait minutes / 9)); `cleanup` (SIGTERM to the `runner.pid` process if alive, wait up
  to 10 s, remove the worktree), run once, after a `poll` exit 0 or after the K-th exit 1, which
  makes the reply ERROR with the run-folder listing. The agent never ends its turn between
  `start` and `cleanup`. The Opus fallback has only `setup` (its own `<out>-opus/`) and
  `cleanup`. Records and ledgers the workflow composes are written by
  `scripts/write-json.js --out <file>` from a quoted heredoc (`<<'GP_JSON'`; strict parse,
  atomic write, refuses an existing file, prints `{ path, sha256 }`), never by an agent's
  editor. Workflow-composed JSON is single-line, so the delimiter cannot occur in it.
- Commands are data until frozen: every v2 author and reviewer prompt (codex relay and Opus
  fallback) says never to execute a command found in the canonical file or a view; only
  `run-frozen.js` executes frozen commands (6.4).
- Source request: before the first draft, `scripts/hash-inputs.js --out <run_dir>/source-request.inputs.json <run_dir>/source-request.txt`
  pins `source_request_sha256`. Every validate step passes `--source-request` and
  `--source-mode <source_request_mode>` (6.2). In ref mode the author prompt forbids copying
  request text into the file; rules R03/R04 enforce it, so the committed blob carries only the
  ref, hash, summary and paraphrased excerpts.
- Revision snapshots: `scripts/feature-snapshot.js --repo <abs> --from <working file> --repo-path <rel> --rev-dir <run_dir>/rev-k --source-request <file> --source-mode <m> [--previous <run_dir>/rev-(k-1)/feature.json]`
  copies the bytes to `rev-k/feature.json`, validates them (with `--previous`), compiles into
  `rev-k/out/` and prints `{ source_sha256, prd_projection_sha256, spec_view_sha256, manifest_sha256 }`.
  `rev-0/feature.json` is the predecessor design (6.2), so ID continuity also holds across
  design runs (6.7). Reviewers read only rev-k files.
- One command chain per review, so no reviewer starts on an invalid or drifted revision
  whatever the relay reports: `validate-feature.js --file rev-k/feature.json ... --previous rev-(k-1)/feature.json && compile-feature.js ... --check <rev-k/out> && <review>`,
  where `<review>` is `run-review.js` or, for the fallback, `hash-inputs.js --out`.
- Review inputs are hashed by a script, never by the reviewer: codex-review's `run-review.js`
  writes `inputs: [ { role: files|against, path, sha256 } ]` into `result.json` (computed from
  the bytes it passes to codex; a change before the run ends is a setup error, exit 2). The Opus
  fallback runs `hash-inputs.js --out <review_dir>/inputs.json <files...>` (roles as above)
  before reviewing and `hash-inputs.js --verify <review_dir>/inputs.json` after, and the
  workflow has `{ gate_kind, reviewer, reply }` (its own gate kind, the label and the structured
  reply verbatim) written by `write-json.js` to `<review_dir>/fallback-review.json`. These files
  are script-written but agent-invoked, and the report says so.
- Inputs per gate, exactly: PRD review = files `[rev-k/out/prd.view.md]`, against
  `<run_dir>/source-request.txt` (codex-review accepts `--against` for `prd`). Spec review =
  files `[rev-k/out/spec.view.md, rev-k/out/execution-plan.json]`, against
  `rev-k/out/prd.view.md` of the same rev.
- Approval ledger: after every review the workflow writes the next immutable file
  `<run_dir>/approvals-<n>.json` (n = 1, 2, ... contiguous; each holds the full record list)
  with `write-json.js`: `{ run_dir, start_head, previous_design, source_request_path,
  source_request_sha256, records: [ { gate, round, rev, rev_dir, verdict, reviewer,
  review_dir, result_path | inputs_path + fallback_review_path + fallback_review_sha256, source_sha256,
  prd_projection_sha256, spec_view_sha256, manifest_sha256, source_request_sha256,
  schema_version, compiler_version } ] }`. `approvals_path`/`approvals_sha256` name the last
  one. The workflow computes each verdict with the section 9 rule.
- `check-completion.js --mode approvals --repo <abs> --approvals <file> --source <run_dir>/rev-k/feature.json`
  (read-only, no git; every path absolute and outside `realpath(--repo)`; `--source` must be a
  rev snapshot named by a ledger record) re-derives every record:
  - no `approvals-<n+1>.json` exists beside `--approvals`; rev-k bytes hash to
    `source_sha256`; recompiling rev-k reproduces the view/manifest/projection hashes;
  - binding per gate: a codex record's `result.json` has `kind` equal to the gate (`prd` or
    `spec`), `outcome: "ok"`, `unable_to_review: null`, `scope.mode: "files"` and `inputs`
    exactly the gate's set above for the record's `rev_dir`, each hash equal to those bytes; a
    fallback record's `fallback-review.json` hashes to the recorded value, its `gate_kind` equals
    the gate, and its `inputs.json` lists exactly the same set;
  - the PRD review's `against` input is `source_request_path`, which hashes to the ledger's,
    every record's and `source-request.inputs.json`'s `source_request_sha256`, and F passes the
    validator's `--source-request` rules against it;
  - verdicts, in two separate checks. (1) Runner consistency (codex records only): the
    `result.json` `verdict` equals `computeVerdict(kind, findings, model_verdict)`. (2) Gate
    verdict: the record's `verdict` equals the section 9 gate outcome, i.e. `computeVerdict`
    and then PASS with any validated-confirmed BLOCKING/MAJOR -> FAIL (`scripts/lib/gate-rule.js`),
    derived from the `result.json` for codex and from the reply for a fallback record. A
    runner-PASS with a confirmed non-trigger MAJOR is therefore a gate FAIL (a revise round), and
    both checks hold for it. "PASS" in the freeze rule below always means this gate verdict;
  - consecutive snapshots rev-0 ... F pass the `--previous` rules.
  It then applies the freeze rule and prints `{ approvals_sha256, records: [ { gate, round,
  rev, verdict } ], rule }`; the workflow requires the echoed records to equal its in-memory
  ledger. In the same `gp-exec` block, before the commit, the design agent runs `cmp` between
  `--source` and the working file. Binding to the committed bytes is `--mode design`'s job
  (F = blob).
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
mixing (`contract: 2` with `task` or `charge`, `contract: 1` with a v2 manifest) is BLOCKED;
CI failure context reaches a v2 build as `ci_failure_log_path` instead (6.3).
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
fails completion: verify ends INCOMPLETE at stage `completion` and land refuses.

### 6.2 design (contract 2)
Args: `work_branch`, `source_request_path` (outside the repo; copied to
`<run_dir>/source-request.txt`), `source_request_mode: text|ref` (default `text`) with
`source_request_ref` (the label the file's `source_request.ref` must carry; required in ref
mode), optional `seed_feature_path`, `features_dir`, optional `previous_design: { commit,
repo_path }` (this feature's earlier frozen design; required whenever one exists, 6.7),
optional `recover: true`. Before the first agent, design.js applies G32/G38 to `features_dir`
in-script and returns `{ status: 'BLOCKED', code: 'E_SCOPE' }` on failure.

Start `gp-exec` block: takes the run lock `<git-dir>/gp-design-<feature_id>.lock` with
O_EXCL (`set -C`, content `run_dir`; exits nonzero if it exists); asserts
`git symbolic-ref -q HEAD` = `refs/heads/<work_branch>`; writes `<run_dir>/start-head.json`
(`{ start_head, previous_design }`, start_head = the work_branch HEAD); saves rev-0: with
`previous_design`, the blob `<commit>:<repo_path>` (if `<start_head>:<path>` also exists it
must equal that blob, else BLOCKED: two predecessors); without it, `<start_head>:<path>` when
that exists. The run's last `gp-exec` block (freeze, or any BLOCKED after the lock) removes the
lock; a lock left by a crashed run blocks every other design run of the feature until
`recover: true` with that `run_dir` completes or a human removes it.

The stage authors the canonical file in the checkout, loops per section 5, and runs
`--mode approvals` on the last snapshot rev-F plus `cmp` with the working file. Commit
`gp-exec` block, which never moves the branch unless it still points at `start_head`:
```
test "$(git symbolic-ref -q HEAD)" = refs/heads/<work_branch>
export GIT_INDEX_FILE=<run_dir>/design.index; git read-tree <start_head>
B=$(git hash-object -w --no-filters -- <run_dir>/rev-F/feature.json)
git update-index --add --cacheinfo 100644,"$B",<path>
C=$(git commit-tree "$(git write-tree)" -p <start_head> -m <msg>); unset GIT_INDEX_FILE
git update-ref refs/heads/<work_branch> "$C" <start_head>
git add -- <path>
```
`update-ref` with the old value fails if another writer moved the branch, so the other
writer's tip stays untouched and no branch holds a design commit. The real index catches up only for
the canonical path (other staged files stay staged and uncommitted). No commit hook runs; a
hook-rewritten file in any later commit fails the blob checks. The stage then saves the
committed blob (`git cat-file blob <design_commit>:<path>`) to
`<run_dir>/frozen-source.feature.json`, compiles it into `<run_dir>/frozen/`, and runs
`--mode design` (below) with `--expect-parent <start_head>`. Freeze happens only on its exit 0
and when its echoed approval records equal the ledger. Returns `feature_path`,
`feature_repo_path`, `design_commit`, `source_sha256`, `prd_projection_sha256`, `frozen_dir`,
`manifest_path` (`<frozen_dir>/execution-plan.json`), `manifest_sha256`, `prd_view_path`,
`spec_view_path`, `approvals_path`, `approvals_sha256`, `approval_rule`.

Recovery (`recover: true`, same `run_dir`, for a run that died after the commit and before
freeze): no authoring or review. It needs the lock holding this `run_dir`, `start-head.json`
and the ledger, `refs/heads/<work_branch>` checked out with exactly one parent equal to
`start_head`, a HEAD commit that touches only the canonical path, and that path's blob equal to
the last approved snapshot. It then runs the blob save, the compile (`--check` instead when
`<run_dir>/frozen/` already exists) and `--mode design` exactly as above. Anything else is
BLOCKED. The workflow never resets, amends or stacks a second design commit; the human reverts
the design commit and reruns design.

`check-completion.js --mode design --repo --feature-id --frozen-dir <dir> --manifest-sha256 --spec <canonical file> --commit <design_commit> --approvals <file> --approvals-sha256 <hex> [--expect-parent <sha>] [--out <file>]`:
read-only; `<frozen-dir>/execution-plan.json` hashes to `--manifest-sha256`; the blob
`<commit>:<source.path>` (read as a Buffer) hashes to `source.sha256`; `--spec` equals
`realpath(<repo>/<source.path>)` (the only in-repo path `outside()` admits, and only for a v2
manifest), its bytes equal the blob and `git status` shows it clean; the `compile --check`
comparison of the blob against `--frozen-dir` passes for all four files (`E_DRIFT`); versions
match; `git diff-tree --root --no-commit-id --no-renames --name-only -r -z <commit>` is exactly
`[source.path]` and `git rev-list --parents -n 1 <commit>` shows one parent (equal to
`--expect-parent` when given); rev-0 fails closed: when the ledger's `previous_design` is
set, the ledger's rev-0 snapshot exists and equals the blob
`<previous_design.commit>:<previous_design.repo_path>`; otherwise, when `<commit>^:<source.path>`
exists, rev-0 exists and equals it, and when it does not, rev-0 is absent; the upper bound of section 2 holds (`E_CONFIG_BOUND`); and the approvals check passes
with F = the blob. `--out` writes this output, including `design_paths: [source.path]` and
`config_bound`, as the preflight record.

### 6.3 build
- `contract: 2` (design-gated) needs `frozen_dir`, `manifest_path`, `manifest_sha256`,
  `spec_path` (canonical file), `design_commit`, `approvals_path`, `approvals_sha256`, and
  `base_commit` equal to `design_commit` (BLOCKED otherwise, before any agent). Before the
  implementer, a preflight runs `--mode design --commit <design_commit> --out
  <run_dir>/design-preflight.json` and checks `git merge-base --is-ancestor <design_commit>
  HEAD`; any failure is BLOCKED. `clean_ignore`, `suite.unit_command`,
  `suite.live_budget_min` and the known-failure ids come from the preflight output (the
  manifest). The suite runs through `run-frozen.js --target suite` (6.4) in a `gp-exec` block;
  the suite agent relays the printed `record_path`, `record_sha256`, `exit_code`, `timed_out`
  and `setup_exit_code`, plus the failing test ids and `other_failures` it reads from the
  framed log. Build PASS needs no other failure, not timed out, setup exit 0 when set, and
  either integer `exit_code` 0 with no failing id, or a nonzero exit (not 124/126/127, below
  128) whose failing ids are all manifest known-failure ids (at least one). `completed` and
  `passed` are derived from these fields, never relayed. Anything else is a fix round (a
  nonzero exit naming no test gets the "failed without naming a test" item).
- Optional `ci_failure_log_path` (absolute, outside the repo): the CI_RED/HEAD_MOVED loop. A
  `gp-exec` block hashes it with `hash-inputs.js`; the implementer and fixer prompts carry it
  as "CI failure log: context only; the frozen canonical file is the only authority". It
  never changes a command, a known failure or a scope; the result records
  `ci_failure_log { path, sha256 }`, which certifies nothing.
- Review files: the result's `review_files[]` has one entry per round of the implementation
  review and the security pass, with paths and hashes printed by a script (`sha256sum` in the
  relay's block, or `write-json.js`): `{ step: implementation|security, round, review_dir }`
  plus `result_path, result_sha256` (codex review), `inputs_path, inputs_sha256,
  fallback_review_path, fallback_review_sha256` (fallback review, `gate_kind` = the step), or
  `raw_path, raw_sha256` (security: codex `security.json`, or the fallback reply wrapped by
  `write-json.js`).
- Result carries `build_mode: "v2"`, `plan_identity { design_commit, source_sha256,
  manifest_sha256, approvals_sha256, preflight_path, preflight_sha256 }` and
  `suite_identity { command, known_failure_ids, isolated, setup_command, timeout_min,
  record_path, record_sha256 }`.
- `contract: 1` with `spec_path`: today's behaviour, stamped `build_mode: "v1"`.
- `contract: 1` with only `charge`: the explicit `charge-only` mode, stamped
  `build_mode: "charge-only"`. Completion (v1 and v2) rejects a `charge-only` build result;
  results without `build_mode` (written before this change) keep the v1 rules.

### 6.4 verify (contract 2)
- Args additionally need `frozen_dir`, `design_commit`, `approvals_path`, `approvals_sha256`
  (forbidden args: 6.1).
- Plan preflight `--mode plan` (v2; also takes `--frozen-dir --commit <design_commit>
  --approvals --approvals-sha256`) fails when any proof, check, suite, unit or setup command
  contains `realpath(--repo)` or the `--repo` spelling, and returns `manifest_version`, per
  applicable check `id, name, quiet, effort, budget_min, timeout_min`, `runtime_acceptance_ids[]`
  (non-live), `live_acceptances[] { id, check_id }`, `negative_controls[] { id,
  mutation_sha256 }`, `limits { proof_timeout_s, negative_controls_total_min }` and
  `suite_setup` (boolean), never a command. The workflow BLOCKS unless the version is 2 and every id
  matches its literal pattern (`^CHECK-[A-Z0-9][A-Z0-9-]*$`, `^[A-Z][A-Z0-9]*-[0-9]{3}-AC[0-9]+$`);
  the lists only label agents, set the quiet wait and name budgets. Completion compares the full
  sets with the manifest, so a relay that drops an id is caught.
- `scripts/run-frozen.js --repo <abs> --frozen-dir <dir> --manifest-sha256 <h> --reviewed-sha <sha> --target check:<ID>|proof:<ACC-ID>|live:<ACC-ID>|suite|negative:<ACC-ID> --out-dir <dir> [--patch <file>] [--ledger <file>]`
  is the only way a v2 stage executes a frozen command. It rejects an id that fails its pattern;
  re-hashes the manifest; checks that the checkout (the repo, or the fresh worktree it creates
  for isolated suites and negative controls) is at `reviewed_sha` and clean before and after;
  runs exactly the manifest's command with `/bin/sh -c` in its own process group, cwd = that
  checkout, under its kill limit (a check with `budget_min > 0`: `budget_min`, other checks and
  the suite: `timeout_min`, proofs: `limits.proof_timeout_s`): SIGTERM to the group at the
  limit, SIGKILL 10 s later; and refuses a command containing the repo's absolute path. For an
  isolated suite it runs `suite.setup_command` in the fresh worktree first. The log is framed by
  a header (`target, command, cwd, head`) and a footer (`exit_code, signal, elapsed_s`), so it
  is never empty and completion checks both against the record. It writes
  `<out-dir>/<target>.record.json` `{ target, command, cwd, head_before, head_after,
  status_before, status_after, timeout_s, budget_min, elapsed_s, exit_code, signal, timed_out,
  log_path, log_sha256, setup: { exit_code, log_path, log_sha256, timed_out } | null }`, prints
  `{ record_path, record_sha256, exit_code, timed_out, setup_exit_code }` (null without setup),
  and for `proof:` appends the record to the
  acceptance ledger (atomic rewrite). `proof:` is refused for a live acceptance: `live:<id>`
  executes nothing and appends `{ id, live: true, check_id, record_path, record_sha256 }` after
  checking that the check's record exists, hashes as printed, has the acceptance's command,
  exit 0 and no timeout. It never takes a command string. Interrupted by SIGTERM, SIGINT or
  SIGHUP (a Bash tool timeout, an interrupted agent), it sends SIGTERM to the running command's
  group and SIGKILL at most 1 s later, ends the log with a footer carrying `interrupted`,
  removes a worktree it made, writes no record, prints nothing and exits 1.
- One foreground Bash call: every frozen step's gp-exec block is one foreground Bash call with
  the Bash timeout 600000 ms, the tool's maximum. Before a step starts, the stage BLOCKS when
  its worst case cannot finish inside that call (570 s, each run counted as its limit + 15 s):
  build at preflight for the suite (setup and suite, each `suite.timeout_min`); verify at the
  plan preflight for a check (`budget_min` when > 0, else `timeout_min`), the proofs block
  (every runtime proof x `proof_timeout_s`) and each negative control (setup when set,
  baseline and mutated run, each `proof_timeout_s`, capped by `negative_controls_total_min`).
- Checks: each check agent waits for a quiet machine when `quiet`, then runs
  `run-frozen.js --target check:<ID>`; evidence paths use the check `id`; the agent reports
  `record_path`, `record_sha256` and the pinned-state fields. One agent then runs
  `--target proof:<id>` for every id in `runtime_acceptance_ids` and `--target live:<id>` for
  every live acceptance.
- Final review and compliance trace: `review_files[]` as in build, steps `final` and
  `compliance` (codex `compliance.json` or the wrapped fallback reply).
- Negative-control phase: runs LAST, after checks, acceptance proofs, final review and the
  compliance trace are captured and hashed. One agent call per `negative_controls` id writes
  a patch from the frozen `mutation` prose to `<run_dir>/negative/<id>/mutation.patch` and runs
  `run-frozen.js --target negative:<id> --patch <file>`, which creates a throwaway worktree of
  `reviewed_sha` at `<run_dir>/negative/<id>/wt`, runs `suite.setup_command` if set, runs the
  unmodified proof (baseline), derives `mutated_paths` from the patch's `diff --git` headers
  (rejecting renames, deletions, mode changes and binary hunks), applies it after
  `git apply --check`, runs the proof again, and removes the worktree. Each run is bounded by
  `limits.proof_timeout_s`; a control that would start after `limits.negative_controls_total_min`
  of phase time is NOT RUN, which makes verify INCOMPLETE at stage `negative controls` (never
  an exemption). The record adds `{ id, setup, baseline_exit_code, baseline_log_path,
  baseline_log_sha256, baseline_timed_out, mutation_patch_path, mutation_patch_sha256,
  mutated_paths, phase_elapsed_s }`. Then the pinned-state check and `git status` on the work
  checkout run again.

### 6.5 check-completion v2 (manifest `version: 2`)
Inputs add `--frozen-dir`, `--approvals`, `--approvals-sha256` and, from land, `--trunk-ref`.
All v1 checks, except that runtime evidence comes from the acceptance ledger (below), plus:
- identity: everything `--mode design` checks, plus the blob `<reviewed_sha>:<source.path>`
  equals the design blob; the manifest validates against `execution-plan.v2.schema.json`; the
  absolute-repo-path rule of `--mode plan`;
- build: `build_mode == "v2"`; `build.base_commit` resolves to `plan_identity.design_commit`;
  `plan_identity` equals the manifest/approvals values; `preflight_path` hashes to
  `preflight_sha256` and its content equals a fresh `--mode design` output (which carries no
  timestamp); `suite_identity` deep-equals the manifest `suite` (command, known-failure ids,
  isolated, setup_command, timeout_min) and its record (hash, framed log, command, head =
  reviewed_sha, not timed out, `setup.exit_code === 0` when `setup_command` is set); the
  suite's failures are a subset of the manifest's known-failure ids and equal
  `known_failures_seen`; the record's integer `exit_code` is 0 exactly when
  `known_failures_seen` is empty, and otherwise nonzero, not 124/126/127 and below 128; the
  build result's `suite.passed` equals `exit_code === 0` and `suite.completed` is true, so the
  kept v1 suite checks never rest on relayed flags alone; no known-failure id contains a `tests_added` path of the build history
  or the path of a changed file under `test_paths`;
- reviews: for the last round of every build and verify review step, each `review_files` path
  hashes as recorded and the step's verdict is recomputed, never read from the stage result:
  implementation/final from a codex `result.json` (`kind: "implementation"`, `outcome: "ok"`,
  `unable_to_review: null`, verdict = `gate-rule.js` over its findings and `model_verdict`) or
  from a `fallback-review.json` (`gate_kind` = the step, verdict = `gate-rule.js` over the
  reply); security from the raw file, blocking set = findings whose `severity` field is
  `critical` or `high` (PASS only when empty); compliance from the raw file's per-requirement
  statuses. A stage-result verdict that differs is exit 1. `reviewers`, `fallback_used` and
  `cross_family` are derived from the file kinds (runner `result.json` or codex raw file =
  codex; `fallback-review.json` or wrapped reply = Opus fallback), not from the stage result;
- checks: one run-frozen record per applicable check, matched by `check_id`, hash as recorded;
  the applicable id set equals the manifest's; command, `timeout_min` and `budget_min` equal
  the manifest check; integer `exit_code === 0`; not timed out; framed log; head =
  reviewed_sha, clean before and after; measured `elapsed_s <= budget_min * 60 + 10` when
  `budget_min > 0`;
- proofs: the ledger's id set equals the manifest's runtime acceptance ids; each non-live
  record is a run-frozen record (hash, framed log, exit 0, not timed out) whose command equals
  the acceptance's `proof_command`; each live acceptance has exactly a `live:` link record to
  its check's record. The compliance trace supplies only the per-id PASS/FAIL judgement and the
  static evidence; each static evidence file equals or lies inside a frozen `evidence_paths`
  entry, and an exempt P0 acceptance cites at least one `alternate_evidence_paths` entry;
- negative controls, one record per `isolated_mutation` acceptance (a NOT RUN or missing one is
  exit 1 naming the id): integer exit codes; baseline exit 0 and not timed out; mutated exit not
  0, not 124/126/127, below 128, not timed out; patch nonempty and its hash matches;
  `mutated_paths` re-derived from the patch bytes equal the recorded list; the patch applies to
  `reviewed_sha` without touching any work tree (`GIT_INDEX_FILE=<tmp> git read-tree
  <reviewed_sha> && git apply --cached --check`); every mutated path is inside an `owned_paths`
  entry of that requirement's components, none under `test_paths`, none in any `tests_added` of
  the build history and none named in the proof command; `phase_elapsed_s` within the total
  limit; all logs hashed. These records are attested evidence, not semantic proof (an
  undeclared test file inside owned code is not caught). `exempt` controls are copied into the
  proof as recorded exemptions with their reasons and counts;
- every v2 proof records `design_commit` and `design_paths` (from the preflight), `reviewers`
  (per approval gate from the ledger, plus the derived build and verify reviewers),
  `fallback_used`, `cross_family` (false when any of those reviews was the Opus fallback) and
  `repo_config`;
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
result echoes `cross_family`, `fallback_used` and `allow_no_ci`. On CI_RED (or verify
HEAD_MOVED) the main session saves the failure log outside the repo and reruns build
`contract: 2` with the same frozen args, `base_commit == design_commit`, a fresh `run_dir` and
`ci_failure_log_path`, then verify and land (SKILL.md).

### 6.7 Scope change after freeze
An authorized change to the canonical file after freeze is a new design run on a fresh work
branch from the trunk with `previous_design` = the earlier `design_commit` and repo path: new
revision, new approvals, new design commit; its `rev-0` is that blob whether or not the earlier
design was merged, so the `--previous` rules bind the new revision to every old id. Prior
implementation work is re-applied on top of the new design commit, so it falls inside the new
reviewed range. Old proofs fail `--previous-proof` and the identity checks.

## 7. Reconciliation rules (author prompts, enforced where mechanical)

- Fix a finding at the requirement/decision that owns it, in place. Keep IDs stable
  (enforced: `E_ID_REMOVED`, `E_ID_REACTIVATED` on every revision).
- New ID only for a genuinely distinct requirement. Never add `-fix`/`-v2`/`-final` IDs,
  "additional requirements" sections, or appendices (`E_SHADOW_ID`).
- Remove any id'd item (goal, non-goal, decision, invariant, component, accepted risk,
  requirement, acceptance) by setting `status: retired` with `retired_rationale`; never reuse
  its ID.
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
BLOCKS). The workflow decides the buckets, not the relay.

- Normalized finding: both gate functions emit `{ id, severity, confidence, iso_property,
  validation_status, title, detail, location }` (`location` a string), and one shared item
  formatter renders them for authors and fixers.
- Codex (`gateCodex`): the relay copies, with no judgement, each `result.json` finding's `id,
  severity, confidence, iso_property, validation.status, claim, evidence, location` plus the
  run's `verdict, verdict_reasons, model_verdict, outcome, unable_to_review,
  validation_outcome` (`validation.outcome`), `run_dir` and `result_sha256` (printed by
  `sha256sum` in the relay's block). The workflow maps `title` = claim, `detail` = evidence,
  `location` = `file:line` or the section name. A reply without `findings` or
  `model_verdict` is BLOCKED (relay inconsistency), never defaulted. A PASS needs `outcome`
  `ok` and `unable_to_review` null; any other outcome must carry verdict NEEDS_HUMAN or ERROR
  and BLOCKS with the runner's reason; for `ok` the workflow recomputes the verdict with its
  copy of `computeVerdict` and BLOCKS when it differs.
- Fallback (`gateFallback`): the reviewer self-validates; the workflow assigns ids `F1, F2, ...`
  in reply order, counts each BLOCKING/MAJOR as `confirmed` and each MINOR/NIT as
  `not_required`, and the same function decides (model verdict = the rule's own, so it never
  disagrees).
- The copies of `computeTriggers`/`computeVerdict` in the three workflows and in
  `scripts/lib/gate-rule.js` are byte-identical to `run-review.js`'s.

Two documented differences, both on the codex path only and both unchanged from today:
(1) `model_rule_disagreement` (including a trigger that codex's validation refuted after the
model judged it): stricter, BLOCKED or a round where the fallback PASSes; (2) unvalidated
findings (the validation call failed or omitted an id): a non-trigger MAJOR left unvalidated
goes to `other_findings`, so codex can PASS where the fallback goes to a fix/revise round
(looser), and a trigger left unvalidated gives NEEDS_HUMAN, so BLOCKED where the fallback gives
FAIL and a fix round (stops for a human instead).

## 10. What each layer proves

- Parser/schema/graph tests: structure only.
- Model reviews (codex, or the disclosed Opus fallback): semantic adequacy (missing intent,
  contradictions in prose, paraphrased duplicates). Schema validation never claims these.
- Approval and completion checks: relayed hashes, relayed verdicts and stale combinations are
  caught by scripts that re-derive them from snapshots, review files and git: every design
  approval record (`--mode approvals`) and, under `contract: 2`, the last round of every build
  and verify review step (6.5). Under `contract: 1` the build and verify review relays are
  checked only for internal consistency (section 9). Files that are script-written but
  agent-invoked (`inputs.json`, `fallback-review.json`, wrapped fallback replies, run-frozen
  records, the `result.json` a relay reads) and evidence logs are host attestations, as in v1:
  a deliberately forged one is not caught.
- Suite: its exit code is bound to the run-frozen record (6.5); the failing test ids and
  `other_failures` behind it are read from the framed log by a model, so which known failure
  excused a nonzero exit, and whether a non-test step also failed, are attested.
- Not enforced by any script: network access and cost of a live check beyond its measured
  wall time; those ceilings are environment-level.
- Live end-to-end runs: actual agentic behaviour. Mocked workflow tests are labelled mocked.
