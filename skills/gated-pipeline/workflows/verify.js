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
// Optional repo scan log: with require_scan_row, the compliance trace must find this change's dated entry at reviewed_sha.
if (A.require_scan_row !== undefined && typeof A.require_scan_row !== 'boolean') return { status: 'BLOCKED', reason: 'require_scan_row must be true or false' }
if (A.scan_log && (typeof A.scan_log !== 'string' || !SAFE.test(A.scan_log) || ABS.test(A.scan_log) || DOTDOT.test(A.scan_log))) return { status: 'BLOCKED', reason: 'scan_log must be a repo-relative path of safe characters' }
if (A.require_scan_row && !A.scan_log) return { status: 'BLOCKED', reason: 'require_scan_row needs scan_log (the repo-relative scan log path)' }

const q = s => `'${s}'`
// The validator reports Windows paths with backslashes; compare by form, not by spelling.
const pathForm = p => p.replace(/\\/g, '/').replace(/^[a-z]:/, d => d.toUpperCase())
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && pathForm(a) === pathForm(b)
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
const COMPLY = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR'] }, blocking: FINDINGS, requirements: { type: 'array', items: { type: 'object' } }, note: { type: 'string' }, blocked: { type: 'boolean' }, ...STATE },
  required: ['verdict', 'blocking', 'requirements', ...STATE_REQ],
}
// The compliance relay also reports whether codex exists here at all; the Opus stand-in uses the plain schema.
const relay = s => ({ ...s, properties: { ...s.properties, codex_available: { type: 'boolean' } }, required: [...s.required, 'codex_available'] })
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
// The final-review relay uses the same schema as design's and build's review relays, plus the head it read first.
const RELAY = RELAY_REVIEW({ head_sha: { type: 'string' } })
// Only "codex not available" may fall back, and only when the repo opted in; a capped codex still stops (ERROR -> BLOCKED).
// Every review step is recorded, so the result discloses any Opus fallback review.
const reviewers = []
const disclose = o => ({ ...o, reviewers, fallback_used: reviewers.some(x => x.reviewer === FALLBACK_REVIEWER) })
async function reviewed(step, gate, viaCodex, fallback) {
  const r = await viaCodex()
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
const fbOut = out + '-opus'
const finSetup = dir => [
  `echo "head_sha: $(git -C ${q(A.repo)} rev-parse HEAD)"`,
  `git -C ${q(A.repo)} diff --binary --no-renames ${A.base_commit} ${A.reviewed_sha} > ${q(dir + '/change.patch')}`,
  `git -C ${q(A.repo)} worktree add --detach ${q(dir + '/wt')} ${A.base_commit}`,
  `git -C ${q(dir + '/wt')} apply --index ${q(dir + '/change.patch')}`,
].join('\n')
const finNote = dir => `Report head_sha: the head_sha: line setup printed (the branch head, read first). The checkout ${dir}/wt holds the whole change ` +
  `${A.base_commit}..${A.reviewed_sha} as uncommitted edits.\n`
const finCmd = `node ${q(A.review_runner)} --kind implementation --uncommitted --repo ${q(out + '/wt')} --out-dir ${q(out)}` +
  `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}`
const fin = await reviewed('final review', r => gateCodex('implementation', r), () => agent(
  `Run an independent codex implementation review of the CHANGE this feature made and report its verdict. Do not review the code yourself.\n` +
  relaySteps({ setup: ['set -e', gpProbe(true), gpFresh(out), finSetup(out)].join('\n'), start: gpStart(finCmd, out),
    poll: gpPoll(`${q(out)}/implementation-*/result.json`), cleanup: [gpStop(out), gpUnwt(out + '/wt'), gpList(out, 'implementation')].join('\n'),
    minutes: Math.ceil(TIMEOUT_S * 6 / 60) + 5 }) +
  `${finNote(out)}${relayRead(out, 'implementation')}\n- ${RULES}`,
  { label: 'codex final review', phase: 'Final review', schema: RELAY, effort: 'low' }),
() => agent(
  `Codex is not available in this environment, so YOU are the independent final implementation reviewer of the CHANGE in its place (the repo config chose review_fallback: opus-high).\n` +
  fallbackSteps(['set -e', gpFresh(fbOut), finSetup(fbOut)].join('\n'), [gpUnwt(fbOut + '/wt'), gpList(fbOut)].join('\n')) + finNote(fbOut) +
  `Review the change as it stands in that checkout (git -C ${q(fbOut + '/wt')} diff --cached is the whole change ${A.base_commit}..${A.reviewed_sha}; read any other file there for context) ` +
  `for correctness bugs, behaviour that contradicts the spec ${A.spec_path}, and unsafe code. Report findings ONLY in that change. ${parityNote('implementation')}\n- ${RULES}`,
  { label: 'opus final review (codex unavailable)', phase: 'Final review', schema: PARITY_SCHEMA({ head_sha: { type: 'string' } }), model: 'opus', effort: 'high' }).then(f => gateFallback('implementation', f)))
if (!fin || fin.blocked || fin.verdict === 'ERROR' || (fin.verdict === 'NEEDS_HUMAN' && !fin.confirmed_findings.length)) return disclose({ status: 'BLOCKED', stage: 'final review', results, final_review: fin })
// Findings decide, not the self-reported verdict.
if (fin.verdict === 'PASS' && fin.confirmed_findings.length) fin.verdict = 'FAIL'
if (fin.head_sha !== A.reviewed_sha) return disclose({ status: 'HEAD_MOVED', reason: `branch head is ${fin.head_sha}, build reviewed ${A.reviewed_sha}: re-run build`, results, final_review: fin })

const cout = `${A.run_dir}/compliance`
const compFb = cout + '-opus'
const compIsolate = dir => `git -C ${q(A.repo)} worktree add --detach ${q(dir + '/wt')} ${A.reviewed_sha}`
const compTask = `Trace every requirement and acceptance check in the spec ${A.spec_path} and frozen inventory ${A.manifest_path} to the implementation in this repository ` +
  `(the change is git diff ${A.base_commit} ${A.reviewed_sha}; this checkout is at ${A.reviewed_sha}) and its tests. For each requirement that is missing, implemented differently from the spec, ` +
  `or not covered by an applicable proof that would fail if it broke, report a finding of severity high that quotes the spec line and the code. ` +
  `Read the actual acceptance ledger ${ledger}, build result ${A.build_result_path} and check outputs under ${A.run_dir}. ` +
  `Return requirements with EVERY frozen ID exactly once and PASS/FAIL/NOT_RUN plus its actual evidence records. ` +
  `Runtime acceptance needs an exact executed command, exit code, nonempty output file and head_sha=${A.reviewed_sha}; a file/line alone only proves a static claim. ` +
  `Each evidence item is a record object, never a summary string. A runtime record copies the ledger record of that ID's frozen proof_command byte for byte (command, exit_code, log_path, log_sha256); ` +
  `put other commands you relied on (controls, check outputs) in the summary, not in evidence. A static record's file is repo-relative (for example src/a.py), never an absolute path. ` +
  (A.require_scan_row ? `The repository requires a security scan row: confirm that its scan log ${A.scan_log} contains a dated entry covering this change at ${A.reviewed_sha}, ` +
    `and cite it as static evidence file:line in your summary or note. If there is no such entry, report a finding of severity high with requirement security-scan-log. ` : '') +
  `Do not execute commands or invent missing evidence. verdict FAIL for any missing/wrong/unproven item, else PASS.`
const compCmd = `timeout --kill-after=60 1800 codex exec${A.codex_model ? ` -m ${q(A.codex_model)}` : ''} -c model_reasoning_effort=${A.codex_effort || 'high'} -s read-only -C ${q(cout + '/wt')} --output-schema ${q(A.compliance_schema)} -o ${q(cout + '/compliance.json')} - < ${q(cout + '/prompt.md')}`
const comp = await reviewed('compliance', r => r, () => agent(
  `Run an independent codex SPEC-COMPLIANCE trace and report its verdict. Do not judge it yourself. ` +
  `Every file codex reads is the reviewed commit's: setup makes an isolated checkout of it at ${cout}/wt, and cleanup removes exactly that checkout.\n` +
  `1. The setup block writes ${cout}/prompt.md containing: "${compTask}"\n` +
  `2. Run under a HARD process timeout so codex can never outlive this step (the start block); if the timeout fires the process is already killed: report ERROR. ` +
  relaySteps({ setup: ['set -e', gpProbe(false), gpFresh(cout), compIsolate(cout), `cat > ${q(cout + '/prompt.md')} <<'GP_TASK'`, compTask, 'GP_TASK'].join('\n'),
    start: gpStart(compCmd, cout), poll: gpPoll(q(cout + '/compliance.json')), cleanup: [gpStop(cout), gpUnwt(cout + '/wt'), gpList(cout)].join('\n'), minutes: 32 }) +
  `3. After cleanup, read ${cout}/compliance.json and return verdict, requirements verbatim, and EVERY finding as blocking (each one is a requirement missing, wrong or unproven). If codex errors, hits a usage cap, or writes no valid JSON, return ERROR with the reason in note.\n` +
  `Around all of the blocks (on the main repo, not the isolated checkout): ${stateNote}\n- ${RULES}`,
  { label: 'codex spec compliance', phase: 'Final review', schema: relay(COMPLY), effort: 'low' }),
() => agent(
  `Codex is not available in this environment, so YOU run the independent SPEC-COMPLIANCE trace in its place (the repo config chose review_fallback: opus-high). Do not change any file.\n` +
  fallbackSteps(['set -e', gpFresh(compFb), compIsolate(compFb)].join('\n'), [gpUnwt(compFb + '/wt'), gpList(compFb)].join('\n')) +
  `Work in the isolated checkout of the reviewed commit at ${compFb}/wt.\n` +
  `1. ${compTask}\n` +
  `2. Return verdict, requirements (each shaped exactly as the requirements items in ${A.compliance_schema}: id, status and evidence records copied from the ledger), and EVERY finding as blocking (each one is a requirement missing, wrong or unproven).\n` +
  `Around the setup, the trace and the cleanup (on the main repo, not the isolated checkout): ${stateNote}\n- ${RULES}`,
  { label: 'opus spec compliance (codex unavailable)', phase: 'Final review', schema: COMPLY, model: 'opus', effort: 'high' }))
if (!comp || comp.blocked || comp.verdict === 'ERROR') return disclose({ status: 'BLOCKED', stage: 'compliance', results, final_review: fin, compliance: comp })
if (comp.blocking.length) comp.verdict = 'FAIL'
const compDrift = pinned(comp)
if (compDrift.length) return disclose({ status: 'HEAD_MOVED', stage: 'compliance', reason: 'compliance trace did not run on the clean reviewed commit: ' + compDrift.join('; '), results, final_review: fin, compliance: comp })

const failed = results.filter(r => r.status !== 'PASS')
const status = fin.verdict !== 'PASS' || comp.verdict !== 'PASS' ? 'FAIL' : failed.length ? 'INCOMPLETE' : 'PASS'
const report = disclose({ status, feature_id: A.feature_id, base_commit: A.base_commit, reviewed_sha: A.reviewed_sha, manifest_sha256: A.manifest_sha256, results, final_review: fin, compliance: comp })
if (status !== 'PASS') return report
phase('Completion')
const reportPath = `${A.run_dir}/verify-result.json`
const proofPath = `${A.run_dir}/completion-proof.json`
// The compliance relay can flatten codex's evidence records to strings; put codex's own records back first.
const merger = A.completion_runner.replace(/check-completion\.js$/, 'merge-compliance.js')
const mergeStep = comp.reviewer === 'codex' && merger !== A.completion_runner
  ? `Then restore codex's own compliance evidence (exit 1 means refused: return passed=false with its printed reason):\n` +
    `node ${q(merger)} --verify-result ${q(reportPath)} --compliance ${q(cout + '/compliance.json')} --manifest ${q(A.manifest_path)} ` +
    `--ledger ${q(ledger)} --checkout ${q(cout + '/wt')}\n`
  : ''
const completion = await agent(
  `Write this exact Workflow result JSON atomically to ${reportPath}, without changing fields:\n${JSON.stringify(report)}\n` +
  mergeStep +
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
if (!completion.passed || !samePath(completion.proof_path, proofPath) || completion.reviewed_sha !== A.reviewed_sha || completion.manifest_sha256 !== A.manifest_sha256) return { ...report, status: 'INCOMPLETE', stage: 'completion', completion }
return { ...report, verify_result_path: reportPath, completion }
