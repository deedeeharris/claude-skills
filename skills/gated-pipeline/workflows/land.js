export const meta = {
  name: 'gated-land',
  description: 'Open the PR from the work branch to the trunk, watch CI, stop for the human merge',
  whenToUse: 'Stage 4 of the gated-pipeline skill, after build and mandatory verify returned PASS',
  phases: [
    { title: 'Completion', detail: 'revalidate frozen inventory and actual artifacts before PR side effects' },
    { title: 'PR', detail: 'open or reuse the PR' },
    { title: 'CI', detail: 'watch checks; re-run a flaky failure once' },
  ],
}

const A = args || {}
// contract 1 (absent = 1): today's flow. contract 2 (docs/v2-design.md 6.5, 6.6): unchanged gates; completion revalidation
// also gets the frozen dir, the approvals ledger and --trunk-ref origin/<trunk_branch> (after git fetch), and the written
// proof must carry a trunk qualification.
if (A.contract !== undefined && A.contract !== 1 && A.contract !== 2) return { status: 'BLOCKED', reason: 'contract must be 1 or 2' }
const C2 = A.contract === 2
const FORBIDDEN_V2 = ['checks', 'clean_ignore', 'state_paths', 'suite_cmd', 'unit_cmd', 'known_failures', 'isolated_setup', 'suite_isolated', 'live_budget_min']
if (C2) {
  const forbidden = FORBIDDEN_V2.filter(k => A[k] !== undefined)
  if (forbidden.length) return { status: 'BLOCKED', stage: 'args', reason: `contract 2 does not take ${forbidden.join(', ')}: the frozen manifest is their only source` }
} else {
  const v2only = ['frozen_dir', 'approvals_path', 'approvals_sha256'].filter(k => A[k] !== undefined)
  if (v2only.length) return { status: 'BLOCKED', stage: 'args', reason: `${v2only.join(', ')} need contract: 2` }
}
const need = ['feature_id', 'repo', 'work_branch', 'trunk_branch', 'title', 'body_path', 'reviewed_sha', 'completion_runner', 'manifest_path', 'manifest_sha256', 'spec_path', 'build_result_path', 'verify_result_path', 'proof_path',
  ...(C2 ? ['frozen_dir', 'approvals_path', 'approvals_sha256'] : [])]
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
// Everything below goes into shell commands single-quoted, so it may not contain quotes, $, backticks or backslash-escapes.
const SAFE_PATH = /^[A-Za-z0-9._\/\\: +@-]+$/
const SAFE_REF = /^[A-Za-z0-9._\/-]+$/
const SAFE_TEXT = /^[A-Za-z0-9 ._,:;()#\/+@-]+$/
if (![A.repo, A.body_path, A.completion_runner, A.manifest_path, A.spec_path, A.build_result_path, A.verify_result_path, A.proof_path].every(p => SAFE_PATH.test(p) && /^([A-Za-z]:[\/\\]|\/)/.test(p))) return { status: 'BLOCKED', reason: 'all path args must be absolute paths of safe characters' }
if (!/^[0-9a-f]{64}$/.test(A.manifest_sha256)) return { status: 'BLOCKED', reason: 'manifest_sha256 must be the frozen 64-hex design hash' }
if (!/^[A-Za-z0-9._-]+$/.test(A.feature_id)) return { status: 'BLOCKED', reason: 'feature_id must match [A-Za-z0-9._-]' }
if (!SAFE_REF.test(A.work_branch) || !SAFE_REF.test(A.trunk_branch)) return { status: 'BLOCKED', reason: 'branch names must match [A-Za-z0-9._/-]' }
if (!SAFE_TEXT.test(A.title)) return { status: 'BLOCKED', reason: 'title may only use letters, digits, spaces and ._,:;()#/+@-' }
if (A.ci_wait_min !== undefined && !(Number.isInteger(A.ci_wait_min) && A.ci_wait_min > 0)) return { status: 'BLOCKED', reason: 'ci_wait_min must be a positive integer' }
if (!/^[0-9a-f]{40}$/.test(A.reviewed_sha)) return { status: 'BLOCKED', reason: 'reviewed_sha must be a full 40-hex commit id' }
// Absolute, normalized (no //, /./, .. or trailing slash), so a path the scripts print compares equal by spelling.
const CANON = p => typeof p === 'string' && SAFE_PATH.test(p) && /^\//.test(p) && !/\/\/|\/\.(\/|$)|\/\.\.(\/|$)|.\/$|\\/.test(p)
if (C2) {
  for (const k of ['repo', 'completion_runner', 'manifest_path', 'spec_path', 'build_result_path', 'verify_result_path', 'proof_path', 'frozen_dir', 'approvals_path']) {
    if (!CANON(A[k])) return { status: 'BLOCKED', stage: 'args', reason: `${k} must be a normalized absolute POSIX path of safe characters: ${A[k]}` }
  }
  if (!/\/check-completion\.js$/.test(A.completion_runner)) return { status: 'BLOCKED', stage: 'args', reason: 'completion_runner must be the skill\'s scripts/check-completion.js' }
  if (A.manifest_path !== A.frozen_dir + '/execution-plan.json') return { status: 'BLOCKED', stage: 'args', reason: 'manifest_path must be <frozen_dir>/execution-plan.json' }
  if (!/^[0-9a-f]{64}$/.test(A.approvals_sha256)) return { status: 'BLOCKED', stage: 'args', reason: 'approvals_sha256 must be a 64-hex hash' }
  if (A.allow_no_ci !== undefined && typeof A.allow_no_ci !== 'boolean') return { status: 'BLOCKED', stage: 'args', reason: 'allow_no_ci must be true or false' }
}
// git reports forward-slash paths, so state prefixes are normalized to that form before comparing.
const normalizeState = paths => paths.map(p => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')).sort()
const q = s => `'${s}'`
// The validator reports Windows paths with backslashes; compare by form, not by spelling.
const pathForm = p => p.replace(/\\/g, '/').replace(/^[a-z]:/, d => d.toUpperCase())
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && pathForm(a) === pathForm(b)

const RULES = [
  `Repo: ${A.repo}. NEVER merge the PR, never enable auto-merge, never push or force-push ${A.trunk_branch}, never push ${A.work_branch} with --force.`,
  'Never trigger deploy workflows or workflow_dispatch runs. Re-running a failed check is the only CI action allowed.',
  'If any command is blocked, or a tool or the API refuses, STOP and report blocked=true. Never reproduce its effect another way.',
].join('\n- ')

phase('Completion')
// contract 2: one gp-exec block (run verbatim, stdout and exit code reported); the workflow reads the validator's JSON line.
const EXEC = { type: 'object', properties: { stdout: { type: 'string' }, exit_code: { type: 'integer' }, blocked: { type: 'boolean' }, note: { type: 'string' } }, required: ['stdout', 'exit_code'] }
const jsonLines = s => String(s || '').split('\n').map(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null } }).filter(Boolean)
async function completionV2() {
  const r = await agent(
    `Revalidate completion before opening or reusing any PR: fetch the trunk, then run the real validator with the trunk qualification. A previous PASS or an existing proof file is insufficient. ` +
    'Run the gp-exec block below verbatim with the Bash tool, in the foreground, as one call, and return its whole stdout verbatim in stdout and its exit code in exit_code. ' +
    'Do not run anything else, and do not fix, retry or work around a failure. Do not open a PR in this step.\n' +
    '```gp-exec\n' + ['set -e', `git -C ${q(A.repo)} fetch origin ${q(A.trunk_branch)} 2>&1`,
      `node ${q(A.completion_runner)} --repo ${q(A.repo)} --feature-id ${q(A.feature_id)} --reviewed-sha ${A.reviewed_sha} --manifest ${q(A.manifest_path)} --manifest-sha256 ${A.manifest_sha256} ` +
      `--spec ${q(A.spec_path)} --build-result ${q(A.build_result_path)} --verify-result ${q(A.verify_result_path)} --previous-proof ${q(A.proof_path)} --out ${q(A.proof_path)} ` +
      `--frozen-dir ${q(A.frozen_dir)} --approvals ${q(A.approvals_path)} --approvals-sha256 ${A.approvals_sha256} --trunk-ref ${q('origin/' + A.trunk_branch)} 2>&1`].join('\n') + '\n```\n' +
    `\n- ${RULES}`,
    { label: 'completion proof', phase: 'Completion', effort: 'low', schema: EXEC })
  if (!r || r.blocked) return { blocked: true, passed: false, run: r }
  const lines = jsonLines(r.stdout)
  const ok = r.exit_code === 0 ? lines.find(o => o.status === 'PASS' && o.proof_path) : null
  const failed = lines.find(o => o.status === 'BLOCKED')
  if (!ok) return { passed: false, ...(failed ? { code: failed.code, reason: failed.reason } : { reason: 'the validator did not run' }), run: r }
  const tq = ok.trunk_qualification
  if (ok.contract !== 2 || ok.certification !== 'design-gated' || !tq || typeof tq !== 'object' || tq.pre_design_range_empty !== true || tq.ref !== 'origin/' + A.trunk_branch) {
    return { passed: false, reason: 'the written proof is not a contract-2 design-gated proof with a trunk qualification', ...ok, run: r }
  }
  return { ...ok, passed: true }
}
const completion = C2 ? await completionV2() : await agent(
  `Revalidate completion before opening or reusing any PR. Run exactly:\n` +
  `node ${q(A.completion_runner)} --repo ${q(A.repo)} --feature-id ${q(A.feature_id)} --reviewed-sha ${A.reviewed_sha} ` +
  `--manifest ${q(A.manifest_path)} --manifest-sha256 ${A.manifest_sha256} --spec ${q(A.spec_path)} ` +
  `--build-result ${q(A.build_result_path)} --verify-result ${q(A.verify_result_path)} --previous-proof ${q(A.proof_path)} --out ${q(A.proof_path)}\n` +
  `Report passed=true only on exit 0 with a written proof; copy proof_path, reviewed_sha, manifest_sha256 and frozen state_paths from output. ` +
  `A previous PASS or an existing proof file is insufficient. Do not open a PR if validation fails.\n- ${RULES}`,
  { label: 'completion proof', phase: 'Completion', effort: 'low', schema: {
    type: 'object', properties: { passed: { type: 'boolean' }, blocked: { type: 'boolean' }, reason: { type: 'string' }, proof_path: { type: 'string' }, reviewed_sha: { type: 'string' }, manifest_sha256: { type: 'string' }, state_paths: { type: 'array', items: { type: 'string' } } },
    required: ['passed', 'proof_path', 'reviewed_sha', 'manifest_sha256', 'state_paths'],
  } })
