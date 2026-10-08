// mm-runtime: optional Claude Code runtime adapter for the mm skill.
//
// It reaches mm only through runMm (one process.run, argv PYTHON, MM_PY, ...) and keeps no MM state:
// module variables hold the last status snapshot and what the hooks saw this session.
// mm.py stays the only writer of MM state, and guard.py stays the portable fence.
import type { EngineInterface, Register } from 'claude-code'
import { MM_PY, PYTHON } from './mm-config'
import {
  errorsOf, inFlightIds, isBound, isUnbound, modeOf, paneLines, readStatus, rowItem, statusLine, taskOf,
  type Snapshot, type StatusRead,
} from './present'

type Dollar = EngineInterface
type Run = { exitCode: number; stdout: string; stderr: string }

const configured = PYTHON !== '' && MM_PY !== ''
const PANE_ID = 'mm-runtime'
const DISPATCH_TOOL = 'mcp__mm-runtime__dispatch'
const WORKERS = ['subagent', 'workflow', 'codex', 'bg', 'other']
const TIMEOUT = { status: 20000, fence: 15000, changes: 15000, approve: 30000, dispatch: 30000 }
const INCOMPATIBLE = 'MM runtime: mm.py too old for this plugin (needs status --json); reinstall the plugin from the current skill'

// Session cache, none of it MM state.
let sid = ''
let interactive = false
let lastValid: Snapshot | undefined
let current: StatusRead = { reason: 'no mm status was read yet in this session' }
let refreshing: Promise<void> | undefined
let refreshQueued = false
const agentIdsSeen: string[] = []
type WorkerCall = { label: string }
const workersInProgress = new Set<WorkerCall>()
// `flying`: the in-flight dispatch ids the window opened with; a refresh that finds others marks it
// UNCERTAIN (WPMOD-r4 F2).
type ShellWindow = { reasons: string[]; flying: string[] }
const openWindows = new Set<ShellWindow>()
// Dispatch tool calls from handler entry until they return; each makes every open PM window UNCERTAIN.
const dispatchCallsInProgress = new Set<object>()
let pendingWarnings: string[] = []
let boundaryFiles: string[] = []
let monitorFailed = false
// A PM shell call that kept running after its tool call returned (WPMOD-r2 F1): its window stays
// open, holding its baseline, and is re-checked until it is known finished. See checkBackground.
type BackgroundWindow = {
  win: ShellWindow
  root: string
  before: ChangesDoc
  taskId?: string
  reported: string[]
  checks: number
  finished: boolean
  failureReported: boolean
}
const backgroundWindows = new Set<BackgroundWindow>()
let backgroundChecks: Promise<void> = Promise.resolve()
// The fallback bound: a background window no completion signal closed is closed after this many
// re-checks (main-loop turn.complete, prompt.submit and PM shell calls each count one).
const MAX_BACKGROUND_CHECKS = 30
// A worker (agentId) shell that kept running after its tool call returned (WPMOD-r3 F3). While any
// may still run, every PM shell window is UNCERTAIN. Closed like a background window: by classic.Stop
// no longer listing its task id, or after MAX_BACKGROUND_CHECKS checks.
type WorkerShell = { label: string; taskId?: string; checks: number }
const workerShells = new Set<WorkerShell>()

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '')
  return line === undefined ? '' : line.trim()
}

