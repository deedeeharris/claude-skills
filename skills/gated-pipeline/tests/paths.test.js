#!/usr/bin/env node
'use strict';

// Plan Level 5.2, the POSIX path matrix (docs/v2-plan.md; docs/v2-design.md 3 G32, 4, 6.2-6.5).
// Part 1, scripts: a temp root whose path holds a space and a non-ASCII letter ("gp v2 ü"), with the repo, the
// state_dir (run dirs, frozen dir, run-frozen out dirs) and the throwaway worktrees run-frozen makes all under it,
// and an executable proof script committed with mode 100755. validate-feature, feature-snapshot, compile-feature
// (--out and --check), check-completion --mode design and run-frozen (red, isolated suite, check, proof, negative)
// run there for real and must work.
// Part 2, workflows: MOCKED at the agent boundary only (tests/helpers/run-workflow.js; every ```gp-exec block is
// run verbatim by tests/helpers/script-stub.js with the real scripts and git; model steps are scripted, the
// reviews take the Opus fallback because the codex on PATH cannot start). design, build and verify contract 2
// run end to end with every path under a root holding spaces, and BLOCK a path holding a character outside the
// workflows' SAFE set (a quote, $, a backtick, ~ and, as SAFE is ASCII-only, a non-ASCII letter) with their
// reason before any agent call.
// Every repo and directory is a temporary directory made at run time; names and identities are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { run, gpBlocks, STOP } = require('./helpers/run-workflow');
const { runBlocks, scriptStep, MOCKED } = require('./helpers/script-stub');
const { makeRepo, baseFeature, featureBytes, cleanEnv, sha256, IMPL_FILES, SCRIPTS, REPO_PATH } = require('./helpers/v2-repo');

const SKILLS = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(SKILLS, 'codex-review', 'scripts', 'run-review.js');
const COMPLETION = path.join(SCRIPTS, 'check-completion.js');
const SEC_SCHEMA = path.join(__dirname, '..', 'schemas', 'security.schema.json');
const COMPLY_SCHEMA = path.join(__dirname, '..', 'schemas', 'compliance.schema.json');
const BRANCH = 'feature/greet';

// ---- fixtures -----------------------------------------------------------------------------------------------------
// The proof, unit and suite command is an executable script that finds the focused test next to itself.
const PROVE = 'test/prove.sh';
const PROVE_SH = '#!/bin/sh\n# synthetic proof script: runs the focused test next to this file\nhere=$(dirname "$0")\nexec node "$here/hello.test.js"\n';
const FILES = { ...IMPL_FILES, [PROVE]: PROVE_SH };
function pathFeature() {
  const f = baseFeature();
  f.requirements[0].acceptance[0].verification.command = PROVE;
  f.suite.command = PROVE;
  f.suite.unit_command = PROVE;
  f.suite.isolated = true; // the suite runs in a throwaway worktree too
  return f;
}

// makeRepo (helpers/v2-repo.js) roots its temp dir at os.tmpdir(): TMPDIR points it at `parent` for the call, and
// the env the helper keeps for every child (c.env) carries the same TMPDIR, so a script's own temp files land there.
function repoUnder(t, prefix, opts = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  try { return { parent, c: makeRepo(t, { feature: pathFeature(), ...opts }) }; } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
}
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); return r.json(); };

