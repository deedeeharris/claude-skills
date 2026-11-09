'use strict';

// Issue #37, plan 1a: the Opus fallback gate gives the same result as the codex path.
// MOCKED at the agent boundary only. Codex side: the real codex-review run-review.js with
// fake-codex.js on PATH (scenario "table"); the relay reply is a field projection of the
// real result.json (no bucketing here) fed through the real design, build and verify
// workflows. Fallback side: the fallback input (the findings as reported, minus those codex
// refuted) as the Opus reply through the same workflows. Expected columns are hand-written.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { test, after } = require('node:test');
const { run, sourceAt } = require('./helpers/run-workflow');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SKILLS = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(SKILLS, 'codex-review', 'scripts', 'run-review.js');
const FAKE = path.join(SKILLS, 'codex-review', 'tests', 'fake-codex.js');
const WORKFLOWS = path.join(__dirname, '..', 'workflows');
const BASE_REV = 'c186e5f';
const FALLBACK = 'claude-opus-high (codex unavailable)';
const sha = 'a'.repeat(40);
const base = 'c'.repeat(40);
const digest = 'b'.repeat(64);

// --- the table ---------------------------------------------------------------------------
// f(letter, severity, confidence, iso_property, codex validation of a BLOCKING/MAJOR:
// 'confirmed' | 'refuted' | 'missing' (its id left out of the validation reply)).
// Each finding's token (codex `claim`, fallback `title`) is tok-<row>-<letter>.
// run: 'ok' | 'validation-timeout' | 'validation-error' | 'unable' | 'review-timeout'.
// mv: model_verdict = the pre-validation rule over the findings as reported.
// codex / fallback: expected transition; implementation rows give [build, verify].
// forward: letters of the findings the revise/fix prompt must carry when a side continues.
const f = (letter, severity, confidence, iso = null, v = 'confirmed') => ({ letter, severity, confidence, iso, v });
const ROWS = [
  // implementation (build + verify)
  { id: 'i01', kind: 'implementation', name: 'MINOR only', mv: 'PASS', findings: [f('a', 'MINOR', 0.9)], codex: ['PASS', 'PASS'], fallback: ['PASS', 'PASS'], forward: [] },
  { id: 'i02', kind: 'implementation', name: 'NIT only', mv: 'PASS', findings: [f('a', 'NIT', 0.9)], codex: ['PASS', 'PASS'], fallback: ['PASS', 'PASS'], forward: [] },
  { id: 'i03', kind: 'implementation', name: 'MAJOR 0.85', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.85)], codex: ['fix', 'FAIL'], fallback: ['fix', 'FAIL'], forward: ['a'] },
  { id: 'i04', kind: 'implementation', name: 'MAJOR 0.6', mv: 'NEEDS_HUMAN', findings: [f('a', 'MAJOR', 0.6)], codex: ['fix', 'FAIL'], fallback: ['fix', 'FAIL'], forward: ['a'] },
  { id: 'i05', kind: 'implementation', name: 'MAJOR 0.3', mv: 'PASS', findings: [f('a', 'MAJOR', 0.3)], codex: ['fix', 'FAIL'], fallback: ['fix', 'FAIL'], forward: ['a'] },
  { id: 'i06', kind: 'implementation', name: 'BLOCKING 0.3', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.3)], codex: ['fix', 'FAIL'], fallback: ['fix', 'FAIL'], forward: ['a'] },
  { id: 'i07', kind: 'implementation', name: 'mixed BLOCKING + MAJOR 0.3 + MINOR', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.9), f('b', 'MAJOR', 0.3), f('c', 'MINOR', 0.9)], codex: ['fix', 'FAIL'], fallback: ['fix', 'FAIL'], forward: ['a', 'b'] },
  // documented difference (1): a trigger codex refuted leaves a model_rule_disagreement
  { id: 'i08', kind: 'implementation', name: 'lone refuted trigger', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, null, 'refuted')], codex: ['BLOCKED', 'BLOCKED'], fallback: ['PASS', 'PASS'], forward: [] },
  { id: 'i09', kind: 'implementation', name: 'lone refuted trigger + MINOR', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, null, 'refuted'), f('b', 'MINOR', 0.9)], codex: ['fix', 'BLOCKED'], fallback: ['PASS', 'PASS'], forward: ['b'] },
  // documented difference (2): unvalidated findings
  { id: 'i10', kind: 'implementation', name: 'MAJOR 0.3 unvalidated by timeout', run: 'validation-timeout', mv: 'PASS', findings: [f('a', 'MAJOR', 0.3)], codex: ['PASS', 'PASS'], fallback: ['fix', 'FAIL'], forward: ['a'] },
  { id: 'i11', kind: 'implementation', name: 'MAJOR 0.3 unvalidated by a missing id', mv: 'PASS', findings: [f('a', 'MAJOR', 0.3, null, 'missing')], codex: ['PASS', 'PASS'], fallback: ['fix', 'FAIL'], forward: ['a'] },
  { id: 'i12', kind: 'implementation', name: 'trigger with validation unavailable', run: 'validation-error', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9)], codex: ['BLOCKED', 'BLOCKED'], fallback: ['fix', 'FAIL'], forward: ['a'] },
  // codex only
  { id: 'i13', kind: 'implementation', name: 'unable_to_review set', run: 'unable', mv: 'PASS', findings: [], codex: ['BLOCKED', 'BLOCKED'], fallback: null, forward: [] },
  { id: 'i14', kind: 'implementation', name: 'review timeout', run: 'review-timeout', mv: 'PASS', findings: [], codex: ['BLOCKED', 'BLOCKED'], fallback: null, forward: [] },
  // prd (design)
  { id: 'p01', kind: 'prd', name: 'MINOR only', mv: 'PASS', findings: [f('a', 'MINOR', 0.95, 'ambiguous')], codex: 'PASS', fallback: 'PASS', forward: [] },
  { id: 'p02', kind: 'prd', name: 'NIT only', mv: 'PASS', findings: [f('a', 'NIT', 0.9)], codex: 'PASS', fallback: 'PASS', forward: [] },
  { id: 'p03', kind: 'prd', name: 'one MAJOR without ISO property', mv: 'PASS', findings: [f('a', 'MAJOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['a'] },
  { id: 'p04', kind: 'prd', name: 'one MAJOR with ISO property', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'incomplete')], codex: 'revise', fallback: 'revise', forward: ['a'] },
  { id: 'p05', kind: 'prd', name: 'two MAJOR without ISO property', mv: 'PASS', findings: [f('a', 'MAJOR', 0.9), f('b', 'MAJOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['a', 'b'] },
  { id: 'p06', kind: 'prd', name: 'two MAJOR with ISO property', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'ambiguous'), f('b', 'MAJOR', 0.9, 'inconsistent')], codex: 'revise', fallback: 'revise', forward: ['a', 'b'] },
  { id: 'p07', kind: 'prd', name: 'three MAJOR without ISO property', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9), f('b', 'MAJOR', 0.9), f('c', 'MAJOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['a', 'b', 'c'] },
  { id: 'p08', kind: 'prd', name: 'three MAJOR with ISO property', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'unverifiable'), f('b', 'MAJOR', 0.9, 'infeasible'), f('c', 'MAJOR', 0.9, 'incomplete')], codex: 'revise', fallback: 'revise', forward: ['a', 'b', 'c'] },
  { id: 'p09', kind: 'prd', name: 'MAJOR 0.6 without ISO property', mv: 'NEEDS_HUMAN', findings: [f('a', 'MAJOR', 0.6)], codex: 'revise', fallback: 'revise', forward: ['a'] },
  { id: 'p10', kind: 'prd', name: 'BLOCKING 0.3', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.3)], codex: 'revise', fallback: 'revise', forward: ['a'] },
  { id: 'p11', kind: 'prd', name: 'mixed BLOCKING + non-ISO MAJOR + MINOR', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.9), f('b', 'MAJOR', 0.9), f('c', 'MINOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['a', 'b'] },
  { id: 'p12', kind: 'prd', name: 'three MAJOR, one refuted', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, null, 'refuted'), f('b', 'MAJOR', 0.9), f('c', 'MAJOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['b', 'c'] },
  { id: 'p13', kind: 'prd', name: 'lone refuted trigger', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'ambiguous', 'refuted')], codex: 'BLOCKED', fallback: 'PASS', forward: [] },
  { id: 'p14', kind: 'prd', name: 'lone refuted trigger + MINOR', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'ambiguous', 'refuted'), f('b', 'MINOR', 0.9)], codex: 'revise', fallback: 'PASS', forward: ['b'] },
  { id: 'p15', kind: 'prd', name: 'lone non-ISO MAJOR unvalidated by timeout', run: 'validation-timeout', mv: 'PASS', findings: [f('a', 'MAJOR', 0.9)], codex: 'PASS', fallback: 'revise', forward: ['a'] },
  { id: 'p16', kind: 'prd', name: 'lone non-ISO MAJOR unvalidated by a missing id', mv: 'PASS', findings: [f('a', 'MAJOR', 0.9, null, 'missing')], codex: 'PASS', fallback: 'revise', forward: ['a'] },
  { id: 'p17', kind: 'prd', name: 'trigger with validation unavailable', run: 'validation-error', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'incomplete')], codex: 'BLOCKED', fallback: 'revise', forward: ['a'] },
  { id: 'p18', kind: 'prd', name: 'unable_to_review set', run: 'unable', mv: 'PASS', findings: [], codex: 'BLOCKED', fallback: null, forward: [] },
  { id: 'p19', kind: 'prd', name: 'review timeout', run: 'review-timeout', mv: 'PASS', findings: [], codex: 'BLOCKED', fallback: null, forward: [] },
  // spec (design, after a clean PRD review)
  { id: 's01', kind: 'spec', name: 'MINOR only', mv: 'PASS', findings: [f('a', 'MINOR', 0.9, 'ambiguous')], codex: 'PASS', fallback: 'PASS', forward: [] },
  { id: 's02', kind: 'spec', name: 'NIT only', mv: 'PASS', findings: [f('a', 'NIT', 0.9)], codex: 'PASS', fallback: 'PASS', forward: [] },
  { id: 's03', kind: 'spec', name: 'one MAJOR without ISO property', mv: 'PASS', findings: [f('a', 'MAJOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['a'] },
  { id: 's04', kind: 'spec', name: 'one MAJOR with ISO property', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'missing_acceptance_criteria')], codex: 'revise', fallback: 'revise', forward: ['a'] },
  { id: 's05', kind: 'spec', name: 'three MAJOR without ISO property', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9), f('b', 'MAJOR', 0.9), f('c', 'MAJOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['a', 'b', 'c'] },
  { id: 's06', kind: 'spec', name: 'BLOCKING 0.3', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.3)], codex: 'revise', fallback: 'revise', forward: ['a'] },
  { id: 's07', kind: 'spec', name: 'mixed BLOCKING + non-ISO MAJOR + MINOR', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.9), f('b', 'MAJOR', 0.9), f('c', 'MINOR', 0.9)], codex: 'revise', fallback: 'revise', forward: ['a', 'b'] },
  { id: 's08', kind: 'spec', name: 'lone refuted trigger', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.9, null, 'refuted')], codex: 'BLOCKED', fallback: 'PASS', forward: [] },
  { id: 's09', kind: 'spec', name: 'lone refuted trigger + MINOR', mv: 'FAIL', findings: [f('a', 'BLOCKING', 0.9, null, 'refuted'), f('b', 'MINOR', 0.9)], codex: 'revise', fallback: 'PASS', forward: ['b'] },
  { id: 's10', kind: 'spec', name: 'trigger with validation unavailable', run: 'validation-error', mv: 'FAIL', findings: [f('a', 'MAJOR', 0.9, 'inconsistent')], codex: 'BLOCKED', fallback: 'revise', forward: ['a'] },
];
const tok = (row, letter) => `tok-${row.id}-${letter}`;
const BIG = s => s === 'BLOCKING' || s === 'MAJOR';
const loc = (row, i) => (row.kind === 'implementation' ? { file: 'app.js', line: i + 1, section: null } : { file: null, line: null, section: `R${i + 1}` });
const locText = l => (l.file ? `${l.file}:${l.line}` : l.section);

