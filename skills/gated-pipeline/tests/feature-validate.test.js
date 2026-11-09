#!/usr/bin/env node
'use strict';

// Level 1 fixture matrix for scripts/validate-feature.js (plan 3.2, WP1), plus strict-json unit cases.
// Every invalid fixture is a minimal text mutation of a valid base; its .expect.json records the base, the
// mutation and the exit code, error codes, rule ids and paths taken from docs/v2-design.md section 3.
// The test proves: the base exits 0, base + mutation reproduces the fixture bytes, and the real CLI (child
// process) reports exactly the expected exit, codes, rules and paths. Paths are JSON Pointers into the file.

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
