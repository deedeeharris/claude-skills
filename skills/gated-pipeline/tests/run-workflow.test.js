'use strict';

// The mocked Workflow harness itself (tests/helpers/run-workflow.js, plan 1b and WP1): every
// scripted reply is validated against the schema its agent call declares, with schema-lite, so a
// mocked test cannot feed a workflow a reply the hosted Workflow tool would refuse.
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, STOP, STOPPED } = require('./helpers/run-workflow');

const sha = 'a'.repeat(40);
const base = 'c'.repeat(40);
const digest = 'b'.repeat(64);

// A minimal workflow script (same calling convention as the real ones) with one schema'd call.
const OBJ = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
const one = schema => ({ source: `const r = await agent('p', { label: 'one', schema: ${JSON.stringify(schema)} })\nreturn { got: r }` });

test('a conforming reply reaches the workflow unchanged', async () => {
  const { result, calls } = await run('x', {}, [{ n: 1 }], one(OBJ));
  assert.deepEqual(result, { got: { n: 1 } });
  assert.equal(calls.length, 1);
});

test('a reply that breaks its schema fails the run', async () => {
  await assert.rejects(run('x', {}, [{ n: 'one' }], one(OBJ)), /"one": scripted reply does not conform/);
  await assert.rejects(run('x', {}, [{}], one(OBJ)), /"one": scripted reply does not conform/);
});

test('a function reply is awaited before it is validated', async () => {
  await assert.rejects(run('x', {}, [async () => ({ n: 1.5 })], one(OBJ)), /does not conform/);
  const { result } = await run('x', {}, [async () => ({ n: 2 })], one(OBJ));
  assert.deepEqual(result, { got: { n: 2 } });
});

test('a schema outside the schema-lite subset is a setup error that fails the run', async () => {
  for (const schema of [{ type: 'object', anyOf: [] }, { type: 'object', additionalProperties: { type: 'string' } }, { $ref: '#/$defs/missing' }]) {
    await assert.rejects(run('x', {}, [{ n: 1 }], one(schema)), /its schema is not a schema-lite schema/);
  }
});

test('nonConforming: a declared out-of-schema reply passes through, a conforming one fails the run', async () => {
  const { result } = await run('x', {}, [{ legacy: true }], { ...one(OBJ), nonConforming: ['one'] });
  assert.deepEqual(result, { got: { legacy: true } });
  await assert.rejects(run('x', {}, [{ n: 1 }], { ...one(OBJ), nonConforming: ['one'] }), /declared nonConforming, but its reply conforms/);
});

test('STOP ends the run at that call without handing the workflow a reply', async () => {
  const { result, calls } = await run('x', {}, [STOP], one(OBJ));
  assert.equal(result, STOPPED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.label, 'one');
});

// The schemas the four workflows declare compile under the subset: the land happy path and a
// verify run with a configured check reach the calls the parity and relay-wait tests do not
// (completion proof, open PR, CI, the check call), each validated by the helper.
test('land: the completion, PR and CI schemas compile and the happy-path replies conform', async () => {
  const proof = '/state/verify/completion-proof.json';
  const args = {
    feature_id: 'feature', repo: '/repo', work_branch: 'feature/test', trunk_branch: 'main',
    title: 'Feature', body_path: '/state/body.md', reviewed_sha: sha,
    completion_runner: '/skill/scripts/check-completion.js', manifest_path: '/state/execution-plan.json',
    manifest_sha256: digest, spec_path: '/state/spec.md', build_result_path: '/state/build/result.json',
    verify_result_path: '/state/verify/verify-result.json', proof_path: proof,
  };
  const gate = { passed: true, reviewed_sha: sha, manifest_sha256: digest, proof_path: proof, state_paths: [] };
  const pr = { blocked: false, url: 'https://github.com/o/r/pull/1', number: 1, head_sha: sha };
  const ci = { state: 'GREEN', failing: [], head_sha: sha, checks_head_sha: sha, rerun_done: false };
  const { result, calls } = await run('land', args, [gate, pr, ci]);
  assert.equal(result.status, 'READY_FOR_HUMAN_MERGE');
  assert.deepEqual(calls.map(c => c.options.label), ['completion proof', 'open PR', 'CI 1']);
  assert.ok(calls.every(c => c.options.schema), 'every land call declares a schema');
});

test('verify: the configured-check schema compiles and a passing check reply conforms', async () => {
  const pinned = { head_before: sha, head_after: sha, status_before: [], status_after: [] };
  const args = {
    feature_id: 'feature', repo: '/repo', work_branch: 'feature/test', run_dir: '/state/verify',
    review_runner: '/skill/run-review.js', spec_path: '/state/spec.md', compliance_schema: '/skill/compliance.schema.json',
    base_commit: base, reviewed_sha: sha, completion_runner: '/skill/scripts/check-completion.js',
    manifest_path: '/state/execution-plan.json', manifest_sha256: digest, build_result_path: '/state/build/result.json',
    checks: [{ name: 'smoke', how: 'run smoke' }],
  };
  const preflight = { passed: true, manifest_sha256: digest, spec_sha256: 'd'.repeat(64), reviewed_sha: sha };
  const check = { status: 'PASS', observed: 'ok', evidence_path: '/state/verify/smoke.txt', evidence_sha256: digest, ...pinned };
  const { calls } = await run('verify', args, [preflight, check, STOP]);
  assert.deepEqual(calls.map(c => c.options.label), ['plan preflight', 'smoke', 'acceptance proofs']);
});
