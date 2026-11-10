#!/usr/bin/env node
'use strict';

// check-completion.js: the v1 differential test (plan WP3) and the contract-2 modes (docs/v2-design.md sections 5,
// 6.2, 6.4, 6.5), against real temp repos (tests/helpers/v2-repo.js). Review files are hand-written (the model
// steps are mocked); every hash, snapshot, ledger, record and git object is made by the real scripts and git.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { makeRepo, completeRun, baseFeature, featureBytes, cleanEnv, sha256, clone, FALLBACK_REVIEWER, REPO_PATH, SCRIPTS } = require('./helpers/v2-repo.js');
const { fixture, CASES } = require('./helpers/v1-completion-cases.js');

const CHECKER = path.join(SCRIPTS, 'check-completion.js');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BASELINE = 'c186e5f';

// ---- v1 differential ------------------------------------------------------------------------------------------
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-v1-old-'));
const OLD_CHECKER = path.join(oldDir, 'check-completion.js');
fs.writeFileSync(OLD_CHECKER, spawnSync('git', ['show', `${BASELINE}:skills/gated-pipeline/scripts/check-completion.js`], { cwd: REPO_ROOT, encoding: 'utf8', env: cleanEnv() }).stdout);
process.on('exit', () => fs.rmSync(oldDir, { recursive: true, force: true }));

function runCase(c, script, root) {
  const f = fixture(root);
  const outputs = [];
  const exec = (overrides = {}) => {
    const argv = overrides.argv || f.argv(overrides);
    const r = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: cleanEnv() });
    let stdout = r.stdout;
    try { const o = JSON.parse(r.stdout); delete o.proof_sha256; stdout = JSON.stringify(o); } catch { /* not JSON: compared raw */ }
    outputs.push({ status: r.status, stdout, stderr: r.stderr });
  };
  return { f, outputs, exec };
}
function proofOf(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try { const o = JSON.parse(text); delete o.checked_at; return JSON.stringify(o); } catch { return text; }
}

test(`v1 differential: ${CASES.length} cases give byte-identical stdout (minus proof_sha256), stderr, exit codes and proofs (minus checked_at) under ${BASELINE} and now`, () => {
  assert.ok(fs.readFileSync(OLD_CHECKER, 'utf8').includes("const FLAGS = ['repo', 'feature-id'"), 'the baseline script was read from git');
  const mapping = [];
  for (const c of CASES) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-v1-diff-')));
    try {
      // Build the fixture once, snapshot it, run the old script, restore the snapshot, run the new one.
      fs.mkdirSync(path.join(root, 'case'));
      const caseRoot = path.join(root, 'case');
      const seed = runCase(c, OLD_CHECKER, caseRoot);
      const snap = path.join(root, 'snapshot');
      assert.equal(spawnSync('cp', ['-a', caseRoot, snap]).status, 0);
      c.steps(seed.f, seed.exec);
      const oldProof = proofOf(seed.f.out);
      fs.rmSync(caseRoot, { recursive: true, force: true });
      assert.equal(spawnSync('cp', ['-a', snap, caseRoot]).status, 0);
      // The restored tree is the same fixture; rebuild only the in-memory handle (no git calls, no writes).
      const fresh = rehydrate(caseRoot, seed.f);
      const now = [];
      const exec = (overrides = {}) => {
        const argv = overrides.argv || fresh.argv(overrides);
        const r = spawnSync(process.execPath, [CHECKER, ...argv], { encoding: 'utf8', env: cleanEnv() });
        let stdout = r.stdout;
        try { const o = JSON.parse(r.stdout); delete o.proof_sha256; stdout = JSON.stringify(o); } catch { /* raw */ }
        now.push({ status: r.status, stdout, stderr: r.stderr });
      };
      c.steps(fresh, exec);
      assert.ok(seed.outputs.length > 0, `${c.name}: the case ran the CLI`);
      assert.deepEqual(now, seed.outputs, `${c.name}: outputs differ`);
      assert.equal(proofOf(fresh.out), oldProof, `${c.name}: proof differs`);
      mapping.push([c.name, c.original, seed.outputs.map(o => o.status).join(',')]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // The mapping printed for the report: case name, original test, exit codes.
  console.log(JSON.stringify({ differential_cases: mapping.length, mapping }));
});

// The in-memory handle of a restored fixture: the same objects the original fixture() built, re-read from disk.
function rehydrate(root, f) {
  const g = { ...f, manifestHash: sha256(fs.readFileSync(f.manifestPath)) };
  g.manifest = fs.existsSync(f.manifestPath) ? JSON.parse(fs.readFileSync(f.manifestPath, 'utf8')) : clone(f.manifest);
  g.build = fs.existsSync(f.buildPath) && isJson(f.buildPath) ? JSON.parse(fs.readFileSync(f.buildPath, 'utf8')) : clone(f.build);
  g.verify = fs.existsSync(f.verifyPath) && isJson(f.verifyPath) ? JSON.parse(fs.readFileSync(f.verifyPath, 'utf8')) : clone(f.verify);
  const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  g.save = () => {
    writeJson(g.manifestPath, g.manifest);
    g.manifestHash = sha256(fs.readFileSync(g.manifestPath));
    g.verify.manifest_sha256 = g.manifestHash;
    writeJson(g.buildPath, g.build);
    writeJson(g.verifyPath, g.verify);
  };
  g.argv = (overrides = {}) => {
    const flags = { repo: g.repo, 'feature-id': 'feature-1', 'reviewed-sha': g.head, manifest: g.manifestPath, 'manifest-sha256': g.manifestHash, spec: g.spec,
      'build-result': g.buildPath, 'verify-result': g.verifyPath, out: g.out, ...overrides };
    return Object.entries(flags).flatMap(([k, v]) => ['--' + k, v]);
  };
  return g;
}
const isJson = file => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; } };

test('v1 differential: every test of check-completion.test.js is mapped to exactly one case', () => {
  const loader = `const Module = require('module'); const load = Module._load; const names = [];
Module._load = function (request, ...rest) { if (request === 'node:test') return { test: name => names.push(name), after() {}, before() {} }; return load.call(this, request, ...rest); };
require(${JSON.stringify(path.join(__dirname, 'check-completion.test.js'))}); console.log(JSON.stringify(names));`;
  const r = spawnSync(process.execPath, ['-e', loader], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const names = JSON.parse(r.stdout);
  const originals = CASES.map(c => c.original).filter(Boolean);
  assert.equal(new Set(originals).size, originals.length, 'one case per original test');
  assert.deepEqual([...originals].sort(), [...names].sort());
  console.log(JSON.stringify({ original_tests: names.length, extra_cases: CASES.length - originals.length }));
});

test('v1: a build result stamped build_mode "charge-only" is rejected (a documented v1 addition); c186e5f accepted it', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-v1-charge-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(root);
  f.build.build_mode = 'charge-only';
  f.save();
  const run = script => spawnSync(process.execPath, [script, ...f.argv()], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run(OLD_CHECKER).status, 0, 'the baseline certified a charge-only build');
  fs.unlinkSync(f.out);
  const now = run(CHECKER);
  assert.equal(now.status, 1);
  assert.match(now.stderr, /charge-only/);
  assert.equal(fs.existsSync(f.out), false);
});

test('v1: a build result stamped build_mode "v2" is rejected (a documented v1 addition): a design-gated build certifies only under contract 2; c186e5f accepted it', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-v1-v2build-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(root);
  f.build.build_mode = 'v2';
  f.save();
  const run = script => spawnSync(process.execPath, [script, ...f.argv()], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run(OLD_CHECKER).status, 0, 'the baseline certified a v2 build under contract 1');
  fs.unlinkSync(f.out);
  const now = run(CHECKER);
  assert.equal(now.status, 1);
  assert.match(now.stderr, /build_mode \\?"v2\\?"/);
  assert.match(now.stderr, /contract 2/);
  assert.equal(fs.existsSync(f.out), false);
  // the stamps v1 builds carry still certify
  for (const mode of ['v1', undefined]) {
    const g = fixture(fs.mkdtempSync(path.join(root, 'ok-')));
    if (mode) g.build.build_mode = mode; else delete g.build.build_mode;
    g.save();
    assert.equal(spawnSync(process.execPath, [CHECKER, ...g.argv()], { encoding: 'utf8', env: cleanEnv() }).status, 0, String(mode));
  }
});

// ---- helpers for the contract-2 rows -----------------------------------------------------------------------------
const SCRIPT = name => path.join(SCRIPTS, name);
function blocked(r, code, pattern) {
  assert.notEqual(r.status, 0, `expected BLOCKED, got exit 0: ${r.stdout}`);
  const err = JSON.parse(r.stderr.trim().split('\n').pop());
  assert.equal(err.status, 'BLOCKED');
  if (code) assert.equal(err.code, code, err.reason);
  if (pattern) assert.match(err.reason, pattern);
  return err;
}
const passed = r => { assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };
const featurePath = (c, rev) => path.join(c.revDir(rev), 'feature.json');

// ---- write-json.js, hash-inputs.js, feature-snapshot.js ------------------------------------------------------------
test('write-json writes the stdin bytes once, atomically, and refuses invalid JSON and an existing file', t => {
  const c = makeRepo(t);
  const file = path.join(c.run, 'record.json');
  const w = c.node('write-json.js', ['--out', file], { input: '{"b":1,"a":[true]}\n' });
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(JSON.parse(w.stdout), { path: file, sha256: sha256(Buffer.from('{"b":1,"a":[true]}\n')) });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"b":1,"a":[true]}\n');
  const again = c.node('write-json.js', ['--out', file], { input: '{"c":2}' });
  assert.equal(again.status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"b":1,"a":[true]}\n');
  for (const bad of ['{"a":1,"a":2}', '[1]', '{"a":1,}', '{"__proto__":{}}']) assert.equal(c.node('write-json.js', ['--out', path.join(c.run, 'bad.json')], { input: bad }).status, 1, bad);
  assert.equal(fs.existsSync(path.join(c.run, 'bad.json')), false);
  assert.equal(c.node('write-json.js', ['--out', 'relative.json'], { input: '{}' }).status, 2);
  assert.deepEqual(fs.readdirSync(c.run).filter(n => n.includes('.tmp-')), [], 'no temporary file is left');
});