// The one way the plugin reaches mm: an argv array, never a shell string.
async function runMm($: Dollar, args: string[], init: { stdin?: string; cwd?: string; timeoutMs: number }): Promise<Run> {
  const result = await $.process.run([PYTHON, MM_PY, ...args], init)
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

function addReason(win: ShellWindow, reason: string): void {
  if (!win.reasons.includes(reason)) win.reasons.push(reason)
}

function seeAgent(agentId: unknown): void {
  if (typeof agentId === 'string' && agentId !== '' && !agentIdsSeen.includes(agentId)) agentIdsSeen.push(agentId)
}

function describeCall(e: Record<string, unknown>): string {
  const target = [e.file_path, e.notebook_path, e.command].find((v) => typeof v === 'string' && v !== '')
  return String(e.tool) + (target === undefined ? '' : ' ' + String(target).slice(0, 120)) + ' by agent ' + String(e.agentId)
}

// A worker (agentId) tool call is in progress from handler entry until its next settles.
function workerStarted(e: Record<string, unknown>): WorkerCall {
  const call = { label: describeCall(e) }
  workersInProgress.add(call)
  for (const win of openWindows) addReason(win, 'a delegated worker call started during the window (' + call.label + ')')
  return call
}

// The latest completed status read positively proved an mm.py older than this plugin. The handlers
// then pass through, so the portable guard.py classic hook stays the fence; any other failed read
// keeps the mod fence fail-closed.
function incompatible(): boolean {
  return current.incompatible === true
}

function pinStatus($: Dollar): void {
  $.ui.status(incompatible() ? INCOMPATIBLE : statusLine(current.snapshot, boundaryFiles.length, monitorFailed))
}

// WPMOD-r4 F1: the dispatch state is unknown when the latest status read failed or reports
// DISPATCHES-UNREADABLE. A worker may then be writing, so no change can be attributed to the PM.
function dispatchUnknown(): string | undefined {
  if (current.snapshot === undefined) return 'dispatch state is unknown (mm status is unavailable: ' + current.reason + ')'
  if (errorsOf(current.snapshot).some((x) => x.code === 'DISPATCHES-UNREADABLE')) {
    return 'dispatch state is unknown (the status reports DISPATCHES-UNREADABLE)'
  }
  return undefined
}

// After every status read: an unknown dispatch state (F1) or in-flight dispatches a window did not
// open with (F2) make every open PM window UNCERTAIN.
function markOpenWindows(): void {
  const unknown = dispatchUnknown()
  const flying = inFlightIds(current.snapshot)
  for (const win of openWindows) {
    if (unknown !== undefined) addReason(win, unknown)
    const fresh = flying.filter((id) => !win.flying.includes(id))
    if (fresh.length > 0) addReason(win, 'dispatches started during the window (' + fresh.join(', ') + ')')
  }
}

async function refreshOnce($: Dollar): Promise<void> {
  try {
    const run = await runMm($, ['status', '--json', '--session', sid], { timeoutMs: TIMEOUT.status })
    current = readStatus(run)
  } catch (err) {
    current = { reason: 'mm.py status could not run (' + errorText(err) + ')' }
  }
  if (current.snapshot !== undefined) lastValid = current.snapshot
  markOpenWindows()
  pinStatus($)
  $.ui.invalidate('ui.render')
}

// At most one status read in flight; triggers that arrive meanwhile coalesce into one follow-up.
function refresh($: Dollar): Promise<void> {
  if (refreshing !== undefined) {
    refreshQueued = true
    return refreshing
  }
  refreshing = (async () => {
    try {
      do {
        refreshQueued = false
        await refreshOnce($)
      } while (refreshQueued)
    } finally {
      refreshing = undefined
    }
  })()
  return refreshing
}

async function startSession($: Dollar): Promise<void> {
  const id = await $.session.id()
  // WPMOD-r4 F3: a different session id (classic.SessionStart after /clear) is a new session; the
  // previous one's pending warnings, boundary status prefix and windows do not carry over.
  if (sid !== '' && id !== sid) {
    pendingWarnings = []
    boundaryFiles = []
    monitorFailed = false
    openWindows.clear()
    backgroundWindows.clear()
  }
  sid = id
  await $.env.set('MM_CC_RUNTIME_MOD_ACTIVE', sid)
  await refresh($)
}

// The fence payload in the settings-hook shape guard.py reads (SPEC 2.3 payload mapping).
async function fencePayload($: Dollar, e: Record<string, unknown>): Promise<Record<string, unknown>> {
  const toolInput: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) {
    if (key !== 'tool' && key !== 'tool_use_id' && key !== 'agentId') toolInput[key] = value
  }
  const payload: Record<string, unknown> = {
    hook_event_name: 'PreToolUse',
    tool_name: e.tool,
    tool_input: toolInput,
    session_id: await $.session.id(),
    cwd: await $.session.cwd(),
  }
  if (e.agentId !== undefined) payload.agent_id = e.agentId
  return payload
}

function failClosed(why: string): { deny: string } {
  return { deny: 'mm-runtime: the PM write fence could not decide (' + why + '), so the write is refused (fail closed)' }
}

