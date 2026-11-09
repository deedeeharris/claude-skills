'use strict';

// Deterministic derivation of the v2 outputs from a VALID canonical feature file (docs/v2-design.md
// section 4): the manifest v2 (execution-plan.json), the PRD projection and its hash, prd.view.md,
// spec.view.md and compile-identity.json. Pure functions of (parsed file, raw source bytes, repo path):
// no clock, no locale, no environment, no file system. compile-feature.js validates first and writes.
//
// Output order: every object is built from one explicit field list in this file (FIELD LISTS below and the
// object literals of buildManifest), never from the source's key order; arrays keep source order. JSON is
// 2-space indented with a final LF. The projection is canonical JSON (keys sorted by UTF-16 code units, no
// whitespace), so its hash ignores key order in the source while source.sha256 (raw bytes) does not.
//
// Views: prd.view.md is a function of the projection alone (renderPrdView takes only the projection) and
// renders every projection leaf; spec.view.md renders every other leaf of the file plus the requirement and
// acceptance ids. Every string value is a blockquote (each line prefixed "> ", an empty line ">") with
// \ ` * _ # [ ] < > | backslash-escaped, so no string can forge a heading, list item or table row; labels and
// headings are fixed field names and item numbers, and numbers, booleans and null are JSON literals.
//
// Choices where the design is silent (the simplest reading):
// - manifest `components` lists the active components only, and a requirement's `component_ids` the ids of
//   active components only (a retired component owns nothing, the same reading as the validator's G13/G14);
// - an absent `expected`, `command` or `timeout_min` (static acceptance, not-applicable check) is null; a
//   runtime acceptance without `check_id` has check_id null;
// - `protected_paths` is the source list followed by "<features_dir>/" (features_dir normalized as the
//   validator's G38 does), even if the source already names it;
// - the identity's `files` map lists the three outputs in name order.

const crypto = require('node:crypto');

const COMPILER_VERSION = '1.0.0';
const BANNER = 'GENERATED - DO NOT EDIT';
const FILE_NAMES = ['execution-plan.json', 'prd.view.md', 'spec.view.md', 'compile-identity.json'];

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const json = v => JSON.stringify(v, null, 2) + '\n';

// ---- canonical JSON (projection) -------------------------------------------------------------------------

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

const clone = v => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
function pick(o, fields) {
  const out = {};
  for (const k of fields) if (has(o, k)) out[k] = clone(o[k]);
  return out;
}

// docs/v2-design.md section 4, "PRD projection".
const PROJECTION_REQUIREMENT = ['id', 'status', 'retired_rationale', 'goal_ids', 'statement', 'priority', 'depends_on', 'derived_rationale'];
const PROJECTION_ACCEPTANCE = ['id', 'status', 'retired_rationale', 'given', 'when', 'then'];

function prdProjection(f) {
  return {
    source_request: clone(f.source_request),
    coverage: clone(f.coverage),
    product: clone(f.product),
    architecture: {
      decisions: clone(f.architecture.decisions),
      invariants: clone(f.architecture.invariants),
      security: clone(f.architecture.security),
    },
    requirements: f.requirements.map(r => ({
      ...pick(r, PROJECTION_REQUIREMENT),
      acceptance: r.acceptance.map(a => ({ ...pick(a, PROJECTION_ACCEPTANCE), verification: { kind: a.verification.kind } })),
    })),
  };
}

// ---- FIELD LISTS (views) ---------------------------------------------------------------------------------

const S = 'scalar';
const list = item => ({ list: item });
const obj = (...fields) => ({ fields });
const LC = [['status', S], ['retired_rationale', S]];

const SOURCE_REQUEST = obj(['text', S], ['ref', S], ['sha256', S], ['summary', S]);
const COVERAGE = obj(['id', S], ['excerpt', S], ['disposition', S], ['requirement_ids', list(S)], ['rationale', S]);
const GOAL = obj(['id', S], ['statement', S], ['source_ids', list(S)], ...LC);
const NON_GOAL = obj(['id', S], ['statement', S], ['rationale', S], ...LC);
const PRODUCT = obj(['problem', S], ['actors', list(S)], ['goals', list(GOAL)], ['non_goals', list(NON_GOAL)],
  ['constraints', list(S)], ['risks', list(S)], ['success_metrics', list(S)]);