// What codex reports (the review call) and how it validates (the validation call).
function codexTable(row) {
  const findings = row.findings.map((x, i) => ({
    id: `F${i + 1}`, severity: x.severity, confidence: x.confidence, category: 'test', iso_property: x.iso,
    location: loc(row, i), claim: tok(row, x.letter), evidence: 'quoted evidence', suggested_fix: 'fix it',
  }));
  const validation = {};
  row.findings.forEach((x, i) => { if (BIG(x.severity) && x.v !== 'missing') validation[`F${i + 1}`] = x.v === 'refuted' ? 'REFUTED' : 'CONFIRMED'; });
  return {
    findings, validation, model_verdict: row.mv,
    unable_to_review: row.run === 'unable' ? 'the artifact could not be read' : null,
    validation_failure: row.run === 'validation-error' ? 'error' : null,
  };
}

// The fallback input: the findings as reported minus those codex refuted.
const fallbackReply = row => ({ findings: row.findings.map((x, i) => ({ x, i })).filter(({ x }) => x.v !== 'refuted').map(({ x, i }) => ({
  severity: x.severity, confidence: x.confidence, iso_property: x.iso, location: locText(loc(row, i)), title: tok(row, x.letter), detail: 'quoted evidence',
})) });

// --- the codex side: the real runner with the fake codex --------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-parity-'));
const BIN = path.join(WORK, 'bin');
fs.mkdirSync(BIN);
fs.copyFileSync(FAKE, path.join(BIN, 'codex'));
fs.chmodSync(path.join(BIN, 'codex'), 0o755);
const DOC = path.join(WORK, 'doc.md');
fs.writeFileSync(DOC, '# document under review\n');

