#!/usr/bin/env node
'use strict';

// Level 2 tests of scripts/compile-feature.js and scripts/lib/feature-render.js (plan WP2 and rows L2.1-L2.4,
// L2.6, L2.7 of plan 3.3; fixture matrix rows S01, S02, S13, S17, S20 of plan 3.2), against
// docs/v2-design.md section 4. The CLI runs as a child process; the leaf-mutation test calls the renderer
// library directly (it needs hundreds of renders and judges only views and hashes, not validity).
// Every repo, checkout and output directory is a temporary directory made at run time.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const SKILL = path.resolve(__dirname, '..');
const COMPILER = path.join(SKILL, 'scripts/compile-feature.js');
const VALIDATOR = path.join(SKILL, 'scripts/validate-feature.js');
const MANIFEST_SCHEMA = path.join(SKILL, 'schemas/execution-plan.v2.schema.json');
const VALID = path.join(__dirname, 'fixtures/v2/valid');
const DESIGN = path.join(SKILL, 'docs/v2-design.md');
const { renderAll } = require(path.join(SKILL, 'scripts/lib/feature-render.js'));
const { compile: compileSchema } = require(path.join(SKILL, 'scripts/lib/schema-lite.js'));
const { parse } = require(path.join(SKILL, 'scripts/lib/strict-json.js'));

const FILES = ['compile-identity.json', 'execution-plan.json', 'prd.view.md', 'spec.view.md'];
const LEVEL2 = ['S01-minimal', 'medium', 'multi-component'];
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const readFixture = stem => fs.readFileSync(path.join(VALID, `${stem}.feature.json`));
const allValid = () => fs.readdirSync(VALID).filter(n => n.endsWith('.feature.json')).sort().map(n => n.slice(0, -'.feature.json'.length));

// Copied by hand from docs/v2-design.md section 4 ("PRD projection: ... of exactly these fields"). The meta-test
// parses the design and asserts equality; this list is never imported from feature-render.js.
const PROJECTION_TOP = ['source_request', 'coverage', 'product', 'architecture.decisions', 'architecture.invariants', 'architecture.security'];
const PROJECTION_REQUIREMENT = ['id', 'status', 'retired_rationale', 'goal_ids', 'statement', 'priority', 'depends_on', 'derived_rationale'];
const PROJECTION_ACCEPTANCE = ['id', 'status', 'retired_rationale', 'given', 'when', 'then', 'verification.kind'];

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A checkout-like directory holding the canonical file at .pipeline/features/<feature_id>.feature.json.
function checkout(root, bytes) {
  const featureId = JSON.parse(bytes.toString('utf8')).feature_id;
  const repo = path.join(root, 'repo');
  const repoPath = `.pipeline/features/${featureId}.feature.json`;
  fs.mkdirSync(path.join(repo, '.pipeline/features'), { recursive: true });
  const file = path.join(repo, repoPath);
  fs.writeFileSync(file, bytes);
  return { repo, repoPath, file };
}