// contract 2: land's result carries the certification and echoes the review disclosure and allow_no_ci (design 6.5, 6.6).
const tagged = o => (C2 ? { ...o, contract: 2 } : o)
const certified = o => (C2 ? { ...o, contract: 2, certification: 'design-gated', cross_family: completion && completion.cross_family === true, fallback_used: completion ? completion.fallback_used !== false : true, allow_no_ci: A.allow_no_ci === true } : o)
if (!completion || completion.blocked || !completion.passed || !samePath(completion.proof_path, A.proof_path) || completion.reviewed_sha !== A.reviewed_sha || completion.manifest_sha256 !== A.manifest_sha256) return tagged({ status: 'BLOCKED', stage: 'completion', completion })
if (!Array.isArray(completion.state_paths) || completion.state_paths.some(p => typeof p !== 'string' || !SAFE_PATH.test(p))) return tagged({ status: 'BLOCKED', stage: 'completion', reason: 'validator did not return frozen state paths', completion })
const statePaths = normalizeState(completion.state_paths)
if (A.state_paths !== undefined && (!Array.isArray(A.state_paths) || A.state_paths.some(p => typeof p !== 'string' || !SAFE_PATH.test(p)) || JSON.stringify(normalizeState(A.state_paths)) !== JSON.stringify(statePaths))) return tagged({ status: 'BLOCKED', stage: 'completion', reason: 'state_paths differs from the frozen plan', completion })

