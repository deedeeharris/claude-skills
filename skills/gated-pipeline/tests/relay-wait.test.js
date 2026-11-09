'use strict';

// Issue #37, plan 1b: an executable long-wait relay test. No model is asked anything. The
// test executes the relay protocol the prompts prescribe: it takes the role-tagged gp-exec
// blocks out of the real prompts and runs each verbatim with bash in a real temp git repo,
// with the real codex-review runner and the fake codex on PATH: setup as a foreground
// call, start as a detached child (the run_in_background model), poll as separate
// foreground calls while it exits 1 (at most the prompt's K), then cleanup once. The only
// changes are two declared substitutions inside poll (seq 1 54 -> seq 1 N, sleep 10 ->
// sleep 0.2). The relay replies then go through the real workflow scripts (mocked agent
// boundary). This proves the prescribed commands and loop work; it does NOT prove that a
// model obeys them, or that the end of an agent turn kills a background job.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { test, describe, after } = require('node:test');
const { run, gpBlocks, pollLimit, STOP } = require('./helpers/run-workflow');

const SKILLS = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(SKILLS, 'codex-review', 'scripts', 'run-review.js');
const FAKE = path.join(SKILLS, 'codex-review', 'tests', 'fake-codex.js');
const SEC_SCHEMA = path.join(__dirname, '..', 'schemas', 'security.schema.json');
const COMPLY_SCHEMA = path.join(__dirname, '..', 'schemas', 'compliance.schema.json');
const COMPLETION = path.join(__dirname, '..', 'scripts', 'check-completion.js');
const digest = 'b'.repeat(64);
const N = 5; // shortened poll loop: N x 0.2 s = 1 s
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-relay-')));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// The fake codex as `codex` on PATH; and a PATH where codex cannot run.
const BIN = path.join(WORK, 'bin');
fs.mkdirSync(BIN);
fs.copyFileSync(FAKE, path.join(BIN, 'codex'));
fs.chmodSync(path.join(BIN, 'codex'), 0o755);
const hostHasCodex = spawnSync('bash', ['-c', 'command -v codex'], { encoding: 'utf8' }).status === 0;
const NOBIN = path.join(WORK, 'nobin');
fs.mkdirSync(NOBIN);
if (hostHasCodex) { // a real codex on this host would answer the probe: shadow it with one that cannot run
  fs.writeFileSync(path.join(NOBIN, 'codex'), '#!/bin/sh\necho "codex: command not found" >&2\nexit 127\n');
  fs.chmodSync(path.join(NOBIN, 'codex'), 0o755);
}
const envWith = (name, extra = {}) => ({ ...process.env, PATH: BIN + path.delimiter + process.env.PATH,
  FAKE_CODEX_SCENARIO: 'pass', FAKE_CODEX_STATE: path.join(WORK, `fake-state-${name}`), ...extra });
const envWithout = () => ({ ...process.env, PATH: NOBIN + path.delimiter + process.env.PATH });

const GIT_ENV = { GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: '' };
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
// A repo with a base and a head commit, and a run dir outside it.
function fixture(name) {
  const repo = path.join(WORK, `repo-${name}`);
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n');
  git(repo, ['add', 'app.js']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(repo, 'new.js'), 'module.exports = 3;\n');
  git(repo, ['add', 'app.js', 'new.js']);
  git(repo, ['commit', '-q', '-m', 'head']);
  const runDir = path.join(WORK, `run-${name}`);
  fs.mkdirSync(runDir);
  return { repo, base, head: git(repo, ['rev-parse', 'HEAD']), runDir };
}
const worktrees = repo => git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree '));
const pinnedAt = (repo, head) => ({ head_before: git(repo, ['rev-parse', 'HEAD']), head_after: head, status_before: [], status_after: [] });