test('hash-inputs pins files with roles, verifies them later and refuses an existing output', t => {
  const c = makeRepo(t);
  const a = path.join(c.run, 'a.txt'), b = path.join(c.run, 'b.txt');
  fs.writeFileSync(a, 'A');
  fs.writeFileSync(b, 'B');
  const out = path.join(c.run, 'inputs.json');
  const r = c.node('hash-inputs.js', ['--out', out, a, '--against', b]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { inputs: [{ role: 'files', path: a, sha256: sha256('A') }, { role: 'against', path: b, sha256: sha256('B') }] });
  assert.equal(c.node('hash-inputs.js', ['--verify', out]).status, 0);
  fs.writeFileSync(b, 'changed');
  const v = c.node('hash-inputs.js', ['--verify', out]);
  assert.equal(v.status, 1);
  assert.deepEqual(JSON.parse(v.stdout).mismatches, [{ path: b, expected: sha256('B'), actual: sha256('changed') }]);
  assert.equal(c.node('hash-inputs.js', ['--out', out, a]).status, 1, 'an inputs file is written once');
  assert.equal(c.node('hash-inputs.js', ['--out', path.join(c.run, 'dup.json'), a, a]).status, 2);
});

test('feature-snapshot copies, validates (with --previous) and compiles one revision', t => {
  const c = makeRepo(t);
  const s1 = c.snap(1);
  assert.equal(s1.valid, true);
  assert.deepEqual(fs.readFileSync(featurePath(c, 1)), fs.readFileSync(c.featureFile));
  assert.equal(s1.source_sha256, sha256(fs.readFileSync(c.featureFile)));
  assert.equal(s1.manifest_sha256, sha256(fs.readFileSync(path.join(c.revDir(1), 'out', 'execution-plan.json'))));
  // a revision that drops an acceptance fails the --previous rules: exit 1, no out/
  const f = clone(c.feature);
  f.requirements[0].acceptance.pop();
  c.writeFeature(f);
  const r = c.node('feature-snapshot.js', ['--repo', c.repo, '--from', c.featureFile, '--repo-path', REPO_PATH, '--rev-dir', c.revDir(2),
    '--source-request', c.request, '--source-mode', 'text', '--previous', featurePath(c, 1)]);
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.code === 'E_ID_REMOVED'));
  assert.equal(fs.existsSync(path.join(c.revDir(2), 'out')), false);
  const again = c.node('feature-snapshot.js', ['--repo', c.repo, '--from', c.featureFile, '--repo-path', REPO_PATH, '--rev-dir', c.revDir(1), '--source-request', c.request, '--source-mode', 'text']);
  assert.equal(again.status, 2, 'a rev dir is never written twice');
  const inRepo = c.node('feature-snapshot.js', ['--repo', c.repo, '--from', c.featureFile, '--repo-path', REPO_PATH, '--rev-dir', path.join(c.repo, 'rev-9'), '--source-request', c.request, '--source-mode', 'text']);
  assert.equal(inRepo.status, 2);
});

// ---- --mode approvals (design section 5; L3.3) -------------------------------------------------------------------
function ledger(t, plan, opts = {}) {
  const c = makeRepo(t, opts);
  for (const step of plan) {
    if (step.feature) c.writeFeature(step.feature(clone(c.feature)));
    if (step.snap !== undefined) c.snap(step.snap, step.snapOpts);
    if (step.gate) c.addRecord(c.review(step.gate, step.rev, step.review || {}));
  }
  return c;
}
const HAPPY = [{ snap: 1 }, { gate: 'prd', rev: 1 }, { gate: 'spec', rev: 1 }];

test('approvals: codex PRD and spec PASS on the same revision freeze (same-revision)', t => {
  const c = ledger(t, HAPPY);
  const out = passed(c.approvals());
  assert.equal(out.rule, 'same-revision');
  assert.equal(out.approvals_sha256, c.approvalsSha);
  assert.deepEqual(out.records, [{ gate: 'prd', round: 1, rev: 1, verdict: 'PASS' }, { gate: 'spec', round: 2, rev: 1, verdict: 'PASS' }]);
});

test('approvals: Opus fallback records with script-hashed inputs freeze too', t => {
  const c = ledger(t, [{ snap: 1 }, { gate: 'prd', rev: 1, review: { reviewer: 'fallback' } }, { gate: 'spec', rev: 1, review: { reviewer: 'fallback', findings: [{ severity: 'MINOR', confidence: 0.9, title: 'nit' }] } }]);
  passed(c.approvals());
});

test('approvals: Opus records labelled configured reviewer (reviews.reviewer: opus-high) freeze; a record whose file carries the other Opus label is exit 1', t => {
  const c = ledger(t, [{ snap: 1 }, { gate: 'prd', rev: 1, review: { reviewer: 'configured' } }, { gate: 'spec', rev: 1, review: { reviewer: 'configured' } }]);
  passed(c.approvals());
  const d = ledger(t, [{ snap: 1 }, { gate: 'prd', rev: 1, review: { reviewer: 'configured', fileReviewer: 'claude-opus-high (codex unavailable)' } }, { gate: 'spec', rev: 1, review: { reviewer: 'configured' } }]);
  blocked(d.approvals(), 'E_APPROVALS', /fallback-review\.json reviewer must be the record's claude-opus-high \(configured reviewer\)/);
});

test('approvals: an edited fallback-review.json is exit 1', t => {
  const c = ledger(t, [{ snap: 1 }, { gate: 'prd', rev: 1, review: { reviewer: 'fallback' } }, { gate: 'spec', rev: 1, review: { reviewer: 'fallback' } }]);
  const fb = c.records[1].fallback_review_path;
  fs.writeFileSync(fb, fs.readFileSync(fb, 'utf8').replace('"findings":[]', '"findings": []'));
  blocked(c.approvals(), 'E_HASH', /fallback-review\.json/);
});

test('approvals: a codex record pins its result.json by hash; a replaced result.json with the same verdict and inputs is exit 1', t => {
  const c = ledger(t, HAPPY);
  assert.match(c.records[1].result_sha256 || '', /^[0-9a-f]{64}$/, 'the codex record carries result_sha256');
  const file = c.records[1].result_path;
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  v.summary = 'another review with the same verdict';
  v.findings = [{ id: 'N-1', severity: 'NIT', confidence: 0.9, iso_property: null, validation: null, claim: 'swapped in', evidence: 'none' }];
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
  blocked(c.approvals(), 'E_HASH', /result\.json/);
});

// The ledger records the design run's source_request_mode (and ref), so R03/R04 hold for every revision and F: the
// form is never inferred from the revision itself.
test('approvals: a ref-mode (confidential) ledger whose revisions use the text form is exit 1 (R03)', t => {
  const c = ledger(t, HAPPY, { sourceMode: 'ref', sourceRef: 'TICKET-7' });
  blocked(c.approvals(), 'E_APPROVALS', /R03/);
});
test('approvals: a text-mode ledger whose revisions use the ref form is exit 1 (R03); the same revisions under a ref-mode ledger pass', t => {
  const toRef = c => f => { f.source_request = { ref: 'TICKET-7', sha256: c.requestSha, summary: 'Make the greeting say hello.' }; return f; };
  const plan = c => [{ feature: toRef(c), snap: 1, snapOpts: { sourceMode: 'ref' } }, { gate: 'prd', rev: 1 }, { gate: 'spec', rev: 1 }];
  const text = makeRepo(t);
  for (const step of plan(text)) { if (step.feature) text.writeFeature(step.feature(clone(text.feature))); if (step.snap) text.snap(step.snap, step.snapOpts); if (step.gate) text.addRecord(text.review(step.gate, step.rev)); }
  blocked(text.approvals(), 'E_APPROVALS', /R03/);
  const ref = makeRepo(t, { sourceMode: 'ref', sourceRef: 'TICKET-7' });
  for (const step of plan(ref)) { if (step.feature) ref.writeFeature(step.feature(clone(ref.feature))); if (step.snap) ref.snap(step.snap, step.snapOpts); if (step.gate) ref.addRecord(ref.review(step.gate, step.rev)); }
  passed(ref.approvals());
});
test('approvals: the ledger source_request_mode and source_request_ref must be a known mode and its label', t => {
  for (const [mode, ref] of [['other', null], ['text', 'TICKET-7'], ['ref', null], ['ref', "it's"]]) {
    const c = ledger(t, HAPPY, { sourceMode: mode, sourceRef: ref });
    blocked(c.approvals(), 'E_APPROVALS', /source_request_mode|source_request_ref/);
  }
});

test('approvals: an approvals-<n+1>.json beside the named ledger is exit 1', t => {
  const c = ledger(t, HAPPY);
  const named = c.approvalsPath;
  c.addRecord(c.review('spec', 1, { verdict: 'FAIL', findings: [{ id: 'X', severity: 'BLOCKING', confidence: 0.9, iso_property: null, validation: { status: 'confirmed' } }], runnerVerdict: 'FAIL', model_verdict: 'FAIL' }));
  blocked(c.approvals({ approvals: named }), 'E_APPROVALS', /approvals-3\.json exists/);
});

test('approvals: earlier ledger files must be the prefix of the named one', t => {
  const c = ledger(t, HAPPY);
  fs.unlinkSync(path.join(c.run, 'approvals-1.json'));
  blocked(c.approvals(), 'E_BLOCKED', /approvals-1\.json/);
});

for (const [name, review, pattern] of [
  ['a spec record backed by a prd-kind run', { kind: 'prd' }, /kind prd is not the spec gate/],
  ['a codex record with outcome not ok', { result: { outcome: 'timeout' } }, /outcome must be ok/],
  ['a codex record with unable_to_review set', { result: { unable_to_review: 'too large' } }, /outcome must be ok/],
  ['a codex record with scope.mode not files', { result: { scope: { mode: 'diff' } } }, /scope\.mode must be files/],
  ['a spec review without execution-plan.json', { inputs: 'no-plan' }, /review inputs are not exactly/],
  ['a codex runner verdict inconsistent with its findings', { runnerVerdict: 'FAIL' }, /not computeVerdict/],
]) {
  test(`approvals: ${name} is exit 1`, t => {
    const c = makeRepo(t);
    c.snap(1);
    c.addRecord(c.review('prd', 1));
    const o = { ...review };
    if (o.inputs === 'no-plan') o.inputs = c.gateInputs('spec', 1).filter(i => !i.path.endsWith('execution-plan.json'));
    c.addRecord(c.review('spec', 1, o));
    blocked(c.approvals(), 'E_APPROVALS', pattern);
  });
}

test('approvals: a fallback record whose gate_kind differs is exit 1', t => {
  const c = ledger(t, [{ snap: 1 }, { gate: 'prd', rev: 1 }, { gate: 'spec', rev: 1, review: { reviewer: 'fallback', gate_kind: 'prd' } }]);
  blocked(c.approvals(), 'E_APPROVALS', /gate_kind prd is not the spec gate/);
});

test('approvals: a spec review against another revision\'s prd.view.md is exit 1', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  const f = clone(c.feature);
  f.checks[0].reason = 'A quick syntax check of the module.';
  c.writeFeature(f);
  c.snap(2);
  const inputs = c.gateInputs('spec', 2).map(i => (i.role === 'against' ? { role: 'against', path: path.join(c.revDir(1), 'out', 'prd.view.md') } : i));
  c.addRecord(c.review('spec', 2, { inputs }));
  blocked(c.approvals({ source: featurePath(c, 2) }), 'E_APPROVALS', /review inputs are not exactly/);
});

