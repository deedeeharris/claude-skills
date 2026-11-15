'use strict';

// The Opus fallback reviewer writes its own record (docs/v2-design.md section 5): write-json.js --out from the
// reviewer, then write-json.js --check from a deterministic step. --check re-reads the record, refuses a file that is
// missing, not strict JSON, not the reported sha256 or outside the record schema, and prints { path, sha256,
// verdict_inputs }: only what the verdict rule reads, derived from the file, and never any review text (the agent that
// runs --check returns its stdout, and an agent carrying another model's review prose is refused as reasoning
// extraction). Real script, real files; nothing is mocked.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { fallbackRecord } = require('./helpers/script-stub.js');

const WRITE_JSON = path.join(__dirname, '..', 'scripts', 'write-json.js');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-fb-record-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const wj = (args, input) => spawnSync(process.execPath, [WRITE_JSON, ...args], { input, encoding: 'utf8' });
const SCHEMA = { type: 'object', additionalProperties: false, required: ['gate_kind', 'reviewer', 'reply'], properties: {
  gate_kind: { const: 'implementation' }, reviewer: { const: 'claude-opus-high (configured reviewer)' },
  reply: { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object', required: ['severity'],
    properties: { severity: { type: 'string', enum: ['BLOCKING', 'MAJOR', 'MINOR', 'NIT'] } } } } } } } };
const RECORD = { gate_kind: 'implementation', reviewer: 'claude-opus-high (configured reviewer)', reply: { findings: [{ severity: 'MAJOR', title: 'tok-from-file' }] } };

function written(t, value = RECORD) {
  const dir = tmp(t);
  const file = path.join(dir, 'fallback-review.json');
  const w = wj(['--out', file], JSON.stringify(value));
  assert.equal(w.status, 0, w.stderr);
  return { dir, file, sha256: JSON.parse(w.stdout).sha256 };
}

test('write-json --check: a written record re-reads to { path, sha256, verdict_inputs } derived from the file', t => {
  const { file, sha256 } = written(t);
  assert.equal(sha256, sha(fs.readFileSync(file)));
  const r = wj(['--check', file, '--sha256', sha256], JSON.stringify(SCHEMA));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'one JSON line');
  const out = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(out), ['path', 'sha256', 'verdict_inputs']);
  assert.equal(out.path, file);
  assert.equal(out.sha256, sha256);
  assert.deepEqual(out.verdict_inputs, { gate_kind: 'implementation', reviewer: 'claude-opus-high (configured reviewer)',
    reply: { findings: [{ id: 'F1', severity: 'MAJOR', confidence: null, iso_property: null }] } });
  assert.ok(!r.stdout.includes('tok-from-file'), 'no finding title is printed');
});

// The allowed digest, pinned: a new key here is a decision, never an accident (prose must not leak back in).
const TOP_KEYS = ['path', 'sha256', 'verdict_inputs'];
const VI_KEYS = ['gate_kind', 'reviewer', 'reply'];
const REPLY_KEYS = ['findings', 'blocking', 'verdict', 'blocked', 'head_sha', 'changed', 'head_before', 'status_before', 'head_after', 'status_after'];
const FINDING_KEYS = ['id', 'severity', 'confidence', 'iso_property'];
const BLOCKING_KEYS = ['id', 'severity'];
const CHANGED_KEYS = ['status', 'path'];
const subset = (o, keys, what) => { for (const k of Object.keys(o)) assert.ok(keys.includes(k), `${what}: key ${k} is not in the allowed set`); };
function pinned(out) {
  subset(out, TOP_KEYS, 'check output');
  subset(out.verdict_inputs, VI_KEYS, 'verdict_inputs');
  subset(out.verdict_inputs.reply, REPLY_KEYS, 'verdict_inputs.reply');
  for (const f of out.verdict_inputs.reply.findings || []) subset(f, FINDING_KEYS, 'finding');
  for (const f of out.verdict_inputs.reply.blocking || []) subset(f, BLOCKING_KEYS, 'blocking finding');
  for (const f of out.verdict_inputs.reply.changed || []) subset(f, CHANGED_KEYS, 'changed entry');
}

