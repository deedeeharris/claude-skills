#!/usr/bin/env node
'use strict';

// Generates two tables of the evidence report (plan section 4, items 2 and 3) from `node --test
// --test-reporter=tap` output plus the fixtures' .expect.json files, so neither is ever typed by hand:
//   - the Level table, rows of Levels 0-3 (plan 3.1, 3.2, 3.3): Level 0 one row per TAP source (its summary
//     counts and exit code; FAIL on any `not ok` line even when `# fail` is 0); Level 1 one row per
//     fixture-matrix case (S01-S20, S19a/S19b, X01-X07); Levels 2 and 3 one row per checklist id (L2.1-L2.8,
//     L3.1-L3.14). A Level 1-3 row collects the tests whose name (or an enclosing suite's name) carries its id as
//     a token, plus, for a case, the fixture tests of its .expect.json
//     files; L2.8 collects the tests of cases X03 and S10 (plan 3.3). Status: FAIL if any collected test is
//     `not ok`, PASS if at least one ran and all are ok, NOT RUN if none ran (missing or skipped).
//   - the fixture matrix: one row per .expect.json (case, fixture, variant, expected exit, codes, rules, gate) with
//     the status of its `fixture <dir>/<stem>.feature.json (...)` test, and one row per case that has no fixture
//     file (S17, S18, S19a, S19b) from its Level 1 row. The fixture test asserts that the real CLI's exit code and
//     codes equal the expectation, so for an ok test the observed values are the expected ones; a failing or
//     missing test shows FAIL / NOT RUN instead of values.
// Beside each table it prints every TAP source's command, exit code and sha256, and the skill commit.
// Levels 4 and 5 are live rows; they are not derivable from TAP and are added from the live evidence.
//
// usage: make-tables.js (--run [--tests-dir <dir>] [--save-tap <dir>] | --tap <file> [--command <text>] [--exit <n>] ...)
//                       [--fixtures <dir>] [--commit <sha>] [--table level|fixtures|all]
//   --run        runs `node --test --test-reporter=tap <file>` once per *.test.js of --tests-dir (default: this
//                skill's tests/), cwd = the skill dir, so Level 0 has exact per-file counts; --save-tap keeps each
//                TAP output byte-exact as <dir>/<file>.tap
//   --tap        reads a saved TAP output; --command and --exit (given after it) describe how it was produced
//   --fixtures   default: tests/fixtures/v2 of this skill;  --commit default: git rev-parse HEAD (+dirty when
//                skills/gated-pipeline has uncommitted changes)
// Exit 0 when the tables were printed (whatever the statuses), 2 on a usage or setup error.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SKILL = path.resolve(__dirname, '../..');
const DEFAULT_TESTS = path.join(SKILL, 'tests');
const DEFAULT_FIXTURES = path.join(SKILL, 'tests', 'fixtures', 'v2');
const LEVEL1 = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18', 'S19a', 'S19b', 'S20',
  'X01', 'X02', 'X03', 'X04', 'X05', 'X06', 'X07'];
const LEVEL2 = Array.from({ length: 8 }, (_, i) => `L2.${i + 1}`);
const LEVEL3 = Array.from({ length: 14 }, (_, i) => `L3.${i + 1}`);
const ALIASES = { 'L2.8': ['X03', 'S10'] };
const PARSE_CODES = new Set(['E_PARSE', 'E_DUP_KEY', 'E_FORBIDDEN_KEY', 'E_CONTROL_CHAR']);

class SetupError extends Error {}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'].includes(k) || k.startsWith('GIT_CONFIG')) delete env[k];
  return env;
}