async function fenceVerdict($: Dollar, payload: Record<string, unknown>): Promise<{ deny: string } | undefined> {
  let run: Run
  try {
    run = await runMm($, ['fence', '--json'], { stdin: JSON.stringify(payload), timeoutMs: TIMEOUT.fence })
  } catch (err) {
    return failClosed('mm.py fence did not run: ' + errorText(err))
  }
  if (run.exitCode !== 0) return failClosed('mm.py fence exited ' + run.exitCode + ': ' + firstLine(run.stderr))
  let verdict: Record<string, unknown>
  try {
    verdict = JSON.parse(run.stdout)
  } catch {
    return failClosed('mm.py fence printed no JSON')
  }
  if (typeof verdict !== 'object' || verdict === null || verdict.schema !== 'mm.fence/1') {
    return failClosed('mm.py fence answered another schema')
  }
  if (verdict.decision === 'allow') return undefined
  const messages = Array.isArray(verdict.messages) ? verdict.messages.filter((m) => typeof m === 'string' && m !== '') : []
  if (verdict.decision === 'deny' && messages.length > 0) return { deny: messages.join('\n') }
  return failClosed('mm.py fence answered no allow')
}

type ChangesDoc = { raw: string; changed: string[] }
// A snapshot read either succeeded (`doc`) or failed (`error`, why); a failure is never "no changes".
type ChangesRead = { doc: ChangesDoc; error?: undefined } | { doc?: undefined; error: string }

async function productChanges($: Dollar, taskDir: string, before?: ChangesDoc): Promise<ChangesRead> {
  const args = ['product-changes', '--task-dir', taskDir, '--json']
  if (before !== undefined) args.push('--baseline', '-')
  let run: Run
  try {
    run = await runMm($, args, { stdin: before?.raw, timeoutMs: TIMEOUT.changes })
  } catch (err) {
    return { error: 'mm.py product-changes did not run: ' + errorText(err) }
  }
  if (run.exitCode !== 0) {
    const why = firstLine(run.stderr)
    return { error: 'mm.py product-changes exited ' + run.exitCode + (why === '' ? '' : ': ' + why) }
  }
  let parsed: any
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return { error: 'mm.py product-changes printed no JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.schema !== 'mm.changes/1') {
    return { error: 'mm.py product-changes answered another schema' }
  }
  if (before !== undefined && !Array.isArray(parsed.changed)) return { error: 'mm.py product-changes answered no changed list' }
  const changed = Array.isArray(parsed.changed) ? parsed.changed.filter((f: unknown) => typeof f === 'string') : []
  return { doc: { raw: run.stdout, changed } }
}

// The plugin never aborts a turn (operator decision, R-26: "Warn + stop note, no abort"). A change
// attributable to the PM instead adds this note to the shell call's result, so the PM stops and asks.
function stopNote(files: string[]): string {
  return 'MM boundary: product files changed during your PM shell call: ' + files.join(', ') +
    '. Stop: do not continue this task; tell the operator what changed and ask how to proceed. Do not revert anything.'
}

function monitorStopNote(why: string): string {
  return 'MM boundary monitor failed: after your PM shell call the product-changes read failed (' + why +
    '), so product file changes during it cannot be ruled out. Stop: do not continue this task; tell the operator the boundary monitor failed and ask how to proceed. Do not revert anything.'
}

function changedWarning(files: string[]): string {
  return 'MM boundary: ' + files.length + ' product files changed during a PM shell call: ' + files.join(', ')
}

function monitorWarning(why: string): string {
  return 'MM boundary monitor failed: the product-changes read after a PM shell call failed (' + why +
    '), so product file changes during it are unknown'
}

function uncertainTail(win: ShellWindow): string {
  if (win.reasons.length === 0) return ''
  return '; UNCERTAIN: ' + win.reasons.join('; ') +
    '. The change may come from a worker or a background shell, so it is not attributed to the PM call and no stop is asked'
}

// Step 4 of R-26 for one finding: toast, status prefix and pending prompt context.
function report($: Dollar, warning: string, files: string[], failed: boolean): void {
  $.ui.toast(warning, { timeoutMs: 15000 })
  pendingWarnings.push(warning)
  for (const f of files) if (!boundaryFiles.includes(f)) boundaryFiles.push(f)
  if (failed) monitorFailed = true
  pinStatus($)
}

function isDeny(r: any): boolean {
  return r !== null && typeof r === 'object' && typeof r.deny === 'string'
}

