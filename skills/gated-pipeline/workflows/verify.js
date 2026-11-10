export const meta = {
  name: 'gated-verify',
  description: 'Repo-specific extra checks one at a time, then codex final review + spec-compliance trace',
  whenToUse: 'Mandatory stage 3: acceptance evidence and compliance, with configured extra checks',
  phases: [
    { title: 'Plan preflight', detail: 'validate frozen spec and inventory before executing commands' },
    { title: 'Checks', detail: 'each configured check, sequentially' },
    { title: 'Acceptance proofs', detail: 'save final-commit evidence for every frozen acceptance item' },
    { title: 'Final review', detail: 'codex defect review of the whole change, then a spec-compliance trace' },
    { title: 'Negative controls', detail: 'contract 2: one isolated mutation per control, last, through run-frozen.js' },
    { title: 'Completion', detail: 'mechanically reconcile inventory, artifacts and approved scope' },
  ],
}

const A = args || {}
// contract 1 (absent = 1): today's flow. contract 2 (docs/v2-design.md 6.1, 6.4): design-gated; every command that runs or
// excuses verification comes from the frozen manifest and runs only through run-frozen.js, so the args that used to carry
// them are BLOCKED before any agent.
if (A.contract !== undefined && A.contract !== 1 && A.contract !== 2) return { status: 'BLOCKED', reason: 'contract must be 1 or 2' }
const C2 = A.contract === 2
const FORBIDDEN_V2 = ['checks', 'clean_ignore', 'state_paths', 'suite_cmd', 'unit_cmd', 'known_failures', 'isolated_setup', 'suite_isolated', 'live_budget_min']
const ONLY_V2 = ['frozen_dir', 'design_commit', 'approvals_path', 'approvals_sha256']
if (C2) {
  const forbidden = FORBIDDEN_V2.filter(k => A[k] !== undefined)
  if (forbidden.length) return { status: 'BLOCKED', stage: 'args', reason: `contract 2 does not take ${forbidden.join(', ')}: the frozen manifest is their only source` }
  const mixed = ['task', 'charge'].filter(k => A[k] !== undefined)
  if (mixed.length) return { status: 'BLOCKED', stage: 'args', reason: `contract 2 does not take ${mixed.join(', ')}` }
} else {
  const v2only = ONLY_V2.filter(k => A[k] !== undefined)
  if (v2only.length) return { status: 'BLOCKED', stage: 'args', reason: `${v2only.join(', ')} need contract: 2` }
}
const need = ['feature_id', 'repo', 'work_branch', 'run_dir', 'review_runner', 'spec_path', 'compliance_schema', 'manifest_path', 'manifest_sha256', 'build_result_path', 'completion_runner',
  ...(C2 ? ['frozen_dir', 'design_commit', 'approvals_path', 'approvals_sha256'] : [])]
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
// Absolute, normalized (no //, /./, .. or trailing slash), so a path the scripts print compares equal by spelling.
const CANON = p => typeof p === 'string' && SAFE.test(p) && /^\//.test(p) && !/\/\/|\/\.(\/|$)|\/\.\.(\/|$)|.\/$|\\/.test(p)
const V2_SCRIPTS = C2 ? A.completion_runner.replace(/\/check-completion\.js$/, '') : ''
if (C2) {
  for (const k of ['repo', 'run_dir', 'spec_path', 'completion_runner', 'frozen_dir', 'manifest_path', 'approvals_path', 'build_result_path']) {
    if (!CANON(A[k])) return { status: 'BLOCKED', stage: 'args', reason: `${k} must be a normalized absolute POSIX path of safe characters: ${A[k]}` }
  }
  if (V2_SCRIPTS === A.completion_runner) return { status: 'BLOCKED', stage: 'args', reason: 'completion_runner must be the skill\'s scripts/check-completion.js' }
  if (A.manifest_path !== A.frozen_dir + '/execution-plan.json') return { status: 'BLOCKED', stage: 'args', reason: 'manifest_path must be <frozen_dir>/execution-plan.json' }
  if (!/^[0-9a-f]{64}$/.test(A.approvals_sha256)) return { status: 'BLOCKED', stage: 'args', reason: 'approvals_sha256 must be a 64-hex hash' }
  if (!/^[0-9a-f]{40}$/.test(A.design_commit)) return { status: 'BLOCKED', stage: 'args', reason: 'design_commit must be a full 40-hex commit id' }
  if (A.base_commit !== A.design_commit) return { status: 'BLOCKED', stage: 'args', reason: `base_commit must equal design_commit under contract 2 (got ${A.base_commit}, design ${A.design_commit})` }
  const inRepo = p => p === A.repo || p.startsWith(A.repo + '/')
  for (const k of ['run_dir', 'frozen_dir', 'approvals_path', 'build_result_path']) if (inRepo(A[k])) return { status: 'BLOCKED', stage: 'args', reason: `${k} must lie outside the repo` }
}

