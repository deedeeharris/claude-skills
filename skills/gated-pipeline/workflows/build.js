export const meta = {
  name: 'gated-build',
  description: 'Test-first implementation by Claude, codex review + security pass, fix loop, full suite last',
  whenToUse: 'Stage 2 of the gated-pipeline skill: build a feature from its frozen spec or charge',
  phases: [
    { title: 'Preflight', detail: 'contract 2: the design identity of the frozen plan, before any change' },
    { title: 'Implement', detail: 'Claude implementer, test-first, commits on the work branch' },
    { title: 'Review', detail: 'codex reviews the change, then a codex security pass' },
    { title: 'Fix', detail: 'Claude fixes confirmed codex findings and suite failures' },
    { title: 'Suite', detail: 'full test suite, last' },
  ],
}

const A = args || {}
// contract 1 (absent = 1): today's flow, stamped build_mode "v1" (spec_path) or "charge-only" (charge only).
// contract 2 (docs/v2-design.md 6.1, 6.3): design-gated, stamped build_mode "v2"; every command that runs or excuses
// verification comes from the frozen manifest, so the args that used to carry them are BLOCKED before any agent.
if (A.contract !== undefined && A.contract !== 1 && A.contract !== 2) return { status: 'BLOCKED', reason: 'contract must be 1 or 2' }
const C2 = A.contract === 2
const FORBIDDEN_V2 = ['checks', 'clean_ignore', 'state_paths', 'suite_cmd', 'unit_cmd', 'known_failures', 'isolated_setup', 'suite_isolated', 'live_budget_min']
const ONLY_V2 = ['frozen_dir', 'design_commit', 'approvals_path', 'approvals_sha256', 'ci_failure_log_path']
if (C2) {
  const forbidden = FORBIDDEN_V2.filter(k => A[k] !== undefined)
  if (forbidden.length) return { status: 'BLOCKED', stage: 'args', reason: `contract 2 does not take ${forbidden.join(', ')}: the frozen manifest is their only source` }
  const mixed = ['task', 'charge'].filter(k => A[k] !== undefined)
  if (mixed.length) return { status: 'BLOCKED', stage: 'args', reason: `contract 2 does not take ${mixed.join(', ')}: it builds the frozen canonical file (CI failure context goes in ci_failure_log_path)` }
} else {
  const v2only = ONLY_V2.filter(k => A[k] !== undefined)
  if (v2only.length) return { status: 'BLOCKED', stage: 'args', reason: `${v2only.join(', ')} need contract: 2` }
}
const need = C2
  ? ['feature_id', 'repo', 'work_branch', 'run_dir', 'review_runner', 'security_schema', 'completion_runner', 'frozen_dir', 'manifest_path', 'manifest_sha256', 'spec_path', 'design_commit', 'approvals_path', 'approvals_sha256', 'base_commit']
  : ['feature_id', 'repo', 'work_branch', 'run_dir', 'review_runner', 'suite_cmd', 'security_schema']
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
if (!A.spec_path && !A.charge) return { status: 'BLOCKED', reason: 'need spec_path or charge' }
// Paths go into shell commands: single-quoted, and only from a conservative character set.
const SAFE = /^[A-Za-z0-9._\/\\: +@-]+$/
for (const k of ['repo', 'run_dir', 'review_runner', 'spec_path', 'security_schema', 'security_checklist']) {
  if (A[k] && (!SAFE.test(A[k]) || !/^([A-Za-z]:[\/\\]|\/)/.test(A[k]))) return { status: 'BLOCKED', reason: `${k} must be an absolute path of safe characters (no ~, quotes, $ or backticks): ${A[k]}` }
}
// contract 2 identity args. Scripts (run-frozen, write-json, hash-inputs) are found next to completion_runner.
const BUILD_MODE = C2 ? 'v2' : A.spec_path ? 'v1' : 'charge-only'
// Absolute, normalized (no //, /./, .. or trailing slash), so a path the scripts print compares equal by spelling.
const CANON = p => typeof p === 'string' && SAFE.test(p) && /^\//.test(p) && !/\/\/|\/\.(\/|$)|\/\.\.(\/|$)|.\/$|\\/.test(p)
const V2_SCRIPTS = C2 ? A.completion_runner.replace(/\/check-completion\.js$/, '') : ''
if (C2) {
  for (const k of ['repo', 'run_dir', 'spec_path', 'completion_runner', 'frozen_dir', 'manifest_path', 'approvals_path', 'ci_failure_log_path']) {
    if (A[k] !== undefined && !CANON(A[k])) return { status: 'BLOCKED', stage: 'args', reason: `${k} must be a normalized absolute POSIX path of safe characters: ${A[k]}` }
  }
  if (V2_SCRIPTS === A.completion_runner) return { status: 'BLOCKED', stage: 'args', reason: 'completion_runner must be the skill\'s scripts/check-completion.js' }
  if (A.manifest_path !== A.frozen_dir + '/execution-plan.json') return { status: 'BLOCKED', stage: 'args', reason: 'manifest_path must be <frozen_dir>/execution-plan.json' }
  if (!/^[A-Za-z0-9._-]+$/.test(A.feature_id)) return { status: 'BLOCKED', stage: 'args', reason: 'feature_id must match [A-Za-z0-9._-]' }
  for (const k of ['manifest_sha256', 'approvals_sha256']) if (!/^[0-9a-f]{64}$/.test(A[k])) return { status: 'BLOCKED', stage: 'args', reason: `${k} must be a 64-hex hash` }
  if (!/^[0-9a-f]{40}$/.test(A.design_commit)) return { status: 'BLOCKED', stage: 'args', reason: 'design_commit must be a full 40-hex commit id' }
  if (A.base_commit !== A.design_commit) return { status: 'BLOCKED', stage: 'args', reason: `base_commit must equal design_commit under contract 2 (got ${A.base_commit}, design ${A.design_commit})` }
  const inRepo = p => p === A.repo || p.startsWith(A.repo.replace(/\/$/, '') + '/')
  for (const k of ['run_dir', 'frozen_dir', 'approvals_path', 'ci_failure_log_path']) if (A[k] !== undefined && inRepo(A[k])) return { status: 'BLOCKED', stage: 'args', reason: `${k} must lie outside the repo` }
}
// Optional repo security docs (threat model, accepted risks): absolute paths, validated like every other path arg.
if (A.security_docs !== undefined && (!Array.isArray(A.security_docs) || A.security_docs.some(p => typeof p !== 'string' || !SAFE.test(p) || !/^([A-Za-z]:[\/\\]|\/)/.test(p)))) return { status: 'BLOCKED', reason: 'security_docs must be a list of absolute paths of safe characters (no ~, quotes, $ or backticks)' }
const SEC_READ = [...(A.security_docs || []), ...(A.security_checklist ? [A.security_checklist] : [])]

