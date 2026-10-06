export const meta = {
  name: 'gated-verify',
  description: 'Repo-specific extra checks one at a time, then codex final review + spec-compliance trace',
  whenToUse: 'Mandatory stage 3: acceptance evidence and compliance, with configured extra checks',
  phases: [
    { title: 'Plan preflight', detail: 'validate frozen spec and inventory before executing commands' },
    { title: 'Checks', detail: 'each configured check, sequentially' },
    { title: 'Acceptance proofs', detail: 'save final-commit evidence for every frozen acceptance item' },
    { title: 'Final review', detail: 'codex defect review of the whole change, then a spec-compliance trace' },
    { title: 'Completion', detail: 'mechanically reconcile inventory, artifacts and approved scope' },
  ],
}

const A = args || {}
const need = ['feature_id', 'repo', 'work_branch', 'run_dir', 'review_runner', 'spec_path', 'compliance_schema', 'manifest_path', 'manifest_sha256', 'build_result_path', 'completion_runner']
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
// Paths go into shell commands: single-quoted, and only from a conservative character set.
const SAFE = /^[A-Za-z0-9._\/\\: +@-]+$/
const ABS = /^([A-Za-z]:|[\/\\])/
const DOTDOT = /(^|[\/\\])\.\.([\/\\]|$)/
for (const k of ['repo', 'run_dir', 'review_runner', 'spec_path', 'compliance_schema', 'manifest_path', 'build_result_path', 'completion_runner']) {
  if (!SAFE.test(A[k]) || !/^([A-Za-z]:[\/\\]|\/)/.test(A[k])) return { status: 'BLOCKED', reason: `${k} must be an absolute path of safe characters (no ~, quotes, $ or backticks): ${A[k]}` }
}
if (!/^[0-9a-f]{64}$/.test(A.manifest_sha256)) return { status: 'BLOCKED', reason: 'manifest_sha256 must be the frozen 64-hex design hash' }
if (!/^[A-Za-z0-9._-]+$/.test(A.feature_id)) return { status: 'BLOCKED', reason: 'feature_id must match [A-Za-z0-9._-]' }
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
if (A.review_fallback !== undefined && !['none', 'opus-high'].includes(A.review_fallback)) return { status: 'BLOCKED', reason: 'review_fallback must be none|opus-high' }
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
    evidence_sha256: { type: 'string' },
    ...STATE,
  },
  required: ['status', 'observed', 'evidence_path', 'evidence_sha256', ...STATE_REQ],
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
  properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR'] }, blocking: FINDINGS, requirements: { type: 'array', items: { type: 'object' } }, note: { type: 'string' }, blocked: { type: 'boolean' }, ...STATE },
  required: ['verdict', 'blocking', 'requirements', ...STATE_REQ],
}
// Codex relays also report whether codex exists here at all; the Opus stand-in uses the plain schemas.
const relay = s => ({ ...s, properties: { ...s.properties, codex_available: { type: 'boolean' } }, required: [...s.required, 'codex_available'] })
const FALLBACK_REVIEWER = 'claude-opus-high (codex unavailable)'
const availNote = runner => `First check that codex is AVAILABLE in this environment: run codex --version${runner ? ` and node ${q(A.review_runner)} --help` : ''}. ` +
  `If ${runner ? 'either' : 'it'} cannot run or exits non-zero (not installed, command not found), do NOT start the review: return codex_available=false, verdict ERROR, empty finding lists, and the observed output in note. ` +
  'Otherwise codex_available=true. A usage cap or quota error is NOT unavailability: it stays codex_available=true with verdict ERROR.\n'
