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

test('when codex ran the compliance trace, completion restores its evidence before the validator', async () => {
  const { calls } = await run('verify', verifyArgs, [preflight, proofs, finalReview, compliance, gate]);
  const prompt = calls[4].prompt;
  assert.ok(prompt.includes("node '/skill/scripts/merge-compliance.js' --verify-result '/state/verify/verify-result.json' --compliance '/state/verify/compliance/compliance.json'"));
  assert.ok(prompt.indexOf('merge-compliance.js') < prompt.indexOf("node '/skill/scripts/check-completion.js'"));
});

test('when the opus fallback ran the compliance trace, completion has no codex file to merge', async () => {
  const { calls } = await run('verify', { ...verifyArgs, review_fallback: 'opus-high' },
    [preflight, proofs, finalReview, { codex_available: false, ...pinned }, compliance, gate]);
  assert.equal(calls.length, 6);
  assert.ok(!calls[5].prompt.includes('merge-compliance.js'));
  assert.ok(calls[5].prompt.includes("node '/skill/scripts/check-completion.js'"));
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

// --- codex relays wait in the foreground; Opus fallback only when codex is not available ---
const FALLBACK_REVIEWER = 'claude-opus-high (codex unavailable)';
const designArgs = {
  feature_id: 'feature', repo: '/repo', task: 'Build a feature', run_dir: '/state/design',
  review_runner: '/skill/run-review.js', execution_schema: '/skill/execution-plan.schema.json',
};
const docReview = { verdict: 'PASS', confirmed_findings: [], verdict_reasons: [], other_findings: [], codex_available: true };
const freeze = { blocked: false, spec_sha256: 'd'.repeat(64), manifest_sha256: digest };
const unavailable = { verdict: 'ERROR', confirmed_findings: [], verdict_reasons: [], other_findings: [], codex_available: false, note: 'codex: command not found' };
const buildArgs = {
  feature_id: 'feature', repo: '/repo', work_branch: 'feature/test', run_dir: '/state/build',
  review_runner: '/skill/run-review.js', suite_cmd: 'npm test', security_schema: '/skill/security.schema.json',
  spec_path: '/state/spec.md',
};
const work = { blocked: false, summary: 'done', files_changed: ['app.js'], commit: sha, base_commit: base };
const codeReview = { verdict: 'PASS', confirmed_findings: [], head_sha: sha, changed: [{ status: 'M', path: 'app.js' }], verdict_reasons: [], other_findings: [], codex_available: true };
const secPass = { verdict: 'PASS', blocking: [], codex_available: true };
const suitePass = { passed: true, counts: '3 passed', failures: [], completed: true, other_failures: [], log_path: '/state/build/suite-1.txt', log_sha256: digest, ...pinned };
const isCodexRelay = c => /^codex /.test(c.options.label);

test('no workflow tells a relay to run codex in the background and poll', () => {
  for (const name of ['design', 'build', 'verify', 'land']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'workflows', name + '.js'), 'utf8');
    assert.ok(!source.includes('run it in the background and poll'), name + ' still has the old wait wording');
    assert.ok(!/in the background, then poll/.test(source), name + ' still has the old codex exec wait wording');
  }
});

test('when design runs, every codex relay waits in the foreground and never returns early', async () => {
  const { calls } = await run('design', designArgs, [{ blocked: false }, docReview, { blocked: false }, docReview, freeze]);
  const relays = calls.filter(isCodexRelay);
  assert.equal(relays.length, 2);
  for (const c of relays) {
    assert.ok(c.prompt.includes('WAIT IN THE FOREGROUND'), c.options.label);
    assert.ok(c.prompt.includes('Bash timeout 600000 ms'), c.options.label);
    assert.ok(c.prompt.includes('for i in $(seq 1 54)'), c.options.label);
    assert.ok(c.prompt.includes('NEVER return'), c.options.label);
    assert.ok(c.prompt.includes('codex --version'), c.options.label);
  }
});