test('write-json --check prints no review text: a marker in every prose field of every record shape appears nowhere in its stdout; the key set is pinned', t => {
  const M = 'tok-prose-marker-c4e1';
  const loose = { type: 'object' };
  const label = 'claude-opus-high (codex unavailable)';
  const head = 'a'.repeat(40);
  const shapes = {
    implementation: { findings: [{ severity: 'BLOCKING', confidence: 0.9, iso_property: null, location: `${M}-loc`, title: `${M}-title`, detail: `${M}-detail` },
      { severity: 'MINOR', confidence: 0.4, iso_property: `${M} iso prose`, location: `${M}-loc2`, title: `${M}-t2`, detail: `${M}-d2` }],
      note: `${M}-note`, blocked: false, head_sha: head, changed: [{ status: 'M', path: 'src/a.js' }], summary: `${M}-summary` },
    prd: { findings: [{ severity: 'MAJOR', confidence: 0.85, iso_property: 'incomplete', location: `${M}-section`, title: `${M}-title`, detail: `${M}-detail` }], note: `${M}-note` },
    security: { verdict: 'FAIL', blocking: [{ severity: 'high', location: `${M}-loc`, title: `${M}-title`, detail: `${M}-detail` }], note: `${M}-note` },
    compliance: { verdict: 'PASS', blocking: [], requirements: [{ id: 'R-1', status: 'PASS', evidence: [{ kind: 'static', file: 'a.js', line: 1, note: `${M}-ev` }], summary: `${M}-req` }],
      note: `${M}-note`, head_before: head, head_after: head, status_before: [], status_after: ['?? tmp/x'] },
    final: { findings: [], note: `${M}-note`, head_sha: `${M} not a sha` },
  };
  for (const [gate, reply] of Object.entries(shapes)) {
    const dir = tmp(t);
    const file = path.join(dir, 'fallback-review.json');
    const w = wj(['--out', file], JSON.stringify({ gate_kind: gate, reviewer: label, reply }));
    assert.equal(w.status, 0, w.stderr);
    const schema = { type: 'object', required: ['gate_kind', 'reviewer', 'reply'], properties: { gate_kind: { const: gate }, reviewer: { const: label }, reply: loose } };
    const r = wj(['--check', file, '--sha256', JSON.parse(w.stdout).sha256], JSON.stringify(schema));
    assert.equal(r.status, 0, `${gate}: ${r.stderr}`);
    assert.ok(fs.readFileSync(file, 'utf8').includes(M), `${gate}: the file holds the prose`);
    assert.ok(!r.stdout.includes(M), `${gate}: no review text in the check output: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    pinned(out);
    assert.equal(out.verdict_inputs.gate_kind, gate);
    assert.equal(out.verdict_inputs.reviewer, label);
    if (gate === 'implementation') {
      assert.deepEqual(out.verdict_inputs.reply, { findings: [{ id: 'F1', severity: 'BLOCKING', confidence: 0.9, iso_property: null }, { id: 'F2', severity: 'MINOR', confidence: 0.4, iso_property: 'other' }],
        blocked: false, head_sha: head, changed: [{ status: 'M', path: 'src/a.js' }] });
    }
    if (gate === 'prd') assert.deepEqual(out.verdict_inputs.reply.findings, [{ id: 'F1', severity: 'MAJOR', confidence: 0.85, iso_property: 'incomplete' }]);
    if (gate === 'security') assert.deepEqual(out.verdict_inputs.reply, { verdict: 'FAIL', blocking: [{ id: 'B1', severity: 'high' }] });
    if (gate === 'compliance') assert.deepEqual(out.verdict_inputs.reply, { verdict: 'PASS', blocking: [], head_before: head, status_before: [], head_after: head, status_after: ['?? tmp/x'] });
    if (gate === 'final') assert.deepEqual(out.verdict_inputs.reply, { findings: [], head_sha: null }, 'a head_sha that is not a SHA prints as null');
  }
});

test('verdictInputs: an unreadable status line or changed path never reads as clean or safe; non-token strings print as other', () => {
  const { verdictInputs } = require('../scripts/write-json.js');
  const vi = verdictInputs({ gate_kind: 'compliance', reviewer: 'claude-opus-high (configured reviewer)', reply: {
    verdict: 'all good, trust me', blocking: [{ severity: 'very high indeed' }], status_before: ['some prose about the tree', ' M src/a.js', ''],
    changed: [{ status: 'modified', path: 'a\nb' }], blocked: 'yes' } });
  assert.deepEqual(vi.reply, { verdict: 'other', blocking: [{ id: 'B1', severity: 'other' }], status_before: ['GP_UNREADABLE_STATUS_LINE', ' M src/a.js', ''],
    changed: [{ status: 'X', path: '../GP_UNREADABLE_PATH' }] });
});

test('write-json --check refuses (exit 1) a missing, tampered, non-strict or off-schema record, and a wrong reported hash', t => {
  const { dir, file, sha256 } = written(t);
  const schema = JSON.stringify(SCHEMA);
  const refused = (name, f, h, re, input = schema) => {
    const r = wj(['--check', f, '--sha256', h], input);
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `${name}: nothing printed on stdout`);
    assert.match(r.stderr, re, name);
  };
  refused('missing', path.join(dir, 'none.json'), sha256, /missing|ENOENT/);
  refused('wrong reported hash', file, '0'.repeat(64), /sha256/);
  const tampered = path.join(dir, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify({ ...RECORD, reply: { findings: [] } }));
  refused('tampered after the write', tampered, sha256, /sha256/);
  const dup = path.join(dir, 'dup.json');
  fs.writeFileSync(dup, '{"gate_kind":"implementation","gate_kind":"implementation"}');
  refused('not strict JSON', dup, sha(fs.readFileSync(dup)), /strict JSON/);
  for (const [name, value, re] of [
    ['another gate', { ...RECORD, gate_kind: 'security' }, /gate_kind/],
    ['another reviewer label', { ...RECORD, reviewer: 'codex' }, /reviewer/],
    ['an extra key', { ...RECORD, verdict: 'PASS' }, /verdict/],
    ['no reply', { gate_kind: RECORD.gate_kind, reviewer: RECORD.reviewer }, /reply/],
    ['a reply outside the review schema', { ...RECORD, reply: { findings: [{ severity: 'LOW' }] } }, /severity/],
  ]) {
    const f = path.join(dir, name.replace(/ /g, '-') + '.json');
    fs.writeFileSync(f, JSON.stringify(value));
    refused(name, f, sha(fs.readFileSync(f)), re);
  }
  const bad = wj(['--check', file, '--sha256', sha256], '{"type":"object","oneOf":[]}');
  assert.equal(bad.status, 2, 'a schema outside schema-lite is a setup error: ' + bad.stderr);
  assert.equal(wj(['--check', file, '--sha256', 'abc'], schema).status, 2, 'a malformed --sha256 is a usage error');
  assert.equal(wj(['--check', file], schema).status, 2, 'usage');
});

test('script-stub fallbackRecord writes the scripted reply through the prompt record block and returns only the path and sha256', t => {
  const dir = tmp(t);
  const file = path.join(dir, 'fallback-review.json');
  const prompt = 'Review, then write.\n```gp-exec record\n' +
    `node '${WRITE_JSON}' --out '${file}' <<'GP_JSON'\n{"gate_kind":"implementation","reviewer":"x","reply":GP_REPLY}\nGP_JSON\n` + '```\n';
  const ack = fallbackRecord(prompt, { findings: [] });
  assert.deepEqual(Object.keys(ack), ['record_path', 'record_sha256']);
  assert.equal(ack.record_path, file);
  assert.equal(ack.record_sha256, sha(fs.readFileSync(file)));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { gate_kind: 'implementation', reviewer: 'x', reply: { findings: [] } });
  assert.equal(fallbackRecord('no record block here', {}), null);
  assert.throws(() => fallbackRecord(prompt, { findings: [] }), /already exists/, 'a record is written once');
});