// One re-check of every pending background window against its own baseline. Its findings are
// always UNCERTAIN (reason: background shell), so they warn and never carry a stop note.
async function checkBackgroundOnce($: Dollar): Promise<void> {
  for (const bg of [...backgroundWindows]) {
    const after = await productChanges($, bg.root, bg.before)
    bg.checks += 1
    if (after.error !== undefined) {
      if (!bg.failureReported) {
        bg.failureReported = true
        report($, monitorWarning(after.error) + uncertainTail(bg.win), [], true)
      }
    } else {
      const fresh = after.doc.changed.filter((f) => !bg.reported.includes(f))
      if (fresh.length > 0) {
        bg.reported.push(...fresh)
        report($, changedWarning(fresh) + uncertainTail(bg.win), fresh, false)
      }
    }
    if (bg.finished || bg.checks >= MAX_BACKGROUND_CHECKS) {
      backgroundWindows.delete(bg)
      openWindows.delete(bg.win)
      if (!bg.finished) {
        $.ui.toast('MM boundary: stopped watching a background PM shell call after ' + MAX_BACKGROUND_CHECKS +
          ' checks (' + (bg.taskId ?? 'no task id') + '); product files it changes from now on are not reported', { timeoutMs: 15000 })
      }
    }
  }
}

// Background windows close on the engine's completion signal: a classic.Stop whose
// background_tasks (the session's in-flight background work [DTS StopHookInput.background_tasks,
// BackgroundTaskSummary.id]) no longer lists the task id the shell's result named
// [tools DTS Bash/PowerShell output backgroundTaskId] gets one final check. Without that signal a
// window closes after MAX_BACKGROUND_CHECKS re-checks. Re-checks run one at a time, in order.
function checkBackground($: Dollar): Promise<void> {
  ageWorkerShells($)
  if (backgroundWindows.size === 0) return backgroundChecks
  backgroundChecks = backgroundChecks.then(() => checkBackgroundOnce($)).catch((err: unknown) => {
    $.ui.log('mm-runtime: a background boundary re-check failed: ' + errorText(err), { to: 'debug' })
  })
  return backgroundChecks
}

// Each check of the background windows is one check of the worker background shells too.
function ageWorkerShells($: Dollar): void {
  for (const ws of [...workerShells]) {
    ws.checks += 1
    if (ws.checks >= MAX_BACKGROUND_CHECKS) {
      workerShells.delete(ws)
      $.ui.log('mm-runtime: stopped treating a worker background shell as running after ' + MAX_BACKGROUND_CHECKS +
        ' checks (' + ws.label + ')', { to: 'debug' })
    }
  }
}

function backgroundTaskOf(r: any): string | undefined {
  return typeof r?.result?.backgroundTaskId === 'string' ? (r.result.backgroundTaskId as string) : undefined
}

// A worker shell still running when its tool call returned (run_in_background, or moved to the
// background later, which its result's backgroundTaskId shows) stays tracked (WPMOD-r3 F3).
function trackWorkerShell(e: Record<string, unknown>, r: unknown, label: string): void {
  const taskId = backgroundTaskOf(r)
  if (isDeny(r) || (e.run_in_background !== true && taskId === undefined)) return
  workerShells.add({ label: label + ' (' + (taskId ?? 'no task id') + ')', taskId, checks: 0 })
}

// WPMOD-r3 F1, F2: what a PM shell call is checked against, or undefined to run it unmonitored.
// Only the latest completed status read proving session.bound === false skips the monitor; after a
// failed read one fresh read is taken, and if that fails too the session is treated as bound.
// Snapshots anchor at the repository root the fence uses (task.repo_root), never at the task
// folder, which mm.py close moves; with no task known, at the session directory.
async function monitorTarget($: Dollar): Promise<{ root: string; snap: Snapshot | undefined } | undefined> {
  if (current.snapshot === undefined) await refresh($)
  if (incompatible() || isUnbound(current.snapshot)) return undefined
  const kept = isBound(lastValid) ? lastValid : undefined
  const snap = current.snapshot ?? kept
  const task = taskOf(snap) ?? taskOf(kept)
  return { root: task !== undefined ? task.repo : await $.session.cwd(), snap }
}

