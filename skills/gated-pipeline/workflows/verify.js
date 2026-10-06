export const meta = {
  name: 'gated-verify',
  description: 'Repo-specific extra checks one at a time, then codex final review + spec-compliance trace',
  whenToUse: 'Stage 3 of the gated-pipeline skill, only for features whose spec needs more than unit + suite proofs',
  phases: [
    { title: 'Checks', detail: 'each configured check, sequentially' },
    { title: 'Final review', detail: 'codex defect review of the whole change, then a spec-compliance trace' },
  ],
}

const A = args || {}
const need = ['feature_id', 'repo', 'work_branch', 'run_dir', 'review_runner', 'spec_path', 'compliance_schema']
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
// Paths go into shell commands: single-quoted, and only from a conservative character set.
const SAFE = /^[A-Za-z0-9._\/\\: +@-]+$/
const ABS = /^([A-Za-z]:|[\/\\])/
const DOTDOT = /(^|[\/\\])\.\.([\/\\]|$)/
for (const k of ['repo', 'run_dir', 'review_runner', 'spec_path', 'compliance_schema']) {
  if (!SAFE.test(A[k]) || !/^([A-Za-z]:[\/\\]|\/)/.test(A[k])) return { status: 'BLOCKED', reason: `${k} must be an absolute path of safe characters (no ~, quotes, $ or backticks): ${A[k]}` }
}
// Scope is the whole change base_commit..reviewed_sha taken from git; files/deleted are informational only.
const files = A.files || []
const deleted = A.deleted || []
// Informational only (never in a shell command), so brackets etc. are fine; absolute, '..', control chars, quotes, $ and ` are not.
const NAME = /^[^\x00-\x1f"'`$]+$/
const bad = [...files, ...deleted].filter(f => !NAME.test(f) || ABS.test(f) || DOTDOT.test(f))
if (bad.length) return { status: 'BLOCKED', reason: 'file names must be repo-relative and safe: ' + bad.join(', ') }
if (!(A.base_commit && /^[0-9a-f]{7,40}$/.test(A.base_commit))) return { status: 'BLOCKED', reason: 'need a hex base_commit (HEAD before the feature started)' }
if (!(A.reviewed_sha && /^[0-9a-f]{40}$/.test(A.reviewed_sha))) return { status: 'BLOCKED', reason: 'need reviewed_sha: the 40-hex commit build reviewed (build result reviewed_sha)' }

const q = s => `'${s}'`
// Every check and the compliance trace must run with HEAD at reviewed_sha and a clean tree, before AND after.
// clean_ignore: repo-relative prefixes whose dirty/untracked status is tolerated (e.g. a harness state dir).
if ((A.clean_ignore || []).some(p => !SAFE.test(p) || ABS.test(p))) return { status: 'BLOCKED', reason: 'clean_ignore entries must be repo-relative paths of safe characters' }
const IGNORE = (A.clean_ignore || []).map(p => p.replace(/\\/g, '/').replace(/^\.\//, ''))
const ignored = p => IGNORE.some(i => p === i || p === i.replace(/\/$/, '') || p.startsWith(i.endsWith('/') ? i : i + '/'))
const dirty = lines => (lines || []).filter(l => l.trim() && !l.slice(3).split(' -> ').map(s => s.replace(/^"|"$/g, '')).every(ignored))
const stateNote = `Immediately before AND immediately after, run git -C ${q(A.repo)} rev-parse HEAD and git -C ${q(A.repo)} status --porcelain --untracked-files=all -- . ${IGNORE.map(i => q(':!' + i)).join(' ')}; ` +
  'report them as head_before, status_before (one array entry per output line), head_after, status_after. Do not clean, stash or change anything yourself.'
const STATE = { head_before: { type: 'string' }, status_before: { type: 'array', items: { type: 'string' } }, head_after: { type: 'string' }, status_after: { type: 'array', items: { type: 'string' } } }
const STATE_REQ = ['head_before', 'status_before', 'head_after', 'status_after']
const pinned = rep => [
  ...(rep.head_before === A.reviewed_sha && rep.head_after === A.reviewed_sha ? [] : [`HEAD was ${rep.head_before} before and ${rep.head_after} after, expected ${A.reviewed_sha}`]),
  ...dirty(rep.status_before).map(l => `dirty before: ${l}`),
  ...dirty(rep.status_after).map(l => `dirty after: ${l}`),
]
// Config values that reach shell commands must be plain tokens.
if (A.codex_model && !/^[A-Za-z0-9._-]+$/.test(A.codex_model)) return { status: 'BLOCKED', reason: 'codex_model must match [A-Za-z0-9._-]' }
if (A.codex_effort && !['low', 'medium', 'high', 'xhigh'].includes(A.codex_effort)) return { status: 'BLOCKED', reason: 'codex_effort must be low|medium|high|xhigh' }
if (A.review_timeout_seconds !== undefined && !(Number.isInteger(A.review_timeout_seconds) && A.review_timeout_seconds > 0)) return { status: 'BLOCKED', reason: 'review_timeout_seconds must be a positive integer' }
const TIMEOUT_S = A.review_timeout_seconds || 1200
const RULES = [
  `Repo: ${A.repo}, branch ${A.work_branch}. Do not change code in this stage; you only run checks and report.`,
  'Never deploy, never run Terraform, never touch production resources.',
  'Report only observed numbers. Anything not run is NOT RUN, never a pass.',
  'If any command is blocked, or a tool or the API refuses, STOP and report blocked=true. Never reproduce its effect another way.',
].join('\n- ')

const CHECK = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_RUN'] },
    blocked: { type: 'boolean' },
    observed: { type: 'string' },
    minutes_used: { type: 'number' },
    evidence_path: { type: 'string' },
    ...STATE,
  },
  required: ['status', 'observed', ...STATE_REQ],
}
const FINDINGS = { type: 'array', items: { type: 'object', properties: {
  severity: { type: 'string' }, location: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
  required: ['severity', 'title'] } }
const REVIEW = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NEEDS_HUMAN', 'ERROR'] }, confirmed_findings: FINDINGS, note: { type: 'string' }, blocked: { type: 'boolean' }, head_sha: { type: 'string' } },
  required: ['verdict', 'confirmed_findings', 'head_sha'],
}
const COMPLY = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR'] }, blocking: FINDINGS, note: { type: 'string' }, blocked: { type: 'boolean' }, ...STATE },
  required: ['verdict', 'blocking', ...STATE_REQ],
}

