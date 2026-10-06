#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const checker = path.resolve(__dirname, '../scripts/check-completion.js');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(repo);
  fs.mkdirSync(artifacts);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Gate Test');
  git(repo, 'config', 'user.email', 'gate-test@example.invalid');
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = false;\n// acceptance\n');
  fs.writeFileSync(path.join(repo, 'protected.js'), '// protected\n');
  git(repo, 'add', 'app.js', 'protected.js');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = true;\n// acceptance\n');
  git(repo, 'add', 'app.js');
  git(repo, 'commit', '-qm', 'implementation');
  const head = git(repo, 'rev-parse', 'HEAD');
  const spec = path.join(artifacts, 'spec.md');
  const manifestPath = path.join(artifacts, 'manifest.json');
  const buildPath = path.join(artifacts, 'build-result.json');
  const verifyPath = path.join(artifacts, 'verify-result.json');
  const out = path.join(root, 'proof', 'completion.json');
  fs.writeFileSync(spec, '# Frozen plan\nR1 runs; R2 is documented.\n');
  const log = name => {
    const file = path.join(artifacts, name);
    fs.writeFileSync(file, 'Observed output: PASS\n');
    return file;
  };
  const state = () => ({ head_before: head, status_before: [], head_after: head, status_after: [] });
  const manifest = {
    version: 1, feature_id: 'feature-1', spec_sha256: sha256(fs.readFileSync(spec)),
    allowed_paths: ['app.js'], protected_paths: ['protected.js'],
    requirements: [
      { id: 'R1', kind: 'runtime', proof_command: 'node acceptance.js' },
      { id: 'R2', kind: 'static', proof_command: 'inspect app.js' },
    ],
    checks: [
      { name: 'smoke', applicable: true, reason: '' },
      { name: 'visual', applicable: false, reason: 'No user interface in this change.' },
    ],
  };
  const build = {
    status: 'PASS', feature_id: 'feature-1', base_commit: base, reviewed_sha: head,
    review: { verdict: 'PASS', head_sha: head, confirmed_findings: [] },
    security: { verdict: 'PASS', blocking: [] },
    suite: { completed: true, passed: true, failures: [], other_failures: [], log_path: log('suite.log'), ...state() },
    known_failures_seen: [], files: ['intentionally-untrusted.js'], deleted: [],
  };
  const verify = {
    status: 'PASS', feature_id: 'feature-1', base_commit: base, reviewed_sha: head, manifest_sha256: '',
    results: [{ name: 'smoke', status: 'PASS', evidence_path: log('smoke.log'), ...state() }],
    final_review: { verdict: 'PASS', head_sha: head, confirmed_findings: [] },
    compliance: {
      verdict: 'PASS', blocking: [], ...state(),
      requirements: [
        { id: 'R1', status: 'PASS', evidence: [{ kind: 'runtime', head_sha: head, command: 'node acceptance.js', exit_code: 0, log_path: log('R1.log'), file: null, line: null }] },
        { id: 'R2', status: 'PASS', evidence: [{ kind: 'static', head_sha: head, command: null, exit_code: null, log_path: null, file: 'app.js', line: 2 }] },
      ],
    },
  };
  build.suite.log_sha256 = sha256(fs.readFileSync(build.suite.log_path));
  verify.results[0].evidence_sha256 = sha256(fs.readFileSync(verify.results[0].evidence_path));
  verify.compliance.requirements[0].evidence[0].log_sha256 = sha256(fs.readFileSync(verify.compliance.requirements[0].evidence[0].log_path));
  const f = { root, repo, artifacts, head, base, spec, manifestPath, buildPath, verifyPath, out, manifest, build, verify, log };
  f.save = () => {
    writeJson(manifestPath, manifest);
    f.manifestHash = sha256(fs.readFileSync(manifestPath));
    verify.manifest_sha256 = f.manifestHash;
    writeJson(buildPath, build);
    writeJson(verifyPath, verify);
  };
  f.run = (overrides = {}) => {
    const flags = {
      repo, 'feature-id': 'feature-1', 'reviewed-sha': head,
      manifest: manifestPath, 'manifest-sha256': f.manifestHash, spec,
      'build-result': buildPath, 'verify-result': verifyPath, out, ...overrides,
    };
    return spawnSync(process.execPath, [checker, ...Object.entries(flags).flatMap(([k, v]) => ['--' + k, v])], { encoding: 'utf8' });
  };
  f.save();
  return f;
}