function bash(block, env) {
  return new Promise((resolve) => {
    const c = spawn('bash', ['-c', block], { env });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', status => resolve({ status, stdout, stderr }));
  });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readPid = async file => { for (let i = 0; i < 100 && !fs.existsSync(file); i++) await sleep(20); return Number(fs.readFileSync(file, 'utf8')); };

// The only two changes the harness makes, both inside poll; nothing else in it may differ.
function shortPoll(poll) {
  const subs = [['$(seq 1 54)', `$(seq 1 ${N})`], ['sleep 10', 'sleep 0.2']];
  let out = poll;
  for (const [a, b] of subs) {
    assert.equal(out.split(a).length - 1, 1, `poll holds ${a} exactly once`);
    out = out.replace(a, b);
  }
  assert.equal(subs.length, 2);
  let back = out;
  for (const [a, b] of subs) back = back.replace(b, a);
  assert.equal(back, poll, 'no other byte of poll changed');
  return out;
}

// Runs a codex relay prompt's blocks. `out` is the relay's out dir and `result` the file the
// poll waits for (a function, since the run folder name is the runner's).
async function relay(prompt, env, out, result) {
  const b = gpBlocks(prompt, ['setup', 'start', 'poll', 'cleanup']);
  const t = { K: pollLimit(prompt), events: [], polls: [] };
  t.setup = await bash(b.setup, env);
  t.events.push(`setup:${t.setup.status}`);
  if (t.setup.status !== 0) return t;
  const start = spawn('bash', ['-c', b.start], { env, detached: true, stdio: 'ignore' });
  t.started = new Promise(r => start.on('exit', (code, sig) => r({ code, sig })));
  t.runnerPid = await readPid(path.join(out, 'runner.pid'));
  const poll = shortPoll(b.poll);
  for (let i = 0; i < t.K; i++) {
    const p = await bash(poll, env);
    t.polls.push(p.status);
    t.events.push(`poll:${p.status}`);
    if (i === 0) t.afterFirstPoll = { runnerAlive: alive(t.runnerPid), resultExists: !!result() };
    if (p.status === 0) break;
  }
  t.cleanup = await bash(b.cleanup, env);
  t.events.push(`cleanup:${t.cleanup.status}`);
  return t;
}
async function fallback(prompt, env) {
  const b = gpBlocks(prompt, ['setup', 'cleanup']);
  const t = { setup: await bash(b.setup, env) };
  if (t.setup.status === 0) t.cleanup = await bash(b.cleanup, env);
  return t;
}
const runFolder = (out, kind) => {
  if (!fs.existsSync(out)) return null;
  const d = fs.readdirSync(out).filter(x => x.startsWith(kind + '-') && fs.existsSync(path.join(out, x, 'result.json')));
  return d.length === 1 ? path.join(out, d[0]) : null;
};
const resultOf = (out, kind) => () => { const d = runFolder(out, kind); return d && path.join(d, 'result.json'); };
const rawOf = file => () => (fs.existsSync(file) ? file : null);
const setupHead = t => (t.setup.stdout.match(/^head_sha: ([0-9a-f]{40})$/m) || [])[1];
const setupChanged = t => t.setup.stdout.split('\nchanged:\n')[1].trim().split('\n').map(l => ({ status: l.split('\t')[0], path: l.split('\t')[1] }));

const NULLS = { model_verdict: null, outcome: null, unable_to_review: null, validation_outcome: null, run_dir: null, result_sha256: null };
const blockedReply = t => ({ verdict: 'ERROR', verdict_reasons: [], findings: [], ...NULLS, codex_available: true, blocked: true, note: t.setup.stdout + t.setup.stderr });
const unavailableReply = t => ({ verdict: 'ERROR', verdict_reasons: [], findings: [], ...NULLS, codex_available: false, note: t.setup.stdout + t.setup.stderr });
// What the review relay prompt prescribes after a poll exit 0: copy result.json field by field.
function reviewReply(t, out, kind) {
  if (t.setup.status === 3) return unavailableReply(t);
  if (t.setup.status !== 0) return blockedReply(t);
  if (!t.polls.includes(0)) return { verdict: 'ERROR', verdict_reasons: [], findings: [], ...NULLS, codex_available: true, note: `no result after ${t.K} polls; run folder:\n${t.cleanup.stdout}` };
  const dir = runFolder(out, kind);
  const res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const shaLine = t.cleanup.stdout.split('\n').find(l => l.endsWith(path.join(dir, 'result.json')));
  return {
    verdict: res.verdict, verdict_reasons: res.verdict_reasons, model_verdict: res.model_verdict, outcome: res.outcome, unable_to_review: res.unable_to_review,
    validation_outcome: res.validation ? res.validation.outcome : null, run_dir: dir, result_sha256: shaLine.split(/\s+/)[0], codex_available: true,
    findings: res.findings.map(x => ({ id: x.id, severity: x.severity, confidence: x.confidence, iso_property: x.iso_property, validation_status: x.validation.status,
      claim: x.claim, evidence: x.evidence, location: x.location })),
  };
}
// The security / compliance relays: verdict and the critical/high (security) or every (compliance) finding as blocking.
function rawReply(t, file, kind) {
  if (t.setup.status === 3) return { verdict: 'ERROR', blocking: [], requirements: [], codex_available: false, note: t.setup.stdout };
  if (t.setup.status !== 0) return { verdict: 'ERROR', blocking: [], requirements: [], codex_available: true, blocked: true, note: t.setup.stdout + t.setup.stderr };
  if (!t.polls.includes(0)) return { verdict: 'ERROR', blocking: [], requirements: [], codex_available: true, note: t.cleanup.stdout };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blocking = kind === 'security' ? doc.findings.filter(x => x.severity === 'critical' || x.severity === 'high') : doc.findings;
  return { verdict: doc.verdict, blocking, requirements: doc.requirements || [], codex_available: true };
}

function responder(table) {
  return async (prompt, options, calls) => {
    const r = table[options.label];
    assert.ok(r !== undefined, 'unexpected agent call: ' + options.label);
    return typeof r === 'function' ? r(prompt, options, calls) : r;
  };
}
const many = fn => Array(30).fill(fn);
const quotedTask = p => p.slice(p.indexOf('prompt.md containing: "') + 'prompt.md containing: "'.length, p.indexOf('"\n2. Run'));

function assertWaited(t, label) {
  assert.ok(t.polls.length >= 2, `${label}: at least two foreground poll calls (got ${t.polls.length})`);
  assert.deepEqual(t.polls, [...Array(t.polls.length - 1).fill(1), 0], `${label}: polls exit 1 until the result exists, then 0`);
  assert.equal(t.afterFirstPoll.runnerAlive, true, `${label}: the runner.pid process is alive before the result exists`);
  assert.equal(t.afterFirstPoll.resultExists, false, `${label}: no result after the first poll`);
  assert.deepEqual(t.events.slice(-2), ['poll:0', 'cleanup:0'], `${label}: cleanup ran once, after a poll exit 0`);
}

const designArgs = (fx) => ({ feature_id: 'feature', repo: fx.repo, task: 'Build a feature', run_dir: fx.runDir, review_runner: RUNNER,
  execution_schema: path.join(__dirname, '..', 'schemas', 'execution-plan.schema.json'), review_timeout_seconds: 600 });
const buildArgs = (fx) => ({ feature_id: 'feature', repo: fx.repo, work_branch: 'main', run_dir: fx.runDir, review_runner: RUNNER, suite_cmd: 'true',
  security_schema: SEC_SCHEMA, spec_path: path.join(fx.runDir, 'spec.md'), review_timeout_seconds: 600 });
const verifyArgs = (fx) => ({ feature_id: 'feature', repo: fx.repo, work_branch: 'main', run_dir: fx.runDir, review_runner: RUNNER,
  spec_path: path.join(fx.runDir, 'spec.md'), compliance_schema: COMPLY_SCHEMA, base_commit: fx.base, reviewed_sha: fx.head, completion_runner: COMPLETION,
  manifest_path: path.join(fx.runDir, 'execution-plan.json'), manifest_sha256: digest, build_result_path: path.join(fx.runDir, 'build-result.json'), review_timeout_seconds: 600 });
const work = fx => ({ blocked: false, summary: 'done', files_changed: ['app.js', 'new.js'], commit: fx.head, base_commit: fx.base });
const suite = fx => ({ passed: true, counts: '1 passed', failures: [], completed: true, other_failures: [], log_path: path.join(fx.runDir, 'suite-1.txt'), log_sha256: digest, ...pinnedAt(fx.repo, fx.head) });
const writeDoc = (file, text) => () => { fs.writeFileSync(file, text); return { blocked: false, path: file, summary: 'written' }; };

// ---- the deadline premise, measured on the worst reachable path ----------------------------
test('deadline premise: the worst runner path stays inside the relay wait at the default timeout', async () => {
  const T = 1;
  const d = 0.3 * T;
  const state = path.join(WORK, 'fake-state-premise');
  const out = path.join(WORK, 'out-premise');
  const table = { model_verdict: 'FAIL', validation: { F1: 'CONFIRMED' }, findings: [{ id: 'F1', severity: 'MAJOR', confidence: 0.9, category: 'c', iso_property: null,
    location: { file: 'app.js', line: 1, section: null }, claim: 'gap', evidence: 'quoted', suggested_fix: 'fix' }] };
  const plan = { review: [{ delay_ms: 600000, ignore_term: true }, { delay_ms: (2 * T - d) * 1000 }],
    validate: [{ delay_ms: 600000, ignore_term: true }, { delay_ms: 600000, ignore_term: true }] };
  const env = envWith('premise', { FAKE_CODEX_SCENARIO: 'table', FAKE_CODEX_TABLE: JSON.stringify(table), FAKE_CODEX_PLAN: JSON.stringify(plan), FAKE_CODEX_STATE: state });
  const doc = path.join(WORK, 'premise.md');
  fs.writeFileSync(doc, 'x\n');
  const t0 = Date.now();
  const r = await new Promise(resolve => spawn(process.execPath, [RUNNER, '--kind', 'implementation', '--files', doc, '--repo', WORK, '--out-dir', out, '--timeout-seconds', String(T)], { env, stdio: 'ignore' })
    .on('close', resolve));
  const seconds = (Date.now() - t0) / 1000;
  const res = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out).find(x => x.startsWith('implementation-')), 'result.json'), 'utf8'));
  assert.equal(r, 3, 'NEEDS_HUMAN: the trigger stayed unvalidated');
  assert.equal(res.review.attempts, 2, 'the review needed both attempts');
  assert.deepEqual(res.validation, { outcome: 'timeout', attempts: 2 }, 'both validation attempts timed out');
  const slack = 0.5;
  const allowance = 5; // git, catalog and process start-up
  assert.ok(seconds >= 6 * T - d + 15 - slack, `the worst path ran: ${seconds} s`);
  assert.ok(seconds <= 6 * T + 3 * 5 + allowance, `bounded by 6T + 3 x 5 s + allowance: ${seconds} s`);
  // At the default timeout this bound fits inside the wait the review relays prescribe.
  const { calls } = await run('build', { feature_id: 'f', repo: '/repo', work_branch: 'w', run_dir: '/state/build', review_runner: '/skill/scripts/run-review.js',
    suite_cmd: 'true', security_schema: '/skill/security.schema.json', spec_path: '/state/spec.md' },
  [{ blocked: false, summary: 's', files_changed: ['a.js'], commit: 'a'.repeat(40), base_commit: 'c'.repeat(40) }, STOP]);
  const p = calls[1].prompt;
  const TIMEOUT_S = Number(p.match(/--timeout-seconds (\d+)/)[1]);
  const minutes = Number(p.match(/up to ~(\d+) minutes/)[1]);
  assert.equal(TIMEOUT_S, 1200);
  assert.equal(minutes, Math.ceil(TIMEOUT_S * 6 / 60) + 5);
  assert.ok(6 * TIMEOUT_S + 3 * 5 + allowance <= minutes * 60, 'worst runner path < the relay wait');
  assert.equal(pollLimit(p), Math.ceil(minutes / 9), 'K = ceil(wait minutes / 9)');
});