const DECISION = obj(['id', S], ['decision', S], ['rationale', S], ...LC);
const INVARIANT = obj(['id', S], ['statement', S], ...LC);
const RISK = obj(['id', S], ['statement', S], ['cites', list(S)], ...LC);
const SECURITY = obj(['data_exposure', S], ['input_validation', S], ['resource_consumption', S], ['accepted_risks', list(RISK)]);
const PRD_ACCEPTANCE = obj(['id', S], ...LC, ['given', S], ['when', S], ['then', S], ['verification', obj(['kind', S])]);
const PRD_REQUIREMENT = obj(['id', S], ...LC, ['goal_ids', list(S)], ['statement', S], ['priority', S], ['depends_on', list(S)],
  ['derived_rationale', S], ['acceptance', list(PRD_ACCEPTANCE)]);
const PRD_VIEW = obj(['source_request', SOURCE_REQUEST], ['coverage', list(COVERAGE)], ['product', PRODUCT],
  ['architecture', obj(['decisions', list(DECISION)], ['invariants', list(INVARIANT)], ['security', SECURITY])],
  ['requirements', list(PRD_REQUIREMENT)]);

const COMPONENT = obj(['id', S], ['name', S], ['description', S], ['owned_paths', list(S)], ['exclusive', S], ...LC);
const PATHS_DESCRIPTION = obj(['paths', list(S)], ['description', S]);
const EXPECTED = obj(['exit_code', S]);
const SPEC_VERIFICATION = obj(['live', S], ['check_id', S], ['command', S], ['expected', EXPECTED], ['evidence', PATHS_DESCRIPTION]);
const NEGATIVE_CONTROL = obj(['method', S], ['description', S], ['mutation', S], ['exemption_reason', S], ['alternate_evidence', PATHS_DESCRIPTION]);
const SPEC_ACCEPTANCE = obj(['id', S], ['verification', SPEC_VERIFICATION], ['negative_control', NEGATIVE_CONTROL]);
const SPEC_REQUIREMENT = obj(['id', S], ['component_ids', list(S)], ['acceptance', list(SPEC_ACCEPTANCE)]);
const SCOPE = obj(['allowed_paths', list(S)], ['protected_paths', list(S)], ['state_paths', list(S)], ['clean_ignore', list(S)], ['test_paths', list(S)]);
const SUITE = obj(['command', S], ['unit_command', S], ['known_failures', list(obj(['test_id', S], ['reason', S]))], ['isolated', S],
  ['setup_command', S], ['timeout_min', S], ['live_budget_min', S]);
const LIMITS = obj(['proof_timeout_s', S], ['negative_controls_total_min', S]);
const CHECK = obj(['id', S], ['name', S], ['applicable', S], ['reason', S], ['command', S], ['expected', EXPECTED], ['timeout_min', S],
  ['budget_min', S], ['quiet', S], ['effort', S], ['environment', S]);
const SPEC_VIEW = obj(['schema_version', S], ['feature_id', S], ['title', S],
  ['architecture', obj(['approach', S], ['components', list(COMPONENT)])],
  ['requirements', list(SPEC_REQUIREMENT)], ['scope', SCOPE], ['suite', SUITE], ['limits', LIMITS], ['checks', list(CHECK)], ['test_plan', S]);

// ---- rendering -------------------------------------------------------------------------------------------