function blocked(f, result, reason) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr + result.stdout, /BLOCKED/);
  assert.match(result.stderr + result.stdout, reason);
  assert.equal(fs.existsSync(f.out), false, 'a blocked run must not write a completion proof');
}

test('valid real repository produces proof using authoritative git files and hashed artifacts', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(fs.readFileSync(f.out));
  assert.equal(proof.status, 'PASS');
  assert.equal(proof.feature_id, 'feature-1');
  assert.equal(proof.reviewed_sha, f.head);
  assert.equal(proof.manifest_sha256, f.manifestHash);
  assert.equal(JSON.parse(result.stdout).manifest_sha256, f.manifestHash);
  assert.deepEqual(proof.changed_files, ['app.js']);
  assert.equal(proof.requirements.length, 2);
  assert.equal(proof.suite.status, 'GREEN');
});

const invalid = [
  ['missing requirement', f => f.verify.compliance.requirements.pop(), /missing.*R2/i],
  ['duplicate requirement', f => f.verify.compliance.requirements.push(f.verify.compliance.requirements[0]), /duplicate.*R1/i],
  ['unknown requirement', f => f.verify.compliance.requirements.push({ id: 'EXTRA', status: 'PASS', evidence: [] }), /unknown.*EXTRA/i],
  ['requirement NOT_RUN', f => { f.verify.compliance.requirements[0].status = 'NOT_RUN'; }, /R1.*PASS/i],
  ['requirement FAIL', f => { f.verify.compliance.requirements[0].status = 'FAIL'; }, /R1.*PASS/i],
  ['runtime requirement cannot use static evidence alone', f => { f.verify.compliance.requirements[0].evidence = [f.verify.compliance.requirements[1].evidence[0]]; }, /R1.*runtime/i],
  ['stale evidence SHA', f => { f.verify.compliance.requirements[0].evidence[0].head_sha = f.base; }, /evidence.*SHA/i],
  ['different proof command', f => { f.verify.compliance.requirements[0].evidence[0].command = 'echo PASS'; }, /proof.command/i],
  ['runtime nonzero exit', f => { f.verify.compliance.requirements[0].evidence[0].exit_code = 1; }, /exit/i],
  ['empty runtime log', f => fs.writeFileSync(f.verify.compliance.requirements[0].evidence[0].log_path, ''), /nonempty/i],
  ['missing runtime log', f => fs.unlinkSync(f.verify.compliance.requirements[0].evidence[0].log_path), /artifact/i],
  ['static line beyond file', f => { f.verify.compliance.requirements[1].evidence[0].line = 99; }, /line/i],
  ['static missing file', f => { f.verify.compliance.requirements[1].evidence[0].file = 'absent.js'; }, /static.*file/i],
  ['static unsafe path', f => { f.verify.compliance.requirements[1].evidence[0].file = '../app.js'; }, /unsafe/i],
  ['spec drift', f => fs.appendFileSync(f.spec, 'unapproved change\n'), /spec.*hash/i],
  ['scope outside allowed paths', f => { f.manifest.allowed_paths = ['other.js']; }, /scope.*app.js/i],
  ['protected changed file', f => { f.manifest.protected_paths = ['app.js']; }, /protected.*app.js/i],
  ['unsafe allowed path', f => { f.manifest.allowed_paths = ['../']; }, /unsafe/i],
  ['unsafe protected path', f => { f.manifest.protected_paths = ['/app.js']; }, /unsafe/i],
  ['missing build review', f => { delete f.build.review; }, /review/i],
  ['review finding contradicts PASS', f => { f.build.review.confirmed_findings = [{ title: 'regression' }]; }, /review/i],
  ['stale build review', f => { f.build.review.head_sha = f.base; }, /review.*SHA/i],
  ['missing security review', f => { delete f.build.security; }, /security/i],
  ['blocking security finding', f => { f.build.security.blocking = [{ title: 'injection' }]; }, /security/i],
  ['missing final review', f => { delete f.verify.final_review; }, /review/i],
  ['incomplete suite', f => { f.build.suite.completed = false; }, /suite.*complete/i],
  ['suite non-test failure', f => { f.build.suite.other_failures = ['lint']; }, /suite/i],
  ['suite missing output', f => fs.unlinkSync(f.build.suite.log_path), /artifact/i],
  ['suite drift', f => { f.build.suite.head_after = f.base; }, /suite.*SHA/i],
  ['dirty reported suite', f => { f.build.suite.status_after = [' M app.js']; }, /suite.*clean/i],
  ['unexplained failed suite', f => { f.build.suite.passed = false; }, /suite/i],
  ['unapproved suite failure', f => { f.build.suite.passed = false; f.build.suite.failures = ['test::new']; }, /known.failures/i],
  ['mismatching baseline IDs', f => { f.build.suite.passed = false; f.build.suite.failures = ['test::new']; f.build.known_failures_seen = ['test::old']; }, /known.failures/i],
  ['failed applicable check', f => { f.verify.results[0].status = 'FAIL'; }, /smoke.*PASS/i],
  ['missing applicable check', f => { f.verify.results = []; }, /missing.*smoke/i],
  ['duplicate check', f => f.verify.results.push(f.verify.results[0]), /duplicate.*smoke/i],
  ['unknown check', f => f.verify.results.push({ ...f.verify.results[0], name: 'surprise' }), /unknown.*surprise/i],
  ['check missing output', f => fs.unlinkSync(f.verify.results[0].evidence_path), /artifact/i],
  ['check stale SHA', f => { f.verify.results[0].head_before = f.base; }, /smoke.*SHA/i],
  ['inapplicable check without reason', f => { f.manifest.checks[1].reason = ''; }, /reason/i],
  ['duplicate inventory ID', f => f.manifest.requirements.push(f.manifest.requirements[0]), /duplicate.*R1/i],
  ['missing requirement inventory', f => { f.manifest.requirements = []; }, /requirements/i],
  ['different feature', f => { f.build.feature_id = 'another'; }, /feature/i],
  ['different original base', f => { f.verify.base_commit = f.head; }, /base/i],
  ['actual dirty tree', f => fs.appendFileSync(path.join(f.repo, 'app.js'), '// dirty\n'), /clean/i],
  ['actual untracked file', f => fs.writeFileSync(path.join(f.repo, 'untracked.txt'), 'dirty'), /clean/i],
  ['artifact symlink into repository', f => { const p = path.join(f.artifacts, 'repo.log'); fs.symlinkSync(path.join(f.repo, 'app.js'), p); f.verify.compliance.requirements[0].evidence[0].log_path = p; }, /outside.*repo/i],
];
for (const [name, mutate, reason] of invalid) {
  test(name + ' blocks completion', t => {
    const f = fixture(t);
    mutate(f);
    f.save();
    blocked(f, f.run(), reason);
  });
}