function runRunner(row) {
  const out = path.join(WORK, `out-${row.id}`);
  const plan = row.run === 'validation-timeout' ? { validate: [{ delay_ms: 60000 }, { delay_ms: 60000 }] }
    : row.run === 'review-timeout' ? { review: [{ delay_ms: 60000 }, { delay_ms: 60000 }] } : {};
  const env = {
    ...process.env, PATH: BIN + path.delimiter + process.env.PATH, FAKE_CODEX_SCENARIO: 'table',
    FAKE_CODEX_TABLE: JSON.stringify(codexTable(row)), FAKE_CODEX_STATE: path.join(WORK, `state-${row.id}`), FAKE_CODEX_PLAN: JSON.stringify(plan),
  };
  const timeout = row.run === 'validation-timeout' || row.run === 'review-timeout' ? '1' : '60';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, '--kind', row.kind, '--files', DOC, '--repo', WORK, '--out-dir', out, '--timeout-seconds', timeout], { env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      const dirs = fs.readdirSync(out).filter(d => d.startsWith(row.kind + '-'));
      if (dirs.length !== 1) return reject(new Error(`${row.id}: expected one run folder, got ${dirs}`));
      const file = path.join(out, dirs[0], 'result.json');
      const bytes = fs.readFileSync(file);
      resolve({ code, file, bytes, res: JSON.parse(bytes.toString('utf8')) });
    });
  });
}
const RUNS = new Map(ROWS.map(row => [row.id, runRunner(row)]));

