'use strict';

// tests/v2-evidence/make-tables.js (plan section 4, tables 2 and 3): the Level table and the fixture matrix are
// built from TAP plus the .expect.json files, with each source's command, exit code and sha256 printed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { gitEnv } = require('./helpers/git-env.js');

const TOOL = path.join(__dirname, 'v2-evidence', 'make-tables.js');
const { parseTap } = require(TOOL);

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-tables-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const tool = args => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: gitEnv() });
const row = (out, first) => out.split('\n').find(l => l.startsWith(`| ${first} |`)) || null;
const rowsOf = (out, level, id) => out.split('\n').find(l => l.startsWith(`| ${level} | ${id} |`)) || null;

// A TAP stream in the node:test reporter's shape: a suite with nested tests, YAML blocks, a skip, a failure.
const TAP = [
  'TAP version 13',
  '# Subtest: fixture invalid/S03-bom.feature.json (S03: byte order mark)',
  'ok 1 - fixture invalid/S03-bom.feature.json (S03: byte order mark)',
  '  ---', '  duration_ms: 1.0', "  type: 'test'", '  ...',
  '# Subtest: fixture valid/S01-minimal.feature.json (S01: minimal)',
  'not ok 2 - fixture valid/S01-minimal.feature.json (S01: minimal)',
  '  ---', "  error: 'exit: 1 !== 0'", '  ...',
  '# Subtest: S17 / L2.4: one byte edited \\# in each file',
  'ok 3 - S17 / L2.4: one byte edited \\# in each file',
  '# Subtest: L3.8 CI loop suite',
  '    # Subtest: land CI_RED -> build again',
  '    ok 1 - land CI_RED -> build again',
  '      ---', '      duration_ms: 2.0', '      ...',
  '    # Subtest: a skipped L3.10 case',
  '    ok 2 - a skipped L3.10 case # SKIP no host',
  '    1..2',
  'ok 4 - L3.8 CI loop suite',
  '# Subtest: L3.1 an invalid draft',
  'ok 5 - L3.1 an invalid draft',
  '1..5',
  '# tests 5',
  '# suites 0',
  '# pass 3',
  '# fail 1',
  '# cancelled 0',
  '# skipped 1',
  '# todo 0',
  '',
].join('\n');

function fixtures(root) {
  const dir = path.join(root, 'fixtures');
  for (const sub of ['valid', 'invalid']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const w = (rel, v) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(v));
  w('valid/S01-minimal.expect.json', { case: 'S01', variant: 'minimal', exit: 0, codes: [], rules: [], diagnostics: [] });
  w('invalid/S03-bom.expect.json', { case: 'S03', variant: 'byte order mark', exit: 1, codes: ['E_PARSE'], rules: [], diagnostics: [['E_PARSE', null, '']] });
  w('invalid/S07-unknown-goal.expect.json', { case: 'S07', variant: 'unknown goal', exit: 1, codes: ['E_REF'], rules: ['G05'], diagnostics: [['E_REF', 'G05', '/requirements/0/goal_ids/0']] });
  return dir;
}

test('parseTap: nesting, YAML blocks, escaped names, directives and the summary', () => {
  const p = parseTap(TAP, 'x.tap');
  assert.deepEqual(p.tests.map(t => [t.path.join(' > '), t.ok, t.directive, t.leaf]), [
    ['fixture invalid/S03-bom.feature.json (S03: byte order mark)', true, null, true],
    ['fixture valid/S01-minimal.feature.json (S01: minimal)', false, null, true],
    ['S17 / L2.4: one byte edited # in each file', true, null, true],
    ['L3.8 CI loop suite', true, null, false],
    ['L3.8 CI loop suite > land CI_RED -> build again', true, null, true],
    ['L3.8 CI loop suite > a skipped L3.10 case', true, 'SKIP', true],
    ['L3.1 an invalid draft', true, null, true],
  ]);
  assert.deepEqual(p.summary, { tests: 5, suites: 0, pass: 3, fail: 1, cancelled: 0, skipped: 1, todo: 0 });
});

