export const meta = {
  name: 'gated-design',
  description: 'PRD and spec written by Claude, each reviewed by codex until PASS',
  whenToUse: 'Stage 1 of the gated-pipeline skill: turn a task into a frozen PRD + spec',
  phases: [
    { title: 'PRD', detail: 'write and revise the PRD' },
    { title: 'PRD review', detail: 'codex reviews the PRD' },
    { title: 'Spec', detail: 'write and revise the spec' },
    { title: 'Spec review', detail: 'codex reviews the spec against the PRD' },
    { title: 'Freeze', detail: 'pin the reviewed spec and acceptance inventory' },
  ],
}

const A = args || {}
const need = ['feature_id', 'repo', 'task', 'run_dir', 'review_runner', 'execution_schema']
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
// Paths go into shell commands: single-quoted, and only from a conservative character set.
const SAFE = /^[A-Za-z0-9._\/\\: +@-]+$/
for (const k of ['repo', 'run_dir', 'review_runner', 'execution_schema']) {
  if (!SAFE.test(A[k]) || !/^([A-Za-z]:[\/\\]|\/)/.test(A[k])) return { status: 'BLOCKED', reason: `${k} must be an absolute path of safe characters (no ~, quotes, $ or backticks): ${A[k]}` }
}

const q = s => `'${s}'`
// Config values that reach shell commands must be plain tokens.
if (A.codex_model && !/^[A-Za-z0-9._-]+$/.test(A.codex_model)) return { status: 'BLOCKED', reason: 'codex_model must match [A-Za-z0-9._-]' }
if (A.codex_effort && !['low', 'medium', 'high', 'xhigh'].includes(A.codex_effort)) return { status: 'BLOCKED', reason: 'codex_effort must be low|medium|high|xhigh' }
if (A.review_timeout_seconds !== undefined && !(Number.isInteger(A.review_timeout_seconds) && A.review_timeout_seconds > 0)) return { status: 'BLOCKED', reason: 'review_timeout_seconds must be a positive integer' }
if (A.review_fallback !== undefined && !['none', 'opus-high'].includes(A.review_fallback)) return { status: 'BLOCKED', reason: 'review_fallback must be none|opus-high' }
const TIMEOUT_S = A.review_timeout_seconds || 1200
const MAX = A.max_rounds ?? 3
const EFFORT = A.author_effort || 'medium'
const prd = `${A.run_dir}/prd.md`
const spec = `${A.run_dir}/spec.md`
const manifest = `${A.run_dir}/execution-plan.json`
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
// The codex relay also reports whether codex exists here at all; the Opus stand-in uses the plain review schema.
const RELAY = { ...REVIEW, properties: { ...REVIEW.properties, codex_available: { type: 'boolean' } }, required: [...REVIEW.required, 'codex_available'] }
const FALLBACK_REVIEWER = 'claude-opus-high (codex unavailable)'
// Wait in the FOREGROUND: a relay that ends its turn while codex runs in the background kills the review.
const waitNote = (lsTarget, minutes) => `It can run for up to ~${minutes} minutes. Start it with the Bash tool's run_in_background, then WAIT IN THE FOREGROUND: ` +
  `make repeated foreground Bash calls (Bash timeout 600000 ms), each a bounded loop of at most 9 minutes: ` +
  `for i in $(seq 1 54); do ls ${lsTarget} >/dev/null 2>&1 && break; sleep 10; done ; repeat until the result exists or that total time has passed. ` +
  'NEVER return or end your turn while the review process is still running: returning kills it and loses the review. ' +
  'If the total time passes with no result, report ERROR with what the run folder contains.'
const availNote = `First check that codex is AVAILABLE in this environment: run codex --version and node ${q(A.review_runner)} --help. ` +
  'If either cannot run or exits non-zero (not installed, command not found), do NOT start the review: return codex_available=false, verdict ERROR, empty finding lists, and the observed output in note. ' +
  'Otherwise codex_available=true. A usage cap or quota error is NOT unavailability: it stays codex_available=true with verdict ERROR.\n'
// Only "codex not available" may fall back, and only when the repo opted in; a capped codex still stops (ERROR -> BLOCKED).
async function reviewed(relay, fallback) {
  const r = await relay()
  if (!r || r.codex_available !== false) return r && { ...r, reviewer: 'codex' }
  if ((A.review_fallback || 'none') !== 'opus-high') return { ...r, blocked: true, reviewer: 'none', note: `codex is not available in this environment and review_fallback is none. ${r.note || ''}` }
  const f = await fallback()
  return f && { ...f, codex_available: false, reviewer: FALLBACK_REVIEWER }
}
// NEEDS_HUMAN only because codex's own verdict disagreed with the runner's rule, with findings still listed: those findings
// are revisable, so they go to the author instead of stopping the stage. Every other NEEDS_HUMAN without confirmed findings stops.
const disagreementOnly = r => r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && r.other_findings.length &&
  r.verdict_reasons.length > 0 && r.verdict_reasons.every(x => /model_rule_disagreement/.test(x))

