export const meta = {
  name: 'gated-build',
  description: 'Test-first implementation by Claude, codex review + security pass, fix loop, full suite last',
  whenToUse: 'Stage 2 of the gated-pipeline skill: build a feature from its frozen spec or charge',
  phases: [
    { title: 'Implement', detail: 'Claude implementer, test-first, commits on the work branch' },
    { title: 'Review', detail: 'codex reviews the change, then a codex security pass' },
    { title: 'Fix', detail: 'Claude fixes confirmed codex findings and suite failures' },
    { title: 'Suite', detail: 'full test suite, last' },
  ],
}

const A = args || {}
const need = ['feature_id', 'repo', 'work_branch', 'run_dir', 'review_runner', 'suite_cmd']
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
if (!A.spec_path && !A.charge) return { status: 'BLOCKED', reason: 'need spec_path or charge' }
// Paths go into shell commands: single-quoted, and only from a conservative character set.
const SAFE = /^[A-Za-z0-9._\/\\: +@-]+$/
for (const k of ['repo', 'run_dir', 'review_runner', 'spec_path', 'security_schema']) {
  if (A[k] && (!SAFE.test(A[k]) || !/^([A-Za-z]:[\/\\]|\/)/.test(A[k]))) return { status: 'BLOCKED', reason: `${k} must be an absolute path of safe characters (no ~, quotes, $ or backticks): ${A[k]}` }
}

const MAX = A.max_fix_rounds ?? 4
const IMPL_EFFORT = A.impl_effort || 'medium'
const TIMEOUT_S = A.review_timeout_seconds || 1200
const q = s => `'${s}'`
// Config values that reach shell commands must be plain tokens.
if (A.codex_model && !/^[A-Za-z0-9._-]+$/.test(A.codex_model)) return { status: 'BLOCKED', reason: 'codex_model must match [A-Za-z0-9._-]' }
if (A.codex_effort && !['low', 'medium', 'high', 'xhigh'].includes(A.codex_effort)) return { status: 'BLOCKED', reason: 'codex_effort must be low|medium|high|xhigh' }
if (A.review_timeout_seconds !== undefined && !(Number.isInteger(A.review_timeout_seconds) && A.review_timeout_seconds > 0)) return { status: 'BLOCKED', reason: 'review_timeout_seconds must be a positive integer' }
const DOTDOT = /(^|[\/\\])\.\.([\/\\]|$)/
const ABS0 = /^([A-Za-z]:|[\/\\])/
// A suite result certifies reviewed_sha only if HEAD was that commit and the tree was clean before AND after the run.
// clean_ignore: repo-relative prefixes whose dirty/untracked status is tolerated (e.g. a harness state dir).
if ((A.clean_ignore || []).some(p => !SAFE.test(p) || ABS0.test(p))) return { status: 'BLOCKED', reason: 'clean_ignore entries must be repo-relative paths of safe characters' }
const IGNORE = (A.clean_ignore || []).map(p => p.replace(/\\/g, '/').replace(/^\.\//, ''))
const ignored = p => IGNORE.some(i => p === i || p === i.replace(/\/$/, '') || p.startsWith(i.endsWith('/') ? i : i + '/'))
const dirty = lines => (lines || []).filter(l => l.trim() && !l.slice(3).split(' -> ').map(s => s.replace(/^"|"$/g, '')).every(ignored))
const stateNoteAt = dir => `Immediately before AND immediately after, run git -C ${q(dir)} rev-parse HEAD and git -C ${q(dir)} status --porcelain --untracked-files=all -- . ${IGNORE.map(i => q(':!' + i)).join(' ')}; ` +
  'report them as head_before, status_before (one array entry per output line), head_after, status_after. Do not clean, stash or change anything yourself.'
// Endpoint checks cannot see a checkout swapped and restored mid-run. suite_isolated=true closes that by running the suite in a
// fresh worktree of the reviewed commit (after isolated_setup, e.g. "npm ci"); otherwise no other writer may touch the checkout.
if (A.isolated_setup !== undefined && (typeof A.isolated_setup !== 'string' || /[\r\n]/.test(A.isolated_setup))) return { status: 'BLOCKED', reason: 'isolated_setup must be a single-line command' }
const STATE = { head_before: { type: 'string' }, status_before: { type: 'array', items: { type: 'string' } }, head_after: { type: 'string' }, status_after: { type: 'array', items: { type: 'string' } } }
const pinned = (rep, sha) => [
  ...(rep.head_before === sha && rep.head_after === sha ? [] : [`HEAD was ${rep.head_before} before and ${rep.head_after} after, expected ${sha}`]),
  ...dirty(rep.status_before).map(l => `dirty before: ${l}`),
  ...dirty(rep.status_after).map(l => `dirty after: ${l}`),
]
const RULES = [
  `Repo: ${A.repo}. Work ONLY on branch ${A.work_branch}; never touch other branches, never push or merge the trunk.`,
  'Commit with explicit pathspecs only (never git add -A or .). Never git rm, never glob-delete, never --no-verify.',
  'Before each commit, scan the staged diff for secrets (.env, service-account json, .pem, id_rsa, API keys) and abort if any are present.',
  'Never deploy, never run Terraform, never touch production resources.',
  A.lock_note ? `Test runs: ${A.lock_note}` : '',
  A.live_budget_min ? `Live or paid tests: hard cap ${A.live_budget_min} minutes total; keep a ledger at ${A.run_dir}/live-ledger.txt; record anything that cannot fit as NOT RUN.` : 'Do not run live or paid external-API tests.',
  'Report only numbers you observed in command output. A skipped check is NOT RUN, never a pass.',
  'If any command is blocked, or a tool or the API refuses, STOP and report blocked=true. Never reproduce its effect another way.',
].filter(Boolean).join('\n- ')

const WORK = {
  type: 'object',
  properties: {
    blocked: { type: 'boolean' },
    blocked_reason: { type: 'string' },
    summary: { type: 'string' },
    base_commit: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    files_deleted: { type: 'array', items: { type: 'string' } },
    tests_added: { type: 'array', items: { type: 'string' } },
    red_then_green: { type: 'string' },
    commit: { type: 'string' },
  },
  required: ['blocked', 'summary', 'files_changed', 'commit'],
}
const FINDINGS = { type: 'array', items: { type: 'object', properties: {
  severity: { type: 'string' }, location: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
  required: ['severity', 'title'] } }
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NEEDS_HUMAN', 'ERROR'] },
    confirmed_findings: FINDINGS,
    note: { type: 'string' }, blocked: { type: 'boolean' },
    head_sha: { type: 'string' },
    changed: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, path: { type: 'string' } }, required: ['status', 'path'] } },
    verdict_reasons: { type: 'array', items: { type: 'string' } },
    other_findings: FINDINGS,
  },
  required: ['verdict', 'confirmed_findings', 'head_sha', 'changed', 'verdict_reasons', 'other_findings'],
}
// NEEDS_HUMAN only because codex's own verdict disagreed with the runner's rule, with findings still listed: those go to
// the fixer. Every other NEEDS_HUMAN without confirmed findings stops the stage.
const disagreementOnly = r => r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && r.other_findings.length &&
  r.verdict_reasons.length > 0 && r.verdict_reasons.every(x => /model_rule_disagreement/.test(x))
