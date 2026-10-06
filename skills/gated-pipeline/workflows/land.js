export const meta = {
  name: 'gated-land',
  description: 'Open the PR from the work branch to the trunk, watch CI, stop for the human merge',
  whenToUse: 'Stage 4 of the gated-pipeline skill, after build (and verify, if needed) returned PASS',
  phases: [
    { title: 'PR', detail: 'open or reuse the PR' },
    { title: 'CI', detail: 'watch checks; re-run a flaky failure once' },
  ],
}

const A = args || {}
const need = ['feature_id', 'repo', 'work_branch', 'trunk_branch', 'title', 'body_path', 'reviewed_sha']
const missing = need.filter(k => !A[k])
if (missing.length) return { status: 'BLOCKED', reason: 'missing args: ' + missing.join(', ') }
// Everything below goes into shell commands single-quoted, so it may not contain quotes, $, backticks or backslash-escapes.
const SAFE_PATH = /^[A-Za-z0-9._\/\\: +@-]+$/
const SAFE_REF = /^[A-Za-z0-9._\/-]+$/
const SAFE_TEXT = /^[A-Za-z0-9 ._,:;()#\/+@-]+$/
if (![A.repo, A.body_path].every(p => SAFE_PATH.test(p) && /^([A-Za-z]:[\/\\]|\/)/.test(p))) return { status: 'BLOCKED', reason: 'repo and body_path must be absolute paths of safe characters' }
if (!SAFE_REF.test(A.work_branch) || !SAFE_REF.test(A.trunk_branch)) return { status: 'BLOCKED', reason: 'branch names must match [A-Za-z0-9._/-]' }
if (!SAFE_TEXT.test(A.title)) return { status: 'BLOCKED', reason: 'title may only use letters, digits, spaces and ._,:;()#/+@-' }
if (A.ci_wait_min !== undefined && !(Number.isInteger(A.ci_wait_min) && A.ci_wait_min > 0)) return { status: 'BLOCKED', reason: 'ci_wait_min must be a positive integer' }
if (!/^[0-9a-f]{40}$/.test(A.reviewed_sha)) return { status: 'BLOCKED', reason: 'reviewed_sha must be a full 40-hex commit id' }
// git reports forward-slash paths, so state prefixes are normalized to that form before comparing.
const statePaths = (A.state_paths || []).filter(p => SAFE_PATH.test(p)).map(p => p.replace(/\\/g, '/').replace(/^\.\//, ''))
const q = s => `'${s}'`

const RULES = [
  `Repo: ${A.repo}. NEVER merge the PR, never enable auto-merge, never push or force-push ${A.trunk_branch}, never push ${A.work_branch} with --force.`,
  'Never trigger deploy workflows or workflow_dispatch runs. Re-running a failed check is the only CI action allowed.',
  'If any command is blocked, or a tool or the API refuses, STOP and report blocked=true. Never reproduce its effect another way.',
].join('\n- ')

const HEAD = {
  head_sha: { type: 'string' },
  reviewed_is_ancestor: { type: 'boolean' },
  files_after_review: { type: 'array', items: { type: 'string' } },
}
const headNote = `Report head_sha (the PR's current head commit: gh pr view <n> --json headRefOid), reviewed_is_ancestor (git -C ${q(A.repo)} merge-base --is-ancestor ${A.reviewed_sha} <head_sha>, after git fetch), ` +
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
  `Open a pull request for feature ${A.feature_id} in ${A.repo} from ${A.work_branch} into ${A.trunk_branch} with gh (run gh from ${A.repo}). ` +
  `First check: gh pr list --head ${q(A.work_branch)} --base ${q(A.trunk_branch)} --state open. If one is open, reuse it. ` +
  `Otherwise run exactly: gh pr create --base ${q(A.trunk_branch)} --head ${q(A.work_branch)} --title ${q(A.title)} --body-file ${q(A.body_path)}\n` +
  `${headNote}\n- ${RULES}`,
  { label: 'open PR', phase: 'PR', schema: PR, effort: 'low' })
if (!pr || pr.blocked) return { status: 'BLOCKED', stage: 'pr', pr }
// CI commands address the PR by number, so a success without a real number is not usable.
if (!(Number.isInteger(pr.number) && pr.number > 0)) return { status: 'BLOCKED', stage: 'pr', reason: 'the PR step returned no positive integer PR number', pr }
const prExtra = unreviewed(pr)
if (prExtra.length) return { status: 'HEAD_MOVED', stage: 'pr', unreviewed: prExtra, pr }

phase('CI')
let ci = null
for (let attempt = 1; attempt <= 2; attempt++) {
  ci = await agent(
    `Watch the CI checks of PR #${pr.number} in ${A.repo} until they finish, with a HARD limit so the watcher can never outlive this step: timeout ${(A.ci_wait_min || 45) * 60} gh pr checks ${pr.number} --watch (if the timeout fires, the watcher is killed and the state is PENDING). ` +
    `Classify each failing check: "flaky" (runner died, timeout, network, a known-flaky test that passed on the base), "real" (a genuine test or build failure), or "unknown". Quote the key log lines (gh run view --log-failed). ` +
    (attempt === 1 ? 'If every failure is flaky, re-run only the failed jobs once (gh run rerun <id> --failed) and set rerun_done=true; do not wait for the re-run here. ' : 'Do not re-run anything. ') +
    `Return PENDING if checks are still running at the wait limit, NONE if the PR has no checks. ${headNote.replace('<n>', String(pr.number))} head_sha is the PR's CURRENT head at the moment you finish. ` +
    `Separately report checks_head_sha = the commit the checks you describe ran on (the headSha of those check runs).\n- ${RULES}`,
    { label: `CI ${attempt}`, phase: 'CI', schema: CI, effort: 'low' })
  if (!ci || ci.blocked) return { status: 'BLOCKED', stage: 'ci', pr, ci }
  if (!ci.rerun_done) break
}
// Only the reviewed commit (plus state-only commits after it) may be handed to the human as ready.
// Both the current PR head and the commit CI actually ran on must pass; CI results for any other commit are not evidence.
// "No checks" looks exactly like CI that has not registered yet, so it means CI_PENDING unless the repo declares it has no CI.
if (ci.state === 'NONE' && !A.allow_no_ci) {
  const moved = unreviewed(ci)
  return moved.length ? { status: 'HEAD_MOVED', unreviewed: moved, pr, ci }
    : { status: 'CI_PENDING', reason: 'no checks reported on the PR yet (set allow_no_ci only if this repo has no CI)', unreviewed: [], pr, ci }
}
// An acceptable head whose own CI has not reported yet is CI_PENDING, not HEAD_MOVED; a completed result counts only for the head.
const headExtra = unreviewed(ci)
const shaMismatch = ci.state !== 'NONE' && ci.checks_head_sha !== ci.head_sha
if (!headExtra.length && shaMismatch) return { status: 'CI_PENDING', reason: `checks reported for ${ci.checks_head_sha}, not yet for the PR head ${ci.head_sha}`, unreviewed: [], pr, ci }
const ciExtra = headExtra.concat(shaMismatch ? [`(CI ran on ${ci.checks_head_sha}, PR head is ${ci.head_sha})`] : [])
const status = ciExtra.length ? 'HEAD_MOVED'
  : ci.state === 'GREEN' || ci.state === 'NONE' ? 'READY_FOR_HUMAN_MERGE' : ci.state === 'PENDING' ? 'CI_PENDING' : 'CI_RED'
return { status, unreviewed: ciExtra, pr, ci }