test('when build runs, the review and security relays wait in the foreground', async () => {
  const { result, calls } = await run('build', buildArgs, [work, codeReview, secPass, suitePass]);
  assert.equal(result.status, 'PASS');
  const relays = calls.filter(isCodexRelay);
  assert.deepEqual(relays.map(c => c.options.label), ['codex review 1', 'codex security 1']);
  for (const c of relays) {
    assert.ok(c.prompt.includes('WAIT IN THE FOREGROUND'), c.options.label);
    assert.ok(c.prompt.includes('NEVER return'), c.options.label);
    assert.ok(c.prompt.includes('codex --version'), c.options.label);
  }
  assert.ok(relays[1].prompt.includes("ls '/state/build/security-1/security.json'"));
  assert.equal(result.review.reviewer, 'codex');
  assert.equal(result.security.reviewer, 'codex');
});

test('when verify runs, the final review and compliance relays wait in the foreground', async () => {
  const { result, calls } = await run('verify', verifyArgs, [preflight, proofs, { ...finalReview, codex_available: true }, { ...compliance, codex_available: true }, gate]);
  assert.equal(result.status, 'PASS');
  const relays = calls.filter(isCodexRelay);
  assert.deepEqual(relays.map(c => c.options.label), ['codex final review', 'codex spec compliance']);
  for (const c of relays) {
    assert.ok(c.prompt.includes('WAIT IN THE FOREGROUND'), c.options.label);
    assert.ok(c.prompt.includes('NEVER return'), c.options.label);
  }
  assert.ok(relays[1].prompt.includes("ls '/state/verify/compliance/compliance.json'"));
});

test('when review_fallback is not none or opus-high, every stage returns BLOCKED before any agent runs', async () => {
  for (const [name, args] of [['design', designArgs], ['build', buildArgs], ['verify', verifyArgs]]) {
    const { result, calls } = await run(name, { ...args, review_fallback: 'sonnet' }, []);
    assert.equal(result.status, 'BLOCKED', name);
    assert.match(result.reason, /review_fallback/, name);
    assert.equal(calls.length, 0, name);
  }
});

test('when codex is unavailable and review_fallback is opus-high, design reviews with Opus high and labels it', async () => {
  const opusPass = { findings: [] };
  const { result, calls } = await run('design', { ...designArgs, review_fallback: 'opus-high' },
    [{ blocked: false }, unavailable, opusPass, { blocked: false }, unavailable, opusPass, freeze]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.prd.reviewer, FALLBACK_REVIEWER);
  assert.equal(result.spec.reviewer, FALLBACK_REVIEWER);
  const opus = calls.filter(c => c.options.model === 'opus');
  assert.equal(opus.length, 2);
  for (const c of opus) assert.equal(c.options.effort, 'high');
  assert.ok(opus[1].prompt.includes('/state/design/execution-plan.json'), 'spec fallback keeps the inventory in scope');
  assert.ok(opus[1].prompt.includes('/state/design/prd.md'), 'spec fallback reviews against the PRD');
});

test('when codex is unavailable and review_fallback is none, design returns BLOCKED without an Opus review', async () => {
  const { result, calls } = await run('design', designArgs, [{ blocked: false }, unavailable]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 2);
  assert.match(result.prd.review.note, /review_fallback is none/);
});

test('when codex is capped, opus-high does not fall back and design returns BLOCKED', async () => {
  const capped = { ...unavailable, codex_available: true, note: 'usage limit reached' };
  const { result, calls } = await run('design', { ...designArgs, review_fallback: 'opus-high' }, [{ blocked: false }, capped]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(c => c.options.model === 'opus'));
});

const blockedUnavailable = { ...unavailable, blocked: true, note: 'git worktree add was refused' };
const opusFinding = { severity: 'MAJOR', confidence: 0.9, iso_property: 'incomplete', location: 'x', title: 'gap', detail: 'd' };