const MAX = A.max_fix_rounds ?? 4
const IMPL_EFFORT = A.impl_effort || 'medium'
const TIMEOUT_S = A.review_timeout_seconds || 1200
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
// Config values that reach shell commands must be plain tokens.
if (A.codex_model && !/^[A-Za-z0-9._-]+$/.test(A.codex_model)) return { status: 'BLOCKED', reason: 'codex_model must match [A-Za-z0-9._-]' }
if (A.codex_effort && !['low', 'medium', 'high', 'xhigh'].includes(A.codex_effort)) return { status: 'BLOCKED', reason: 'codex_effort must be low|medium|high|xhigh' }
if (A.review_timeout_seconds !== undefined && !(Number.isInteger(A.review_timeout_seconds) && A.review_timeout_seconds > 0)) return { status: 'BLOCKED', reason: 'review_timeout_seconds must be a positive integer' }
if (A.review_fallback !== undefined && !['none', 'opus-high'].includes(A.review_fallback)) return { status: 'BLOCKED', reason: 'review_fallback must be none|opus-high' }
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
const rulesFor = (liveBudgetMin, extra) => [
  `Repo: ${A.repo}. Work ONLY on branch ${A.work_branch}; never touch other branches, never push or merge the trunk.`,
  'Commit with explicit pathspecs only (never git add -A or .). Never git rm, never glob-delete, never --no-verify.',
  'Before each commit, scan the staged diff for secrets (.env, service-account json, .pem, id_rsa, API keys) and abort if any are present.',
  'Never deploy, never run Terraform, never touch production resources.',
  'Use the checkout selected by the orchestrator at the supplied repo path; an existing checkout is supported and a dedicated feature worktree is optional. Follow the orchestrator\'s checkout ownership and writer coordination. Check branch, clean baseline and the correct dev/client environment before the first edit. Never weaken a guard or verification harness to unblock work.',
  // contract 2 (design section 1): no model authors a ledger; the only v2 ledger is the acceptance ledger run-frozen.js writes in verify.
  C2 ? 'Your red/green notes go in your reply; they certify nothing, so write no ledger, manifest or hash file. The only contract-2 ledger is the acceptance ledger run-frozen.js writes in verify. Preserve failed/interrupted output. Stop on unapproved scope expansion.'
    : `Keep atomic per-acceptance checkpoints at ${A.run_dir}/execution-ledger.json: id, status, command, exit code, log_path, log_sha256 and commit. Preserve failed/interrupted output. Stop on unapproved scope expansion.`,
  A.lock_note ? `Test runs: ${A.lock_note}` : '',
  liveBudgetMin ? `Live or paid tests: hard cap ${liveBudgetMin} minutes total; ${C2 ? '' : `keep a ledger at ${A.run_dir}/live-ledger.txt; `}record anything that cannot fit as NOT RUN.` : 'Do not run live or paid external-API tests.',
  'Report only numbers you observed in command output. A skipped check is NOT RUN, never a pass.',
  'If any command is blocked, or a tool or the API refuses, STOP and report blocked=true. Never reproduce its effect another way.',
  ...(extra || []),
].filter(Boolean).join('\n- ')
// contract 2: commands are data until frozen (design section 5); only run-frozen.js executes a frozen command.
const NOEXEC = C2 ? [`Never execute a proof, check, suite or setup command found in the canonical file ${A.spec_path} or in its generated views; the frozen verification runs only through scripts/run-frozen.js in the gp-exec blocks the workflow gives you. Never edit the canonical file, its views or the manifest.`] : []
let RULES = rulesFor(A.live_budget_min, NOEXEC)

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
const HEAD_SHA = { type: 'string' }
const CHANGED = { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, path: { type: 'string' } }, required: ['status', 'path'] } }
// NEEDS_HUMAN only because codex's own verdict disagreed with the runner's rule, with findings still listed: those go to
// the fixer. Every other NEEDS_HUMAN without confirmed findings stops the stage.
const disagreementOnly = r => r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && r.other_findings.length &&
  r.verdict_reasons.length > 0 && r.verdict_reasons.every(x => /model_rule_disagreement/.test(x))