// Today's relay instruction (design.js:149, build.js:258, verify.js:239 at c186e5f): confirmed
// -> confirmed_findings, every other non-refuted -> other_findings, verdict_reasons verbatim.
function relayV1({ res }) {
  const st = x => x.validation && x.validation.status;
  const item = x => ({ severity: x.severity, location: locText(x.location), title: x.claim, detail: x.evidence });
  return {
    verdict: res.verdict, verdict_reasons: res.verdict_reasons, codex_available: true,
    confirmed_findings: res.findings.filter(x => st(x) === 'confirmed').map(item),
    other_findings: res.findings.filter(x => st(x) !== 'confirmed' && st(x) !== 'refuted').map(item),
  };
}
// The relay of design section 9: a pure field projection of result.json, no judgement.
function project({ res, file, bytes }) {
  return {
    verdict: res.verdict, verdict_reasons: res.verdict_reasons, model_verdict: res.model_verdict, outcome: res.outcome,
    unable_to_review: res.unable_to_review, validation_outcome: res.validation ? res.validation.outcome : null,
    run_dir: path.dirname(file), result_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), codex_available: true,
    findings: res.findings.map(x => ({ id: x.id, severity: x.severity, confidence: x.confidence, iso_property: x.iso_property,
      validation_status: x.validation.status, claim: x.claim, evidence: x.evidence, location: x.location })),
  };
}
const RELAY = relayV1;