const SEC = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR'] }, blocking: FINDINGS, note: { type: 'string' }, blocked: { type: 'boolean' } },
  required: ['verdict', 'blocking'],
}
const SUITE = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    counts: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    completed: { type: 'boolean' },
    other_failures: { type: 'array', items: { type: 'string' } },
    log_path: { type: 'string' },
    blocked: { type: 'boolean' },
    ...STATE,
  },
  required: ['passed', 'counts', 'failures', 'completed', 'other_failures', 'head_before', 'status_before', 'head_after', 'status_after'],
}

// Known pre-existing failures are matched in code by EXACT test id, never left to an agent's judgement, and only
// excuse a suite run that completed (no crash, timeout or collection error). A string is split on newlines only,
// because parameterized test ids can contain commas.
const KNOWN = (Array.isArray(A.known_failures) ? A.known_failures : String(A.known_failures || '').split('\n')).map(s => s.trim()).filter(Boolean)
const newFailures = s => s.failures.map(f => f.trim()).filter(f => !KNOWN.includes(f))

const target = A.spec_path ? `the frozen spec at ${A.spec_path}` : 'the charge below'
const chargeText = A.charge ? `\n\nCHARGE:\n${A.charge}` : ''
// A restart (after HEAD_MOVED or CI_RED) must pass the feature's ORIGINAL base_commit, so commits that arrived since the
// last review fall inside the reviewed range instead of becoming the new base.
if (A.base_commit !== undefined && !/^[0-9a-f]{7,40}$/.test(A.base_commit)) return { status: 'BLOCKED', reason: 'base_commit must be a hex commit id' }
const workReport = A.base_commit
  ? `The feature's base_commit is fixed at ${A.base_commit}; report exactly that. In files_changed list repo-relative paths that still exist; list removed files in files_deleted.`
  : 'Before changing anything, record `git rev-parse HEAD` as base_commit (keep the first value across rounds). In files_changed list repo-relative paths that still exist; list removed files in files_deleted.'