phase('Checks')
const results = []
for (const c of (A.checks || [])) {
  const budget = c.budget_min > 0
    ? `HARD CAP: ${c.budget_min} minutes of live or paid usage. Keep a ledger at ${A.run_dir}/${c.name}-ledger.txt. Stop at the cap and record the rest as NOT RUN.\n`
    : 'Make NO live or paid external calls in this check. If it needs any, report NOT_RUN.\n'
  const r = await agent(
    `Run the "${c.name}" check for feature ${A.feature_id}.\n${c.how}\n${budget}` +
    (c.quiet ? 'Run only on a quiet machine: before launching, check that no other heavy test process is running. Wait (bounded) if one is, and report NOT_RUN if the machine never goes quiet.\n' : '') +
    `Save evidence under ${A.run_dir}/${c.name}/. ${stateNote}\n- ${RULES}`,
    { label: c.name, phase: 'Checks', schema: CHECK, effort: c.effort || 'medium' })
  if (!r || r.blocked) return { status: 'BLOCKED', stage: c.name, check: r, results }
  const drift = pinned(r)
  if (drift.length) return { status: 'HEAD_MOVED', stage: c.name, reason: 'check did not run on the clean reviewed commit: ' + drift.join('; '), check: r, results }
  results.push({ name: c.name, ...r })
}

phase('Final review')
const out = `${A.run_dir}/final-review`
// Review the WHOLE change base_commit..reviewed_sha via the runner's diff mode: replay it as uncommitted edits in a
// throwaway worktree at base_commit. The branch head must still be reviewed_sha, or the checks above ran on other code.
const patch = `${out}/change.patch`
const wt = `${out}/wt`
const fin = await agent(
  `Run an independent codex implementation review of the CHANGE this feature made and report its verdict. Do not review the code yourself.\n` +
  `Report head_sha = git -C ${q(A.repo)} rev-parse HEAD, read first.\n` +
  `Set up the review checkout first (Bash, in order; stop and report blocked if any step fails):\n` +
  `1. mkdir -p ${q(out)} && git -C ${q(A.repo)} diff --binary --no-renames ${A.base_commit} ${A.reviewed_sha} > ${q(patch)}\n` +
  `2. git -C ${q(A.repo)} worktree add --detach ${q(wt)} ${A.base_commit}\n` +
  `3. git -C ${q(wt)} apply --index ${q(patch)}\n` +
  `After result.json exists (or the run fails), remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(wt)}\n` +
  `Command (Bash): node ${q(A.review_runner)} --kind implementation --uncommitted --repo ${q(wt)} --out-dir ${q(out)}` +
  `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}\n` +
  `It can run for up to ~${Math.ceil(TIMEOUT_S * 6 / 60) + 5} minutes: run it in the background and poll for ${out}/*/result.json with a bounded wait loop of that length.\n` +
  `Exit codes: 0 PASS, 1 FAIL, 3 NEEDS_HUMAN, 2 setup error (report ERROR). Return ONLY confirmed findings.\n- ${RULES}`,
  { label: 'codex final review', phase: 'Final review', schema: REVIEW, effort: 'low' })