const SEC = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR'] }, blocking: FINDINGS, note: { type: 'string' }, blocked: { type: 'boolean' } },
  required: ['verdict', 'blocking'],
}
// The security relay also reports whether codex exists here at all; the Opus stand-in uses the plain schema.
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
// The review relay copies result.json field by field, plus the head it pinned and git's list of changed paths.
const RELAY = RELAY_REVIEW({ head_sha: HEAD_SHA, changed: CHANGED })
// Only "codex not available" may fall back, and only when the repo opted in; a capped codex still stops (ERROR -> BLOCKED).
// Every review step is recorded, so an earlier Opus fallback round stays visible after a later codex PASS.
const reviewers = []
const disclose = o => ({ ...o, ...(C2 ? { contract: 2 } : {}), build_mode: BUILD_MODE, reviewers, fallback_used: reviewers.some(x => x.reviewer === FALLBACK_REVIEWER) })
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
const SUITE = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    counts: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    completed: { type: 'boolean' },
    other_failures: { type: 'array', items: { type: 'string' } },
    log_path: { type: 'string' },
    log_sha256: { type: 'string' },
    blocked: { type: 'boolean' },
    ...STATE,
  },
  required: ['passed', 'counts', 'failures', 'completed', 'other_failures', 'log_path', 'log_sha256', 'head_before', 'status_before', 'head_after', 'status_after'],
}

// Known pre-existing failures are matched in code by EXACT test id, never left to an agent's judgement, and only
// excuse a suite run that completed (no crash, timeout or collection error). A string is split on newlines only,
// because parameterized test ids can contain commas.
let KNOWN = (Array.isArray(A.known_failures) ? A.known_failures : String(A.known_failures || '').split('\n')).map(s => s.trim()).filter(Boolean)
const newFailures = s => s.failures.map(f => f.trim()).filter(f => !KNOWN.includes(f))

const target = C2 ? `the frozen canonical feature file at ${A.spec_path} (design commit ${A.design_commit}; for prose read its generated views ${A.frozen_dir}/prd.view.md and ${A.frozen_dir}/spec.view.md)`
  : A.spec_path ? `the frozen spec at ${A.spec_path}` : 'the charge below'
const chargeText = A.charge ? `\n\nCHARGE:\n${A.charge}` : ''
// contract 2: the CI failure log note, for the implementer and fixer prompts only (design 6.3); no reviewer sees it.
let ciNote = ''

// ---- contract 2: deterministic steps (design section 5) ----------------------------------------------------------
// Each is one ```gp-exec block the agent runs verbatim in the foreground, reporting stdout and exit code; the
// workflow reads the scripts' printed JSON lines and sha256sum lines from that stdout. Certifying scripts re-derive
// everything later (completion), so a relay mistake BLOCKS there at the latest.
const EXEC = { type: 'object', properties: { stdout: { type: 'string' }, exit_code: { type: 'integer' }, blocked: { type: 'boolean' }, note: { type: 'string' } }, required: ['stdout', 'exit_code'] }
const execBlock = body => '```gp-exec\n' + body + '\n```\n'
const EXEC_NOTE = 'Run the gp-exec block below verbatim with the Bash tool, in the foreground, as one call with Bash timeout 600000 ms (the maximum), and return its whole stdout verbatim in stdout and its exit code in exit_code. ' +
  'Do not run anything else, and do not fix, retry or work around a failure.\n'
