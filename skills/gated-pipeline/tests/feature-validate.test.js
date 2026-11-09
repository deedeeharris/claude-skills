#!/usr/bin/env node
'use strict';

// Level 1 fixture matrix for scripts/validate-feature.js (plan 3.2, WP1), plus strict-json unit cases.
// Every invalid fixture is a minimal text mutation of a valid base; its .expect.json records the base, the
// mutation and the exit code, error codes, rule ids and paths taken from docs/v2-design.md section 3, plus
// `diagnostics`: the exact [code, rule, path] triples with their multiplicity.
// The test proves: the base exits 0, base + mutation reproduces the fixture bytes, and the real CLI (child
// process) reports exactly the expected exit, codes, rules, paths and diagnostics. Paths are JSON Pointers.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const SKILL = path.resolve(__dirname, '..');
const VALIDATOR = path.join(SKILL, 'scripts/validate-feature.js');
const SCHEMA = path.join(SKILL, 'schemas/feature.schema.json');
const FIXTURES = path.join(__dirname, 'fixtures/v2');
const DESIGN = path.join(SKILL, 'docs/v2-design.md');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const uniqSorted = list => [...new Set(list)].sort();

// Copied by hand from docs/v2-design.md section 3 (the parse, version and schema code lists, the rule tables
// G01-G39, R01-R04, P01-P02 and their codes). The meta-test below parses the design and asserts equality, so a
// change to the contract shows up here; the lists are never imported from the validator.
const DESIGN_CODES = [
  'E_PARSE', 'E_DUP_KEY', 'E_FORBIDDEN_KEY', 'E_SCHEMA_VERSION',
  'E_UNKNOWN_FIELD', 'E_TYPE', 'E_REQUIRED', 'E_ENUM', 'E_CONST', 'E_PATTERN', 'E_MIN_ITEMS', 'E_MIN_LENGTH',
  'E_MINIMUM', 'E_MAXIMUM',
  'E_DUP_ID', 'E_ID_FORMAT', 'E_SHADOW_ID', 'E_DUP_STATEMENT', 'E_REF', 'E_CYCLE', 'E_SOURCE_FORM', 'E_COVERAGE',
  'E_REASON_MISSING', 'E_PROOF', 'E_NEGATIVE_CONTROL', 'E_LIMIT', 'E_CONTROL_CHAR', 'E_UNSAFE_PATH',
  'E_PROTECTED_OVERLAP', 'E_STATE_OVERLAP', 'E_OWNERSHIP', 'E_SCOPE', 'E_MIGRATION_TODO',
  'E_SOURCE_MISMATCH', 'E_SOURCE_LEAK', 'E_ID_REMOVED', 'E_ID_REACTIVATED',
];
const DESIGN_RULES = [
  ...Array.from({ length: 39 }, (_, i) => 'G' + String(i + 1).padStart(2, '0')),
  'R01', 'R02', 'R03', 'R04', 'P01', 'P02',
];

function designSection3() {
  const text = fs.readFileSync(DESIGN, 'utf8');
  const start = text.indexOf('\n## 3. ');
  const end = text.indexOf('\n## 4. ', start);
  assert.ok(start > 0 && end > start, 'section 3 of v2-design.md not found');
  return text.slice(start, end);
}

function loadCases() {
  const cases = [];
  for (const dir of ['valid', 'invalid', 'previous']) {
    for (const name of fs.readdirSync(path.join(FIXTURES, dir)).sort()) {
      if (!name.endsWith('.expect.json')) continue;
      const stem = name.slice(0, -'.expect.json'.length);
      const expect = JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, name), 'utf8'));
      cases.push({ dir, stem, rel: `${dir}/${stem}.feature.json`, file: path.join(FIXTURES, dir, stem + '.feature.json'), expect });
    }
  }
  return cases;
}
const CASES = loadCases();

const featureIdOf = file => JSON.parse(fs.readFileSync(file, 'utf8')).feature_id;
const repoPathFor = id => `.pipeline/features/${id}.feature.json`;