const q = s => `'${s}'`
// contract 2: every stage run uses a FRESH run_dir, made by the stage's first gp-exec block: its parent with mkdir -p
// (the parent computed here from the normalized absolute run_dir), then the run_dir itself with a plain mkdir.
// GP_RUN_DIR_EXISTS only when the run_dir already exists; GP_RUN_DIR_PARENT when its parent cannot be made;
// GP_RUN_DIR_CREATE when mkdir fails for any other reason.
const freshRunDir = run => [
  `mkdir -p ${q(run.slice(0, run.lastIndexOf('/')) || '/')} || { echo GP_RUN_DIR_PARENT; exit 4; }`,
  `mkdir ${q(run)} || { if [ -e ${q(run)} ] || [ -L ${q(run)} ]; then echo GP_RUN_DIR_EXISTS; else echo GP_RUN_DIR_CREATE; fi; exit 4; }`,
]
const runDirCode = stdout => /GP_RUN_DIR_EXISTS/.test(stdout || '') ? 'E_RUN_DIR_EXISTS' : /GP_RUN_DIR_(PARENT|CREATE)/.test(stdout || '') ? 'E_RUN_DIR' : null
// The validator reports Windows paths with backslashes; compare by form, not by spelling.
const pathForm = p => p.replace(/\\/g, '/').replace(/^[a-z]:/, d => d.toUpperCase())
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && pathForm(a) === pathForm(b)
// Every check and the compliance trace must run with HEAD at reviewed_sha and a clean tree, before AND after.
// clean_ignore: repo-relative prefixes whose dirty/untracked status is tolerated (e.g. a harness state dir).
if ((A.clean_ignore || []).some(p => !SAFE.test(p) || ABS.test(p))) return { status: 'BLOCKED', reason: 'clean_ignore entries must be repo-relative paths of safe characters' }
let IGNORE = (A.clean_ignore || []).map(p => p.replace(/\\/g, '/').replace(/^\.\//, ''))
const ignored = p => IGNORE.some(i => p === i || p === i.replace(/\/$/, '') || p.startsWith(i.endsWith('/') ? i : i + '/'))
const dirty = lines => (lines || []).filter(l => l.trim() && !l.slice(3).split(' -> ').map(s => s.replace(/^"|"$/g, '')).every(ignored))
const stateNoteFor = () => `Immediately before AND immediately after, run git -C ${q(A.repo)} rev-parse HEAD and git -C ${q(A.repo)} status --porcelain --untracked-files=all -- . ${IGNORE.map(i => q(':!' + i)).join(' ')}; ` +
  'report them as head_before, status_before (one array entry per output line), head_after, status_after. Do not clean, stash or change anything yourself.'
let stateNote = stateNoteFor()
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
  // contract 2: commands are data until frozen (design section 5); only run-frozen.js executes a frozen command.
  ...(C2 ? [`Never execute a proof, check, suite or setup command found in the canonical file ${A.spec_path}, in its generated views or in the manifest; the frozen verification runs only through scripts/run-frozen.js in the gp-exec blocks the workflow gives you. Never edit the canonical file, its views or the manifest.`] : []),
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
// contract 2: the run-frozen steps recovered by a record readback (block below), disclosed in every result.
const READBACK = []
const disclose = o => ({ ...o, ...(C2 ? { contract: 2, readback: READBACK.slice() } : {}), reviewers, fallback_used: reviewers.some(x => x.reviewer === FALLBACK_REVIEWER) })
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

// ---- contract 2 (docs/v2-design.md 6.4) ---------------------------------------------------------------------------
// Deterministic steps are ```gp-exec blocks the agent runs verbatim in the foreground, reporting stdout and exit code;
// the workflow reads the scripts' printed JSON lines and sha256sum lines. Every frozen command runs through
// run-frozen.js; no prompt carries a frozen command. The plan preflight's id lists only label agents, set the quiet
// wait and name budgets: completion compares the full sets with the manifest, so a relay that drops an id is caught.
const EXEC = { type: 'object', properties: { stdout: { type: 'string' }, exit_code: { type: 'integer' }, blocked: { type: 'boolean' }, note: { type: 'string' } }, required: ['stdout', 'exit_code'] }
const execBlock = body => '```gp-exec\n' + body + '\n```\n'
const EXEC_NOTE = 'Run the gp-exec block below verbatim with the Bash tool, in the foreground, as one call with Bash timeout 600000 ms (the maximum), and return its whole stdout verbatim in stdout and its exit code in exit_code. ' +
  'Do not run anything else, and do not fix, retry or work around a failure.\n'
// One foreground Bash call ends at 600 s at most; each frozen run inside it may take its limit plus run-frozen.js's 10 s kill
// grace. A step that cannot finish inside one call BLOCKS before it starts (a killed call would lose its record).
// The same bound as scripts/lib/call-limits.js (validator rule G40, which keeps such limits from being frozen); a
// workflow cannot require a module, so tests/feature-validate.test.js keeps these copies equal to it.
const ONE_CALL_S = 570
const RUN_GRACE_S = 15
const overCall = (label, seconds) => seconds > ONE_CALL_S ? `${label} can take up to ${seconds} s and cannot finish inside one foreground Bash call (600 s); shorten its frozen limit` : ''
const jsonLines = s => String(s || '').split('\n').map(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null } }).filter(Boolean)
const shaOf = (s, file) => ((String(s || '').split('\n').map(l => /^([0-9a-f]{64}) [ *](.+)$/.exec(l)).find(m => m && m[2] === file)) || [])[1]
const HEX64 = /^[0-9a-f]{64}$/
const CHECK_ID = /^CHECK-[A-Z0-9][A-Z0-9-]*$/
const ACC_ID = /^[A-Z][A-Z0-9]*-[0-9]{3}-AC[0-9]+$/
const SCRIPT = name => q(`${V2_SCRIPTS}/${name}`)
const writeJsonBlock = (file, value) => `node ${SCRIPT('write-json.js')} --out ${q(file)} <<'GP_JSON'\n${JSON.stringify(value)}\nGP_JSON`
const runFrozen = (target, outDir, extra = '') => `node ${SCRIPT('run-frozen.js')} --repo ${q(A.repo)} --frozen-dir ${q(A.frozen_dir)} --manifest-sha256 ${A.manifest_sha256} ` +
  `--reviewed-sha ${A.reviewed_sha} --target ${target} --out-dir ${q(outDir)}${extra} 2>&1`