test('the raw codex exec relays: the hard process timeout fits inside their stated wait', async () => {
  const sha = 'a'.repeat(40);
  const base = 'c'.repeat(40);
  const pinned = { head_before: sha, head_after: sha, status_before: [], status_after: [] };
  const clean = { verdict: 'PASS', verdict_reasons: [], findings: [], model_verdict: 'PASS', outcome: 'ok', unable_to_review: null, validation_outcome: 'skipped',
    run_dir: '/x', result_sha256: digest, codex_available: true, head_sha: sha };
  const b = await run('build', { feature_id: 'f', repo: '/repo', work_branch: 'w', run_dir: '/state/build', review_runner: '/skill/scripts/run-review.js',
    suite_cmd: 'true', security_schema: '/skill/security.schema.json', spec_path: '/state/spec.md' },
  [{ blocked: false, summary: 's', files_changed: ['app.js'], commit: sha, base_commit: base }, { ...clean, changed: [{ status: 'M', path: 'app.js' }] }, STOP]);
  const v = await run('verify', { feature_id: 'f', repo: '/repo', work_branch: 'w', run_dir: '/state/verify', review_runner: '/skill/scripts/run-review.js',
    spec_path: '/state/spec.md', compliance_schema: '/skill/compliance.schema.json', base_commit: base, reviewed_sha: sha, completion_runner: '/skill/scripts/check-completion.js',
    manifest_path: '/state/plan.json', manifest_sha256: digest, build_result_path: '/state/build.json' },
  [{ passed: true, manifest_sha256: digest, spec_sha256: digest, reviewed_sha: sha }, { blocked: false, ledger_path: '/state/verify/acceptance-ledger.json', ...pinned }, clean, STOP]);
  const prompts = [b.calls.find(x => x.options.label === 'codex security 1'), v.calls.find(x => x.options.label === 'codex spec compliance')];
  for (const c of prompts) {
    const [, kill, limit] = c.prompt.match(/timeout --kill-after=(\d+) (\d+) codex exec/).map(Number);
    const minutes = Number(c.prompt.match(/up to ~(\d+) minutes/)[1]);
    assert.ok(limit + kill < minutes * 60, `${c.options.label}: ${limit} + ${kill} s < ${minutes} minutes`);
    assert.equal(pollLimit(c.prompt), Math.ceil(minutes / 9));
  }
});