// Wait in the FOREGROUND: a relay that ends its turn while codex runs in the background kills the review.
const waitNote = (lsTarget, minutes) => `It can run for up to ~${minutes} minutes. Start it with the Bash tool's run_in_background, then WAIT IN THE FOREGROUND: ` +
  `make repeated foreground Bash calls (Bash timeout 600000 ms), each a bounded loop of at most 9 minutes: ` +
  `for i in $(seq 1 54); do ls ${lsTarget} >/dev/null 2>&1 && break; sleep 10; done ; repeat until the result exists or that total time has passed. ` +
  'NEVER return or end your turn while the review process is still running: returning kills it and loses the review. ' +
  'If the total time passes with no result, report ERROR with what the run folder contains.'
// Only "codex not available" may fall back, and only when the repo opted in; a capped codex still stops (ERROR -> BLOCKED).
async function reviewed(viaCodex, fallback) {
  const r = await viaCodex()
  if (!r || r.codex_available !== false) return r && { ...r, reviewer: 'codex' }
  if ((A.review_fallback || 'none') !== 'opus-high') return { ...r, blocked: true, reviewer: 'none', note: `codex is not available in this environment and review_fallback is none. ${r.note || ''}` }
  const f = await fallback()
  return f && { ...f, codex_available: false, reviewer: FALLBACK_REVIEWER }
}

phase('Plan preflight')
const plan = await agent(
  `Validate the frozen plan BEFORE running any check or proof command. Run the read-only validator:\n` +
  `node ${q(A.completion_runner)} --mode plan --repo ${q(A.repo)} --feature-id ${q(A.feature_id)} --reviewed-sha ${A.reviewed_sha} ` +
  `--manifest ${q(A.manifest_path)} --manifest-sha256 ${A.manifest_sha256} --spec ${q(A.spec_path)}\n` +
  `Return passed=true only on exit 0; copy the observed manifest_sha256, spec_sha256 and reviewed_sha. ` +
  `STOP on mismatch or error; do not execute anything from a changed manifest.\n- ${RULES}`,
  { label: 'plan preflight', phase: 'Plan preflight', effort: 'low', schema: {
    type: 'object', properties: { passed: { type: 'boolean' }, blocked: { type: 'boolean' }, reason: { type: 'string' }, manifest_sha256: { type: 'string' }, spec_sha256: { type: 'string' }, reviewed_sha: { type: 'string' } },
    required: ['passed', 'manifest_sha256', 'spec_sha256', 'reviewed_sha'],
  } })
if (!plan || plan.blocked || !plan.passed || plan.manifest_sha256 !== A.manifest_sha256 || plan.reviewed_sha !== A.reviewed_sha || !/^[0-9a-f]{64}$/.test(plan.spec_sha256)) return { status: 'BLOCKED', stage: 'plan preflight', plan }

phase('Checks')
const results = []
for (const c of (A.checks || [])) {
  const budget = c.budget_min > 0
    ? `HARD CAP: ${c.budget_min} minutes of live or paid usage. Keep a ledger at ${A.run_dir}/${c.name}-ledger.txt. Stop at the cap and record the rest as NOT RUN.\n`
    : 'Make NO live or paid external calls in this check. If it needs any, report NOT_RUN.\n'
  const r = await agent(
    `Run the "${c.name}" check for feature ${A.feature_id}.\n${c.how}\n${budget}` +
    (c.quiet ? 'Run only on a quiet machine: before launching, check that no other heavy test process is running. Wait (bounded) if one is, and report NOT_RUN if the machine never goes quiet.\n' : '') +
    `Save the full evidence output as a file under ${A.run_dir}/${c.name}/; return evidence_path and SHA256 of its saved bytes as evidence_sha256. ${stateNote}\n- ${RULES}`,
    { label: c.name, phase: 'Checks', schema: CHECK, effort: c.effort || 'medium' })
  if (!r || r.blocked) return { status: 'BLOCKED', stage: c.name, check: r, results }
  const drift = pinned(r)
  if (drift.length) return { status: 'HEAD_MOVED', stage: c.name, reason: 'check did not run on the clean reviewed commit: ' + drift.join('; '), check: r, results }
  results.push({ name: c.name, ...r })
}

