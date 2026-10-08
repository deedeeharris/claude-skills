#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const merger = path.resolve(__dirname, '../scripts/merge-compliance.js');
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const CMD = 'pytest tests/test_a.py -k "x and y"';
const CHECKOUT = 'C:/state/run/compliance/wt';

function fixture(t, { codex, relayEvidence = 'AC1: ran pytest, 3 passed', ledger } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-compliance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { kind: 'runtime', head_sha: 'a'.repeat(40), command: CMD, exit_code: 0, log_path: 'C:/state/run/acceptance/AC1.log', log_sha256: 'b'.repeat(64), file: null, line: null };
  const stat = { kind: 'static', head_sha: 'a'.repeat(40), command: null, exit_code: null, log_path: null, log_sha256: null, file: 'src/a.py', line: 3 };
  const files = {
    vr: path.join(dir, 'verify-result.json'),
    cj: path.join(dir, 'compliance.json'),
    manifest: path.join(dir, 'manifest.json'),
    ledger: path.join(dir, 'acceptance-ledger.json'),
  };
  writeJson(files.manifest, { requirements: [{ id: 'AC1', kind: 'runtime', proof_command: CMD }, { id: 'AC2', kind: 'static', proof_command: null }] })
  writeJson(files.vr, { status: 'PASS', reviewed_sha: 'a'.repeat(40), compliance: { verdict: 'PASS', note: 'relayed', blocking: [], requirements: [
    { id: 'AC1', status: 'PASS', evidence: [relayEvidence] }, { id: 'AC2', status: 'PASS', evidence: ['src/a.py:3'] }] } })
  writeJson(files.cj, codex || { verdict: 'PASS', findings: [], requirements: [
    { id: 'AC1', status: 'PASS', evidence: [runtime] }, { id: 'AC2', status: 'PASS', evidence: [stat] }] })
  writeJson(files.ledger, ledger || { records: [{ id: 'AC1', status: 'PASS', evidence: [runtime] }] })
  return { dir, files, runtime, stat }
}
function run(files, extra = []) {
  return spawnSync(process.execPath, [merger, '--verify-result', files.vr, '--compliance', files.cj, '--manifest', files.manifest,
    '--ledger', files.ledger, '--checkout', CHECKOUT, ...extra], { encoding: 'utf8' })
}
const codexWith = (fx, ac1, ac2 = [fx.stat]) => ({ verdict: 'PASS', findings: [], requirements: [
  { id: 'AC1', status: 'PASS', evidence: ac1 }, { id: 'AC2', status: 'PASS', evidence: ac2 }] })

test('when the relay flattened evidence to strings, restores codex records and keeps the relay copy', t => {
  const fx = fixture(t)
  const before = fs.readFileSync(fx.files.vr, 'utf8')
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const vr = readJson(fx.files.vr)
  assert.deepEqual(vr.compliance.requirements[0].evidence, [fx.runtime])
  assert.deepEqual(vr.compliance.requirements[1].evidence, [fx.stat])
  assert.equal(vr.compliance.verdict, 'PASS')
  assert.equal(vr.status, 'PASS')
  assert.equal(fs.readFileSync(path.join(fx.dir, 'verify-result.relay.json'), 'utf8'), before)
})

