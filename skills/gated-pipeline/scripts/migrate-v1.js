#!/usr/bin/env node
'use strict';

// v1 -> v2 import (docs/v2-design.md section 8). Read-only on its inputs.
// usage: migrate-v1.js --manifest <v1 execution-plan.json> --spec <spec.md> [--prd <prd.md>]
//          [--source-request <original request file>] --feature-id <id> --out <draft.json>
//
// Writes a DRAFT v2 canonical feature file to --out and <out>.report.json:
//   { migrator_version, feature_id, inputs: [ { role, path, sha256 } ], mapping[], todos[], conflicts[],
//     unmapped_tests[], lost[], provenance_missing }
// - mapping: one entry per v1 acceptance id, in manifest order: { v1_id, acceptance_id, requirement_id, kind,
//   renamed, v1_proof_command, command } (command = the draft's runtime command, null for static). A v1 id
//   already of the v2 form <REQ>-ACn is kept exactly; a v1 id of the requirement form <REQ> becomes <REQ>-AC1;
//   any other id becomes its own requirement MIG-NNN with acceptance MIG-NNN-AC1 (renamed: true).
// - todos: { path, reason } for every draft field whose value is the literal MIGRATION-TODO, and only those.
//   Every field the v1 inputs do not determine holds the token, whatever its type (a string, boolean, integer
//   or enum field), so the draft never validates until a human or an authorized review fills it (the
//   validator: E_MIGRATION_TODO for strings, a schema code for the others). Copied, never invented: the
//   acceptance ids, runtime proof commands, kinds, scope lists, check names, applicability and reasons, the
//   title (the first H1) and the original request text.
// - conflicts: acceptance ids only in spec.md (only_in_spec) or only in the manifest (only_in_manifest), proof
//   commands that differ (proof_command_differs: a code span or fenced line next to the id in spec.md, none
//   equal to the manifest command), and a spec.md that does not hash to the manifest spec_sha256.
// - unmapped_tests: test files named by spec.md or by a manifest command that appear in no runtime proof
//   command of the draft, with their sources (spec.md:<line>, manifest:<v1 id>).
// - lost: spec.md/prd.md sections whose heading names no v2 field.
// - provenance_missing: true when there is no prd.md or no original request.
// Prints { status: "DRAFT_WRITTEN", draft_path, report_path, todos, conflicts, unmapped_tests, lost,
// provenance_missing }. Exit 0 means "draft written", never "certified"; exit 2 is a usage or setup error
// (the reason on stderr, nothing on stdout, nothing written). It never executes a string from its inputs.
//
// Choices where the design is silent (the simplest reading):
// - --source-request is an optional addition: the design names "no original request" as a provenance gap but
//   gives the CLI no way to pass one; with it the draft carries { text } (one trailing newline removed);
// - --feature-id must equal the manifest feature_id; both files are written once (an existing --out or
//   report is refused) next to each other, in an existing directory;
// - a v1 runtime negative control is "the code mutation that must make that proof fail" (v1 design prompt),
//   so it becomes method isolated_mutation; a static one must be exempt (G24). Their prose stays a todo;
// - one placeholder SRC, goal and component carry every migrated requirement, so the draft's graph is whole;
//   a mapped spec.md/prd.md section of a list field (non-goals, decisions, invariants, constraints, risks,
//   accepted risks) gets one placeholder item; with no such section the list stays empty;
// - section headings map to fields by keyword (SECTION_RULES below); the first H1 of a file is the title.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parse, StrictJsonError } = require('./lib/strict-json.js');
const { writeOnce, Refusal, SetupError } = require('./write-json.js');