phase('Acceptance proofs')
const ledger = `${A.run_dir}/acceptance-ledger.json`
const proofs = await agent(
  `Read the frozen inventory ${A.manifest_path} (SHA256 must be ${A.manifest_sha256}) and spec ${A.spec_path} (SHA256 must be ${plan.spec_sha256}). ` +
  `Compute and compare both hashes immediately before executing each command; STOP on any mismatch. ` +
  `In ${A.repo} at ${A.reviewed_sha}, execute each runtime proof_command exactly, sequentially, with the repo's test lock rules. ` +
  `Capture the full output in a distinct file under ${A.run_dir}/acceptance/ and record id, status PASS/FAIL/NOT_RUN and evidence ` +
  `(kind, head_sha, command, exit_code, log_path, log_sha256, file, line; unused values are null). Hash the actual saved output bytes at capture. Use actual source file/line for static items. ` +
  `Do not edit code or run negative-control mutations on this checkout. Do not make live or paid calls here: reuse final-commit outputs ` +
  `from the budgeted configured checks when their exact command matches, or mark that item NOT_RUN. ` +
  `Save the per-ID records atomically to ${ledger}; preserve failed output too. ${stateNote}\n- ${RULES}`,
  { label: 'acceptance proofs', phase: 'Acceptance proofs', effort: 'medium', schema: {
    type: 'object', properties: { blocked: { type: 'boolean' }, reason: { type: 'string' }, ledger_path: { type: 'string' }, ...STATE },
    required: ['blocked', 'ledger_path', ...STATE_REQ],
  } })
if (!proofs || proofs.blocked) return { status: 'BLOCKED', stage: 'acceptance proofs', reason: proofs && proofs.reason || 'proof runner unavailable', results }
const proofDrift = pinned(proofs)
if (proofDrift.length) return { status: 'HEAD_MOVED', stage: 'acceptance proofs', reason: proofDrift.join('; '), results }
if (proofs.ledger_path !== ledger) return { status: 'BLOCKED', stage: 'acceptance proofs', reason: 'proof runner did not save the expected ledger', results }

phase('Final review')
const out = `${A.run_dir}/final-review`
// Review the WHOLE change base_commit..reviewed_sha via the runner's diff mode: replay it as uncommitted edits in a
// throwaway worktree at base_commit. The branch head must still be reviewed_sha, or the checks above ran on other code.
const patch = `${out}/change.patch`
const wt = `${out}/wt`
const finSetup = `Report head_sha = git -C ${q(A.repo)} rev-parse HEAD, read first.\n` +
  `Set up the review checkout first (Bash, in order; stop and report blocked if any step fails):\n` +
  `1. mkdir -p ${q(out)} && git -C ${q(A.repo)} diff --binary --no-renames ${A.base_commit} ${A.reviewed_sha} > ${q(patch)}\n` +
  `2. git -C ${q(A.repo)} worktree add --detach ${q(wt)} ${A.base_commit}\n` +
  `3. git -C ${q(wt)} apply --index ${q(patch)}\n`