function compileCli({ file, repo, repoPath, out, check, cwd, env }) {
  const argv = [COMPILER, '--file', file, '--repo', repo, '--repo-path', repoPath];
  if (out !== undefined) argv.push('--out', out);
  if (check !== undefined) argv.push('--check', check);
  const res = spawnSync(process.execPath, argv, { cwd: cwd || os.tmpdir(), env: env || process.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* asserted by callers */ }
  return { status: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr, json };
}

function compiledDir(t, bytes, prefix = 'gp-compile-') {
  const root = tmpdir(t, prefix);
  const co = checkout(root, bytes);
  const out = path.join(root, 'out');
  const res = compileCli({ ...co, out });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  return { ...co, root, out, res };
}

const readOut = dir => Object.fromEntries(FILES.map(n => [n, fs.readFileSync(path.join(dir, n))]));
const render = (value, bytes, repoPath) => renderAll(value, bytes, repoPath || `.pipeline/features/${value.feature_id}.feature.json`);

// ---- L2.1 determinism --------------------------------------------------------------------------------------

test('L2.1 determinism: two checkouts at different absolute paths, cwd, TZ and LC_ALL compile byte-identical outputs', t => {
  for (const stem of LEVEL2) {
    const bytes = readFixture(stem);
    const rootA = tmpdir(t, 'gp-det-a-');
    const rootB = path.join(tmpdir(t, 'gp-det-b-'), 'nested dir ü', 'deeper');
    fs.mkdirSync(rootB, { recursive: true });
    const a = checkout(rootA, bytes);
    const b = checkout(rootB, bytes);
    const outA = path.join(rootA, 'out');
    const outB = path.join(tmpdir(t, 'gp-det-out-'), 'frozen');
    const resA = compileCli({ ...a, out: outA, cwd: a.repo, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
    // B passes --file relative to its cwd.
    const resB = compileCli({ ...b, file: path.relative(rootB, b.file), out: outB, cwd: rootB, env: { ...process.env, TZ: 'Pacific/Chatham', LC_ALL: 'tr_TR.UTF-8', LANG: 'tr_TR.UTF-8' } });
    assert.equal(resA.status, 0, stem + resA.stderr);
    assert.equal(resB.status, 0, stem + resB.stderr);
    const filesA = readOut(outA), filesB = readOut(outB);
    for (const n of FILES) assert.ok(filesA[n].equals(filesB[n]), `${stem}: ${n} differs between checkouts`);
    assert.deepEqual(fs.readdirSync(outA).sort(), FILES);
    for (const k of ['source_sha256', 'prd_projection_sha256', 'prd_view_sha256', 'spec_view_sha256', 'manifest_sha256', 'identity_sha256']) {
      assert.equal(resA.json[k], resB.json[k], `${stem}: ${k}`);
    }
    // A third compile in-process from the same bytes gives the same bytes again.
    const again = render(parse(bytes).value, bytes);
    for (const n of FILES) assert.ok(again.files[n].equals(filesA[n]), `${stem}: ${n} not reproducible`);
    // No absolute path of either checkout leaks into an output.
    for (const n of FILES) {
      for (const p of [rootA, rootB, os.tmpdir()]) assert.ok(!filesA[n].toString('utf8').includes(p), `${stem}: ${n} holds ${p}`);
    }
  }
});

// ---- L2.2 reorder policy -----------------------------------------------------------------------------------

function reverseKeys(v) {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v === null || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).reverse()) out[k] = reverseKeys(v[k]);
  return out;
}

test('L2.2 reorder policy: reordered keys change source.sha256 (raw bytes) but no manifest or view body', t => {
  for (const stem of LEVEL2) {
    const value = JSON.parse(readFixture(stem).toString('utf8'));
    const plain = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    const reordered = Buffer.from(JSON.stringify(reverseKeys(value), null, 2) + '\n');
    assert.ok(!plain.equals(reordered));
    const x = compiledDir(t, plain), y = compiledDir(t, reordered);
    const fx = readOut(x.out), fy = readOut(y.out);
    assert.notEqual(x.res.json.source_sha256, y.res.json.source_sha256);
    assert.equal(x.res.json.source_sha256, sha256(plain));
    assert.equal(y.res.json.source_sha256, sha256(reordered));
    assert.ok(fx['prd.view.md'].equals(fy['prd.view.md']), `${stem}: prd view`);
    assert.ok(fx['spec.view.md'].equals(fy['spec.view.md']), `${stem}: spec view`);
    assert.equal(x.res.json.prd_projection_sha256, y.res.json.prd_projection_sha256);
    const mx = JSON.parse(fx['execution-plan.json']), my = JSON.parse(fy['execution-plan.json']);
    assert.notEqual(mx.source.sha256, my.source.sha256);
    for (const m of [mx, my]) { m.source.sha256 = m.spec_sha256 = 'X'; }
    assert.deepEqual(mx, my);
    // Same key order in the bytes, too: the manifest body is the same text once the two hashes are equal.
    const strip = (buf, h) => buf.toString('utf8').split(h).join('X');
    assert.equal(strip(fx['execution-plan.json'], sha256(plain)), strip(fy['execution-plan.json'], sha256(reordered)));
    const ix = JSON.parse(fx['compile-identity.json']), iy = JSON.parse(fy['compile-identity.json']);
    for (const i of [ix, iy]) { i.source_sha256 = 'X'; i.files['execution-plan.json'] = 'X'; }
    assert.deepEqual(ix, iy);
  }
});

// ---- L2.3 identity fields ----------------------------------------------------------------------------------

test('L2.3 identity fields: compile-identity.json and manifest hashes, none self-referential', t => {
  for (const stem of LEVEL2) {
    const bytes = readFixture(stem);
    const { out, repoPath, res } = compiledDir(t, bytes);
    const files = readOut(out);
    const identity = JSON.parse(files['compile-identity.json']);
    const manifest = JSON.parse(files['execution-plan.json']);
    const value = JSON.parse(bytes);
    assert.deepEqual(Object.keys(identity), ['compiler_version', 'schema_version', 'feature_id', 'source_path', 'source_sha256', 'prd_projection_sha256', 'files']);
    assert.deepEqual(Object.keys(identity.files), ['execution-plan.json', 'prd.view.md', 'spec.view.md']);
    assert.equal(identity.schema_version, 2);
    assert.equal(identity.feature_id, value.feature_id);
    assert.equal(identity.source_path, repoPath);
    assert.equal(identity.source_sha256, sha256(bytes));
    assert.match(identity.compiler_version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
    for (const n of ['execution-plan.json', 'prd.view.md', 'spec.view.md']) assert.equal(identity.files[n], sha256(files[n]), n);
    assert.equal(manifest.version, 2);
    assert.equal(manifest.compiler_version, identity.compiler_version);
    assert.deepEqual(manifest.source, { path: repoPath, sha256: sha256(bytes) });
    assert.equal(manifest.spec_sha256, manifest.source.sha256);
    assert.equal(manifest.views.prd_view_sha256, sha256(files['prd.view.md']));
    assert.equal(manifest.views.spec_view_sha256, sha256(files['spec.view.md']));
    assert.equal(manifest.views.prd_projection_sha256, identity.prd_projection_sha256);
    assert.equal(res.json.manifest_sha256, sha256(files['execution-plan.json']));
    assert.equal(res.json.identity_sha256, sha256(files['compile-identity.json']));
    // No file holds its own hash; the identity hash is in no output; the manifest hash only in the identity.
    for (const n of FILES) assert.ok(!files[n].toString('utf8').includes(sha256(files[n])), `${n} holds its own hash`);
    for (const n of FILES) assert.ok(!files[n].toString('utf8').includes(sha256(files['compile-identity.json'])));
    for (const n of ['execution-plan.json', 'prd.view.md', 'spec.view.md']) assert.ok(!files[n].toString('utf8').includes(sha256(files['execution-plan.json'])));
    // The projection hash is the SHA-256 of the canonical JSON of the projection (keys sorted, no whitespace).
    const projection = projectionByDesign(value);
    assert.equal(identity.prd_projection_sha256, sha256(Buffer.from(canonical(projection))));
    // No timestamps.
    for (const n of FILES) assert.doesNotMatch(files[n].toString('utf8'), /\b20[0-9]{2}-[01][0-9]-[0-3][0-9]T/);
    // LF only, final newline, 2-space JSON.
    for (const n of FILES) { const s = files[n].toString('utf8'); assert.ok(!s.includes('\r') && s.endsWith('\n'), n); }
    assert.equal(files['execution-plan.json'].toString('utf8'), JSON.stringify(manifest, null, 2) + '\n');
  }
});

// Independent implementation of the design's projection, from the literal lists above.
function projectionByDesign(f) {
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => !k.includes('.') && Object.hasOwn(o, k)).map(k => [k, o[k]]));
  return {
    source_request: f.source_request,
    coverage: f.coverage,
    product: f.product,
    architecture: { decisions: f.architecture.decisions, invariants: f.architecture.invariants, security: f.architecture.security },
    requirements: f.requirements.map(r => ({
      ...pick(r, PROJECTION_REQUIREMENT),
      acceptance: r.acceptance.map(a => ({ ...pick(a, PROJECTION_ACCEPTANCE), verification: { kind: a.verification.kind } })),
    })),
  };
}
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