const HEAD = {
  head_sha: { type: 'string' },
  reviewed_is_ancestor: { type: 'boolean' },
  files_after_review: { type: 'array', items: { type: 'string' } },
}
const headNote = `Report head_sha (the PR's current head commit: gh api repos/{owner}/{repo}/pulls/<n> --jq .head.sha), reviewed_is_ancestor (git -C ${q(A.repo)} merge-base --is-ancestor ${A.reviewed_sha} <head_sha>, after git fetch), ` +
  `and files_after_review = every path touched by ANY commit after the reviewed one (git -C ${q(A.repo)} log --name-only --no-renames --diff-merges=separate --format= ${A.reviewed_sha}..<head_sha>, de-duplicated; ` +
  `per-commit and per merge parent, so an edit made inside a merge commit shows, a file added then removed again still shows, and a rename lists both paths; empty when head_sha is ${A.reviewed_sha}).`

const PR = {
  type: 'object',
  properties: { blocked: { type: 'boolean' }, reason: { type: 'string' }, url: { type: 'string' }, number: { type: 'number' }, ...HEAD },
  required: ['blocked'],
}
const CI = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['GREEN', 'RED', 'PENDING', 'NONE'] },
    failing: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, kind: { type: 'string', enum: ['flaky', 'real', 'unknown'] }, log_excerpt: { type: 'string' } },
      required: ['name', 'kind'] } },
    rerun_done: { type: 'boolean' },
    blocked: { type: 'boolean' },
    checks_head_sha: { type: 'string' },
    ...HEAD,
  },
  required: ['state', 'failing', 'head_sha', 'checks_head_sha'],
}