phase('Implement')
const work = await agent(
  `You are the implementer for feature ${A.feature_id}. Implement ${target}.${chargeText}\n\n` +
  `Work test-first: for each acceptance item write the test, run it and see it FAIL, implement, run it and see it PASS. ` +
  `Run the focused tests with: ${A.unit_cmd || '(the repo\'s focused test command)'}. Keep the change minimal and in the repo's style. ` +
  `Commit on ${A.work_branch} and push the branch. Save the red and green outputs under ${A.run_dir}/implement/. ${workReport}\n\nRules:\n- ${RULES}`,
  { label: 'implement', phase: 'Implement', schema: WORK, effort: IMPL_EFFORT })
if (!work || work.blocked) return { status: 'BLOCKED', stage: 'implement', reason: work ? work.blocked_reason : 'implementer died' }

const base = A.base_commit || work.base_commit || ''
const files = new Set()
const deleted = new Set()
function track(w) {
  (w.files_changed || []).forEach(f => { files.add(f); deleted.delete(f) });
  (w.files_deleted || []).forEach(f => { deleted.add(f); files.delete(f) })
}
track(work)
const ABS = /^([A-Za-z]:|[\/\\])/
// File names never reach a shell command (scope is the git range), so any git path is allowed (e.g. app/[slug]/page.tsx)
// except absolute ones, '..' segments, control characters, quotes, '$' and backticks.
const NAME = /^[^\x00-\x1f"'`$]+$/
const unsafe = () => [...files, ...deleted].filter(f => !NAME.test(f) || ABS.test(f) || DOTDOT.test(f))
  .concat(/^[0-9a-f]{7,40}$/.test(base) ? [] : ['(the implementer must report a hex base_commit)'])
const history = [{ round: 0, work }]

// Review scope = the WHOLE change base_commit..<pinned head>, taken from git, never from the agents' file lists (an
// unreported file must not escape review). The runner's only diff-aware mode is --uncommitted, so the change is replayed
// as uncommitted edits (deletions included) in a throwaway worktree at base_commit.
function scopePrep(out) {
  const wt = `${out}/wt`
  return `Set up the review checkout first (Bash, in order; stop and report blocked if any step fails):\n` +
    `0. Pin the head: H=$(git -C ${q(A.repo)} rev-parse HEAD). Report it as head_sha, and use $H (never HEAD) below.\n` +
    `1. mkdir -p ${q(out)} && git -C ${q(A.repo)} diff --binary --no-renames ${base} "$H" > ${q(out + '/change.patch')}\n` +
    `   and report changed = every line of: git -C ${q(A.repo)} diff --name-status --no-renames ${base} "$H" (status letter + repo-relative path).\n` +
    `2. git -C ${q(A.repo)} worktree add --detach ${q(wt)} ${base}\n` +
    `3. git -C ${q(wt)} apply --index ${q(out + '/change.patch')}\n` +
    `After result.json exists (or the run fails), remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(wt)}\n`
}
const scopeArgs = out => `--uncommitted --repo ${q(out + '/wt')}`
const waitNote = out => `It can run for up to ~${Math.ceil(TIMEOUT_S * 6 / 60) + 5} minutes: run it in the background and poll for ${out}/*/result.json with a bounded wait loop of that length.`

async function review(round) {
  const out = `${A.run_dir}/review-${round}`
  return agent(
    `Run an independent codex implementation review of the CHANGE and report its verdict. Do not review the code yourself.\n${scopePrep(out)}` +
    `Command (Bash): node ${q(A.review_runner)} --kind implementation ${scopeArgs(out)} --out-dir ${q(out)}` +
    `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}\n${waitNote(out)}\n` +
    `Exit codes: 0 PASS, 1 FAIL, 3 NEEDS_HUMAN, 2 setup error (report ERROR). Read the result.json of the run folder THIS command created (the newest; ignore older folders). ` +
    `Put findings whose validation.status is "confirmed" in confirmed_findings, every other non-refuted finding in other_findings, and copy result.json's verdict_reasons verbatim. ` +
    `If codex reports a usage cap or quota error, return verdict ERROR with that text in note.\n- ${RULES}`,
    { label: `codex review ${round}`, phase: 'Review', schema: REVIEW, effort: 'low' })
}

async function security(round) {
  const out = `${A.run_dir}/security-${round}`
  return agent(
    `Run an independent codex SECURITY review of the change and report its verdict. Do not review the code yourself.\n` +
    `0. Create ${out}/ and an isolated checkout of the reviewed commit, so every file codex reads is that commit's: git -C ${q(A.repo)} worktree add --detach ${q(out + '/wt')} ${reviewedSha}. ` +
    `After security.json exists (or the run fails), remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(out + '/wt')}\n` +
    `1. Write ${out}/prompt.md containing: "Security review (OWASP Top 10, secrets, injection, authz, unsafe deserialization, SSRF, path traversal, logging of sensitive data) ` +
    `of the change ${base}..${reviewedSha} in this repository (all of it: git diff ${base} ${reviewedSha}). Read any other file you need for context, but report findings ONLY in that change. ` +
    `Quote the code for every finding. verdict FAIL if any critical or high finding exists, else PASS."\n` +
    `2. Run under a HARD process timeout so codex can never outlive this step (Bash, in the background, then poll up to ~32 minutes for ${out}/security.json; if the timeout fires the process is already killed: report ERROR): ` +
    `timeout --kill-after=60 1800 codex exec${A.codex_model ? ` -m ${q(A.codex_model)}` : ''} -c model_reasoning_effort=${A.codex_effort || 'high'} -s read-only -C ${q(out + '/wt')} --output-schema ${q(A.security_schema)} -o ${q(out + '/security.json')} - < ${q(out + '/prompt.md')}\n` +
    `3. Return verdict and ONLY the critical/high findings as blocking. If codex errors, hits a usage cap, or writes no valid JSON, return ERROR with the reason in note.\n- ${RULES}`,
    { label: `codex security ${round}`, phase: 'Review', schema: SEC, effort: 'low' })
}

let verdict = null
let lastSuite = null
let lastSec = null
let reviewedSha = ''
for (let round = 1; round <= MAX + 1; round++) {
  if (unsafe().length) return { status: 'BLOCKED', stage: 'review', reason: 'file names must be repo-relative and safe: ' + unsafe().join(', '), history }
  const r = await review(round)
  if (!r || r.blocked || r.verdict === 'ERROR' || (r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && !disagreementOnly(r))) return { status: 'BLOCKED', stage: 'review', round, review: r, history }
  if (!/^[0-9a-f]{40}$/.test(r.head_sha)) return { status: 'BLOCKED', stage: 'review', round, reason: 'review did not report a 40-hex head_sha', review: r, history }
  if (!r.changed.length) return { status: 'BLOCKED', stage: 'review', round, reason: `git shows no change between ${base} and ${r.head_sha}`, review: r, history }
  // git's list is authoritative: report what the agents left out, then adopt it.
  const gitPaths = r.changed.map(c => c.path)
  const unreported = gitPaths.filter(p => !files.has(p) && !deleted.has(p))
  if (unreported.length) log(`round ${round}: ${unreported.length} changed path(s) the agents did not report: ${unreported.join(', ')}`)
  files.clear(); deleted.clear()
  r.changed.forEach(c => (c.status.startsWith('D') ? deleted : files).add(c.path))
  if (unsafe().length) return { status: 'BLOCKED', stage: 'review', reason: 'changed paths must be repo-relative and safe: ' + unsafe().join(', '), history }
  reviewedSha = r.head_sha
  if (r.verdict === 'PASS' && r.confirmed_findings.length) r.verdict = 'FAIL'
  verdict = r
  let sec = null
  let suite = null
  if (r.verdict === 'PASS' && A.security_schema) {
    sec = await security(round)
    lastSec = sec
    if (!sec || sec.blocked || sec.verdict === 'ERROR') return { status: 'BLOCKED', stage: 'security', round, security: sec, history }
    // Findings decide, not the self-reported verdict: any blocking finding is a FAIL.
    if (sec.blocking.length) sec.verdict = 'FAIL'
    if (sec.verdict === 'FAIL') log(`security pass failed in round ${round}: ${sec.blocking.length} high/critical`)
  }
  if (r.verdict === 'PASS' && (!sec || sec.verdict === 'PASS')) {
    phase('Suite')
    const swt = `${A.run_dir}/suite-${round}/wt`
    const where = A.suite_isolated
      ? `in an isolated checkout of the reviewed commit: git -C ${q(A.repo)} worktree add --detach ${q(swt)} ${reviewedSha}, then in ${swt} ` +
        `${A.isolated_setup ? `run the setup command (${A.isolated_setup}), then ` : ''}run the suite there. After the run, remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(swt)}. `
      : `in ${A.repo} on branch ${A.work_branch}. `
    suite = await agent(
      `Run the full test suite as the LAST step, ${where}Suite command: ${A.suite_cmd}\n` +
      `Save the full output to ${A.run_dir}/suite-${round}.txt. Report the observed counts, each failing test id exactly as the runner prints it, and in other_failures every failure that is not a test (coverage threshold, lint/type step, post-test command, a non-zero exit not explained by a listed test). ` +
      `${stateNoteAt(A.suite_isolated ? swt : A.repo)}${A.suite_isolated ? ' (the "before" state is taken after the setup command, the "after" state before removing the checkout)' : ''} ` +
      `completed=true ONLY if the whole suite ran to the end; a crash, timeout, collection/import error or interrupted run is completed=false.\n- ${RULES}`,
      { label: `suite ${round}`, phase: 'Suite', schema: SUITE, effort: 'low' })
    if (!suite || suite.blocked) return { status: 'BLOCKED', stage: 'suite', suite, history }
    lastSuite = suite
    const drift = pinned(suite, reviewedSha)
    if (drift.length) return { status: 'BLOCKED', stage: 'suite', reason: 'the suite did not run on the clean reviewed commit: ' + drift.join('; '), suite, history }
    // Accept only a completed run with no failure outside the known baseline ids (exact match), and never a report that
    // claims failure without naming it. Known failures are reported, never sent to the fixer.
    const fresh = newFailures(suite)
    if (suite.completed && !fresh.length && !suite.other_failures.length && (suite.passed || suite.failures.length)) return { status: 'PASS', rounds: round, reviewed_sha: reviewedSha, review: r, security: sec, suite, known_failures_seen: suite.failures.filter(f => !fresh.includes(f.trim())), base_commit: base, files: [...files], deleted: [...deleted], history }
    log(`suite failed in round ${round}: ${suite.counts}${suite.completed ? '' : ' (run did not complete)'}`)
  }
  if (round > MAX) break
  phase('Fix')
  const items = [
    ...(r.verdict !== 'PASS' ? (r.confirmed_findings.length ? r.confirmed_findings : r.other_findings).map(f => `[codex ${f.severity}] ${f.location || ''} ${f.title}: ${f.detail || ''}`) : []),
    ...(sec && sec.verdict === 'FAIL' ? sec.blocking.map(f => `[security ${f.severity}] ${f.location || ''} ${f.title}: ${f.detail || ''}`) : []),
    ...(suite ? newFailures(suite).map(f => `[suite] ${f}`) : []),
    ...(suite ? suite.other_failures.map(f => `[suite, not a test] ${f}`) : []),
    ...(suite && !suite.completed ? [`[suite] the full suite did not run to completion (${suite.counts}); see ${A.run_dir}/suite-${round}.txt`] : []),
  ]
  if (!items.length) items.push(`[suite] the suite failed without naming a test (${suite ? suite.counts : 'no result'}); see ${A.run_dir}/suite-${round}.txt`)
  const fix = await agent(
    `You are fixing feature ${A.feature_id} on ${A.work_branch} (implemented against ${target}).${chargeText}\n` +
    `Fix each item below for real. If an item is wrong, say why in summary instead of changing code for it. Add or adjust tests test-first. Commit and push. ${workReport}\nITEMS:\n${items.join('\n')}\n\nRules:\n- ${RULES}`,
    { label: `fix ${round}`, phase: 'Fix', schema: WORK, effort: IMPL_EFFORT })
  if (!fix || fix.blocked) return { status: 'BLOCKED', stage: 'fix', round, reason: fix ? fix.blocked_reason : 'fixer died', history }
  track(fix)
  history.push({ round, findings: items, fix })
}
return { status: 'FAIL', reason: `not clean after ${MAX} fix rounds`, reviewed_sha: reviewedSha, review: verdict, security: lastSec, suite: lastSuite, base_commit: base, files: [...files], deleted: [...deleted], history }