test('--tap: Level rows and the fixture matrix with statuses, gates, the command and the TAP sha256', t => {
  const root = tmp(t);
  const tap = path.join(root, 'suite.tap');
  fs.writeFileSync(tap, TAP);
  const r = tool(['--tap', tap, '--command', 'node --test --test-reporter=tap tests/*.test.js', '--exit', '1', '--fixtures', fixtures(root), '--commit', 'abc123']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  const sha = crypto.createHash('sha256').update(TAP).digest('hex');
  assert.ok(out.includes(`- \`node --test --test-reporter=tap tests/*.test.js\`: exit 1, sha256 ${sha}`));
  assert.equal(out.split(`sha256 ${sha}`).length - 1, 2, 'the command and sha256 stand beside each of the two tables');
  assert.equal(rowsOf(out, '0', 'suite.tap'), `| 0 | suite.tap | FAIL | 3/5 | 1 | suite.tap (TAP sha256 ${sha.slice(0, 12)}) | abc123 |`);
  assert.equal(rowsOf(out, '1', 'S01'), '| 1 | S01 | FAIL | 0/1 | 1 | suite.tap | abc123 |');
  assert.equal(rowsOf(out, '1', 'S03'), '| 1 | S03 | PASS | 1/1 | 1 | suite.tap | abc123 |');
  assert.equal(rowsOf(out, '1', 'S17'), '| 1 | S17 | PASS | 1/1 | 1 | suite.tap | abc123 |');
  assert.equal(rowsOf(out, '1', 'S07'), '| 1 | S07 | NOT RUN | 0/0 | - | - | abc123 |');
  assert.equal(rowsOf(out, '2', 'L2.4'), '| 2 | L2.4 | PASS | 1/1 | 1 | suite.tap | abc123 |');
  assert.equal(rowsOf(out, '3', 'L3.8'), '| 3 | L3.8 | PASS | 1/1 | 1 | suite.tap | abc123 |', 'a suite id covers its children; the skipped child is not counted');
  assert.equal(rowsOf(out, '3', 'L3.1'), '| 3 | L3.1 | PASS | 1/1 | 1 | suite.tap | abc123 |', 'L3.1 does not collect L3.10');
  assert.equal(rowsOf(out, '3', 'L3.10'), '| 3 | L3.10 | NOT RUN | 0/0 | 1 | suite.tap | abc123 |', 'a skipped test is NOT RUN');
  assert.match(rowsOf(out, '2', 'L2.8 (via X03, S10)'), /\| NOT RUN \|/);
  assert.equal(row(out, 'S03'), '| S03 | invalid/S03-bom.feature.json | byte order mark | 1 | E_PARSE | - | parse | PASS | 1 | E_PARSE |');
  assert.equal(row(out, 'S01'), '| S01 | valid/S01-minimal.feature.json | minimal | 0 | - | - | - | FAIL | FAIL | FAIL |');
  assert.equal(row(out, 'S07'), '| S07 | invalid/S07-unknown-goal.feature.json | unknown goal | 1 | E_REF | G05 | graph | NOT RUN | NOT RUN | NOT RUN |');
  assert.ok(out.includes('| S17 | PASS | 1/1 | suite.tap |'), 'a case without a fixture file gets its own row');
  assert.ok(out.includes('Levels 4 and 5 are live rows'));
});

test('--run: one TAP source per test file with its exit code; --save-tap keeps the TAP bytes', t => {
  const root = tmp(t);
  const tests = path.join(root, 'tests');
  fs.mkdirSync(tests);
  fs.writeFileSync(path.join(tests, 'a.test.js'), "require('node:test').test('L2.1 ok', () => {});\n");
  fs.writeFileSync(path.join(tests, 'b.test.js'), "require('node:test').test('L2.2 fails', () => { throw new Error('no'); });\n");
  const save = path.join(root, 'tap');
  const r = tool(['--run', '--tests-dir', tests, '--save-tap', save, '--fixtures', fixtures(root), '--commit', 'abc123', '--table', 'level']);
  assert.equal(r.status, 0, r.stderr);
  const shaA = crypto.createHash('sha256').update(fs.readFileSync(path.join(save, 'a.test.js.tap'))).digest('hex');
  assert.ok(r.stdout.includes(`a.test.js\`: exit 0, sha256 ${shaA}`));
  assert.match(rowsOf(r.stdout, '0', 'a.test.js'), /^\| 0 \| a\.test\.js \| PASS \| 1\/1 \| 0 \|/);
  assert.match(rowsOf(r.stdout, '0', 'b.test.js'), /^\| 0 \| b\.test\.js \| FAIL \| 0\/1 \| 1 \|/);
  assert.equal(rowsOf(r.stdout, '2', 'L2.1'), '| 2 | L2.1 | PASS | 1/1 | 0 | a.test.js | abc123 |');
  assert.equal(rowsOf(r.stdout, '2', 'L2.2'), '| 2 | L2.2 | FAIL | 0/1 | 1 | b.test.js | abc123 |');
  assert.ok(!r.stdout.includes('### Fixture matrix'), '--table level prints only the Level table');
});

test('usage errors exit 2', () => {
  assert.equal(tool([]).status, 2);
  assert.equal(tool(['--command', 'x']).status, 2);
  assert.equal(tool(['--tap', 'missing.tap']).status, 2);
  assert.equal(tool(['--run', '--table', 'nope']).status, 2);
});