test('completed exact known-baseline failures are qualified success, not green', t => {
  const f = fixture(t);
  f.build.suite.passed = false;
  f.build.suite.failures = ['suite::known[one,two]'];
  f.build.known_failures_seen = ['suite::known[one,two]'];
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(fs.readFileSync(f.out));
  assert.equal(proof.suite.status, 'KNOWN_BASELINE_FAILURES');
  assert.deepEqual(proof.known_failures_seen, ['suite::known[one,two]']);
});

test('directory-prefix scope permits its files', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'src'));
  git(f.repo, 'mv', 'app.js', 'src/app.js');
  git(f.repo, 'commit', '-qm', 'move');
  // Rename detection is disabled; deletion and addition must both fit the frozen scope.
  f.manifest.allowed_paths = ['app.js', 'src/'];
  const head = git(f.repo, 'rev-parse', 'HEAD');
  f.build.reviewed_sha = head;
  f.build.review.head_sha = head;
  f.build.suite.head_before = head;
  f.build.suite.head_after = head;
  f.verify.reviewed_sha = head;
  f.verify.final_review.head_sha = head;
  for (const report of [f.verify.compliance, ...f.verify.results]) {
    report.head_before = head;
    report.head_after = head;
  }
  for (const trace of f.verify.compliance.requirements) {
    for (const evidence of trace.evidence) {
      evidence.head_sha = head;
      if (evidence.kind === 'static') evidence.file = 'src/app.js';
    }
  }
  f.save();
  const result = f.run({ 'reviewed-sha': head });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.out)).changed_files, ['app.js', 'src/app.js']);
});