test('when codex re-escaped the command and the ledger record matches, takes the ledger command', t => {
  const fx = fixture(t)
  writeJson(fx.files.cj, codexWith(fx, [{ ...fx.runtime, command: CMD.replace(/"/g, '\\"') }]))
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout)
  assert.equal(readJson(fx.files.vr).compliance.requirements[0].evidence[0].command, CMD)
  assert.match(readJson(fx.files.vr).compliance.note, /taken from the acceptance ledger/)
})

test('when the re-escaped command has a different log hash than the ledger, refuses because nothing is left', t => {
  const fx = fixture(t)
  writeJson(fx.files.cj, codexWith(fx, [{ ...fx.runtime, command: 'other', log_sha256: 'c'.repeat(64) }]))
  const before = fs.readFileSync(fx.files.vr, 'utf8')
  const r = run(fx.files)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /REFUSED AC1 would have no evidence left/)
  assert.equal(fs.readFileSync(fx.files.vr, 'utf8'), before)
})

test('when the ledger record matches by log hash but its exit code or command differs, does not borrow it', t => {
  for (const ledgerRec of [r => ({ ...r, exit_code: 1 }), r => ({ ...r, command: 'pytest other' })]) {
    const fx = fixture(t)
    writeJson(fx.files.ledger, { records: [{ id: 'AC1', status: 'PASS', evidence: [ledgerRec(fx.runtime)] }] })
    writeJson(fx.files.cj, codexWith(fx, [{ ...fx.runtime, command: CMD.replace(/"/g, '\\"') }]))
    const r = run(fx.files)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /REFUSED AC1 would have no evidence left/)
  }
})

test('when the ledger record comes from another commit, does not borrow its command', t => {
  const fx = fixture(t)
  writeJson(fx.files.ledger, { records: [{ id: 'AC1', status: 'PASS', evidence: [{ ...fx.runtime, head_sha: 'e'.repeat(40) }] }] })
  writeJson(fx.files.cj, codexWith(fx, [{ ...fx.runtime, command: CMD.replace(/"/g, '\\"') }]))
  const r = run(fx.files)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /REFUSED AC1 would have no evidence left/)
})

test('when the ledger is a bare list of records, still repairs the command from it', t => {
  const fx = fixture(t)
  writeJson(fx.files.ledger, [{ id: 'AC1', status: 'PASS', evidence: [fx.runtime] }])
  writeJson(fx.files.cj, codexWith(fx, [{ ...fx.runtime, command: CMD.replace(/"/g, '\\"') }]))
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout)
  assert.equal(readJson(fx.files.vr).compliance.requirements[0].evidence[0].command, CMD)
})

test('when the ledger shape is not recognized, says so in the note and repairs nothing', t => {
  const fx = fixture(t)
  writeJson(fx.files.ledger, { AC1: { evidence: [fx.runtime] } })
  writeJson(fx.files.cj, codexWith(fx, [fx.runtime, { ...fx.runtime, command: CMD.replace(/"/g, '\\"'), log_sha256: 'f'.repeat(64) }]))
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout)
  assert.match(readJson(fx.files.vr).compliance.note, /ledger shape not recognized/)
  assert.deepEqual(readJson(fx.files.vr).compliance.requirements[0].evidence, [fx.runtime])
})

test('when a control command sits beside the frozen one, leaves the control out and notes it', t => {
  const fx = fixture(t)
  writeJson(fx.files.cj, codexWith(fx, [fx.runtime, { ...fx.runtime, command: 'bash control.sh', log_sha256: 'd'.repeat(64) }]))
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(readJson(fx.files.vr).compliance.requirements[0].evidence, [fx.runtime])
  assert.match(readJson(fx.files.vr).compliance.note, /bash control\.sh/)
})

test('when a static path is absolute, makes a checkout path repo-relative and leaves out any other', t => {
  const fx = fixture(t)
  writeJson(fx.files.cj, codexWith(fx, [fx.runtime], [{ ...fx.stat, file: 'C:\\state\\run\\compliance\\wt\\src\\a.py' }, { ...fx.stat, file: 'D:/elsewhere/b.py' }]))
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(readJson(fx.files.vr).compliance.requirements[1].evidence, [fx.stat])
})

test('when the checkout is spelled with dot segments or other letter case, still makes the path repo-relative', t => {
  for (const checkout of ['C:/state/./run/compliance/wt', 'C:/STATE/run/compliance/wt', 'c:\\state\\run\\x\\..\\compliance\\wt\\']) {
    const fx = fixture(t)
    writeJson(fx.files.cj, codexWith(fx, [fx.runtime], [{ ...fx.stat, file: 'C:/state/run/compliance/wt/src/a.py' }]))
    const r2 = spawnSync(process.execPath, [merger, '--verify-result', fx.files.vr, '--compliance', fx.files.cj, '--manifest', fx.files.manifest,
      '--ledger', fx.files.ledger, '--checkout', checkout], { encoding: 'utf8' })
    assert.equal(r2.status, 0, checkout + ': ' + r2.stdout)
    assert.deepEqual(readJson(fx.files.vr).compliance.requirements[1].evidence, [fx.stat], checkout)
  }
})

test('when a posix checkout differs only in letter case, does not treat it as the same directory', t => {
  const fx = fixture(t)
  writeJson(fx.files.cj, codexWith(fx, [fx.runtime], [{ ...fx.stat, file: '/state/run/compliance/wt/src/a.py' }, fx.stat]))
  const r = spawnSync(process.execPath, [merger, '--verify-result', fx.files.vr, '--compliance', fx.files.cj, '--manifest', fx.files.manifest,
    '--ledger', fx.files.ledger, '--checkout', '/STATE/run/compliance/wt'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout)
  assert.match(readJson(fx.files.vr).compliance.note, /left out: static path outside the repo/)
})

test('when codex compliance is not a clean PASS, refuses and leaves the verify result untouched', t => {
  for (const codex of [{ verdict: 'FAIL', findings: [], requirements: [] }, { verdict: 'PASS', findings: [{ id: 'F1' }], requirements: [] }]) {
    const fx = fixture(t, { codex })
    const before = fs.readFileSync(fx.files.vr, 'utf8')
    const r = run(fx.files)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /REFUSED codex compliance is not PASS/)
    assert.equal(fs.readFileSync(fx.files.vr, 'utf8'), before)
    assert.equal(fs.existsSync(path.join(fx.dir, 'verify-result.relay.json')), false)
  }
})

test('when compliance.json lists the same IDs in another order, merges', t => {
  const fx = fixture(t)
  const cj = readJson(fx.files.cj)
  cj.requirements.reverse()
  writeJson(fx.files.cj, cj)
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(readJson(fx.files.vr).compliance.requirements.map(x => x.id), ['AC2', 'AC1'])
})

test('when an ID is missing, extra or duplicated, refuses', t => {
  const cases = [
    [cj => cj.requirements.pop(), /requirement IDs differ/],
    [cj => cj.requirements.push({ id: 'AC3', status: 'PASS', evidence: [] }), /requirement IDs differ/],
    [cj => { cj.requirements[1] = { ...cj.requirements[0] } }, /duplicate requirement ID in compliance\.json/],
  ]
  for (const [edit, why] of cases) {
    const fx = fixture(t)
    const cj = readJson(fx.files.cj)
    edit(cj)
    writeJson(fx.files.cj, cj)
    const r = run(fx.files)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stdout, why)
  }
})

test('when a repo-relative static path uses backslashes or ./, writes it in the validator form', t => {
  for (const file of ['src\\a.py', './src/a.py', 'src/./a.py']) {
    const fx = fixture(t)
    writeJson(fx.files.cj, codexWith(fx, [fx.runtime], [{ ...fx.stat, file }]))
    const r = run(fx.files)
    assert.equal(r.status, 0, file + ': ' + r.stdout)
    assert.deepEqual(readJson(fx.files.vr).compliance.requirements[1].evidence, [fx.stat], file)
  }
})

test('when a relative static path climbs out of the repo, leaves it out', t => {
  const fx = fixture(t)
  writeJson(fx.files.cj, codexWith(fx, [fx.runtime], [{ ...fx.stat, file: '..\\other\\a.py' }, fx.stat]))
  const r = run(fx.files)
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(readJson(fx.files.vr).compliance.requirements[1].evidence, [fx.stat])
  assert.match(readJson(fx.files.vr).compliance.note, /static path leaves the repo/)
})

test('when a required flag is missing, exits 2 with usage', t => {
  const fx = fixture(t)
  const r = spawnSync(process.execPath, [merger, '--verify-result', fx.files.vr], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage/)
})