// ---- part 1: the scripts ------------------------------------------------------------------------------------------
test('5.2 scripts: repo, state_dir and worktrees under "gp v2 ü": validate, compile, --mode design and run-frozen (red, suite, check, proof, negative) work', t => {
  const { parent, c } = repoUnder(t, 'gp v2 ü-');
  assert.match(c.repo, / /);
  assert.match(c.repo, /ü/);
  for (const p of [c.repo, c.run]) assert.ok(p.startsWith(parent + path.sep), p);

  // validate-feature on the working file, with the pinned source request
  const v = ok(c.node('validate-feature.js', ['--file', c.featureFile, '--repo-path', REPO_PATH, '--source-request', c.request]), 'validate');
  assert.equal(v.valid, true);
  assert.deepEqual(v.errors, []);
  assert.equal(v.source_sha256, sha256(fs.readFileSync(c.featureFile)));

  // snapshot (validates and compiles into the rev dir), two script-hashed review records, the design commit
  c.snap(1);
  c.addRecord(c.review('prd', 1));
  c.addRecord(c.review('spec', 1));
  // design 6.2 commit: only the canonical file on top of start_head (made with argv git, no shell)
  c.git('add', '--', REPO_PATH);
  c.git('commit', '-qm', 'design: greet');
  c.designCommit = c.git('rev-parse', 'HEAD');
  assert.equal(c.git('rev-parse', `${c.designCommit}^`), c.startHead);

  // compile-feature --out from the committed blob, then --check against it
  const frozen = c.compileFrozen();
  assert.equal(frozen.source_sha256, sha256(fs.readFileSync(c.featureFile)));
  const blob = path.join(c.run, `frozen-source-${path.basename(c.frozenDir)}.feature.json`);
  const chk = ok(c.node('compile-feature.js', ['--file', blob, '--repo', c.repo, '--repo-path', REPO_PATH, '--check', c.frozenDir]), 'compile --check');
  assert.equal(chk.ok, true);
  const manifest = JSON.parse(fs.readFileSync(c.manifestPath, 'utf8'));
  assert.equal(manifest.requirements.find(r => r.id === 'HELLO-001-AC1').proof_command, PROVE);
  for (const n of fs.readdirSync(c.frozenDir)) assert.ok(!fs.readFileSync(path.join(c.frozenDir, n), 'utf8').includes(parent), `${n} holds the absolute root`);

  // check-completion --mode design, with the expected parent
  const preflight = path.join(c.run, 'state dir', 'build', 'design-preflight.json');
  fs.mkdirSync(path.dirname(preflight), { recursive: true });
  const d = ok(c.design({ out: preflight, expectParent: c.startHead }), 'check-completion --mode design');
  assert.equal(d.status, 'PASS', JSON.stringify(d));
  assert.equal(d.design_commit, c.designCommit);
  assert.equal(d.unit_command, PROVE);
  assert.ok(fs.existsSync(preflight));

  // the implementation: the red commit holds the focused tests and the executable proof script (mode 100755)
  c.implement(FILES, [PROVE]);
  assert.ok(c.redCommit, 'a red commit was made');
  assert.match(c.git('ls-tree', c.reviewedSha, '--', PROVE), /^100755 blob /);

  const out = name => path.join(c.run, 'state dir', name);
  // red: the frozen unit command (the script) in a throwaway worktree of the red commit fails before the implementation
  const red = ok(c.runFrozen('red', { sha: c.redCommit, base: c.designCommit, outDir: out('test-first') }), 'red');
  const redRec = JSON.parse(fs.readFileSync(red.record_path, 'utf8'));
  assert.equal(redRec.exit_code, 1, JSON.stringify(redRec));
  assert.equal(redRec.timed_out, false);
  assert.ok(red.record_path.startsWith(parent + path.sep));
  assert.ok(!fs.existsSync(path.join(out('test-first'), 'red-wt')), 'the red worktree is removed');
  // the isolated suite: the script in a throwaway worktree of the reviewed commit passes
  const suite = ok(c.runFrozen('suite', { outDir: out('suite') }), 'suite');
  const suiteRec = JSON.parse(fs.readFileSync(suite.record_path, 'utf8'));
  assert.equal(suiteRec.exit_code, 0, JSON.stringify(suiteRec));
  assert.match(fs.readFileSync(suiteRec.log_path, 'utf8'), /hello test ok/);
  // a check, in the repo checkout itself
  const lint = ok(c.runFrozen('check:CHECK-LINT', { outDir: out('checks') }), 'check');
  assert.equal(JSON.parse(fs.readFileSync(lint.record_path, 'utf8')).exit_code, 0);
  // the proof: the executable script, recorded in the ledger
  const proof = ok(c.runFrozen('proof:HELLO-001-AC1', { outDir: out('proofs') }), 'proof');
  const proofRec = JSON.parse(fs.readFileSync(proof.record_path, 'utf8'));
  assert.equal(proofRec.exit_code, 0, JSON.stringify(proofRec));
  assert.match(fs.readFileSync(proofRec.log_path, 'utf8'), /hello test ok/);
  const ledger = JSON.parse(fs.readFileSync(c.ledgerPath, 'utf8'));
  assert.ok(JSON.stringify(ledger).includes('HELLO-001-AC1'));
  // the negative control: baseline passes, the mutated worktree fails the same script
  const negDir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  const neg = ok(c.runFrozen('negative:HELLO-001-AC1', { outDir: negDir, patch: c.patchFile('HELLO-001-AC1', c.MUTATION) }), 'negative');
  const negRec = JSON.parse(fs.readFileSync(neg.record_path, 'utf8'));
  assert.equal(negRec.baseline_exit_code, 0, JSON.stringify(negRec));
  assert.notEqual(negRec.exit_code, 0, JSON.stringify(negRec));
  assert.ok(!fs.existsSync(path.join(negDir, 'wt')), 'the negative-control worktree is removed');
  // a linked worktree of the reviewed commit under the same root: the canonical file there validates and its
  // committed blob still compiles to the frozen dir, byte for byte
  const wt = path.join(parent, 'work tree ü');
  c.git('worktree', 'add', '-q', '--detach', wt, c.reviewedSha);
  const wtFile = path.join(wt, REPO_PATH);
  assert.equal(ok(c.node('validate-feature.js', ['--file', wtFile, '--repo-path', REPO_PATH], { cwd: wt }), 'validate in the worktree').valid, true);
  assert.equal(ok(c.node('compile-feature.js', ['--file', wtFile, '--repo', wt, '--repo-path', REPO_PATH, '--check', c.frozenDir], { cwd: wt }), 'compile --check in the worktree').ok, true);
  c.git('worktree', 'remove', wt);
  // the checkout is untouched and no worktree is left registered
  assert.equal(c.git('rev-parse', 'HEAD'), c.reviewedSha);
  assert.equal(c.git('status', '--porcelain'), '');
  assert.equal(c.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
});

// ---- part 2: the workflows ----------------------------------------------------------------------------------------
const UNAVAILABLE = note => ({ verdict: 'ERROR', verdict_reasons: [], model_verdict: null, outcome: null, unable_to_review: null, validation_outcome: null,
  run_dir: null, result_sha256: null, findings: [], codex_available: false, note });
const bash = body => spawnSync('bash', ['-c', body], { env: cleanEnv(), encoding: 'utf8' });
const stub = () => scriptStep();
const head = c => c.git('rev-parse', 'HEAD');
const changedOf = c => c.git('diff', '--name-status', '--no-renames', c.designCommit, 'HEAD').split('\n').filter(Boolean).map(l => ({ status: l.split('\t')[0], path: l.split('\t')[1] }));

// The Opus fallback of build and verify: its setup and cleanup blocks run verbatim, the reply is scripted.
function opus(reply) {
  return prompt => {
    const b = gpBlocks(prompt, ['setup', 'cleanup']);
    const setup = bash(b.setup);
    assert.equal(setup.status, 0, 'fallback setup: ' + setup.stdout + setup.stderr);
    const cleanup = bash(b.cleanup);
    assert.equal(cleanup.status, 0, 'fallback cleanup: ' + cleanup.stdout + cleanup.stderr);
    const headSha = (setup.stdout.match(/^head_sha: ([0-9a-f]{40})$/m) || [])[1];
    const changed = setup.stdout.includes('\nchanged:\n') ? setup.stdout.split('\nchanged:\n')[1].trim().split('\n').map(l => ({ status: l.split('\t')[0], path: l.split('\t')[1] })) : undefined;
    return typeof reply === 'function' ? reply({ headSha, changed }) : reply;
  };
}
function sh(body, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', body], { cwd, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => { stdout += x; });
    child.stderr.on('data', x => { stderr += x; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function responder(table) {
  return async (prompt, options, calls) => {
    const r = table[options.label];
    assert.ok(r !== undefined, 'unexpected agent call: ' + options.label);
    return typeof r === 'function' ? r(prompt, options, calls) : r;
  };
}
const many = fn => Array(80).fill(fn);
const labelsOf = calls => calls.map(x => x.options.label);

// design contract 2 with the Opus fallback: the codex relay's setup block runs verbatim with a codex that cannot
// start (exit 3: unavailable), the fallback's setup and cleanup blocks run verbatim, every deterministic block runs.
const DESIGN_DETERMINISTIC = /^(start|snapshot \d+|record \d+|approvals|commit|freeze|release lock|recover check)$/;
function designDriver(c) {
  return async (prompt, options) => {
    const label = options.label;
    if (DESIGN_DETERMINISTIC.test(label)) {
      const r = runBlocks(prompt, { cwd: c.repo, env: c.stubEnv });
      return { stdout: r.stdout, exit_code: r.exit_code };
    }
    if (label === 'draft') { fs.copyFileSync(c.seed, c.featureFile); return { blocked: false, path: c.featureFile, summary: 'drafted' }; }
    if (/^codex (prd|spec) review \d+$/.test(label)) {
      const b = gpBlocks(prompt, ['setup', 'start', 'poll', 'cleanup']);
      const setup = await sh(b.setup, c.repo, c.stubEnv);
      assert.equal(setup.code, 3, `${label}: the relay setup reports codex unavailable: ${setup.stdout}${setup.stderr}`);
      return UNAVAILABLE(setup.stdout + setup.stderr);
    }
    if (/^opus (prd|spec) review \d+ \(codex unavailable\)$/.test(label)) {
      const b = gpBlocks(prompt, ['setup', 'cleanup']);
      const setup = await sh(b.setup, c.repo, c.stubEnv);
      assert.equal(setup.code, 0, `${label} setup: ${setup.stdout}${setup.stderr}`);
      const cleanup = await sh(b.cleanup, c.repo, c.stubEnv);
      assert.equal(cleanup.code, 0, `${label} cleanup: ${cleanup.stdout}${cleanup.stderr}`);
      return { findings: [] };
    }
    assert.fail('unexpected agent call: ' + label);
  };
}

test(`5.2 workflows (${MOCKED}): design, build and verify contract 2 run to PASS with repo, state_dir, run dirs and the seed under paths with spaces`, async t => {
  const { parent, c } = repoUnder(t, 'gp v2 spaced root-');
  assert.match(c.repo, / /);
  fs.rmSync(c.featureFile, { force: true }); // the design draft writes it
  const state = path.join(c.root, 'state dir');
  c.seed = path.join(c.root, 'seed dir', 'greet seed.feature.json');
  fs.mkdirSync(path.dirname(c.seed));
  fs.writeFileSync(c.seed, featureBytes(c.feature));
  const bin = path.join(c.root, 'bin dir');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "codex: not installed here" >&2\nexit 127\n', { mode: 0o755 });
  c.stubEnv = cleanEnv({ PATH: bin + path.delimiter + process.env.PATH });
  for (const p of [c.repo, state, c.seed, c.request]) assert.ok(p.startsWith(parent + path.sep) && / /.test(p), p);

  // design
  const designRun = path.join(state, 'greet', 'design', 'r 1');
  const dArgs = { contract: 2, feature_id: 'greet', repo: c.repo, run_dir: designRun, review_runner: RUNNER, completion_runner: COMPLETION,
    work_branch: BRANCH, source_request_path: c.request, seed_feature_path: c.seed, review_fallback: 'opus-high', max_rounds: 3, review_timeout_seconds: 60 };
  const d = await run('design', dArgs, many(designDriver(c)));
  assert.equal(d.result.status, 'PASS', JSON.stringify(d.result).slice(0, 3000));
  assert.equal(labelsOf(d.calls)[0], 'start');
  assert.equal(d.result.frozen_dir, path.join(designRun, 'frozen'));
  Object.assign(c, { designCommit: d.result.design_commit, frozenDir: d.result.frozen_dir, manifestPath: d.result.manifest_path,
    manifestSha: d.result.manifest_sha256, approvalsPath: d.result.approvals_path, approvalsSha: d.result.approvals_sha256 });
  assert.equal(c.manifestSha, sha256(fs.readFileSync(c.manifestPath)));
  assert.equal(head(c), c.designCommit);

  // build (Opus fallback reviews)
  const buildRun = path.join(state, 'greet', 'build', 'r 1');
  const bArgs = { contract: 2, feature_id: 'greet', repo: c.repo, work_branch: BRANCH, run_dir: buildRun, review_runner: RUNNER, security_schema: SEC_SCHEMA,
    completion_runner: COMPLETION, frozen_dir: c.frozenDir, manifest_path: c.manifestPath, manifest_sha256: c.manifestSha, spec_path: c.featureFile,
    design_commit: c.designCommit, approvals_path: c.approvalsPath, approvals_sha256: c.approvalsSha, base_commit: c.designCommit, review_fallback: 'opus-high' };
  const implement = () => {
    c.implement(FILES, [PROVE]);
    return { blocked: false, summary: 'implemented', files_changed: Object.keys(FILES), tests_added: ['test/hello.test.js'], red_then_green: 'red then green',
      commit: c.reviewedSha, base_commit: c.designCommit, red_commit: c.redCommit };
  };
  const NOCODEX = { verdict: 'ERROR', verdict_reasons: [], findings: [], model_verdict: null, outcome: null, unable_to_review: null, validation_outcome: null,
    run_dir: null, result_sha256: null, codex_available: false, note: 'codex: command not found' };
  const b = await run('build', bArgs, many(responder({
    'design preflight': stub(), implement, 'test-first red': stub(),
    'suite 1': scriptStep(r => ({ stdout: r.stdout, exit_code: r.exit_code, failures: [], other_failures: [] })),
    'codex review 1': { ...NOCODEX, head_sha: '', changed: [] },
    'opus review 1 (codex unavailable)': opus(({ headSha, changed }) => ({ findings: [], head_sha: headSha, changed })), 'record opus review 1': stub(),
    'codex security 1': { verdict: 'ERROR', blocking: [], codex_available: false, raw_sha256: null },
    'opus security 1 (codex unavailable)': opus({ verdict: 'PASS', blocking: [] }), 'record opus security 1': stub(),
  })));
  assert.equal(b.result.status, 'PASS', JSON.stringify(b.result).slice(0, 3000));
  assert.equal(b.result.reviewed_sha, c.reviewedSha);
  assert.equal(b.result.test_first.red_commit, c.redCommit);
  const buildResult = path.join(state, 'greet', 'build result.json');
  fs.writeFileSync(buildResult, JSON.stringify(b.result, null, 2) + '\n');

  // verify (Opus fallback reviews), up to and including the completion proof
  const verifyRun = path.join(state, 'greet', 'verify', 'r 1');
  const vArgs = { contract: 2, feature_id: 'greet', repo: c.repo, work_branch: BRANCH, run_dir: verifyRun, review_runner: RUNNER, spec_path: c.featureFile,
    compliance_schema: COMPLY_SCHEMA, manifest_path: c.manifestPath, manifest_sha256: c.manifestSha, build_result_path: buildResult, completion_runner: COMPLETION,
    frozen_dir: c.frozenDir, design_commit: c.designCommit, approvals_path: c.approvalsPath, approvals_sha256: c.approvalsSha, base_commit: c.designCommit,
    reviewed_sha: head(c), review_fallback: 'opus-high' };
  const sha = head(c);
  const pinned = { head_before: sha, status_before: [], head_after: sha, status_after: [] };
  const reqs = [
    { id: 'HELLO-001-AC1', status: 'PASS', evidence: [] },
    { id: 'HELLO-001-AC2', status: 'PASS', evidence: [] },
    { id: 'HELLO-001-AC3', status: 'PASS', evidence: [{ kind: 'static', head_sha: sha, command: null, exit_code: null, log_path: null, log_sha256: null, file: 'src/hello.js', line: 1 }] },
  ];
  const negative = async (prompt, options, calls) => {
    const dir = path.join(verifyRun, 'negative', 'HELLO-001-AC1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mutation.patch'), c.MUTATION);
    return stub()(prompt, options, calls);
  };
  const v = await run('verify', vArgs, many(responder({
    'plan preflight': stub(), 'check CHECK-LINT': stub(), 'check CHECK-LIVE': stub(),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`acceptance proofs ${i + 1}`, stub()])),
    'negative control HELLO-001-AC1': negative, 'pinned state': stub(), 'completion proof': stub(),
    'codex final review': { ...NOCODEX, head_sha: sha },
    'opus final review (codex unavailable)': opus(({ headSha }) => ({ findings: [], head_sha: headSha })), 'record opus final review': stub(),
    'codex spec compliance': { verdict: 'ERROR', blocking: [], requirements: [], codex_available: false, raw_sha256: null, ...pinned },
    'opus spec compliance (codex unavailable)': opus(() => ({ verdict: 'PASS', blocking: [], requirements: reqs, ...pinned })), 'record opus compliance': stub(),
  })));
  assert.equal(v.result.status, 'PASS', JSON.stringify(v.result).slice(0, 3000));
  assert.ok(v.result.completion && v.result.completion.proof_path, JSON.stringify(v.result.completion));
  assert.ok(v.result.completion.proof_path.startsWith(verifyRun + path.sep), v.result.completion.proof_path);
  assert.ok(fs.existsSync(v.result.completion.proof_path));
  assert.equal(head(c), sha);
});

