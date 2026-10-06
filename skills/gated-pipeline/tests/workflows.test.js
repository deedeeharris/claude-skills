'use strict';

// Exercise the actual Workflow scripts. Only the unavailable hosted agent boundary
// is scripted; all stage decisions, argument checks and transitions run unchanged.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const base = 'c'.repeat(40);
const proof = '/state/verify/completion-proof.json';
const landArgs = {
  feature_id: 'feature', repo: '/repo', work_branch: 'feature/test', trunk_branch: 'main',
  title: 'Feature', body_path: '/state/body.md', reviewed_sha: sha,
  completion_runner: '/skill/scripts/check-completion.js', manifest_path: '/state/execution-plan.json',
  manifest_sha256: digest, spec_path: '/state/spec.md', build_result_path: '/state/build/result.json',
  verify_result_path: '/state/verify/verify-result.json', proof_path: proof,
};
const gate = { passed: true, reviewed_sha: sha, manifest_sha256: digest, proof_path: proof, state_paths: [] };
const pr = { blocked: false, url: 'https://github.com/o/r/pull/1', number: 1, head_sha: sha };
const ci = { state: 'GREEN', failing: [], head_sha: sha, checks_head_sha: sha, rerun_done: false };

async function run(name, args, replies) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'workflows', name + '.js'), 'utf8')
    .replace('export const meta =', 'const meta =');
  const calls = [];
  const execute = new AsyncFunction('args', 'agent', 'phase', 'log', source);
  const result = await execute(args, async (prompt, options) => {
    calls.push({ prompt, options });
    assert.ok(replies.length, 'unexpected agent invocation: ' + options.label);
    return replies.shift();
  }, () => {}, () => {});
  return { result, calls };
}

test('land refuses absent completion inputs before any PR side effect', async () => {
  const { completion_runner, manifest_path, manifest_sha256, build_result_path,
    verify_result_path, proof_path, spec_path, ...oldArgs } = landArgs;
  const { result, calls } = await run('land', oldArgs, []);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 0);
});

test('failed completion validation blocks land before opening a PR', async () => {
  const { result, calls } = await run('land', landArgs, [{ ...gate, passed: false, reason: 'missing AC-2' }]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes("node '/skill/scripts/check-completion.js'"));
});

test('a proof for another reviewed commit cannot reach the PR step', async () => {
  const { result, calls } = await run('land', landArgs, [{ ...gate, reviewed_sha: base }]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes("node '/skill/scripts/check-completion.js'"));
});

test('a validated completion still follows the existing PR and CI gates', async () => {
  const { result, calls } = await run('land', landArgs, [gate, pr, ci]);
  assert.equal(result.status, 'READY_FOR_HUMAN_MERGE');
  assert.equal(calls.length, 3);
  assert.equal(result.completion.proof_path, proof);
});

test('head movement after proof validation still invalidates readiness', async () => {
  const { result } = await run('land', landArgs, [gate, { ...pr, head_sha: base, reviewed_is_ancestor: true, files_after_review: ['code.js'] }]);
  assert.equal(result.status, 'HEAD_MOVED');
});

test('land cannot widen the frozen state allowance through mutable arguments', async () => {
  const { result, calls } = await run('land', { ...landArgs, state_paths: ['src/'] }, [gate]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 1);
});

const verifyArgs = {
  feature_id: 'feature', repo: '/repo', work_branch: 'feature/test', run_dir: '/state/verify',
  review_runner: '/skill/run-review.js', spec_path: '/state/spec.md', compliance_schema: '/skill/compliance.schema.json',
  base_commit: base, reviewed_sha: sha, completion_runner: '/skill/scripts/check-completion.js',
  manifest_path: '/state/execution-plan.json', manifest_sha256: digest, build_result_path: '/state/build/result.json',
};
const pinned = { head_before: sha, head_after: sha, status_before: [], status_after: [] };
const preflight = { passed: true, manifest_sha256: digest, spec_sha256: 'd'.repeat(64), reviewed_sha: sha };
const finalReview = { verdict: 'PASS', confirmed_findings: [], head_sha: sha };
const compliance = { verdict: 'PASS', blocking: [], requirements: [], ...pinned };
const proofs = { blocked: false, ledger_path: '/state/verify/acceptance-ledger.json', ...pinned };

test('empty extra checks still run the mandatory completion gate', async () => {
  const { result, calls } = await run('verify', verifyArgs, [preflight, proofs, finalReview, compliance, gate]);
  assert.equal(result.status, 'PASS');
  assert.equal(calls.length, 5);
  assert.equal(result.completion.proof_path, proof);
  assert.equal(result.feature_id, 'feature');
  assert.equal(result.manifest_sha256, digest);
});

test('unproven acceptance prevents verify PASS despite clean reviews', async () => {
  const { result } = await run('verify', verifyArgs, [preflight, proofs, finalReview, compliance, { ...gate, passed: false, reason: 'missing runtime output' }]);
  assert.equal(result.status, 'INCOMPLETE');
});

test('verify requires frozen plan identity before launching checks', async () => {
  const { manifest_sha256, ...noIdentity } = verifyArgs;
  const { result, calls } = await run('verify', noIdentity, []);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 0);
});

test('failed configured check never reaches completion or PR readiness', async () => {
  const { result, calls } = await run('verify', { ...verifyArgs, checks: [{ name: 'smoke', how: 'run smoke' }] },
    [preflight, { status: 'NOT_RUN', observed: 'no budget', evidence_path: '/state/check.txt', ...pinned }, proofs, finalReview, compliance]);
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(calls.length, 5);
});

test('frozen-plan drift blocks verify before executing any checks or acceptance commands', async () => {
  const { result, calls } = await run('verify', { ...verifyArgs, checks: [{ name: 'smoke', how: 'run smoke' }] },
    [{ ...preflight, passed: false, reason: 'manifest changed' }]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes('--mode plan'));
});

test('design reviews acceptance inventory together with the spec and freezes its identity', async () => {
  const review = { verdict: 'PASS', confirmed_findings: [], verdict_reasons: [], other_findings: [] };
  const { result, calls } = await run('design', {
    feature_id: 'feature', repo: '/repo', task: 'Build a feature', run_dir: '/state/design',
    review_runner: '/skill/run-review.js', execution_schema: '/skill/execution-plan.schema.json',
  }, [{ blocked: false }, review, { blocked: false }, review,
    { blocked: false, spec_sha256: 'd'.repeat(64), manifest_sha256: digest }]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.manifest_path, '/state/design/execution-plan.json');
  assert.equal(result.manifest_sha256, digest);
  assert.ok(calls[3].prompt.includes("--files '/state/design/spec.md' '/state/design/execution-plan.json'"));
});
