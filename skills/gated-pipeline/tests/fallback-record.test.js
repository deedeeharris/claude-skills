'use strict';

// The Opus fallback reviewer writes its own record (docs/v2-design.md section 5): write-json.js --out from the
// reviewer, then write-json.js --check from a deterministic step. --check re-reads the record, refuses a file that is
// missing, not strict JSON, not the reported sha256 or outside the record schema, and prints { path, sha256, value }
// so the workflow takes the review from the file. Real script, real files; nothing is mocked.
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

test('write-json --check: a written record re-reads to { path, sha256, value } with the value parsed from the file', t => {
  const { file, sha256 } = written(t);
  assert.equal(sha256, sha(fs.readFileSync(file)));
  const r = wj(['--check', file, '--sha256', sha256], JSON.stringify(SCHEMA));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'one JSON line');
  const out = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(out), ['path', 'sha256', 'value']);
  assert.equal(out.path, file);
  assert.equal(out.sha256, sha256);
  assert.deepEqual(out.value, RECORD);
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