// One foreground Bash call ends at 600 s at most; each frozen run inside it may take its limit plus run-frozen.js's 10 s kill
// grace. A step that cannot finish inside one call BLOCKS before it starts (a killed call would lose its record).
const ONE_CALL_S = 570
const RUN_GRACE_S = 15
const overCall = (label, seconds) => seconds > ONE_CALL_S ? `${label} can take up to ${seconds} s and cannot finish inside one foreground Bash call (600 s); shorten its frozen limit` : ''
const jsonLines = s => String(s || '').split('\n').map(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null } }).filter(Boolean)
const shaOf = (s, file) => ((String(s || '').split('\n').map(l => /^([0-9a-f]{64}) [ *](.+)$/.exec(l)).find(m => m && m[2] === file)) || [])[1]
const HEX64 = /^[0-9a-f]{64}$/
const SCRIPT = name => q(`${V2_SCRIPTS}/${name}`)
const writeJsonBlock = (file, value) => `node ${SCRIPT('write-json.js')} --out ${q(file)} <<'GP_JSON'\n${JSON.stringify(value)}\nGP_JSON`
const crash = code => [124, 126, 127].includes(code) || code >= 128
let PRE = null // the --mode design output (the preflight record), contract 2
let SUITE_M = null // the manifest suite, contract 2
let CI_LOG = null // { path, sha256 } of ci_failure_log_path, contract 2
let PLAN_IDENTITY = null
const reviewFiles = []
// Review files (design 6.3): one entry per round of each review step, every path and hash printed by a script. The Opus
// fallback hashes its inputs before reviewing (hash-inputs.js --out) and again after (--verify, in the record block), and
// its structured reply is written verbatim by write-json.js; a raw codex file is hashed by sha256sum in the cleanup block.
const fbInputs = dir => (C2 ? [`node ${SCRIPT('hash-inputs.js')} --out ${q(dir + '/inputs.json')} --files ${q(dir + '/change.patch')} >/dev/null`] : [])
const rawHash = file => (C2 ? [`sha256sum ${q(file)} 2>&1 || true`] : [])
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
// rawName: the raw codex file of a security/compliance step; without it the step is an implementation review (result.json).
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
  phase('Preflight')
  const prePath = `${A.run_dir}/design-preflight.json`
  const ciLog = A.ci_failure_log_path
  const printSuite = `node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=m.suite;` +
    `console.log(JSON.stringify({gp_suite:{command:s.command,known_failure_ids:s.known_failures.map(k=>k.test_id),isolated:s.isolated,setup_command:s.setup_command,timeout_min:s.timeout_min}}))' ${q(A.manifest_path)}`
  const pre = await agent(
    `Preflight of the design-gated build of feature ${A.feature_id}, BEFORE anything changes: the frozen plan's design identity (check-completion.js --mode design writes it to ${prePath}), ` +
    `the design commit as an ancestor of HEAD${ciLog ? ', and the hash of the CI failure log' : ''}. ${EXEC_NOTE}` +
    execBlock([
      'set -e',
      ...freshRunDir(A.run_dir),
      `node ${SCRIPT('check-completion.js')} --mode design --repo ${q(A.repo)} --feature-id ${q(A.feature_id)} --frozen-dir ${q(A.frozen_dir)} --manifest-sha256 ${A.manifest_sha256} ` +
        `--spec ${q(A.spec_path)} --commit ${A.design_commit} --approvals ${q(A.approvals_path)} --approvals-sha256 ${A.approvals_sha256} --out ${q(prePath)} 2>&1`,
      `git -C ${q(A.repo)} merge-base --is-ancestor ${A.design_commit} HEAD || { echo GP_DESIGN_NOT_ANCESTOR; exit 5; }`,
      `sha256sum ${q(prePath)}`,
      printSuite,
      ...(ciLog ? [`case "$(realpath ${q(ciLog)})/" in "$(realpath ${q(A.repo)})"/*) echo GP_CI_LOG_IN_REPO; exit 6;; esac`,
        `node ${SCRIPT('hash-inputs.js')} --out ${q(A.run_dir + '/ci-failure-log.inputs.json')} ${q(ciLog)}`] : []),
    ].join('\n')) + `\n- ${RULES}`,
    { label: 'design preflight', phase: 'Preflight', schema: EXEC, effort: 'low' })
  if (!pre || pre.blocked || pre.exit_code !== 0) {
    const code = pre && runDirCode(pre.stdout)
    return disclose({ status: 'BLOCKED', stage: 'preflight', ...(code ? { code } : {}),
      reason: code === 'E_RUN_DIR_EXISTS' ? 'run_dir already exists (GP_RUN_DIR_EXISTS): every build run needs a fresh run_dir; nothing was changed'
        : code ? `run_dir ${A.run_dir} could not be created: nothing was changed` : 'the design preflight failed: nothing was changed', preflight: pre })
  }
  const lines = jsonLines(pre.stdout)
  const d = lines.find(o => o.mode === 'design')
  const preSha = shaOf(pre.stdout, prePath)
  const s = (lines.find(o => o.gp_suite) || {}).gp_suite
  const hi = lines.find(o => Array.isArray(o.inputs))
  const bad = !d ? 'no --mode design output' : d.status !== 'PASS' ? 'the design preflight did not PASS'
    : d.design_commit !== A.design_commit || d.manifest_sha256 !== A.manifest_sha256 || d.approvals_sha256 !== A.approvals_sha256 ? 'the preflight names another design commit, manifest or approvals ledger'
    : !d.source || !HEX64.test(d.source.sha256) || !HEX64.test(preSha || '') ? 'the preflight record or its hash is missing'
    : !s || typeof s.command !== 'string' || !s.command || JSON.stringify(s.known_failure_ids) !== JSON.stringify(d.known_failure_ids) ? 'the manifest suite is missing or differs from the preflight'
    : !Array.isArray(d.clean_ignore) || typeof d.unit_command !== 'string' || !Number.isInteger(d.live_budget_min) ? 'the preflight lacks the frozen suite configuration'
    : ciLog && !(hi && hi.inputs.length === 1 && hi.inputs[0].path === ciLog && HEX64.test(hi.inputs[0].sha256)) ? 'the CI failure log was not hashed' : ''
  if (bad) return disclose({ status: 'BLOCKED', stage: 'preflight', reason: bad, preflight: pre })
  const suiteRuns = typeof s.setup_command === 'string' ? 2 : 1
  const suiteLong = !Number.isInteger(s.timeout_min) || s.timeout_min < 1 ? 'the manifest suite has no timeout_min'
    : overCall(`the frozen suite (${suiteRuns === 2 ? 'setup and suite, ' : ''}${suiteRuns} x timeout_min ${s.timeout_min})`, suiteRuns * (s.timeout_min * 60 + RUN_GRACE_S))
  if (suiteLong) return disclose({ status: 'BLOCKED', stage: 'preflight', reason: suiteLong, preflight: pre })
  PRE = d
  SUITE_M = s
  KNOWN = d.known_failure_ids.slice()
  CI_LOG = ciLog ? { path: ciLog, sha256: hi.inputs[0].sha256 } : null
  PLAN_IDENTITY = { design_commit: A.design_commit, source_sha256: d.source.sha256, manifest_sha256: d.manifest_sha256, approvals_sha256: d.approvals_sha256, preflight_path: prePath, preflight_sha256: preSha }
  RULES = rulesFor(d.live_budget_min, NOEXEC)
  // The CI failure log is context for the implementer and fixer only; it certifies nothing (design 6.3).
  if (CI_LOG) ciNote = `\n\nCI failure log: context only; the frozen canonical file is the only authority. It is ${CI_LOG.path} (sha256 ${CI_LOG.sha256}); ` +
    'read it to find what failed. It never changes a command, a known failure or the scope.'
}
// A restart (after HEAD_MOVED or CI_RED) must pass the feature's ORIGINAL base_commit, so commits that arrived since the
// last review fall inside the reviewed range instead of becoming the new base.
if (A.base_commit !== undefined && !/^[0-9a-f]{7,40}$/.test(A.base_commit)) return { status: 'BLOCKED', reason: 'base_commit must be a hex commit id' }
const workReport = A.base_commit
  ? `The feature's base_commit is fixed at ${A.base_commit}; report exactly that. In files_changed list repo-relative paths that still exist; list removed files in files_deleted.`
  : 'Before changing anything, record `git rev-parse HEAD` as base_commit (keep the first value across rounds). In files_changed list repo-relative paths that still exist; list removed files in files_deleted.'