test('actual HEAD drift blocks even when all report SHAs agree', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.repo, 'app.js'), '// later change\n');
  git(f.repo, 'add', 'app.js');
  git(f.repo, 'commit', '-qm', 'later commit');
  blocked(f, f.run(), /HEAD.*SHA/i);
});

test('supplied proof commands are data and never executed', t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'must-not-exist');
  const command = 'touch ' + marker;
  f.manifest.requirements[0].proof_command = command;
  f.verify.compliance.requirements[0].evidence[0].command = command;
  f.save();
  assert.equal(f.run().status, 0);
  assert.equal(fs.existsSync(marker), false);
});

test('static requirements may have an empty proof command', t => {
  const f = fixture(t);
  f.manifest.requirements[1].proof_command = '';
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('output cannot overwrite an input artifact', t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.buildPath, 'utf8');
  blocked(f, f.run({ out: f.buildPath }), /overwrite/i);
  assert.equal(fs.readFileSync(f.buildPath, 'utf8'), original);
});

test('manifest exact byte hash drift blocks completion', t => {
  const f = fixture(t);
  fs.appendFileSync(f.manifestPath, ' ');
  blocked(f, f.run(), /manifest.*hash/i);
});

test('verify must carry the pinned manifest hash', t => {
  const f = fixture(t);
  f.verify.manifest_sha256 = '0'.repeat(64);
  writeJson(f.verifyPath, f.verify);
  blocked(f, f.run(), /manifest.*hash/i);
});

test('output inside the repository is refused without mutation', t => {
  const f = fixture(t);
  blocked(f, f.run({ out: path.join(f.repo, 'proof.json') }), /outside.*repo/i);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('nonancestor base is refused', t => {
  const f = fixture(t);
  git(f.repo, 'checkout', '--orphan', 'other-history');
  git(f.repo, 'commit', '-qm', 'unrelated root');
  const other = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'checkout', '--detach', f.head);
  f.build.base_commit = other;
  f.verify.base_commit = other;
  f.save();
  blocked(f, f.run(), /ancestor/i);
});

test('missing argument produces explicit BLOCKED, not an unhandled exception', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [checker, '--repo', f.repo], { encoding: 'utf8' });
  blocked(f, result, /missing/i);
});

test('invalid JSON artifact blocks completion', t => {
  const f = fixture(t);
  fs.writeFileSync(f.buildPath, '{broken');
  blocked(f, f.run(), /JSON/i);
});

for (const source of ['suite', 'check', 'runtime']) {
  test('output cannot overwrite ' + source + ' evidence', t => {
    const f = fixture(t);
    const file = source === 'suite' ? f.build.suite.log_path : source === 'check' ? f.verify.results[0].evidence_path : f.verify.compliance.requirements[0].evidence[0].log_path;
    const original = fs.readFileSync(file, 'utf8');
    blocked(f, f.run({ out: file }), /overwrite|alias/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
}

for (const source of ['suite', 'check', 'runtime']) {
  test('initial completion rejects changed captured ' + source + ' output', t => {
    const f = fixture(t);
    const file = source === 'suite' ? f.build.suite.log_path : source === 'check' ? f.verify.results[0].evidence_path : f.verify.compliance.requirements[0].evidence[0].log_path;
    fs.appendFileSync(file, 'changed after capture\n');
    blocked(f, f.run(), /hash/i);
  });
}

for (const alias of ['symlink', 'hardlink']) {
  test('output ' + alias + ' cannot alias runtime evidence', t => {
    const f = fixture(t);
    const file = f.verify.compliance.requirements[0].evidence[0].log_path;
    fs.mkdirSync(path.dirname(f.out));
    if (alias === 'symlink') fs.symlinkSync(file, f.out);
    else fs.linkSync(file, f.out);
    const original = fs.readFileSync(file, 'utf8');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /overwrite|alias/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readFileSync(f.out, 'utf8'), original);
  });
}

test('static requirement needs static file and line evidence', t => {
  const f = fixture(t);
  f.manifest.requirements[1].proof_command = '';
  f.verify.compliance.requirements[1].evidence = [{ ...f.verify.compliance.requirements[0].evidence[0], command: '' }];
  f.save();
  blocked(f, f.run(), /R2.*static/i);
});

function expectPreviousBlocked(f, mutate, reason) {
  assert.equal(f.run().status, 0);
  const old = fs.readFileSync(f.out, 'utf8');
  mutate();
  const result = f.run({ 'previous-proof': f.out });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, reason);
  assert.equal(fs.readFileSync(f.out, 'utf8'), old, 'failed revalidation must preserve prior proof');
}

for (const source of ['suite', 'check', 'runtime']) {
  test('previous proof rejects changed nonempty ' + source + ' log', t => {
    const f = fixture(t);
    const file = source === 'suite' ? f.build.suite.log_path : source === 'check' ? f.verify.results[0].evidence_path : f.verify.compliance.requirements[0].evidence[0].log_path;
    expectPreviousBlocked(f, () => fs.appendFileSync(file, 'tampered\n'), /previous.proof|hash|changed/i);
  });
}

test('previous proof rejects changed valid static traces', t => {
  const f = fixture(t);
  expectPreviousBlocked(f, () => {
    f.verify.compliance.requirements[1].evidence[0].line = 1;
    f.save();
  }, /previous.proof|hash|changed/i);
});

test('unchanged previous proof revalidates and can replace itself', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const before = JSON.parse(fs.readFileSync(f.out));
  const result = f.run({ 'previous-proof': f.out });
  assert.equal(result.status, 0, result.stderr);
  const after = JSON.parse(fs.readFileSync(f.out));
  delete before.checked_at;
  delete after.checked_at;
  assert.deepEqual(after, before);
});