// ---- S17 / L2.4 drift --------------------------------------------------------------------------------------

test('S17 / L2.4: one byte edited in each of the four files, an extra file or a missing file -> --check exit 1 E_DRIFT naming it', t => {
  const bytes = readFixture('medium');
  const { out, repo, repoPath, file, root } = compiledDir(t, bytes);
  const clean = compileCli({ file, repo, repoPath, check: out });
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  assert.equal(clean.json.ok, true);
  const copy = name => { const d = path.join(root, name); fs.cpSync(out, d, { recursive: true }); return d; };
  for (const n of FILES) {
    const d = copy(`edit-${n}`);
    const p = path.join(d, n);
    const buf = fs.readFileSync(p);
    const at = Math.floor(buf.length / 2);
    buf[at] = buf[at] === 0x41 ? 0x42 : 0x41;
    fs.writeFileSync(p, buf);
    const res = compileCli({ file, repo, repoPath, check: d });
    assert.equal(res.status, 1, n + res.stderr);
    assert.deepEqual(res.json.errors.map(e => [e.code, e.file]), [['E_DRIFT', n]], n);
  }
  const extra = copy('extra');
  fs.writeFileSync(path.join(extra, 'notes.md'), 'hand-written\n');
  let res = compileCli({ file, repo, repoPath, check: extra });
  assert.equal(res.status, 1);
  assert.deepEqual(res.json.errors.map(e => [e.code, e.file]), [['E_DRIFT', 'notes.md']]);
  const extraDir = copy('extra-dir');
  fs.mkdirSync(path.join(extraDir, 'sub'));
  res = compileCli({ file, repo, repoPath, check: extraDir });
  assert.deepEqual(res.json.errors.map(e => [e.code, e.file]), [['E_DRIFT', 'sub']]);
  const missing = copy('missing');
  fs.rmSync(path.join(missing, 'spec.view.md'));
  res = compileCli({ file, repo, repoPath, check: missing });
  assert.equal(res.status, 1);
  assert.deepEqual(res.json.errors.map(e => [e.code, e.file]), [['E_DRIFT', 'spec.view.md']]);
  // A view edited consistently with its manifest and identity hashes is still drift: the source is the authority.
  const forged = copy('forged');
  const view = path.join(forged, 'prd.view.md');
  fs.writeFileSync(view, fs.readFileSync(view, 'utf8').replace('Repeated guessing is stopped.', 'Guessing is allowed.'));
  const h = sha256(fs.readFileSync(view));
  for (const n of ['execution-plan.json', 'compile-identity.json']) {
    const p = path.join(forged, n);
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (m.views) m.views.prd_view_sha256 = h; else m.files['prd.view.md'] = h;
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  }
  res = compileCli({ file, repo, repoPath, check: forged });
  assert.equal(res.status, 1);
  assert.deepEqual(res.json.errors.map(e => e.file), ['compile-identity.json', 'execution-plan.json', 'prd.view.md']);
  // A changed source against the old directory is drift too.
  const changed = path.join(root, 'changed.feature.json');
  fs.writeFileSync(changed, Buffer.from(bytes.toString('utf8').replace('Lock for 15 minutes after 5 failures.', 'Lock for 20 minutes after 5 failures.').replace('Unit tests for the counter', 'Unit tests for a counter')));
  res = compileCli({ file: changed, repo, repoPath, check: out });
  assert.equal(res.status, 1);
  assert.deepEqual(res.json.errors.map(e => e.file), FILES);
  // --check never writes.
  assert.deepEqual(fs.readdirSync(out).sort(), FILES);
});