test('approvals: a spec-only revision keeps the PRD approval (unchanged-prd-projection)', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  const f = clone(c.feature);
  f.checks[0].reason = 'A quick syntax check of the module.';
  c.writeFeature(f);
  c.snap(2);
  c.addRecord(c.review('spec', 2));
  assert.equal(passed(c.approvals({ source: featurePath(c, 2) })).rule, 'unchanged-prd-projection');
});

test('approvals: a projection change (a decision edit) after the PRD PASS voids it', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  const f = clone(c.feature);
  f.architecture.decisions.push({ id: 'DEC-001', decision: 'Return a constant.', rationale: 'Simplest.', status: 'active' });
  c.writeFeature(f);
  c.snap(2);
  c.addRecord(c.review('spec', 2));
  blocked(c.approvals({ source: featurePath(c, 2) }), 'E_FREEZE_RULE', /another PRD projection/);
});

test('approvals: PRD PASS on P1, FAIL on P2, back to P1 needs a fresh PRD PASS', t => {
  const c = makeRepo(t);
  const p1 = clone(c.feature);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  const p2 = clone(p1);
  p2.product.problem = 'The greeting is wrong and nobody notices.';
  c.writeFeature(p2);
  c.snap(2);
  c.addRecord(c.review('prd', 2, { verdict: 'FAIL', runnerVerdict: 'FAIL', model_verdict: 'FAIL', findings: [{ id: 'F1', severity: 'BLOCKING', confidence: 0.9, iso_property: null, validation: { status: 'confirmed' } }] }));
  c.writeFeature(p1);
  c.snap(3);
  c.addRecord(c.review('spec', 3));
  blocked(c.approvals({ source: featurePath(c, 3) }), 'E_FREEZE_RULE', /latest PRD review is not a PASS/);
  c.addRecord(c.review('prd', 3));
  c.addRecord(c.review('spec', 3));
  assert.equal(passed(c.approvals({ source: featurePath(c, 3) })).rule, 'same-revision');
});

test('approvals: PRD FAIL then spec PASS on unchanged bytes does not freeze', t => {
  const c = ledger(t, [{ snap: 1 }, { gate: 'prd', rev: 1, review: { verdict: 'FAIL', runnerVerdict: 'FAIL', model_verdict: 'FAIL', findings: [{ id: 'F1', severity: 'BLOCKING', confidence: 0.9, iso_property: null, validation: { status: 'confirmed' } }] } }, { gate: 'spec', rev: 1 }]);
  blocked(c.approvals(), 'E_FREEZE_RULE', /latest PRD review is not a PASS/);
});

test('approvals gate verdict: a runner PASS with a confirmed MAJOR is a gate FAIL; a later clean PASS freezes, and marking that round PASS is exit 1', t => {
  const major = [{ id: 'F1', severity: 'MAJOR', confidence: 0.9, iso_property: null, validation: { status: 'confirmed' } }];
  const plan = recorded => [{ snap: 1 }, { gate: 'prd', rev: 1, review: { verdict: recorded, runnerVerdict: 'PASS', model_verdict: 'PASS', findings: major } }, { gate: 'prd', rev: 1 }, { gate: 'spec', rev: 1 }];
  passed(ledger(t, plan('FAIL')).approvals());
  blocked(ledger(t, plan('PASS')).approvals(), 'E_APPROVALS', /recorded verdict PASS is not the gate verdict FAIL/);
});

test('approvals: a wrong or reused relayed projection hash in a record is exit 1', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1, { record: { prd_projection_sha256: '0'.repeat(64) } }));
  c.addRecord(c.review('spec', 1));
  blocked(c.approvals(), 'E_APPROVALS', /prd_projection_sha256 differs/);
});

test('approvals: a revision that drops a requirement id fails the --previous rules', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  const f = clone(c.feature);
  f.requirements[0].acceptance.pop();
  c.writeFeature(f);
  c.snap(2, { previous: null }); // bypasses feature-snapshot's own --previous check
  c.addRecord(c.review('prd', 2));
  c.addRecord(c.review('spec', 2));
  blocked(c.approvals({ source: featurePath(c, 2) }), 'E_APPROVALS', /E_ID_REMOVED/);
});

test('approvals: source_request.text edited after the PRD PASS is exit 1', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  // A rev-2 made by hand (feature-snapshot would refuse it): its source text no longer matches the request.
  const f = clone(c.feature);
  f.source_request.text = 'Make hello() return the text hello, loudly.';
  fs.mkdirSync(c.revDir(2));
  fs.writeFileSync(featurePath(c, 2), featureBytes(f));
  const r = c.node('compile-feature.js', ['--file', featurePath(c, 2), '--repo', c.repo, '--repo-path', REPO_PATH, '--out', path.join(c.revDir(2), 'out')]);
  assert.equal(r.status, 0, r.stderr);
  c.snapshots[2] = r.json();
  c.addRecord(c.review('spec', 2));
  blocked(c.approvals({ source: featurePath(c, 2) }), 'E_APPROVALS', /E_SOURCE_MISMATCH/);
});

test('approvals: --source must be a rev snapshot named by a ledger record, outside the repo', t => {
  const c = ledger(t, HAPPY);
  const copy = path.join(c.run, 'copy.json');
  fs.copyFileSync(featurePath(c, 1), copy);
  blocked(c.approvals({ source: copy }), 'E_APPROVALS', /--source must be/);
  blocked(c.approvals({ source: c.featureFile }), 'E_BLOCKED', /outside the repo/);
});

test('approvals: an edited rev-k/out view is drift', t => {
  const c = ledger(t, HAPPY);
  fs.appendFileSync(path.join(c.revDir(1), 'out', 'spec.view.md'), '\nextra\n');
  blocked(c.approvals(), 'E_DRIFT', /spec\.view\.md/);
});

// ---- --mode design (design 6.2; S19a; L2.4; L3.11 rev-0) -------------------------------------------------------
test('design: the frozen design passes, echoes the ledger, the bound and the paths, and --out writes the preflight once', t => {
  const c = makeRepo(t).freeze();
  const out = path.join(c.run, 'design-preflight.json');
  const d = passed(c.design({ expectParent: c.startHead, out }));
  assert.equal(d.design_commit, c.designCommit);
  assert.equal(d.design_parent, c.startHead);
  assert.deepEqual(d.design_paths, [REPO_PATH]);
  assert.deepEqual(d.records, passed(c.approvals()).records);
  assert.equal(d.approval_rule, 'same-revision');
  assert.equal(d.manifest_sha256, c.manifestSha);
  assert.deepEqual(d.config_bound, { config_path: '.claude/pipeline.yaml', config_sha256: sha256(require('./helpers/v2-repo.js').PIPELINE_YAML), state_paths: [], clean_ignore: [], known_failures: [] });
  assert.equal(d.unit_command, 'node test/hello.test.js');
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), d);
  blocked(c.design({ out }), 'E_OUT_EXISTS');
  blocked(c.design({ expectParent: c.designCommit }), 'E_IDENTITY', /--expect-parent/);
  assert.ok(!c.git('diff', '--cached', '--name-only').includes(REPO_PATH), 'the real index caught up with the commit');
});