test('plan mode validates inventory without completion artifacts or output', t => {
  const f = fixture(t);
  fs.unlinkSync(f.buildPath);
  fs.unlinkSync(f.verifyPath);
  const result = spawnSync(process.execPath, [checker, '--mode', 'plan', '--repo', f.repo,
    '--feature-id', 'feature-1', '--reviewed-sha', f.head, '--manifest', f.manifestPath,
    '--manifest-sha256', f.manifestHash, '--spec', f.spec], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).manifest_sha256, f.manifestHash);
  assert.equal(fs.existsSync(f.out), false);
});

test('plan mode rejects invalid frozen inventory', t => {
  const f = fixture(t);
  f.manifest.requirements.push(f.manifest.requirements[0]);
  f.save();
  blocked(f, f.run({ mode: 'plan' }), /duplicate.*R1/i);
});

test('frozen state-only commits after review are qualified completion', t => {
  const f = fixture(t);
  f.manifest.state_paths = ['state'];
  f.save();
  fs.mkdirSync(path.join(f.repo, 'state'));
  fs.writeFileSync(path.join(f.repo, 'state', 'run.json'), '{}');
  git(f.repo, 'add', 'state/run.json');
  git(f.repo, 'commit', '-qm', 'state only');
  const actual = git(f.repo, 'rev-parse', 'HEAD');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(fs.readFileSync(f.out));
  assert.equal(proof.actual_head, actual);
  assert.deepEqual(proof.state_only_qualification.changed_paths, ['state/run.json']);
  assert.deepEqual(proof.changed_files, ['app.js']);
});

test('state-only compatibility never excuses non-state commits that cancel out', t => {
  const f = fixture(t);
  f.manifest.state_paths = ['state/'];
  f.save();
  fs.writeFileSync(path.join(f.repo, 'temporary.js'), 'unreviewed');
  git(f.repo, 'add', 'temporary.js');
  git(f.repo, 'commit', '-qm', 'add unreviewed code');
  fs.unlinkSync(path.join(f.repo, 'temporary.js'));
  git(f.repo, 'add', 'temporary.js');
  git(f.repo, 'commit', '-qm', 'remove unreviewed code');
  blocked(f, f.run(), /state.only|unreviewed/i);
});

test('frozen clean_ignore tolerates state dirt but not source dirt', t => {
  const f = fixture(t);
  f.manifest.clean_ignore = ['state/'];
  f.build.suite.status_before = ['?? state/run.json'];
  f.build.suite.status_after = ['?? state/run.json'];
  f.save();
  fs.mkdirSync(path.join(f.repo, 'state'));
  fs.writeFileSync(path.join(f.repo, 'state', 'run.json'), '{}');
  const success = f.run();
  assert.equal(success.status, 0, success.stderr);
  fs.unlinkSync(f.out);
  fs.appendFileSync(path.join(f.repo, 'app.js'), '// unreviewed');
  blocked(f, f.run(), /clean/i);
});

