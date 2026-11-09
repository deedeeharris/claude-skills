'use strict';

// Real-repo fixtures for the contract-2 scripts (tests/check-completion-v2.test.js, tests/run-frozen.test.js).
// Everything runs in a temp dir made at runtime: a git repo with a base commit, a run dir outside it, the real
// scripts (hash-inputs, feature-snapshot, write-json, compile-feature, check-completion, run-frozen) and, for
// model steps only, hand-written review files (a codex-review result.json, an Opus fallback reply): those are the
// mocked parts, labelled as such. Git runs with a sanitized environment (no inherited GIT_DIR/GIT_WORK_TREE/
// GIT_INDEX_FILE), a fixed commit date, a synthetic identity and no commit signing, so it can never touch the
// checkout the tests live in.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.resolve(__dirname, '../../scripts');
const FALLBACK_REVIEWER = 'claude-opus-high (codex unavailable)';
const REPO_PATH = '.pipeline/features/greet.feature.json';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));

function cleanEnv(extra = {}) {
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', ...extra };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

function baseFeature() {
  return {
    schema_version: 2,
    feature_id: 'greet',
    title: 'Greeting function',
    source_request: { text: 'Make hello() return the text hello.' },
    coverage: [{ id: 'SRC-001', excerpt: 'hello() returns hello', disposition: 'covered', requirement_ids: ['HELLO-001'] }],
    product: {
      problem: 'The greeting is wrong.', actors: ['caller'],
      goals: [{ id: 'GOAL-001', statement: 'A caller gets the greeting hello.', source_ids: ['SRC-001'], status: 'active' }],
      non_goals: [], constraints: [], risks: [], success_metrics: ['hello() returns hello'],
    },
    architecture: {
      approach: 'Change the one function.', decisions: [], invariants: [],
      components: [{ id: 'COMP-LIB', name: 'Library', description: 'The greeting code.', owned_paths: ['src/'], exclusive: true, status: 'active' }],
      security: { data_exposure: 'None.', input_validation: 'No input.', resource_consumption: 'Constant.', accepted_risks: [] },
    },
    requirements: [{
      id: 'HELLO-001', status: 'active', goal_ids: ['GOAL-001'], statement: 'hello() returns the string hello.', priority: 'P1',
      depends_on: [], component_ids: ['COMP-LIB'],
      acceptance: [
        { id: 'HELLO-001-AC1', status: 'active', given: 'the library', when: 'hello() is called', then: 'it returns hello',
          verification: { kind: 'runtime', live: false, command: 'node test/hello.test.js', expected: { exit_code: 0 } },
          negative_control: { method: 'isolated_mutation', description: 'Break the greeting.', mutation: 'Make hello() return goodbye.' } },
        { id: 'HELLO-001-AC2', status: 'active', given: 'the library', when: 'the live probe runs', then: 'it answers',
          verification: { kind: 'runtime', live: true, check_id: 'CHECK-LIVE', command: 'node test/live.test.js', expected: { exit_code: 0 } },
          negative_control: { method: 'exempt', description: 'A live probe.', exemption_reason: 'Live calls are never mutated.' } },
        { id: 'HELLO-001-AC3', status: 'active', given: 'the source', when: 'it is read', then: 'hello is a constant',
          verification: { kind: 'static', evidence: { paths: ['src/'], description: 'The function body.' } },
          negative_control: { method: 'exempt', description: 'Static evidence.', exemption_reason: 'Static evidence has no run to break.' } },
      ],
    }],
    scope: { allowed_paths: ['src/', 'test/'], protected_paths: [], state_paths: [], clean_ignore: [], test_paths: ['test/'] },
    suite: { command: 'node test/hello.test.js', unit_command: 'node test/hello.test.js', known_failures: [], isolated: false, setup_command: null, timeout_min: 2, live_budget_min: 1 },
    limits: { proof_timeout_s: 30, negative_controls_total_min: 5 },
    checks: [
      { id: 'CHECK-LINT', name: 'Lint', applicable: true, reason: 'A quick syntax check.', command: 'node --check src/hello.js', expected: { exit_code: 0 }, timeout_min: 2, budget_min: 0, quiet: false, effort: 'low', environment: 'local shell' },
      { id: 'CHECK-LIVE', name: 'Live probe', applicable: true, reason: 'The live probe.', command: 'node test/live.test.js', expected: { exit_code: 0 }, timeout_min: 2, budget_min: 1, quiet: true, effort: 'low', environment: 'local shell' },
      { id: 'CHECK-UI', name: 'Visual', applicable: false, reason: 'No user interface.', budget_min: 0, quiet: false, effort: 'low', environment: 'none' },
    ],
    test_plan: 'One focused test.',
  };
}
const featureBytes = f => Buffer.from(JSON.stringify(f, null, 2) + '\n', 'utf8');

const PIPELINE_YAML = '# synthetic pipeline config\ntests:\n  known_failures: []\n  clean_ignore: []\nstate:\n  paths: []\n';
const BASE_FILES = {
  'src/hello.js': "module.exports = () => 'hi';\n",
  'README.md': 'Synthetic repo.\n',
};
const IMPL_FILES = {
  'src/hello.js': "module.exports = () => 'hello';\n",
  'test/hello.test.js': "const assert = require('assert');\nassert.equal(require('../src/hello.js')(), 'hello');\nconsole.log('hello test ok');\n",
  'test/live.test.js': "console.log('live probe ok');\n",
};

function makeRepo(t, opts = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-v2-')));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const run = path.join(root, 'run');
  fs.mkdirSync(repo);
  fs.mkdirSync(run);
  const env = cleanEnv(opts.env);
  const c = { root, repo, run, env, repoPath: REPO_PATH, records: [], ledgers: [], previous_design: null };
  c.featureFile = path.join(repo, REPO_PATH);
  c.exec = (cmd, args, o = {}) => spawnSync(cmd, args, { cwd: o.cwd || repo, env: o.env || env, encoding: o.encoding === null ? null : 'utf8', input: o.input, maxBuffer: 64 * 1024 * 1024 });
  c.git = (...args) => {
    const r = c.exec('git', args);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  c.sh = (script, o = {}) => c.exec('bash', ['-c', script], o);
  c.node = (script, args, o = {}) => {
    const r = c.exec(process.execPath, [path.join(SCRIPTS, script), ...args], o);
    r.json = () => JSON.parse(r.stdout);
    return r;
  };
  c.write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content); };
  c.git('init', '-q', '-b', 'main');
  c.git('config', 'user.name', 'alice');
  c.git('config', 'user.email', '');
  c.git('config', 'commit.gpgsign', 'false');
  c.git('config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries({ ...BASE_FILES, ...(opts.baseFiles || {}) })) c.write(rel, content);
  c.write('.claude/pipeline.yaml', opts.pipelineYaml !== undefined ? opts.pipelineYaml : PIPELINE_YAML);
  c.git('add', '-A');
  c.git('commit', '-qm', 'base');
  c.git('checkout', '-q', '-b', 'feature/greet');
  if (opts.beforeDesign) opts.beforeDesign(c);
  c.startHead = c.git('rev-parse', 'HEAD');
  // design inputs
  c.request = path.join(run, 'source-request.txt');
  fs.writeFileSync(c.request, (opts.requestText || 'Make hello() return the text hello.') + '\n');
  const pinned = c.node('hash-inputs.js', ['--out', path.join(run, 'source-request.inputs.json'), c.request]);
  assert.equal(pinned.status, 0, pinned.stderr);
  c.requestSha = pinned.json().inputs[0].sha256;
  c.feature = opts.feature || baseFeature();
  c.writeFeature = (f = c.feature) => { c.write(REPO_PATH, Buffer.isBuffer(f) ? f : featureBytes(f)); };
  c.writeFeature();

  // rev-k snapshot of the working file (feature-snapshot.js).
  c.revDir = k => path.join(run, `rev-${k}`);
  c.snapshot = (k, o = {}) => {
    const args = ['--repo', repo, '--from', c.featureFile, '--repo-path', REPO_PATH, '--rev-dir', c.revDir(k), '--source-request', c.request, '--source-mode', 'text'];
    const prev = o.previous !== undefined ? o.previous : (k > 1 || fs.existsSync(c.revDir(0)) ? path.join(c.revDir(k - 1), 'feature.json') : null);
    if (prev) args.push('--previous', prev);
    const r = c.node('feature-snapshot.js', args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.json();
  };
  // rev-0 = a predecessor design blob (bytes).
  c.rev0 = bytes => { fs.mkdirSync(c.revDir(0)); fs.writeFileSync(path.join(c.revDir(0), 'feature.json'), bytes); };

  // One review of a gate on a rev: hand-written review files (mocked model step), script-hashed inputs.
  let reviewCount = 0;
  c.gateInputs = (gate, rev) => {
    const out = path.join(c.revDir(rev), 'out');
    return gate === 'prd'
      ? [{ role: 'files', path: path.join(out, 'prd.view.md') }, { role: 'against', path: c.request }]
      : [{ role: 'files', path: path.join(out, 'spec.view.md') }, { role: 'files', path: path.join(out, 'execution-plan.json') }, { role: 'against', path: path.join(out, 'prd.view.md') }];
  };
  c.review = (gate, rev, o = {}) => {
    const n = ++reviewCount;
    const reviewDir = path.join(run, 'reviews', `${gate}-${n}`);
    fs.mkdirSync(reviewDir, { recursive: true });
    const snap = c.snapshots[rev];
    const inputs = (o.inputs || c.gateInputs(gate, rev));
    const findings = o.findings || [];
    const record = { gate, round: o.round || n, rev, rev_dir: c.revDir(rev), verdict: o.verdict || 'PASS', reviewer: 'codex', review_dir: reviewDir,
      source_sha256: snap.source_sha256, prd_projection_sha256: snap.prd_projection_sha256, spec_view_sha256: snap.spec_view_sha256,
      manifest_sha256: snap.manifest_sha256, source_request_sha256: c.requestSha, schema_version: 2, compiler_version: '1.0.0' };
    if ((o.reviewer || 'codex') === 'codex') {
      const runDir = path.join(reviewDir, `${o.kind || gate}-20260101T000000000Z-1`);
      fs.mkdirSync(runDir);
      const result = { run_id: path.basename(runDir), kind: o.kind || gate, model: 'synthetic', effort: 'high', catalog_status: 'ok',
        scope: { mode: 'files', repo, files: inputs.filter(i => i.role === 'files').map(i => i.path), against: (inputs.find(i => i.role === 'against') || {}).path || null },
        outcome: 'ok', verdict: o.runnerVerdict || 'PASS', verdict_reasons: [], model_verdict: o.model_verdict || 'PASS', summary: 'synthetic', unable_to_review: null,
        review: null, validation: null, findings, counts: {},
        inputs: inputs.map(i => ({ role: i.role, path: i.path, sha256: sha256(fs.readFileSync(i.path)) })), ...(o.result || {}) };
      fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
      record.result_path = path.join(runDir, 'result.json');
    } else {
      record.reviewer = FALLBACK_REVIEWER;
      const inputsPath = path.join(reviewDir, 'inputs.json');
      const h = c.node('hash-inputs.js', ['--out', inputsPath, ...inputs.flatMap(i => [i.role === 'files' ? '--files' : '--against', i.path])]);
      assert.equal(h.status, 0, h.stderr);
      const fb = c.writeJson(path.join(reviewDir, 'fallback-review.json'), { gate_kind: o.gate_kind || gate, reviewer: FALLBACK_REVIEWER, reply: { findings } });
      Object.assign(record, { inputs_path: inputsPath, fallback_review_path: fb.path, fallback_review_sha256: fb.sha256 });
    }
    Object.assign(record, o.record || {});
    return record;
  };
  c.writeJson = (file, value) => {
    const r = c.node('write-json.js', ['--out', file], { input: JSON.stringify(value) + '\n' });
    assert.equal(r.status, 0, r.stderr);
    return r.json();
  };
  c.ledgerHeader = () => ({ run_dir: run, start_head: c.startHead, previous_design: c.previous_design, source_request_path: c.request, source_request_sha256: c.requestSha });
  c.addRecord = record => {
    c.records.push(record);
    const file = path.join(run, `approvals-${c.records.length}.json`);
    const w = c.writeJson(file, { ...c.ledgerHeader(), records: c.records });
    c.approvalsPath = w.path;
    c.approvalsSha = w.sha256;
    return w;
  };
  c.snapshots = {};
  c.snap = (k, o) => { c.snapshots[k] = c.snapshot(k, o); return c.snapshots[k]; };
  c.approvals = (o = {}) => c.node('check-completion.js', ['--mode', 'approvals', '--repo', repo, '--approvals', o.approvals || c.approvalsPath,
    '--source', o.source || path.join(c.revDir(c.lastRev()), 'feature.json')]);
  c.lastRev = () => Math.max(...Object.keys(c.snapshots).map(Number));

  // The design commit block of design 6.2, run with bash (temp index, commit-tree, update-ref against start_head).
  c.commitBlock = (rev = c.lastRev()) => c.sh([
    'set -e',
    `test "$(git symbolic-ref -q HEAD)" = refs/heads/feature/greet`,
    `export GIT_INDEX_FILE=${run}/design.index; git read-tree ${c.startHead}`,
    `B=$(git hash-object -w --no-filters -- ${c.revDir(rev)}/feature.json)`,
    `git update-index --add --cacheinfo 100644,"$B",${REPO_PATH}`,
    `C=$(git commit-tree "$(git write-tree)" -p ${c.startHead} -m 'design: greet'); unset GIT_INDEX_FILE`,
    `git update-ref refs/heads/feature/greet "$C" ${c.startHead}`,
    `git add -- ${REPO_PATH}`,
    'echo "$C"',
  ].join('\n'));
  c.freezeDir = path.join(run, 'frozen');
  c.commitDesign = (rev) => {
    const r = c.commitBlock(rev);
    assert.equal(r.status, 0, r.stderr);
    c.designCommit = r.stdout.trim();
    return c.designCommit;
  };
  c.compileFrozen = (commit = c.designCommit, dir = c.freezeDir) => {
    const blob = c.exec('git', ['cat-file', 'blob', `${commit}:${REPO_PATH}`], { encoding: null }).stdout;
    const saved = path.join(run, `frozen-source-${path.basename(dir)}.feature.json`);
    fs.writeFileSync(saved, blob);
    const r = c.node('compile-feature.js', ['--file', saved, '--repo', repo, '--repo-path', REPO_PATH, '--out', dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    c.manifestPath = path.join(dir, 'execution-plan.json');
    c.manifestSha = sha256(fs.readFileSync(c.manifestPath));
    c.frozenDir = dir;
    return r.json();
  };
  c.designArgs = (o = {}) => ['--mode', 'design', '--repo', repo, '--feature-id', 'greet', '--frozen-dir', o.frozenDir || c.frozenDir,
    '--manifest-sha256', o.manifestSha || c.manifestSha, '--spec', o.spec || c.featureFile, '--commit', o.commit || c.designCommit,
    '--approvals', o.approvals || c.approvalsPath, '--approvals-sha256', o.approvalsSha || c.approvalsSha,
    ...(o.expectParent ? ['--expect-parent', o.expectParent] : []), ...(o.out ? ['--out', o.out] : [])];
  c.design = (o = {}) => c.node('check-completion.js', c.designArgs(o));
  c.plan = (o = {}) => c.node('check-completion.js', ['--mode', 'plan', '--repo', c.repo, '--feature-id', 'greet', '--reviewed-sha', o.sha || c.reviewedSha,
    '--manifest', c.manifestPath, '--manifest-sha256', c.manifestSha, '--spec', c.featureFile, '--frozen-dir', c.frozenDir, '--commit', c.designCommit,
    '--approvals', c.approvalsPath, '--approvals-sha256', c.approvalsSha]);
  // Happy path: rev-1, PRD PASS, spec PASS, commit, frozen compile.
  c.freeze = (o = {}) => {
    c.snap(1);
    c.addRecord(c.review('prd', 1, o.prd));
    c.addRecord(c.review('spec', 1, o.spec));
    c.commitDesign();
    c.compileFrozen();
    return c;
  };

  // ---- build/verify side ----------------------------------------------------------------------------------
  c.implement = (files = IMPL_FILES) => {
    for (const [rel, content] of Object.entries(files)) c.write(rel, content);
    c.git('add', '--', ...Object.keys(files));
    c.git('commit', '-qm', 'implementation');
    c.reviewedSha = c.git('rev-parse', 'HEAD');
    return c.reviewedSha;
  };
  c.frozenRuns = path.join(run, 'frozen-runs');
  c.ledgerPath = path.join(run, 'acceptance-ledger.json');
  c.runFrozen = (target, o = {}) => {
    const args = ['--repo', o.repo || repo, '--frozen-dir', o.frozenDir || c.frozenDir, '--manifest-sha256', o.manifestSha || c.manifestSha,
      '--reviewed-sha', o.sha || c.reviewedSha, '--target', target, '--out-dir', o.outDir || c.frozenRuns];
    if (o.patch) args.push('--patch', o.patch);
    if (o.ledger !== false && /^(proof|live):/.test(target)) args.push('--ledger', o.ledger || c.ledgerPath);
    return c.node('run-frozen.js', args, { env: o.env ? cleanEnv({ ...o.env }) : env });
  };
  c.patchFile = (id, text) => {
    const dir = path.join(run, 'negative', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mutation.patch');
    fs.writeFileSync(file, text);
    return file;
  };
  c.MUTATION = "diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1 +1 @@\n-module.exports = () => 'hello';\n+module.exports = () => 'goodbye';\n";
  return c;
}

// A complete contract-2 run that completes: design, implementation, run-frozen records, review files, results.
function completeRun(t, opts = {}) {
  const c = makeRepo(t, opts);
  c.freeze(opts.freeze || {});
  c.implement(opts.implFiles);
  const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); return r.json(); };
  const preflightPath = path.join(c.run, 'build', 'design-preflight.json');
  fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
  ok(c.design({ out: preflightPath }), 'build preflight');
  const suite = ok(c.runFrozen('suite', { outDir: path.join(c.run, 'build', 'suite') }), 'suite');
  const suiteRecord = JSON.parse(fs.readFileSync(suite.record_path));
  const checks = ['CHECK-LINT', 'CHECK-LIVE'].map(id => ({ check_id: id, ...pick(ok(c.runFrozen('check:' + id), id), ['record_path', 'record_sha256']) }));
  ok(c.runFrozen('proof:HELLO-001-AC1'), 'proof');
  ok(c.runFrozen('live:HELLO-001-AC2'), 'live');
  const neg = ok(c.runFrozen('negative:HELLO-001-AC1', { outDir: path.join(c.run, 'negative', 'HELLO-001-AC1'), patch: c.patchFile('HELLO-001-AC1', opts.mutation || c.MUTATION), env: opts.runEnv }), 'negative');
  const head = c.reviewedSha;
  const state = () => ({ head_before: head, status_before: [], head_after: head, status_after: [] });
  // review files (mocked model steps; script-hashed)
  const reviewFile = (step, round, kind) => {
    const dir = path.join(c.run, step === 'final' || step === 'compliance' ? 'verify' : 'build', `${step}-${round}`);
    fs.mkdirSync(dir, { recursive: true });
    const entry = { step, round, reviewer: 'codex', review_dir: dir };
    if (kind === 'result') {
      const result = { kind: 'implementation', outcome: 'ok', verdict: 'PASS', verdict_reasons: ['no triggering findings'], model_verdict: 'PASS', unable_to_review: null,
        scope: { mode: 'diff' }, validation: null, findings: [] };
      const file = path.join(dir, 'result.json');
      fs.writeFileSync(file, JSON.stringify(result, null, 2));
      Object.assign(entry, { result_path: file, result_sha256: sha256(fs.readFileSync(file)) });
    } else {
      const file = path.join(dir, kind === 'security' ? 'security.json' : 'compliance.json');
      const raw = kind === 'security' ? { verdict: 'PASS', summary: 'synthetic', findings: [] } : { verdict: 'PASS', summary: 'synthetic', findings: [],
        requirements: opts.complianceRequirements ? opts.complianceRequirements(head) : [
          { id: 'HELLO-001-AC1', status: 'PASS', evidence: [] },
          { id: 'HELLO-001-AC2', status: 'PASS', evidence: [] },
          { id: 'HELLO-001-AC3', status: 'PASS', evidence: [{ kind: 'static', head_sha: head, command: null, exit_code: null, log_path: null, log_sha256: null, file: 'src/hello.js', line: 1 }] },
        ] };
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      Object.assign(entry, { raw_path: file, raw_sha256: sha256(fs.readFileSync(file)) });
    }
    return entry;
  };
  const build = {
    status: 'PASS', contract: 2, build_mode: 'v2', feature_id: 'greet', rounds: 1, base_commit: c.designCommit, reviewed_sha: head,
    plan_identity: { design_commit: c.designCommit, source_sha256: sha256(fs.readFileSync(c.featureFile)), manifest_sha256: c.manifestSha,
      approvals_sha256: c.approvalsSha, preflight_path: preflightPath, preflight_sha256: sha256(fs.readFileSync(preflightPath)) },
    suite_identity: { command: 'node test/hello.test.js', known_failure_ids: [], isolated: false, setup_command: null, timeout_min: 2,
      record_path: suite.record_path, record_sha256: suite.record_sha256 },
    review: { verdict: 'PASS', head_sha: head, confirmed_findings: [] },
    security: { verdict: 'PASS', blocking: [] },
    suite: { completed: true, passed: true, failures: [], other_failures: [], log_path: suiteRecord.log_path, log_sha256: suiteRecord.log_sha256, ...state() },
    known_failures_seen: [],
    review_files: [reviewFile('implementation', 1, 'result'), reviewFile('security', 1, 'security')],
    reviewers: [{ step: 'review 1', reviewer: 'codex' }, { step: 'security 1', reviewer: 'codex' }], fallback_used: false,
    files: ['src/hello.js', 'test/hello.test.js', 'test/live.test.js'], deleted: [],
    history: [{ round: 0, work: { tests_added: ['test/hello.test.js'] } }],
  };
  const verify = {
    status: 'PASS', contract: 2, feature_id: 'greet', base_commit: c.designCommit, reviewed_sha: head, manifest_sha256: c.manifestSha,
    check_records: checks,
    acceptance_ledger: { path: c.ledgerPath, sha256: sha256(fs.readFileSync(c.ledgerPath)) },
    negative_controls: [{ id: 'HELLO-001-AC1', record_path: neg.record_path, record_sha256: neg.record_sha256 }],
    final_review: { verdict: 'PASS', head_sha: head, confirmed_findings: [] },
    compliance: { verdict: 'PASS', blocking: [], ...state(), requirements: [] },
    review_files: [reviewFile('final', 1, 'result'), reviewFile('compliance', 1, 'compliance')],
    fallback_used: false,
  };
  c.build = build;
  c.verify = verify;
  c.buildPath = path.join(c.run, 'build-result.json');
  c.verifyPath = path.join(c.run, 'verify-result.json');
  c.out = path.join(c.run, 'proof', 'completion.json');
  c.save = () => {
    fs.writeFileSync(c.buildPath, JSON.stringify(c.build, null, 2) + '\n');
    fs.writeFileSync(c.verifyPath, JSON.stringify(c.verify, null, 2) + '\n');
  };
  c.rehash = entry => {
    for (const [p, h] of [['record_path', 'record_sha256'], ['result_path', 'result_sha256'], ['raw_path', 'raw_sha256'], ['path', 'sha256'],
      ['fallback_review_path', 'fallback_review_sha256'], ['inputs_path', 'inputs_sha256'], ['preflight_path', 'preflight_sha256']]) {
      if (entry[p] && entry[h] !== undefined) entry[h] = sha256(fs.readFileSync(entry[p]));
    }
    return entry;
  };
  // Rewrites the record an entry names (attested evidence edited by hand) and re-hashes the entry.
  c.editRecord = (entry, mutate, pathKey = 'record_path', hashKey = 'record_sha256') => { entry[hashKey] = c.editJson(entry[pathKey], mutate); return entry; };
  // Rewrites the footer of a framed log to match an edited record, and returns the log's new hash.
  c.setFooter = (logPath, footer) => {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    lines[lines.length - 2] = 'gp-run-frozen footer ' + JSON.stringify(footer);
    fs.writeFileSync(logPath, lines.join('\n'));
    return sha256(fs.readFileSync(logPath));
  };
  // Rewrites a JSON file through a mutation and returns its new hash (for re-hashed tamper cases).
  c.editJson = (file, mutate) => {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(v);
    fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
    return sha256(fs.readFileSync(file));
  };
  c.completionArgs = (o = {}) => ['--repo', c.repo, '--feature-id', 'greet', '--reviewed-sha', o.sha || head, '--manifest', c.manifestPath,
    '--manifest-sha256', c.manifestSha, '--spec', c.featureFile, '--build-result', c.buildPath, '--verify-result', c.verifyPath, '--out', o.out || c.out,
    '--frozen-dir', c.frozenDir, '--approvals', c.approvalsPath, '--approvals-sha256', c.approvalsSha,
    ...(o.trunkRef ? ['--trunk-ref', o.trunkRef] : []), ...(o.previous ? ['--previous-proof', o.previous] : []), ...(o.extra || [])];
  c.completion = (o = {}) => { c.save(); return c.node('check-completion.js', c.completionArgs(o)); };
  return c;
}
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

module.exports = { makeRepo, completeRun, baseFeature, featureBytes, cleanEnv, sha256, clone, FALLBACK_REVIEWER, REPO_PATH, PIPELINE_YAML, IMPL_FILES, SCRIPTS };