// --- the stages ---------------------------------------------------------------------------
const designArgs = {
  feature_id: 'feature', repo: '/repo', task: 'Build a feature', run_dir: '/state/design',
  review_runner: '/skill/scripts/run-review.js', execution_schema: '/skill/execution-plan.schema.json', review_fallback: 'opus-high', max_rounds: 2,
};
const buildArgs = {
  feature_id: 'feature', repo: '/repo', work_branch: 'feature/test', run_dir: '/state/build',
  review_runner: '/skill/scripts/run-review.js', suite_cmd: 'npm test', security_schema: '/skill/security.schema.json',
  spec_path: '/state/spec.md', review_fallback: 'opus-high',
};
const verifyArgs = {
  feature_id: 'feature', repo: '/repo', work_branch: 'feature/test', run_dir: '/state/verify',
  review_runner: '/skill/scripts/run-review.js', spec_path: '/state/spec.md', compliance_schema: '/skill/compliance.schema.json',
  base_commit: base, reviewed_sha: sha, completion_runner: '/skill/scripts/check-completion.js',
  manifest_path: '/state/execution-plan.json', manifest_sha256: digest, build_result_path: '/state/build/result.json', review_fallback: 'opus-high',
};
const pinned = { head_before: sha, head_after: sha, status_before: [], status_after: [] };
const CLEAN = { verdict: 'PASS', verdict_reasons: ['no triggering findings'], findings: [], model_verdict: 'PASS', outcome: 'ok', unable_to_review: null,
  validation_outcome: 'skipped', run_dir: '/state/x/prd-1', result_sha256: digest, confirmed_findings: [], other_findings: [], codex_available: true };
const UNAVAILABLE = { verdict: 'ERROR', verdict_reasons: [], findings: [], model_verdict: null, outcome: null, unable_to_review: null, validation_outcome: null,
  run_dir: null, result_sha256: null, confirmed_findings: [], other_findings: [], codex_available: false, note: 'codex: command not found' };
const STOP = { blocked: true, blocked_reason: 'the parity test stops after the first revise/fix prompt' };
const freeze = { blocked: false, spec_sha256: 'd'.repeat(64), manifest_sha256: digest };
const work = { blocked: false, summary: 'done', files_changed: ['app.js'], commit: sha, base_commit: base };
const changed = { head_sha: sha, changed: [{ status: 'M', path: 'app.js' }] };
const suitePass = { passed: true, counts: '3 passed', failures: [], completed: true, other_failures: [], log_path: '/state/build/suite-1.txt', log_sha256: digest, ...pinned };
const preflight = { passed: true, manifest_sha256: digest, spec_sha256: 'd'.repeat(64), reviewed_sha: sha };
const proofs = { blocked: false, ledger_path: '/state/verify/acceptance-ledger.json', ...pinned };
const compliance = { verdict: 'PASS', blocking: [], requirements: [], codex_available: true, ...pinned };
const gate = { passed: true, reviewed_sha: sha, manifest_sha256: digest, proof_path: '/state/verify/completion-proof.json' };