test('S19a: an edit committed after freeze, recompiled and re-hashed, is exit 1', t => {
  const c = makeRepo(t).freeze();
  const f = clone(c.feature);
  f.requirements[0].acceptance[0].verification.command = 'node test/hello.test.js && true';
  c.writeFeature(f);
  c.git('commit', '-qam', 'edit after freeze');
  const commit = c.git('rev-parse', 'HEAD');
  c.compileFrozen(commit, path.join(c.run, 'frozen-2'));
  blocked(c.design({ commit }), 'E_FREEZE_RULE', /latest spec PASS/);
});

test('S19a: a dirty-only edit of the canonical file is exit 1', t => {
  const c = makeRepo(t).freeze();
  fs.appendFileSync(c.featureFile, ' ');
  blocked(c.design(), 'E_IDENTITY', /differs from the committed blob/);
});

test('S19a: a CRLF checkout is exit 1, never re-hashed', t => {
  const c = makeRepo(t).freeze();
  c.git('config', 'core.autocrlf', 'true');
  fs.unlinkSync(c.featureFile);
  c.git('checkout', '--', REPO_PATH);
  assert.ok(fs.readFileSync(c.featureFile, 'utf8').includes('\r\n'), 'the checkout converted line ends');
  assert.equal(c.git('status', '--porcelain', '--', REPO_PATH), '', 'git itself calls it clean');
  blocked(c.design(), 'E_IDENTITY', /CRLF/);
});