// R-26: a PM-main-loop shell call bracketed by two product-changes reads.
async function watchShell($: Dollar, e: Record<string, unknown>, next: (e: never) => Promise<unknown>) {
  await checkBackground($)
  const target = await monitorTarget($)
  if (target === undefined) return next(e as never)
  const { root, snap } = target
  const runsMm = typeof e.command === 'string' && e.command.includes('mm.py')
  const win: ShellWindow = { reasons: [], flying: inFlightIds(snap) }
  const unknown = dispatchUnknown()
  if (unknown !== undefined) addReason(win, unknown)
  if (dispatchCallsInProgress.size > 0) addReason(win, 'a dispatch tool call was in progress when the window opened')
  if (workersInProgress.size > 0) {
    const labels = [...workersInProgress].map((w) => w.label).join('; ')
    addReason(win, 'a delegated worker call was already in progress when the window opened (' + labels + ')')
  }
  if (workerShells.size > 0) {
    const labels = [...workerShells].map((w) => w.label).join('; ')
    addReason(win, 'a delegated worker shell may still be running in the background (' + labels + ')')
  }
  if (openWindows.size > 0) {
    addReason(win, 'another PM shell call overlapped')
    for (const other of openWindows) addReason(other, 'another PM shell call overlapped')
  }
  if (win.flying.length > 0) addReason(win, 'dispatches were in flight (' + win.flying.join(', ') + ')')
  openWindows.add(win)
  let r: any
  let failure: { error: unknown } | undefined
  let after: ChangesRead
  let background: BackgroundWindow | undefined
  try {
    const before = await productChanges($, root)
    if (before.error !== undefined) {
      // An mm.py call is never refused for this (WPMOD-r3 F2): mm.py unbind must always run.
      if (runsMm) {
        report($, 'MM boundary monitor failed: the product-changes read before a PM shell call running mm.py failed (' +
          before.error + '), so it ran unmonitored and product file changes during it are unknown' + uncertainTail(win), [], true)
        return await next(e as never)
      }
      return {
        deny: 'mm-runtime: cannot snapshot product files before this PM shell call (' + before.error +
          '), so it is refused (fail closed). Fix git for ' + root +
          ', or delegate the command to a worker, or leave PM mode: mm.py unbind --session ' + sid,
      }
    }
    try {
      r = await next(e as never)
    } catch (err) {
      failure = { error: err }
    }
    after = await productChanges($, root, before.doc)
    // A command still running when its tool call returned (run_in_background, or moved to the
    // background later, which its result's backgroundTaskId shows) keeps its window open.
    const taskId = backgroundTaskOf(r)
    if (failure === undefined && !isDeny(r) && (e.run_in_background === true || taskId !== undefined)) {
      addReason(win, 'background shell: the command kept running after its tool call returned (' + (taskId ?? 'no task id') + ')')
      background = {
        win, root, before: before.doc, taskId, reported: [], checks: 0, finished: false, failureReported: false,
      }
      backgroundWindows.add(background)
    }
  } finally {
    if (background === undefined) openWindows.delete(win)
  }
  if (background !== undefined) {
    if (after.error !== undefined) {
      background.failureReported = true
      report($, monitorWarning(after.error) + uncertainTail(win), [], true)
    } else if (after.doc.changed.length > 0) {
      background.reported.push(...after.doc.changed)
      report($, changedWarning(after.doc.changed) + uncertainTail(win), after.doc.changed, false)
    }
    return r
  }
  if (after.error === undefined && after.doc.changed.length === 0) {
    if (failure !== undefined) throw failure.error
    return r
  }
  const uncertain = win.reasons.length > 0
  let note: string
  if (after.error !== undefined) {
    // A failed after read is a boundary finding too: nothing proves the call left product files alone.
    report($, monitorWarning(after.error) + uncertainTail(win), [], true)
    note = monitorStopNote(after.error)
  } else {
    const files = after.doc.changed
    report($, changedWarning(files) + uncertainTail(win), files, false)
    note = stopNote(files)
  }
  // A rejected call is propagated unchanged, after its warning. The turn is never aborted.
  if (failure !== undefined) throw failure.error
  // UNCERTAIN: warning only (toast, status prefix, prompt context), no stop note.
  if (uncertain) return r
  if (isDeny(r)) return r
  return { ...r, context: [...(Array.isArray(r?.context) ? r.context : []), note] }
}

// R-25 step 0: the prompt path, resolved once against the session directory with string
// operations only, so every mm.py call gets the same fully qualified path.
function resolvePrompt(base: string, v: string): { path: string } | { deny: string } {
  let windows: boolean
  let root = ''
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(base)
  if (/^[A-Za-z]:[\\/]/.test(base)) {
    windows = true
    root = base.slice(0, 2)
  } else if (unc !== null) {
    windows = true
    root = unc[0]
  } else if (base.startsWith('/')) {
    windows = false
  } else {
    return { deny: 'mm-runtime: the session directory ' + base + ' is neither a Windows drive or UNC path nor a POSIX path, so prompt_file cannot be resolved; nothing was run' }
  }
  if (windows && (/^[A-Za-z]:[\\/]/.test(v) || /^[\\/]{2}/.test(v))) return { path: v }
  if (windows && /^[\\/]/.test(v)) return { path: root + v }
  if (/^[A-Za-z]:/.test(v)) {
    return {
      deny: 'mm-runtime: prompt_file ' + v + ' is drive-relative or a drive path in a POSIX session; it cannot be resolved reliably (a drive-relative path depends on a per-drive current folder the plugin cannot see), so it is refused. Pass a fully qualified path or one relative to the session directory',
    }
  }
  if (!windows && v.startsWith('/')) return { path: v }
  return { path: base.replace(/[\\/]+$/, '') + '/' + v }
}