if (!fin || fin.blocked || fin.verdict === 'ERROR' || (fin.verdict === 'NEEDS_HUMAN' && !fin.confirmed_findings.length)) return { status: 'BLOCKED', stage: 'final review', results, final_review: fin }
// Findings decide, not the self-reported verdict.
if (fin.verdict === 'PASS' && fin.confirmed_findings.length) fin.verdict = 'FAIL'
if (fin.head_sha !== A.reviewed_sha) return { status: 'HEAD_MOVED', reason: `branch head is ${fin.head_sha}, build reviewed ${A.reviewed_sha}: re-run build`, results, final_review: fin }

const cout = `${A.run_dir}/compliance`
const comp = await agent(
  `Run an independent codex SPEC-COMPLIANCE trace and report its verdict. Do not judge it yourself.\n` +
  `0. Create ${cout}/ and an isolated checkout of the reviewed commit, so every file codex reads is that commit's: git -C ${q(A.repo)} worktree add --detach ${q(cout + '/wt')} ${A.reviewed_sha}. ` +
  `After compliance.json exists (or the run fails), remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(cout + '/wt')}\n` +
  `1. Write ${cout}/prompt.md containing: "Trace every requirement and acceptance check in the spec ${A.spec_path} to the implementation in this repository ` +
  `(the change is git diff ${A.base_commit} ${A.reviewed_sha}; this checkout is at ${A.reviewed_sha}) and its tests. For each requirement that is missing, implemented differently from the spec, ` +
  `or not covered by a test that would fail if it broke, report a finding of severity high that quotes the spec line and the code (a requirement with no test that would fail if it broke is high, never lower). verdict FAIL if any such finding exists, else PASS."\n` +
  `2. Run under a HARD process timeout so codex can never outlive this step (Bash, in the background, then poll up to ~32 minutes for ${cout}/compliance.json; if the timeout fires the process is already killed: report ERROR): ` +
  `timeout --kill-after=60 1800 codex exec${A.codex_model ? ` -m ${q(A.codex_model)}` : ''} -c model_reasoning_effort=${A.codex_effort || 'high'} -s read-only -C ${q(cout + '/wt')} --output-schema ${q(A.compliance_schema)} -o ${q(cout + '/compliance.json')} - < ${q(cout + '/prompt.md')}\n` +
  `3. Return verdict and EVERY finding as blocking (each one is a requirement missing, wrong or untested). If codex errors, hits a usage cap, or writes no valid JSON, return ERROR with the reason in note.\n` +
  `Around the whole of steps 0-2 (on the main repo, not the isolated checkout): ${stateNote}\n- ${RULES}`,
  { label: 'codex spec compliance', phase: 'Final review', schema: COMPLY, effort: 'low' })
if (!comp || comp.blocked || comp.verdict === 'ERROR') return { status: 'BLOCKED', stage: 'compliance', results, final_review: fin, compliance: comp }
if (comp.blocking.length) comp.verdict = 'FAIL'
const compDrift = pinned(comp)
if (compDrift.length) return { status: 'HEAD_MOVED', stage: 'compliance', reason: 'compliance trace did not run on the clean reviewed commit: ' + compDrift.join('; '), results, final_review: fin, compliance: comp }

const failed = results.filter(r => r.status !== 'PASS')
const status = fin.verdict !== 'PASS' || comp.verdict !== 'PASS' ? 'FAIL' : failed.length ? 'INCOMPLETE' : 'PASS'
return { status, results, final_review: fin, compliance: comp }