phase('Implement')
const work = await agent(
  `You are the implementer for feature ${A.feature_id}. Implement ${target}.${chargeText}${ciNote}\n\n` +
  `Work test-first: for each behavioral acceptance item write the test, run it and see it FAIL, implement, run it and see it PASS. Static-only items use the frozen spec's applicable static evidence. ` +
  `Run the focused tests with: ${(C2 ? PRE.unit_command : A.unit_cmd) || '(the repo\'s focused test command)'}. Keep the change minimal and in the repo's style. ` +
  `Commit on ${A.work_branch} and push the branch. Save the red and green outputs under ${A.run_dir}/implement/. ${workReport}\n\nRules:\n- ${RULES}`,
  { label: 'implement', phase: 'Implement', schema: WORK, effort: IMPL_EFFORT })
if (!work || work.blocked) return disclose({ status: 'BLOCKED', stage: 'implement', reason: work ? work.blocked_reason : 'implementer died' })

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
function scopePrep(dir) {
  return [
    `H=$(git -C ${q(A.repo)} rev-parse HEAD)`, 'echo "head_sha: $H"',
    `git -C ${q(A.repo)} diff --binary --no-renames ${base} "$H" > ${q(dir + '/change.patch')}`,
    `git -C ${q(A.repo)} worktree add --detach ${q(dir + '/wt')} ${base}`,
    `git -C ${q(dir + '/wt')} apply --index ${q(dir + '/change.patch')}`,
    'echo "changed:"', `git -C ${q(A.repo)} diff --name-status --no-renames ${base} "$H"`,
  ].join('\n')
}
const scopeNote = dir => 'Report head_sha (the head_sha: line setup printed; it pins the head, and every later step uses it, never HEAD) and changed ' +
  `(every line setup printed after changed:, a status letter and a repo-relative path). The checkout ${dir}/wt holds the whole change ${base}..head_sha as uncommitted edits.\n`

async function review(round) {
  const out = `${A.run_dir}/review-${round}`
  const fb = out + '-opus'
  const cmd = `node ${q(A.review_runner)} --kind implementation --uncommitted --repo ${q(out + '/wt')} --out-dir ${q(out)}` +
    `${A.codex_model ? ` --model ${q(A.codex_model)}` : ''} --effort ${A.codex_effort || 'high'} --timeout-seconds ${TIMEOUT_S}`
  let raw = null
  const res = await reviewed(`review ${round}`, r => gateCodex('implementation', r), () => agent(
    `Run an independent codex implementation review of the CHANGE and report its verdict. Do not review the code yourself.\n` +
    relaySteps({ setup: ['set -e', gpProbe(true), gpFresh(out), scopePrep(out)].join('\n'), start: gpStart(cmd, out),
      poll: gpPoll(`${q(out)}/implementation-*/result.json`), cleanup: [gpStop(out), gpUnwt(out + '/wt'), gpList(out, 'implementation')].join('\n'),
      minutes: Math.ceil(TIMEOUT_S * 6 / 60) + 5 }) +
    `${scopeNote(out)}${relayRead(out, 'implementation')}\n- ${RULES}`,
    { label: `codex review ${round}`, phase: 'Review', schema: RELAY, effort: 'low' }),
  () => agent(
    `Codex is not available in this environment, so YOU are the independent implementation reviewer of the CHANGE in its place (the repo config chose review_fallback: opus-high). ` +
    `Do not change the work branch.\n${fallbackSteps(['set -e', gpFresh(fb), scopePrep(fb), ...fbInputs(fb)].join('\n'), [gpUnwt(fb + '/wt'), gpList(fb)].join('\n'))}${scopeNote(fb)}` +
    `Review the change as it stands in that checkout (git -C ${q(fb + '/wt')} diff --cached is the whole change ${base}..head_sha; read any other file there for context) for correctness bugs, ` +
    `missing or broken acceptance behaviour from ${target}, and unsafe code. Report findings ONLY in that change. ` +
    `${parityNote('implementation')}${chargeText}\n- ${RULES}`,
    { label: `opus review ${round} (codex unavailable)`, phase: 'Review', schema: PARITY_SCHEMA({ head_sha: HEAD_SHA, changed: CHANGED }), model: 'opus', effort: 'high' }).then(f => { raw = f; return gateFallback('implementation', f) }))
  return C2 ? reviewFile({ step: 'implementation', round, out, fb, res, raw, ph: 'Review', label: `review ${round}` }) : res
}