function runText(name: string, run: Run): string {
  return 'mm.py ' + name + ' exit ' + run.exitCode + (run.stdout === '' ? '' : '\n' + run.stdout.trimEnd()) +
    (run.stderr === '' ? '' : '\n' + run.stderr.trimEnd())
}

function parseApproval(run: Run): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(run.stdout)
    if (parsed?.schema !== 'mm.approval/1' || typeof parsed.record !== 'object' || parsed.record === null) return undefined
    return parsed.record
  } catch {
    return undefined
  }
}

// R-25: the dispatch tool. Returns its answer and whether mm.py was reached.
async function dispatchTool($: Dollar, e: Record<string, unknown>): Promise<{ answer: unknown; reached: boolean }> {
  const fields = ['row', 'route', 'model', 'prompt_file', 'worker'] as const
  for (const f of fields) {
    if (typeof e[f] !== 'string' || e[f] === '') {
      return { answer: { deny: 'mm-runtime: dispatch needs ' + fields.join(', ') + ' as non-empty strings; ' + f + ' is missing' }, reached: false }
    }
  }
  if (e.launch !== undefined && typeof e.launch !== 'string') {
    return { answer: { deny: 'mm-runtime: dispatch launch must be a string when given' }, reached: false }
  }
  const row = e.row as string
  const route = e.route as string
  const model = e.model as string
  const worker = e.worker as string
  const launchArgs = typeof e.launch === 'string' ? ['--launch', e.launch] : []
  const resolved = resolvePrompt(await $.session.cwd(), e.prompt_file as string)
  if ('deny' in resolved) return { answer: { deny: resolved.deny }, reached: false }
  const promptFile = resolved.path

  const session = await $.session.id()
  let status: StatusRead
  try {
    status = readStatus(await runMm($, ['status', '--json', '--session', session], { timeoutMs: TIMEOUT.status }))
  } catch (err) {
    status = { reason: 'mm.py status could not run (' + errorText(err) + ')' }
  }
  if (status.incompatible === true) {
    return { answer: { deny: 'mm-runtime: ' + INCOMPATIBLE + '; nothing was dispatched (' + status.reason + ')' }, reached: true }
  }
  const snap = status.snapshot
  if (snap === undefined) return { answer: { deny: 'mm-runtime: mm status is unavailable (' + status.reason + '), so nothing was dispatched' }, reached: true }
  const task = taskOf(snap)
  if (!isBound(snap)) {
    return { answer: { deny: 'mm-runtime: this session is not bound to an MM task; run mm.py bind --task-dir <task> --session ' + session + ' first' }, reached: true }
  }
  if (task === undefined) {
    const why = errorsOf(snap).map((x) => x.message).join('; ')
    return { answer: { deny: 'mm-runtime: the bound task cannot be read (' + (why || 'no task in the status document') + ')' }, reached: true }
  }
  const common = ['--task-dir', task.dir, '--row', row, '--route', route, '--model', model, '--prompt-file', promptFile]

  if (modeOf(snap) === 'unattended') {
    const run = await runMm($, ['dispatch', ...common, '--worker', worker, ...launchArgs], { cwd: task.dir, timeoutMs: TIMEOUT.dispatch })
    return { answer: { result: runText('dispatch', run) }, reached: true }
  }
  if (interactive !== true) {
    return {
      answer: { deny: 'mm-runtime: attended dispatch needs the operator at the terminal; no one can answer here, so it is refused. Ask in chat and use mm.py dispatch --approved-by' },
      reached: true,
    }
  }
  const approveArgs = ['approve-dispatch', ...common, '--worker', worker, ...launchArgs, '--channel', 'cc-dialog', '--session', session]
  const dry = await runMm($, [...approveArgs, '--dry-run', '--json'], { cwd: task.dir, timeoutMs: TIMEOUT.approve })
  const draft = dry.exitCode === 0 ? parseApproval(dry) : undefined
  if (draft === undefined || typeof draft.prompt_sha256 !== 'string') {
    return { answer: { deny: 'mm-runtime: approve-dispatch --dry-run refused or answered no record: ' + runText('approve-dispatch', dry) }, reached: true }
  }
  const sha = draft.prompt_sha256
  const launch = typeof draft.launch === 'string' && draft.launch !== '' ? draft.launch : '(none)'
  const question = [
    'mm dispatch for task ' + task.name,
    'row: ' + row + ' ' + (rowItem(snap, row) ?? ''),
    'worker: ' + worker,
    'route: ' + route,
    'model: ' + model,
    'launch: ' + launch,
    'prompt: ' + promptFile,
    'sha256: ' + sha.slice(0, 12) + ' (' + String(draft.prompt_bytes) + ' bytes)',
    'Approve this dispatch?',
  ].join('\n')
  let answer = 'Cancel'
  try {
    answer = await $.ui.ask(question, ['Cancel', 'Approve'])
  } catch (err) {
    return { answer: { deny: 'mm-runtime: operator cancelled the dispatch of row ' + row + ' (the dialog closed: ' + errorText(err) + '); nothing was approved' }, reached: true }
  }
  if (answer !== 'Approve') {
    return { answer: { deny: 'mm-runtime: operator cancelled the dispatch of row ' + row + '; nothing was approved' }, reached: true }
  }
  const approved = await runMm($, [...approveArgs, '--expect-sha256', sha, '--json'], { cwd: task.dir, timeoutMs: TIMEOUT.approve })
  const record = approved.exitCode === 0 ? parseApproval(approved) : undefined
  if (record === undefined || typeof record.id !== 'string') {
    return { answer: { deny: 'mm-runtime: approve-dispatch refused, nothing was dispatched: ' + runText('approve-dispatch', approved) }, reached: true }
  }
  const run = await runMm($, ['dispatch', ...common, '--approval-id', record.id, '--worker', worker, ...launchArgs], {
    cwd: task.dir, timeoutMs: TIMEOUT.dispatch,
  })
  return { answer: { result: runText('dispatch', run) }, reached: true }
}

const DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    row: { type: 'string', description: 'The ledger row id the dispatch serves.' },
    route: { type: 'string', description: 'The mm route, as mm.py dispatch --route takes it.' },
    model: { type: 'string', description: 'The model the worker runs on.' },
    prompt_file: {
      type: 'string',
      description: 'The prompt file: fully qualified, root-relative on Windows (takes the session drive), or relative to the session directory; drive-relative values such as C:foo are refused.',
    },
    worker: { type: 'string', enum: WORKERS, description: 'Who runs the work.' },
    launch: { type: 'string', description: 'Optional launch template, as mm.py dispatch --launch takes it; {prompt} becomes the prompt copy path.' },
  },
  required: ['row', 'route', 'model', 'prompt_file', 'worker'],
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    if (!configured) {
      $.ui.status('MM runtime: not configured')
      return next(e)
    }
    interactive = e.isInteractive === true
    await startSession($)
    try {
      await $.tool.register({
        name: 'dispatch',
        description: 'Record an mm dispatch for the bound task. Attended tasks ask the operator in a dialog bound to this exact call (row, worker, route, model, launch, prompt hash) before mm.py dispatch runs.',
        inputSchema: DISPATCH_SCHEMA,
      })
    } catch (err) {
      $.ui.log('mm-runtime: the dispatch tool was not registered: ' + errorText(err), { to: 'debug' })
    }
    try {
      await $.command.register({ name: 'mm-runtime', description: 'Show the mm task pane', argumentHint: '', immediate: true })
    } catch (err) {
      $.ui.log('mm-runtime: /mm-runtime was not registered: ' + errorText(err), { to: 'debug' })
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (!configured) return next(e)
    await startSession($)
    return next(e)
  })

  // MultiEdit is not a built-in tool of every build, so its name is typed loosely here.
  on('tool.call', { tool: ['Edit', 'Write', 'MultiEdit' as never, 'NotebookEdit'] }, async ($, e, next) => {
    if (!configured || incompatible()) return next(e)
    const call = e as Record<string, unknown>
    const worker = call.agentId !== undefined ? workerStarted(call) : undefined
    seeAgent(call.agentId)
    try {
      // Only the latest completed status read may waive the fence, never a snapshot kept after a failed refresh.
      if (isUnbound(current.snapshot)) return await next(e)
      const payload = await fencePayload($, call)
      const denied = await fenceVerdict($, payload)
      if (denied !== undefined) return denied
      return await next(e)
    } finally {
      if (worker !== undefined) workersInProgress.delete(worker)
    }
  }).catch(($, e, next) => ({
    deny: 'mm-runtime: the PM write fence failed (' + next.error.kind + ': ' + next.error.message + '), so the write is refused (fail closed)',
  }))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    if (!configured) return next(e)
    const call = e as Record<string, unknown>
    const command = typeof call.command === 'string' ? call.command : ''
    let r: unknown
    if (call.agentId !== undefined) {
      seeAgent(call.agentId)
      const worker = workerStarted(call)
      try {
        r = await next(e)
      } finally {
        workersInProgress.delete(worker)
      }
      trackWorkerShell(call, r, worker.label)
    } else if (incompatible()) {
      r = await next(e)
    } else {
      r = await watchShell($, call, next as never)
    }
    if (command.includes('mm.py')) await refresh($)
    return r as never
  })

  on('tool.call', { tool: DISPATCH_TOOL }, async ($, e, next) => {
    if (!configured) return next(e)
    // WPMOD-r4 F2: a dispatch may start a worker, so every PM window open meanwhile is UNCERTAIN.
    const call = {}
    dispatchCallsInProgress.add(call)
    for (const win of openWindows) addReason(win, 'a dispatch tool call ran during the window')
    try {
      const out = await dispatchTool($, e as Record<string, unknown>)
      if (out.reached) await refresh($)
      return out.answer as never
    } finally {
      dispatchCallsInProgress.delete(call)
    }
  }).catch(($, e, next) => ({
    deny: 'mm-runtime: the dispatch tool failed (' + next.error.kind + ': ' + next.error.message + '); nothing was approved by this call',
  }))

  on('turn.complete', async ($, e, next) => {
    if (!configured) return next(e)
    await refresh($)
    if (e.agentId === undefined) await checkBackground($)
    return next(e)
  })

  // The completion signal for background PM shell calls (WPMOD-r2 F1, see checkBackground) and
  // worker background shells (WPMOD-r3 F3).
  on('classic.Stop', async ($, e, next) => {
    if (!configured || (backgroundWindows.size === 0 && workerShells.size === 0)) return next(e)
    const inFlight = (e as Record<string, unknown>).background_tasks
    if (Array.isArray(inFlight)) {
      const ids = inFlight.map((t: unknown) => (typeof t === 'object' && t !== null ? (t as Record<string, unknown>).id : undefined))
      for (const ws of [...workerShells]) {
        if (ws.taskId !== undefined && !ids.includes(ws.taskId)) workerShells.delete(ws)
      }
      let done = false
      for (const bg of backgroundWindows) {
        if (bg.taskId !== undefined && !ids.includes(bg.taskId)) {
          bg.finished = true
          done = true
        }
      }
      if (done) await checkBackground($)
    }
    return next(e)
  })

  on('command.run', { command: 'mm-runtime' }, async ($, e, next) => {
    if (!configured) return next(e)
    if (incompatible()) return { text: INCOMPATIBLE + ' (' + current.reason + ')' }
    const snap = current.snapshot
    if (snap === undefined) {
      return {
        text: 'mm-runtime: mm status is unavailable (' + current.reason + '); run ' + PYTHON + ' ' + MM_PY +
          ' status --json --session ' + sid + ' to see why',
      }
    }
    if (isUnbound(snap)) return { text: 'mm-runtime: this session is not bound to an MM task' }
    const lines = paneLines(snap, agentIdsSeen)
    const asText = lines.map((l) => l.text).join('\n')
    try {
      const opened = await $.ui.open({ id: PANE_ID, title: 'mm', focus: true, closeOnEscape: true })
      if (opened.isPlaced === true) return {}
      return { text: asText + '\n(pane not placed: ' + opened.reason + ')' }
    } catch (err) {
      return { text: asText + '\n(pane not opened: ' + errorText(err) + ')' }
    }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (!configured || e.requestId !== PANE_ID) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const [header, ...body] = paneLines(current.snapshot, agentIdsSeen)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ bold: true, wrap: 'truncate-end', children: [header === undefined ? 'mm' : header.text] }),
        ...body.map((l) => Text({ wrap: 'truncate-end', dimColor: l.dim, children: [l.text] })),
      ],
    })
  })

  on('prompt.submit', async ($, e, next) => {
    if (!configured) return next(e)
    await checkBackground($)
    if (pendingWarnings.length === 0) return next(e)
    const warnings = pendingWarnings
    pendingWarnings = []
    boundaryFiles = []
    monitorFailed = false
    pinStatus($)
    return next({ ...e, context: [...(e.context ?? []), ...warnings] })
  })
}