function responder(table) {
  return (prompt, options) => {
    const r = table[options.label];
    assert.ok(r !== undefined, 'unexpected agent call: ' + options.label);
    return r;
  };
}
const many = fn => Array(30).fill(fn);

// Runs one stage with the gated review reply on `side` and returns { transition, prompt }.
async function stage(name, kind, side, reply, opts = {}) {
  if (name === 'design') {
    const table = {
      'prd draft': { blocked: false, path: '/state/design/prd.md', summary: 'ok' },
      'spec draft': { blocked: false, path: '/state/design/spec.md', summary: 'ok' },
      'codex prd review 1': CLEAN, 'codex spec review 1': CLEAN, 'freeze plan identity': freeze,
      [`codex ${kind} review 1`]: side === 'codex' ? reply : UNAVAILABLE,
      [`opus ${kind} review 1 (codex unavailable)`]: reply,
      [`${kind} revise 1`]: STOP,
    };
    const { result, calls } = await run('design', designArgs, many(responder(table)), opts);
    const revise = calls.find(c => c.options.label === `${kind} revise 1`);
    const opus = calls.filter(c => c.options.model === 'opus').length;
    if (revise) return { transition: 'revise', prompt: revise.prompt, result, opus };
    if (result.status === 'BLOCKED' && result[kind] && result[kind].stage === `${kind} review`) return { transition: 'BLOCKED', result, opus };
    return { transition: result.status, result, opus };
  }
  if (name === 'build') {
    const table = {
      implement: work, 'codex security 1': { verdict: 'PASS', blocking: [], codex_available: true }, 'suite 1': suitePass, 'fix 1': STOP,
      'codex review 1': side === 'codex' ? { ...reply, ...changed } : { ...UNAVAILABLE, head_sha: '', changed: [] },
      'opus review 1 (codex unavailable)': { ...reply, ...changed },
    };
    const { result, calls } = await run('build', buildArgs, many(responder(table)), opts);
    const fix = calls.find(c => c.options.label === 'fix 1');
    const opus = calls.filter(c => c.options.model === 'opus').length;
    if (fix) return { transition: 'fix', prompt: fix.prompt, result, opus };
    if (result.status === 'BLOCKED' && result.stage !== 'review') return { transition: `BLOCKED at ${result.stage}`, result, opus };
    return { transition: result.status, result, opus };
  }
  const table = {
    'plan preflight': preflight, 'acceptance proofs': proofs, 'codex spec compliance': compliance, 'completion proof': gate,
    'codex final review': side === 'codex' ? { ...reply, head_sha: sha } : { ...UNAVAILABLE, head_sha: sha },
    'opus final review (codex unavailable)': { ...reply, head_sha: sha },
  };
  const { result, calls } = await run('verify', verifyArgs, many(responder(table)), opts);
  const opus = calls.filter(c => c.options.model === 'opus').length;
  if (result.status === 'BLOCKED' && result.stage !== 'final review') return { transition: `BLOCKED at ${result.stage}`, result, opus };
  return { transition: result.status, result, opus };
}

function assertForwarded(row, side, out) {
  if (!out.prompt) return;
  for (const x of row.findings) {
    const t = tok(row, x.letter);
    if (row.forward.includes(x.letter)) assert.ok(out.prompt.includes(t), `${side}: the prompt carries ${t}`);
    else assert.ok(!out.prompt.includes(t), `${side}: the prompt does not carry ${t}`);
  }
  assert.ok(!out.prompt.includes('undefined'), `${side}: no "undefined" in the prompt`);
  assert.ok(!out.prompt.includes('[object Object]'), `${side}: no "[object Object]" in the prompt`);
}