// ---- TAP (the node:test TAP reporter: 4-space nesting, YAML blocks, `# Subtest:` lines, summary comments) ----
function unescapeName(s) { return s.replace(/\\([\\#])/g, '$1'); }

function parseTap(text, source) {
  const pending = [[]];
  const summary = {};
  let inYaml = null;
  for (const raw of text.split('\n')) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (inYaml !== null) { if (indent === inYaml && line === '...') inYaml = null; continue; }
    if (line === '---') { inYaml = indent; continue; }
    const depth = Math.floor(indent / 4);
    const m = /^(not ok|ok) (\d+)(?: - (.*?))?(?: # (SKIP|TODO)\b.*)?$/i.exec(line);
    if (m) {
      const name = unescapeName((m[3] || '').replace(/\s+$/, ''));
      const entry = { name, ok: m[1] === 'ok', directive: m[4] ? m[4].toUpperCase() : null, depth, source, children: pending[depth + 1] || [] };
      pending[depth + 1] = [];
      (pending[depth] = pending[depth] || []).push(entry);
      continue;
    }
    const s = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)$/.exec(line);
    if (s && depth === 0) summary[s[1]] = Number(s[2]);
  }
  const all = [];
  const walk = (list, ancestors) => {
    for (const e of list) {
      e.path = [...ancestors, e.name];
      e.leaf = e.children.length === 0;
      all.push(e);
      walk(e.children, e.path);
    }
  };
  walk(pending[0] || [], []);
  return { tests: all, summary };
}

// ---- sources ----
function runSources(testsDir, saveDir) {
  if (!fs.existsSync(testsDir)) throw new SetupError(`tests dir ${testsDir} does not exist`);
  const files = fs.readdirSync(testsDir).filter(f => f.endsWith('.test.js')).sort();
  if (!files.length) throw new SetupError(`no *.test.js in ${testsDir}`);
  if (saveDir) fs.mkdirSync(saveDir, { recursive: true });
  return files.map(f => {
    const rel = path.relative(SKILL, path.join(testsDir, f)).split(path.sep).join('/');
    const arg = rel.startsWith('..') ? path.join(testsDir, f) : rel;
    const env = gitEnv();
    delete env.NODE_TEST_CONTEXT; // under a parent node --test, the child would report to it instead of printing TAP
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', arg], { cwd: SKILL, env, maxBuffer: 1024 * 1024 * 1024 });
    if (r.error) throw new SetupError(`node --test ${f}: ${r.error.message}`);
    if (saveDir) fs.writeFileSync(path.join(saveDir, f + '.tap'), r.stdout);
    return { label: f, command: `node --test --test-reporter=tap ${arg}`, exit: r.status, bytes: r.stdout };
  });
}

function parseArgs(argv) {
  const a = { taps: [], run: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--run') { a.run = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new SetupError(`${f} needs a value`);
    i++;
    if (f === '--tap') a.taps.push({ file: v });
    else if (f === '--command' || f === '--exit') {
      const last = a.taps[a.taps.length - 1];
      if (!last) throw new SetupError(`${f} must follow a --tap`);
      if (f === '--command') last.command = v; else last.exit = Number(v);
    } else if (['--tests-dir', '--save-tap', '--fixtures', '--commit', '--table'].includes(f)) {
      const k = f.slice(2).replace('-', '_');
      if (Object.hasOwn(a, k)) throw new SetupError(`${f} given twice`);
      a[k] = v;
    } else throw new SetupError(`unknown argument ${JSON.stringify(f)}`);
  }
  if (a.run === Boolean(a.taps.length)) throw new SetupError('give either --run or at least one --tap');
  if (a.table && !['level', 'fixtures', 'all'].includes(a.table)) throw new SetupError('--table must be level, fixtures or all');
  return a;
}

function loadFixtures(dir) {
  if (!fs.existsSync(dir)) throw new SetupError(`fixtures dir ${dir} does not exist`);
  const out = [];
  for (const sub of fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()) {
    for (const name of fs.readdirSync(path.join(dir, sub)).filter(n => n.endsWith('.expect.json')).sort()) {
      let expect;
      try { expect = JSON.parse(fs.readFileSync(path.join(dir, sub, name), 'utf8')); } catch (e) { throw new SetupError(`${sub}/${name}: ${e.message}`); }
      const stem = name.slice(0, -'.expect.json'.length);
      out.push({ rel: `${sub}/${stem}.feature.json`, expect });
    }
  }
  return out;
}

function gateOf(expect) {
  if (expect.exit === 0) return '-';
  const gates = new Set();
  for (const [code, rule] of expect.diagnostics || []) {
    if (rule === null) gates.add(PARSE_CODES.has(code) ? 'parse' : code === 'E_SCHEMA_VERSION' ? 'version' : 'schema');
    else gates.add(/^R/.test(rule) ? 'source rule' : /^P/.test(rule) ? 'previous rule' : 'graph');
  }
  return [...gates].sort().join(' / ') || '-';
}

const tokenRe = id => new RegExp(`(?<![A-Za-z0-9.])${id.replace(/\./g, '\\.')}(?![A-Za-z0-9])`);

function statusOf(tests) {
  const ran = tests.filter(t => t.directive === null);
  if (ran.some(t => !t.ok)) return 'FAIL';
  return ran.length ? 'PASS' : 'NOT RUN';
}

function build(opts) {
  const sources = opts.sources.map(s => ({ ...s, sha256: sha256(s.bytes), ...parseTap(s.bytes.toString('utf8'), s.label) }));
  const tests = sources.flatMap(s => s.tests);
  const fixtures = opts.fixtures;
  const fixtureTest = rel => tests.filter(t => t.name.startsWith(`fixture ${rel} (`));
  const byToken = id => { const re = tokenRe(id); return tests.filter(t => t.path.some(n => re.test(n))); };
  const collect = id => {
    if (ALIASES[id]) return [...new Set(ALIASES[id].flatMap(collect))];
    const fx = fixtures.filter(f => f.expect.case === id).flatMap(f => fixtureTest(f.rel));
    return [...new Set([...fx, ...byToken(id)])];
  };
  const srcOf = list => [...new Set(list.map(t => t.source))];
  const sourceBy = Object.fromEntries(sources.map(s => [s.label, s]));
  const exits = list => srcOf(list).map(l => (sourceBy[l].exit === undefined || sourceBy[l].exit === null ? '-' : sourceBy[l].exit)).join(', ') || '-';
  const counted = list => { const leaves = list.filter(t => t.leaf && t.directive === null); return `${leaves.filter(t => t.ok).length}/${leaves.length}`; };

  const levelRows = [];
  for (const s of sources) {
    // A suite whose describe callback throws is `not ok` while node:test still prints `# fail 0` and exits 0, so any
    // `not ok` line fails the row too.
    const failed = (s.summary.fail || 0) + (s.summary.cancelled || 0) + s.tests.filter(t => !t.ok && t.directive === null).length;
    const status = s.summary.tests === undefined ? 'NOT RUN' : failed || (s.exit !== undefined && s.exit !== null && s.exit !== 0) ? 'FAIL' : 'PASS';
    levelRows.push({ level: '0', row: s.label, status, tests: `${s.summary.pass ?? '-'}/${s.summary.tests ?? '-'}`, exit: s.exit ?? '-', artifact: `${s.label} (TAP sha256 ${s.sha256.slice(0, 12)})` });
  }
  for (const [level, ids] of [['1', LEVEL1], ['2', LEVEL2], ['3', LEVEL3]]) {
    for (const id of ids) {
      const list = collect(id);
      levelRows.push({ level, row: id + (ALIASES[id] ? ` (via ${ALIASES[id].join(', ')})` : ''), status: statusOf(list), tests: counted(list), exit: exits(list), artifact: srcOf(list).join(', ') || '-' });
    }
  }

  const fixtureRows = fixtures.map(f => {
    const list = fixtureTest(f.rel);
    const status = statusOf(list);
    const e = f.expect;
    const codes = (e.codes || []).join(', ') || '-';
    return { case: e.case, fixture: f.rel, variant: e.variant, exit: e.exit, codes, rules: (e.rules || []).join(', ') || '-', gate: gateOf(e), status,
      observed_exit: status === 'PASS' ? String(e.exit) : status, observed_codes: status === 'PASS' ? codes : status };
  }).sort((a, b) => LEVEL1.indexOf(a.case) - LEVEL1.indexOf(b.case) || (a.fixture < b.fixture ? -1 : a.fixture > b.fixture ? 1 : 0));
  const withFixture = new Set(fixtures.map(f => f.expect.case));
  const otherRows = LEVEL1.filter(id => !withFixture.has(id)).map(id => { const list = collect(id); return { case: id, status: statusOf(list), tests: counted(list), artifact: srcOf(list).join(', ') || '-' }; });
  return { sources, levelRows, fixtureRows, otherRows };
}

function render(t, commit, which) {
  const head = [];
  head.push('TAP sources (command, exit code, sha256 of the TAP output):');
  for (const s of t.sources) head.push(`- \`${s.command}\`: exit ${s.exit ?? '-'}, sha256 ${s.sha256}`);
  head.push(`Skill commit: ${commit}`);
  const out = ['<!-- generated by tests/v2-evidence/make-tables.js from node --test --test-reporter=tap output; do not edit -->', ''];
  if (which !== 'fixtures') {
    out.push('### Level table (Levels 0-3)', '', ...head, '');
    out.push('| Level | Row | Status | Tests ok/total | Exit code | Artifact | Skill commit |', '|---|---|---|---|---|---|---|');
    for (const r of t.levelRows) out.push(`| ${r.level} | ${esc(r.row)} | ${r.status} | ${r.tests} | ${r.exit} | ${esc(r.artifact)} | ${commit} |`);
    out.push('', 'Levels 4 and 5 are live rows; they are not derivable from TAP and are added from the live evidence.', '');
  }
  if (which !== 'level') {
    out.push('### Fixture matrix (plan 3.2)', '', ...head, '');
    out.push('Observed values are the ones the passing fixture test asserted equal to the expectation; FAIL or NOT RUN replaces them otherwise.', '');
    out.push('| Case | Fixture | Variant | Expected exit | Expected codes | Rules | Gate | Test | Observed exit | Observed codes |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of t.fixtureRows) out.push(`| ${r.case} | ${esc(r.fixture)} | ${esc(r.variant)} | ${r.exit} | ${esc(r.codes)} | ${esc(r.rules)} | ${r.gate} | ${r.status} | ${esc(r.observed_exit)} | ${esc(r.observed_codes)} |`);
    out.push('', 'Cases without a fixture file (stage and mode tests):', '', '| Case | Status | Tests ok/total | Artifact |', '|---|---|---|---|');
    for (const r of t.otherRows) out.push(`| ${r.case} | ${r.status} | ${r.tests} | ${esc(r.artifact)} |`);
    out.push('');
  }
  return out.join('\n');
}

function skillCommit() {
  const env = gitEnv();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: SKILL, encoding: 'utf8', env });
  if (head.status !== 0) return 'unknown';
  const dirty = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: SKILL, encoding: 'utf8', env });
  return head.stdout.trim() + (dirty.status === 0 && dirty.stdout.trim() ? '+dirty' : '');
}

function main(argv) {
  const a = parseArgs(argv);
  const sources = a.run ? runSources(path.resolve(a.tests_dir || DEFAULT_TESTS), a.save_tap && path.resolve(a.save_tap))
    : a.taps.map(t => {
      let bytes;
      try { bytes = fs.readFileSync(t.file); } catch (e) { throw new SetupError(`cannot read TAP ${t.file}: ${e.code || e.message}`); }
      return { label: path.basename(t.file), command: t.command || `(saved TAP ${path.basename(t.file)})`, exit: Number.isInteger(t.exit) ? t.exit : null, bytes };
    });
  const tables = build({ sources, fixtures: loadFixtures(path.resolve(a.fixtures || DEFAULT_FIXTURES)) });
  process.stdout.write(render(tables, a.commit || skillCommit(), a.table || 'all'));
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (e instanceof SetupError) { process.stderr.write(`make-tables: ${e.message}\n`); process.exitCode = 2; } else throw e;
  }
}

module.exports = { parseTap, build, render, gateOf };
