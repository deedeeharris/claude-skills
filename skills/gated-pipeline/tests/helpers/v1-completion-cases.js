'use strict';

// v1 completion differential cases (plan WP3). `fixture(root)` is a STATED COPY of check-completion.test.js's
// fixture() at c186e5f with exactly these changes, so that two runs from one snapshot are byte-comparable:
//   1. it builds inside a caller-given root instead of a mkdtemp dir registered with t.after;
//   2. git runs with a sanitized environment (no inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE), a fixed
//      author/committer date and no commit signing, so every commit SHA is reproducible;
//   3. f.argv(overrides) returns the CLI arguments instead of f.run() spawning the checker, so the same case
//      can run against two scripts;
//   4. the synthetic commit identity has an empty email address.
// `CASES` is a named list: one case per test of check-completion.test.js that runs the CLI, each mapped to its
// original test name (`original`), plus extra mutated variants (`original: null`). A case is
// steps(f, exec): exec(overrides | { argv }) runs the script under test; every other statement mutates the
// fixture exactly as the original test does. tests/check-completion-v2.test.js runs every case from one
// snapshot against `git show c186e5f:skills/gated-pipeline/scripts/check-completion.js` and against the
// current script and compares stdout (minus proof_sha256), stderr, exit codes and the proof file (minus
// checked_at) byte for byte.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('./v2-repo.js');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const ENV = cleanEnv();
function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(root) {
  const repo = path.join(root, 'repo');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(repo);
  fs.mkdirSync(artifacts);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Gate Test');
  git(repo, 'config', 'user.email', '');
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
  const f = { root, repo, artifacts, head, base, spec, manifestPath, buildPath, verifyPath, out, manifest, build, verify, log, git };
  f.save = () => {
    writeJson(manifestPath, manifest);
    f.manifestHash = sha256(fs.readFileSync(manifestPath));
    verify.manifest_sha256 = f.manifestHash;
    writeJson(buildPath, build);
    writeJson(verifyPath, verify);
  };
  f.argv = (overrides = {}) => {
    const flags = {
      repo, 'feature-id': 'feature-1', 'reviewed-sha': head,
      manifest: manifestPath, 'manifest-sha256': f.manifestHash, spec,
      'build-result': buildPath, 'verify-result': verifyPath, out, ...overrides,
    };
    return Object.entries(flags).flatMap(([k, v]) => ['--' + k, v]);
  };
  f.save();
  return f;
}