function codex(kind, file, against, out, label, ph, inventory) {
  return reviewed(() => agent(
    `Run an independent codex ${kind} review and report its verdict. Do not review the document yourself.\n${availNote}` +
    (inventory ? 'Review the execution inventory against the spec too: every acceptance ID and proof command must match, scope must be explicit, and inapplicable checks must have a reason.\n' : '') +
    `Command (Bash): node ${q(A.review_runner)} --kind ${kind} --files ${q(file)}${inventory ? ' ' + q(inventory) : ''}${against ? ` --against ${q(against)}` : ''} --repo ${q(A.repo)} --out-dir ${q(out)}` +
    `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}\n` +
    `${waitNote(`${q(out)}/*/result.json`, Math.ceil(TIMEOUT_S * 6 / 60) + 5)}\n` +
    `Exit codes: 0 PASS, 1 FAIL, 3 NEEDS_HUMAN, 2 setup error (report ERROR). Read the result.json of the run folder THIS command created (the newest; ignore older folders). ` +
    `Put findings whose validation.status is "confirmed" in confirmed_findings, every other non-refuted finding in other_findings, and copy result.json's verdict_reasons verbatim. ` +
    `If codex reports a usage cap or quota error, return ERROR with that text in note.\n- ${RULES}`,
    { label, phase: ph, schema: RELAY, effort: 'low' }),
  () => agent(
    `Codex is not available in this environment, so YOU are the independent ${kind} reviewer in its place (the repo config chose review_fallback: opus-high). ` +
    `Review ${file}${inventory ? ` and the execution inventory ${inventory}` : ''}${against ? ` against ${against}` : ''} for defects: missing or contradicted requirements, ` +
    'claims the repo does not support (read the code), untestable or vague acceptance checks, and gaps in scope.\n' +
    (inventory ? 'Review the execution inventory against the spec too: every acceptance ID and proof command must match, scope must be explicit, and inapplicable checks must have a reason.\n' : '') +
    'Put each defect you verified against the document and the repo in confirmed_findings, anything plausible but unverified in other_findings, and one short line per reason for your verdict in verdict_reasons. ' +
    `verdict PASS only when confirmed_findings is empty. Do not edit any file.\n- ${RULES}`,
    { label: `${label} (opus fallback)`, phase: ph, schema: REVIEW, model: 'opus', effort: 'high' }))
}

async function loop(kind, path, writePrompt, against, ph, rph, inventory) {
  let doc = await agent(writePrompt(null), { label: `${kind} draft`, phase: ph, schema: DOC, effort: EFFORT })
  if (!doc || doc.blocked) return { status: 'BLOCKED', stage: kind, reason: doc ? doc.blocked_reason : 'author died' }
  for (let round = 1; round <= MAX; round++) {
    const r = await codex(kind, path, against, `${A.run_dir}/${kind}-review-${round}`, `codex ${kind} review ${round}`, rph, inventory)
    if (!r || r.blocked || r.verdict === 'ERROR' || (r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && !disagreementOnly(r))) return { status: 'BLOCKED', stage: `${kind} review`, round, review: r }
    if (r.verdict === 'PASS' && !r.confirmed_findings.length) return { status: 'PASS', rounds: round, path, reviewer: r.reviewer }
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
  ? `Revise the spec at ${spec} and its execution inventory at ${manifest} (traced against ${prd}) to resolve these confirmed codex findings (or explain why one is wrong). Recompute spec_sha256 in the inventory after edits:\n${items}\n- ${RULES.replace('Write ONLY the file you are asked to write', 'Write ONLY the design artifacts you are asked to write')}`
  : `Write an implementation spec for feature ${A.feature_id} to ${spec}, traced to every requirement in ${prd}. ` +
    `For each acceptance check give: an id, the behaviour, the exact proof command, and a negative control (the code mutation that must make that proof fail). ` +
    `List the files to change, protected files/non-goals, invariants, the test plan (failing test first), and, if any proof calls a live or paid external API, a hard minute/cost budget. ` +
    `For a service include boot/connectivity, success/failure/edge paths and side-effect readback where relevant. For static/document changes use static evidence; do not invent a service to boot. ` +
    `Write ${manifest} to the schema at ${A.execution_schema}: version=1, feature_id=${A.feature_id}, spec_sha256 is the SHA256 of the final spec bytes, ` +
    `requirements contains EVERY acceptance ID in order with kind runtime or static and proof_command (exact command for runtime, empty for static). ` +
    `allowed_paths lists exact repo-relative files (or deliberately scoped directory prefixes ending /); protected_paths wins over allowed_paths. ` +
    `Include state_paths and clean_ignore from the agreed repo config when used; narrow them to genuine state files, never code or verification artifacts. ` +
    `checks inventories the configured extra checks; explicitly state applicability and reason for service smoke, lint and types. ` +
    `No check may depend on behaviour the repo does not control. You may write ONLY these two design artifacts.\n- ${RULES.replace('Write ONLY the file you are asked to write', 'Write ONLY the design artifacts you are asked to write')}`,
  prd, 'Spec', 'Spec review', manifest)
if (s.status !== 'PASS') return { status: s.status, prd: p, spec: s, prd_path: prd, spec_path: spec }
phase('Freeze')
const frozen = await agent(
  `Read-only: compute SHA256 of the exact bytes of ${spec} and ${manifest} with Node crypto or sha256sum. ` +
  `Do not edit either artifact after review. Return spec_sha256 and manifest_sha256 from the observed output, not estimates.\n- ${RULES}`,
  { label: 'freeze plan identity', phase: 'Freeze', effort: 'low', schema: {
    type: 'object', properties: { blocked: { type: 'boolean' }, reason: { type: 'string' }, spec_sha256: { type: 'string' }, manifest_sha256: { type: 'string' } },
    required: ['blocked', 'spec_sha256', 'manifest_sha256'],
  } })
if (!frozen || frozen.blocked || !/^[0-9a-f]{64}$/.test(frozen.spec_sha256) || !/^[0-9a-f]{64}$/.test(frozen.manifest_sha256)) return { status: 'BLOCKED', stage: 'freeze', reason: frozen && frozen.reason || 'missing observed plan hashes' }
return { status: 'PASS', feature_id: A.feature_id, prd: p, spec: s, prd_path: prd, spec_path: spec, manifest_path: manifest, spec_sha256: frozen.spec_sha256, manifest_sha256: frozen.manifest_sha256 }