// The repo's own security docs and checklist come first; the task text is quoted into prompt.md, so it holds no double quotes.
const secTask = () => (SEC_READ.length ? `First read the repository security docs and OWASP checklist: ${SEC_READ.join(', ')}. Apply that checklist, and check its threat-model premises and accepted risks against the code instead of assuming them. ` : '') +
  'Security review (OWASP Top 10 and OWASP API Security Top 10, including API1/API3/API5 object, property and function level authorization and API4 unrestricted resource consumption; ' +
  'secrets, injection, authz, unsafe deserialization, SSRF, path traversal, logging of sensitive data) ' +
  `of the change ${base}..${reviewedSha} in this repository (all of it: git diff ${base} ${reviewedSha}). Read any other file you need for context, but report findings ONLY in that change. ` +
  'Client-side controls are not security controls: debounce, throttle, hidden or disabled UI and client-side validation do not count; every new endpoint or expensive operation needs server-side authorization, input validation and a bound (rate limit, result cap or size limit). ' +
  'Accepted risks elsewhere in the threat model can widen the attack surface of new endpoints: for example, content that runs same-origin can call a new endpoint with the credentials of the signed-in user, so judge each new endpoint as reachable by it. ' +
  'Quote the code for every finding. verdict FAIL if any critical or high finding exists, else PASS.'
async function security(round) {
  const out = `${A.run_dir}/security-${round}`
  const fb = out + '-opus'
  const isolate = dir => `git -C ${q(A.repo)} worktree add --detach ${q(dir + '/wt')} ${reviewedSha}`
  const cmd = `timeout --kill-after=60 1800 codex exec${A.codex_model ? ` -m ${q(A.codex_model)}` : ''} -c model_reasoning_effort=${A.codex_effort || 'high'} -s read-only -C ${q(out + '/wt')} --output-schema ${q(A.security_schema)} -o ${q(out + '/security.json')} - < ${q(out + '/prompt.md')}`
  let raw = null
  const res = await reviewed(`security ${round}`, r => r, () => agent(
    `Run an independent codex SECURITY review of the change and report its verdict. Do not review the code yourself. ` +
    `Every file codex reads is the reviewed commit's: setup makes an isolated checkout of it at ${out}/wt, and cleanup removes exactly that checkout.\n` +
    `1. The setup block writes ${out}/prompt.md containing: "${secTask()}"\n` +
    `2. Run under a HARD process timeout so codex can never outlive this step (the start block); if the timeout fires the process is already killed: report ERROR. ` +
    relaySteps({ setup: ['set -e', gpProbe(false), gpFresh(out), isolate(out), `cat > ${q(out + '/prompt.md')} <<'GP_TASK'`, secTask(), 'GP_TASK'].join('\n'),
      start: gpStart(cmd, out), poll: gpPoll(q(out + '/security.json')), cleanup: [gpStop(out), gpUnwt(out + '/wt'), gpList(out), ...rawHash(out + '/security.json')].join('\n'), minutes: 32 }) +
    `3. After cleanup, read ${out}/security.json and return verdict and ONLY the critical/high findings as blocking. If codex errors, hits a usage cap, or writes no valid JSON, return ERROR with the reason in note.${C2 ? RAW_NOTE('security.json') : ''}\n- ${RULES}`,
    { label: `codex security ${round}`, phase: 'Review', schema: C2 ? RAW_RELAY(SEC) : relay(SEC), effort: 'low' }),
  () => agent(
    `Codex is not available in this environment, so YOU are the independent SECURITY reviewer in its place (the repo config chose review_fallback: opus-high). Do not change any file.\n` +
    fallbackSteps(['set -e', gpFresh(fb), isolate(fb)].join('\n'), [gpUnwt(fb + '/wt'), gpList(fb)].join('\n')) +
    `Review in the isolated checkout of the reviewed commit at ${fb}/wt.\n` +
    `1. ${secTask()}\n2. Return verdict and ONLY the critical/high findings as blocking.${C2 ? ' Give each blocking finding its severity in lower case: critical or high.' : ''}\n- ${RULES}`,
    { label: `opus security ${round} (codex unavailable)`, phase: 'Review', schema: SEC, model: 'opus', effort: 'high' }).then(f => { raw = f; return f }))
  return C2 ? reviewFile({ step: 'security', round, out, fb, res, raw, ph: 'Review', label: `security ${round}`, rawName: 'security.json' }) : res
}