function cliArgs(file, repoPath, args = {}) {
  const argv = [VALIDATOR, '--file', file, '--repo-path', repoPath];
  if (args.source_request) argv.push('--source-request', path.join(FIXTURES, args.source_request));
  if (args.source_mode) argv.push('--source-mode', args.source_mode);
  if (args.previous) argv.push('--previous', path.join(FIXTURES, args.previous));
  return argv;
}
function validate(file, repoPath, args, extra = []) {
  const res = spawnSync(process.execPath, [...cliArgs(file, repoPath, args), ...extra], { encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(res.stdout); } catch { /* asserted by the caller */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, out };
}

function applyMutation(baseBytes, mutation) {
  const find = Buffer.from(mutation.find, 'utf8');
  const at = baseBytes.indexOf(find);
  assert.ok(at >= 0, 'mutation.find not in base');
  assert.equal(baseBytes.indexOf(find, at + 1), -1, 'mutation.find occurs more than once in base');
  const replace = Object.hasOwn(mutation, 'replace_hex') ? Buffer.from(mutation.replace_hex, 'hex') : Buffer.from(mutation.replace, 'utf8');
  return Buffer.concat([baseBytes.subarray(0, at), replace, baseBytes.subarray(at + find.length)]);
}

for (const c of CASES) {
  test(`fixture ${c.rel} (${c.expect.case}: ${c.expect.variant})`, () => {
    const { expect } = c;
    const args = expect.args || {};
    const bytes = fs.readFileSync(c.file);
    let repoPath;
    if (expect.base) {
      const baseFile = path.join(FIXTURES, expect.base);
      const baseBytes = fs.readFileSync(baseFile);
      const baseRepoPath = repoPathFor(featureIdOf(baseFile));
      const base = validate(baseFile, baseRepoPath, Object.assign({}, args, { repo_path: undefined }));
      assert.equal(base.status, 0, `base ${expect.base} must be valid: ${base.stdout}${base.stderr}`);
      if (expect.mutation) assert.ok(applyMutation(baseBytes, expect.mutation).equals(bytes), 'base + mutation must reproduce the fixture bytes');
      else assert.ok(baseBytes.equals(bytes) && args.repo_path, 'a fixture without mutation must equal its base and change only --repo-path');
      repoPath = args.repo_path || baseRepoPath;
    } else {
      assert.equal(expect.mutation, null);
      repoPath = args.repo_path || repoPathFor(featureIdOf(c.file));
    }
    const res = validate(c.file, repoPath, args);
    assert.equal(res.status, expect.exit, `exit: ${res.stdout}${res.stderr}`);
    assert.ok(res.out, 'stdout must be one JSON object');
    assert.deepEqual(Object.keys(res.out), ['valid', 'validator_version', 'schema_version', 'source_sha256', 'errors']);
    assert.equal(res.out.valid, expect.exit === 0);
    assert.equal(res.out.source_sha256, sha256(bytes));
    for (const e of res.out.errors) assert.deepEqual(Object.keys(e), ['code', 'rule', 'path', 'id', 'message']);
    assert.deepEqual(uniqSorted(res.out.errors.map(e => e.code)), uniqSorted(expect.codes), 'codes');
    assert.deepEqual(uniqSorted(res.out.errors.map(e => e.rule).filter(r => r !== null)), uniqSorted(expect.rules), 'rules');
    assert.deepEqual(uniqSorted(res.out.errors.map(e => e.path)), uniqSorted(expect.paths), 'paths');
    // Exactly these diagnostics: every (code, rule, path) triple with its multiplicity, so a right code at a
    // wrong path or a duplicated diagnostic fails. The triples must also agree with codes, rules and paths.
    assert.ok(Array.isArray(expect.diagnostics), 'expect.diagnostics lists [code, rule, path] triples');
    assert.deepEqual(uniqSorted(expect.diagnostics.map(d => d[0])), uniqSorted(expect.codes), 'diagnostics agree with codes');
    assert.deepEqual(uniqSorted(expect.diagnostics.map(d => d[1]).filter(r => r !== null)), uniqSorted(expect.rules), 'diagnostics agree with rules');
    assert.deepEqual(uniqSorted(expect.diagnostics.map(d => d[2])), uniqSorted(expect.paths), 'diagnostics agree with paths');
    const triples = list => list.map(t => JSON.stringify(t)).sort();
    assert.deepEqual(triples(res.out.errors.map(e => [e.code, e.rule, e.path])), triples(expect.diagnostics), 'diagnostics (code, rule, path), with count');
    for (const e of res.out.errors) if (!/^R|^G|^P/.test(e.rule || '')) assert.equal(e.rule, null, 'parse, version and schema codes carry rule null');
  });
}

test('meta: the code and rule lists equal design section 3, and every one is expected by a fixture', () => {
  const section = designSection3();
  const codes = uniqSorted(section.match(/`E_[A-Z0-9_]+`/g).map(s => s.slice(1, -1)));
  const rules = uniqSorted([...section.matchAll(/^\s*\| ([GRP]\d{2}) \|/gm)].map(m => m[1]));
  assert.deepEqual(uniqSorted(DESIGN_CODES), codes);
  assert.deepEqual(uniqSorted(DESIGN_RULES), rules);
  const expectedCodes = new Set(CASES.flatMap(c => c.expect.codes));
  const expectedRules = new Set(CASES.flatMap(c => c.expect.rules));
  assert.deepEqual(DESIGN_CODES.filter(x => !expectedCodes.has(x)), [], 'codes without a fixture');
  assert.deepEqual(DESIGN_RULES.filter(x => !expectedRules.has(x)), [], 'rules without a fixture');
});

test('meta: the plan 3.2 valid fixtures exist and the matrix rows S03-S14, S20, X01-X07 each have fixtures', () => {
  for (const stem of ['S01-minimal', 'S02-unicode-multiline', 'S13-not-applicable-check', 'S15-contradiction', 'S16-paraphrase', 'X06-ref', 'medium', 'multi-component', 'S20-alternate-evidence']) {
    assert.ok(CASES.some(c => c.dir === 'valid' && c.stem === stem), stem);
  }
  const rows = new Set(CASES.filter(c => c.expect.exit === 1).map(c => c.expect.case));
  for (const row of ['S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S14', 'S20', 'X01', 'X02', 'X03', 'X04', 'X05', 'X06', 'X07']) assert.ok(rows.has(row), row);
});

test('diagnostics are sorted by (path, code, rule) and the output is byte-identical across runs', () => {
  const file = path.join(FIXTURES, 'invalid/S10-owned-inside-protected.feature.json');
  const a = validate(file, repoPathFor('greet'), {});
  const b = validate(file, repoPathFor('greet'), {});
  assert.equal(a.stdout, b.stdout);
  const keys = a.out.errors.map(e => [e.path, e.code, e.rule || '']);
  const sorted = [...keys].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
  assert.deepEqual(keys, sorted);
  assert.ok(a.out.errors.length >= 2);
});

test('proof commands are data: validating a file whose every command writes a marker runs none of them (L2.7)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-validate-marker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'marker');
  const f = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid/S01-minimal.feature.json'), 'utf8'));
  const cmd = `touch ${marker}`;
  f.requirements[0].acceptance[0].verification.command = cmd;
  f.suite.command = `$(touch ${marker})`;
  f.suite.unit_command = `\`touch ${marker}\``;
  f.suite.setup_command = cmd;
  f.checks[0].command = cmd;
  f.title = `$(touch ${marker})`;
  const file = path.join(dir, 'greet.feature.json');
  fs.writeFileSync(file, JSON.stringify(f, null, 2) + '\n');
  const res = validate(file, repoPathFor('greet'), {});
  assert.ok(res.status === 0 || res.status === 1, res.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test('usage and setup errors exit 2', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-validate-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s01 = path.join(FIXTURES, 'valid/S01-minimal.feature.json');
  const run = argv => spawnSync(process.execPath, [VALIDATOR, ...argv], { encoding: 'utf8' });
  assert.equal(run(['--file', s01]).status, 2, 'missing --repo-path');
  assert.equal(run(['--repo-path', repoPathFor('greet')]).status, 2, 'missing --file');
  assert.equal(run(['--file', s01, '--repo-path', repoPathFor('greet'), '--bogus', 'x']).status, 2, 'unknown flag');
  assert.equal(run(['--file', s01, '--repo-path', repoPathFor('greet'), '--file', s01]).status, 2, 'repeated flag');
  assert.equal(run(['--file', path.join(dir, 'missing.json'), '--repo-path', repoPathFor('greet')]).status, 2, 'unreadable file');
  assert.equal(run(['--file', s01, '--repo-path', repoPathFor('greet'), '--source-mode', 'text']).status, 2, '--source-mode without --source-request');
  const req = path.join(FIXTURES, 'valid/S01-minimal.request.txt');
  assert.equal(run(['--file', s01, '--repo-path', repoPathFor('greet'), '--source-request', req, '--source-mode', 'raw']).status, 2, 'bad --source-mode');
  assert.equal(run(['--file', s01, '--repo-path', repoPathFor('greet'), '--source-request', path.join(dir, 'none.txt')]).status, 2, 'unreadable request');
  assert.equal(run(['--file', s01, '--repo-path', repoPathFor('greet'), '--previous', path.join(FIXTURES, 'invalid/S03-dup-key.feature.json')]).status, 2, 'unparseable --previous');
  // A schema using a keyword outside the subset is a setup error, never a silent pass.
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  schema.properties.title.maxLength = 200;
  const loose = path.join(dir, 'loose.schema.json');
  fs.writeFileSync(loose, JSON.stringify(schema));
  const res = run(['--file', s01, '--repo-path', repoPathFor('greet'), '--schema', loose]);
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /maxLength/);
  // The default schema is the bundled one.
  assert.equal(run(['--file', s01, '--repo-path', repoPathFor('greet'), '--schema', SCHEMA]).status, 0);
});

test('the schema declares 2020-12 and every object in it has additionalProperties false', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}/${i}`));
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') assert.equal(node.additionalProperties, false, `${where} lacks additionalProperties: false`);
    for (const [k, v] of Object.entries(node)) if (k !== 'enum' && k !== 'const') walk(v, `${where}/${k}`);
  };
  walk(schema, '#');
});

// strict-json unit cases (design 3 step 1, plan WP1).
const { parse } = require('../scripts/lib/strict-json.js');
const parseError = input => { try { parse(input); } catch (e) { return e; } assert.fail('expected a parse error'); };

test('strict-json accepts RFC 8259 JSON and builds prototype-free objects', () => {
  const { value } = parse(Buffer.from('{"a": [1, -2.5e3, true, false, null, "x\\u00e9\\ud83d\\ude00\\n\\t\\"\\\\\\/"], "b": {}}'));
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.getPrototypeOf(value.b), null);
  assert.deepEqual(value.a, [1, -2500, true, false, null, 'xé😀\n\t"\\/']);
  assert.equal(parse(' 0 ').value, 0);
  assert.equal(parse('" "').value, ' ', 'raw U+2028 is grammar-valid; the graph rule G31 rejects it');
});

test('strict-json rejections carry code, path and offset', () => {
  const cases = [
    ['{"a": 1, "a": 2}', 'E_DUP_KEY', '/a'],
    ['{"x": {"y": [{"k": 1, "k": 1}]}}', 'E_DUP_KEY', '/x/y/0/k'],
    ['{"__proto__": 1}', 'E_FORBIDDEN_KEY', '/__proto__'],
    ['{"a": {"constructor": 1}}', 'E_FORBIDDEN_KEY', '/a/constructor'],
    ['[{"prototype": 1}]', 'E_FORBIDDEN_KEY', '/0/prototype'],
    ['{"a": 1,}', 'E_PARSE', ''],
    ['[1, 2,]', 'E_PARSE', '/2'],
    ['{"a": 1} // c', 'E_PARSE', ''],
    ['/* c */ {}', 'E_PARSE', ''],
    ['{"a": NaN}', 'E_PARSE', '/a'],
    ['{"a": Infinity}', 'E_PARSE', '/a'],
    ['{"a": -Infinity}', 'E_PARSE', '/a'],
    ['{"a": 1e400}', 'E_PARSE', '/a'],
    ['{"a": 01}', 'E_PARSE', '/a'],
    ['{"a": "\\ud800"}', 'E_PARSE', '/a'],
    ['{"a": "\\udc00x"}', 'E_PARSE', '/a'],
    ['{"a": "\\ud800\\u0041"}', 'E_PARSE', '/a'],
    ['{"a": "x\ty"}', 'E_PARSE', '/a'],
    ['{"a": "\\x41"}', 'E_PARSE', '/a'],
    ["{'a': 1}", 'E_PARSE', ''],
    ['', 'E_PARSE', ''],
    ['{} {}', 'E_PARSE', ''],
    ['{"a~b/c": 1, "a~b/c": 2}', 'E_DUP_KEY', '/a~0b~1c'],
  ];
  for (const [input, code, where] of cases) {
    const e = parseError(Buffer.from(input, 'utf8'));
    assert.equal(e.code, code, input);
    assert.equal(e.path, where, input);
    assert.equal(typeof e.message, 'string');
    assert.ok(e.offset === null || Number.isInteger(e.offset), input);
  }
  const bom = parseError(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
  assert.equal(bom.code, 'E_PARSE');
  assert.equal(bom.offset, 0);
  const bad = parseError(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
  assert.equal(bad.code, 'E_PARSE');
  assert.equal(bad.offset, 6, 'offset of the first invalid UTF-8 byte');
  const deep = parseError(Buffer.from('['.repeat(10000) + ']'.repeat(10000)));
  assert.equal(deep.code, 'E_PARSE', 'nesting depth is bounded');
});

// Rule branches beyond the fixture matrix, through the library entry point (same code path as the CLI).
const { validateFeature, loadSchema } = require('../scripts/validate-feature.js');
const validateSchema = loadSchema(SCHEMA);
const BASES = {
  s01: JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid/S01-minimal.feature.json'), 'utf8')),
  medium: JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid/medium.feature.json'), 'utf8')),
};
function check(base, edit, opts = {}) {
  const f = JSON.parse(JSON.stringify(BASES[base]));
  edit(f);
  const bytes = Buffer.from(JSON.stringify(f, null, 2) + '\n');
  return validateFeature({ bytes, repoPath: opts.repoPath || repoPathFor(f.feature_id), validateSchema, request: opts.request || null, previous: opts.previous || null })
    .errors.map(e => `${e.rule || '-'} ${e.code} ${e.path}`);
}
const AC = f => f.requirements[0].acceptance[0];
const LIVE = f => f.requirements[1].acceptance[0];

test('rule branches: proofs, checks and live acceptances', () => {
  assert.deepEqual(check('s01', f => { delete AC(f).verification.live; }), ['G18 E_PROOF /requirements/0/acceptance/0/verification/live']);
  assert.deepEqual(check('medium', f => { f.requirements[2].acceptance[0].verification.live = false; }), ['G19 E_PROOF /requirements/2/acceptance/0/verification/live']);
  assert.deepEqual(check('medium', f => { delete f.requirements[2].acceptance[0].verification.evidence; }), ['G19 E_PROOF /requirements/2/acceptance/0/verification/evidence']);
  assert.deepEqual(check('medium', f => { f.checks[1].budget_min = 0; }), ['G21 E_PROOF /requirements/1/acceptance/0/verification/check_id']);
  assert.deepEqual(check('medium', f => { f.checks[1].applicable = false; }), ['G21 E_PROOF /requirements/1/acceptance/0/verification/check_id']);
  assert.deepEqual(check('s01', f => { delete f.checks[0].expected; delete f.checks[0].timeout_min; }), ['G28 E_REASON_MISSING /checks/0/expected', 'G28 E_REASON_MISSING /checks/0/timeout_min']);
  assert.deepEqual(check('s01', f => { f.checks[0].applicable = false; delete f.checks[0].command; delete f.checks[0].expected; delete f.checks[0].timeout_min; }), []);
  assert.deepEqual(check('s01', f => { f.checks[0].command = 'a\nb'; f.suite.unit_command = 'c\nd'; f.suite.setup_command = 'e\nf'; }),
    ['G20 E_PROOF /checks/0/command', 'G20 E_PROOF /suite/setup_command', 'G20 E_PROOF /suite/unit_command']);
  assert.deepEqual(check('s01', f => { f.checks[0].reason = '   '; }), ['G27 E_REASON_MISSING /checks/0/reason']);
  assert.deepEqual(check('medium', f => { LIVE(f).negative_control = { method: 'exempt', description: 'x', exemption_reason: 'y' }; }), []);
});

test('rule branches: ids, statements, references and controls', () => {
  assert.deepEqual(check('s01', f => { f.checks[0].id = 'CHECK-NEWS'; f.title = 'Revision-proof greeting'; }), [], 'segments only match whole words');
  assert.deepEqual(check('s01', f => { f.checks[0].id = 'CHECK-NEW-API'; }), ['G03 E_SHADOW_ID /checks/0/id']);
  assert.deepEqual(check('s01', f => { f.feature_id = 'greet-addendum'; }), ['G03 E_SHADOW_ID /feature_id']);
  assert.deepEqual(check('s01', f => { f.requirements[0].depends_on = ['HELLO-001']; }), ['G07 E_CYCLE /requirements/0/depends_on'], 'a self-dependency is a cycle');
  assert.deepEqual(check('medium', f => { f.requirements[3].statement = f.requirements[0].statement; }), ['G04 E_DUP_STATEMENT /requirements/3/statement'], 'retired requirements are compared too');
  assert.deepEqual(check('medium', f => { f.requirements[2].priority = 'P1'; delete f.requirements[2].acceptance[0].negative_control.alternate_evidence; }), [], 'G25 binds P0 only');
  assert.deepEqual(check('s01', f => { f.requirements[0].status = 'retired'; f.requirements[0].retired_rationale = 'x'; f.requirements.push(Object.assign(JSON.parse(JSON.stringify(f.requirements[0])), { id: 'HELLO-002', status: 'active', statement: 'Other.', acceptance: [Object.assign(JSON.parse(JSON.stringify(f.requirements[0].acceptance[0])), { id: 'HELLO-002-AC1' })] })); f.coverage[0].requirement_ids.push('HELLO-002'); }), []);
  assert.deepEqual(check('s01', f => { f.title = 'a\u0085b'; f.test_plan = 'x y'; }), ['G31 E_CONTROL_CHAR /test_plan', 'G31 E_CONTROL_CHAR /title']);
  assert.deepEqual(check('s01', f => { f.title = 'tab\tand\nnewline'; }), [], 'TAB and LF are allowed');
});

test('rule branches: paths and --repo-path', () => {
  assert.deepEqual(check('s01', () => {}, { repoPath: 'greet.feature.json' }), ['G38 E_SCOPE '], 'features_dir must be a directory');
  assert.deepEqual(check('s01', () => {}, { repoPath: '/abs/greet.feature.json' }), ['G38 E_SCOPE ']);
  assert.deepEqual(check('s01', () => {}, { repoPath: 'docs/.GIT/greet.feature.json' }), ['G38 E_SCOPE ']);
  assert.deepEqual(check('s01', f => { f.scope.allowed_paths.push('specs/'); }, { repoPath: 'specs/features/greet.feature.json' }), ['G33 E_PROTECTED_OVERLAP /scope/allowed_paths/2'], 'the features_dir is protected');
  assert.deepEqual(check('s01', f => { f.scope.allowed_paths = ['./src', 'test']; f.architecture.components[0].owned_paths = ['src//']; }), [], 'paths compare by segments');
  assert.deepEqual(check('medium', f => { f.architecture.components[2].status = 'active'; f.architecture.components[2].exclusive = true; f.architecture.components[2].owned_paths = ['src/auth/legacy/']; }),
    ['G35 E_OWNERSHIP /architecture/components/2/owned_paths/0'], 'exclusive overlap among active components');
  assert.deepEqual(check('medium', f => { f.architecture.components[2].exclusive = true; f.architecture.components[2].owned_paths = ['src/auth/legacy/']; }), [], 'retired components own nothing');
  assert.deepEqual(check('medium', f => { f.scope.state_paths = ['docs/']; }), ['G34 E_STATE_OVERLAP /scope/state_paths/0'], 'state paths may not hide alternate evidence');
});

// Each candidate kind of G33 and G34 on its own (no other kind overlaps the same path), so dropping a kind from
// either rule fails a case here or in fixture S10-state-inside-test (a state path inside a test path that lies
// outside allowed_paths).
test('rule branches: every G33 and G34 candidate kind alone', () => {
  assert.deepEqual(check('s01', f => { f.scope.protected_paths = ['build/']; f.scope.clean_ignore = ['build/cache/']; }), ['G33 E_PROTECTED_OVERLAP /scope/clean_ignore/0'], 'clean_ignore inside a protected path');
  assert.deepEqual(check('s01', f => { f.scope.protected_paths = ['spec/']; f.scope.test_paths.push('spec/'); }), ['G33 E_PROTECTED_OVERLAP /scope/test_paths/1'], 'test path equal to a protected path');
  assert.deepEqual(check('s01', f => { f.scope.test_paths.push('.pipeline/features/fixtures/'); }), ['G33 E_PROTECTED_OVERLAP /scope/test_paths/1'], 'test path inside the features_dir');
  assert.deepEqual(check('medium', f => { f.requirements[2].acceptance[0].verification.evidence.paths = ['notes/compare.md']; f.scope.state_paths.push('notes/'); }),
    ['G34 E_STATE_OVERLAP /scope/state_paths/1'], 'state path containing only an evidence path (outside allowed_paths)');
  assert.deepEqual(check('medium', f => { f.requirements[2].acceptance[0].verification.evidence.paths = ['notes/compare.md']; }), [], 'an evidence path outside allowed_paths is itself valid');
  assert.deepEqual(check('s01', f => { f.scope.allowed_paths = ['src/']; f.scope.clean_ignore = ['test/out/']; }), ['G34 E_STATE_OVERLAP /scope/clean_ignore/0'], 'clean_ignore inside a test path only');
  // The owned kind of G34 adds a diagnostic of its own only when G36 also fails (otherwise the owned path lies
  // inside an allowed path, which G34 already reports).
  assert.deepEqual(check('s01', f => { f.architecture.components[0].owned_paths = ['lib/']; f.scope.state_paths = ['lib/cache/']; }),
    ['G36 E_OWNERSHIP /architecture/components/0/owned_paths/0', 'G34 E_STATE_OVERLAP /scope/state_paths/0']);
});

// Overlap rules (G33, G34, G35, G37) fold ASCII case, so a path that differs only in case from a protected,
// state or owned path is rejected on a case-insensitive filesystem too (fail closed); G36 (inside) stays exact.
test('rule branches: overlap rules fold case, G36 compares exactly', () => {
  assert.deepEqual(check('s01', f => { f.scope.allowed_paths.push('.PIPELINE/Features/'); }), ['G33 E_PROTECTED_OVERLAP /scope/allowed_paths/2'], 'the features_dir in another case');
  assert.deepEqual(check('s01', f => { f.scope.protected_paths = ['secrets/']; f.scope.allowed_paths.push('Secrets/'); }), ['G33 E_PROTECTED_OVERLAP /scope/allowed_paths/2']);
  assert.deepEqual(check('s01', f => { f.scope.state_paths = ['SRC/cache/']; }), ['G34 E_STATE_OVERLAP /scope/state_paths/0']);
  assert.deepEqual(check('s01', f => { f.scope.test_paths.push('Src/x/'); }), ['G37 E_OWNERSHIP /scope/test_paths/1']);
  assert.deepEqual(check('medium', f => { f.scope.allowed_paths.push('SRC/'); f.architecture.components[1].owned_paths = ['SRC/Auth/']; }),
    ['G35 E_OWNERSHIP /architecture/components/1/owned_paths/0']);
  assert.deepEqual(check('s01', f => { f.architecture.components[0].owned_paths = ['SRC/']; }), ['G36 E_OWNERSHIP /architecture/components/0/owned_paths/0'], 'owned "SRC/" is not inside allowed "src/"');
});

test('rule branches: G13, G14 count active goals and components; G25 needs every active acceptance exempt', () => {
  assert.deepEqual(check('medium', f => { f.requirements[0].goal_ids = ['GOAL-002']; }), ['G13 E_COVERAGE /requirements/0/goal_ids']);
  assert.deepEqual(check('medium', f => { f.requirements[0].goal_ids = ['GOAL-002', 'GOAL-001']; }), [], 'one active goal is enough');
  assert.deepEqual(check('medium', f => { f.requirements[0].component_ids = ['COMP-LEGACY']; }), ['G14 E_COVERAGE /requirements/0/component_ids']);
  assert.deepEqual(check('medium', f => { f.requirements[0].component_ids = ['COMP-LEGACY', 'COMP-AUTH']; }), [], 'one active component is enough');
  assert.deepEqual(check('medium', f => { f.requirements[3].goal_ids = ['GOAL-002']; f.requirements[3].component_ids = ['COMP-LEGACY']; }), [], 'a retired requirement may name retired items');
  const mixed = f => {
    const r = f.requirements[2];
    delete r.acceptance[0].negative_control.alternate_evidence;
    r.acceptance.push(Object.assign(JSON.parse(JSON.stringify(f.requirements[0].acceptance[0])), { id: 'AUTH-003-AC2' }));
  };
  assert.deepEqual(check('medium', mixed), [], 'a P0 requirement with one exempt and one isolated_mutation acceptance needs no alternate_evidence');
  assert.deepEqual(check('medium', f => { mixed(f); f.requirements[2].acceptance[1].status = 'retired'; f.requirements[2].acceptance[1].retired_rationale = 'x'; }),
    ['G25 E_NEGATIVE_CONTROL /requirements/2/acceptance/0/negative_control/alternate_evidence'], 'retired acceptances do not count');
});

test('rule branches: R01 trailing CRLF, R04 window at any offset', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'valid/S01-minimal.request.txt'));
  const s = text.toString('utf8');
  const asReq = (str, mode) => ({ requestBytes: Buffer.from(str), requestText: str, mode });
  assert.ok(s.endsWith('\n') && !s.endsWith('\r\n'));
  assert.deepEqual(check('s01', () => {}, { request: asReq(s.slice(0, -1) + '\r\n', 'text') }), [], 'one trailing CRLF is normalized');
  assert.deepEqual(check('s01', () => {}, { request: asReq(s.slice(0, -1), 'text') }), [], 'no trailing newline');
  assert.deepEqual(check('s01', () => {}, { request: asReq(s.slice(0, -1) + '\r\n\r\n', 'text') }), ['R01 E_SOURCE_MISMATCH /source_request/text'], 'only one is normalized');
  assert.deepEqual(check('s01', () => {}, { request: asReq(s.slice(0, -1) + '\r', 'text') }), ['R01 E_SOURCE_MISMATCH /source_request/text'], 'a lone trailing CR is content');
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const ref = excerpt => f => { f.source_request = { ref: 'r', sha256: sha, summary: 's' }; f.coverage[0].excerpt = excerpt; };
  assert.ok(s.length >= 44);
  assert.deepEqual(check('s01', ref('Note:' + s.slice(2, 42)), { request: asReq(s, 'ref') }), ['R04 E_SOURCE_LEAK /coverage/0/excerpt'], 'a 40-code-point copy at excerpt offset 5');
  assert.deepEqual(check('s01', ref('Note:' + s.slice(2, 41)), { request: asReq(s, 'ref') }), [], 'a 39-code-point copy is no leak');
});

test('rule branches: source request and previous revision', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'valid/S01-minimal.request.txt'));
  const req = mode => ({ requestBytes: text, requestText: text.toString('utf8'), mode });
  assert.deepEqual(check('s01', () => {}, { request: req('text') }), []);
  assert.deepEqual(check('s01', f => { f.source_request.text += '\n'; }, { request: req('text') }), [], 'one trailing newline is normalized');
  assert.deepEqual(check('s01', f => { f.source_request.text += '\n\n'; }, { request: req('text') }), ['R01 E_SOURCE_MISMATCH /source_request/text']);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  assert.deepEqual(check('s01', f => { f.source_request = { ref: 'r', sha256: sha, summary: 's' }; }, { request: req('text') }), ['R03 E_SOURCE_FORM /source_request'], 'text mode needs the text form');
  assert.deepEqual(check('s01', f => { f.source_request = { ref: 'r', sha256: sha, summary: 's' }; }, { request: req('ref') }), []);
  const prev = JSON.parse(JSON.stringify(BASES.medium));
  assert.deepEqual(check('medium', f => { f.requirements.splice(0, 1); f.requirements[1].depends_on = []; }, { previous: prev }).filter(e => e.startsWith('P')),
    ['P01 E_ID_REMOVED /requirements', 'P01 E_ID_REMOVED /requirements', 'P01 E_ID_REMOVED /requirements'], 'a removed requirement takes its acceptances with it');
  assert.deepEqual(check('medium', f => { f.checks[2].applicable = true; f.checks[2].command = 'true'; f.checks[2].expected = { exit_code: 0 }; f.checks[2].timeout_min = 1; }, { previous: prev }), [], 'a check may become applicable again');
});

test('schema errors suppress the graph rules; a non-object root is a version error', () => {
  assert.deepEqual(check('s01', f => { f.title = 7; f.requirements[0].goal_ids = []; }), ['- E_TYPE /title']);
  const out = validateFeature({ bytes: Buffer.from('[]'), repoPath: repoPathFor('x'), validateSchema });
  assert.deepEqual(out.errors.map(e => [e.code, e.path]), [['E_SCHEMA_VERSION', '']]);
  const ids = validateFeature({ bytes: Buffer.from(JSON.stringify(Object.assign({}, BASES.s01, { requirements: [Object.assign({}, BASES.s01.requirements[0], { priority: 'P9' })] }))), repoPath: repoPathFor('greet'), validateSchema });
  assert.deepEqual(ids.errors.map(e => [e.code, e.path, e.id]), [['E_ENUM', '/requirements/0/priority', 'HELLO-001']], 'schema errors carry the nearest enclosing id');
});