// ---- L2.7 commands are data --------------------------------------------------------------------------------

test('L2.7 marker: a file whose every command and prose field would write a marker is validated and compiled; none runs', t => {
  const root = tmpdir(t, 'gp-compile-marker-');
  const marker = path.join(root, 'marker');
  const f = JSON.parse(readFixture('medium').toString('utf8'));
  const touch = `touch ${marker}`;
  for (const r of f.requirements) {
    for (const a of r.acceptance) {
      if (a.verification.command !== undefined && a.verification.live !== true) a.verification.command = `${touch} # ${a.id}`;
      if (a.negative_control.mutation !== undefined) a.negative_control.mutation = `$(${touch})`;
    }
  }
  for (const c of f.checks) if (c.command !== undefined) c.command = `${touch}; echo ${c.id}`;
  for (const r of f.requirements) for (const a of r.acceptance) if (a.verification.live === true) a.verification.command = f.checks.find(c => c.id === a.verification.check_id).command;
  f.suite.command = `$(${touch})`;
  f.suite.unit_command = `\`${touch}\``;
  f.suite.setup_command = `${touch} && npm ci`;
  f.test_plan = `$(${touch})`;
  const co = checkout(root, Buffer.from(JSON.stringify(f, null, 2)));
  const v = spawnSync(process.execPath, [VALIDATOR, '--file', co.file, '--repo-path', co.repoPath], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const out = path.join(root, 'out');
  const res = compileCli({ ...co, out });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(compileCli({ ...co, check: out }).status, 0);
  assert.ok(fs.readFileSync(path.join(out, 'execution-plan.json'), 'utf8').includes(touch));
  assert.equal(fs.existsSync(marker), false);
});

// ---- --out rules -------------------------------------------------------------------------------------------

test('--out inside --repo (directly, through a symlink, or the repo given through a symlink) or existing -> exit 2, nothing written', t => {
  const root = tmpdir(t, 'gp-compile-out-');
  const co = checkout(root, readFixture('S01-minimal'));
  const before = () => fs.readdirSync(co.repo).sort();
  const listing = before();
  const expect2 = (args, what) => {
    const res = compileCli({ ...co, ...args });
    assert.equal(res.status, 2, `${what}: ${res.stdout}${res.stderr}`);
    assert.equal(res.stdout, '', what);
    assert.match(res.stderr, /^compile-feature: /, what);
  };
  expect2({ out: path.join(co.repo, 'frozen') }, 'inside');
  expect2({ out: path.join(co.repo, '.pipeline', 'frozen') }, 'nested inside');
  expect2({ out: co.repo }, 'the repo itself');
  fs.symlinkSync(co.repo, path.join(root, 'link'));
  expect2({ out: path.join(root, 'link', 'frozen') }, 'through a symlink');
  expect2({ repo: path.join(root, 'link'), out: path.join(co.repo, 'frozen') }, 'repo through a symlink');
  const existing = path.join(root, 'existing');
  fs.mkdirSync(existing);
  expect2({ out: existing }, 'existing directory');
  fs.writeFileSync(path.join(root, 'existing-file'), '');
  expect2({ out: path.join(root, 'existing-file') }, 'existing file');
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
  expect2({ out: path.join(root, 'dangling') }, 'dangling symlink');
  expect2({ out: path.join(root, 'no-parent', 'out') }, 'missing parent');
  assert.deepEqual(before(), listing);
  assert.deepEqual(fs.readdirSync(existing), []);
  assert.equal(fs.existsSync(path.join(root, 'nowhere')), false);
  for (const name of fs.readdirSync(root)) assert.ok(!name.includes('.tmp-'), name);
});

test('usage errors exit 2: missing flags, both or neither of --out/--check, relative --repo, unknown flag, missing --check dir', t => {
  const root = tmpdir(t, 'gp-compile-usage-');
  const co = checkout(root, readFixture('S01-minimal'));
  const run = argv => spawnSync(process.execPath, [COMPILER, ...argv], { encoding: 'utf8' });
  const base = ['--file', co.file, '--repo', co.repo, '--repo-path', co.repoPath];
  for (const argv of [
    [],
    base,
    [...base, '--out', path.join(root, 'a'), '--check', root],
    ['--file', co.file, '--repo', 'relative/repo', '--repo-path', co.repoPath, '--out', path.join(root, 'b')],
    [...base, '--out', path.join(root, 'c'), '--bogus', 'x'],
    [...base, '--out'],
    [...base, '--check', path.join(root, 'absent')],
    ['--file', path.join(root, 'absent.json'), '--repo', co.repo, '--repo-path', co.repoPath, '--out', path.join(root, 'd')],
  ]) {
    const res = run(argv);
    assert.equal(res.status, 2, JSON.stringify(argv) + res.stdout + res.stderr);
    assert.equal(res.stdout, '');
  }
  for (const n of ['a', 'b', 'c', 'd']) assert.equal(fs.existsSync(path.join(root, n)), false);
});

test('an invalid file -> exit 1 with the validator diagnostics, nothing written (also under --check)', t => {
  const root = tmpdir(t, 'gp-compile-invalid-');
  const bad = readFixture('S01-minimal').toString('utf8').replace('"goal_ids": ["GOAL-001"]', '"goal_ids": ["GOAL-404"]');
  const co = checkout(root, Buffer.from(bad));
  const out = path.join(root, 'out');
  const res = compileCli({ ...co, out });
  assert.equal(res.status, 1);
  assert.equal(res.json.ok, false);
  assert.ok(res.json.errors.some(e => e.code === 'E_REF' && e.rule === 'G05'), res.stdout);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['repo']);
  // A basename that does not match the feature_id is the validator's G38, not a compile.
  const wrong = compileCli({ ...co, repoPath: '.pipeline/features/other.feature.json', out });
  assert.equal(wrong.status, 1);
  assert.ok(wrong.json.errors.some(e => e.code === 'E_SCOPE'));
  assert.equal(fs.existsSync(out), false);
});