// A commit after the reviewed one is acceptable only if it keeps the reviewed commit in history and touches nothing but state paths.
function unreviewed(h) {
  if (!h || !h.head_sha) return ['(head unknown)']
  if (h.head_sha === A.reviewed_sha) return []
  if (!h.reviewed_is_ancestor) return ['(reviewed commit is not an ancestor of the PR head)']
  const extra = (h.files_after_review || []).filter(f => !statePaths.some(p => f === p || f.startsWith(p.endsWith('/') ? p : p + '/')))
  return Array.isArray(h.files_after_review) ? extra : ['(files after review not reported)']
}

phase('PR')
const pr = await agent(
  `Open a pull request for feature ${A.feature_id} in ${A.repo} from ${A.work_branch} into ${A.trunk_branch} with gh, through the REST API only (run gh from ${A.repo}; gh pr list/create/view/checks use GraphQL, which some hosts refuse). ` +
  `First check: gh api "repos/{owner}/{repo}/pulls?state=open&base=${A.trunk_branch}&head={owner}:${A.work_branch}" --jq '.[] | [.number, .html_url] | @tsv'. If one is open, reuse it. ` +
  `Otherwise run exactly: gh api -X POST repos/{owner}/{repo}/pulls -f base=${q(A.trunk_branch)} -f head=${q(A.work_branch)} -f title=${q(A.title)} -F body=@${q(A.body_path)} --jq '[.number, .html_url] | @tsv'\n` +
  `${headNote}\n- ${RULES}`,
  { label: 'open PR', phase: 'PR', schema: PR, effort: 'low' })
