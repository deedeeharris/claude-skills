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
// Optional repo security docs (threat model, accepted risks): absolute paths, validated like every other path arg.
if (A.security_docs !== undefined && (!Array.isArray(A.security_docs) || A.security_docs.some(p => typeof p !== 'string' || !SAFE.test(p) || !/^([A-Za-z]:[\/\\]|\/)/.test(p)))) return { status: 'BLOCKED', reason: 'security_docs must be a list of absolute paths of safe characters (no ~, quotes, $ or backticks)' }
const SEC_DOCS = A.security_docs || []

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
const FALLBACK_REVIEWER = 'claude-opus-high (codex unavailable)'

// Opus fallback parity with codex-review: same rubric file, severity scale and verdict rule as run-review.js
// (computeTriggers/computeVerdict). The reviewer reports findings; the verdict is computed here, never by the model.
const PARITY_RUBRICS = A.review_runner.replace(/[\/\\][^\/\\]+$/, '').replace(/[\/\\]scripts$/, '') + '/rubrics'
const PARITY_SCHEMA = (extra = {}) => ({
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['BLOCKING', 'MAJOR', 'MINOR', 'NIT'] }, confidence: { type: 'number' },
      iso_property: { type: ['string', 'null'] }, location: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
      required: ['severity', 'confidence', 'title'] } },
    note: { type: 'string' }, blocked: { type: 'boolean' }, ...extra,
  },
  required: ['findings', ...Object.keys(extra)],
})
const parityNote = kind => `Apply the codex-review rubric at ${PARITY_RUBRICS}/${kind}.md (read it first; report only what it allows) and its severity scale: ` +
  'BLOCKING = must be fixed before use (data loss, security exposure, crash on a normal path, or unusable as the basis for the next stage); ' +
  'MAJOR = a real defect that causes wrong behavior or rework; MINOR = real but low-impact; NIT = style. ' +
  'confidence = probability the finding is real: >= 0.8 only when you checked it against the artifact text or code path, 0.5-0.8 likely, < 0.5 speculative. ' +
  'Validate every BLOCKING or MAJOR finding yourself before reporting it: re-open the cited location, and drop it if the evidence does not hold. ' +
  (kind === 'implementation' ? 'iso_property is always null. ' : 'iso_property is one of ambiguous|unverifiable|missing_acceptance_criteria|inconsistent|infeasible|incomplete, or null for other gaps. ') +
  'Report every finding in findings with location and detail (quote the evidence). Do NOT decide the verdict: the workflow applies the codex-review rule.'