test('when design round 1 is an Opus fallback and round 2 a codex PASS, the result still discloses the Opus round', async () => {
  const opusFail = { findings: [opusFinding] };
  const { result, calls } = await run('design', { ...designArgs, review_fallback: 'opus-high' },
    [{ blocked: false }, unavailable, opusFail, { blocked: false }, docReview, { blocked: false }, docReview, freeze]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.prd.reviewer, 'codex');
  assert.equal(result.fallback_used, true);
  assert.deepEqual(result.reviewers, [
    { step: 'prd review 1', reviewer: FALLBACK_REVIEWER },
    { step: 'prd review 2', reviewer: 'codex' },
    { step: 'spec review 1', reviewer: 'codex' },
  ]);
  assert.ok(calls[3].prompt.includes(`[${FALLBACK_REVIEWER} MAJOR]`), 'revision findings name their actual reviewer');
});

test('when build round 1 is an Opus fallback and round 2 a codex PASS, the result still discloses the Opus round', async () => {
  const opusFail = { findings: [{ ...opusFinding, iso_property: null }], head_sha: sha, changed: [{ status: 'M', path: 'app.js' }] };
  const { result, calls } = await run('build', { ...buildArgs, review_fallback: 'opus-high' },
    [work, { ...unavailable, head_sha: '', changed: [] }, opusFail, work, codeReview, secPass, suitePass]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.review.reviewer, 'codex');
  assert.equal(result.fallback_used, true);
  assert.deepEqual(result.reviewers, [
    { step: 'review 1', reviewer: FALLBACK_REVIEWER },
    { step: 'review 2', reviewer: 'codex' },
    { step: 'security 2', reviewer: 'codex' },
  ]);
  assert.ok(calls.find(c => c.options.label === 'fix 1').prompt.includes(`[${FALLBACK_REVIEWER} MAJOR]`), 'fix items name their actual reviewer');
});

test('when verify reviews come only from codex, fallback_used is false and both reviews are listed', async () => {
  const { result } = await run('verify', verifyArgs, [preflight, proofs, { ...finalReview, codex_available: true }, { ...compliance, codex_available: true }, gate]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.fallback_used, false);
  assert.deepEqual(result.reviewers, [{ step: 'final review', reviewer: 'codex' }, { step: 'compliance', reviewer: 'codex' }]);
});

test('when a design relay reports blocked with codex unavailable and opus-high, design returns BLOCKED without an Opus review', async () => {
  const { result, calls } = await run('design', { ...designArgs, review_fallback: 'opus-high' }, [{ blocked: false }, blockedUnavailable]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(c => c.options.model === 'opus'));
});

test('when a build review or security relay reports blocked with codex unavailable and opus-high, build returns BLOCKED without an Opus review', async () => {
  const reviewBlocked = await run('build', { ...buildArgs, review_fallback: 'opus-high' },
    [work, { ...blockedUnavailable, head_sha: '', changed: [] }]);
  assert.equal(reviewBlocked.result.status, 'BLOCKED');
  assert.equal(reviewBlocked.result.stage, 'review');
  assert.equal(reviewBlocked.calls.length, 2);
  assert.ok(!reviewBlocked.calls.some(c => c.options.model === 'opus'));
  const securityBlocked = await run('build', { ...buildArgs, review_fallback: 'opus-high' },
    [work, codeReview, { verdict: 'ERROR', blocking: [], codex_available: false, blocked: true, note: 'refused' }]);
  assert.equal(securityBlocked.result.status, 'BLOCKED');
  assert.equal(securityBlocked.result.stage, 'security');
  assert.equal(securityBlocked.calls.length, 3);
  assert.ok(!securityBlocked.calls.some(c => c.options.model === 'opus'));
});