const MIGRATOR_VERSION = '1.0.0';
const TOKEN = 'MIGRATION-TODO';
const FLAGS = ['manifest', 'spec', 'prd', 'source-request', 'feature-id', 'out'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ACC_V2 = /^((?!(?:GOAL|NG|DEC|INV|SRC|RISK|CHECK|COMP)-)[A-Z][A-Z0-9]*-[0-9]{3})-AC([0-9]+)$/;
const REQ_V2 = /^(?!(?:GOAL|NG|DEC|INV|SRC|RISK|CHECK|COMP)-)[A-Z][A-Z0-9]*-[0-9]{3}$/;
const ACC_GENERIC = '[A-Z][A-Z0-9]*-[0-9]{3}-AC[0-9]+';

// Heading keyword -> v2 field (JSON Pointer), first match wins. `list` fields get one placeholder item.
const SECTION_RULES = {
  'prd.md': [
    [/non[- ]?goals?|out of scope/, '/product/non_goals'],
    [/problem/, '/product/problem'],
    [/\b(actors?|users?|who|personas?|audience)\b/, '/product/actors'],
    [/success|metrics?|criteria/, '/product/success_metrics'],
    [/constraints?/, '/product/constraints'],
    [/risks?/, '/product/risks'],
    [/security|threat/, '/architecture/security'],
    [/goals?|behaviou?r|requirements?|scope|features?/, '/product/goals'],
  ],
  'spec.md': [
    [/non[- ]?goals?|out of scope/, '/product/non_goals'],
    [/protected/, '/scope/protected_paths'],
    [/test plan|testing|\btests?\b/, '/test_plan'],
    [/acceptance|proofs?|checks?|verification|negative controls?/, '/requirements'],
    [/files?|scope|paths?/, '/scope/allowed_paths'],
    [/invariants?/, '/architecture/invariants'],
    [/accepted risks?/, '/architecture/security/accepted_risks'],
    [/security|threat/, '/architecture/security'],
    [/decisions?/, '/architecture/decisions'],
    [/risks?/, '/product/risks'],
    [/budget|live|paid/, '/suite/live_budget_min'],
    [/constraints?/, '/product/constraints'],
    [/approach|design|architecture|overview|summary|implementation|components?/, '/architecture/approach'],
  ],
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!FLAGS.includes(flag)) throw new SetupError(`unknown argument ${JSON.stringify(argv[i])}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new SetupError(`--${flag} needs a value`);
    if (Object.hasOwn(args, flag)) throw new SetupError(`--${flag} given twice`);
    args[flag] = argv[i + 1];
  }
  for (const k of ['manifest', 'spec', 'feature-id', 'out']) if (!args[k]) throw new SetupError(`--${k} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(args['feature-id']) || /^\.+$/.test(args['feature-id'])) throw new SetupError('--feature-id must match [A-Za-z0-9._-]+');
  return args;
}

function readBytes(file, what) {
  try { return fs.readFileSync(file); } catch (e) { throw new SetupError(`cannot read ${what} ${file}: ${e.code || e.message}`); }
}
function readText(file, what) {
  const bytes = readBytes(file, what);
  try { return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch {
    throw new SetupError(`${what} ${file} is not valid UTF-8`);
  }
}

// The v1 manifest: strict JSON and the v1 shape (schemas/execution-plan.schema.json), else a setup error.
function readManifest(file) {
  const bytes = readBytes(file, 'manifest');
  let m;
  try { m = parse(bytes).value; } catch (e) {
    if (e instanceof StrictJsonError) throw new SetupError(`manifest ${file}: ${e.code} at "${e.path}": ${e.message}`);
    throw e;
  }
  const bad = why => { throw new SetupError(`manifest ${file} is not a v1 execution plan: ${why}`); };
  if (!isObject(m)) bad('not an object');
  if (m.version !== 1) bad('version must be 1');
  if (typeof m.feature_id !== 'string' || !m.feature_id) bad('feature_id');
  if (typeof m.spec_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.spec_sha256)) bad('spec_sha256');
  for (const k of ['allowed_paths', 'protected_paths', 'state_paths', 'clean_ignore']) {
    if (m[k] === undefined && (k === 'state_paths' || k === 'clean_ignore')) continue;
    if (!Array.isArray(m[k]) || !m[k].every(p => typeof p === 'string')) bad(k);
  }
  if (!Array.isArray(m.requirements) || !m.requirements.length) bad('requirements');
  const ids = new Set();
  for (const r of m.requirements) {
    if (!isObject(r) || typeof r.id !== 'string' || !r.id || !['runtime', 'static'].includes(r.kind) || typeof r.proof_command !== 'string') bad('a requirement needs id, kind runtime|static and proof_command');
    if (ids.has(r.id)) bad(`duplicate acceptance id ${r.id}`);
    ids.add(r.id);
  }
  if (!Array.isArray(m.checks) || !m.checks.every(c => isObject(c) && typeof c.name === 'string' && c.name && typeof c.applicable === 'boolean' && typeof c.reason === 'string')) bad('checks');
  return { bytes, value: m };
}