// ---- L3.10 interrupted compile -----------------------------------------------------------------------------

test('an interrupted compile (GP_COMPILE_ABORT_AFTER=0..4) leaves no <out>; a rerun then compiles', t => {
  const root = tmpdir(t, 'gp-compile-abort-');
  const co = checkout(root, readFixture('medium'));
  const parent = path.join(root, 'outs');
  fs.mkdirSync(parent);
  const out = path.join(parent, 'frozen');
  for (let n = 0; n <= 4; n++) {
    const res = compileCli({ ...co, out, env: { ...process.env, GP_COMPILE_ABORT_AFTER: String(n) } });
    assert.equal(res.signal, 'SIGKILL', `n=${n}: ${res.status} ${res.stdout}${res.stderr}`);
    assert.equal(res.stdout, '');
    assert.equal(fs.existsSync(out), false, `n=${n}: <out> exists`);
    const tmps = fs.readdirSync(parent).filter(x => x !== 'frozen');
    assert.ok(tmps.every(x => x.startsWith('frozen.tmp-')), tmps.join());
    const latest = tmps.map(x => path.join(parent, x)).find(p => fs.readdirSync(p).length === n);
    assert.ok(latest, `n=${n}: a temporary directory holds exactly ${n} files`);
  }
  const res = compileCli({ ...co, out });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(compileCli({ ...co, check: out }).status, 0);
});