// --- #37 gate rule: this block is the same in design.js, build.js and verify.js. ISO_SET, computeTriggers and
// computeVerdict are byte-identical copies of codex-review's run-review.js (tests/fallback-parity.test.js checks).
const ISO_SET = new Set(['ambiguous', 'unverifiable', 'missing_acceptance_criteria', 'inconsistent', 'infeasible', 'incomplete']);
function computeTriggers(kind, findings) {
  if (kind === 'implementation') {
    return findings.filter((f) => f.severity === 'BLOCKING' || (f.severity === 'MAJOR' && f.confidence >= 0.8));
  }
  const major = findings.filter((f) => f.severity === 'MAJOR');
  const byCount = major.length >= 3 ? major : [];
  const byIso = major.filter((f) => f.iso_property && ISO_SET.has(f.iso_property));
  const blocking = findings.filter((f) => f.severity === 'BLOCKING');
  const byId = new Map();
  for (const f of [...blocking, ...byIso, ...byCount]) byId.set(f.id, f);
  return [...byId.values()];
}
function computeVerdict(kind, findings, modelVerdict) {
  const reasons = [];
  const counted = findings.filter((f) => !f.validation || f.validation.status !== 'refuted');
  const triggers = computeTriggers(kind, counted);
  if (triggers.length > 0) {
    const confirmed = triggers.filter((f) => f.validation && f.validation.status === 'confirmed');
    if (confirmed.length > 0) {
      for (const f of confirmed) reasons.push(`${f.id} ${f.severity} conf ${f.confidence} (${kind})`);
      return { verdict: 'FAIL', reasons };
    }
    if (triggers.every((f) => f.validation && f.validation.status === 'unvalidated')) {
      reasons.push('validation_unavailable: all triggering findings unvalidated');
      return { verdict: 'NEEDS_HUMAN', reasons };
    }
    reasons.push('triggering findings left in an unexpected validation state');
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  const lowConf = counted.find((f) => (f.severity === 'BLOCKING' || f.severity === 'MAJOR') && f.confidence >= 0.5 && f.confidence < 0.8);
  if (lowConf) {
    reasons.push(`${lowConf.id} ${lowConf.severity} conf ${lowConf.confidence} in 0.5-0.8 band`);
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  // Both computed from `counted` (refuted findings already excluded above), never from
  // the raw `findings` — a refuted BLOCKING/MAJOR must never affect this comparison, the
  // same rule every other branch above already applies.
  const preTriggers = computeTriggers(kind, counted);
  const preVerdict = preTriggers.length > 0 ? 'FAIL'
    : counted.some((f) => (f.severity === 'BLOCKING' || f.severity === 'MAJOR') && f.confidence >= 0.5 && f.confidence < 0.8) ? 'NEEDS_HUMAN' : 'PASS';
  if (modelVerdict !== preVerdict) {
    reasons.push(`model_rule_disagreement: model said ${modelVerdict}, rule says ${preVerdict}`);
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  reasons.push('no triggering findings');
  return { verdict: 'PASS', reasons };
}
// Normalized finding for both reviewers: { id, severity, confidence, iso_property, validation_status, title, detail,
// location } with location a string. The workflow decides the buckets, never the relay: confirmed_findings = every
// validated-confirmed BLOCKING/MAJOR, other_findings = every other non-refuted finding (#37, design section 9).
const gateBig = x => x.severity === 'BLOCKING' || x.severity === 'MAJOR'
const gateStr = v => (v == null ? '' : String(v))
const gateLoc = l => (l && typeof l === 'object' ? (l.file ? l.file + (l.line != null ? ':' + l.line : '') : gateStr(l.section)) : gateStr(l))
function gateOf(kind, reply, findings, modelVerdict) {
  const v = computeVerdict(kind, findings.map(x => ({ ...x, validation: { status: x.validation_status } })), modelVerdict)
  const confirmed = findings.filter(x => gateBig(x) && x.validation_status === 'confirmed')
  return { ...reply, findings, verdict: v.verdict, verdict_reasons: v.reasons, confirmed_findings: confirmed,
    other_findings: findings.filter(x => !confirmed.includes(x) && x.validation_status !== 'refuted') }
}
const gateBlocked = (reply, reason) => ({ ...reply, blocked: true, reason })
// Codex: the relay copied result.json field by field; its verdict must be the one computeVerdict gives for its findings.
function gateCodex(kind, reply) {
  if (!reply || reply.blocked) return reply
  if (!Array.isArray(reply.findings) || !('model_verdict' in reply)) return gateBlocked(reply, 'relay inconsistency: the reply lacks findings or model_verdict')
  if (reply.outcome !== 'ok' || reply.unable_to_review != null) return gateBlocked(reply, `codex-review outcome ${reply.outcome}` +
    `${reply.unable_to_review != null ? `, unable_to_review: ${reply.unable_to_review}` : ''}, verdict ${reply.verdict}: ${(reply.verdict_reasons || []).join('; ')}`)
  const findings = reply.findings.map(x => ({ id: gateStr(x.id), severity: x.severity, confidence: x.confidence, iso_property: x.iso_property ?? null,
    validation_status: gateStr(x.validation_status), title: gateStr(x.claim), detail: gateStr(x.evidence), location: gateLoc(x.location) }))
  const g = gateOf(kind, reply, findings, reply.model_verdict)
  return g.verdict === reply.verdict ? g : gateBlocked(reply, `relay inconsistency: relayed verdict ${reply.verdict}, its findings give ${g.verdict}`)
}
// Opus fallback: the reviewer self-validated, so every BLOCKING/MAJOR counts as confirmed; ids F1, F2, ... in reply order.
// The model verdict passed is the rule's own: when computeVerdict reaches its model comparison, no trigger and no
// 0.5-0.8 finding is left, so the rule's pre-verdict there is always PASS and the fallback never disagrees with itself.
function gateFallback(kind, reply) {
  if (!reply || reply.blocked) return reply
  if (!Array.isArray(reply.findings)) return gateBlocked(reply, 'relay inconsistency: the fallback reply lacks findings')
  const findings = reply.findings.map((x, i) => ({ id: `F${i + 1}`, severity: x.severity, confidence: Number(x.confidence) || 0,
    iso_property: kind === 'implementation' ? null : x.iso_property ?? null, validation_status: gateBig(x) ? 'confirmed' : 'not_required',
    title: gateStr(x.title), detail: gateStr(x.detail), location: gateLoc(x.location) }))
  return gateOf(kind, reply, findings, 'PASS')
}
// One item format for authors and fixers.
const gateItem = (reviewer, x) => `[${reviewer} ${x.severity}] ${x.id} ${x.location} ${x.title}: ${x.detail}`
// --- end of the gate rule block
// --- review relays (plan 1b, design section 5): this block is the same in design.js, build.js and verify.js. A relay
// runs fixed role-tagged blocks verbatim, in order: setup (availability probes, a fresh out dir made with plain mkdir,
// so a glob or fixed name can only match this run's output), start (run_in_background), poll (in the foreground,
// repeated while it exits 1, at most K times), cleanup (once). The Opus fallback has only setup (its own <out>-opus/)
// and cleanup. A relay that ends its turn while codex runs in the background kills the review.
const gpBlock = (role, body) => '```gp-exec ' + role + '\n' + body + '\n```\n'
const gpProbe = runner => `codex --version${runner ? ` && node ${q(A.review_runner)} --help >/dev/null` : ''} || { echo GP_CODEX_UNAVAILABLE; exit 3; }`
const gpFresh = dir => `mkdir ${q(dir)} || { echo GP_OUT_DIR_EXISTS; exit 4; }`
const gpStart = (cmd, out) => `${cmd} & echo $! > ${q(out + '/runner.pid')}; wait $!`
const gpPoll = target => `for i in $(seq 1 54); do ls ${target} >/dev/null 2>&1 && exit 0; sleep 10; done; exit 1`
const gpStop = out => `P=$(cat ${q(out + '/runner.pid')} 2>/dev/null || true)\n` +
  'if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then kill -TERM "$P"; for i in $(seq 1 20); do kill -0 "$P" 2>/dev/null || break; sleep 0.5; done; fi'
const gpUnwt = wt => `git -C ${q(A.repo)} worktree remove --force ${q(wt)}`
const gpList = (out, kind) => `ls -la ${q(out)}${kind ? ` ${q(out)}/${kind}-*/` : ''} 2>&1 || true` +
  (kind ? `\nsha256sum ${q(out)}/${kind}-*/result.json 2>&1 || true` : '')
function relaySteps({ setup, start, poll, cleanup, minutes }) {
  const K = Math.ceil(minutes / 9)
  return 'Run the gp-exec blocks below verbatim with the Bash tool, one Bash call per block, in this order, and read what each prints. ' +
    'setup: in the foreground. If it exits 3, codex or the runner cannot run here: run no other block and return codex_available=false, verdict ERROR, ' +
    'empty finding lists, null for every other result field, and the observed output in note. If it fails in any other way (exit 4: the out dir already ' +
    'exists, so what it holds is not this run\'s), run no other block and return blocked=true with the output in note. ' +
    `start: with the Bash tool's run_in_background; it can run for up to ~${minutes} minutes. Then WAIT IN THE FOREGROUND: ` +
    'run the poll block as a foreground Bash call (Bash timeout 600000 ms; one bounded loop of at most 9 minutes, for i in $(seq 1 54) ...), ' +
    `again each time it exits 1, at most ${K} times in all. NEVER return or end your turn between start and cleanup: returning kills the review process and loses the review. ` +
    `cleanup: once, after a poll exits 0, or after the ${K}-th poll exits 1 (or when start has ended and a poll still finds no result); ` +
    'without a poll exit 0, report verdict ERROR with the run-folder listing cleanup printed in note.\n' +
    gpBlock('setup', setup) + gpBlock('start', start) + gpBlock('poll', poll) + gpBlock('cleanup', cleanup)
}
const fallbackSteps = (setup, cleanup) => 'Run the gp-exec setup block below verbatim with the Bash tool before you review (if it fails, return blocked=true ' +
  'with its output in note), and the cleanup block once when your review is done.\n' + gpBlock('setup', setup) + gpBlock('cleanup', cleanup)
// The relay copies result.json field by field (design section 9); the workflow, not the relay, applies the gate rule.
const relayRead = (out, kind) => `After cleanup, read the result.json of the one run folder ${out}/${kind}-*/ and copy it with no judgement: verdict, ` +
  'verdict_reasons, model_verdict, outcome, unable_to_review, validation_outcome (its validation.outcome; null when validation is null), run_dir (that run folder) ' +
  'and result_sha256 (from the sha256sum line cleanup printed), and EVERY finding with its id, severity, confidence, iso_property, validation_status ' +
  '(its validation.status), claim, evidence and location (the object as is). Do not drop, merge, re-grade or sort findings into buckets: the workflow decides. ' +
  'If codex reports a usage cap or quota error, return verdict ERROR with that text in note (a cap is NOT unavailability: codex_available stays true).'
const NULLABLE = { type: ['string', 'null'] }
const RELAY_FINDING = { type: 'object', properties: {
  id: { type: 'string' }, severity: { type: 'string', enum: ['BLOCKING', 'MAJOR', 'MINOR', 'NIT'] }, confidence: { type: 'number' }, iso_property: NULLABLE,
  validation_status: { type: 'string', enum: ['confirmed', 'refuted', 'unvalidated', 'not_required'] }, claim: { type: 'string' }, evidence: { type: 'string' },
  location: { type: 'object', properties: { file: NULLABLE, line: { type: ['integer', 'null'] }, section: NULLABLE } } },
  required: ['id', 'severity', 'confidence', 'iso_property', 'validation_status', 'claim', 'evidence', 'location'] }
const RELAY_REVIEW = (extra = {}) => ({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NEEDS_HUMAN', 'ERROR'] }, verdict_reasons: { type: 'array', items: { type: 'string' } },
    model_verdict: NULLABLE, outcome: NULLABLE, unable_to_review: NULLABLE, validation_outcome: NULLABLE, run_dir: NULLABLE, result_sha256: NULLABLE,
    findings: { type: 'array', items: RELAY_FINDING }, note: { type: 'string' }, blocked: { type: 'boolean' }, codex_available: { type: 'boolean' }, ...extra,
  },
  required: ['verdict', 'verdict_reasons', 'model_verdict', 'outcome', 'unable_to_review', 'validation_outcome', 'run_dir', 'result_sha256', 'findings', 'codex_available', ...Object.keys(extra)],
})
// --- end of the review relay block
// The codex relay copies result.json field by field and also reports whether codex exists here at all.
const RELAY = RELAY_REVIEW()
// Only "codex not available" may fall back, and only when the repo opted in; a capped codex still stops (ERROR -> BLOCKED).
// Every review step is recorded, so an earlier Opus fallback round stays visible after a later codex PASS.
const reviewers = []
const disclose = o => ({ ...o, reviewers, fallback_used: reviewers.some(x => x.reviewer === FALLBACK_REVIEWER) })
async function reviewed(step, gate, relay, fallback) {
  const r = await relay()
  let res
  // An explicit relay blocker (refused command, failed setup, stale out dir) always stops the stage; it never falls back.
  if (!r || r.blocked || r.codex_available !== false) res = r && { ...gate(r), reviewer: 'codex' }
  else if ((A.review_fallback || 'none') !== 'opus-high') res = { ...r, blocked: true, reviewer: 'none', note: `codex is not available in this environment and review_fallback is none. ${r.note || ''}` }
  else {
    const f = await fallback()
    res = f && { ...f, codex_available: false, reviewer: FALLBACK_REVIEWER }
  }
  if (res) reviewers.push({ step, reviewer: res.reviewer })
  return res
}
// NEEDS_HUMAN only because codex's own verdict disagreed with the runner's rule, with findings still listed: those findings
// are revisable, so they go to the author instead of stopping the stage. Every other NEEDS_HUMAN without confirmed findings stops.
const disagreementOnly = r => r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && r.other_findings.length &&
  r.verdict_reasons.length > 0 && r.verdict_reasons.every(x => /model_rule_disagreement/.test(x))

function codex(kind, file, against, out, label, ph, inventory) {
  const fb = out + '-opus'
  const cmd = `node ${q(A.review_runner)} --kind ${kind} --files ${q(file)}${inventory ? ' ' + q(inventory) : ''}${against ? ` --against ${q(against)}` : ''} --repo ${q(A.repo)} --out-dir ${q(out)}` +
    `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}`
  return reviewed(label.replace(/^codex /, ''), r => gateCodex(kind, r), () => agent(
    `Run an independent codex ${kind} review and report its verdict. Do not review the document yourself.\n` +
    (inventory ? 'Review the execution inventory against the spec too: every acceptance ID and proof command must match, scope must be explicit, and inapplicable checks must have a reason.\n' : '') +
    relaySteps({ setup: ['set -e', gpProbe(true), gpFresh(out)].join('\n'), start: gpStart(cmd, out), poll: gpPoll(`${q(out)}/${kind}-*/result.json`),
      cleanup: gpStop(out) + '\n' + gpList(out, kind), minutes: Math.ceil(TIMEOUT_S * 6 / 60) + 5 }) +
    `${relayRead(out, kind)}\n- ${RULES}`,
    { label, phase: ph, schema: RELAY, effort: 'low' }),
  () => agent(
    `Codex is not available in this environment, so YOU are the independent ${kind} reviewer in its place (the repo config chose review_fallback: opus-high). ` +
    `Review ${file}${inventory ? ` and the execution inventory ${inventory}` : ''}${against ? ` against ${against}` : ''} for defects: missing or contradicted requirements, ` +
    'claims the repo does not support (read the code), untestable or vague acceptance checks, and gaps in scope.\n' +
    (inventory ? 'Review the execution inventory against the spec too: every acceptance ID and proof command must match, scope must be explicit, and inapplicable checks must have a reason.\n' : '') +
    fallbackSteps(['set -e', gpFresh(fb)].join('\n'), gpList(fb)) +
    `${parityNote(kind)} Do not edit any file.\n- ${RULES}`,
    { label: `${label.replace(/^codex /, 'opus ')} (codex unavailable)`, phase: ph, schema: PARITY_SCHEMA(), model: 'opus', effort: 'high' }).then(f => gateFallback(kind, f)))
}

async function loop(kind, path, writePrompt, against, ph, rph, inventory) {
  let doc = await agent(writePrompt(null), { label: `${kind} draft`, phase: ph, schema: DOC, effort: EFFORT })
  if (!doc || doc.blocked) return { status: 'BLOCKED', stage: kind, reason: doc ? doc.blocked_reason : 'author died' }
  for (let round = 1; round <= MAX; round++) {
    const r = await codex(kind, path, against, `${A.run_dir}/${kind}-review-${round}`, `codex ${kind} review ${round}`, rph, inventory)
    if (!r || r.blocked || r.verdict === 'ERROR' || (r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && !disagreementOnly(r))) return { status: 'BLOCKED', stage: `${kind} review`, round, review: r }
    if (r.verdict === 'PASS' && !r.confirmed_findings.length) return { status: 'PASS', rounds: round, path, reviewer: r.reviewer }
    if (round === MAX) return { status: 'FAIL', stage: `${kind} review`, rounds: round, review: r }
    const items = (r.confirmed_findings.length ? r.confirmed_findings : r.other_findings).map(f => gateItem(r.reviewer, f)).join('\n')
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
if (p.status !== 'PASS') return disclose({ status: p.status, prd: p })

phase('Spec')
const s = await loop('spec', spec, items => items
  ? `Revise the spec at ${spec} and its execution inventory at ${manifest} (traced against ${prd}) to resolve these confirmed codex findings (or explain why one is wrong). Recompute spec_sha256 in the inventory after edits:\n${items}\n- ${RULES.replace('Write ONLY the file you are asked to write', 'Write ONLY the design artifacts you are asked to write')}`
  : `Write an implementation spec for feature ${A.feature_id} to ${spec}, traced to every requirement in ${prd}. ` +
    `For each acceptance check give: an id, the behaviour, the exact proof command, and a negative control (the code mutation that must make that proof fail). ` +
    `List the files to change, protected files/non-goals, invariants, the test plan (failing test first), and, if any proof calls a live or paid external API, a hard minute/cost budget. ` +
    `For a service include boot/connectivity, success/failure/edge paths and side-effect readback where relevant. For static/document changes use static evidence; do not invent a service to boot. ` +
    `Include a Security considerations section covering: data exposure and authorization scope (who may read or change what, and exactly what each new endpoint or output returns); ` +
    `input validation and length limits for every new input; resource consumption (any expensive or scan-like operation, e.g. a full-collection scan endpoint, needs a server-side bound such as a rate limit or result cap; ` +
    `client-side debounce/throttle is not a security control); and any accepted risk, which must cite the repo's threat-model premises ` +
    `${SEC_DOCS.length ? `(read ${SEC_DOCS.join(', ')} first)` : '(from its security docs, if it has any)'} rather than assume them. ` +
    `Write ${manifest} to the schema at ${A.execution_schema}: version=1, feature_id=${A.feature_id}, spec_sha256 is the SHA256 of the final spec bytes, ` +
    `requirements contains EVERY acceptance ID in order with kind runtime or static and proof_command (exact command for runtime, empty for static). ` +
    `allowed_paths lists exact repo-relative files (or deliberately scoped directory prefixes ending /); protected_paths wins over allowed_paths. ` +
    `Include state_paths and clean_ignore from the agreed repo config when used; narrow them to genuine state files, never code or verification artifacts. ` +
    `checks inventories the configured extra checks; explicitly state applicability and reason for service smoke, lint and types. ` +
    `No check may depend on behaviour the repo does not control. You may write ONLY these two design artifacts.\n- ${RULES.replace('Write ONLY the file you are asked to write', 'Write ONLY the design artifacts you are asked to write')}`,
  prd, 'Spec', 'Spec review', manifest)
if (s.status !== 'PASS') return disclose({ status: s.status, prd: p, spec: s, prd_path: prd, spec_path: spec })
phase('Freeze')
const frozen = await agent(
  `Read-only: compute SHA256 of the exact bytes of ${spec} and ${manifest} with Node crypto or sha256sum. ` +
  `Do not edit either artifact after review. Return spec_sha256 and manifest_sha256 from the observed output, not estimates.\n- ${RULES}`,
  { label: 'freeze plan identity', phase: 'Freeze', effort: 'low', schema: {
    type: 'object', properties: { blocked: { type: 'boolean' }, reason: { type: 'string' }, spec_sha256: { type: 'string' }, manifest_sha256: { type: 'string' } },
    required: ['blocked', 'spec_sha256', 'manifest_sha256'],
  } })
if (!frozen || frozen.blocked || !/^[0-9a-f]{64}$/.test(frozen.spec_sha256) || !/^[0-9a-f]{64}$/.test(frozen.manifest_sha256)) return disclose({ status: 'BLOCKED', stage: 'freeze', reason: frozen && frozen.reason || 'missing observed plan hashes' })
return disclose({ status: 'PASS', feature_id: A.feature_id, prd: p, spec: s, prd_path: prd, spec_path: spec, manifest_path: manifest, spec_sha256: frozen.spec_sha256, manifest_sha256: frozen.manifest_sha256 })
