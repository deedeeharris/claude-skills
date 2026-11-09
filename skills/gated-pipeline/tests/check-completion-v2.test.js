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