test('when a verify final review or compliance relay reports blocked with codex unavailable and opus-high, verify returns BLOCKED without an Opus review', async () => {
  const finalBlocked = await run('verify', { ...verifyArgs, review_fallback: 'opus-high' },
    [preflight, proofs, { verdict: 'ERROR', confirmed_findings: [], head_sha: sha, codex_available: false, blocked: true }]);
  assert.equal(finalBlocked.result.status, 'BLOCKED');
  assert.equal(finalBlocked.result.stage, 'final review');
  assert.equal(finalBlocked.calls.length, 3);
  assert.ok(!finalBlocked.calls.some(c => c.options.model === 'opus'));
  const complianceBlocked = await run('verify', { ...verifyArgs, review_fallback: 'opus-high' },
    [preflight, proofs, { ...finalReview, codex_available: true }, { verdict: 'ERROR', blocking: [], requirements: [], codex_available: false, blocked: true, ...pinned }]);
  assert.equal(complianceBlocked.result.status, 'BLOCKED');
  assert.equal(complianceBlocked.result.stage, 'compliance');
  assert.equal(complianceBlocked.calls.length, 4);
  assert.ok(!complianceBlocked.calls.some(c => c.options.model === 'opus'));
});

test('when codex is unavailable and review_fallback is opus-high, build reviews and security-checks with Opus high', async () => {
  const opusReview = { verdict: 'PASS', confirmed_findings: [], head_sha: sha, changed: [{ status: 'M', path: 'app.js' }], verdict_reasons: [], other_findings: [] };
  const { result, calls } = await run('build', { ...buildArgs, review_fallback: 'opus-high' },
    [work, { ...unavailable, head_sha: '', changed: [] }, opusReview, { verdict: 'ERROR', blocking: [], codex_available: false }, { verdict: 'PASS', blocking: [] }, suitePass]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.review.reviewer, FALLBACK_REVIEWER);
  assert.equal(result.security.reviewer, FALLBACK_REVIEWER);
  const opus = calls.filter(c => c.options.model === 'opus');
  assert.equal(opus.length, 2);
  assert.ok(opus[0].prompt.includes(`git -C '/repo' diff --binary --no-renames ${base}`), 'build fallback reviews the whole change in a throwaway worktree');
  assert.ok(opus[1].prompt.includes(`${base}..${sha}`), 'security fallback covers the whole change');
});

test('when codex is unavailable and review_fallback is opus-high, verify final review and compliance use Opus high', async () => {
  const { result, calls } = await run('verify', { ...verifyArgs, review_fallback: 'opus-high' },
    [preflight, proofs, { verdict: 'ERROR', confirmed_findings: [], head_sha: sha, codex_available: false }, finalReview,
      { verdict: 'ERROR', blocking: [], requirements: [], codex_available: false, ...pinned }, compliance, gate]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.final_review.reviewer, FALLBACK_REVIEWER);
  assert.equal(result.compliance.reviewer, FALLBACK_REVIEWER);
  assert.equal(result.fallback_used, true);
  const opus = calls.filter(c => c.options.model === 'opus');
  assert.deepEqual(opus.map(c => c.options.effort), ['high', 'high']);
});

// Opus fallback parity with codex-review (run-review.js computeTriggers/computeVerdict): the model reports
// findings, the workflow decides the verdict with codex's rule, so MINOR/NIT never block and the loop converges.
const minorOnly = { findings: [
  { severity: 'MINOR', confidence: 0.95, iso_property: 'ambiguous', location: 'x', title: 'wording', detail: 'd' },
  { severity: 'NIT', confidence: 0.9, iso_property: null, location: 'y', title: 'typo', detail: 'd' },
] };

test('fallback parity: an Opus design review with only MINOR/NIT findings passes and still reports them', async () => {
  const { result, calls } = await run('design', { ...designArgs, review_fallback: 'opus-high' },
    [{ blocked: false }, unavailable, minorOnly, { blocked: false }, unavailable, minorOnly, freeze]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.prd.reviewer, FALLBACK_REVIEWER);
  const opus = calls.filter(c => c.options.model === 'opus');
  assert.ok(opus[0].prompt.includes('/skill/rubrics/prd.md'), 'prd fallback reads the codex-review prd rubric');
  assert.ok(opus[1].prompt.includes('/skill/rubrics/spec.md'), 'spec fallback reads the codex-review spec rubric');
  assert.ok(!opus[0].prompt.includes('PASS only when'), 'the model no longer decides the verdict');
});