const fin = await reviewed(() => agent(
  `Run an independent codex implementation review of the CHANGE this feature made and report its verdict. Do not review the code yourself.\n${availNote(true)}` +
  finSetup +
  `After result.json exists (or the run fails), remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(wt)}\n` +
  `Command (Bash): node ${q(A.review_runner)} --kind implementation --uncommitted --repo ${q(wt)} --out-dir ${q(out)}` +
  `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}\n` +
  `${waitNote(`${q(out)}/*/result.json`, Math.ceil(TIMEOUT_S * 6 / 60) + 5)}\n` +
  `Exit codes: 0 PASS, 1 FAIL, 3 NEEDS_HUMAN, 2 setup error (report ERROR). Return ONLY confirmed findings.\n- ${RULES}`,
  { label: 'codex final review', phase: 'Final review', schema: relay(REVIEW), effort: 'low' }),
() => agent(
  `Codex is not available in this environment, so YOU are the independent final implementation reviewer of the CHANGE in its place (the repo config chose review_fallback: opus-high).\n` +
  finSetup +
  `Review the change as it stands in that checkout (git -C ${q(wt)} diff --cached is the whole change ${A.base_commit}..${A.reviewed_sha}; read any other file there for context) ` +
  `for correctness bugs, behaviour that contradicts the spec ${A.spec_path}, and unsafe code. Report findings ONLY in that change, and ONLY defects you verified against the code, as confirmed_findings. ` +
  `verdict PASS only when there are none. When your review is done, remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(wt)}\n- ${RULES}`,
  { label: 'opus final review (codex unavailable)', phase: 'Final review', schema: REVIEW, model: 'opus', effort: 'high' }))
if (!fin || fin.blocked || fin.verdict === 'ERROR' || (fin.verdict === 'NEEDS_HUMAN' && !fin.confirmed_findings.length)) return { status: 'BLOCKED', stage: 'final review', results, final_review: fin }
// Findings decide, not the self-reported verdict.
if (fin.verdict === 'PASS' && fin.confirmed_findings.length) fin.verdict = 'FAIL'
if (fin.head_sha !== A.reviewed_sha) return { status: 'HEAD_MOVED', reason: `branch head is ${fin.head_sha}, build reviewed ${A.reviewed_sha}: re-run build`, results, final_review: fin }

const cout = `${A.run_dir}/compliance`
const compIsolate = `0. Create ${cout}/ and an isolated checkout of the reviewed commit, so every file read is that commit's: git -C ${q(A.repo)} worktree add --detach ${q(cout + '/wt')} ${A.reviewed_sha}. `
const compTask = `Trace every requirement and acceptance check in the spec ${A.spec_path} and frozen inventory ${A.manifest_path} to the implementation in this repository ` +
  `(the change is git diff ${A.base_commit} ${A.reviewed_sha}; this checkout is at ${A.reviewed_sha}) and its tests. For each requirement that is missing, implemented differently from the spec, ` +
  `or not covered by an applicable proof that would fail if it broke, report a finding of severity high that quotes the spec line and the code. ` +
  `Read the actual acceptance ledger ${ledger}, build result ${A.build_result_path} and check outputs under ${A.run_dir}. ` +
  `Return requirements with EVERY frozen ID exactly once and PASS/FAIL/NOT_RUN plus its actual evidence records. ` +
  `Runtime acceptance needs an exact executed command, exit code, nonempty output file and head_sha=${A.reviewed_sha}; a file/line alone only proves a static claim. ` +
  `Do not execute commands or invent missing evidence. verdict FAIL for any missing/wrong/unproven item, else PASS.`
const comp = await reviewed(() => agent(
  `Run an independent codex SPEC-COMPLIANCE trace and report its verdict. Do not judge it yourself.\n${availNote(false)}` +
  compIsolate +
  `After compliance.json exists (or the run fails), remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(cout + '/wt')}\n` +
  `1. Write ${cout}/prompt.md containing: "${compTask}"\n` +
  `2. Run under a HARD process timeout so codex can never outlive this step; if the timeout fires the process is already killed: report ERROR. ${waitNote(q(cout + '/compliance.json'), 32)}\n` +
  `Command: timeout --kill-after=60 1800 codex exec${A.codex_model ? ` -m ${q(A.codex_model)}` : ''} -c model_reasoning_effort=${A.codex_effort || 'high'} -s read-only -C ${q(cout + '/wt')} --output-schema ${q(A.compliance_schema)} -o ${q(cout + '/compliance.json')} - < ${q(cout + '/prompt.md')}\n` +
  `3. Return verdict, requirements verbatim, and EVERY finding as blocking (each one is a requirement missing, wrong or unproven). If codex errors, hits a usage cap, or writes no valid JSON, return ERROR with the reason in note.\n` +
  `Around the whole of steps 0-2 (on the main repo, not the isolated checkout): ${stateNote}\n- ${RULES}`,
  { label: 'codex spec compliance', phase: 'Final review', schema: relay(COMPLY), effort: 'low' }),
() => agent(
  `Codex is not available in this environment, so YOU run the independent SPEC-COMPLIANCE trace in its place (the repo config chose review_fallback: opus-high). Do not change any file.\n` +
  compIsolate + `Work in that checkout. Afterwards remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(cout + '/wt')}\n` +
  `1. ${compTask}\n` +
  `2. Return verdict, requirements (each shaped exactly as the requirements items in ${A.compliance_schema}: id, status and evidence records copied from the ledger), and EVERY finding as blocking (each one is a requirement missing, wrong or unproven).\n` +
  `Around the whole of steps 0-1 (on the main repo, not the isolated checkout): ${stateNote}\n- ${RULES}`,
  { label: 'opus spec compliance (codex unavailable)', phase: 'Final review', schema: COMPLY, model: 'opus', effort: 'high' }))
if (!comp || comp.blocked || comp.verdict === 'ERROR') return { status: 'BLOCKED', stage: 'compliance', results, final_review: fin, compliance: comp }
if (comp.blocking.length) comp.verdict = 'FAIL'
const compDrift = pinned(comp)
if (compDrift.length) return { status: 'HEAD_MOVED', stage: 'compliance', reason: 'compliance trace did not run on the clean reviewed commit: ' + compDrift.join('; '), results, final_review: fin, compliance: comp }

const failed = results.filter(r => r.status !== 'PASS')
const status = fin.verdict !== 'PASS' || comp.verdict !== 'PASS' ? 'FAIL' : failed.length ? 'INCOMPLETE' : 'PASS'
const report = { status, feature_id: A.feature_id, base_commit: A.base_commit, reviewed_sha: A.reviewed_sha, manifest_sha256: A.manifest_sha256, results, final_review: fin, compliance: comp }
if (status !== 'PASS') return report
phase('Completion')
const reportPath = `${A.run_dir}/verify-result.json`
const proofPath = `${A.run_dir}/completion-proof.json`
const completion = await agent(
  `Write this exact Workflow result JSON atomically to ${reportPath}, without changing fields:\n${JSON.stringify(report)}\n` +
  `Then run the real deterministic completion validator (do not substitute your own judgement):\n` +
  `node ${q(A.completion_runner)} --repo ${q(A.repo)} --feature-id ${q(A.feature_id)} --reviewed-sha ${A.reviewed_sha} ` +
  `--manifest ${q(A.manifest_path)} --manifest-sha256 ${A.manifest_sha256} --spec ${q(A.spec_path)} ` +
  `--build-result ${q(A.build_result_path)} --verify-result ${q(reportPath)} --out ${q(proofPath)}\n` +
  `Return passed=true only for exit 0 and a written proof; return its proof_path, reviewed_sha and manifest_sha256 from observed output.\n- ${RULES}`,
  { label: 'completion proof', phase: 'Completion', effort: 'low', schema: {
    type: 'object', properties: { passed: { type: 'boolean' }, blocked: { type: 'boolean' }, reason: { type: 'string' }, proof_path: { type: 'string' }, reviewed_sha: { type: 'string' }, manifest_sha256: { type: 'string' } },
    required: ['passed', 'proof_path', 'reviewed_sha', 'manifest_sha256'],
  } })
if (!completion || completion.blocked) return { ...report, status: 'BLOCKED', stage: 'completion', completion }
if (!completion.passed || completion.proof_path !== proofPath || completion.reviewed_sha !== A.reviewed_sha || completion.manifest_sha256 !== A.manifest_sha256) return { ...report, status: 'INCOMPLETE', stage: 'completion', completion }
return { ...report, verify_result_path: reportPath, completion }
