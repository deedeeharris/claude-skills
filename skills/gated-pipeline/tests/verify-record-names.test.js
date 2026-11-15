#!/usr/bin/env node
'use strict';

// workflows/verify.js contract 2 accepts both spellings of a run-frozen record name: <target>.record.json on POSIX and,
// with the target's ':' as '_', on Windows (scripts/lib/frozen-files.js). The workflow cannot see the OS. MOCKED at
// the agent boundary only: every reply is scripted, nothing runs, and the paths are never touched.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { run, STOP } = require('./helpers/run-workflow.js');

const SHA = 'a'.repeat(40), DESIGN = 'b'.repeat(40), MANIFEST = 'c'.repeat(64), APPROVALS = 'd'.repeat(64);
const ROOT = '/c/gp-names';
const RUN = `${ROOT}/run/verify`;
const ARGS = {
  contract: 2, feature_id: 'greet', repo: `${ROOT}/repo`, work_branch: 'feature/greet', run_dir: RUN, review_runner: `${ROOT}/skills/codex-review/scripts/run-review.js`,
  spec_path: `${ROOT}/repo/.pipeline/features/greet.feature.json`, compliance_schema: `${ROOT}/skills/gated-pipeline/schemas/compliance.schema.json`,
  manifest_path: `${ROOT}/run/frozen/execution-plan.json`, manifest_sha256: MANIFEST, build_result_path: `${ROOT}/run/build/build-result.json`,
  completion_runner: `${ROOT}/skills/gated-pipeline/scripts/check-completion.js`, frozen_dir: `${ROOT}/run/frozen`, design_commit: DESIGN,
  approvals_path: `${ROOT}/run/approvals-1.json`, approvals_sha256: APPROVALS, base_commit: DESIGN, reviewed_sha: SHA,
};
const PLAN = {
  mode: 'plan', status: 'PASS', manifest_version: 2, contract: 2, manifest_sha256: MANIFEST, reviewed_sha: SHA, design_commit: DESIGN, approvals_sha256: APPROVALS,
  checks: [{ id: 'CHECK-LINT', name: 'Lint', quiet: false, effort: 'low', budget_min: 0, timeout_min: 1 }],
  runtime_acceptance_ids: ['HELLO-001-AC1'], live_acceptances: [], negative_controls: [], clean_ignore: [],
  limits: { proof_timeout_s: 60, negative_controls_total_min: 5 }, suite_setup: false,
};
const recordAt = (file, target) => ({ target, head_before: SHA, head_after: SHA, status_before: [], status_after: [], exit_code: 0, timed_out: false, setup: null, record_path: file });
const line = file => JSON.stringify({ record_path: file, record_sha256: 'e'.repeat(64), exit_code: 0, timed_out: false, setup_exit_code: null });

async function verifyUntilProofs(checkReply, readbackReply) {
  const replies = [{ stdout: JSON.stringify(PLAN) + '\n', exit_code: 0 }, checkReply];
  if (readbackReply) replies.push(readbackReply);
  replies.push(() => STOP);
  const { calls } = await run('verify', ARGS, replies);
  return calls.map(c => c.options.label);
}

test('when the check reply prints the record line with the win32 name check_<ID>.record.json, verify accepts it and goes on to the proofs', async () => {
  const labels = await verifyUntilProofs({ stdout: line(`${RUN}/frozen-runs/check_CHECK-LINT.record.json`) + '\n', exit_code: 0 });
  assert.deepEqual(labels, ['plan preflight', 'check CHECK-LINT', 'acceptance proofs 1']);
});

test('when the check reply prints the POSIX name check:<ID>.record.json, verify accepts it with no readback, as before', async () => {
  const labels = await verifyUntilProofs({ stdout: line(`${RUN}/frozen-runs/check:CHECK-LINT.record.json`) + '\n', exit_code: 0 });
  assert.deepEqual(labels, ['plan preflight', 'check CHECK-LINT', 'acceptance proofs 1']);
});

test('when the check reply lacks the line and only the win32 name exists on disk, the one readback reads it back and verify goes on', async () => {
  const file = `${RUN}/frozen-runs/check_CHECK-LINT.record.json`;
  const readback = (prompt) => {
    assert.ok(prompt.includes(`test -f '${file}'`), 'the readback block also tries the win32 name');
    return { stdout: `${'f'.repeat(64)}  ${file}\n${JSON.stringify(recordAt(file, 'check:CHECK-LINT'))}\n`, exit_code: 0 };
  };
  const labels = await verifyUntilProofs({ stdout: 'the check ran\n', exit_code: 0 }, readback);
  assert.deepEqual(labels, ['plan preflight', 'check CHECK-LINT', 'readback check CHECK-LINT', 'acceptance proofs 1']);
});

test('when the proof batch prints the win32 name proof_<ID>.record.json and the ledger hash, verify accepts the proof with no readback', async () => {
  const replies = [{ stdout: JSON.stringify(PLAN) + '\n', exit_code: 0 },
    { stdout: line(`${RUN}/frozen-runs/check:CHECK-LINT.record.json`) + '\n', exit_code: 0 },
    { stdout: line(`${RUN}/frozen-runs/proof_HELLO-001-AC1.record.json`) + `\n${'9'.repeat(64)}  ${RUN}/acceptance-ledger.json\n`, exit_code: 0 },
    () => STOP];
  const { calls } = await run('verify', ARGS, replies);
  const labels = calls.map(c => c.options.label);
  assert.equal(labels[2], 'acceptance proofs 1');
  assert.ok(labels.length === 4 && !labels[3].startsWith('readback'), labels.join(', '));
});