test('5.2 workflows: a path with a quote, $, a backtick, ~ or a non-ASCII letter BLOCKS design, build and verify contract 2 with its reason, before any agent call', async () => {
  const W = '/w s/state dir';
  const ok2 = {
    design: { contract: 2, feature_id: 'greet', repo: '/w s/repo', run_dir: `${W}/design`, review_runner: RUNNER, completion_runner: COMPLETION,
      work_branch: BRANCH, source_request_path: `${W}/source request.txt` },
    build: { contract: 2, feature_id: 'greet', repo: '/w s/repo', work_branch: BRANCH, run_dir: `${W}/build`, review_runner: RUNNER, security_schema: SEC_SCHEMA,
      completion_runner: COMPLETION, frozen_dir: `${W}/frozen`, manifest_path: `${W}/frozen/execution-plan.json`, manifest_sha256: 'a'.repeat(64),
      spec_path: '/w s/repo/.pipeline/features/greet.feature.json', design_commit: 'd'.repeat(40), approvals_path: `${W}/approvals-2.json`,
      approvals_sha256: 'b'.repeat(64), base_commit: 'd'.repeat(40) },
    verify: { contract: 2, feature_id: 'greet', repo: '/w s/repo', work_branch: BRANCH, run_dir: `${W}/verify`, review_runner: RUNNER,
      spec_path: '/w s/repo/.pipeline/features/greet.feature.json', compliance_schema: COMPLY_SCHEMA, manifest_path: `${W}/frozen/execution-plan.json`,
      manifest_sha256: 'a'.repeat(64), build_result_path: `${W}/build result.json`, completion_runner: COMPLETION, frozen_dir: `${W}/frozen`,
      design_commit: 'd'.repeat(40), approvals_path: `${W}/approvals-2.json`, approvals_sha256: 'b'.repeat(64), base_commit: 'd'.repeat(40), reviewed_sha: 'e'.repeat(40) },
  };
  // The same args with spaces pass every arg check: the first agent call is made (and stopped there).
  for (const [stage, args] of Object.entries(ok2)) {
    const { result, calls } = await run(stage, args, [STOP]);
    assert.ok(result.stopped, `${stage}: spaces are accepted, got ${JSON.stringify(result)}`);
    assert.equal(calls.length, 1, stage);
  }
  const BAD = ["it's", 'a$HOME', 'a`id`', '~user', 'gp ü'];
  const SAFE_REASON = k => new RegExp(`^${k} must be an? (absolute|normalized absolute POSIX) path of safe characters`);
  for (const [stage, args] of Object.entries(ok2)) {
    const keys = stage === 'design' ? ['repo', 'run_dir', 'source_request_path'] : stage === 'build' ? ['repo', 'run_dir', 'spec_path'] : ['repo', 'run_dir', 'build_result_path'];
    for (const k of keys) {
      for (const bad of BAD) {
        const value = args[k].replace('/w s/', `/w s/${bad}/`);
        // a path under the repo moves with it, so only the one arg is unsafe
        const over = { [k]: value };
        if (k === 'repo') for (const p of ['spec_path']) if (args[p]) over[p] = args[p].replace('/w s/repo', value);
        const { result, calls } = await run(stage, { ...args, ...over }, []);
        const what = `${stage} ${k}=${JSON.stringify(value)}`;
        assert.equal(result.status, 'BLOCKED', what);
        assert.match(result.reason, SAFE_REASON(k), `${what}: ${result.reason}`);
        assert.ok(result.reason.endsWith(value) || result.reason.includes(value), `${what}: the reason names the path`);
        assert.equal(calls.length, 0, `${what}: no agent call`);
      }
    }
  }
});