for (const row of ROWS) {
  const stages = row.kind === 'implementation' ? ['build', 'verify'] : ['design'];
  stages.forEach((name, si) => {
    const want = side => (Array.isArray(row[side]) ? row[side][si] : row[side]);
    test(`parity ${row.id} ${row.kind} ${row.name} via ${name}: codex ${want('codex')}, fallback ${row.fallback ? want('fallback') : 'n/a'}`, async () => {
      const ran = await RUNS.get(row.id);
      assert.equal(ran.res.model_verdict, row.run === 'review-timeout' ? null : row.mv, 'the fake codex reported the row\'s model verdict');
      const c = await stage(name, row.kind, 'codex', RELAY(ran));
      assert.equal(c.transition, want('codex'), 'codex transition');
      assert.equal(c.opus, 0, 'the codex path makes no Opus call');
      assertForwarded(row, 'codex', c);
      if (!row.fallback) return;
      const fb = await stage(name, row.kind, 'fallback', fallbackReply(row));
      assert.equal(fb.transition, want('fallback'), 'fallback transition');
      assertForwarded(row, 'fallback', fb);
    });
  });
}

// --- before rows: the two section-0 expectations, against the workflow text of c186e5f ----
const unavailableV1 = { verdict: 'ERROR', confirmed_findings: [], verdict_reasons: [], other_findings: [], codex_available: false, note: 'codex: command not found' };

test('before (c186e5f): a lone non-ISO design MAJOR 0.9 from the Opus fallback passed with no PRD revise round', async () => {
  const major = { severity: 'MAJOR', confidence: 0.9, iso_property: null, location: 'x', title: 'one', detail: 'd' };
  const { result, calls } = await run('design', { ...designArgs, max_rounds: 3 },
    [{ blocked: false }, unavailableV1, { findings: [major] }, { blocked: false }, unavailableV1, { findings: [] }, freeze], { source: sourceAt(BASE_REV, 'design') });
  assert.equal(result.status, 'PASS');
  assert.ok(!calls.some(c => c.options.label === 'prd revise 1'));
});

test('before (c186e5f): a 0.6 build MAJOR from the Opus fallback was BLOCKED as NEEDS_HUMAN', async () => {
  const { result } = await run('build', buildArgs,
    [work, { ...unavailableV1, head_sha: '', changed: [] }, { findings: [{ severity: 'MAJOR', confidence: 0.6, iso_property: null, title: 'maybe' }], ...changed }],
    { source: sourceAt(BASE_REV, 'build') });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.review.verdict, 'NEEDS_HUMAN');
});

// --- relay consistency: an inconsistent or incomplete relay reply never passes --------------
const codexFinding = (kind, status) => ({ id: 'F1', severity: 'MAJOR', confidence: 0.9, iso_property: kind === 'implementation' ? null : 'incomplete',
  validation_status: status, claim: 'gap', evidence: 'quoted', location: { file: 'app.js', line: 1, section: null } });
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };
const BAD = kind => [
  ['an old-style reply (buckets and verdict, no findings)', { verdict: 'FAIL', verdict_reasons: [`F1 MAJOR conf 0.9 (${kind})`], codex_available: true,
    confirmed_findings: [{ severity: 'MAJOR', title: 'gap', location: 'x', detail: 'd' }], other_findings: [] }],
  ['a verdict inconsistent with its findings (PASS over a confirmed trigger)', { ...CLEAN, findings: [codexFinding(kind, 'confirmed')], model_verdict: 'FAIL' }],
  ['a verdict inconsistent with its findings (FAIL over none)', { ...CLEAN, verdict: 'FAIL', model_verdict: 'FAIL' }],
  ['a reply without findings', without(CLEAN, 'findings')],
  ['a reply without model_verdict', without(CLEAN, 'model_verdict')],
  ['unable_to_review relayed as PASS', { ...CLEAN, unable_to_review: 'the artifact could not be read' }],
  ['a timeout outcome relayed as PASS', { ...CLEAN, outcome: 'timeout' }],
];
for (const [name, kind] of [['design', 'prd'], ['design', 'spec'], ['build', 'implementation'], ['verify', 'implementation']]) {
  for (const [what, reply] of BAD(kind)) {
    test(`relay consistency (${name} ${kind}): ${what} is BLOCKED`, async () => {
      const out = await stage(name, kind, 'codex', reply);
      assert.equal(out.transition, 'BLOCKED');
      assert.equal(out.opus, 0, 'no Opus call');
    });
  }
}