if (!pr || pr.blocked) return certified({ status: 'BLOCKED', stage: 'pr', pr })
// CI commands address the PR by number, so a success without a real number is not usable.
if (!(Number.isInteger(pr.number) && pr.number > 0)) return certified({ status: 'BLOCKED', stage: 'pr', reason: 'the PR step returned no positive integer PR number', pr })
const prExtra = unreviewed(pr)
if (prExtra.length) return certified({ status: 'HEAD_MOVED', stage: 'pr', unreviewed: prExtra, pr })

phase('CI')
let ci = null
for (let attempt = 1; attempt <= 2; attempt++) {
  ci = await agent(
    `Watch the CI checks of PR #${pr.number} in ${A.repo} until they finish, with a HARD limit so the watcher can never outlive this step: timeout ${(A.ci_wait_min || 45) * 60} bash -c over a loop that reads gh api "repos/{owner}/{repo}/commits/<head_sha>/check-runs?per_page=100" every 30 s and stops when no run is queued or in_progress (if the timeout fires, the loop is killed and the state is PENDING). Use the REST API only; gh pr checks uses GraphQL. ` +
    `Classify each failing check: "flaky" (runner died, timeout, network, a known-flaky test that passed on the base), "real" (a genuine test or build failure), or "unknown". Quote the key log lines (gh api repos/{owner}/{repo}/actions/jobs/<job_id>/logs, the job id from the check run). ` +
    (attempt === 1 ? 'If every failure is flaky, re-run only the failed jobs once (gh api -X POST repos/{owner}/{repo}/actions/runs/<run_id>/rerun-failed-jobs) and set rerun_done=true; do not wait for the re-run here. ' : 'Do not re-run anything. ') +
    `Return PENDING if checks are still running at the wait limit, NONE if the PR has no checks. ${headNote.replace('<n>', String(pr.number))} head_sha is the PR's CURRENT head at the moment you finish. ` +
    `Separately report checks_head_sha = the commit the checks you describe ran on (the headSha of those check runs).\n- ${RULES}`,
    { label: `CI ${attempt}`, phase: 'CI', schema: CI, effort: 'low' })
  if (!ci || ci.blocked) return certified({ status: 'BLOCKED', stage: 'ci', pr, ci })
  if (!ci.rerun_done) break
}
// Only the reviewed commit (plus state-only commits after it) may be handed to the human as ready.
// Both the current PR head and the commit CI actually ran on must pass; CI results for any other commit are not evidence.
// "No checks" looks exactly like CI that has not registered yet, so it means CI_PENDING unless the repo declares it has no CI.
if (ci.state === 'NONE' && !A.allow_no_ci) {
  const moved = unreviewed(ci)
  return certified(moved.length ? { status: 'HEAD_MOVED', unreviewed: moved, pr, ci }
    : { status: 'CI_PENDING', reason: 'no checks reported on the PR yet (set allow_no_ci only if this repo has no CI)', unreviewed: [], pr, ci })
}
// An acceptable head whose own CI has not reported yet is CI_PENDING, not HEAD_MOVED; a completed result counts only for the head.
const headExtra = unreviewed(ci)
const shaMismatch = ci.state !== 'NONE' && ci.checks_head_sha !== ci.head_sha
if (!headExtra.length && shaMismatch) return certified({ status: 'CI_PENDING', reason: `checks reported for ${ci.checks_head_sha}, not yet for the PR head ${ci.head_sha}`, unreviewed: [], pr, ci })
const ciExtra = headExtra.concat(shaMismatch ? [`(CI ran on ${ci.checks_head_sha}, PR head is ${ci.head_sha})`] : [])
const status = ciExtra.length ? 'HEAD_MOVED'
  : ci.state === 'GREEN' || ci.state === 'NONE' ? 'READY_FOR_HUMAN_MERGE' : ci.state === 'PENDING' ? 'CI_PENDING' : 'CI_RED'
return certified({ status, unreviewed: ciExtra, pr, ci, completion })