test('fallback parity: a design MAJOR blocks only with an ISO property or as the third MAJOR', async () => {
  const major = (iso, title) => ({ severity: 'MAJOR', confidence: 0.9, iso_property: iso, location: 'x', title, detail: 'd' });
  const lone = await run('design', { ...designArgs, review_fallback: 'opus-high' },
    [{ blocked: false }, unavailable, { findings: [major(null, 'one')] }, { blocked: false }, unavailable, { findings: [] }, freeze]);
  assert.equal(lone.result.status, 'PASS', 'one non-ISO MAJOR does not trigger');
  const three = await run('design', { ...designArgs, review_fallback: 'opus-high', max_rounds: 1 },
    [{ blocked: false }, unavailable, { findings: [major(null, 'a'), major(null, 'b'), major(null, 'c')] }]);
  assert.equal(three.result.status, 'FAIL');
  assert.equal(three.result.prd.review.confirmed_findings.length, 3);
  const iso = await run('design', { ...designArgs, review_fallback: 'opus-high', max_rounds: 1 },
    [{ blocked: false }, unavailable, { findings: [major('unverifiable', 'no pass/fail')] }]);
  assert.equal(iso.result.status, 'FAIL');
  assert.deepEqual(iso.result.prd.review.confirmed_findings.map(f => f.title), ['no pass/fail']);
});

test('fallback parity: build blocks on a verified MAJOR, asks a human for a 0.5-0.8 MAJOR, passes MINOR', async () => {
  const head = { head_sha: sha, changed: [{ status: 'M', path: 'app.js' }] };
  const opusReview = findings => ({ findings, ...head });
  const minor = await run('build', { ...buildArgs, review_fallback: 'opus-high' },
    [work, { ...unavailable, head_sha: '', changed: [] }, opusReview(minorOnly.findings), secPass, suitePass]);
  assert.equal(minor.result.status, 'PASS');
  assert.equal(minor.result.review.other_findings.length, 2, 'non-blocking findings stay visible');
  const band = await run('build', { ...buildArgs, review_fallback: 'opus-high' },
    [work, { ...unavailable, head_sha: '', changed: [] }, opusReview([{ severity: 'MAJOR', confidence: 0.6, iso_property: null, title: 'maybe' }])]);
  assert.equal(band.result.status, 'BLOCKED');
  assert.equal(band.result.review.verdict, 'NEEDS_HUMAN');
});

test('fallback parity: verify final review passes with MINOR only and fails on BLOCKING', async () => {
  const pass = await run('verify', { ...verifyArgs, review_fallback: 'opus-high' },
    [preflight, proofs, { ...unavailable, head_sha: sha }, { findings: minorOnly.findings, head_sha: sha }, { ...compliance, codex_available: true }, gate]);
  assert.equal(pass.result.status, 'PASS');
  const fail = await run('verify', { ...verifyArgs, review_fallback: 'opus-high' },
    [preflight, proofs, { ...unavailable, head_sha: sha }, { findings: [{ severity: 'BLOCKING', confidence: 0.9, iso_property: null, title: 'crash' }], head_sha: sha }, { ...compliance, codex_available: true }]);
  assert.equal(fail.result.status, 'FAIL');
  assert.equal(fail.result.final_review.verdict, 'FAIL');
});

test('fallback parity: a design MAJOR with an ISO property triggers at any confidence and goes back to the author', async () => {
  const lowConfIso = { severity: 'MAJOR', confidence: 0.75, iso_property: 'missing_acceptance_criteria', location: 'x', title: 'no criterion', detail: 'd' };
  const { result, calls } = await run('design', { ...designArgs, review_fallback: 'opus-high' },
    [{ blocked: false }, unavailable, { findings: [lowConfIso] }, { blocked: false }, unavailable, { findings: [] }, { blocked: false }, unavailable, { findings: [] }, freeze]);
  assert.equal(result.status, 'PASS', 'FAIL -> revise -> PASS, never NEEDS_HUMAN');
  assert.ok(calls.find(c => c.options.label === 'prd revise 1').prompt.includes('no criterion'));
});