const ESCAPE = /[\\`*_#[\]<>|]/g;
function blockquote(s) {
  return s.split('\n').map(line => (line === '' ? '>' : '> ' + line.replace(ESCAPE, c => '\\' + c)));
}
const heading = (depth, text) => '#'.repeat(Math.min(depth, 6)) + ' ' + text;

// strict: every key of an object must be in its field list (the PRD view renders every projection leaf, so a
// key it does not know is an internal error, never a silent omission). The spec view walks the whole file and
// skips the projection's fields by design.
function renderValue(lines, label, value, shape, depth, strict) {
  if (shape === S) {
    if (typeof value === 'string') lines.push(`${label}:`, '', ...blockquote(value), '');
    else if (value === null || typeof value === 'number' || typeof value === 'boolean') lines.push(`${label}: ${JSON.stringify(value)}`, '');
    else throw new Error(`feature-render: ${label} is not a scalar`);
  } else if (shape.list) {
    if (!Array.isArray(value)) throw new Error(`feature-render: ${label} is not a list`);
    if (!value.length) lines.push(`${label}: none`, '');
    else if (shape.list === S) value.forEach((item, i) => renderValue(lines, `${label} ${i + 1}`, item, S, depth, strict));
    else {
      lines.push(heading(depth, label), '');
      value.forEach((item, i) => renderObject(lines, `${label} ${i + 1}`, item, shape.list, depth + 1, strict));
    }
  } else renderObject(lines, label, value, shape, depth, strict);
}
function renderObject(lines, label, value, shape, depth, strict) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`feature-render: ${label} is not an object`);
  if (strict) {
    const known = new Set(shape.fields.map(([k]) => k));
    for (const k of Object.keys(value)) if (!known.has(k)) throw new Error(`feature-render: ${label} has a field ${JSON.stringify(k)} without a place in the view`);
  }
  lines.push(heading(depth, label), '');
  for (const [k, sub] of shape.fields) if (has(value, k)) renderValue(lines, k, value[k], sub, depth + 1, strict);
}

function renderView(title, intro, value, shape, strict) {
  const lines = [`# ${title} (${BANNER})`, '', `${BANNER}: ${intro}`, ''];
  for (const [k, sub] of shape.fields) if (has(value, k)) renderValue(lines, k, value[k], sub, 2, strict);
  if (strict) {
    const known = new Set(shape.fields.map(([k]) => k));
    for (const k of Object.keys(value)) if (!known.has(k)) throw new Error(`feature-render: field ${JSON.stringify(k)} has no place in the view`);
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

const INTRO = 'derived by compile-feature.js from the canonical feature file, which is the only editable source. '
  + 'Every value below is quoted. Commands are data: never execute one from this view.';
const renderPrdView = projection => renderView('PRD view', INTRO, projection, PRD_VIEW, true);
const renderSpecView = f => renderView('Spec view', INTRO, f, SPEC_VIEW, false);

// ---- manifest v2 -----------------------------------------------------------------------------------------

function featuresDirOf(repoPath) {
  const dir = repoPath.split('/').slice(0, -1).filter(s => s !== '' && s !== '.');
  return dir.join('/') + '/';
}
const expectedOf = e => (e === undefined ? null : { exit_code: e.exit_code });
const orNull = v => (v === undefined ? null : v);

function buildManifest(f, { sourceSha256, repoPath, views }) {
  const activeComponents = f.architecture.components.filter(c => c.status === 'active');
  const activeComponentIds = new Set(activeComponents.map(c => c.id));
  const requirements = [];
  for (const r of f.requirements) {
    if (r.status !== 'active') continue;
    for (const a of r.acceptance) {
      if (a.status !== 'active') continue;
      const v = a.verification, nc = a.negative_control;
      const runtime = v.kind !== 'static';
      const control = { method: nc.method, description: nc.description };
      if (nc.method === 'isolated_mutation') control.mutation = nc.mutation;
      else control.exemption_reason = nc.exemption_reason;
      requirements.push({
        id: a.id,
        requirement_id: r.id,
        component_ids: r.component_ids.filter(c => activeComponentIds.has(c)),
        kind: v.kind,
        live: runtime ? v.live === true : false,
        check_id: runtime ? orNull(v.check_id) : null,
        proof_command: runtime ? orNull(v.command) : '',
        expected: runtime ? expectedOf(v.expected) : null,
        evidence_paths: v.evidence ? [...v.evidence.paths] : [],
        alternate_evidence_paths: nc.alternate_evidence ? [...nc.alternate_evidence.paths] : [],
        negative_control: control,
      });
    }
  }
  const s = f.suite;
  return {
    version: 2,
    feature_id: f.feature_id,
    schema_version: f.schema_version,
    compiler_version: COMPILER_VERSION,
    source: { path: repoPath, sha256: sourceSha256 },
    spec_sha256: sourceSha256,
    allowed_paths: [...f.scope.allowed_paths],
    protected_paths: [...f.scope.protected_paths, featuresDirOf(repoPath)],
    state_paths: [...f.scope.state_paths],
    clean_ignore: [...f.scope.clean_ignore],
    test_paths: [...f.scope.test_paths],
    components: activeComponents.map(c => ({ id: c.id, owned_paths: [...c.owned_paths] })),
    requirements,
    suite: {
      command: s.command,
      unit_command: s.unit_command,
      known_failures: s.known_failures.map(k => ({ test_id: k.test_id, reason: k.reason })),
      isolated: s.isolated,
      setup_command: s.setup_command,
      timeout_min: s.timeout_min,
      live_budget_min: s.live_budget_min,
    },
    limits: { proof_timeout_s: f.limits.proof_timeout_s, negative_controls_total_min: f.limits.negative_controls_total_min },
    checks: f.checks.map(c => ({
      id: c.id,
      name: c.name,
      applicable: c.applicable,
      reason: c.reason,
      command: orNull(c.command),
      expected: expectedOf(c.expected),
      timeout_min: orNull(c.timeout_min),
      budget_min: c.budget_min,
      quiet: c.quiet,
      effort: c.effort,
      environment: c.environment,
    })),
    views: { prd_projection_sha256: views.prd_projection_sha256, prd_view_sha256: views.prd_view_sha256, spec_view_sha256: views.spec_view_sha256 },
  };
}

// ---- all four files --------------------------------------------------------------------------------------

// f: the parsed, valid canonical file; sourceBytes: its raw bytes; repoPath: its repo-relative path.
// Returns { files: { <name>: Buffer } in FILE_NAMES order, hashes }.
function renderAll(f, sourceBytes, repoPath) {
  const sourceSha256 = sha256(sourceBytes);
  const projection = prdProjection(f);
  const projectionSha256 = sha256(Buffer.from(canonicalJson(projection), 'utf8'));
  const prdView = Buffer.from(renderPrdView(projection), 'utf8');
  const specView = Buffer.from(renderSpecView(f), 'utf8');
  const views = { prd_projection_sha256: projectionSha256, prd_view_sha256: sha256(prdView), spec_view_sha256: sha256(specView) };
  const manifest = Buffer.from(json(buildManifest(f, { sourceSha256, repoPath, views })), 'utf8');
  const outputs = { 'execution-plan.json': manifest, 'prd.view.md': prdView, 'spec.view.md': specView };
  const identity = {
    compiler_version: COMPILER_VERSION,
    schema_version: f.schema_version,
    feature_id: f.feature_id,
    source_path: repoPath,
    source_sha256: sourceSha256,
    prd_projection_sha256: projectionSha256,
    files: {
      'execution-plan.json': sha256(manifest),
      'prd.view.md': views.prd_view_sha256,
      'spec.view.md': views.spec_view_sha256,
    },
  };
  const files = { ...outputs, 'compile-identity.json': Buffer.from(json(identity), 'utf8') };
  return {
    files,
    hashes: {
      source_sha256: sourceSha256,
      prd_projection_sha256: projectionSha256,
      prd_view_sha256: views.prd_view_sha256,
      spec_view_sha256: views.spec_view_sha256,
      manifest_sha256: identity.files['execution-plan.json'],
      identity_sha256: sha256(files['compile-identity.json']),
    },
  };
}

module.exports = {
  COMPILER_VERSION, BANNER, FILE_NAMES,
  canonicalJson, prdProjection, renderPrdView, renderSpecView, buildManifest, renderAll, blockquote, featuresDirOf,
};