// ---- leaf mutation: the PRD view is a function of the projection --------------------------------------------

test('meta: the projection field lists equal docs/v2-design.md section 4', () => {
  const text = fs.readFileSync(DESIGN, 'utf8');
  const start = text.indexOf('\n## 4. ');
  const end = text.indexOf('\n## 5. ', start);
  assert.ok(start > 0 && end > start, 'section 4 not found');
  const sec = text.slice(start, end);
  const a = sec.indexOf('of exactly these fields:');
  const z = sec.indexOf('`prd_projection_sha256` is its SHA-256', a);
  assert.ok(a > 0 && z > a);
  const para = sec.slice(a, z).replace(/\s+/g, ' ');
  const [top, rest] = para.split(' and per requirement ');
  const [req, acc] = rest.split(' and per acceptance ');
  const ticks = s => [...s.matchAll(/`([^`]+)`/g)].map(m => m[1]);
  const csv = s => ticks(s).join(',').split(',').map(x => x.trim()).filter(Boolean);
  assert.deepEqual(ticks(top), PROJECTION_TOP);
  assert.deepEqual(csv(req), PROJECTION_REQUIREMENT);
  assert.deepEqual(csv(acc), PROJECTION_ACCEPTANCE);
});

// Is the leaf at this path (array of keys and indices) part of the PRD projection? Decided from the literal lists.
function inProjection(p) {
  const dotted = p.filter(x => typeof x === 'string');
  const startsWith = list => list.some(item => { const parts = item.split('.'); return parts.every((s, i) => dotted[i] === s); });
  if (p[0] === 'requirements') {
    if (p[2] === 'acceptance') return p.length > 4 && startsWith(PROJECTION_ACCEPTANCE.map(x => `requirements.acceptance.${x}`));
    return startsWith(PROJECTION_REQUIREMENT.map(x => `requirements.${x}`));
  }
  return startsWith(PROJECTION_TOP);
}

function leaves(v, p = [], out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...p, i], out));
  else if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) leaves(v[k], [...p, k], out);
  else out.push({ path: p, value: v });
  return out;
}
const mutateLeaf = v => (typeof v === 'string' ? v + 'Z' : typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : 'Z');
function withLeaf(value, p, leaf) {
  const copy = JSON.parse(JSON.stringify(value));
  let node = copy;
  for (const k of p.slice(0, -1)) node = node[k];
  node[p[p.length - 1]] = leaf;
  return copy;
}

test('leaf mutation: each projection leaf changes the projection hash and prd.view.md; each other leaf changes neither, but spec.view.md', () => {
  let projectionLeaves = 0, otherLeaves = 0;
  for (const stem of LEVEL2) {
    const bytes = readFixture(stem);
    const value = JSON.parse(bytes.toString('utf8'));
    const repoPath = `.pipeline/features/${value.feature_id}.feature.json`;
    const base = render(value, bytes, repoPath);
    for (const { path: p, value: v } of leaves(value)) {
      const m = render(withLeaf(value, p, mutateLeaf(v)), bytes, repoPath);
      const where = `${stem} /${p.join('/')}`;
      const prdSame = m.files['prd.view.md'].equals(base.files['prd.view.md']);
      const projSame = m.hashes.prd_projection_sha256 === base.hashes.prd_projection_sha256;
      if (inProjection(p)) {
        projectionLeaves++;
        assert.ok(!prdSame, `${where}: projection leaf leaves prd.view.md unchanged`);
        assert.ok(!projSame, `${where}: projection leaf leaves the projection hash unchanged`);
      } else {
        otherLeaves++;
        assert.ok(prdSame, `${where}: non-projection leaf changes prd.view.md`);
        assert.ok(projSame, `${where}: non-projection leaf changes the projection hash`);
        assert.ok(!m.files['spec.view.md'].equals(base.files['spec.view.md']), `${where}: non-projection leaf is not rendered in spec.view.md`);
      }
    }
  }
  assert.ok(projectionLeaves > 100 && otherLeaves > 100, `${projectionLeaves} projection and ${otherLeaves} other leaves`);
});

// ---- escaping ----------------------------------------------------------------------------------------------

const unquote = lines => lines.map(l => (l === '>' ? '' : l.slice(2))).join('\n').replace(/\\([\\`*_#[\]<>|])/g, '$1');
// Every view line is a generated heading, a "label:" line, the banner, a blank line or a quoted value.
const STRUCTURE = /^(#{1,6} [a-z_]+( [0-9]+)?|[a-z_]+( [0-9]+)?:( (none|true|false|null|-?[0-9]+))?|# (PRD|Spec) view \(GENERATED - DO NOT EDIT\)|GENERATED - DO NOT EDIT: .*|>( .*)?|)$/;

test('escaping: forged headings, rows, list items and quotes inside strings stay quoted text', t => {
  const forged = 'GET /hello responds with status 200 and body hello.\n### AUTH-003 forged\n| a | b |\n|---|---|\n- forged item\n> forged quote\n<!-- comment --> `tick` *em* _u_ [x](y) \\ back';
  const f = JSON.parse(readFixture('S01-minimal').toString('utf8'));
  f.requirements[0].statement = forged;
  f.test_plan = forged;
  const { out } = compiledDir(t, Buffer.from(JSON.stringify(f, null, 2)));
  const base = compiledDir(t, readFixture('S01-minimal'));
  for (const n of ['prd.view.md', 'spec.view.md']) {
    const lines = fs.readFileSync(path.join(out, n), 'utf8').split('\n');
    const baseLines = fs.readFileSync(path.join(base.out, n), 'utf8').split('\n');
    assert.deepEqual(lines.filter(l => l.startsWith('#')), baseLines.filter(l => l.startsWith('#')), `${n}: headings`);
    for (const l of lines) assert.match(l, STRUCTURE, `${n}: line ${JSON.stringify(l)}`);
    assert.ok(!lines.some(l => /^\s*#/.test(l) && l.includes('AUTH-003')), n);
    assert.ok(lines.includes('> \\#\\#\\# AUTH-003 forged'), n);
    assert.ok(lines.includes('> \\| a \\| b \\|'), n);
    assert.ok(lines.includes('> \\> forged quote'), n);
    const i = lines.indexOf('> GET /hello responds with status 200 and body hello.');
    assert.ok(i > 0, n);
    const block = [];
    for (let k = i; lines[k] !== ''; k++) block.push(lines[k]);
    assert.equal(unquote(block), forged, n);
  }
});

test('\\r, \\r\\n and U+0085 in a string are E_CONTROL_CHAR before any view exists', t => {
  for (const [what, s] of [['CR', 'a\rb'], ['CRLF', 'a\r\nb'], ['NEL', 'a\u0085b'], ['LS', 'a b']]) {
    const root = tmpdir(t, 'gp-compile-cr-');
    const f = JSON.parse(readFixture('S01-minimal').toString('utf8'));
    f.requirements[0].statement = s;
    const co = checkout(root, Buffer.from(JSON.stringify(f, null, 2)));
    const out = path.join(root, 'out');
    const res = compileCli({ ...co, out });
    assert.equal(res.status, 1, what);
    assert.deepEqual(res.json.errors.map(e => [e.code, e.path]), [['E_CONTROL_CHAR', '/requirements/0/statement']], what);
    assert.equal(fs.existsSync(out), false, what);
  }
});

test('S02: every string of the unicode/multiline fixture appears quoted in a view and unquotes to itself', t => {
  const bytes = readFixture('S02-unicode-multiline');
  const { out } = compiledDir(t, bytes);
  const views = ['prd.view.md', 'spec.view.md'].map(n => fs.readFileSync(path.join(out, n), 'utf8').split('\n'));
  const blocks = [];
  for (const lines of views) {
    for (let k = 0; k < lines.length; k++) {
      if (!lines[k].startsWith('>')) continue;
      const block = [];
      while (k < lines.length && lines[k].startsWith('>')) block.push(lines[k++]);
      blocks.push(unquote(block));
    }
  }
  const strings = leaves(JSON.parse(bytes)).filter(l => typeof l.value === 'string');
  assert.ok(strings.length > 20);
  for (const { path: p, value } of strings) assert.ok(blocks.includes(value), `/${p.join('/')} not found quoted`);
  for (const lines of views) for (const l of lines) assert.match(l, STRUCTURE, JSON.stringify(l));
});

// ---- L2.6 bijection, manifest schema, S13, S20 -------------------------------------------------------------

test('L2.6 bijection: manifest requirement ids map one-to-one onto active acceptances of active requirements, checks onto checks', () => {
  for (const stem of allValid()) {
    const bytes = readFixture(stem);
    const f = JSON.parse(bytes);
    const m = JSON.parse(render(f, bytes).files['execution-plan.json']);
    const active = f.requirements.filter(r => r.status === 'active').flatMap(r => r.acceptance.filter(a => a.status === 'active').map(a => ({ a, r })));
    assert.deepEqual(m.requirements.map(x => x.id), active.map(x => x.a.id), stem);
    assert.equal(new Set(m.requirements.map(x => x.id)).size, m.requirements.length, stem);
    m.requirements.forEach((x, i) => {
      const { a, r } = active[i];
      assert.equal(x.requirement_id, r.id);
      assert.equal(x.kind, a.verification.kind);
      assert.equal(x.proof_command, a.verification.kind === 'static' ? '' : a.verification.command);
      assert.equal(x.live, a.verification.live === true);
      assert.equal(x.check_id, a.verification.check_id || null);
      assert.equal(x.negative_control.method, a.negative_control.method);
      assert.equal(x.negative_control[a.negative_control.method === 'exempt' ? 'exemption_reason' : 'mutation'],
        a.negative_control[a.negative_control.method === 'exempt' ? 'exemption_reason' : 'mutation']);
      const activeComps = new Set(f.architecture.components.filter(c => c.status === 'active').map(c => c.id));
      assert.deepEqual(x.component_ids, r.component_ids.filter(c => activeComps.has(c)));
    });
    assert.deepEqual(m.checks.map(c => c.id), f.checks.map(c => c.id), stem);
    assert.deepEqual(m.checks.map(c => [c.applicable, c.reason]), f.checks.map(c => [c.applicable, c.reason]), stem);
    assert.deepEqual(m.components.map(c => c.id), f.architecture.components.filter(c => c.status === 'active').map(c => c.id), stem);
    const retired = f.requirements.flatMap(r => r.acceptance.filter(a => a.status !== 'active' || r.status !== 'active').map(a => a.id));
    for (const id of retired) assert.ok(!m.requirements.some(x => x.id === id), `${stem}: retired ${id} in the manifest`);
    assert.deepEqual(m.protected_paths, [...f.scope.protected_paths, '.pipeline/features/'], stem);
  }
});

test('every compiled manifest validates against execution-plan.v2.schema.json with schema-lite', () => {
  const validate = compileSchema(parse(fs.readFileSync(MANIFEST_SCHEMA)).value);
  for (const stem of allValid()) {
    const bytes = readFixture(stem);
    const m = JSON.parse(render(JSON.parse(bytes), bytes).files['execution-plan.json']);
    assert.deepEqual(validate(m), [], stem);
  }
  // The schema rejects what the compiler never writes.
  const bytes = readFixture('S01-minimal');
  const m = JSON.parse(render(JSON.parse(bytes), bytes).files['execution-plan.json']);
  for (const [mut, code] of [
    [x => { x.version = 1; }, 'E_CONST'],
    [x => { x.extra = true; }, 'E_UNKNOWN_FIELD'],
    [x => { x.requirements[0].expected = { exit_code: 1 }; }, 'E_CONST'],
    [x => { delete x.views; }, 'E_REQUIRED'],
    [x => { x.source.sha256 = 'abc'; }, 'E_PATTERN'],
  ]) {
    const c = JSON.parse(JSON.stringify(m));
    mut(c);
    assert.ok(validate(c).some(e => e.code === code), code);
  }
});

test('S13 and S20: a not-applicable check keeps applicable false and its reason; the exemption and alternate evidence are in the manifest', () => {
  for (const stem of ['S13-not-applicable-check', 'S20-alternate-evidence']) {
    const bytes = readFixture(stem);
    const f = JSON.parse(bytes);
    const m = JSON.parse(render(f, bytes).files['execution-plan.json']);
    for (const c of f.checks.filter(x => x.applicable === false)) {
      const mc = m.checks.find(x => x.id === c.id);
      assert.equal(mc.applicable, false);
      assert.equal(mc.reason, c.reason);
      assert.equal(mc.command, c.command === undefined ? null : c.command);
    }
    for (const r of f.requirements) {
      for (const a of r.acceptance.filter(x => x.status === 'active' && x.negative_control.method === 'exempt')) {
        const x = m.requirements.find(y => y.id === a.id);
        assert.equal(x.negative_control.exemption_reason, a.negative_control.exemption_reason);
        assert.deepEqual(x.alternate_evidence_paths, a.negative_control.alternate_evidence ? a.negative_control.alternate_evidence.paths : []);
      }
    }
  }
  assert.ok(JSON.parse(readFixture('S13-not-applicable-check')).checks.some(c => c.applicable === false));
  assert.ok(JSON.parse(readFixture('S20-alternate-evidence')).requirements.some(r => r.acceptance.some(a => a.negative_control.alternate_evidence)));
});