const INVALID = [
  ['missing requirement', f => f.verify.compliance.requirements.pop()],
  ['duplicate requirement', f => f.verify.compliance.requirements.push(f.verify.compliance.requirements[0])],
  ['unknown requirement', f => f.verify.compliance.requirements.push({ id: 'EXTRA', status: 'PASS', evidence: [] })],
  ['requirement NOT_RUN', f => { f.verify.compliance.requirements[0].status = 'NOT_RUN'; }],
  ['requirement FAIL', f => { f.verify.compliance.requirements[0].status = 'FAIL'; }],
  ['runtime requirement cannot use static evidence alone', f => { f.verify.compliance.requirements[0].evidence = [f.verify.compliance.requirements[1].evidence[0]]; }],
  ['stale evidence SHA', f => { f.verify.compliance.requirements[0].evidence[0].head_sha = f.base; }],
  ['different proof command', f => { f.verify.compliance.requirements[0].evidence[0].command = 'echo PASS'; }],
  ['runtime nonzero exit', f => { f.verify.compliance.requirements[0].evidence[0].exit_code = 1; }],
  ['empty runtime log', f => fs.writeFileSync(f.verify.compliance.requirements[0].evidence[0].log_path, '')],
  ['missing runtime log', f => fs.unlinkSync(f.verify.compliance.requirements[0].evidence[0].log_path)],
  ['static line beyond file', f => { f.verify.compliance.requirements[1].evidence[0].line = 99; }],
  ['static missing file', f => { f.verify.compliance.requirements[1].evidence[0].file = 'absent.js'; }],
  ['static unsafe path', f => { f.verify.compliance.requirements[1].evidence[0].file = '../app.js'; }],
  ['spec drift', f => fs.appendFileSync(f.spec, 'unapproved change\n')],
  ['scope outside allowed paths', f => { f.manifest.allowed_paths = ['other.js']; }],
  ['protected changed file', f => { f.manifest.protected_paths = ['app.js']; }],
  ['unsafe allowed path', f => { f.manifest.allowed_paths = ['../']; }],
  ['unsafe protected path', f => { f.manifest.protected_paths = ['/app.js']; }],
  ['missing build review', f => { delete f.build.review; }],
  ['review finding contradicts PASS', f => { f.build.review.confirmed_findings = [{ title: 'regression' }]; }],
  ['stale build review', f => { f.build.review.head_sha = f.base; }],
  ['missing security review', f => { delete f.build.security; }],
  ['blocking security finding', f => { f.build.security.blocking = [{ title: 'injection' }]; }],
  ['missing final review', f => { delete f.verify.final_review; }],
  ['incomplete suite', f => { f.build.suite.completed = false; }],
  ['suite non-test failure', f => { f.build.suite.other_failures = ['lint']; }],
  ['suite missing output', f => fs.unlinkSync(f.build.suite.log_path)],
  ['suite drift', f => { f.build.suite.head_after = f.base; }],
  ['dirty reported suite', f => { f.build.suite.status_after = [' M app.js']; }],
  ['unexplained failed suite', f => { f.build.suite.passed = false; }],
  ['unapproved suite failure', f => { f.build.suite.passed = false; f.build.suite.failures = ['test::new']; }],
  ['mismatching baseline IDs', f => { f.build.suite.passed = false; f.build.suite.failures = ['test::new']; f.build.known_failures_seen = ['test::old']; }],
  ['failed applicable check', f => { f.verify.results[0].status = 'FAIL'; }],
  ['missing applicable check', f => { f.verify.results = []; }],
  ['duplicate check', f => f.verify.results.push(f.verify.results[0])],
  ['unknown check', f => f.verify.results.push({ ...f.verify.results[0], name: 'surprise' })],
  ['check missing output', f => fs.unlinkSync(f.verify.results[0].evidence_path)],
  ['check stale SHA', f => { f.verify.results[0].head_before = f.base; }],
  ['inapplicable check without reason', f => { f.manifest.checks[1].reason = ''; }],
  ['duplicate inventory ID', f => f.manifest.requirements.push(f.manifest.requirements[0])],
  ['missing requirement inventory', f => { f.manifest.requirements = []; }],
  ['different feature', f => { f.build.feature_id = 'another'; }],
  ['different original base', f => { f.verify.base_commit = f.head; }],
  ['actual dirty tree', f => fs.appendFileSync(path.join(f.repo, 'app.js'), '// dirty\n')],
  ['actual untracked file', f => fs.writeFileSync(path.join(f.repo, 'untracked.txt'), 'dirty')],
  ['artifact symlink into repository', f => { const p = path.join(f.artifacts, 'repo.log'); fs.symlinkSync(path.join(f.repo, 'app.js'), p); f.verify.compliance.requirements[0].evidence[0].log_path = p; }],
];
const SOURCES = ['suite', 'check', 'runtime'];
const evidenceFile = (f, source) => source === 'suite' ? f.build.suite.log_path : source === 'check' ? f.verify.results[0].evidence_path : f.verify.compliance.requirements[0].evidence[0].log_path;

