'use strict';

// WP6 (docs/v2-plan.md, docs/v2-design.md section 8): scripts/migrate-v1.js on synthetic v1 fixtures
// (tests/fixtures/v1-migrate/<case>/: execution-plan.json, spec.md, optional prd.md and request.txt, expect.json).
// Each case names the report entries it must produce: the exact acceptance-id/proof mapping, todos, conflicts,
// unmapped tests, lost sections and missing provenance. Every case also checks that the inputs are byte-unchanged,
// that every MIGRATION-TODO in the draft is listed in the report (and nothing else is), and that the draft never
// validates. The preservation test runs the v1 completion on a real v1 run after migrating it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test, describe, after } = require('node:test');
const { fixture: v1Run } = require('./helpers/v1-completion-cases');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const MIGRATE = path.join(SCRIPTS, 'migrate-v1.js');
const VALIDATE = path.join(SCRIPTS, 'validate-feature.js');
const COMPLETION = path.join(SCRIPTS, 'check-completion.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'v1-migrate');
const TOKEN = 'MIGRATION-TODO';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function tmp() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-migrate-'));
  roots.push(r);
  return r;
}
const node = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...opts });
function migrate(args) {
  const r = node(MIGRATE, args);
  return { ...r, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}
// Every file below dir, as { relative path: sha256 }.
function hashTree(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(dir, p)] = sha256(fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}
// JSON pointers of every string equal to (or containing) the token.
function tokenPaths(value, pointer = '', out = { equal: [], inside: [] }) {
  if (typeof value === 'string') {
    if (value === TOKEN) out.equal.push(pointer);
    else if (value.includes(TOKEN)) out.inside.push(pointer);
  } else if (Array.isArray(value)) value.forEach((v, i) => tokenPaths(v, `${pointer}/${i}`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) tokenPaths(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
  return out;
}
const at = (root, pointer) => pointer.split('/').slice(1).reduce((v, k) => v[k], root);
function setAt(root, pointer, value) {
  const keys = pointer.split('/').slice(1);
  const last = keys.pop();
  keys.reduce((v, k) => v[k], root)[last] = value;
}

function runCase(name, extra = {}) {
  const dir = path.join(FIXTURES, name);
  const expect = JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'execution-plan.json'), 'utf8'));
  const out = path.join(tmp(), 'draft.feature.json');
  const args = ['--manifest', path.join(dir, 'execution-plan.json'), '--spec', path.join(dir, 'spec.md'), '--feature-id', manifest.feature_id, '--out', out];
  if (expect.prd) args.push('--prd', path.join(dir, 'prd.md'));
  if (expect.source_request) args.push('--source-request', path.join(dir, 'request.txt'));
  const before = hashTree(dir);
  const r = migrate([...args, ...(extra.args || [])]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(hashTree(dir), before, 'the v1 inputs are byte-unchanged');
  const draft = JSON.parse(fs.readFileSync(out, 'utf8'));
  const report = JSON.parse(fs.readFileSync(out + '.report.json', 'utf8'));
  return { dir, expect, manifest, out, draft, report, stdout: r.json };
}

describe('migrate-v1 fixtures (design 8, plan 5.4)', () => {
  for (const name of fs.readdirSync(FIXTURES).sort()) {
    test(`${name}: report, exact mapping, inputs unchanged, draft never validates`, () => {
      const { expect, manifest, out, draft, report, stdout } = runCase(name);
      // the report entries this fixture is about
      assert.deepEqual(report.mapping, expect.mapping, 'mapping');
      assert.deepEqual(report.conflicts, expect.conflicts, 'conflicts');
      assert.deepEqual(report.unmapped_tests, expect.unmapped_tests, 'unmapped_tests');
      assert.deepEqual(report.lost, expect.lost, 'lost');
      assert.equal(report.provenance_missing, expect.provenance_missing, 'provenance_missing');
      for (const want of expect.todos_include) {
        const hit = report.todos.find(t => t.path === want.path);
        assert.ok(hit, `todo ${want.path} is reported`);
        assert.ok(hit.reason.includes(want.reason_includes), `todo ${want.path} reason ${JSON.stringify(hit.reason)} names ${JSON.stringify(want.reason_includes)}`);
      }
      // stdout is a summary; exit 0 means "draft written", never "certified"
      assert.equal(stdout.status, 'DRAFT_WRITTEN');
      assert.equal(stdout.todos, report.todos.length);
      // every token in the draft is a whole field and is listed; no todo names a field without the token
      const tokens = tokenPaths(draft);
      assert.deepEqual(tokens.inside, [], 'the token is always a whole field value');
      assert.ok(tokens.equal.length > 0, 'a draft always carries MIGRATION-TODO');
      assert.deepEqual(report.todos.map(t => t.path).sort(), tokens.equal.sort(), 'todos are exactly the token fields');
      assert.equal(new Set(report.todos.map(t => t.path)).size, report.todos.length, 'one todo per field');
      // exact acceptance ids and proof commands, in manifest order
      const acceptances = draft.requirements.flatMap(q => q.acceptance.map(a => ({ q, a })));
      assert.deepEqual(acceptances.map(x => x.a.id), report.mapping.map(m => m.acceptance_id));
      report.mapping.forEach((m, i) => {
        const { q, a } = acceptances[i];
        assert.equal(m.v1_id, manifest.requirements[i].id);
        assert.equal(m.v1_proof_command, manifest.requirements[i].proof_command);
        assert.equal(q.id, m.requirement_id);
        assert.equal(a.verification.kind, m.kind);
        assert.equal(a.verification.kind === 'runtime' ? a.verification.command : null, m.command);
        if (m.kind === 'static') assert.equal(a.negative_control.method, 'exempt');
      });
      // scope and check copies
      assert.equal(draft.schema_version, 2);
      assert.equal(draft.feature_id, manifest.feature_id);
      for (const k of ['allowed_paths', 'protected_paths', 'state_paths', 'clean_ignore']) assert.deepEqual(draft.scope[k], manifest[k] || [], k);
      assert.deepEqual(draft.checks.map(c => [c.name, c.applicable]), manifest.checks.map(c => [c.name, c.applicable]));
      manifest.checks.forEach((c, i) => assert.equal(draft.checks[i].reason, c.reason || TOKEN));
      // the draft is rejected by the validator
      const v = node(VALIDATE, ['--file', out, '--repo-path', `.pipeline/features/${manifest.feature_id}.feature.json`]);
      assert.equal(v.status, 1, v.stderr + v.stdout);
      assert.equal(JSON.parse(v.stdout).valid, false);
    });
  }

  test('exact: with every todo filled the draft validates; one todo left is E_MIGRATION_TODO (G39)', () => {
    const { dir, draft, report, out } = runCase('exact');
    const byKey = {
      priority: 'P1', live: false, exclusive: true, timeout_min: 5, budget_min: 0, quiet: false, effort: 'low', isolated: false,
      proof_timeout_s: 60, negative_controls_total_min: 5, live_budget_min: 0, command: 'npm test', unit_command: 'npm test',
      setup_command: null,
    };
    const byPath = { '/architecture/components/0/owned_paths/0': 'src/', '/scope/test_paths/0': 'test/', '/requirements/1/acceptance/0/verification/evidence/paths/0': 'src/' };
    let n = 0;
    for (const t of report.todos) {
      const key = t.path.split('/').pop();
      setAt(draft, t.path, t.path in byPath ? byPath[t.path] : key in byKey ? byKey[key] : `Filled text number ${++n}.`);
    }
    const filled = out.replace(/draft/, 'filled');
    fs.writeFileSync(filled, JSON.stringify(draft, null, 2) + '\n');
    const v = node(VALIDATE, ['--file', filled, '--repo-path', '.pipeline/features/login.feature.json', '--source-request', path.join(dir, 'request.txt')]);
    assert.equal(v.status, 0, v.stdout);
    setAt(draft, '/test_plan', TOKEN);
    fs.writeFileSync(filled, JSON.stringify(draft, null, 2) + '\n');
    const v2 = node(VALIDATE, ['--file', filled, '--repo-path', '.pipeline/features/login.feature.json']);
    assert.equal(v2.status, 1);
    assert.deepEqual(JSON.parse(v2.stdout).errors.map(e => [e.code, e.rule, e.path]), [['E_MIGRATION_TODO', 'G39', '/test_plan']]);
    assert.equal(at(draft, '/title'), 'Login lockout');
    assert.equal(at(draft, '/source_request/text'), 'Lock an account after five failed logins.');
  });

  test('a spec.md that does not hash to the manifest spec_sha256 is a conflict', () => {
    const root = tmp();
    const src = path.join(FIXTURES, 'provenance');
    for (const f of ['execution-plan.json', 'spec.md']) fs.copyFileSync(path.join(src, f), path.join(root, f));
    fs.appendFileSync(path.join(root, 'spec.md'), 'An edit after freeze.\n');
    const out = path.join(root, 'draft.json');
    const r = migrate(['--manifest', path.join(root, 'execution-plan.json'), '--spec', path.join(root, 'spec.md'), '--feature-id', 'health', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(fs.readFileSync(out + '.report.json', 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'execution-plan.json'), 'utf8'));
    assert.deepEqual(report.conflicts, [{ kind: 'spec_sha256_differs', id: null, manifest: manifest.spec_sha256, spec: sha256(fs.readFileSync(path.join(root, 'spec.md'))) }]);
  });

  test('usage and setup errors exit 2 and write nothing', () => {
    const dir = path.join(FIXTURES, 'exact');
    const base = ['--manifest', path.join(dir, 'execution-plan.json'), '--spec', path.join(dir, 'spec.md'), '--feature-id', 'login'];
    const root = tmp();
    const badManifest = path.join(root, 'v2.json');
    fs.writeFileSync(badManifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'execution-plan.json'), 'utf8')), version: 2 }));
    const dupManifest = path.join(root, 'dup.json');
    fs.writeFileSync(dupManifest, '{"version":1,"version":1}');
    const badSpec = path.join(root, 'bad.md');
    fs.writeFileSync(badSpec, Buffer.from([0x23, 0x20, 0xff, 0x0a]));
    const existing = path.join(root, 'existing.json');
    fs.writeFileSync(existing, '{}');
    const reportExists = path.join(root, 'r.json');
    fs.writeFileSync(reportExists + '.report.json', '{}');
    const cases = [
      ['no --out', base],
      ['unknown flag', [...base, '--out', path.join(root, 'a.json'), '--bogus', 'x']],
      ['flag twice', [...base, '--out', path.join(root, 'b.json'), '--feature-id', 'login']],
      ['feature id differs from the manifest', [...base.slice(0, 5), 'other', '--out', path.join(root, 'c.json')]],
      ['unsafe feature id', [...base.slice(0, 5), '../x', '--out', path.join(root, 'd.json')]],
      ['a version 2 manifest', ['--manifest', badManifest, ...base.slice(2), '--out', path.join(root, 'e.json')]],
      ['a duplicate key in the manifest', ['--manifest', dupManifest, ...base.slice(2), '--out', path.join(root, 'f.json')]],
      ['invalid UTF-8 in spec.md', [...base.slice(0, 2), '--spec', badSpec, ...base.slice(4), '--out', path.join(root, 'g.json')]],
      ['missing prd.md', [...base, '--prd', path.join(root, 'absent.md'), '--out', path.join(root, 'h.json')]],
      ['an existing --out', [...base, '--out', existing]],
      ['an existing report', [...base, '--out', reportExists]],
      ['--out over an input', [...base, '--out', path.join(dir, 'spec.md')]],
      ['--out in a missing directory', [...base, '--out', path.join(root, 'none', 'x.json')]],
    ];
    const before = hashTree(root);
    const fixturesBefore = hashTree(dir);
    for (const [label, args] of cases) {
      const r = migrate(args);
      assert.equal(r.status, 2, `${label}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, '', label);
      assert.ok(r.stderr.trim(), `${label}: the reason goes to stderr`);
    }
    assert.deepEqual(hashTree(root), before, 'nothing written');
    assert.deepEqual(hashTree(dir), fixturesBefore, 'inputs unchanged');
  });
});

test('preservation: migrating a frozen v1 run leaves its inputs byte-unchanged and its v1 completion still passes', () => {
  const root = tmp();
  const f = v1Run(root);
  const prd = path.join(f.artifacts, 'prd.md');
  fs.writeFileSync(prd, '# Feature one\n\n## Problem\nThe app answers false.\n');
  const gitState = () => [f.git(f.repo, 'rev-parse', 'HEAD'), f.git(f.repo, 'status', '--porcelain=v1', '--untracked-files=all')];
  const stateBefore = gitState();
  const before = hashTree(root);
  fs.mkdirSync(path.join(root, 'migrated'));
  const out = path.join(root, 'migrated', 'feature-1.feature.json');
  const r = migrate(['--manifest', f.manifestPath, '--spec', f.spec, '--prd', prd, '--feature-id', 'feature-1', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const after = hashTree(root);
  for (const k of Object.keys(after)) if (k.startsWith('migrated' + path.sep)) delete after[k];
  assert.deepEqual(after, before, 'every file of the v1 run (repo, plan, spec, prd, results, logs) is byte-unchanged');
  assert.deepEqual(gitState(), stateBefore, 'HEAD and the work tree are unchanged');
  const report = JSON.parse(fs.readFileSync(out + '.report.json', 'utf8'));
  assert.deepEqual(report.mapping.map(m => [m.v1_id, m.acceptance_id, m.renamed]), [['R1', 'MIG-001-AC1', true], ['R2', 'MIG-002-AC1', true]]);
  // the original run, unchanged, still completes under contract 1
  const c = node(COMPLETION, f.argv());
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(JSON.parse(c.stdout).status, 'PASS');
  const proof = JSON.parse(fs.readFileSync(f.out, 'utf8'));
  assert.equal(proof.contract, undefined, 'a v1 proof carries no contract field');
});
