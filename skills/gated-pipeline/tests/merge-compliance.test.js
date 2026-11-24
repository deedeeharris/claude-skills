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

// ---- relayed mode: the Opus compliance trace (reviewer opus-high, or the codex-unavailable fallback) ----------------
// Opus returns its trace as the stage's structured output; there is no compliance.json. A large frozen plan can come
// back with every runtime command null (relay truncation), and check-completion then refuses. --mode relayed checks
// the relayed records in verify-result.json in place and restores such a command from the acceptance ledger under the
// codex path's exact-match rules, with the log bytes re-hashed from disk. These cases run the real v1 validator.
const { fixture: completionFixture } = require('./helpers/v1-completion-cases.js');
const { cleanEnv } = require('./helpers/v2-repo.js');
const checker = path.resolve(__dirname, '../scripts/check-completion.js');
const crypto = require('node:crypto');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function relayed(t, { relay = r => ({ ...r, command: null }), ledgerRec = r => r } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-relayed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = completionFixture(root);
  const runtime = { ...f.verify.compliance.requirements[0].evidence[0] };
  f.ledgerPath = path.join(f.artifacts, 'acceptance-ledger.json');
  writeJson(f.ledgerPath, { records: [{ id: 'R1', status: 'PASS', evidence: [ledgerRec(runtime)] }] });
  f.verify.compliance.requirements[0].evidence = [relay(runtime)];
  f.save();
  f.runtime = runtime;
  f.complete = () => spawnSync(process.execPath, [checker, ...f.argv()], { encoding: 'utf8', env: cleanEnv() });
  f.merge = (extra = []) => spawnSync(process.execPath, [merger, '--mode', 'relayed', '--verify-result', f.verifyPath, '--manifest', f.manifestPath,
    '--ledger', f.ledgerPath, '--checkout', path.join(root, 'compliance-opus', 'wt'), ...extra], { encoding: 'utf8' });
  return f;
}
const refusesFrozen = r => {
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout + r.stderr, /R1 evidence must use the frozen proof command/);
};

test('relayed: an Opus trace whose runtime commands came back null fails completion until the merger restores them from the ledger', t => {
  const f = relayed(t);
  refusesFrozen(f.complete());
  const before = fs.readFileSync(f.verifyPath, 'utf8');
  const m = f.merge();
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.match(m.stdout, /MERGED requirements=2/);
  const vr = readJson(f.verifyPath);
  assert.deepEqual(vr.compliance.requirements[0].evidence, [f.runtime]);
  assert.equal(vr.compliance.verdict, 'PASS');
  assert.match(vr.compliance.note, /runtime command taken from the acceptance ledger/);
  assert.equal(fs.readFileSync(f.verifyPath.replace(/\.json$/, '.relay.json'), 'utf8'), before);
  const c = f.complete();
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(JSON.parse(c.stdout).status, 'PASS');
})

test('relayed: a re-escaped (flattened) command is restored the same way', t => {
  const f = relayed(t, { relay: r => ({ ...r, command: JSON.stringify(r.command) }) });
  refusesFrozen(f.complete());
  assert.equal(f.merge().status, 0);
  assert.equal(f.complete().status, 0);
})

test('relayed: records that already carry the frozen command merge unchanged and completion passes', t => {
  const f = relayed(t, { relay: r => r });
  const m = f.merge();
  assert.equal(m.status, 0, m.stdout);
  assert.deepEqual(readJson(f.verifyPath).compliance.requirements[0].evidence, [f.runtime]);
  assert.equal(f.complete().status, 0);
})

