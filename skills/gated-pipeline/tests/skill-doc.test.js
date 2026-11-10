'use strict';

// WP6 doc check (docs/v2-plan.md WP6): SKILL.md documents the contract-2 stage args the workflows require, the
// forbidden args they BLOCK, and a handoff table that names every design result field build, verify and land
// consume. The required-arg lists are read from the workflows themselves (each stage run with only
// `contract: 2` BLOCKS with "missing args: ..."), so a new required arg fails this test until it is documented.
// The template check reads templates/pipeline.yaml with the line rule check-completion.js --mode design uses for
// the repo owner's upper bound (design section 2).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { run } = require('./helpers/run-workflow');
const { parse } = require('../scripts/lib/strict-json');

const ROOT = path.join(__dirname, '..');
const SKILL = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'templates', 'pipeline.yaml'), 'utf8');
const STAGES = ['design', 'build', 'verify', 'land'];
const source = stage => fs.readFileSync(path.join(ROOT, 'workflows', stage + '.js'), 'utf8');
const ALL_FORBIDDEN = ['task', 'charge', 'checks', 'clean_ignore', 'state_paths', 'suite_cmd', 'unit_cmd', 'known_failures', 'isolated_setup', 'suite_isolated', 'live_budget_min'];

// The rows of the first Markdown table after `heading` (a whole line), as arrays of trimmed cells.
function table(heading) {
  const lines = SKILL.split('\n');
  const at = lines.indexOf(heading);
  assert.ok(at >= 0, `SKILL.md has the heading ${JSON.stringify(heading)}`);
  let i = at + 1;
  while (i < lines.length && !lines[i].startsWith('|')) { assert.ok(!/^#/.test(lines[i]), `a table follows ${heading}`); i++; }
  const rows = [];
  for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  assert.ok(rows.length > 2, `${heading}: header, separator and rows`);
  assert.ok(rows[1].every(c => /^:?-+:?$/.test(c)), `${heading}: the second row is the separator`);
  return { header: rows[0], rows: rows.slice(2) };
}
const ticked = cell => [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]);
async function missingArgs(stage, args = {}) {
  const { result } = await run(stage, { contract: 2, ...args }, []);
  const m = /^missing args: (.*)$/.exec(result.reason || '');
  assert.ok(m, `${stage}: with only contract 2 it reports its missing args (${JSON.stringify(result)})`);
  return m[1].split(', ');
}
async function forbiddenArgs(stage) {
  const extra = stage === 'design' ? { feature_id: 'a', repo: '/r', run_dir: '/x', review_runner: '/y', completion_runner: '/z/check-completion.js', work_branch: 'b', source_request_path: '/s' } : {};
  const { result } = await run(stage, { contract: 2, ...extra, ...Object.fromEntries(ALL_FORBIDDEN.filter(k => stage === 'design' || !['task', 'charge'].includes(k)).map(k => [k, 'x'])) }, []);
  const m = /^contract 2 does not take (.*?):/.exec(result.reason || '');
  assert.ok(m, `${stage}: contract 2 refuses the forbidden args (${JSON.stringify(result)})`);
  return m[1].split(', ');
}
// The keys of design's contract-2 PASS result (the freeze return in workflows/design.js).
function designResultKeys() {
  const src = source('design');
  const start = src.indexOf("return end({ status: 'PASS', feature_path");
  assert.ok(start >= 0, 'design.js has the contract-2 PASS return');
  const body = src.slice(start, src.indexOf('})', start));
  return [...new Set([...body.matchAll(/(?:\{|,)\s*([a-z_0-9]+)(?=[:,\s}])/g)].map(m => m[1]))].filter(k => k !== 'status');
}
// Stage args that carry a design result field under another name.
const RENAMED = { spec_path: 'feature_path', base_commit: 'design_commit' };

describe('SKILL.md v2 arg tables (plan WP6)', () => {
  for (const stage of STAGES) {
    test(`${stage}: every required contract-2 arg is documented as required, every documented arg is read by the workflow`, async () => {
      const need = await missingArgs(stage);
      const { rows } = table(`### v2 args: ${stage}`);
      const doc = new Map(rows.flatMap(r => ticked(r[0]).map(n => [n, r[1]])));
      for (const a of need) {
        assert.ok(doc.has(a), `${stage}: required arg ${a} is in the v2 arg table`);
        assert.match(doc.get(a), /^required/, `${stage}: ${a} is marked required`);
      }
      const src = source(stage);
      for (const a of doc.keys()) assert.ok(a === 'contract' || src.includes('A.' + a) || src.includes(`'${a}'`), `${stage}: documented arg ${a} is read by workflows/${stage}.js`);
      assert.ok(doc.has('contract') && /^required/.test(doc.get('contract')), `${stage}: contract is documented (required, value 2)`);
    });
  }

  test('the forbidden-arg list equals what every v2 stage BLOCKS', async () => {
    const lines = SKILL.split('\n');
    const at = lines.indexOf('### v2 forbidden args');
    assert.ok(at >= 0, 'SKILL.md has the heading ### v2 forbidden args');
    // first paragraph line: exactly the list; the next one names task and charge (the mixing rule)
    const [listLine, mixLine] = lines.slice(at + 1).filter(l => l.trim()).slice(0, 2);
    const listed = ticked(listLine);
    for (const stage of ['build', 'verify', 'land']) assert.deepEqual([...listed].sort(), [...await forbiddenArgs(stage)].sort(), `${stage}: the documented list equals the BLOCKED list`);
    const design = await forbiddenArgs('design');
    assert.deepEqual(design.filter(k => !listed.includes(k)).sort(), ['charge', 'task'], 'design blocks the same list plus task and charge');
    for (const k of ['task', 'charge']) assert.ok(ticked(mixLine).includes(k), `${k} is named in the line after the forbidden list`);
  });

  test('the handoff table names every design result field build, verify and land consume', async () => {
    const keys = designResultKeys();
    for (const k of ['feature_path', 'design_commit', 'frozen_dir', 'manifest_path', 'manifest_sha256', 'approvals_path', 'approvals_sha256']) assert.ok(keys.includes(k), `design result has ${k}`);
    const { header, rows } = table('### v2 stage handoff');
    assert.deepEqual(header.slice(0, 2), ['Field', 'From']);
    const col = Object.fromEntries(header.map((h, i) => [h, i]));
    for (const stage of ['build', 'verify', 'land']) {
      assert.ok(stage in col, `the handoff table has a ${stage} column`);
      for (const arg of await missingArgs(stage)) {
        const field = keys.includes(arg) ? arg : RENAMED[arg];
        if (!field) continue;
        const row = rows.find(r => ticked(r[0])[0] === field && r[1] === 'design');
        assert.ok(row, `the handoff table has a row for design's ${field}`);
        assert.ok(ticked(row[col[stage]]).includes(arg), `design's ${field} -> ${stage} arg ${arg}`);
      }
    }
    // every design field named in the table really is a design result field
    for (const r of rows.filter(r => r[1] === 'design')) assert.ok(keys.includes(ticked(r[0])[0]), `${r[0]} is a design result field`);
  });

  test('SKILL.md covers the v2 operating rules the plan lists', () => {
    for (const term of [
      'contract: 2', '.gitattributes', '-text', 'v2/design-gated', 'source_request_mode', 'source_request_ref', 'E_SOURCE_LEAK',
      'exclusive', 'owned_paths', 'test_paths', 'ci_failure_log_path', 'CI_RED', 'HEAD_MOVED', 'git revert', 'resumeFromRunId',
      'recover: true', 'previous_design', 'scripts/migrate-v1.js', 'MIGRATION-TODO', 'model_rule_disagreement', 'features_dir',
      'run-frozen.js', 'Contract 1 (v1) compatibility',
    ]) assert.ok(SKILL.includes(term), `SKILL.md mentions ${term}`);
  });

  test('the Migration from v1 section names the id rules, every report key and every conflict kind migrate-v1 writes', () => {
    const at = SKILL.indexOf('### Migration from v1');
    assert.ok(at >= 0, 'SKILL.md has a Migration from v1 section');
    const section = SKILL.slice(at, SKILL.indexOf('\n## ', at));
    const code = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-v1.js'), 'utf8');
    const kinds = [...new Set([...code.matchAll(/conflicts\.push\(\{ kind: '([a-z0-9_]+)'/g)].map(m => m[1]))];
    assert.ok(kinds.length >= 5, `conflict kinds read from migrate-v1.js: ${kinds}`);
    // a kind is documented by its own name or, for the original four, by the words the section uses for it
    const words = { only_in_spec: 'only one of spec.md and the manifest', only_in_manifest: 'only one of spec.md and the manifest',
      proof_command_differs: 'differing proof commands', spec_sha256_differs: '`spec_sha256`' };
    for (const k of kinds) assert.ok(section.includes(`\`${k}\``) || (words[k] && section.includes(words[k])), `the section documents the conflict kind ${k}`);
    for (const term of ['`todos`', '`conflicts`', '`unmapped_tests`', '`lost`', '`provenance_missing`', '`mapping`',
      'v2 form `<REQ>-ACn` is kept', 'requirement form `<REQ>` becomes `<REQ>-ACn`', '`MIG-NNN-AC1`', '`depends_on`', '`suite.known_failures`',
      '`E_MIGRATION_TODO`', '`E_PROTECTED_OVERLAP`', '`E_STATE_OVERLAP`']) assert.ok(section.includes(term), `the section mentions ${term}`);
  });
});

describe('templates/pipeline.yaml (plan WP6, design section 2)', () => {
  // The --mode design line rule: the key line inside its parent block holds a one-line JSON array of strings.
  function bound(parent, key) {
    const lines = TEMPLATE.split('\n');
    const start = lines.findIndex(l => new RegExp(`^${parent}:\\s*(#.*)?$`).test(l));
    assert.ok(start >= 0, `the template has a ${parent}: block`);
    const block = [];
    for (const l of lines.slice(start + 1)) { if (/^\S/.test(l) && !/^#/.test(l)) break; block.push(l); }
    const hits = block.map(l => new RegExp(`^(\\s+)${key}:(.*)$`).exec(l)).filter(Boolean);
    assert.equal(hits.length, 1, `${parent}.${key} appears once`);
    const m = /^\s*(\[.*\])\s*(#.*)?$/.exec(hits[0][2]);
    assert.ok(m, `${parent}.${key} is a one-line JSON array`);
    const value = parse(Buffer.from(m[1], 'utf8')).value;
    assert.ok(Array.isArray(value) && value.every(x => typeof x === 'string'), `${parent}.${key} is a JSON array of strings`);
    return value;
  }
  test('the three upper-bound lists are one-line JSON arrays; design.features_dir is set', () => {
    bound('tests', 'known_failures');
    bound('tests', 'clean_ignore');
    bound('state', 'paths');
    assert.match(TEMPLATE, /^design:\s*(#.*)?\n\s+features_dir: \.pipeline\/features\b/m);
  });
});
