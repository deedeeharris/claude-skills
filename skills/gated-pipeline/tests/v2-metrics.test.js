'use strict';

// tests/helpers/v2-metrics.js (plan 3.1 row 5.5): the metric list over a design run dir built by the real scripts
// (v2-repo helper: rev-1 snapshot, PRD and spec PASS records, design commit, frozen compile).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { makeRepo, baseFeature, featureBytes, REPO_PATH } = require('./helpers/v2-repo.js');
const { gitEnv } = require('./helpers/git-env.js');
const { computeMetrics } = require('./helpers/v2-metrics.js');

const statuses = m => Object.fromEntries(m.checks.map(c => [c.id, c.status]));

test('a frozen happy-path design run: one authoritative file, no shadow/duplicate/unresolved ids, consistent hashes, one round per gate', t => {
  const c = makeRepo(t).freeze();
  const m = computeMetrics({ runDir: c.run, repo: c.repo, commit: c.designCommit });
  assert.deepEqual(statuses(m), { authoritative_files: 'PASS', shadow_requirements: 'PASS', duplicate_requirements: 'PASS',
    unresolved_references: 'PASS', approval_hash_consistency: 'PASS', approvals_validator: 'PASS', reviewer_rounds: 'PASS' });
  assert.deepEqual(m.summary, { PASS: 7, FAIL: 0, NOT_RUN: 0 });
  assert.deepEqual(m.metrics.authoritative_files.files, [REPO_PATH]);
  assert.equal(m.metrics.approval_hash_consistency.records, 2);
  assert.equal(m.metrics.approval_hash_consistency.consistent_records, 2);
  assert.equal(m.metrics.approval_hash_consistency.frozen_matches_final, true);
  assert.equal(m.metrics.approval_hash_consistency.committed_matches_final, true);
  assert.deepEqual(m.metrics.reviewer_rounds.by_gate, { prd: { rounds: 1, verdicts: ['PASS'], reviewers: ['codex'] }, spec: { rounds: 1, verdicts: ['PASS'], reviewers: ['codex'] } });
  assert.deepEqual(m.revisions.map(r => [r.rev, r.valid, r.compiled, r.requirements]), [[1, true, true, 1]]);

  // the CLI prints the same object
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'v2-metrics.js'), '--run-dir', c.run, '--repo', c.repo, '--commit', c.designCommit], { encoding: 'utf8', env: gitEnv() });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), JSON.parse(JSON.stringify(m)));
});

test('a later revision with a shadow id and an unresolved reference, an edited view and a missing repo show up as FAIL and NOT_RUN', t => {
  const c = makeRepo(t).freeze();
  // rev-2: a shadow check id and an unresolved depends_on (written by hand: the snapshot script would refuse it)
  const f = baseFeature();
  f.checks[0].id = 'CHECK-LINT-FIX';
  f.requirements[0].depends_on = ['NOPE-001'];
  fs.mkdirSync(path.join(c.run, 'rev-2'));
  fs.writeFileSync(path.join(c.run, 'rev-2', 'feature.json'), featureBytes(f));
  fs.appendFileSync(path.join(c.revDir(1), 'out', 'spec.view.md'), 'edited after the review\n');

  const m = computeMetrics({ runDir: c.run });
  const s = statuses(m);
  assert.equal(s.shadow_requirements, 'FAIL');
  assert.equal(s.unresolved_references, 'FAIL');
  assert.equal(s.duplicate_requirements, 'PASS');
  assert.equal(s.approval_hash_consistency, 'FAIL');
  assert.equal(s.authoritative_files, 'NOT_RUN');
  assert.equal(s.approvals_validator, 'NOT_RUN');
  assert.ok(m.metrics.shadow_requirements.final >= 1 && m.metrics.shadow_requirements.per_rev[1] === 0);
  assert.ok(m.metrics.unresolved_references.final >= 1);
  assert.ok(m.metrics.approval_hash_consistency.problems.some(p => /record 1 \(spec rev-1\): out\/spec\.view\.md sha256: differs/.test(p)), m.metrics.approval_hash_consistency.problems.join('\n'));
  assert.deepEqual(m.revisions.map(r => [r.rev, r.valid]), [[1, true], [2, false]]);
  assert.deepEqual(m.summary, { PASS: 2, FAIL: 3, NOT_RUN: 2 });
});