// --- one rule text: the computeVerdict copies are byte-identical ----------------------------
const fnText = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `function ${name} present`);
  return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const isoSet = src => (src.match(/const ISO_SET = (new Set\(\[[^\]]*\]\))/) || [])[1];
const runnerSrc = fs.readFileSync(RUNNER, 'utf8');

test('computeTriggers/computeVerdict and ISO_SET in design.js, build.js and verify.js are byte-identical to run-review.js', () => {
  for (const name of ['design', 'build', 'verify']) {
    const src = fs.readFileSync(path.join(WORKFLOWS, name + '.js'), 'utf8');
    for (const fn of ['computeTriggers', 'computeVerdict']) assert.equal(fnText(src, fn), fnText(runnerSrc, fn), `${name}.js ${fn}`);
    assert.equal(isoSet(src), isoSet(runnerSrc), `${name}.js ISO_SET`);
  }
});

const GATE_RULE = path.join(__dirname, '..', 'scripts', 'lib', 'gate-rule.js');
test('computeTriggers/computeVerdict in scripts/lib/gate-rule.js are byte-identical to run-review.js', { skip: !fs.existsSync(GATE_RULE) && 'scripts/lib/gate-rule.js arrives with WP3' }, () => {
  const src = fs.readFileSync(GATE_RULE, 'utf8');
  for (const fn of ['computeTriggers', 'computeVerdict']) assert.equal(fnText(src, fn), fnText(runnerSrc, fn), `gate-rule.js ${fn}`);
});

// --- security has no parity row: the critical/high filter is the model's on both paths ------
test('security: the codex and fallback prompts carry the same task text and "ONLY the critical/high findings as blocking"', async () => {
  const sec = { 'codex security 1': { verdict: 'PASS', blocking: [], codex_available: true }, 'suite 1': suitePass, implement: work };
  const viaCodex = await run('build', buildArgs, many(responder({ ...sec, 'codex review 1': { ...CLEAN, ...changed } })));
  const viaOpus = await run('build', buildArgs, many(responder({ ...sec, 'codex review 1': { ...UNAVAILABLE, head_sha: '', changed: [] },
    'opus review 1 (codex unavailable)': { findings: [], ...changed }, 'codex security 1': { verdict: 'ERROR', blocking: [], codex_available: false },
    'opus security 1 (codex unavailable)': { verdict: 'PASS', blocking: [] } })));
  assert.equal(viaCodex.result.status, 'PASS');
  assert.equal(viaOpus.result.status, 'PASS');
  const p1 = viaCodex.calls.find(c => c.options.label === 'codex security 1').prompt;
  const p2 = viaOpus.calls.find(c => c.options.label === 'opus security 1 (codex unavailable)').prompt;
  const task = p1.slice(p1.indexOf('prompt.md containing: "') + 'prompt.md containing: "'.length, p1.indexOf('"\n2. Run'));
  assert.ok(task.length > 200, 'the codex task was found');
  assert.ok(p2.includes(task), 'the fallback prompt carries the same task text');
  for (const p of [p1, p2]) assert.ok(p.includes('ONLY the critical/high findings as blocking'));
});

// --- the helper itself: same calls and result as workflows.test.js run() ------------------
test('run-workflow.js gives the same calls and result as workflows.test.js run() on the v1 design happy path', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'workflows.test.js'), 'utf8');
  const start = text.indexOf('async function run(name, args, replies) {');
  assert.ok(start >= 0);
  const original = new Function('fs', 'path', 'assert', 'AsyncFunction', '__dirname',
    `return (${text.slice(start, text.indexOf('\n}\n', start) + 2)})`)(fs, path, assert, AsyncFunction, __dirname);
  const args = { ...designArgs, review_fallback: undefined };
  const replies = () => [{ blocked: false }, CLEAN, { blocked: false }, CLEAN, freeze];
  const a = await original('design', args, replies());
  const b = await run('design', args, replies());
  assert.equal(a.result.status, 'PASS');
  assert.deepEqual(b, a);
});

after(() => fs.rmSync(WORK, { recursive: true, force: true }));