// contract 2 suite (design 6.3): run-frozen.js --target suite runs exactly the manifest's suite (and its setup) on the pinned,
// clean reviewed commit. completed and passed are derived from the record, never relayed; the agent reads only the
// failing test ids and the non-test failures from the framed log. PASS needs no other failure, no timeout, setup exit 0
// when set, and either exit 0 with no failing id, or a nonzero non-crash exit whose failing ids are all (at least one)
// manifest known-failure ids. Anything else is a fix round.
async function suiteV2(round) {
  const out = `${A.run_dir}/suite-${round}`
  const rec = `${out}/suite.record.json`
  const rep = await agent(
    `Run the full test suite of feature ${A.feature_id} as the LAST step, on the reviewed commit ${reviewedSha}, through run-frozen.js: it runs exactly the frozen manifest's suite ` +
    `command (never type a suite command yourself) and writes a framed log and a record. ${EXEC_NOTE}` +
    execBlock(['set -e', `node ${SCRIPT('run-frozen.js')} --repo ${q(A.repo)} --frozen-dir ${q(A.frozen_dir)} --manifest-sha256 ${A.manifest_sha256} --reviewed-sha ${reviewedSha} --target suite --out-dir ${q(out)} 2>&1`,
      `tr -d '\\n' < ${q(rec)}; echo`].join('\n')) +
    `Then read the log file named by log_path in the record line (the last line of stdout) and report in failures each failing test id exactly as the runner prints it, ` +
    'and in other_failures every failure that is not a test (coverage threshold, lint/type step, post-test command, a non-zero exit not explained by a listed test). Report only what the log shows.\n- ' + RULES,
    { label: `suite ${round}`, phase: 'Suite', effort: 'low', schema: { ...EXEC, properties: { ...EXEC.properties, failures: { type: 'array', items: { type: 'string' } }, other_failures: { type: 'array', items: { type: 'string' } } },
      required: [...EXEC.required, 'failures', 'other_failures'] } })
  if (!rep || rep.blocked) return { blocked: true, reason: 'the suite step was blocked', report: rep }
  if (rep.exit_code !== 0) return { blocked: true, reason: 'run-frozen.js refused or the checkout moved or got dirty during the suite', report: rep }
  const lines = jsonLines(rep.stdout)
  const printed = lines.find(o => o.record_path === rec)
  const record = lines.find(o => o.target === 'suite' && o.log_path)
  if (!printed || !record || !HEX64.test(printed.record_sha256 || '') || record.exit_code !== printed.exit_code || record.head_before !== reviewedSha || record.head_after !== reviewedSha) {
    return { blocked: true, reason: 'the suite record was not printed for the reviewed commit', report: rep }
  }
  const failures = rep.failures.map(f => f.trim()).filter(Boolean)
  const exit = record.exit_code
  const setupOk = SUITE_M.setup_command === null ? record.setup === null : !!record.setup && record.setup.exit_code === 0 && record.setup.timed_out === false
  const completed = record.timed_out === false && setupOk && Number.isInteger(exit) && !crash(exit)
  const ok = completed && !rep.other_failures.length && ((exit === 0 && !failures.length) || (exit !== 0 && failures.length > 0 && failures.every(f => KNOWN.includes(f))))
  return { ok, completed, passed: exit === 0, counts: `exit ${exit}${record.timed_out ? ', timed out' : ''}${record.setup ? `, setup exit ${record.setup.exit_code}` : ''}`,
    failures, other_failures: rep.other_failures.slice(), log_path: record.log_path, log_sha256: record.log_sha256,
    head_before: record.head_before, status_before: record.status_before, head_after: record.head_after, status_after: record.status_after,
    record_path: printed.record_path, record_sha256: printed.record_sha256, exit_code: exit, timed_out: record.timed_out, setup_exit_code: printed.setup_exit_code }
}