const CASES = [
  { name: 'valid', original: 'valid real repository produces proof using authoritative git files and hashed artifacts', steps: (f, exec) => exec() },
  ...INVALID.map(([name, mutate]) => ({ name, original: name + ' blocks completion', steps: (f, exec) => { mutate(f); f.save(); exec(); } })),
  { name: 'known-baseline failures', original: 'completed exact known-baseline failures are qualified success, not green', steps: (f, exec) => {
    f.build.suite.passed = false; f.build.suite.failures = ['suite::known[one,two]']; f.build.known_failures_seen = ['suite::known[one,two]']; f.save(); exec();
  } },
  { name: 'directory-prefix scope', original: 'directory-prefix scope permits its files', steps: (f, exec) => {
    fs.mkdirSync(path.join(f.repo, 'src'));
    f.git(f.repo, 'mv', 'app.js', 'src/app.js');
    f.git(f.repo, 'commit', '-qm', 'move');
    f.manifest.allowed_paths = ['app.js', 'src/'];
    const head = f.git(f.repo, 'rev-parse', 'HEAD');
    f.build.reviewed_sha = head; f.build.review.head_sha = head; f.build.suite.head_before = head; f.build.suite.head_after = head;
    f.verify.reviewed_sha = head; f.verify.final_review.head_sha = head;
    for (const report of [f.verify.compliance, ...f.verify.results]) { report.head_before = head; report.head_after = head; }
    for (const trace of f.verify.compliance.requirements) for (const evidence of trace.evidence) { evidence.head_sha = head; if (evidence.kind === 'static') evidence.file = 'src/app.js'; }
    f.save();
    exec({ 'reviewed-sha': head });
  } },
  { name: 'HEAD drift', original: 'actual HEAD drift blocks even when all report SHAs agree', steps: (f, exec) => {
    fs.appendFileSync(path.join(f.repo, 'app.js'), '// later change\n'); f.git(f.repo, 'add', 'app.js'); f.git(f.repo, 'commit', '-qm', 'later commit'); exec();
  } },
  { name: 'proof commands are data', original: 'supplied proof commands are data and never executed', steps: (f, exec) => {
    const command = 'touch ' + path.join(f.root, 'must-not-exist');
    f.manifest.requirements[0].proof_command = command; f.verify.compliance.requirements[0].evidence[0].command = command; f.save(); exec();
    assert.equal(fs.existsSync(path.join(f.root, 'must-not-exist')), false);
  } },
  { name: 'empty static proof command', original: 'static requirements may have an empty proof command', steps: (f, exec) => { f.manifest.requirements[1].proof_command = ''; f.save(); exec(); } },
  { name: 'output over an input', original: 'output cannot overwrite an input artifact', steps: (f, exec) => exec({ out: f.buildPath }) },
  { name: 'manifest byte drift', original: 'manifest exact byte hash drift blocks completion', steps: (f, exec) => { fs.appendFileSync(f.manifestPath, ' '); exec(); } },
  { name: 'verify manifest hash', original: 'verify must carry the pinned manifest hash', steps: (f, exec) => { f.verify.manifest_sha256 = '0'.repeat(64); writeJson(f.verifyPath, f.verify); exec(); } },
  { name: 'output inside repo', original: 'output inside the repository is refused without mutation', steps: (f, exec) => exec({ out: path.join(f.repo, 'proof.json') }) },
  { name: 'nonancestor base', original: 'nonancestor base is refused', steps: (f, exec) => {
    f.git(f.repo, 'checkout', '--orphan', 'other-history'); f.git(f.repo, 'commit', '-qm', 'unrelated root');
    const other = f.git(f.repo, 'rev-parse', 'HEAD'); f.git(f.repo, 'checkout', '--detach', f.head);
    f.build.base_commit = other; f.verify.base_commit = other; f.save(); exec();
  } },
  { name: 'missing argument', original: 'missing argument produces explicit BLOCKED, not an unhandled exception', steps: (f, exec) => exec({ argv: ['--repo', f.repo] }) },
  { name: 'invalid JSON artifact', original: 'invalid JSON artifact blocks completion', steps: (f, exec) => { fs.writeFileSync(f.buildPath, '{broken'); exec(); } },
  ...SOURCES.map(source => ({ name: 'output over ' + source + ' evidence', original: 'output cannot overwrite ' + source + ' evidence', steps: (f, exec) => exec({ out: evidenceFile(f, source) }) })),
  ...SOURCES.map(source => ({ name: 'changed captured ' + source, original: 'initial completion rejects changed captured ' + source + ' output', steps: (f, exec) => { fs.appendFileSync(evidenceFile(f, source), 'changed after capture\n'); exec(); } })),
  ...['symlink', 'hardlink'].map(alias => ({ name: 'output ' + alias, original: 'output ' + alias + ' cannot alias runtime evidence', steps: (f, exec) => {
    const file = f.verify.compliance.requirements[0].evidence[0].log_path;
    fs.mkdirSync(path.dirname(f.out));
    if (alias === 'symlink') fs.symlinkSync(file, f.out); else fs.linkSync(file, f.out);
    exec();
  } })),
  { name: 'static needs file and line', original: 'static requirement needs static file and line evidence', steps: (f, exec) => {
    f.manifest.requirements[1].proof_command = ''; f.verify.compliance.requirements[1].evidence = [{ ...f.verify.compliance.requirements[0].evidence[0], command: '' }]; f.save(); exec();
  } },
  ...SOURCES.map(source => ({ name: 'previous proof, changed ' + source, original: 'previous proof rejects changed nonempty ' + source + ' log', steps: (f, exec) => {
    exec(); fs.appendFileSync(evidenceFile(f, source), 'tampered\n'); exec({ 'previous-proof': f.out });
  } })),
  { name: 'previous proof, static trace', original: 'previous proof rejects changed valid static traces', steps: (f, exec) => {
    exec(); f.verify.compliance.requirements[1].evidence[0].line = 1; f.save(); exec({ 'previous-proof': f.out });
  } },
  { name: 'previous proof revalidates', original: 'unchanged previous proof revalidates and can replace itself', steps: (f, exec) => { exec(); exec({ 'previous-proof': f.out }); } },
  { name: 'plan mode', original: 'plan mode validates inventory without completion artifacts or output', steps: (f, exec) => {
    fs.unlinkSync(f.buildPath); fs.unlinkSync(f.verifyPath);
    exec({ argv: ['--mode', 'plan', '--repo', f.repo, '--feature-id', 'feature-1', '--reviewed-sha', f.head, '--manifest', f.manifestPath, '--manifest-sha256', f.manifestHash, '--spec', f.spec] });
  } },
  { name: 'plan invalid inventory', original: 'plan mode rejects invalid frozen inventory', steps: (f, exec) => { f.manifest.requirements.push(f.manifest.requirements[0]); f.save(); exec({ mode: 'plan' }); } },
  { name: 'state-only commits', original: 'frozen state-only commits after review are qualified completion', steps: (f, exec) => {
    f.manifest.state_paths = ['state']; f.save();
    fs.mkdirSync(path.join(f.repo, 'state')); fs.writeFileSync(path.join(f.repo, 'state', 'run.json'), '{}');
    f.git(f.repo, 'add', 'state/run.json'); f.git(f.repo, 'commit', '-qm', 'state only'); exec();
  } },
  { name: 'state-only cancel out', original: 'state-only compatibility never excuses non-state commits that cancel out', steps: (f, exec) => {
    f.manifest.state_paths = ['state/']; f.save();
    fs.writeFileSync(path.join(f.repo, 'temporary.js'), 'unreviewed'); f.git(f.repo, 'add', 'temporary.js'); f.git(f.repo, 'commit', '-qm', 'add unreviewed code');
    fs.unlinkSync(path.join(f.repo, 'temporary.js')); f.git(f.repo, 'add', 'temporary.js'); f.git(f.repo, 'commit', '-qm', 'remove unreviewed code'); exec();
  } },
  { name: 'clean_ignore state dirt', original: 'frozen clean_ignore tolerates state dirt but not source dirt', steps: (f, exec) => {
    f.manifest.clean_ignore = ['state/']; f.build.suite.status_before = ['?? state/run.json']; f.build.suite.status_after = ['?? state/run.json']; f.save();
    fs.mkdirSync(path.join(f.repo, 'state')); fs.writeFileSync(path.join(f.repo, 'state', 'run.json'), '{}');
    exec(); fs.unlinkSync(f.out); fs.appendFileSync(path.join(f.repo, 'app.js'), '// unreviewed'); exec();
  } },
  { name: 'unsafe clean_ignore', original: 'unsafe frozen clean_ignore is refused', steps: (f, exec) => { f.manifest.clean_ignore = ['../']; f.save(); exec(); } },
  ...SOURCES.map(source => ({ name: 'missing captured hash ' + source, original: 'missing captured hash for ' + source + ' output is refused', steps: (f, exec) => {
    if (source === 'suite') delete f.build.suite.log_sha256; else if (source === 'check') delete f.verify.results[0].evidence_sha256; else delete f.verify.compliance.requirements[0].evidence[0].log_sha256;
    f.save(); exec();
  } })),
  { name: 'previous proof, later state commits', original: 'previous proof permits later frozen state-only commits without recertifying code', steps: (f, exec) => {
    f.manifest.state_paths = ['state/']; f.save(); exec();
    fs.mkdirSync(path.join(f.repo, 'state')); fs.writeFileSync(path.join(f.repo, 'state', 'run.json'), '{}');
    f.git(f.repo, 'add', 'state/run.json'); f.git(f.repo, 'commit', '-qm', 'record stage'); exec({ 'previous-proof': f.out });
  } },
  { name: 'merge parents', original: 'state-only qualification examines every merge parent', steps: (f, exec) => {
    f.manifest.state_paths = ['state/']; f.save();
    f.git(f.repo, 'checkout', '-b', 'state-left', f.head); fs.mkdirSync(path.join(f.repo, 'state')); fs.writeFileSync(path.join(f.repo, 'state', 'left'), 'left');
    f.git(f.repo, 'add', 'state/left'); f.git(f.repo, 'commit', '-qm', 'left state');
    f.git(f.repo, 'checkout', '-b', 'state-right', f.head); fs.mkdirSync(path.join(f.repo, 'state'), { recursive: true }); fs.writeFileSync(path.join(f.repo, 'state', 'right'), 'right');
    f.git(f.repo, 'add', 'state/right'); f.git(f.repo, 'commit', '-qm', 'right state'); f.git(f.repo, 'merge', '--no-ff', '-m', 'merge state', 'state-left'); exec();
  } },
  ...['committed', 'dirty'].map(operation => ({ name: 'protected over ' + operation + ' state', original: 'protected paths override ' + operation + ' state exemptions', steps: (f, exec) => {
    f.manifest.state_paths = ['state/']; f.manifest.clean_ignore = ['state/']; f.manifest.protected_paths.push('state/secret.json'); f.save();
    fs.mkdirSync(path.join(f.repo, 'state')); fs.writeFileSync(path.join(f.repo, 'state', 'secret.json'), '{}');
    if (operation === 'committed') { f.git(f.repo, 'add', 'state/secret.json'); f.git(f.repo, 'commit', '-qm', 'protected change'); }
    exec();
  } })),
  { name: 'stdout state exemptions', original: 'stdout and proof expose only frozen state exemptions', steps: (f, exec) => {
    f.manifest.state_paths = ['state/']; f.manifest.clean_ignore = ['state/temp/']; f.save(); exec({ mode: 'plan' }); exec({ mode: 'completion' });
  } },
  ...[['state_paths', 'state/', 'state/private.json'], ['state_paths', 'state/runs/', 'state/'], ['clean_ignore', 'protected.js', 'protected.js'], ['clean_ignore', 'state/runs/', 'state/']].map(([field, exempt, protectedPath]) => ({
    name: 'plan overlap ' + field + ' ' + exempt + ' ' + protectedPath, original: 'plan rejects declared ' + field + ' overlap: ' + exempt + ' and ' + protectedPath, steps: (f, exec) => {
      f.manifest[field] = [exempt]; f.manifest.protected_paths.push(protectedPath); f.manifest.protected_paths = [...new Set(f.manifest.protected_paths)]; f.save(); exec({ mode: 'plan' });
    } })),
  // extra mutated variants (no original test)
  { name: 'extra: unknown argument', original: null, steps: (f, exec) => exec({ argv: [...f.argv(), '--bogus', 'x'] }) },
  { name: 'extra: duplicate argument', original: null, steps: (f, exec) => exec({ argv: [...f.argv(), '--repo', f.repo] }) },
  { name: 'extra: unknown mode', original: null, steps: (f, exec) => exec({ mode: 'audit' }) },
  { name: 'extra: build stamped build_mode v1', original: null, steps: (f, exec) => { f.build.build_mode = 'v1'; f.save(); exec(); } },
  { name: 'extra: version 2 manifest under v1 args', original: null, steps: (f, exec) => { f.manifest.version = 2; f.save(); exec(); exec({ mode: 'plan' }); } },
  { name: 'extra: short reviewed sha', original: null, steps: (f, exec) => exec({ 'reviewed-sha': f.head.slice(0, 12) }) },
  { name: 'extra: known baseline then previous proof', original: null, steps: (f, exec) => {
    f.build.suite.passed = false; f.build.suite.failures = ['a::b']; f.build.known_failures_seen = ['a::b']; f.save(); exec(); exec({ 'previous-proof': f.out });
  } },
];

module.exports = { fixture, CASES };