// ---- Markdown reading -------------------------------------------------------------------------------------
// Lines with their fence state; a fenced line is attached to the nearest preceding non-blank unfenced line.
function readLines(text) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const out = [];
  let fence = null, anchor = -1;
  lines.forEach((l, i) => {
    const m = /^\s*(```+|~~~+)/.exec(l);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) { fence = null; out.push({ n: i + 1, text: l, kind: 'fence-mark' }); }
      else out.push({ n: i + 1, text: l, kind: 'fenced', anchor });
      return;
    }
    if (m) { fence = m[1]; out.push({ n: i + 1, text: l, kind: 'fence-mark' }); return; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) { out.push({ n: i + 1, text: l, kind: 'heading', level: h[1].length, heading: h[2] }); anchor = -1; return; }
    if (l.trim()) anchor = out.length;
    out.push({ n: i + 1, text: l, kind: 'text' });
  });
  return out;
}

// Sections: { file, heading, level, line, body } plus a preamble (heading null) when text precedes any heading.
function sections(file, lines) {
  const out = [];
  let cur = { file, heading: null, level: 0, line: null, body: [] };
  for (const l of lines) {
    if (l.kind === 'heading') { out.push(cur); cur = { file, heading: l.heading, level: l.level, line: l.n, body: [] }; continue; }
    cur.body.push(l);
  }
  out.push(cur);
  return out.filter(s => s.heading !== null || s.body.some(l => l.text.trim()));
}

// Section -> v2 field, or null (lost). The first H1 of a file is the title.
function mapSections(secs) {
  let titleSeen = false;
  return secs.map(s => {
    if (s.heading === null) return { ...s, field: null, line: s.body.find(l => l.text.trim()).n };
    if (s.level === 1 && !titleSeen) { titleSeen = true; return { ...s, field: '/title' }; }
    const h = s.heading.toLowerCase();
    const rule = SECTION_RULES[s.file].find(([re]) => re.test(h));
    return { ...s, field: rule ? rule[1] : null };
  });
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idShape = id => id.split(/([0-9]+)/).map((part, i) => i % 2 ? '[0-9]+' : escapeRe(part)).join('');
const codeSpans = text => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1].trim());
const looksLikeCommand = s => /\s/.test(s);

// Test file names in a text: a path token with an extension under a test directory, or a test-named file.
function testFiles(text) {
  const out = [];
  for (const m of String(text).matchAll(/[A-Za-z0-9_.@+/-]+/g)) {
    const p = m[0].replace(/^(\.\/)+/, '').replace(/\.+$/, '');
    if (!/\.[A-Za-z0-9]+$/.test(p) || p.startsWith('-') || p.startsWith('/')) continue;
    const segs = p.split('/');
    const base = segs[segs.length - 1];
    if (segs.slice(0, -1).some(s => /^(test|tests|__tests__|spec|specs)$/.test(s)) || /^test_|[._-](test|spec)\.[A-Za-z0-9]+$/.test(base)) out.push(p);
  }
  return out;
}

// ---- the draft ---------------------------------------------------------------------------------------------
function migrate({ manifest: m, specText, specSha, prdText, requestText }) {
  const todos = [];
  const hints = {};
  const todo = (pointer, reason) => {
    const extra = Object.keys(hints).filter(f => pointer === f || pointer.startsWith(f + '/')).flatMap(f => hints[f]);
    todos.push({ path: pointer, reason: reason + (extra.length ? ` (see ${extra.join('; ')})` : '') });
    return TOKEN;
  };

  // sections and their fields
  const specLines = readLines(specText);
  const prdLines = prdText === null ? null : readLines(prdText);
  const mapped = [...mapSections(sections('spec.md', specLines)), ...(prdLines ? mapSections(sections('prd.md', prdLines)) : [])];
  const lost = mapped.filter(s => s.field === null).map(s => ({ file: s.file, line: s.line, heading: s.heading }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  const hasSection = field => mapped.some(s => s.field === field);
  for (const s of mapped) if (s.field && s.field !== '/title') (hints[s.field] = hints[s.field] || []).push(`${s.file} ${JSON.stringify(s.heading)} (line ${s.line})`);
  const titleSec = mapped.find(s => s.field === '/title' && s.file === 'spec.md') || mapped.find(s => s.field === '/title');

  // acceptance ids: exact when already v2-shaped, else renamed
  const usedReq = new Set(), usedAcc = new Set();
  for (const r of m.requirements) { const a = ACC_V2.exec(r.id); if (a) { usedReq.add(a[1]); usedAcc.add(r.id); } else if (REQ_V2.test(r.id)) usedReq.add(r.id); }
  let mig = 0;
  const nextMig = () => { let id; do id = `MIG-${String(++mig).padStart(3, '0')}`; while (usedReq.has(id)); usedReq.add(id); return id; };
  const nextAc = req => { let n = 0, id; do id = `${req}-AC${++n}`; while (usedAcc.has(id)); usedAcc.add(id); return id; };
  const ids = m.requirements.map(r => {
    const a = ACC_V2.exec(r.id);
    if (a) return { req: a[1], acc: r.id, renamed: false };
    if (REQ_V2.test(r.id)) return { req: r.id, acc: nextAc(r.id), renamed: true };
    const req = nextMig();
    return { req, acc: nextAc(req), renamed: true };
  });
  const reqOrder = [];
  ids.forEach(x => { if (!reqOrder.includes(x.req)) reqOrder.push(x.req); });

  const requirements = [];
  const mapping = [];
  reqOrder.forEach((reqId, qi) => {
    const base = `/requirements/${qi}`;
    const members = m.requirements.map((r, i) => ({ r, x: ids[i] })).filter(({ x }) => x.req === reqId);
    const label = members.map(({ r }) => r.id).join(', ');
    const q = {
      id: reqId, status: 'active', goal_ids: ['GOAL-001'],
      statement: todo(`${base}/statement`, `state the requirement behind v1 acceptance ${label}`),
      priority: todo(`${base}/priority`, 'v1 has no priority: P0, P1 or P2'),
      depends_on: [], component_ids: ['COMP-MIGRATED'], acceptance: [],
    };
    members.forEach(({ r, x }, ai) => {
      const p = `${base}/acceptance/${ai}`;
      const a = { id: x.acc, status: 'active' };
      for (const k of ['given', 'when', 'then']) a[k] = todo(`${p}/${k}`, `the ${k} of v1 acceptance ${r.id}${x.renamed ? ` (renamed ${x.acc})` : ''}`);
      let command = null;
      if (r.kind === 'runtime') {
        const cmd = r.proof_command;
        command = !cmd.trim() ? todo(`${p}/verification/command`, `v1 runtime acceptance ${r.id} has an empty proof command`)
          : /[\r\n]/.test(cmd) ? todo(`${p}/verification/command`, `v1 runtime acceptance ${r.id} has a multi-line proof command: ${JSON.stringify(cmd)}`) : cmd;
        a.verification = { kind: 'runtime', live: todo(`${p}/verification/live`, `v1 does not say whether ${r.id} makes live or paid calls (true needs a check_id)`), command, expected: { exit_code: 0 } };
        a.negative_control = { method: 'isolated_mutation', description: todo(`${p}/negative_control/description`, `the negative control of v1 acceptance ${r.id}`),
          mutation: todo(`${p}/negative_control/mutation`, `the code mutation that must make the proof of ${r.id} fail`) };
      } else {
        const from = r.proof_command.trim() ? ` (v1 static proof: ${JSON.stringify(r.proof_command)})` : '';
        a.verification = { kind: 'static', evidence: {
          paths: [todo(`${p}/verification/evidence/paths/0`, `the evidence paths of static acceptance ${r.id}${from}`)],
          description: todo(`${p}/verification/evidence/description`, `what the evidence of ${r.id} shows${from}`) } };
        a.negative_control = { method: 'exempt', description: todo(`${p}/negative_control/description`, `the negative control of static acceptance ${r.id}`),
          exemption_reason: todo(`${p}/negative_control/exemption_reason`, `why static acceptance ${r.id} has no mutation`) };
      }
      q.acceptance.push(a);
      mapping.push({ v1_id: r.id, acceptance_id: x.acc, requirement_id: reqId, kind: r.kind, renamed: x.renamed, v1_proof_command: r.proof_command,
        command: r.kind === 'runtime' ? command : null });
    });
    requirements.push(q);
  });
  // mapping in manifest order
  mapping.sort((a, b) => m.requirements.findIndex(r => r.id === a.v1_id) - m.requirements.findIndex(r => r.id === b.v1_id));

  const noPrd = prdText === null ? ' (no prd.md)' : '';
  const placeholder = (field, make) => hasSection(field) ? [make(`${field}/0`)] : [];
  const draft = {
    schema_version: 2,
    feature_id: m.feature_id,
    title: titleSec ? titleSec.heading : todo('/title', 'no H1 heading in spec.md or prd.md'),
    source_request: { text: requestText !== null ? requestText.replace(/\r?\n$/, '') : todo('/source_request/text', 'no original request: pass it with --source-request, or use the ref form') },
    coverage: [{ id: 'SRC-001', excerpt: todo('/coverage/0/excerpt', 'placeholder source item covering every migrated requirement: split the request into its items'),
      disposition: 'covered', requirement_ids: [...reqOrder] }],
    product: {
      problem: todo('/product/problem', 'the problem' + noPrd),
      actors: [todo('/product/actors/0', 'who has the problem' + noPrd)],
      goals: [{ id: 'GOAL-001', statement: todo('/product/goals/0/statement', 'placeholder goal every migrated requirement points to' + noPrd), source_ids: ['SRC-001'], status: 'active' }],
      non_goals: placeholder('/product/non_goals', p => ({ id: 'NG-001', statement: todo(`${p}/statement`, 'a non-goal'), rationale: todo(`${p}/rationale`, 'why it is out of scope'), status: 'active' })),
      constraints: placeholder('/product/constraints', p => todo(p, 'a constraint')),
      risks: placeholder('/product/risks', p => todo(p, 'a risk')),
      success_metrics: [todo('/product/success_metrics/0', 'a measurable success criterion' + noPrd)],
    },
    architecture: {
      approach: todo('/architecture/approach', 'the technical approach'),
      decisions: placeholder('/architecture/decisions', p => ({ id: 'DEC-001', decision: todo(`${p}/decision`, 'a decision'), rationale: todo(`${p}/rationale`, 'its rationale'), status: 'active' })),
      invariants: placeholder('/architecture/invariants', p => ({ id: 'INV-001', statement: todo(`${p}/statement`, 'an invariant'), status: 'active' })),
      components: [{ id: 'COMP-MIGRATED', name: todo('/architecture/components/0/name', 'placeholder component every migrated requirement uses'),
        description: todo('/architecture/components/0/description', 'what the component is'),
        owned_paths: [todo('/architecture/components/0/owned_paths/0', 'the code this component owns (inside allowed_paths, outside test_paths)')],
        exclusive: todo('/architecture/components/0/exclusive', 'whether no other exclusive component may own these paths'), status: 'active' }],
      security: {
        data_exposure: todo('/architecture/security/data_exposure', 'data exposure and authorization scope'),
        input_validation: todo('/architecture/security/input_validation', 'input validation and length limits'),
        resource_consumption: todo('/architecture/security/resource_consumption', 'resource consumption and its server-side bound'),
        accepted_risks: placeholder('/architecture/security/accepted_risks', p => ({ id: 'RISK-001', statement: todo(`${p}/statement`, 'an accepted risk'), cites: [], status: 'active' })),
      },
    },
    requirements,
    scope: {
      allowed_paths: [...m.allowed_paths], protected_paths: [...m.protected_paths], state_paths: [...(m.state_paths || [])], clean_ignore: [...(m.clean_ignore || [])],
      test_paths: requirements.some(q => q.acceptance.some(a => a.negative_control.method === 'isolated_mutation'))
        ? [todo('/scope/test_paths/0', 'where the tests live (outside every owned path); isolated mutations need at least one')] : [],
    },
    suite: {
      command: todo('/suite/command', 'the v1 manifest has no suite: the full suite command (v1 kept it in pipeline.yaml tests.suite_cmd)'),
      unit_command: todo('/suite/unit_command', 'the v1 manifest has no suite: the focused test command (v1: tests.unit_cmd)'),
      known_failures: [],
      isolated: todo('/suite/isolated', 'whether the suite runs in a fresh worktree (v1: tests.suite_isolated)'),
      setup_command: todo('/suite/setup_command', 'the isolated setup command or null (v1: tests.isolated_setup)'),
      timeout_min: todo('/suite/timeout_min', 'the suite kill limit in minutes'),
      live_budget_min: todo('/suite/live_budget_min', 'the live/paid budget in minutes (0 for none)'),
    },
    limits: {
      proof_timeout_s: todo('/limits/proof_timeout_s', 'the per-proof kill limit in seconds (1-3600)'),
      negative_controls_total_min: todo('/limits/negative_controls_total_min', 'the total time for the negative-control phase in minutes'),
    },
    checks: [],
    test_plan: todo('/test_plan', 'the test plan (failing test first)'),
  };

  // checks: names, applicability and reasons copied; ids derived; the rest underivable (v1 kept commands in config)
  const usedCheck = new Set();
  m.checks.forEach((c, i) => {
    const p = `/checks/${i}`;
    let stem = 'CHECK-' + (c.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || String(i + 1));
    let id = stem, n = 1;
    while (usedCheck.has(id)) id = `${stem}-${++n}`;
    usedCheck.add(id);
    const ck = { id, name: c.name, applicable: c.applicable, reason: c.reason.trim() ? c.reason : todo(`${p}/reason`, `v1 check ${JSON.stringify(c.name)} has an empty reason`) };
    if (c.applicable) {
      ck.command = todo(`${p}/command`, `the command of v1 check ${JSON.stringify(c.name)} (v1 kept it in pipeline.yaml verify_checks)`);
      ck.expected = { exit_code: 0 };
      ck.timeout_min = todo(`${p}/timeout_min`, `the kill limit of ${JSON.stringify(c.name)} in minutes`);
    }
    ck.budget_min = todo(`${p}/budget_min`, `the live/paid budget of ${JSON.stringify(c.name)} in minutes (0 for none)`);
    ck.quiet = todo(`${p}/quiet`, `whether ${JSON.stringify(c.name)} waits for a quiet machine`);
    ck.effort = todo(`${p}/effort`, `the agent effort for ${JSON.stringify(c.name)}: low, medium or high`);
    ck.environment = todo(`${p}/environment`, `where ${JSON.stringify(c.name)} runs`);
    draft.checks.push(ck);
  });

  // ---- conflicts between spec.md and the manifest --------------------------------------------------------
  const conflicts = [];
  if (specSha !== m.spec_sha256) conflicts.push({ kind: 'spec_sha256_differs', id: null, manifest: m.spec_sha256, spec: specSha });
  const manifestIds = m.requirements.map(r => r.id);
  const families = [...new Set([ACC_GENERIC, ...manifestIds.map(idShape)])];
  const idRe = new RegExp(`(?<![A-Za-z0-9_-])(?:${families.join('|')})(?![A-Za-z0-9_-])`, 'g');
  const lineIds = specLines.map(l => l.kind === 'text' || l.kind === 'heading' ? [...new Set([...l.text.matchAll(idRe)].map(x => x[0]))] : []);
  const firstLine = {};
  lineIds.forEach((list, i) => list.forEach(id => { if (!(id in firstLine)) firstLine[id] = specLines[i].n; }));
  for (const id of Object.keys(firstLine)) if (!manifestIds.includes(id)) conflicts.push({ kind: 'only_in_spec', id, line: firstLine[id] });
  for (const id of manifestIds) if (!(id in firstLine)) conflicts.push({ kind: 'only_in_manifest', id });
  for (const r of m.requirements) {
    if (r.kind !== 'runtime' || !r.proof_command.trim()) continue;
    const cands = [];
    let line = null;
    specLines.forEach((l, i) => {
      if (lineIds[i].length !== 1 || lineIds[i][0] !== r.id) return;
      const found = [...codeSpans(l.text), ...specLines.filter(f => f.kind === 'fenced' && f.anchor === i).map(f => f.text.trim())].filter(looksLikeCommand);
      if (found.length && line === null) line = l.n;
      cands.push(...found);
    });
    if (cands.length && !cands.includes(r.proof_command.trim())) conflicts.push({ kind: 'proof_command_differs', id: r.id, line, manifest: r.proof_command, spec: [...new Set(cands)] });
  }
  conflicts.sort((a, b) => (a.id || '') < (b.id || '') ? -1 : (a.id || '') > (b.id || '') ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);

  // ---- unmapped tests --------------------------------------------------------------------------------------
  const mappedTests = new Set(mapping.filter(x => x.command && x.command !== TOKEN).flatMap(x => testFiles(x.command)));
  const tests = new Map();
  const note = (p, src) => { if (!tests.has(p)) tests.set(p, []); if (!tests.get(p).includes(src)) tests.get(p).push(src); };
  for (const l of specLines) for (const p of testFiles(l.text)) note(p, `spec.md:${l.n}`);
  for (const r of m.requirements) for (const p of testFiles(r.proof_command)) note(p, `manifest:${r.id}`);
  const unmapped_tests = [...tests].filter(([p]) => !mappedTests.has(p)).map(([p, sources]) => ({ path: p, sources }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  // todos in document order
  const order = [];
  const walk = (v, p) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}/${i}`)); else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, `${p}/${k}`); else if (v === TOKEN) order.push(p); };
  walk(draft, '');
  todos.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));

  return { draft, todos, mapping, conflicts, unmapped_tests, lost, provenance_missing: prdText === null || requestText === null };
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    const out = path.resolve(args.out);
    const reportPath = out + '.report.json';
    for (const p of [out, reportPath]) if (fs.existsSync(p) || isLink(p)) throw new SetupError(`${p} already exists; the draft and its report are written once`);
    const dir = path.dirname(out);
    if (!isDir(dir)) throw new SetupError(`output directory ${dir} does not exist`);
    const manifest = readManifest(args.manifest);
    if (manifest.value.feature_id !== args['feature-id']) throw new SetupError(`--feature-id ${args['feature-id']} differs from the manifest feature_id ${manifest.value.feature_id}`);
    const spec = readText(args.spec, 'spec');
    const prd = args.prd !== undefined ? readText(args.prd, 'prd') : null;
    const req = args['source-request'] !== undefined ? readText(args['source-request'], 'source request') : null;
    const r = migrate({ manifest: manifest.value, specText: spec.text, specSha: sha256(spec.bytes), prdText: prd && prd.text, requestText: req && req.text });
    const inputs = [['manifest', args.manifest, manifest.bytes], ['spec', args.spec, spec.bytes], ...(prd ? [['prd', args.prd, prd.bytes]] : []),
      ...(req ? [['source_request', args['source-request'], req.bytes]] : [])].map(([role, p, bytes]) => ({ role, path: path.resolve(p), sha256: sha256(bytes) }));
    const report = { migrator_version: MIGRATOR_VERSION, feature_id: args['feature-id'], inputs, mapping: r.mapping, todos: r.todos, conflicts: r.conflicts,
      unmapped_tests: r.unmapped_tests, lost: r.lost, provenance_missing: r.provenance_missing };
    writeOnce(out, Buffer.from(JSON.stringify(r.draft, null, 2) + '\n', 'utf8'));
    writeOnce(reportPath, Buffer.from(JSON.stringify(report, null, 2) + '\n', 'utf8'));
    process.stdout.write(JSON.stringify({ status: 'DRAFT_WRITTEN', draft_path: out, report_path: reportPath, todos: r.todos.length, conflicts: r.conflicts.length,
      unmapped_tests: r.unmapped_tests.length, lost: r.lost.length, provenance_missing: r.provenance_missing }) + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal) && !(e instanceof SetupError)) throw e;
    process.stderr.write(`migrate-v1: ${e.message}\n`);
    return 2;
  }
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { migrate, TOKEN, MIGRATOR_VERSION };