// --- security scans: repo-owned threat model, OWASP checklist and scan log reach the prompts ---
const secDocs = ['/repo/docs/threat-model.md', '/repo/docs/accepted-risks.md'];
// The codex security/compliance task is written into prompt.md between double quotes.
const quotedTask = p => p.slice(p.indexOf('prompt.md containing: "') + 'prompt.md containing: "'.length, p.indexOf('"\n2. Run'));
const checklist = '/repo/docs/owasp-checklist.md';

test('design: the spec prompt requires a Security considerations section and reads security_docs when given', async () => {
  const withDocs = await run('design', { ...designArgs, security_docs: secDocs }, [{ blocked: false }, docReview, { blocked: false }, docReview, freeze]);
  assert.equal(withDocs.result.status, 'PASS');
  const spec = withDocs.calls.find(c => c.options.label === 'spec draft').prompt;
  assert.ok(spec.includes('Security considerations'), 'spec must carry a Security considerations section');
  assert.match(spec, /authorization scope/);
  assert.match(spec, /length limits/);
  assert.match(spec, /server-side bound/);
  assert.match(spec, /client-side debounce\/throttle is not a security control/);
  for (const d of secDocs) assert.ok(spec.includes(d), 'spec author reads ' + d);
  const prd = withDocs.calls.find(c => c.options.label === 'prd draft').prompt;
  assert.ok(!prd.includes('Security considerations'), 'the PRD prompt is unchanged');
  const without = await run('design', designArgs, [{ blocked: false }, docReview, { blocked: false }, docReview, freeze]);
  const plain = without.calls.find(c => c.options.label === 'spec draft').prompt;
  assert.ok(plain.includes('Security considerations'), 'the section is required even without repo docs');
  assert.ok(!plain.includes('/repo/docs/'), 'no repo docs are invented when none are given');
});