test('S19a: a design commit made through a reformatting pre-commit hook is exit 1, never re-hashed', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  c.addRecord(c.review('spec', 1));
  const hook = path.join(c.repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nnode -e "const fs=require('fs');const p='${REPO_PATH}';fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')),null,4)+'\\\\n')"\ngit add ${REPO_PATH}\n`, { mode: 0o755 });
  c.git('add', REPO_PATH);
  c.git('commit', '-qm', 'design via hook');
  c.designCommit = c.git('rev-parse', 'HEAD');
  assert.notDeepEqual(c.exec('git', ['cat-file', 'blob', `${c.designCommit}:${REPO_PATH}`], { encoding: null }).stdout, fs.readFileSync(featurePath(c, 1)), 'the hook rewrote the file');
  c.compileFrozen();
  blocked(c.design(), 'E_FREEZE_RULE', /latest spec PASS/);
});

test('design: a first-time canonical file plus an unrelated staged file: the commit holds only the canonical path, the other stays staged', t => {
  const c = makeRepo(t);
  c.write('notes.txt', 'unrelated\n');
  c.git('add', 'notes.txt');
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  c.addRecord(c.review('spec', 1));
  c.commitDesign();
  assert.deepEqual(c.git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', c.designCommit).split('\n'), [REPO_PATH]);
  assert.deepEqual(c.git('diff', '--cached', '--name-only').split('\n'), ['notes.txt']);
  c.compileFrozen();
  passed(c.design({ expectParent: c.startHead }));
});

test('design: a commit block run after another writer moved the branch fails and leaves that writer\'s tip', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.write('other.txt', 'other writer\n');
  c.git('add', 'other.txt');
  c.git('commit', '-qm', 'other writer');
  const tip = c.git('rev-parse', 'HEAD');
  const r = c.commitBlock(1);
  assert.notEqual(r.status, 0);
  assert.equal(c.git('rev-parse', 'refs/heads/feature/greet'), tip);
});

test('design: a design commit with an extra file is exit 1', t => {
  const c = makeRepo(t);
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  c.addRecord(c.review('spec', 1));
  c.write('extra.txt', 'x\n');
  c.git('add', REPO_PATH, 'extra.txt');
  c.git('commit', '-qm', 'design plus extra');
  c.designCommit = c.git('rev-parse', 'HEAD');
  c.compileFrozen();
  blocked(c.design(), 'E_IDENTITY', /must change exactly/);
});

for (const file of ['execution-plan.json', 'prd.view.md', 'spec.view.md', 'compile-identity.json', 'extra.txt']) {
  test(`L2.4: ${file === 'extra.txt' ? 'an extra file in' : 'an edited ' + file + ' in'} the frozen dir is E_DRIFT for --mode design`, t => {
    const c = makeRepo(t).freeze();
    const p = path.join(c.frozenDir, file);
    if (file === 'extra.txt') fs.writeFileSync(p, 'x');
    else fs.appendFileSync(p, file.endsWith('.json') ? ' ' : '\nedited\n');
    const manifestSha = sha256(fs.readFileSync(c.manifestPath));
    blocked(c.design({ manifestSha }), file === 'execution-plan.json' ? null : 'E_DRIFT', /frozen dir differs|does not validate|manifest/);
  });
}

test('rev-0 fails closed: a predecessor in the parent commit without rev-0 is exit 1; with rev-0 it passes', t => {
  const prior = baseFeature();
  const mk = withRev0 => {
    const c = makeRepo(t, { baseFiles: { [REPO_PATH]: featureBytes(prior) } });
    const f = clone(prior);
    f.title = 'Greeting function, revised';
    c.writeFeature(f);
    if (withRev0) c.rev0(featureBytes(prior));
    return c.freeze();
  };
  blocked(mk(false).design(), 'E_REV0', /rev-0 must exist/);
  passed(mk(true).design());
});

test('rev-0 fails closed: a rev-0 differing from previous_design\'s blob is exit 1; equal passes', t => {
  const mk = rev0 => {
    const c = makeRepo(t, { beforeDesign: x => {
      x.write('.pipeline/old/greet.feature.json', featureBytes(baseFeature()));
      x.git('add', '-A');
      x.git('commit', '-qm', 'earlier design kept elsewhere');
    } });
    c.previous_design = { commit: c.startHead, repo_path: '.pipeline/old/greet.feature.json' };
    c.rev0(rev0);
    return c.freeze();
  };
  const other = baseFeature();
  other.title = 'Something else';
  blocked(mk(featureBytes(other)).design(), 'E_REV0', /previous_design blob/);
  passed(mk(featureBytes(baseFeature())).design());
});

test('rev-0 fails closed: a rev-0 without any predecessor is exit 1', t => {
  const c = makeRepo(t);
  c.rev0(featureBytes(baseFeature()));
  c.freeze();
  blocked(c.design(), 'E_REV0', /rev-0 exists/);
});

const boundFeature = edit => { const f = baseFeature(); edit(f); return f; };
for (const [name, edit, yaml] of [
  ['a state_paths entry', f => { f.scope.state_paths = ['state/']; }, 'state:\n  paths: ["other/"]\n'],
  ['a clean_ignore entry', f => { f.scope.clean_ignore = ['tmp/']; }, 'tests:\n  clean_ignore: []\n'],
  ['a known-failure id', f => { f.suite.known_failures = [{ test_id: 'legacy::flaky', reason: 'Predates the feature.' }]; }, 'tests:\n  known_failures: ["legacy::other"]  # synthetic\n'],
]) {
  test(`config bound: ${name} outside the .claude/pipeline.yaml list at design_commit is E_CONFIG_BOUND`, t => {
    const c = makeRepo(t, { feature: boundFeature(edit), pipelineYaml: yaml }).freeze();
    blocked(c.design(), 'E_CONFIG_BOUND');
  });
}

test('config bound: entries inside the lists pass and are echoed', t => {
  const c = makeRepo(t, {
    feature: boundFeature(f => { f.scope.state_paths = ['state/']; f.scope.clean_ignore = ['tmp/']; f.suite.known_failures = [{ test_id: 'legacy::flaky', reason: 'Predates the feature.' }]; }),
    pipelineYaml: 'tests:\n  known_failures: ["legacy::flaky"]   # owner list\n  clean_ignore: ["tmp/"]\nstate:\n  state_dir: ""\n  paths: ["state/", "more/"]\n',
  }).freeze();
  const d = passed(c.design());
  assert.deepEqual(d.config_bound.state_paths, ['state/', 'more/']);
  assert.deepEqual(d.known_failure_ids, ['legacy::flaky']);
});

for (const yaml of ['state:\n  paths: state/\n', 'state:\n  paths:\n    - state/\n', 'tests:\n  clean_ignore: [1]\n']) {
  test(`config bound: a value that is not a one-line JSON array of strings is exit 2 (${JSON.stringify(yaml)})`, t => {
    const c = makeRepo(t, { pipelineYaml: yaml }).freeze();
    const r = c.design();
    assert.equal(r.status, 2, r.stderr);
    assert.equal(JSON.parse(r.stderr).code, 'E_CONFIG_FORM');
  });
}

// boundList reads only the direct child key of the parent block: a nested key or text inside a block scalar is never
// the owner's bound, and a match at any other indent is refused (E_CONFIG_FORM) rather than guessed.
test('config bound: only the direct child key is the bound; nested or block-scalar matches are E_CONFIG_FORM', () => {
  const { boundList } = require('../scripts/check-completion.js');
  const code = fn => { try { fn(); return null; } catch (e) { return e.code; } };
  assert.deepEqual(boundList('tests:\n  known_failures: []\n  clean_ignore: ["tmp/"]  # owner\n', 'tests', 'clean_ignore'), ['tmp/']);
  assert.deepEqual(boundList('tests:\n  # clean_ignore: ["src/"]\n  known_failures: []\n', 'tests', 'clean_ignore'), [], 'a comment is not a key');
  assert.deepEqual(boundList('tests:\n  known_failures: []\nother:\n  clean_ignore: ["src/"]\n', 'tests', 'clean_ignore'), [], 'another block is not this one');
  assert.equal(code(() => boundList('tests:\n  matrix:\n    clean_ignore: ["dist/"]\n  known_failures: []\n', 'tests', 'clean_ignore')), 'E_CONFIG_FORM', 'a nested key is never the direct one');
  assert.equal(code(() => boundList('tests:\n  note: |\n    clean_ignore: ["src/"]\n', 'tests', 'clean_ignore')), 'E_CONFIG_FORM', 'text in a block scalar is never the key');
  assert.equal(code(() => boundList('tests:\n  matrix:\n    clean_ignore: ["dist/"]\n  clean_ignore: []\n', 'tests', 'clean_ignore')), 'E_CONFIG_FORM');
  assert.equal(code(() => boundList('tests:\n  clean_ignore: []\ntests:\n  clean_ignore: ["src/"]\n', 'tests', 'clean_ignore')), 'E_CONFIG_FORM', 'the parent block appears once');
});

test('design: --spec must be the canonical file in the repo, not a copy outside it', t => {
  const c = makeRepo(t).freeze();
  const copy = path.join(c.run, 'copy.feature.json');
  fs.copyFileSync(c.featureFile, copy);
  blocked(c.design({ spec: copy }), 'E_IDENTITY', /--spec must be/);
});

test('design: a v1 manifest under the v2 modes is exit 1', t => {
  const c = makeRepo(t).freeze();
  const v1 = path.join(c.run, 'v1');
  fs.mkdirSync(v1);
  fs.writeFileSync(path.join(v1, 'execution-plan.json'), JSON.stringify({ version: 1, feature_id: 'greet' }));
  blocked(c.design({ frozenDir: v1, manifestSha: sha256(fs.readFileSync(path.join(v1, 'execution-plan.json'))) }), 'E_IDENTITY', /version 2 manifest/);
});

test('v2 usage errors are exit 2', t => {
  const c = makeRepo(t).freeze();
  for (const argv of [['--mode', 'design', '--repo', c.repo], [...c.designArgs(), '--source', c.featureFile], ['--mode', 'approvals', '--repo', 'relative', '--approvals', c.approvalsPath, '--source', 'x']]) {
    const r = c.node('check-completion.js', argv);
    assert.equal(r.status, 2, r.stderr);
  }
});

// ---- --mode plan (v2; design 6.4) -------------------------------------------------------------------------------
test('plan v2 returns ids, labels and budgets, never a command', t => {
  const c = makeRepo(t).freeze();
  c.implement();
  const p = passed(c.plan());
  assert.equal(p.manifest_version, 2);
  assert.deepEqual(p.checks, [
    { id: 'CHECK-LINT', name: 'Lint', quiet: false, effort: 'low', budget_min: 0, timeout_min: 2 },
    { id: 'CHECK-LIVE', name: 'Live probe', quiet: true, effort: 'low', budget_min: 1, timeout_min: 2 },
  ]);
  assert.deepEqual(p.runtime_acceptance_ids, ['HELLO-001-AC1']);
  assert.deepEqual(p.limits, { proof_timeout_s: 30, negative_controls_total_min: 5 }, 'the limits, so verify can BLOCK a step that cannot fit in one Bash call');
  assert.equal(p.suite_setup, false);
  assert.deepEqual(p.live_acceptances, [{ id: 'HELLO-001-AC2', check_id: 'CHECK-LIVE' }]);
  assert.deepEqual(p.negative_controls, [{ id: 'HELLO-001-AC1', mutation_sha256: sha256('Make hello() return goodbye.') }]);
  assert.ok(!/node test|node --check/.test(JSON.stringify(p)), 'no command in the plan output');
});

test('plan v2: a frozen command holding the repo absolute path is exit 1', t => {
  const c = makeRepo(t);
  c.feature.checks[0].command = `node --check ${c.repo}/src/hello.js`;
  c.writeFeature();
  c.freeze();
  c.implement();
  blocked(c.plan(), 'E_REPO_PATH');
});

test('plan v2: an edited frozen view is E_DRIFT; a v2 manifest without --approvals fails the v1 path', t => {
  const c = makeRepo(t).freeze();
  c.implement();
  fs.appendFileSync(path.join(c.frozenDir, 'prd.view.md'), '\nedited\n');
  blocked(c.plan(), 'E_DRIFT');
  const v1 = c.node('check-completion.js', ['--mode', 'plan', '--repo', c.repo, '--feature-id', 'greet', '--reviewed-sha', c.reviewedSha, '--manifest', c.manifestPath, '--manifest-sha256', c.manifestSha, '--spec', c.featureFile]);
  assert.equal(v1.status, 1);
  assert.match(v1.stderr, /manifest version or feature does not match|outside the repo/);
});

// ---- contract-2 completion (design 6.5) -----------------------------------------------------------------------
const entryOf = (list, step) => list.find(e => e.step === step);

test('completion v2: a complete run certifies design-gated, derives reviewers from the files, and land revalidates with --trunk-ref', t => {
  const c = completeRun(t);
  const out = passed(c.completion());
  assert.equal(out.contract, 2);
  assert.equal(out.certification, 'design-gated');
  assert.equal(out.trunk_qualification, null);
  const proof = JSON.parse(fs.readFileSync(c.out, 'utf8'));
  assert.equal(proof.contract, 2);
  assert.equal(proof.design_commit, c.designCommit);
  assert.deepEqual(proof.design_paths, [REPO_PATH]);
  assert.equal(proof.cross_family, true);
  assert.equal(proof.fallback_used, false);
  assert.deepEqual(proof.reviewers.map(r => `${r.stage}:${r.step}:${r.reviewer}`), ['design:prd:codex', 'design:spec:codex', 'build:implementation:codex', 'build:security:codex', 'verify:final:codex', 'verify:compliance:codex']);
  assert.deepEqual(proof.negative_controls.counts, { isolated: 1, exempt: 2 });
  assert.deepEqual(proof.requirements.map(r => r.id), ['HELLO-001-AC1', 'HELLO-001-AC2', 'HELLO-001-AC3']);
  assert.deepEqual(proof.checks.map(x => [x.id, x.applicable]), [['CHECK-LINT', true], ['CHECK-LIVE', true], ['CHECK-UI', false]]);
  // land: revalidation against verify's proof, with the trunk ref (trunk moved in between)
  c.git('checkout', '-q', 'main');
  c.write('LATER.md', 'trunk moved on\n');
  c.git('add', 'LATER.md');
  c.git('commit', '-qm', 'trunk moved');
  c.git('checkout', '-q', 'feature/greet');
  const landed = passed(c.completion({ trunkRef: 'main', previous: c.out }));
  assert.equal(landed.trunk_qualification.pre_design_range_empty, true);
  assert.deepEqual(landed.trunk_qualification.pr_paths, [REPO_PATH, 'src/hello.js', 'test/hello.test.js', 'test/live.test.js']);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.out, 'utf8')).trunk_qualification, landed.trunk_qualification);
});

test('completion v2: a commit before the design commit that is not on trunk is exit 1 at --trunk-ref', t => {
  const c = completeRun(t, { beforeDesign: x => { x.write('src/early.js', 'unreviewed\n'); x.git('add', 'src/early.js'); x.git('commit', '-qm', 'pre-design commit'); } });
  passed(c.completion());
  blocked(c.completion({ trunkRef: 'main', previous: c.out }), 'E_TRUNK', /not on main/);
});

test('L2.4/L3.12: an edited frozen view is E_DRIFT for completion', t => {
  const c = completeRun(t);
  fs.appendFileSync(path.join(c.frozenDir, 'spec.view.md'), '\nedited\n');
  blocked(c.completion(), 'E_DRIFT');
});

test('L3.14: a build result stamped charge-only is rejected under v2', t => {
  const c = completeRun(t);
  c.build.build_mode = 'charge-only';
  blocked(c.completion(), 'E_BUILD_MODE', /charge-only/);
  delete c.build.build_mode;
  blocked(c.completion(), 'E_BUILD_MODE', /"v2"/);
});

test('completion v2: base_commit must be the design commit and plan_identity must match the preflight', t => {
  const c = completeRun(t);
  c.build.base_commit = c.startHead;
  c.verify.base_commit = c.startHead;
  blocked(c.completion(), 'E_BUILD', /not the design commit/);
  c.build.base_commit = c.verify.base_commit = c.designCommit;
  c.build.plan_identity.approvals_sha256 = '0'.repeat(64);
  blocked(c.completion(), 'E_BUILD', /plan_identity/);
});

// suite identity (design 6.3, 6.5; L3.7)
test('suite identity: a stamped suite command differing from the manifest is exit 1', t => {
  const c = completeRun(t);
  c.build.suite_identity.command = 'node test/other.test.js';
  blocked(c.completion(), 'E_SUITE', /suite_identity differs/);
});

test('suite identity: a failure listed only in known_failures_seen is exit 1', t => {
  const c = completeRun(t);
  c.build.known_failures_seen = ['legacy::flaky'];
  blocked(c.completion(), null, /exactly match known failures/);
});

const KNOWN = { test_id: 'legacy::flaky', reason: 'Predates the feature.' };
const ADDED = { test_id: 'test/hello.test.js::flaky', reason: 'Claimed to predate the feature.' };
function failingSuite(t, exitCode, extra = {}) {
  const feature = baseFeature();
  feature.suite.command = 'node test/suite.js';
  feature.suite.known_failures = [KNOWN, ADDED];
  const c = completeRun(t, {
    feature, pipelineYaml: 'tests:\n  known_failures: ["legacy::flaky", "test/hello.test.js::flaky"]\n',
    implFiles: { ...require('./helpers/v2-repo.js').IMPL_FILES, 'test/suite.js': `console.log('not ok legacy::flaky');\nprocess.exit(${exitCode});\n` }, ...extra,
  });
  c.build.suite_identity.command = 'node test/suite.js';
  c.build.suite_identity.known_failure_ids = [KNOWN.test_id, ADDED.test_id];
  return c;
}
const excuse = (c, id) => { c.build.suite.passed = false; c.build.suite.failures = [id]; c.build.known_failures_seen = [id]; };

test('suite identity: a nonzero suite exit whose failures are all known certifies KNOWN_BASELINE_FAILURES', t => {
  const c = failingSuite(t, 1);
  excuse(c, KNOWN.test_id);
  passed(c.completion());
  assert.equal(JSON.parse(fs.readFileSync(c.out, 'utf8')).suite.status, 'KNOWN_BASELINE_FAILURES');
});

test('suite identity: a known-failure id naming a test in tests_added is exit 1', t => {
  const c = failingSuite(t, 1);
  excuse(c, ADDED.test_id);
  blocked(c.completion(), 'E_SUITE', /names a test this build added or changed/);
});

test('suite identity: a suite record with exit 1 under a build result relaying passed: true, failures: [] is exit 1', t => {
  const c = failingSuite(t, 1);
  blocked(c.completion(), 'E_SUITE', /exited 1 while no known failure was seen/);
});

test('suite identity: a record with exit 0 and a nonempty known_failures_seen is exit 1', t => {
  const feature = baseFeature();
  feature.suite.known_failures = [KNOWN];
  const c = completeRun(t, { feature, pipelineYaml: 'tests:\n  known_failures: ["legacy::flaky"]\n' });
  c.build.suite_identity.known_failure_ids = [KNOWN.test_id];
  excuse(c, KNOWN.test_id);
  blocked(c.completion(), 'E_SUITE', /nonzero, non-crash suite exit \(got 0\)/);
});

test('suite identity: a record with exit 127 whose failures are all known is exit 1', t => {
  const c = failingSuite(t, 127);
  excuse(c, KNOWN.test_id);
  blocked(c.completion(), 'E_SUITE', /got 127/);
});

test('suite identity: a timed-out suite record whose failures are all known is exit 1', t => {
  const c = failingSuite(t, 1);
  excuse(c, KNOWN.test_id);
  const si = c.build.suite_identity;
  c.editRecord(si, r => { r.timed_out = true; });
  blocked(c.completion(), 'E_SUITE', /timed out/);
});

// test-first (design 6.3, 6.5): the red record binds a failing frozen unit run to a test-only commit before the implementation.
test('test-first: a complete run certifies its red commit; the proof carries test_first', t => {
  const c = completeRun(t);
  passed(c.completion());
  const proof = JSON.parse(fs.readFileSync(c.out, 'utf8'));
  assert.equal(proof.test_first.red_commit, c.redCommit);
  assert.equal(proof.test_first.record_sha256, c.build.test_first.record_sha256);
  assert.equal(proof.test_first.exit_code, 1);
  assert.deepEqual(proof.test_first.red_paths, ['test/hello.test.js', 'test/live.test.js']);
  assert.equal(proof.test_first.command, 'node test/hello.test.js');
});

test('test-first: a build result without test_first, or with extra fields, is exit 1', t => {
  const c = completeRun(t);
  const tf = c.build.test_first;
  delete c.build.test_first;
  blocked(c.completion(), 'E_TEST_FIRST', /test_first/);
  c.build.test_first = { ...tf, extra: 1 };
  blocked(c.completion(), 'E_TEST_FIRST', /test_first/);
});

test('test-first: a hand-made build result with a forged red record hash is exit 1 (E_HASH)', t => {
  const c = completeRun(t);
  c.build.test_first.record_sha256 = '0'.repeat(64);
  blocked(c.completion(), 'E_HASH', /red record/);
});

test('test-first: a red record edited to exit 0 (re-hashed, footer rewritten) is exit 1: RED needs a failing run', t => {
  const c = completeRun(t);
  const tf = c.build.test_first;
  const rec = JSON.parse(fs.readFileSync(tf.record_path, 'utf8'));
  const logSha = c.setFooter(rec.log_path, { exit_code: 0, signal: null, elapsed_s: rec.elapsed_s });
  c.editRecord(tf, r => { r.exit_code = 0; r.log_sha256 = logSha; });
  blocked(c.completion(), 'E_TEST_FIRST', /exit 0/);
});

test('test-first: a red record with exit 127 (re-hashed, footer rewritten) is exit 1: a crash is not a failing test', t => {
  const c = completeRun(t);
  const tf = c.build.test_first;
  const rec = JSON.parse(fs.readFileSync(tf.record_path, 'utf8'));
  const logSha = c.setFooter(rec.log_path, { exit_code: 127, signal: null, elapsed_s: rec.elapsed_s });
  c.editRecord(tf, r => { r.exit_code = 127; r.log_sha256 = logSha; });
  blocked(c.completion(), 'E_TEST_FIRST', /127/);
});

test('test-first: a red commit that is not an ancestor of reviewed_sha is exit 1, even with its own valid red record', t => {
  const c = completeRun(t);
  // a test-only commit on another branch from the design commit, with a real (failing) red run of its own
  c.git('checkout', '-q', '-b', 'side', c.designCommit);
  c.write('test/hello.test.js', require('./helpers/v2-repo.js').IMPL_FILES['test/hello.test.js']);
  c.git('add', '--', 'test/hello.test.js');
  c.git('commit', '-qm', 'red on another branch');
  const side = c.git('rev-parse', 'HEAD');
  c.git('checkout', '-q', 'feature/greet');
  const r = c.runFrozen('red', { sha: side, base: c.designCommit, outDir: path.join(c.run, 'side-red') });
  assert.equal(r.status, 0, r.stderr);
  const printed = JSON.parse(r.stdout);
  assert.equal(printed.exit_code, 1);
  c.build.test_first = { red_commit: side, record_path: printed.record_path, record_sha256: printed.record_sha256 };
  blocked(c.completion(), 'E_TEST_FIRST', /not a proper ancestor of the reviewed SHA/);
});

test('test-first: a red commit equal to reviewed_sha, or to the design commit, is exit 1', t => {
  const c = completeRun(t);
  c.build.test_first.red_commit = c.reviewedSha;
  blocked(c.completion(), 'E_TEST_FIRST', /not a proper ancestor of the reviewed SHA/);
  c.build.test_first.red_commit = c.designCommit;
  blocked(c.completion(), 'E_TEST_FIRST', /not a proper descendant of the design commit/);
});

test('test-first: a red commit whose range design_commit..red_commit touches src/ is exit 1', t => {
  // the "red" commit holds the code and one test; the other test comes after it
  const c = completeRun(t, { redFiles: ['src/hello.js', 'test/live.test.js'], red: false });
  c.build.test_first = { red_commit: c.redCommit, record_path: path.join(c.run, 'build', 'test-first', 'red.record.json'), record_sha256: '0'.repeat(64) };
  blocked(c.completion(), 'E_TEST_FIRST', /outside scope\.test_paths: src\/hello\.js/);
});

test('test-first: a red record of another target or another command is exit 1', t => {
  const c = completeRun(t);
  // the suite record is a frozen run too, but not the red one
  c.build.test_first.record_path = c.build.suite_identity.record_path;
  c.build.test_first.record_sha256 = c.build.suite_identity.record_sha256;
  blocked(c.completion(), 'E_RECORD', /target suite is not red/);
});

// reviews (design 6.5; L3.4, L3.7)
test('reviews: a final review verdict that drops a confirmed finding of its result.json is exit 1', t => {
  const c = completeRun(t);
  const e = entryOf(c.verify.review_files, 'final');
  c.editRecord(e, r => { r.findings = [{ id: 'F-1', severity: 'MAJOR', confidence: 0.3, iso_property: null, validation: { status: 'confirmed' }, claim: 'x', evidence: 'y' }]; }, 'result_path', 'result_sha256');
  blocked(c.completion(), 'E_REVIEW', /final verdict PASS differs from the verdict its review file gives: FAIL/);
});

test('reviews: a fallback-reviewed build certifies with cross_family false; the same file relabelled as codex is exit 1', t => {
  const c = completeRun(t);
  const old = entryOf(c.build.review_files, 'implementation');
  const dir = old.review_dir;
  const inputs = path.join(dir, 'inputs.json');
  assert.equal(c.node('hash-inputs.js', ['--out', inputs, path.join(c.repo, 'src', 'hello.js')]).status, 0);
  const fb = c.writeJson(path.join(dir, 'fallback-review.json'), { gate_kind: 'implementation', reviewer: FALLBACK_REVIEWER, reply: { findings: [{ severity: 'MINOR', confidence: 0.9, title: 'style' }] } });
  const entry = { step: 'implementation', round: 1, reviewer: FALLBACK_REVIEWER, review_dir: dir, inputs_path: inputs, inputs_sha256: sha256(fs.readFileSync(inputs)), fallback_review_path: fb.path, fallback_review_sha256: fb.sha256 };
  c.build.review_files[c.build.review_files.indexOf(old)] = entry;
  c.build.fallback_used = true;
  const out = passed(c.completion());
  assert.equal(out.cross_family, false);
  assert.equal(out.fallback_used, true);
  assert.equal(JSON.parse(fs.readFileSync(c.out, 'utf8')).cross_family, false);
  fs.unlinkSync(c.out);
  entry.reviewer = 'codex';
  blocked(c.completion(), 'E_REVIEW', /labelled codex/);
  entry.reviewer = FALLBACK_REVIEWER;
  c.build.fallback_used = false;
  blocked(c.completion(), 'E_REVIEW', /fallback_used false/);
});

test('reviews: a security PASS whose raw file holds a high finding is exit 1', t => {
  const c = completeRun(t);
  c.editRecord(entryOf(c.build.review_files, 'security'), r => { r.findings = [{ severity: 'high', file: 'src/hello.js', line: 1, title: 'leak', detail: 'x', category: 'data' }]; }, 'raw_path', 'raw_sha256');
  blocked(c.completion(), 'E_REVIEW', /security verdict PASS differs/);
});

// Review fix: the blocking set is every critical or high finding of findings AND blocking, so an empty findings list
// cannot hide a high entry of blocking (the fallback security reply schema puts its findings in blocking).
test('reviews: a security PASS whose raw file holds a high finding in blocking next to an empty findings list is exit 1', t => {
  const c = completeRun(t);
  c.editRecord(entryOf(c.build.review_files, 'security'), r => { r.findings = []; r.blocking = [{ severity: 'high', file: 'src/hello.js', line: 1, title: 'leak' }]; }, 'raw_path', 'raw_sha256');
  blocked(c.completion(), 'E_REVIEW', /security verdict PASS differs/);
});

test('reviews: a wrapped fallback security reply with findings [] and a high blocking entry is exit 1', t => {
  const c = completeRun(t);
  const old = entryOf(c.build.review_files, 'security');
  const raw = c.writeJson(path.join(old.review_dir, 'fallback-security.json'), { gate_kind: 'security', reviewer: FALLBACK_REVIEWER,
    reply: { verdict: 'PASS', findings: [], blocking: [{ severity: 'high', file: 'src/hello.js', line: 1, title: 'leak' }] } });
  Object.assign(old, { reviewer: FALLBACK_REVIEWER, raw_path: raw.path, raw_sha256: raw.sha256 });
  c.build.fallback_used = true;
  blocked(c.completion(), 'E_REVIEW', /security verdict PASS differs/);
  c.editRecord(old, r => { r.reply.blocking = [{ severity: 'medium', file: 'src/hello.js', line: 1, title: 'style' }]; }, 'raw_path', 'raw_sha256');
  passed(c.completion());
});

test('reviews: a compliance raw file with a FAIL requirement is exit 1 even when the stage relays PASS', t => {
  const c = completeRun(t);
  c.editRecord(entryOf(c.verify.review_files, 'compliance'), r => { r.requirements[0].status = 'FAIL'; }, 'raw_path', 'raw_sha256');
  blocked(c.completion(), 'E_REVIEW', /compliance verdict PASS differs/);
});

test('reviews: a review file whose hash differs from the recorded one is exit 1', t => {
  const c = completeRun(t);
  fs.appendFileSync(entryOf(c.build.review_files, 'implementation').result_path, ' ');
  blocked(c.completion(), 'E_HASH');
});

// proofs (design 6.5; L3.6)
test('proofs: a fallback compliance trace with a re-escaped command still certifies only through the ledger record', t => {
  const c = completeRun(t, { complianceRequirements: head => [
    { id: 'HELLO-001-AC1', status: 'PASS', evidence: [{ kind: 'runtime', head_sha: head, command: 'node test/hello.test.js \\"escaped\\"', exit_code: 0, log_path: '/nowhere', log_sha256: '0'.repeat(64), file: null, line: null }] },
    { id: 'HELLO-001-AC2', status: 'PASS', evidence: [] },
    { id: 'HELLO-001-AC3', status: 'PASS', evidence: [{ kind: 'static', head_sha: head, command: null, exit_code: null, log_path: null, log_sha256: null, file: 'src/hello.js', line: 1 }] },
  ] });
  const e = entryOf(c.verify.review_files, 'compliance');
  const raw = JSON.parse(fs.readFileSync(e.raw_path, 'utf8'));
  fs.unlinkSync(e.raw_path);
  const wrapped = c.writeJson(e.raw_path, { gate_kind: 'compliance', reviewer: FALLBACK_REVIEWER, reply: { verdict: 'PASS', blocking: [], requirements: raw.requirements } });
  Object.assign(e, { reviewer: FALLBACK_REVIEWER, raw_sha256: wrapped.sha256 });
  c.verify.fallback_used = true;
  passed(c.completion());
  const proof = JSON.parse(fs.readFileSync(c.out, 'utf8'));
  assert.deepEqual(proof.requirements[0].evidence.map(x => x.command), ['node test/hello.test.js']);
  assert.equal(proof.cross_family, false);
});

test('proofs: static evidence outside the frozen evidence_paths is exit 1', t => {
  const c = completeRun(t, { complianceRequirements: head => [
    { id: 'HELLO-001-AC1', status: 'PASS', evidence: [] }, { id: 'HELLO-001-AC2', status: 'PASS', evidence: [] },
    { id: 'HELLO-001-AC3', status: 'PASS', evidence: [{ kind: 'static', head_sha: head, command: null, exit_code: null, log_path: null, log_sha256: null, file: 'README.md', line: 1 }] },
  ] });
  blocked(c.completion(), 'E_PROOF', /outside the frozen evidence_paths/);
});

test('proofs: an exempt P0 acceptance must cite an alternate_evidence_paths entry', t => {
  const feature = baseFeature();
  feature.coverage[0].requirement_ids.push('HELLO-002');
  feature.requirements.push({ id: 'HELLO-002', status: 'active', goal_ids: ['GOAL-001'], statement: 'The greeting is documented.', priority: 'P0', depends_on: [], component_ids: ['COMP-LIB'],
    acceptance: [{ id: 'HELLO-002-AC1', status: 'active', given: 'the repo', when: 'it is read', then: 'the greeting is documented',
      verification: { kind: 'static', evidence: { paths: ['src/'], description: 'The code.' } },
      negative_control: { method: 'exempt', description: 'Static.', exemption_reason: 'No run to break.', alternate_evidence: { paths: ['README.md'], description: 'The readme.' } } }] });
  const traces = cite => head => [
    { id: 'HELLO-001-AC1', status: 'PASS', evidence: [] }, { id: 'HELLO-001-AC2', status: 'PASS', evidence: [] },
    { id: 'HELLO-001-AC3', status: 'PASS', evidence: [{ kind: 'static', head_sha: head, command: null, exit_code: null, log_path: null, log_sha256: null, file: 'src/hello.js', line: 1 }] },
    { id: 'HELLO-002-AC1', status: 'PASS', evidence: [{ kind: 'static', head_sha: head, command: null, exit_code: null, log_path: null, log_sha256: null, file: 'src/hello.js', line: 1 },
      ...(cite ? [{ kind: 'static', head_sha: head, command: null, exit_code: null, log_path: null, log_sha256: null, file: 'README.md', line: 1 }] : [])] },
  ];
  blocked(completeRun(t, { feature, complianceRequirements: traces(false) }).completion(), 'E_PROOF', /alternate_evidence_paths/);
  passed(completeRun(t, { feature, complianceRequirements: traces(true) }).completion());
});

test('proofs: a check whose measured elapsed_s exceeds its budget is exit 1', t => {
  const c = completeRun(t);
  const e = c.verify.check_records.find(x => x.check_id === 'CHECK-LIVE');
  const rec = JSON.parse(fs.readFileSync(e.record_path, 'utf8'));
  const logSha = c.setFooter(rec.log_path, { exit_code: 0, signal: null, elapsed_s: 75 });
  c.editRecord(e, r => { r.elapsed_s = 75; r.log_sha256 = logSha; });
  blocked(c.completion(), 'E_CHECK', /exceeds its budget/);
});

test('proofs: a check record with a command other than the manifest\'s, or a missing check, is exit 1', t => {
  const c = completeRun(t);
  const e = c.verify.check_records.find(x => x.check_id === 'CHECK-LINT');
  c.editRecord(e, r => { r.command = 'true'; });
  blocked(c.completion(), 'E_RECORD', /not the frozen one/);
  c.verify.check_records = c.verify.check_records.filter(x => x !== e);
  blocked(c.completion(), 'E_CHECK', /missing check record: CHECK-LINT/);
});

test('proofs: an acceptance ledger missing a runtime acceptance is exit 1', t => {
  const c = completeRun(t);
  const al = c.verify.acceptance_ledger;
  c.editRecord(al, l => { l.entries = l.entries.filter(x => x.id !== 'HELLO-001-AC1'); }, 'path', 'sha256');
  blocked(c.completion(), 'E_PROOF', /not the manifest runtime acceptance ids/);
});

// negative controls (L3.13)
const negEntry = c => c.verify.negative_controls[0];
const negRecord = c => JSON.parse(fs.readFileSync(negEntry(c).record_path, 'utf8'));
for (const [name, mutate, pattern, footerExit] of [
  ['an environment failure (baseline red)', r => { r.baseline_exit_code = 1; }, /baseline proof must pass/],
  ['a null mutated exit code', r => { r.exit_code = null; }, /must be integers/, null],
  ['a mutated exit 127', r => { r.exit_code = 127; }, /crashed \(exit 127\)/, 127],
  ['reported mutated_paths differing from the patch', r => { r.mutated_paths = ['src/other.js']; }, /are not the patch's/],
  ['a NOT RUN record', r => { for (const k of Object.keys(r)) if (!['target', 'id'].includes(k)) delete r[k]; r.status = 'NOT_RUN'; r.reason = 'phase time used'; }, /NOT RUN/],
]) {
  test(`negative controls: ${name} is rejected`, t => {
    const c = completeRun(t);
    const e = negEntry(c);
    if (footerExit !== undefined) {
      // an attested record edited consistently: the log footer says the same as the record
      const rec = JSON.parse(fs.readFileSync(e.record_path, 'utf8'));
      const sha = c.setFooter(rec.log_path, { exit_code: footerExit, signal: null, elapsed_s: rec.elapsed_s });
      c.editRecord(e, r => { mutate(r); r.log_sha256 = sha; });
    } else c.editRecord(e, mutate);
    blocked(c.completion(), 'E_NEGATIVE_CONTROL', pattern);
  });
}

test('negative controls: a missing record is NOT RUN, exit 1 naming the id', t => {
  const c = completeRun(t);
  c.verify.negative_controls = [];
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /HELLO-001-AC1 is NOT RUN/);
});

test('negative controls: a hanging mutation run through run-frozen ends within the limit and is rejected', t => {
  const feature = baseFeature();
  feature.limits.proof_timeout_s = 2;
  const c = completeRun(t, { feature, runEnv: { GP_RUN_FROZEN_KILL_GRACE_S: '1' },
    mutation: "diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1 +1 @@\n-module.exports = () => 'hello';\n+for (;;) {}\n" });
  const rec = JSON.parse(fs.readFileSync(negEntry(c).record_path, 'utf8'));
  assert.equal(rec.timed_out, true);
  assert.ok(rec.elapsed_s < 6);
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /timed out/);
});

test('negative controls: a weak control (the mutated proof still passes) is rejected', t => {
  const c = completeRun(t, { mutation: "diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1 +1,2 @@\n module.exports = () => 'hello';\n+// a comment changes nothing\n" });
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /weak control/);
});

// Review fix: a content-only `git diff` of an executable owned file carries `index <a>..<b> 100755` and certifies.
test('negative controls: a git-generated patch editing an executable owned file certifies', t => {
  let text;
  const c = completeRun(t, { executable: ['src/hello.js'], mutation: x => (text = x.gitDiff('src/hello.js', "module.exports = () => 'goodbye';\n")) });
  assert.match(text, /^index [0-9a-f]+\.\.[0-9a-f]+ 100755$/m);
  const out = passed(c.completion());
  assert.deepEqual(JSON.parse(fs.readFileSync(negEntry(c).record_path, 'utf8')).mutated_paths, ['src/hello.js']);
  assert.ok(out);
});

// Swaps the recorded patch for `text` and re-hashes it; mutated_paths becomes the literal `paths` (what a recorder
// would have claimed), or stays as recorded when `paths` is omitted.
function swapPatch(c, text, paths) {
  const e = negEntry(c);
  const rec = JSON.parse(fs.readFileSync(e.record_path, 'utf8'));
  fs.writeFileSync(rec.mutation_patch_path, text);
  c.editRecord(e, r => { r.mutation_patch_sha256 = sha256(Buffer.from(text)); if (paths) r.mutated_paths = paths; });
}
const patchFor = (file, from, to) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

test('negative controls: a patch deleting the test file is rejected', t => {
  const c = completeRun(t);
  swapPatch(c, "diff --git a/test/hello.test.js b/test/hello.test.js\ndeleted file mode 100644\n--- a/test/hello.test.js\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-const assert = require('assert');\n-assert.equal(require('../src/hello.js')(), 'hello');\n-console.log('hello test ok');\n");
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /deletes/);
});

test('negative controls: a patch editing a co-located test the build added is rejected', t => {
  const c = completeRun(t, { implFiles: { ...require('./helpers/v2-repo.js').IMPL_FILES, 'src/hello.spec.js': "console.log('spec');\n" } });
  c.build.history[0].work.tests_added.push('src/hello.spec.js');
  swapPatch(c, patchFor('src/hello.spec.js', "console.log('spec');", "process.exit(1);"), ['src/hello.spec.js']);
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /is a test this build added/);
});

test('negative controls: a patch that does not apply to reviewed_sha is rejected', t => {
  const c = completeRun(t);
  swapPatch(c, patchFor('src/hello.js', "module.exports = () => 'nothing like this';", "module.exports = () => 'x';"), ['src/hello.js']);
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /does not apply/);
});

test('negative controls: a patch outside the requirement\'s owned paths is rejected', t => {
  const c = completeRun(t);
  swapPatch(c, patchFor('README.md', 'Synthetic repo.', 'Changed.'), ['README.md']);
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /outside the owned paths/);
});

// A recorder that took mutated_paths from the diff --git headers alone would claim ['src/hello.js'] for these
// patches, while git apply also edits test/hello.test.js (review fix; expectations are literals).
const TEST_BREAK = "--- a/test/hello.test.js\n+++ b/test/hello.test.js\n@@ -1,3 +1,3 @@\n const assert = require('assert');\n-assert.equal(require('../src/hello.js')(), 'hello');\n+process.exit(1);\n console.log('hello test ok');\n";
const NOOP_HELLO = "diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1 +1,2 @@\n module.exports = () => 'hello';\n+// a comment changes nothing\n";
for (const [name, text, pattern] of [
  ['a leading plain hunk on a test file', TEST_BREAK + NOOP_HELLO, /text before its first diff --git header/],
  ['a trailing plain hunk on a test file', NOOP_HELLO + TEST_BREAK, /outside a diff --git section's hunks/],
  ['---/+++ names that differ from the diff --git header', 'diff --git a/src/hello.js b/src/hello.js\n' + TEST_BREAK, /does not name src\/hello.js/],
]) {
  test(`negative controls: a patch with ${name} is rejected although its headers name only owned code`, t => {
    const c = completeRun(t);
    swapPatch(c, text, ['src/hello.js']);
    // the swapped patch applies to reviewed_sha, so only the path derivation can catch it
    const check = spawnSync('git', ['apply', '--check', negRecord(c).mutation_patch_path], { cwd: c.repo, encoding: 'utf8', env: cleanEnv() });
    assert.equal(check.status, 0, check.stderr);
    blocked(c.completion(), 'E_NEGATIVE_CONTROL', pattern);
  });
}

test('negative controls: the setup log of a control is hashed and frame-checked when setup_command is set', t => {
  const feature = baseFeature();
  feature.suite.setup_command = 'node -e "console.log(1)"';
  const c = completeRun(t, { feature });
  c.build.suite_identity.setup_command = feature.suite.setup_command;
  passed(c.completion());
  const rec = negRecord(c);
  assert.equal(rec.setup.exit_code, 0);
  fs.appendFileSync(rec.setup.log_path, 'tampered\n');
  blocked(c.completion(), 'E_HASH', /setup log/);
  const sha = c.setFooter(rec.setup.log_path, { exit_code: 3, signal: null, elapsed_s: 0 });
  c.editRecord(negEntry(c), r => { r.setup.log_sha256 = sha; });
  blocked(c.completion(), 'E_RECORD', /setup: the log/);
});

test('negative controls: a record without setup_command but with a setup block is rejected', t => {
  const c = completeRun(t);
  c.editRecord(negEntry(c), r => { r.setup = { exit_code: 0, log_path: r.log_path, log_sha256: r.log_sha256, timed_out: false }; });
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /setup null/);
});

test('negative controls: a mutated run under a limit above proof_timeout_s is rejected', t => {
  const c = completeRun(t);
  c.editRecord(negEntry(c), r => { r.timeout_s = 31; });
  blocked(c.completion(), 'E_NEGATIVE_CONTROL', /above proof_timeout_s/);
});

test('negative controls: a patch file that changed after the run is rejected', t => {
  const c = completeRun(t);
  const rec = JSON.parse(fs.readFileSync(negEntry(c).record_path, 'utf8'));
  fs.appendFileSync(rec.mutation_patch_path, '\n');
  blocked(c.completion(), 'E_HASH', /patch/);
});

// run-frozen records bind the frozen manifest they ran from (review B5)
test('records: a check, suite, red or negative-control record stamped with another manifest_sha256 is exit 1', t => {
  const other = 'a'.repeat(64);
  for (const [name, entry, code] of [
    ['check', c => c.verify.check_records.find(x => x.check_id === 'CHECK-LINT'), 'E_RECORD'],
    ['suite', c => c.build.suite_identity, 'E_RECORD'],
    ['red', c => c.build.test_first, 'E_RECORD'],
    ['negative', c => negEntry(c), 'E_NEGATIVE_CONTROL'],
  ]) {
    const c = completeRun(t);
    c.editRecord(entry(c), r => { r.manifest_sha256 = other; });
    blocked(c.completion(), code, /manifest_sha256/);
  }
});

// status lines of a record: the old -> new form is a rename or copy only (review B2)
test('records: a dirty file named "tmp -> tmp" is not read as a rename into clean_ignore; real renames inside it stay clean', t => {
  const feature = boundFeature(f => { f.scope.clean_ignore = ['tmp/']; });
  const pipelineYaml = 'tests:\n  known_failures: []\n  clean_ignore: ["tmp/"]\nstate:\n  paths: []\n';
  for (const [lines, ok] of [
    [['?? "tmp -> tmp"'], false],
    [[' M "tmp -> tmp"'], false],
    [['R  plain -> "tmp -> tmp"'], false],
    [['R  tmp/a -> tmp/b'], true],
    [['?? tmp/x', '?? "tmp/a b"'], true],
    [['R  src/a -> tmp/b'], false],
  ]) {
    const c = completeRun(t, { feature, pipelineYaml });
    c.editRecord(c.verify.check_records.find(x => x.check_id === 'CHECK-LINT'), r => { r.status_before = lines; });
    if (ok) passed(c.completion());
    else blocked(c.completion(), 'E_RECORD', /clean|status/);
  }
});

test('completion v2: a previous proof from another design is refused; an unchanged one revalidates', t => {
  const c = completeRun(t);
  passed(c.completion());
  const before = JSON.parse(fs.readFileSync(c.out, 'utf8'));
  passed(c.completion({ previous: c.out }));
  const after = JSON.parse(fs.readFileSync(c.out, 'utf8'));
  delete before.checked_at;
  delete after.checked_at;
  assert.deepEqual(after, before);
  c.editJson(c.out, p => { p.approvals_sha256 = '0'.repeat(64); });
  blocked(c.completion({ previous: c.out }), 'E_PREVIOUS');
});