describe('relay blocks executed against the real runner and the fake codex', { concurrency: true }, () => {
  test('design happy path: both relays wait in the foreground, read this run\'s result and PASS without a fallback', async () => {
    const fx = fixture('design-happy');
    const env = envWith('design-happy', { FAKE_CODEX_DELAY_MS: '1500' });
    const traces = {};
    const relayFor = kind => async (prompt) => {
      const out = path.join(fx.runDir, `${kind}-review-1`);
      traces[kind] = await relay(prompt, env, out, resultOf(out, kind));
      traces[kind].out = out;
      return reviewReply(traces[kind], out, kind);
    };
    const { result, calls } = await run('design', designArgs(fx), many(responder({
      'prd draft': writeDoc(path.join(fx.runDir, 'prd.md'), '# PRD\n'),
      'spec draft': () => { fs.writeFileSync(path.join(fx.runDir, 'execution-plan.json'), '{}\n'); return writeDoc(path.join(fx.runDir, 'spec.md'), '# Spec\n')(); },
      'codex prd review 1': relayFor('prd'), 'codex spec review 1': relayFor('spec'),
      'freeze plan identity': { blocked: false, spec_sha256: digest, manifest_sha256: digest },
    })));
    assert.equal(result.status, 'PASS');
    assert.equal(result.fallback_used, false);
    assert.equal(calls.filter(c => c.options.model === 'opus').length, 0, 'no fallback agent call');
    for (const kind of ['prd', 'spec']) {
      const t = traces[kind];
      assertWaited(t, kind);
      const res = JSON.parse(fs.readFileSync(resultOf(t.out, kind)(), 'utf8'));
      assert.equal(res.verdict, 'PASS');
      assert.deepEqual(await t.started, { code: 0, sig: null }, `${kind}: the runner exited 0`);
      assert.equal(result[kind].reviewer, 'codex');
    }
  });

  test('build happy path: the review and security relays wait, and cleanup leaves no worktree', async () => {
    const fx = fixture('build-happy');
    const env = envWith('build-happy', { FAKE_CODEX_DELAY_MS: '1500' });
    const traces = {};
    const reviewOut = path.join(fx.runDir, 'review-1');
    const secOut = path.join(fx.runDir, 'security-1');
    const { result, calls } = await run('build', buildArgs(fx), many(responder({
      implement: work(fx), 'suite 1': suite(fx),
      'codex review 1': async (prompt) => {
        const t = traces.review = await relay(prompt, env, reviewOut, resultOf(reviewOut, 'implementation'));
        return { ...reviewReply(t, reviewOut, 'implementation'), head_sha: setupHead(t), changed: setupChanged(t) };
      },
      'codex security 1': async (prompt) => {
        traces.prompt = prompt;
        const t = traces.security = await relay(prompt, env, secOut, rawOf(path.join(secOut, 'security.json')));
        return rawReply(t, path.join(secOut, 'security.json'), 'security');
      },
    })));
    assert.equal(result.status, 'PASS');
    assert.equal(result.reviewed_sha, fx.head);
    assert.deepEqual(result.files.sort(), ['app.js', 'new.js']);
    assert.equal(calls.filter(c => c.options.model === 'opus').length, 0, 'no fallback agent call');
    assertWaited(traces.review, 'review');
    assertWaited(traces.security, 'security');
    assert.deepEqual(await traces.review.started, { code: 0, sig: null }, 'the runner exited 0');
    assert.deepEqual(await traces.security.started, { code: 0, sig: null }, 'codex exec exited 0');
    assert.equal(fs.readFileSync(path.join(secOut, 'prompt.md'), 'utf8'), quotedTask(traces.prompt) + '\n', 'prompt.md is the quoted task');
    assert.equal(worktrees(fx.repo).length, 1, 'no worktree of the run remains');
  });

  test('verify happy path: the final review and compliance relays wait and PASS', async () => {
    const fx = fixture('verify-happy');
    const env = envWith('verify-happy', { FAKE_CODEX_DELAY_MS: '1500' });
    const traces = {};
    const finOut = path.join(fx.runDir, 'final-review');
    const compOut = path.join(fx.runDir, 'compliance');
    const { result, calls } = await run('verify', verifyArgs(fx), many(responder({
      'plan preflight': { passed: true, manifest_sha256: digest, spec_sha256: digest, reviewed_sha: fx.head },
      'acceptance proofs': { blocked: false, ledger_path: path.join(fx.runDir, 'acceptance-ledger.json'), ...pinnedAt(fx.repo, fx.head) },
      'codex final review': async (prompt) => {
        const t = traces.final = await relay(prompt, env, finOut, resultOf(finOut, 'implementation'));
        return { ...reviewReply(t, finOut, 'implementation'), head_sha: setupHead(t) };
      },
      'codex spec compliance': async (prompt) => {
        traces.prompt = prompt;
        const t = traces.comp = await relay(prompt, env, compOut, rawOf(path.join(compOut, 'compliance.json')));
        return { ...rawReply(t, path.join(compOut, 'compliance.json'), 'compliance'), ...pinnedAt(fx.repo, fx.head) };
      },
      'completion proof': { passed: true, proof_path: path.join(fx.runDir, 'completion-proof.json'), reviewed_sha: fx.head, manifest_sha256: digest },
    })));
    assert.equal(result.status, 'PASS');
    assert.equal(calls.filter(c => c.options.model === 'opus').length, 0, 'no fallback agent call');
    assertWaited(traces.final, 'final review');
    assertWaited(traces.comp, 'compliance');
    assert.deepEqual(await traces.final.started, { code: 0, sig: null });
    assert.equal(fs.readFileSync(path.join(compOut, 'prompt.md'), 'utf8'), quotedTask(traces.prompt) + '\n', 'prompt.md is the quoted task');
    assert.equal(worktrees(fx.repo).length, 1, 'no worktree of the run remains');
  });

  // ---- the fallback path (the only path the live run takes) ----------------------------
  const probeFails = (t, out) => {
    assert.equal(t.setup.status, 3, 'the probe exits 3 with no codex on PATH');
    assert.match(t.setup.stdout, /GP_CODEX_UNAVAILABLE/);
    assert.ok(!fs.existsSync(out), 'the relay creates no out dir when codex cannot run');
  };
  const fallbackRan = (t, out) => {
    assert.equal(t.setup.status, 0, `fallback setup: ${t.setup.stderr}`);
    assert.equal(t.cleanup.status, 0, `fallback cleanup: ${t.cleanup.stderr}`);
    assert.ok(fs.statSync(out + '-opus').isDirectory(), 'the fallback has its own fresh dir next to the relay\'s');
  };

  test('fallback path, design: the probe fails, the fallback blocks run, the stage PASSes disclosed', async () => {
    const fx = fixture('design-fallback');
    const traces = {};
    const relayFor = kind => async (prompt) => { const t = traces[kind] = await relay(prompt, envWithout(), '/nonexistent', () => null); return reviewReply(t, null, kind); };
    const fbFor = kind => async (prompt) => { traces[kind + '-opus'] = await fallback(prompt, envWithout()); return { findings: [] }; };
    const { result } = await run('design', { ...designArgs(fx), review_fallback: 'opus-high' }, many(responder({
      'prd draft': writeDoc(path.join(fx.runDir, 'prd.md'), '# PRD\n'), 'spec draft': writeDoc(path.join(fx.runDir, 'spec.md'), '# Spec\n'),
      'codex prd review 1': relayFor('prd'), 'codex spec review 1': relayFor('spec'),
      'opus prd review 1 (codex unavailable)': fbFor('prd'), 'opus spec review 1 (codex unavailable)': fbFor('spec'),
      'freeze plan identity': { blocked: false, spec_sha256: digest, manifest_sha256: digest },
    })));
    assert.equal(result.status, 'PASS');
    assert.equal(result.fallback_used, true);
    for (const kind of ['prd', 'spec']) {
      const out = path.join(fx.runDir, `${kind}-review-1`);
      probeFails(traces[kind], out);
      fallbackRan(traces[kind + '-opus'], out);
      assert.equal(result[kind].reviewer, 'claude-opus-high (codex unavailable)');
    }
  });

  test('fallback path, build: review and security fall back, worktrees are removed, the stage PASSes disclosed', async () => {
    const fx = fixture('build-fallback');
    const traces = {};
    const { result } = await run('build', { ...buildArgs(fx), review_fallback: 'opus-high' }, many(responder({
      implement: work(fx), 'suite 1': suite(fx),
      'codex review 1': async (prompt) => { const t = traces.review = await relay(prompt, envWithout(), '/nonexistent', () => null); return { ...reviewReply(t), head_sha: '', changed: [] }; },
      'opus review 1 (codex unavailable)': async (prompt) => {
        const b = gpBlocks(prompt, ['setup', 'cleanup']);
        const setup = await bash(b.setup, envWithout());
        traces.reviewFb = { setup };
        const reply = { findings: [], head_sha: setupHead({ setup }), changed: setupChanged({ setup }) };
        assert.equal(fs.readFileSync(path.join(fx.runDir, 'review-1-opus', 'wt', 'new.js'), 'utf8'), 'module.exports = 3;\n', 'the fallback checkout holds the change');
        traces.reviewFb.cleanup = await bash(b.cleanup, envWithout());
        return reply;
      },
      'codex security 1': async (prompt) => { const t = traces.security = await relay(prompt, envWithout(), '/nonexistent', () => null); return rawReply(t); },
      'opus security 1 (codex unavailable)': async (prompt) => { traces.securityFb = await fallback(prompt, envWithout()); return { verdict: 'PASS', blocking: [] }; },
    })));
    assert.equal(result.status, 'PASS');
    assert.equal(result.fallback_used, true);
    assert.equal(result.reviewed_sha, fx.head);
    probeFails(traces.review, path.join(fx.runDir, 'review-1'));
    probeFails(traces.security, path.join(fx.runDir, 'security-1'));
    fallbackRan(traces.reviewFb, path.join(fx.runDir, 'review-1'));
    fallbackRan(traces.securityFb, path.join(fx.runDir, 'security-1'));
    assert.equal(worktrees(fx.repo).length, 1, 'no worktree of the run remains');
  });

  test('fallback path, verify: final review and compliance fall back and the stage PASSes disclosed', async () => {
    const fx = fixture('verify-fallback');
    const traces = {};
    const { result } = await run('verify', { ...verifyArgs(fx), review_fallback: 'opus-high' }, many(responder({
      'plan preflight': { passed: true, manifest_sha256: digest, spec_sha256: digest, reviewed_sha: fx.head },
      'acceptance proofs': { blocked: false, ledger_path: path.join(fx.runDir, 'acceptance-ledger.json'), ...pinnedAt(fx.repo, fx.head) },
      'codex final review': async (prompt) => { const t = traces.final = await relay(prompt, envWithout(), '/nonexistent', () => null); return { ...reviewReply(t), head_sha: fx.head }; },
      'opus final review (codex unavailable)': async (prompt) => {
        const b = gpBlocks(prompt, ['setup', 'cleanup']);
        const setup = await bash(b.setup, envWithout());
        traces.finalFb = { setup, cleanup: await bash(b.cleanup, envWithout()) };
        return { findings: [], head_sha: setupHead({ setup }) };
      },
      'codex spec compliance': async (prompt) => { const t = traces.comp = await relay(prompt, envWithout(), '/nonexistent', () => null); return { ...rawReply(t), ...pinnedAt(fx.repo, fx.head) }; },
      'opus spec compliance (codex unavailable)': async (prompt) => { traces.compFb = await fallback(prompt, envWithout()); return { verdict: 'PASS', blocking: [], requirements: [], ...pinnedAt(fx.repo, fx.head) }; },
      'completion proof': { passed: true, proof_path: path.join(fx.runDir, 'completion-proof.json'), reviewed_sha: fx.head, manifest_sha256: digest },
    })));
    assert.equal(result.status, 'PASS');
    assert.equal(result.fallback_used, true);
    probeFails(traces.final, path.join(fx.runDir, 'final-review'));
    probeFails(traces.comp, path.join(fx.runDir, 'compliance'));
    fallbackRan(traces.finalFb, path.join(fx.runDir, 'final-review'));
    fallbackRan(traces.compFb, path.join(fx.runDir, 'compliance'));
    assert.equal(worktrees(fx.repo).length, 1, 'no worktree of the run remains');
  });

  // ---- stale results: an existing out dir is never read as this run's ------------------
  const stalePass = dir => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ verdict: 'PASS', outcome: 'ok', findings: [] })); };
  const staleSetup = t => { assert.equal(t.setup.status, 4, 'setup refuses the existing out dir'); assert.match(t.setup.stdout, /GP_OUT_DIR_EXISTS/); };

  test('stale: an existing review out dir holding a PASS result.json blocks build and design before any review', async () => {
    const fx = fixture('stale-review');
    stalePass(path.join(fx.runDir, 'review-1', 'implementation-old'));
    stalePass(path.join(fx.runDir, 'prd-review-1', 'prd-old'));
    const env = envWith('stale-review');
    const traces = {};
    const b = await run('build', buildArgs(fx), many(responder({
      implement: work(fx),
      'codex review 1': async (prompt) => { const t = traces.build = await relay(prompt, env, path.join(fx.runDir, 'review-1'), () => null); return { ...reviewReply(t), head_sha: '', changed: [] }; },
    })));
    assert.equal(b.result.status, 'BLOCKED');
    assert.equal(b.result.stage, 'review');
    staleSetup(traces.build);
    const d = await run('design', { ...designArgs(fx), review_fallback: 'opus-high' }, many(responder({
      'prd draft': writeDoc(path.join(fx.runDir, 'prd.md'), '# PRD\n'),
      'codex prd review 1': async (prompt) => { const t = traces.design = await relay(prompt, env, path.join(fx.runDir, 'prd-review-1'), () => null); return reviewReply(t); },
    })));
    assert.equal(d.result.status, 'BLOCKED');
    assert.equal(d.calls.filter(c => c.options.model === 'opus').length, 0, 'a stale out dir never falls back');
    staleSetup(traces.design);
    assert.ok(!fs.existsSync(path.join(fx.runDir, 'review-1', 'runner.pid')), 'nothing started');
  });

  test('stale: an existing security.json or compliance.json blocks the stage; no stale PASS reaches it', async () => {
    const fx = fixture('stale-raw');
    fs.mkdirSync(path.join(fx.runDir, 'security-1'));
    fs.writeFileSync(path.join(fx.runDir, 'security-1', 'security.json'), JSON.stringify({ verdict: 'PASS', summary: 'old', findings: [] }));
    fs.mkdirSync(path.join(fx.runDir, 'compliance'));
    fs.writeFileSync(path.join(fx.runDir, 'compliance', 'compliance.json'), JSON.stringify({ verdict: 'PASS', summary: 'old', findings: [], requirements: [] }));
    const env = envWith('stale-raw');
    const traces = {};
    const b = await run('build', buildArgs(fx), many(responder({
      implement: work(fx),
      'codex review 1': async (prompt) => {
        const out = path.join(fx.runDir, 'review-1');
        const t = await relay(prompt, env, out, resultOf(out, 'implementation'));
        return { ...reviewReply(t, out, 'implementation'), head_sha: setupHead(t), changed: setupChanged(t) };
      },
      'codex security 1': async (prompt) => { const t = traces.sec = await relay(prompt, env, path.join(fx.runDir, 'security-1'), () => null); return rawReply(t); },
    })));
    assert.equal(b.result.status, 'BLOCKED');
    assert.equal(b.result.stage, 'security');
    staleSetup(traces.sec);
    const v = await run('verify', verifyArgs(fx), many(responder({
      'plan preflight': { passed: true, manifest_sha256: digest, spec_sha256: digest, reviewed_sha: fx.head },
      'acceptance proofs': { blocked: false, ledger_path: path.join(fx.runDir, 'acceptance-ledger.json'), ...pinnedAt(fx.repo, fx.head) },
      'codex final review': async (prompt) => {
        const out = path.join(fx.runDir, 'final-review');
        const t = await relay(prompt, env, out, resultOf(out, 'implementation'));
        return { ...reviewReply(t, out, 'implementation'), head_sha: setupHead(t) };
      },
      'codex spec compliance': async (prompt) => { const t = traces.comp = await relay(prompt, env, path.join(fx.runDir, 'compliance'), () => null); return { ...rawReply(t), ...pinnedAt(fx.repo, fx.head) }; },
    })));
    assert.equal(v.result.status, 'BLOCKED');
    assert.equal(v.result.stage, 'compliance');
    staleSetup(traces.comp);
    assert.equal(worktrees(fx.repo).length, 1, 'the review relays cleaned up; the refused setups made no worktree');
  });

  test('stale: an existing fallback dir blocks the fallback review too', async () => {
    const fx = fixture('stale-fallback');
    fs.mkdirSync(path.join(fx.runDir, 'prd-review-1-opus'));
    const traces = {};
    const { result } = await run('design', { ...designArgs(fx), review_fallback: 'opus-high' }, many(responder({
      'prd draft': writeDoc(path.join(fx.runDir, 'prd.md'), '# PRD\n'),
      'codex prd review 1': async (prompt) => reviewReply(await relay(prompt, envWithout(), '/nonexistent', () => null)),
      'opus prd review 1 (codex unavailable)': async (prompt) => {
        const t = traces.fb = await fallback(prompt, envWithout());
        return t.setup.status === 0 ? { findings: [] } : { findings: [], blocked: true, note: t.setup.stdout };
      },
    })));
    assert.equal(result.status, 'BLOCKED');
    staleSetup(traces.fb);
  });

  // ---- the deadline path: no result within K polls ---------------------------------------
  test('deadline: after K polls without a result the relay reports ERROR, the stage BLOCKS without Opus, and cleanup stops the run', async () => {
    const fx = fixture('deadline');
    const state = path.join(WORK, 'fake-state-deadline');
    const env = envWith('deadline', { FAKE_CODEX_STATE: state, FAKE_CODEX_PLAN: JSON.stringify({ review: [{ delay_ms: 600000, ignore_term: true }] }) });
    const out = path.join(fx.runDir, 'review-1');
    const traces = {};
    const { result, calls } = await run('build', { ...buildArgs(fx), review_fallback: 'opus-high' }, many(responder({
      implement: work(fx),
      'codex review 1': async (prompt) => {
        const b = gpBlocks(prompt, ['setup', 'start', 'poll', 'cleanup']);
        const t = traces.t = { K: pollLimit(prompt), polls: [], events: [] };
        t.setup = await bash(b.setup, env);
        const start = spawn('bash', ['-c', b.start], { env, detached: true, stdio: 'ignore' });
        t.started = new Promise(r => start.on('exit', (code, sig) => r({ code, sig })));
        t.runnerPid = await readPid(path.join(out, 'runner.pid'));
        t.fakePid = await readPid(path.join(state, 'review-1.pid'));
        const poll = shortPoll(b.poll);
        for (let i = 0; i < t.K; i++) t.polls.push((await bash(poll, env)).status);
        t.aliveAtDeadline = { runner: alive(t.runnerPid), fake: alive(t.fakePid) };
        const c0 = Date.now();
        t.cleanup = await bash(b.cleanup, env);
        t.cleanupSeconds = (Date.now() - c0) / 1000;
        t.fakeAfterCleanup = alive(t.fakePid);
        return { ...reviewReply(t), head_sha: setupHead(t), changed: setupChanged(t) };
      },
    })));
    const t = traces.t;
    assert.deepEqual(t.polls, Array(t.K).fill(1), `all ${t.K} polls exit 1`);
    assert.deepEqual(t.aliveAtDeadline, { runner: true, fake: true });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.stage, 'review');
    assert.equal(result.review.verdict, 'ERROR');
    assert.match(result.review.note, /no result after \d+ polls; run folder:/);
    assert.equal(calls.filter(c => c.options.model === 'opus').length, 0, 'no Opus call: codex is available');
    assert.equal(t.fakeAfterCleanup, false, 'the fake codex is gone after cleanup');
    assert.ok(t.cleanupSeconds <= 10, `cleanup finished within its 10 s wait (${t.cleanupSeconds} s; the runner's grace is 5 s)`);
    const res = JSON.parse(fs.readFileSync(resultOf(out, 'implementation')(), 'utf8'));
    assert.equal(res.outcome, 'interrupted');
    assert.equal(res.verdict, 'NEEDS_HUMAN');
    const log = fs.readFileSync(path.join(out, 'codex-review-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].outcome, 'interrupted');
    assert.equal((await t.started).code, 3, 'the runner recorded the interruption and exited 3');
    assert.ok(!fs.readdirSync(path.dirname(resultOf(out, 'implementation')())).some(x => x.includes('.tmp-')), 'no partial result file');
    assert.equal(worktrees(fx.repo).length, 1, 'the worktree is gone');
  });

  test('SIGKILL to the runner orphans the fake codex (documented): nothing can record it, the test kills the orphan', async (t) => {
    const state = path.join(WORK, 'fake-state-sigkill');
    const out = path.join(WORK, 'out-sigkill');
    const env = envWith('sigkill', { FAKE_CODEX_STATE: state, FAKE_CODEX_PLAN: JSON.stringify({ review: [{ delay_ms: 600000 }] }) });
    const doc = path.join(WORK, 'sigkill.md');
    fs.writeFileSync(doc, 'x\n');
    const runner = spawn(process.execPath, [RUNNER, '--kind', 'implementation', '--files', doc, '--repo', WORK, '--out-dir', out, '--timeout-seconds', '600'], { env, stdio: 'ignore' });
    const exited = new Promise(r => runner.on('exit', (code, sig) => r({ code, sig })));
    const fakePid = await readPid(path.join(state, 'review-1.pid'));
    runner.kill('SIGKILL');
    assert.deepEqual(await exited, { code: null, sig: 'SIGKILL' });
    await sleep(300);
    const orphan = alive(fakePid);
    assert.equal(orphan, true, 'the fake codex survives a SIGKILL of the runner (own process group)');
    assert.ok(!fs.existsSync(path.join(fs.readdirSync(out).map(x => path.join(out, x)).find(x => x.includes('implementation-')), 'result.json')), 'no result was recorded');
    process.kill(-fakePid, 'SIGKILL');
    t.diagnostic(`SIGKILL case: orphaned fake codex pid ${fakePid} survived the runner and was killed by the test`);
  });
});