// A run-frozen block also prints the work checkout's HEAD and status when it exits (an EXIT trap keeps the exit code),
// so a refusal because the branch moved or the checkout got dirty is routed as HEAD_MOVED (design 6.6), any other
// refusal as BLOCKED.
const STATE_TRAP = [`gp_state() { echo "gp-state head: $(git -C ${q(A.repo)} rev-parse HEAD)"; echo "gp-state status:"; git -C ${q(A.repo)} status --porcelain --untracked-files=all; }`, 'trap gp_state EXIT']
const frozenBlock = lines => execBlock(['set -e', ...STATE_TRAP, ...lines].join('\n'))
// null when the block printed no state; else the drift from the pinned reviewed commit (empty = still pinned and clean).
function stateDrift(stdout) {
  const lines = String(stdout || '').split('\n')
  const at = lines.lastIndexOf('gp-state status:')
  const h = lines.slice(0, at < 0 ? 0 : at).reverse().find(l => l.startsWith('gp-state head: '))
  if (at < 0 || !h) return null
  const headNow = h.slice('gp-state head: '.length).trim()
  const dirt = dirty(lines.slice(at + 1).filter(l => l.trim()))
  return [...(headNow === A.reviewed_sha ? [] : [`HEAD is ${headNow}, reviewed ${A.reviewed_sha}`]), ...dirt.map(l => `dirty: ${l}`)]
}
// The status of a failed run-frozen step: HEAD_MOVED when the checkout left the reviewed commit or got dirty, else BLOCKED.
const refusedStatus = (r, stage, reason, extra) => {
  const drift = r ? stateDrift(r.stdout) : null
  return drift && drift.length
    ? disclose({ status: 'HEAD_MOVED', stage, reason: `the work checkout is no longer the clean reviewed commit (${drift.join('; ')}): re-run build`, ...extra })
    : disclose({ status: 'BLOCKED', stage, reason, ...extra })
}
// --- record readback (design 6.4): this block is the same in build.js and verify.js. A run-frozen step whose reply
// lacks a record line run-frozen.js prints (a relay that paraphrased its stdout) gets ONE low-effort readback agent
// whose gp-exec block only reads: test -f, sha256sum and cat of each record (and sha256sum of a negative control's
// patch, or cat of the ledger). It never re-runs and never writes anything. A record is accepted only when the file
// exists, its hash is printed, its JSON names the expected target, it was made on the pinned reviewed commit with the
// checkout clean before and after (exactly when run-frozen.js exits 0 having written it) and, for a negative control,
// it holds integer baseline_exit_code and exit_code and a mutation_patch_sha256 equal to the printed patch hash. A
// blocked reply, or one that shows run-frozen's own refusal (a nonzero exit with a run-frozen: line), gets no
// readback. The workflow cannot hash, so a wrong printed record hash is caught by completion, which re-derives every
// record from disk (hash, target, command, logs, patch, exit codes).
const rbRefused = r => !r || r.blocked === true || (r.exit_code !== 0 && /^run-frozen: /m.test(String(r.stdout || '')))
const rbCovered = (file, entries) => entries.some(e => file === e.replace(/\/$/, '') || file.startsWith(e.endsWith('/') ? e : e + '/'))
// A porcelain v1 line's paths, read as run-frozen.js and check-completion.js read them: git C-quotes a name holding a
// space, so `old -> new` is a rename or copy (R or C in XY) only; an unreadable line is null, never clean.
const rbPaths = l => {
  if (typeof l !== 'string' || l.length < 4 || l[2] !== ' ') return null
  const t = l.slice(3).match(/"(?:[^"\\]|\\.)*"|[^ "]+| /g)
  if (!t || t.join('') !== l.slice(3)) return null
  const p = t.filter(x => x !== ' ').map(x => (x.startsWith('"') ? x.slice(1, -1) : x))
  if (/[RC]/.test(l.slice(0, 2))) return t.length === 5 && t[2] === '->' ? [p[0], p[2]] : null
  return t.length === 1 ? p : null
}
const rbClean = (status, entries) => Array.isArray(status) && status.every(l => { const f = rbPaths(l); return f !== null && f.every(p => rbCovered(p, entries)) })
// The text a cat printed after a file's sha256sum line (up to the next sha256sum line), parsed as one JSON object, else null.
function rbJsonAfter(stdout, file) {
  const lines = String(stdout || '').split('\n')
  const shaLine = l => /^([0-9a-f]{64}) [ *](.+)$/.exec(l)
  const at = lines.findIndex(l => { const m = shaLine(l); return !!m && m[2] === file })
  if (at < 0) return null
  let end = at + 1
  while (end < lines.length && !shaLine(lines[end])) end++
  try { const v = JSON.parse(lines.slice(at + 1, end).join('\n')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
}
// reads: [{ record, target, patch? }]; files: other JSON files to hash and print (the acceptance ledger).
// Returns { records: [{ record_path, record_sha256, record, printed }], files: { <path>: { sha256, value } } } or { error }.
async function readback({ step, ph, sha, clean, reads, files = [] }) {
  const body = [...reads.map(x => `test -f ${q(x.record)} && sha256sum ${x.patch ? q(x.patch) + ' ' : ''}${q(x.record)} && cat ${q(x.record)}`),
    ...files.map(f => `test -f ${q(f)} && sha256sum ${q(f)} && cat ${q(f)}`)].join('\n')
  const r = await agent(`Step ${step} ran run-frozen.js, but its reply did not carry the record line run-frozen.js prints. Read the files back: the block below only reads; ` +
    `it never runs or writes anything. Return its stdout exactly as printed, byte for byte, with nothing added, dropped or reformatted. ${EXEC_NOTE}` + execBlock(body) + `\n- ${RULES}`,
    { label: `readback ${step}`, phase: ph, schema: EXEC, effort: 'low' })
  if (!r || r.blocked) return { error: 'the readback was blocked' }
  const records = []
  for (const x of reads) {
    const recSha = shaOf(r.stdout, x.record)
    const rec = rbJsonAfter(r.stdout, x.record)
    const patchSha = x.patch ? shaOf(r.stdout, x.patch) : null
    const bad = !HEX64.test(recSha || '') ? `no record file or no sha256 printed for ${x.record}`
      : !rec ? `${x.record} did not print as one JSON object`
      : rec.target !== x.target ? `${x.record} names target ${rec.target}, not ${x.target}`
      : rec.head_before !== sha || rec.head_after !== sha || !rbClean(rec.status_before, clean) || !rbClean(rec.status_after, clean) ? `${x.record} was not made on the clean reviewed commit ${sha}`
      : x.patch && !(Number.isInteger(rec.baseline_exit_code) && Number.isInteger(rec.exit_code) && HEX64.test(rec.mutation_patch_sha256 || '')) ? `${x.record} lacks baseline_exit_code, exit_code or mutation_patch_sha256`
      : x.patch && patchSha !== rec.mutation_patch_sha256 ? `the patch ${x.patch} hashes to ${patchSha || 'nothing printed'}, the record says ${rec.mutation_patch_sha256}` : ''
    if (bad) return { error: bad }
    records.push({ record_path: x.record, record_sha256: recSha, record: rec,
      printed: { record_path: x.record, record_sha256: recSha, exit_code: rec.exit_code ?? null, timed_out: rec.timed_out ?? false, setup_exit_code: rec.setup ? rec.setup.exit_code : null } })
  }
  const read = {}
  for (const f of files) {
    const s = shaOf(r.stdout, f)
    const value = rbJsonAfter(r.stdout, f)
    if (!HEX64.test(s || '') || !value) return { error: `no file, sha256 or JSON printed for ${f}` }
    read[f] = { sha256: s, value }
  }
  return { records, files: read }
}
// --- end of the record readback block
// verify: a run-frozen step's printed record line, else ONE readback (block above) when the reply lacks it and shows
// neither a refusal nor checkout drift. { printed, relayed } when the reply printed it; { printed, recovered } after an
// accepted readback (listed in READBACK); else { why }, naming the missing line and the readback result.
async function recordLine(r, { step, ph, record, target, patch }) {
  const line = r && !r.blocked ? jsonLines(r.stdout).find(o => o.record_path === record && HEX64.test(o.record_sha256 || '')) : null
  if (line) return { printed: line, relayed: true }
  const why = `no printed record line with record_path ${record}`
  if (rbRefused(r) || (stateDrift(r.stdout) || []).length) return { why }
  const rb = await readback({ step, ph, sha: A.reviewed_sha, clean: IGNORE, reads: [{ record, target, patch }] })
  if (rb.error) return { why: `${why}; readback: ${rb.error}` }
  READBACK.push({ step, record_path: record })
  return { printed: rb.records[0].printed, recovered: true }
}
// Review files (design 6.3/6.4): steps final and compliance, one entry per round, every path and hash printed by a script.
const reviewFiles = []
const fbInputs = dir => [`node ${SCRIPT('hash-inputs.js')} --out ${q(dir + '/inputs.json')} --files ${q(dir + '/change.patch')} >/dev/null`]
const RAW_NOTE = name => ` Also return raw_sha256: the hash on the sha256sum line cleanup printed for ${name} (null when there is none).`
const RAW_RELAY = s => { const r = relay(s); return { ...r, properties: { ...r.properties, raw_sha256: { type: ['string', 'null'] } }, required: [...r.required, 'raw_sha256'] } }
async function recordFallback({ step, round, dir, reply, inputs, ph, label }) {
  const file = `${dir}/fallback-review.json`
  const r = await agent(
    `Record the Opus fallback ${step} review: ${inputs ? 're-hash its inputs (hash-inputs.js --verify fails if any changed during the review), then ' : ''}` +
    `write its reply verbatim with the skill's write-json.js (strict JSON, written once and atomically; it prints { path, sha256 }). ${EXEC_NOTE}` +
    execBlock(['set -e', ...(inputs ? [`node ${SCRIPT('hash-inputs.js')} --verify ${q(dir + '/inputs.json')}`] : []),
      writeJsonBlock(file, { gate_kind: step, reviewer: FALLBACK_REVIEWER, reply }), ...(inputs ? [`sha256sum ${q(dir + '/inputs.json')}`] : [])].join('\n')) + `\n- ${RULES}`,
    { label: `record opus ${label}`, phase: ph, schema: EXEC, effort: 'low' })
  const w = r && !r.blocked && r.exit_code === 0 ? jsonLines(r.stdout).find(o => o.path === file && HEX64.test(o.sha256 || '')) : null
  const inSha = r && inputs ? shaOf(r.stdout, dir + '/inputs.json') : null
  if (!w || (inputs && !HEX64.test(inSha || ''))) return { error: `the fallback ${step} review record was not written: ${r ? r.stdout : 'no reply'}` }
  return { entry: { step, round, reviewer: FALLBACK_REVIEWER, review_dir: dir,
    ...(inputs ? { inputs_path: dir + '/inputs.json', inputs_sha256: inSha, fallback_review_path: file, fallback_review_sha256: w.sha256 } : { raw_path: file, raw_sha256: w.sha256 }) } }
}
async function reviewFile({ step, round, out, fb, res, raw, ph, label, rawName }) {
  if (!res || res.blocked || !['PASS', 'FAIL', 'NEEDS_HUMAN'].includes(res.verdict)) return res
  if (res.reviewer === 'codex') {
    if (rawName) {
      if (!HEX64.test(res.raw_sha256 || '')) return gateBlocked(res, `relay inconsistency: no raw_sha256 for ${out}/${rawName}`)
      reviewFiles.push({ step, round, reviewer: 'codex', review_dir: out, raw_path: `${out}/${rawName}`, raw_sha256: res.raw_sha256 })
    } else {
      const d = res.run_dir
      if (typeof d !== 'string' || !d.startsWith(out + '/implementation-') || d.slice(out.length + 1).includes('/') || !HEX64.test(res.result_sha256 || '')) {
        return gateBlocked(res, `relay inconsistency: run_dir ${d} and result_sha256 must name this run's result.json under ${out}`)
      }
      reviewFiles.push({ step, round, reviewer: 'codex', review_dir: out, result_path: d + '/result.json', result_sha256: res.result_sha256 })
    }
    return res
  }
  const rec = await recordFallback({ step, round, dir: fb, reply: raw, inputs: !rawName, ph, label })
  if (rec.error) return gateBlocked(res, rec.error)
  reviewFiles.push(rec.entry)
  return res
}

if (C2) {
  const base = A.base_commit
  const sha = A.reviewed_sha
  phase('Plan preflight')
  const planRun = await agent(
    `Validate the frozen plan of feature ${A.feature_id} BEFORE running any check or proof command, with the read-only validator (check-completion.js --mode plan; it prints ids, never a command). ${EXEC_NOTE}` +
    execBlock(['set -e', ...freshRunDir(A.run_dir), `node ${SCRIPT('check-completion.js')} --mode plan --repo ${q(A.repo)} --feature-id ${q(A.feature_id)} --reviewed-sha ${sha} --manifest ${q(A.manifest_path)} ` +
      `--manifest-sha256 ${A.manifest_sha256} --spec ${q(A.spec_path)} --frozen-dir ${q(A.frozen_dir)} --commit ${A.design_commit} --approvals ${q(A.approvals_path)} --approvals-sha256 ${A.approvals_sha256} 2>&1`].join('\n')) + `\n- ${RULES}`,
    { label: 'plan preflight', phase: 'Plan preflight', effort: 'low', schema: EXEC })
  if (!planRun || planRun.blocked || planRun.exit_code !== 0) {
    const code = planRun && runDirCode(planRun.stdout)
    return disclose({ status: 'BLOCKED', stage: 'plan preflight', ...(code ? { code } : {}),
      reason: code === 'E_RUN_DIR_EXISTS' ? 'run_dir already exists (GP_RUN_DIR_EXISTS): every verify run needs a fresh run_dir; nothing was executed'
        : code ? `run_dir ${A.run_dir} could not be created: nothing was executed` : 'the plan preflight failed: nothing was executed', plan: planRun })
  }
  const p = jsonLines(planRun.stdout).find(o => o.mode === 'plan')
  const isInt = (v, min) => Number.isInteger(v) && v >= min
  const relPath = x => typeof x === 'string' && SAFE.test(x) && !ABS.test(x) && !DOTDOT.test(x)
  const planBad = !p ? 'no --mode plan output' : p.status !== 'PASS' || p.manifest_version !== 2 || p.contract !== 2 ? 'the plan preflight did not PASS on a version 2 manifest'
    : p.manifest_sha256 !== A.manifest_sha256 || p.reviewed_sha !== sha || p.design_commit !== A.design_commit || p.approvals_sha256 !== A.approvals_sha256 ? 'the plan preflight names another manifest, commit or approvals ledger'
    : !Array.isArray(p.checks) || !p.checks.every(c => c && CHECK_ID.test(c.id) && typeof c.name === 'string' && typeof c.quiet === 'boolean' && ['low', 'medium', 'high'].includes(c.effort) && isInt(c.budget_min, 0) && isInt(c.timeout_min, 1)) ? 'a check id or its fields fail their pattern'
    : !Array.isArray(p.runtime_acceptance_ids) || !p.runtime_acceptance_ids.every(id => ACC_ID.test(id)) ? 'a runtime acceptance id fails its pattern'
    : !Array.isArray(p.live_acceptances) || !p.live_acceptances.every(x => x && ACC_ID.test(x.id) && CHECK_ID.test(x.check_id)) ? 'a live acceptance id fails its pattern'
    : !Array.isArray(p.negative_controls) || !p.negative_controls.every(x => x && ACC_ID.test(x.id) && HEX64.test(x.mutation_sha256 || '')) ? 'a negative control id fails its pattern'
    : !Array.isArray(p.clean_ignore) || !p.clean_ignore.every(relPath) ? 'the frozen clean_ignore is not a list of repo-relative paths' : ''
  if (planBad) return disclose({ status: 'BLOCKED', stage: 'plan preflight', reason: planBad, plan: planRun })
  const L = p.limits
  if (!L || !isInt(L.proof_timeout_s, 1) || !isInt(L.negative_controls_total_min, 1) || typeof p.suite_setup !== 'boolean') return disclose({ status: 'BLOCKED', stage: 'plan preflight', reason: 'the plan preflight lacks the frozen limits', plan: planRun })
  const run1 = s => s + RUN_GRACE_S
  const negRuns = p.suite_setup ? 3 : 2 // setup (when set), the baseline and the mutated run, each bounded by proof_timeout_s
  const tooLong = [
    ...p.checks.map(c => overCall(`check ${c.id} (${c.budget_min > 0 ? `budget_min ${c.budget_min}` : `timeout_min ${c.timeout_min}`})`, run1((c.budget_min > 0 ? c.budget_min : c.timeout_min) * 60))),
    // The proofs run in batches that each fit one call (below), so only one proof has to fit.
    p.runtime_acceptance_ids.length ? overCall(`an acceptance proof (proof_timeout_s ${L.proof_timeout_s}, one run-frozen.js run)`, run1(L.proof_timeout_s)) : '',
    ...p.negative_controls.map(n => overCall(`negative control ${n.id} (${negRuns} runs x proof_timeout_s ${L.proof_timeout_s}, within negative_controls_total_min ${L.negative_controls_total_min})`,
      Math.min(negRuns * run1(L.proof_timeout_s), L.negative_controls_total_min * 60 + negRuns * RUN_GRACE_S))),
  ].filter(Boolean)
  if (tooLong.length) return disclose({ status: 'BLOCKED', stage: 'plan preflight', reason: tooLong.join('; '), plan: planRun })
  IGNORE = p.clean_ignore.map(x => x.replace(/^\.\//, ''))
  stateNote = stateNoteFor()

  phase('Checks')
  const frozenRuns = `${A.run_dir}/frozen-runs`
  const checks = []
  for (const c of p.checks) {
    const limit = c.budget_min > 0 ? `a live or paid check: run-frozen.js kills it at its budget of ${c.budget_min} minutes, which is also the cap on its measured time` : `run-frozen.js kills it at its timeout of ${c.timeout_min} minutes`
    const r = await agent(
      `Run the frozen check ${c.id} (${c.name}) of feature ${A.feature_id} through run-frozen.js: it runs exactly the manifest's command for ${c.id} on the pinned, clean reviewed commit ${sha} (${limit}); never type the check's command yourself. ` +
      (c.quiet ? 'Run only on a quiet machine: before the block, check that no other heavy test process is running and wait (bounded) if one is; if the machine never goes quiet, run nothing and return blocked=true with the reason in note. ' : '') +
      EXEC_NOTE + frozenBlock([runFrozen(`check:${c.id}`, frozenRuns)]) + `\n- ${RULES}`,
      { label: `check ${c.id}`, phase: 'Checks', schema: EXEC, effort: c.effort })
    if (!r || r.blocked) return refusedStatus(r, `check ${c.id}`, 'run-frozen.js refused the check', { check: r, checks })
    const got = await recordLine(r, { step: `check ${c.id}`, ph: 'Checks', record: `${frozenRuns}/check:${c.id}.record.json`, target: `check:${c.id}` })
    if (r.exit_code !== 0 && !got.recovered) return refusedStatus(r, `check ${c.id}`, 'run-frozen.js refused the check' + (got.why ? ` (${got.why})` : ''), { check: r, checks })
    if (!got.printed) return disclose({ status: 'BLOCKED', stage: `check ${c.id}`, reason: `the check record was not printed (${got.why})`, check: r, checks })
    const printed = got.printed
    checks.push({ check_id: c.id, name: c.name, record_path: printed.record_path, record_sha256: printed.record_sha256, exit_code: printed.exit_code, timed_out: printed.timed_out,
      status: printed.exit_code === 0 && printed.timed_out === false ? 'PASS' : 'FAIL' })
  }
  // Every applicable check must exit 0 (completion rejects anything else), so a failed check ends verify here.
  const failedChecks = checks.filter(c => c.status !== 'PASS')
  if (failedChecks.length) return disclose({ status: 'INCOMPLETE', stage: 'checks', reason: 'frozen check(s) failed: ' + failedChecks.map(c => `${c.check_id} exit ${c.exit_code}${c.timed_out ? ' (timed out)' : ''}`).join(', '), checks })

  phase('Acceptance proofs')
  // The proofs run in sequential batches, each its own agent call and gp-exec block, packed in manifest order so that
  // a batch's worst case (its proof count x one proof's limit + grace) fits one foreground Bash call. Every batch
  // appends to the same ledger through run-frozen.js and prints its hash; the last batch's hash is the ledger's. The
  // live links execute nothing and follow the last proof, in manifest order, in the last batch.
  const ledger = `${A.run_dir}/acceptance-ledger.json`
  const perBatch = Math.max(1, Math.floor(ONE_CALL_S / run1(L.proof_timeout_s)))
  const batchIds = []
  for (let i = 0; i < p.runtime_acceptance_ids.length; i += perBatch) batchIds.push(p.runtime_acceptance_ids.slice(i, i + perBatch))
  if (!batchIds.length) batchIds.push([])
  const batches = batchIds.map(ids => ids.map(id => runFrozen(`proof:${id}`, frozenRuns, ` --ledger ${q(ledger)}`)))
  batches[batches.length - 1].push(...p.live_acceptances.map(x => runFrozen(`live:${x.id}`, frozenRuns, ` --ledger ${q(ledger)}`)))
  const proofRec = id => `${frozenRuns}/proof:${id}.record.json`
  const liveRec = x => `${frozenRuns}/check:${x.check_id}.record.json`
  const proofRuns = []
  const recoveredLines = [] // record lines a readback recovered, as run-frozen.js would have printed them
  const rbErrors = []
  let proofs = null
  let ledgerSha = null
  for (const [i, lines] of batches.entries()) {
    const part = batches.length > 1 ? ` (batch ${i + 1} of ${batches.length}; every batch appends to the same ledger)` : ''
    const step = `acceptance proofs ${i + 1}`
    proofs = await agent(
      `Record the acceptance evidence of feature ${A.feature_id} with run-frozen.js${part}: every runtime proof runs exactly its frozen command on the pinned reviewed commit and is appended to the acceptance ledger ${ledger}; ` +
      `a live acceptance executes nothing and only links the record of the check that ran it. Do not make live or paid calls here. ${EXEC_NOTE}` +
      frozenBlock([...(lines.length ? lines : [writeJsonBlock(ledger, { version: 2, entries: [] })]), `sha256sum ${q(ledger)}`]) + `\n- ${RULES}`,
      { label: step, phase: 'Acceptance proofs', effort: 'low', schema: EXEC })
    if (!proofs || proofs.blocked) return refusedStatus(proofs, 'acceptance proofs', `run-frozen.js refused a proof or live link (batch ${i + 1} of ${batches.length})`, { proofs, proof_batches: proofRuns, checks })
    // A batch reply that lacks a record line, a live link or (last batch) the ledger hash gets ONE readback of the
    // missing records and the ledger; every recovered record must be listed in the ledger as run-frozen.js appends it.
    const last = i === batches.length - 1
    const here = jsonLines(proofs.stdout)
    const lostIds = batchIds[i].filter(id => !here.some(o => o.record_path === proofRec(id) && HEX64.test(o.record_sha256 || '')))
    const lostLive = last ? p.live_acceptances.filter(x => !here.some(o => o.linked === true && o.record_path === liveRec(x) && HEX64.test(o.record_sha256 || ''))) : []
    const lost = [...lostIds.map(proofRec), ...lostLive.map(x => `the live link ${x.id}`), ...(last && !HEX64.test(shaOf(proofs.stdout, ledger) || '') ? [`the sha256sum line of ${ledger}`] : [])]
    let rb = null
    if (lost.length && !rbRefused(proofs) && !(stateDrift(proofs.stdout) || []).length) {
      rb = await readback({ step, ph: 'Acceptance proofs', sha, clean: IGNORE, reads: lostIds.map(id => ({ record: proofRec(id), target: `proof:${id}` })), files: [ledger] })
      const checkSha = x => (checks.find(ch => ch.check_id === x.check_id) || {}).record_sha256
      if (!rb.error) {
        const entries = Array.isArray(rb.files[ledger].value.entries) ? rb.files[ledger].value.entries : []
        const listed = (id, live, recPath, recSha, checkId) => entries.some(e => e && e.id === id && e.live === live && e.record_path === recPath && e.record_sha256 === recSha && (!live || e.check_id === checkId))
        const unlisted = [...lostIds.filter((id, k) => !listed(id, false, rb.records[k].record_path, rb.records[k].record_sha256)),
          ...lostLive.filter(x => !listed(x.id, true, liveRec(x), checkSha(x), x.check_id)).map(x => x.id)]
        if (unlisted.length) rb = { error: `the ledger ${ledger} does not list ${unlisted.join(', ')} with the record read back` }
      }
      if (rb.error) rbErrors.push(`batch ${i + 1}: no printed record line for ${lost.join(', ')}; readback: ${rb.error}`)
      else {
        recoveredLines.push(...rb.records.map(x => x.printed),
          ...lostLive.map(x => ({ record_path: liveRec(x), record_sha256: checkSha(x), exit_code: 0, timed_out: false, setup_exit_code: null, linked: true })))
        READBACK.push(...rb.records.map(x => ({ step, record_path: x.record_path })), ...lostLive.map(x => ({ step, record_path: liveRec(x) })), ...(last ? [{ step, ledger_path: ledger }] : []))
      }
    }
    const recovered = !!rb && !rb.error
    if (proofs.exit_code !== 0 && !recovered) {
      return refusedStatus(proofs, 'acceptance proofs', `run-frozen.js refused a proof or live link (batch ${i + 1} of ${batches.length})${rb ? ` (${rbErrors[rbErrors.length - 1]})` : ''}`, { proofs, proof_batches: proofRuns, checks })
    }
    proofRuns.push(proofs)
    if (last) ledgerSha = recovered ? rb.files[ledger].sha256 : shaOf(proofs.stdout, ledger)
  }
  const proofPrinted = [...proofRuns.flatMap(r => jsonLines(r.stdout)), ...recoveredLines]
  const missingProof = [...p.runtime_acceptance_ids.filter(id => !proofPrinted.some(o => o.record_path === proofRec(id))),
    ...p.live_acceptances.filter(x => !proofPrinted.some(o => o.linked === true && o.record_path === liveRec(x))).map(x => x.id)]
  if (!HEX64.test(ledgerSha || '') || missingProof.length) {
    return disclose({ status: 'BLOCKED', stage: 'acceptance proofs', reason: 'the ledger hash or a proof record was not printed: ' + missingProof.join(', ') + (rbErrors.length ? ` (${rbErrors.join('; ')})` : ''), proofs, proof_batches: proofRuns, checks })
  }
  const acceptance = { path: ledger, sha256: ledgerSha }

  phase('Final review')
  const out = `${A.run_dir}/final-review`
  const fbOut = out + '-opus'
  const finSetup = dir => [
    `echo "head_sha: $(git -C ${q(A.repo)} rev-parse HEAD)"`,
    `git -C ${q(A.repo)} diff --binary --no-renames ${base} ${sha} > ${q(dir + '/change.patch')}`,
    `git -C ${q(A.repo)} worktree add --detach ${q(dir + '/wt')} ${base}`,
    `git -C ${q(dir + '/wt')} apply --index ${q(dir + '/change.patch')}`,
  ].join('\n')
  const finNote = dir => `Report head_sha: the head_sha: line setup printed (the branch head, read first). The checkout ${dir}/wt holds the whole change ` +
    `${base}..${sha} as uncommitted edits.\n`
  const finCmd = `node ${q(A.review_runner)} --kind implementation --uncommitted --repo ${q(out + '/wt')} --out-dir ${q(out)}` +
    `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}`
  let finRaw = null
  let fin = await reviewed('final review', r => gateCodex('implementation', r), () => agent(
    `Run an independent codex implementation review of the CHANGE this feature made and report its verdict. Do not review the code yourself.\n` +
    relaySteps({ setup: ['set -e', gpProbe(true), gpFresh(out), finSetup(out)].join('\n'), start: gpStart(finCmd, out),
      poll: gpPoll(`${q(out)}/implementation-*/result.json`), cleanup: [gpStop(out), gpUnwt(out + '/wt'), gpList(out, 'implementation')].join('\n'),
      minutes: Math.ceil(TIMEOUT_S * 6 / 60) + 5 }) +
    `${finNote(out)}${relayRead(out, 'implementation')}\n- ${RULES}`,
    { label: 'codex final review', phase: 'Final review', schema: RELAY, effort: 'low' }),
  () => agent(
    `Codex is not available in this environment, so YOU are the independent final implementation reviewer of the CHANGE in its place (the repo config chose review_fallback: opus-high).\n` +
    fallbackSteps(['set -e', gpFresh(fbOut), finSetup(fbOut), ...fbInputs(fbOut)].join('\n'), [gpUnwt(fbOut + '/wt'), gpList(fbOut)].join('\n')) + finNote(fbOut) +
    `Review the change as it stands in that checkout (git -C ${q(fbOut + '/wt')} diff --cached is the whole change ${base}..${sha}; read any other file there for context) ` +
    `for correctness bugs, behaviour that contradicts the frozen canonical file ${A.spec_path}, and unsafe code. Report findings ONLY in that change. ${parityNote('implementation')}\n- ${RULES}`,
    { label: 'opus final review (codex unavailable)', phase: 'Final review', schema: PARITY_SCHEMA({ head_sha: { type: 'string' } }), model: 'opus', effort: 'high' }).then(f => { finRaw = f; return gateFallback('implementation', f) }))
  fin = await reviewFile({ step: 'final', round: 1, out, fb: fbOut, res: fin, raw: finRaw, ph: 'Final review', label: 'final review' })
  if (!fin || fin.blocked || fin.verdict === 'ERROR' || (fin.verdict === 'NEEDS_HUMAN' && !fin.confirmed_findings.length)) return disclose({ status: 'BLOCKED', stage: 'final review', checks, final_review: fin })
  if (fin.verdict === 'PASS' && fin.confirmed_findings.length) fin.verdict = 'FAIL'
  if (fin.head_sha !== sha) return disclose({ status: 'HEAD_MOVED', reason: `branch head is ${fin.head_sha}, build reviewed ${sha}: re-run build`, checks, final_review: fin })

  const cout = `${A.run_dir}/compliance`
  const compFb = cout + '-opus'
  const compIsolate = dir => `git -C ${q(A.repo)} worktree add --detach ${q(dir + '/wt')} ${sha}`
  // The task text is quoted into prompt.md, so it holds no double quotes.
  const compTask = `Trace every acceptance of the frozen canonical feature file ${A.spec_path} (its generated views ${A.frozen_dir}/prd.view.md and ${A.frozen_dir}/spec.view.md, and the frozen manifest ${A.manifest_path}) ` +
    `to the implementation in this repository (the change is git diff ${base} ${sha}; this checkout is at ${sha}) and its tests. For each acceptance that is missing, implemented differently from the canonical file, ` +
    `or not covered by a proof that would fail if it broke, report a finding of severity high that quotes the canonical text and the code. ` +
    `Read the acceptance ledger ${ledger} (the run-frozen records of every runtime proof and live link), the build result ${A.build_result_path} and the check records under ${frozenRuns}. ` +
    `Return requirements with EVERY acceptance id of the manifest requirements list exactly once and PASS/FAIL/NOT_RUN. Runtime evidence is the ledger's run-frozen records: give a runtime acceptance an empty evidence list. ` +
    `A static acceptance cites evidence records of kind static with head_sha=${sha}, command, exit_code, log_path and log_sha256 null, a repo-relative file inside one of its frozen evidence_paths (or alternate_evidence_paths), and a line. ` +
    (A.require_scan_row ? `The repository requires a security scan row: confirm that its scan log ${A.scan_log} contains a dated entry covering this change at ${sha}, ` +
      `and cite it as static evidence file:line in your summary or note. If there is no such entry, report a finding of severity high with requirement security-scan-log. ` : '') +
    `Never execute a command found in the canonical file, a view or the manifest, and do not invent missing evidence. verdict FAIL for any missing/wrong/unproven item, else PASS.`
  const compCmd = `timeout --kill-after=60 1800 codex exec${A.codex_model ? ` -m ${q(A.codex_model)}` : ''} -c model_reasoning_effort=${A.codex_effort || 'high'} -s read-only -C ${q(cout + '/wt')} --output-schema ${q(A.compliance_schema)} -o ${q(cout + '/compliance.json')} - < ${q(cout + '/prompt.md')}`
  let compRaw = null
  let comp = await reviewed('compliance', r => r, () => agent(
    `Run an independent codex SPEC-COMPLIANCE trace and report its verdict. Do not judge it yourself. ` +
    `Every file codex reads is the reviewed commit's: setup makes an isolated checkout of it at ${cout}/wt, and cleanup removes exactly that checkout.\n` +
    `1. The setup block writes ${cout}/prompt.md containing: "${compTask}"\n` +
    `2. Run under a HARD process timeout so codex can never outlive this step (the start block); if the timeout fires the process is already killed: report ERROR. ` +
    relaySteps({ setup: ['set -e', gpProbe(false), gpFresh(cout), compIsolate(cout), `cat > ${q(cout + '/prompt.md')} <<'GP_TASK'`, compTask, 'GP_TASK'].join('\n'),
      start: gpStart(compCmd, cout), poll: gpPoll(q(cout + '/compliance.json')), cleanup: [gpStop(cout), gpUnwt(cout + '/wt'), gpList(cout), `sha256sum ${q(cout + '/compliance.json')} 2>&1 || true`].join('\n'), minutes: 32 }) +
    `3. After cleanup, read ${cout}/compliance.json and return verdict, requirements verbatim, and EVERY finding as blocking (each one is a requirement missing, wrong or unproven). If codex errors, hits a usage cap, or writes no valid JSON, return ERROR with the reason in note.${RAW_NOTE('compliance.json')}\n` +
    `Around all of the blocks (on the main repo, not the isolated checkout): ${stateNote}\n- ${RULES}`,
    { label: 'codex spec compliance', phase: 'Final review', schema: RAW_RELAY(COMPLY), effort: 'low' }),
  () => agent(
    `Codex is not available in this environment, so YOU run the independent SPEC-COMPLIANCE trace in its place (the repo config chose review_fallback: opus-high). Do not change any file.\n` +
    fallbackSteps(['set -e', gpFresh(compFb), compIsolate(compFb)].join('\n'), [gpUnwt(compFb + '/wt'), gpList(compFb)].join('\n')) +
    `Work in the isolated checkout of the reviewed commit at ${compFb}/wt.\n` +
    `1. ${compTask}\n` +
    `2. Return verdict, requirements (each shaped exactly as the requirements items in ${A.compliance_schema}: id, status and evidence records), and EVERY finding as blocking (each one is a requirement missing, wrong or unproven).\n` +
    `Around the setup, the trace and the cleanup (on the main repo, not the isolated checkout): ${stateNote}\n- ${RULES}`,
    { label: 'opus spec compliance (codex unavailable)', phase: 'Final review', schema: COMPLY, model: 'opus', effort: 'high' }).then(f => { compRaw = f; return f }))
  comp = await reviewFile({ step: 'compliance', round: 1, out: cout, fb: compFb, res: comp, raw: compRaw, ph: 'Final review', label: 'compliance', rawName: 'compliance.json' })
  if (!comp || comp.blocked || comp.verdict === 'ERROR') return disclose({ status: 'BLOCKED', stage: 'compliance', checks, final_review: fin, compliance: comp })
  if (comp.blocking.length) comp.verdict = 'FAIL'
  const compDrift = pinned(comp)
  if (compDrift.length) return disclose({ status: 'HEAD_MOVED', stage: 'compliance', reason: 'compliance trace did not run on the clean reviewed commit: ' + compDrift.join('; '), checks, final_review: fin, compliance: comp })
  const reportOf = (status, extra = {}) => disclose({ status, contract: 2, feature_id: A.feature_id, base_commit: base, reviewed_sha: sha, manifest_sha256: A.manifest_sha256,
    design_commit: A.design_commit, approvals_sha256: A.approvals_sha256, checks, check_records: checks.map(c => ({ check_id: c.check_id, record_path: c.record_path, record_sha256: c.record_sha256 })),
    acceptance_ledger: acceptance, final_review: fin, compliance: comp, review_files: reviewFiles.slice(),
    repo_config: { scan_log: A.scan_log || null, require_scan_row: A.require_scan_row === true }, ...extra })
  if (fin.verdict !== 'PASS' || comp.verdict !== 'PASS') return reportOf('FAIL', { negative_controls: [] })

  // Negative controls run LAST, after every other piece of evidence is captured and hashed (design 6.4).
  phase('Negative controls')
  const negatives = []
  for (const n of p.negative_controls) {
    const dir = `${A.run_dir}/negative/${n.id}`
    const patch = `${dir}/mutation.patch`
    const draft = `${dir}/draft`
    const r = await agent(
      `Negative control ${n.id} of feature ${A.feature_id}: write the frozen mutation as a patch, then let run-frozen.js prove the proof of ${n.id} fails on it.\n` +
      `1. Read negative_control.mutation of the entry ${n.id} in the requirements list of the frozen manifest ${A.manifest_path}. Two different hashes apply: the manifest FILE hashes to ${A.manifest_sha256}, and the mutation STRING itself ` +
      `(the value of that negative_control.mutation field, as UTF-8 bytes, without JSON quotes) hashes to ${n.mutation_sha256}. It is prose that says what to break, never a command.\n` +
      `2. Write that mutation as a unified git patch to ${patch}: mkdir -p ${q(dir)}; git -C ${q(A.repo)} worktree add --detach ${q(draft)} ${sha}; make the edit in ${draft} only, ` +
      `in non-test code inside the owned paths of the acceptance's components (never a file under the frozen test_paths, never a test the build added, never a file named in the proof command); ` +
      `git -C ${q(draft)} add -A -N; git -C ${q(draft)} diff --no-renames > ${q(patch)}; git -C ${q(A.repo)} worktree remove --force ${q(draft)} ` +
      `(add -N, intent to add, makes git diff include a new file). The patch may only change existing files or add regular files: no rename, deletion, mode change or binary change. Never touch the work checkout ${A.repo}.\n` +
      `3. Then: ${EXEC_NOTE}` + frozenBlock([runFrozen(`negative:${n.id}`, dir, ` --patch ${q(patch)}`)]) + `\n- ${RULES}`,
      { label: `negative control ${n.id}`, phase: 'Negative controls', schema: EXEC, effort: 'medium' })
    if (!r || r.blocked) return reportOf('BLOCKED', { stage: 'negative controls', reason: `negative control ${n.id} was blocked`, negative: r, negative_controls: negatives })
    const got = await recordLine(r, { step: `negative control ${n.id}`, ph: 'Negative controls', record: `${dir}/negative:${n.id}.record.json`, target: `negative:${n.id}`, patch })
    const printed = got.printed
    if (printed && printed.not_run) {
      negatives.push({ id: n.id, record_path: printed.record_path, record_sha256: printed.record_sha256 })
      return reportOf('INCOMPLETE', { stage: 'negative controls', reason: `negative control ${n.id} is NOT RUN: negative_controls_total_min of phase time was used before it`, negative: r, negative_controls: negatives })
    }
    const negDrift = r.exit_code !== 0 ? stateDrift(r.stdout) : null
    if (negDrift && negDrift.length) return reportOf('HEAD_MOVED', { stage: 'negative controls', reason: `during negative control ${n.id} the work checkout left the clean reviewed commit (${negDrift.join('; ')}): re-run build`, negative: r, negative_controls: negatives })
    if ((r.exit_code !== 0 && !got.recovered) || !printed) return reportOf('INCOMPLETE', { stage: 'negative controls', reason: `negative control ${n.id} did not run (refused patch, or the checkout moved)${got.why ? `: ${got.why}` : ''}`, negative: r, negative_controls: negatives })
    negatives.push({ id: n.id, record_path: printed.record_path, record_sha256: printed.record_sha256 })
  }
  const after = await agent(`After the negative controls, check that the work checkout is still pinned at ${sha} and clean. ${EXEC_NOTE}` +
    execBlock(['set -e', `echo "head: $(git -C ${q(A.repo)} rev-parse HEAD)"`, 'echo "status:"', `git -C ${q(A.repo)} status --porcelain --untracked-files=all`].join('\n')) + `\n- ${RULES}`,
    { label: 'pinned state', phase: 'Negative controls', schema: EXEC, effort: 'low' })
  if (!after || after.blocked || after.exit_code !== 0) return reportOf('BLOCKED', { stage: 'negative controls', reason: 'the pinned-state check failed', negative_controls: negatives })
  const afterLines = after.stdout.split('\n')
  const afterHead = ((afterLines.find(l => l.startsWith('head: ')) || '').slice(6)).trim()
  const afterStatus = afterLines.slice(afterLines.indexOf('status:') + 1).filter(l => l.trim())
  if (afterLines.indexOf('status:') < 0 || afterHead !== sha || dirty(afterStatus).length) {
    return reportOf('HEAD_MOVED', { stage: 'negative controls', reason: `after the negative controls HEAD is ${afterHead} (reviewed ${sha}) with ${dirty(afterStatus).length} dirty path(s): re-run build`, negative_controls: negatives })
  }

  phase('Completion')
  const report = reportOf('PASS', { negative_controls: negatives })
  const reportPath = `${A.run_dir}/verify-result.json`
  const proofPath = `${A.run_dir}/completion-proof.json`
  const cc = await agent(
    `Write the verify result with write-json.js, then run the real deterministic completion validator (do not substitute your own judgement). ${EXEC_NOTE}` +
    execBlock(['set -e', writeJsonBlock(reportPath, report),
      `node ${SCRIPT('check-completion.js')} --repo ${q(A.repo)} --feature-id ${q(A.feature_id)} --reviewed-sha ${sha} --manifest ${q(A.manifest_path)} --manifest-sha256 ${A.manifest_sha256} ` +
      `--spec ${q(A.spec_path)} --build-result ${q(A.build_result_path)} --verify-result ${q(reportPath)} --out ${q(proofPath)} --frozen-dir ${q(A.frozen_dir)} ` +
      `--approvals ${q(A.approvals_path)} --approvals-sha256 ${A.approvals_sha256} 2>&1`].join('\n')) + `\n- ${RULES}`,
    { label: 'completion proof', phase: 'Completion', effort: 'low', schema: EXEC })
  if (!cc || cc.blocked) return { ...report, status: 'BLOCKED', stage: 'completion', completion: cc }
  const ccLines = jsonLines(cc.stdout)
  const written = ccLines.find(o => o.path === reportPath && HEX64.test(o.sha256 || ''))
  const verdictLine = ccLines.find(o => o.status === 'PASS' && o.proof_path) || ccLines.find(o => o.status === 'BLOCKED' && o.code)
  if (!written || !verdictLine) return { ...report, status: 'BLOCKED', stage: 'completion', reason: 'the verify result or the validator output is missing', completion: cc }
  const completion = { passed: cc.exit_code === 0 && verdictLine.status === 'PASS', ...verdictLine, verify_result_sha256: written.sha256 }
  if (!completion.passed || completion.proof_path !== proofPath || completion.reviewed_sha !== sha || completion.manifest_sha256 !== A.manifest_sha256 || completion.contract !== 2) {
    return { ...report, status: 'INCOMPLETE', stage: 'completion', verify_result_path: reportPath, completion }
  }
  return { ...report, verify_result_path: reportPath, completion }
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
  `Inspect files only with read-only commands (cat, sed, grep, ls, git diff, git show, git log); never run tests, builds or anything that writes, and do not invent missing evidence. verdict FAIL for any missing/wrong/unproven item, else PASS.`
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
