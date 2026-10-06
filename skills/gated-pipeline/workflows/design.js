export const meta = {
  name: 'gated-design',
  description: 'PRD and spec written by Claude, each reviewed by codex until PASS',
  whenToUse: 'Stage 1 of the gated-pipeline skill: turn a task into a frozen PRD + spec',
  phases: [
    { title: 'PRD', detail: 'write and revise the PRD' },
    { title: 'PRD review', detail: 'codex reviews the PRD' },
    { title: 'Spec', detail: 'write and revise the spec' },
    { title: 'Spec review', detail: 'codex reviews the spec against the PRD' },
  ],
}

const A = args || {}
const need = ['feature_id', 'repo', 'task', 'run_dir', 'review_runner']
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
// Paths go into shell commands: single-quoted, and only from a conservative character set.
const SAFE = /^[A-Za-z0-9._\/\\: +@-]+$/
for (const k of ['repo', 'run_dir', 'review_runner']) {
  if (!SAFE.test(A[k]) || !/^([A-Za-z]:[\/\\]|\/)/.test(A[k])) return { status: 'BLOCKED', reason: `${k} must be an absolute path of safe characters (no ~, quotes, $ or backticks): ${A[k]}` }
}

const q = s => `'${s}'`
// Config values that reach shell commands must be plain tokens.
if (A.codex_model && !/^[A-Za-z0-9._-]+$/.test(A.codex_model)) return { status: 'BLOCKED', reason: 'codex_model must match [A-Za-z0-9._-]' }
if (A.codex_effort && !['low', 'medium', 'high', 'xhigh'].includes(A.codex_effort)) return { status: 'BLOCKED', reason: 'codex_effort must be low|medium|high|xhigh' }
if (A.review_timeout_seconds !== undefined && !(Number.isInteger(A.review_timeout_seconds) && A.review_timeout_seconds > 0)) return { status: 'BLOCKED', reason: 'review_timeout_seconds must be a positive integer' }
const TIMEOUT_S = A.review_timeout_seconds || 1200
const MAX = A.max_rounds ?? 3
const EFFORT = A.author_effort || 'medium'
const prd = `${A.run_dir}/prd.md`
const spec = `${A.run_dir}/spec.md`
const RULES = [
  `Repo: ${A.repo}. Write ONLY the file you are asked to write; do not change code, branches or git state.`,
  'Ground every statement in the repo as it is (read the code). No invented APIs, models or files.',
  'If any command is blocked, or a tool or the API refuses, STOP and report blocked=true. Never reproduce its effect another way.',
].join('\n- ')

const DOC = {
  type: 'object',
  properties: { blocked: { type: 'boolean' }, blocked_reason: { type: 'string' }, path: { type: 'string' }, summary: { type: 'string' } },
  required: ['blocked', 'path', 'summary'],
}
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NEEDS_HUMAN', 'ERROR'] },
    confirmed_findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string' }, location: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
      required: ['severity', 'title'] } },
    note: { type: 'string' }, blocked: { type: 'boolean' },
    verdict_reasons: { type: 'array', items: { type: 'string' } },
    other_findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string' }, location: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
      required: ['severity', 'title'] } },
  },
  required: ['verdict', 'confirmed_findings', 'verdict_reasons', 'other_findings'],
}
// NEEDS_HUMAN only because codex's own verdict disagreed with the runner's rule, with findings still listed: those findings
// are revisable, so they go to the author instead of stopping the stage. Every other NEEDS_HUMAN without confirmed findings stops.
const disagreementOnly = r => r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && r.other_findings.length &&
  r.verdict_reasons.length > 0 && r.verdict_reasons.every(x => /model_rule_disagreement/.test(x))