test('relayed: no refill when the log hash, the log bytes on disk, the exit code, the head, the kind or the command text differ; completion still refuses', t => {
  const cases = [
    ['log hash differs from the ledger', { relay: r => ({ ...r, command: null, log_sha256: 'c'.repeat(64) }) }],
    ['log path differs from the ledger', { relay: r => ({ ...r, command: null, log_path: r.log_path + '.other' }) }],
    ['log bytes on disk no longer hash to the record', { after: f => fs.appendFileSync(f.runtime.log_path, 'tampered\n') }],
    ['ledger exit code differs', { ledgerRec: r => ({ ...r, exit_code: 1 }) }],
    ['relayed exit code differs', { relay: r => ({ ...r, command: null, exit_code: 1 }) }],
    ['ledger head differs', { ledgerRec: r => ({ ...r, head_sha: 'e'.repeat(40) }) }],
    ['relayed head differs', { relay: r => ({ ...r, command: null, head_sha: 'e'.repeat(40) }) }],
    ['ledger kind is not runtime', { ledgerRec: r => ({ ...r, kind: 'static' }) }],
    ['ledger command text is not the frozen proof_command', { ledgerRec: r => ({ ...r, command: r.command + ' --other' }) }],
    ['ledger command is the frozen text re-escaped', { ledgerRec: r => ({ ...r, command: JSON.stringify(r.command) }) }],
  ]
  for (const [name, opts] of cases) {
    const f = relayed(t, opts)
    if (opts.after) opts.after(f)
    const before = fs.readFileSync(f.verifyPath, 'utf8')
    const m = f.merge()
    assert.equal(m.status, 1, name + ': ' + m.stdout)
    assert.match(m.stdout, /REFUSED R1 would have no evidence left/, name)
    assert.equal(fs.readFileSync(f.verifyPath, 'utf8'), before, name + ': a refused merge leaves the verify result untouched')
    const c = f.complete()
    assert.notEqual(c.status, 0, name + ': completion must still refuse')
    assert.equal(fs.existsSync(f.out), false, name)
  }
})

test('relayed: a relative log path is never re-hashed or refilled', t => {
  const f = relayed(t)
  const rel = path.relative(process.cwd(), f.runtime.log_path)
  writeJson(f.ledgerPath, { records: [{ id: 'R1', status: 'PASS', evidence: [{ ...f.runtime, log_path: rel }] }] })
  f.verify.compliance.requirements[0].evidence = [{ ...f.runtime, command: null, log_path: rel }]
  f.save()
  const m = f.merge()
  assert.equal(m.status, 1, m.stdout)
  assert.match(m.stdout, /REFUSED R1 would have no evidence left/)
})

test('relayed: refuses unless the relayed trace is PASS with no blocking item and every ID passed, and never changes a verdict', t => {
  const edits = [
    [vr => { vr.compliance.verdict = 'FAIL' }, /relayed compliance is not PASS with zero blocking items/],
    [vr => { vr.compliance.blocking = [{ severity: 'high', title: 'missing' }] }, /relayed compliance is not PASS with zero blocking items/],
    [vr => { vr.compliance.requirements[1].status = 'NOT_RUN' }, /a relayed requirement is not PASS/],
    [vr => { vr.compliance.requirements.push({ ...vr.compliance.requirements[1] }) }, /duplicate requirement ID in the verify result/],
    [vr => { vr.compliance.requirements.push({ id: 'R9', status: 'PASS', evidence: [] }) }, /requirement not in the frozen manifest: R9/],
    [vr => { vr.compliance.requirements[1].evidence = ['app.js:2'] }, /R2 evidence in the verify result is not a record/],
  ]
  for (const [edit, why] of edits) {
    const f = relayed(t)
    edit(f.verify)
    f.save()
    const before = fs.readFileSync(f.verifyPath, 'utf8')
    const m = f.merge()
    assert.equal(m.status, 1, m.stdout)
    assert.match(m.stdout, why)
    assert.equal(fs.readFileSync(f.verifyPath, 'utf8'), before)
    assert.equal(fs.existsSync(f.verifyPath.replace(/\.json$/, '.relay.json')), false)
  }
})

test('relayed: --mode relayed takes no --compliance file and needs the ledger; an unknown mode is a usage error', t => {
  const f = relayed(t)
  for (const argv of [
    ['--mode', 'relayed', '--verify-result', f.verifyPath, '--manifest', f.manifestPath, '--ledger', f.ledgerPath, '--compliance', f.verifyPath],
    ['--mode', 'relayed', '--verify-result', f.verifyPath, '--manifest', f.manifestPath],
    ['--mode', 'other', '--verify-result', f.verifyPath, '--manifest', f.manifestPath, '--ledger', f.ledgerPath],
    ['--verify-result', f.verifyPath, '--manifest', f.manifestPath, '--ledger', f.ledgerPath],
  ]) {
    const r = spawnSync(process.execPath, [merger, ...argv], { encoding: 'utf8' })
    assert.equal(r.status, 2, argv.join(' ') + ': ' + r.stdout)
    assert.match(r.stderr, /usage/)
  }
})