test('build: codex and fallback security prompts name OWASP API Security Top 10 / API4 and read the repo docs first', async () => {
  const args = { ...buildArgs, security_docs: secDocs, security_checklist: checklist };
  const viaCodex = await run('build', args, [work, codeReview, secPass, suitePass]);
  assert.equal(viaCodex.result.status, 'PASS');
  const opusReview = { verdict: 'PASS', confirmed_findings: [], head_sha: sha, changed: [{ status: 'M', path: 'app.js' }], verdict_reasons: [], other_findings: [] };
  const viaOpus = await run('build', { ...args, review_fallback: 'opus-high' },
    [work, { ...unavailable, head_sha: '', changed: [] }, opusReview, { verdict: 'ERROR', blocking: [], codex_available: false }, { verdict: 'PASS', blocking: [] }, suitePass]);
  assert.equal(viaOpus.result.status, 'PASS');
  const prompts = [viaCodex.calls.find(c => c.options.label === 'codex security 1').prompt,
    viaOpus.calls.find(c => c.options.label === 'opus security 1 (codex unavailable)').prompt];
  for (const p of prompts) {
    assert.ok(p.includes('OWASP Top 10'), 'web Top 10 still named');
    assert.ok(p.includes('OWASP API Security Top 10'), 'API Top 10 named');
    assert.match(p, /API4[^.]*unrestricted resource consumption/i);
    assert.match(p, /client-side controls are not security controls/i);
    assert.match(p, /accepted risk/i);
    for (const d of [...secDocs, checklist]) assert.ok(p.includes(d), 'security reviewer reads ' + d);
    assert.ok(p.includes('verdict FAIL if any critical or high finding exists, else PASS'), 'verdict rule unchanged');
  }
  const task = quotedTask(prompts[0]);
  for (const d of [...secDocs, checklist]) assert.ok(task.includes(d), 'the codex task itself carries ' + d);
  assert.ok(task.includes('API4') && !/["']/.test(task), 'the quoted codex task holds no quote characters');
  const plain = await run('build', buildArgs, [work, codeReview, secPass, suitePass]);
  const plainSec = plain.calls.find(c => c.options.label === 'codex security 1').prompt;
  assert.ok(plainSec.includes('API4'), 'API4 is checked even without repo docs');
  assert.ok(!plainSec.includes('/repo/docs/'), 'no repo docs are invented when none are given');
});

test('verify: the compliance trace requires a dated scan-log row only when require_scan_row is true', async () => {
  const scanArgs = { ...verifyArgs, scan_log: 'docs/security-scan-log.md', require_scan_row: true };
  const required = await run('verify', scanArgs, [preflight, proofs, finalReview, compliance, gate]);
  assert.equal(required.result.status, 'PASS');
  const viaCodex = required.calls.find(c => c.options.label === 'codex spec compliance').prompt;
  const fallback = await run('verify', { ...scanArgs, review_fallback: 'opus-high' },
    [preflight, proofs, finalReview, { verdict: 'ERROR', blocking: [], requirements: [], codex_available: false, ...pinned }, compliance, gate]);
  const viaOpus = fallback.calls.find(c => c.options.label === 'opus spec compliance (codex unavailable)').prompt;
  for (const p of [viaCodex, viaOpus]) {
    assert.ok(p.includes('docs/security-scan-log.md'), 'scan log named');
    assert.match(p, /dated/);
    assert.ok(p.includes(`at ${sha}`), 'checked at reviewed_sha');
    assert.match(p, /file:line/);
    assert.match(p, /severity high/);
  }
  const task = quotedTask(viaCodex);
  assert.ok(task.includes('docs/security-scan-log.md') && !task.includes('"'), 'the quoted codex task carries the scan log and no double quote');
  for (const args of [verifyArgs, { ...verifyArgs, scan_log: 'docs/security-scan-log.md', require_scan_row: false }]) {
    const { calls } = await run('verify', args, [preflight, proofs, finalReview, compliance, gate]);
    const p = calls.find(c => c.options.label === 'codex spec compliance').prompt;
    assert.ok(!/scan log/i.test(p), 'no scan-row requirement unless require_scan_row is true');
  }
});

test('unsafe security config returns BLOCKED before any agent runs', async () => {
  const cases = [
    ['design', { ...designArgs, security_docs: ['docs/threat-model.md'] }, /security_docs/],
    ['design', { ...designArgs, security_docs: ['/repo/$(id).md'] }, /security_docs/],
    ['design', { ...designArgs, security_docs: '/repo/docs/threat-model.md' }, /security_docs/],
    ['build', { ...buildArgs, security_docs: ["/repo/it's.md"] }, /security_docs/],
    ['build', { ...buildArgs, security_checklist: '~/checklist.md' }, /security_checklist/],
    ['verify', { ...verifyArgs, scan_log: '/repo/docs/scan-log.md', require_scan_row: true }, /scan_log/],
    ['verify', { ...verifyArgs, scan_log: '../outside/scan-log.md', require_scan_row: true }, /scan_log/],
    ['verify', { ...verifyArgs, scan_log: 'docs/`id`.md', require_scan_row: true }, /scan_log/],
    ['verify', { ...verifyArgs, require_scan_row: true }, /scan_log/],
    ['verify', { ...verifyArgs, scan_log: 'docs/scan-log.md', require_scan_row: 'yes' }, /require_scan_row/],
  ];
  for (const [name, args, reason] of cases) {
    const { result, calls } = await run(name, args, []);
    assert.equal(result.status, 'BLOCKED', name + ' ' + JSON.stringify(args.security_docs || args.security_checklist || args.scan_log));
    assert.match(result.reason, reason, name);
    assert.equal(calls.length, 0, name);
  }
});

test('the compliance trace may read files with read-only commands but never run tests or builds', async () => {
  const { calls } = await run('verify', verifyArgs, [preflight, proofs, { ...finalReview, codex_available: true }, { ...compliance, codex_available: true }, gate]);
  const relay = calls.find(c => c.options.label === 'codex spec compliance');
  assert.ok(relay.prompt.includes('Inspect files only with read-only commands (cat, sed, grep, ls, git diff, git show, git log)'));
  assert.ok(relay.prompt.includes('never run tests, builds or anything that writes'));
  assert.ok(!relay.prompt.includes('Do not execute commands'));
});