let verdict = null
let lastSuite = null
let lastSec = null
let reviewedSha = ''
for (let round = 1; round <= MAX + 1; round++) {
  if (unsafe().length) return disclose({ status: 'BLOCKED', stage: 'review', reason: 'file names must be repo-relative and safe: ' + unsafe().join(', '), history })
  const r = await review(round)
  if (!r || r.blocked || r.verdict === 'ERROR' || (r.verdict === 'NEEDS_HUMAN' && !r.confirmed_findings.length && !disagreementOnly(r))) return disclose({ status: 'BLOCKED', stage: 'review', round, review: r, history })
  if (!/^[0-9a-f]{40}$/.test(r.head_sha)) return disclose({ status: 'BLOCKED', stage: 'review', round, reason: 'review did not report a 40-hex head_sha', review: r, history })
  if (!r.changed.length) return disclose({ status: 'BLOCKED', stage: 'review', round, reason: `git shows no change between ${base} and ${r.head_sha}`, review: r, history })
  // git's list is authoritative: report what the agents left out, then adopt it.
  const gitPaths = r.changed.map(c => c.path)
  const unreported = gitPaths.filter(p => !files.has(p) && !deleted.has(p))
  if (unreported.length) log(`round ${round}: ${unreported.length} changed path(s) the agents did not report: ${unreported.join(', ')}`)
  files.clear(); deleted.clear()
  r.changed.forEach(c => (c.status.startsWith('D') ? deleted : files).add(c.path))
  if (unsafe().length) return disclose({ status: 'BLOCKED', stage: 'review', reason: 'changed paths must be repo-relative and safe: ' + unsafe().join(', '), history })
  reviewedSha = r.head_sha
  if (r.verdict === 'PASS' && r.confirmed_findings.length) r.verdict = 'FAIL'
  verdict = r
  let sec = null
  let suite = null
  if (r.verdict === 'PASS' && A.security_schema) {
    sec = await security(round)
    lastSec = sec
    if (!sec || sec.blocked || sec.verdict === 'ERROR') return disclose({ status: 'BLOCKED', stage: 'security', round, security: sec, history })
    // Findings decide, not the self-reported verdict: any blocking finding is a FAIL.
    if (sec.blocking.length) sec.verdict = 'FAIL'
    if (sec.verdict === 'FAIL') log(`security pass failed in round ${round}: ${sec.blocking.length} high/critical`)
  }
  if (C2 && r.verdict === 'PASS' && (!sec || sec.verdict === 'PASS')) {
    phase('Suite')
    suite = await suiteV2(round)
    if (!suite || suite.blocked) return disclose({ status: 'BLOCKED', stage: 'suite', reason: suite ? suite.reason : 'the suite step died', suite, history })
    lastSuite = suite
    if (suite.ok) {
      const { ok, ...shown } = suite
      return disclose({ status: 'PASS', feature_id: A.feature_id, rounds: round, reviewed_sha: reviewedSha, review: r, security: sec, suite: shown, known_failures_seen: suite.failures.slice(),
        base_commit: base, files: [...files], deleted: [...deleted], history, plan_identity: PLAN_IDENTITY,
        suite_identity: { command: SUITE_M.command, known_failure_ids: SUITE_M.known_failure_ids, isolated: SUITE_M.isolated, setup_command: SUITE_M.setup_command, timeout_min: SUITE_M.timeout_min,
          record_path: suite.record_path, record_sha256: suite.record_sha256 },
        review_files: reviewFiles.slice(), ci_failure_log: CI_LOG, repo_config: { lock_note: A.lock_note || null } })
    }
    log(`suite failed in round ${round}: ${suite.counts}${suite.completed ? '' : ' (run did not complete)'}`)
  } else if (r.verdict === 'PASS' && (!sec || sec.verdict === 'PASS')) {
    phase('Suite')
    const swt = `${A.run_dir}/suite-${round}/wt`
    const where = A.suite_isolated
      ? `in an isolated checkout of the reviewed commit: git -C ${q(A.repo)} worktree add --detach ${q(swt)} ${reviewedSha}, then in ${swt} ` +
        `${A.isolated_setup ? `run the setup command (${A.isolated_setup}), then ` : ''}run the suite there. After the run, remove exactly that checkout: git -C ${q(A.repo)} worktree remove --force ${q(swt)}. `
      : `in ${A.repo} on branch ${A.work_branch}. `
    suite = await agent(
      `Run the full test suite as the LAST step, ${where}Suite command: ${A.suite_cmd}\n` +
      `Save the full output to ${A.run_dir}/suite-${round}.txt; return log_path and SHA256 of those exact saved bytes as log_sha256. Report the observed counts, each failing test id exactly as the runner prints it, and in other_failures every failure that is not a test (coverage threshold, lint/type step, post-test command, a non-zero exit not explained by a listed test). ` +
      `${stateNoteAt(A.suite_isolated ? swt : A.repo)}${A.suite_isolated ? ' (the "before" state is taken after the setup command, the "after" state before removing the checkout)' : ''} ` +
      `completed=true ONLY if the whole suite ran to the end; a crash, timeout, collection/import error or interrupted run is completed=false.\n- ${RULES}`,
      { label: `suite ${round}`, phase: 'Suite', schema: SUITE, effort: 'low' })
    if (!suite || suite.blocked) return disclose({ status: 'BLOCKED', stage: 'suite', suite, history })
    lastSuite = suite
    const drift = pinned(suite, reviewedSha)
    if (drift.length) return disclose({ status: 'BLOCKED', stage: 'suite', reason: 'the suite did not run on the clean reviewed commit: ' + drift.join('; '), suite, history })
    // Accept only a completed run with no failure outside the known baseline ids (exact match), and never a report that
    // claims failure without naming it. Known failures are reported, never sent to the fixer.
    const fresh = newFailures(suite)
    if (suite.completed && !fresh.length && !suite.other_failures.length && (suite.passed || suite.failures.length)) return disclose({ status: 'PASS', feature_id: A.feature_id, rounds: round, reviewed_sha: reviewedSha, review: r, security: sec, suite, known_failures_seen: suite.failures.filter(f => !fresh.includes(f.trim())), base_commit: base, files: [...files], deleted: [...deleted], history })
    log(`suite failed in round ${round}: ${suite.counts}${suite.completed ? '' : ' (run did not complete)'}`)
  }
  if (round > MAX) break
  phase('Fix')
  const items = [
    ...(r.verdict !== 'PASS' ? (r.confirmed_findings.length ? r.confirmed_findings : r.other_findings).map(f => gateItem(r.reviewer, f)) : []),
    ...(sec && sec.verdict === 'FAIL' ? sec.blocking.map(f => `[security ${sec.reviewer} ${f.severity}] ${f.location || ''} ${f.title}: ${f.detail || ''}`) : []),
    ...(suite ? newFailures(suite).map(f => `[suite] ${f}`) : []),
    ...(suite ? suite.other_failures.map(f => `[suite, not a test] ${f}`) : []),
    ...(suite && !suite.completed ? [`[suite] the full suite did not run to completion (${suite.counts}); see ${C2 ? suite.log_path : `${A.run_dir}/suite-${round}.txt`}`] : []),
  ]
  if (!items.length) items.push(`[suite] the suite failed without naming a test (${suite ? suite.counts : 'no result'}); see ${C2 && suite ? suite.log_path : `${A.run_dir}/suite-${round}.txt`}`)
  const fix = await agent(
    `You are fixing feature ${A.feature_id} on ${A.work_branch} (implemented against ${target}).${chargeText}${ciNote}\n` +
    `Fix each item below for real. If an item is wrong, say why in summary instead of changing code for it. Add or adjust tests test-first. Commit and push. ${workReport}\nITEMS:\n${items.join('\n')}\n\nRules:\n- ${RULES}`,
    { label: `fix ${round}`, phase: 'Fix', schema: WORK, effort: IMPL_EFFORT })
  if (!fix || fix.blocked) return disclose({ status: 'BLOCKED', stage: 'fix', round, reason: fix ? fix.blocked_reason : 'fixer died', history })
  track(fix)
  history.push({ round, findings: items, fix })
}
return disclose({ status: 'FAIL', feature_id: A.feature_id, reason: `not clean after ${MAX} fix rounds`, reviewed_sha: reviewedSha, review: verdict, security: lastSec, suite: lastSuite, base_commit: base, files: [...files], deleted: [...deleted], history,
  ...(C2 ? { plan_identity: PLAN_IDENTITY, review_files: reviewFiles.slice(), ci_failure_log: CI_LOG } : {}) })