function codex(kind, file, against, out, label, ph) {
  return agent(
    `Run an independent codex ${kind} review and report its verdict. Do not review the document yourself.\n` +
    `Command (Bash): node ${q(A.review_runner)} --kind ${kind} --files ${q(file)}${against ? ` --against ${q(against)}` : ''} --repo ${q(A.repo)} --out-dir ${q(out)}` +
    `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}\n` +
    `It can run for up to ~${Math.ceil(TIMEOUT_S * 6 / 60) + 5} minutes: run it in the background and poll for ${out}/*/result.json with a bounded wait loop of that length.\n` +
    `Exit codes: 0 PASS, 1 FAIL, 3 NEEDS_HUMAN, 2 setup error (report ERROR). Read the result.json of the run folder THIS command created (the newest; ignore older folders). ` +
    `Put findings whose validation.status is "confirmed" in confirmed_findings, every other non-refuted finding in other_findings, and copy result.json's verdict_reasons verbatim. ` +
    `If codex reports a usage cap or quota error, return ERROR with that text in note.\n- ${RULES}`,
    { label, phase: ph, schema: REVIEW, effort: 'low' })
}

async function loop(kind, path, writePrompt, against, ph, rph) {
  let doc = await agent(writePrompt(null), { label: `${kind} draft`, phase: ph, schema: DOC, effort: EFFORT })
  if (!doc || doc.blocked) return { status: 'BLOCKED', stage: kind, reason: doc ? doc.blocked_reason : 'author died' }
  for (let round = 1; round <= MAX; round++) {
    const r = await codex(kind, path, against, `${A.run_dir}/${kind}-review-${round}`, `codex ${kind} review ${round}`, rph)
    if (!r || r.blocked || r.verdict === 'ERROR' || (r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && !disagreementOnly(r))) return { status: 'BLOCKED', stage: `${kind} review`, round, review: r }
    if (r.verdict === 'PASS' && !r.confirmed_findings.length) return { status: 'PASS', rounds: round, path }
    if (round === MAX) return { status: 'FAIL', stage: `${kind} review`, rounds: round, review: r }
    const items = (r.confirmed_findings.length ? r.confirmed_findings : r.other_findings).map(f => `[${f.severity}] ${f.location || ''} ${f.title}: ${f.detail || ''}`).join('\n')
    doc = await agent(writePrompt(items), { label: `${kind} revise ${round}`, phase: ph, schema: DOC, effort: EFFORT })
    if (!doc || doc.blocked) return { status: 'BLOCKED', stage: kind, reason: doc ? doc.blocked_reason : 'author died' }
  }
  return { status: 'FAIL', stage: kind, reason: 'max_rounds is 0' }
}

phase('PRD')
const p = await loop('prd', prd, items => items
  ? `Revise the PRD at ${prd} for feature ${A.feature_id} to resolve these confirmed codex findings (or explain in summary why one is wrong):\n${items}\n- ${RULES}`
  : `Write a PRD for feature ${A.feature_id} to ${prd}. TASK:\n${A.task}\n\n` +
    `Cover: the problem and who has it; the user-visible behaviour wanted; scope and explicit non-goals; constraints from the repo's CLAUDE.md; ` +
    `risks; and measurable success criteria. Keep it short and concrete.\n- ${RULES}`,
  null, 'PRD', 'PRD review')
if (p.status !== 'PASS') return { status: p.status, prd: p }

phase('Spec')
const s = await loop('spec', spec, items => items
  ? `Revise the spec at ${spec} (traced against ${prd}) to resolve these confirmed codex findings (or explain why one is wrong):\n${items}\n- ${RULES}`
  : `Write an implementation spec for feature ${A.feature_id} to ${spec}, traced to every requirement in ${prd}. ` +
    `For each acceptance check give: an id, the behaviour, the exact proof command, and a negative control (the code mutation that must make that proof fail). ` +
    `List the files to change, the test plan (failing test first), and, if any proof calls a live or paid external API, a hard minute/cost budget. ` +
    `No check may depend on behaviour the repo does not control.\n- ${RULES}`,
  prd, 'Spec', 'Spec review')
return { status: s.status, prd: p, spec: s, prd_path: prd, spec_path: spec }