test('unsafe frozen clean_ignore is refused', t => {
  const f = fixture(t);
  f.manifest.clean_ignore = ['../'];
  f.save();
  blocked(f, f.run(), /unsafe/i);
});

for (const source of ['suite', 'check', 'runtime']) {
  test('missing captured hash for ' + source + ' output is refused', t => {
    const f = fixture(t);
    if (source === 'suite') delete f.build.suite.log_sha256;
    else if (source === 'check') delete f.verify.results[0].evidence_sha256;
    else delete f.verify.compliance.requirements[0].evidence[0].log_sha256;
    f.save();
    blocked(f, f.run(), /hash/i);
  });
}

test('previous proof permits later frozen state-only commits without recertifying code', t => {
  const f = fixture(t);
  f.manifest.state_paths = ['state/'];
  f.save();
  assert.equal(f.run().status, 0);
  fs.mkdirSync(path.join(f.repo, 'state'));
  fs.writeFileSync(path.join(f.repo, 'state', 'run.json'), '{}');
  git(f.repo, 'add', 'state/run.json');
  git(f.repo, 'commit', '-qm', 'record stage');
  const result = f.run({ 'previous-proof': f.out });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.out)).reviewed_sha, f.head);
});

test('state-only qualification examines every merge parent', t => {
  const f = fixture(t);
  f.manifest.state_paths = ['state/'];
  f.save();
  git(f.repo, 'checkout', '-b', 'state-left', f.head);
  fs.mkdirSync(path.join(f.repo, 'state'));
  fs.writeFileSync(path.join(f.repo, 'state', 'left'), 'left');
  git(f.repo, 'add', 'state/left');
  git(f.repo, 'commit', '-qm', 'left state');
  git(f.repo, 'checkout', '-b', 'state-right', f.head);
  fs.mkdirSync(path.join(f.repo, 'state'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'state', 'right'), 'right');
  git(f.repo, 'add', 'state/right');
  git(f.repo, 'commit', '-qm', 'right state');
  git(f.repo, 'merge', '--no-ff', '-m', 'merge state', 'state-left');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.out)).state_only_qualification.changed_paths, ['state/left', 'state/right']);
});

for (const operation of ['committed', 'dirty']) {
  test('protected paths override ' + operation + ' state exemptions', t => {
    const f = fixture(t);
    f.manifest.state_paths = ['state/'];
    f.manifest.clean_ignore = ['state/'];
    f.manifest.protected_paths.push('state/secret.json');
    f.save();
    fs.mkdirSync(path.join(f.repo, 'state'));
    fs.writeFileSync(path.join(f.repo, 'state', 'secret.json'), '{}');
    if (operation === 'committed') {
      git(f.repo, 'add', 'state/secret.json');
      git(f.repo, 'commit', '-qm', 'protected change');
    }
    blocked(f, f.run(), /protected/i);
  });
}

test('stdout and proof expose only frozen state exemptions', t => {
  const f = fixture(t);
  f.manifest.state_paths = ['state/'];
  f.manifest.clean_ignore = ['state/temp/'];
  f.save();
  for (const mode of ['plan', 'completion']) {
    const result = f.run({ mode });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.state_paths, ['state/']);
    assert.deepEqual(observed.clean_ignore, ['state/temp/']);
  }
  const proof = JSON.parse(fs.readFileSync(f.out));
  assert.deepEqual(proof.state_paths, ['state/']);
  assert.deepEqual(proof.clean_ignore, ['state/temp/']);
});

for (const [field, exempt, protectedPath] of [
  ['state_paths', 'state/', 'state/private.json'],
  ['state_paths', 'state/runs/', 'state/'],
  ['clean_ignore', 'protected.js', 'protected.js'],
  ['clean_ignore', 'state/runs/', 'state/'],
]) {
  test('plan rejects declared ' + field + ' overlap: ' + exempt + ' and ' + protectedPath, t => {
    const f = fixture(t);
    f.manifest[field] = [exempt];
    f.manifest.protected_paths.push(protectedPath);
    f.manifest.protected_paths = [...new Set(f.manifest.protected_paths)];
    f.save();
    blocked(f, f.run({ mode: 'plan' }), /protected.*overlap|overlap.*protected/i);
  });
}
