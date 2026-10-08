// R-25 dispatch tool (matrix M, N, O; F4): mcp__mm-runtime__dispatch binds the operator's
// dialog answer to the exact call through approve-dispatch and dispatch --approval-id.
import { expect, test } from 'claude-code/testing'
import {
  boot, doc, flagValue, fx, MM, PY, runsOf, SID, TASK_DIR, world,
  type Run, type WorldOptions,
} from './harness'

const TOOL = 'mcp__mm-runtime__dispatch'
const BG = { tool: TOOL, row: '#2', route: 'bg-it', model: 'sonnet', prompt_file: '/work/repo/prompts/p.md', worker: 'bg' }
const DEFAULT_LAUNCH = '/babysitter:yolo {prompt}'

// approve-dispatch stub that echoes what it was given, as the real command records it.
function echoApprove(run: Run) {
  const d = fx(run.argv.includes('--dry-run') ? 'approval-dry-run.json' : 'approval-ok.json')
  const launch = flagValue(run, '--launch')
  d.record.launch = launch === undefined ? (flagValue(run, '--route') === 'bg-it' ? DEFAULT_LAUNCH : '') : launch
  d.record.prompt_path = flagValue(run, '--prompt-file')
  d.record.row = flagValue(run, '--row')
  return doc(d)
}

function attended(taskDir = TASK_DIR): any {
  const d = fx('status-bound.json')
  d.task.dir = taskDir
  return d
}

function mmCalls(w: { runs: Run[] }): Run[] {
  return w.runs.filter((r) => r.argv[2] === 'approve-dispatch' || r.argv[2] === 'dispatch')
}

async function call($: any, on: any, input: Record<string, unknown>, o: WorldOptions & { interactive?: boolean } = {}) {
  const w = world(on, { approve: echoApprove, ...o })
  await boot($, o.interactive ?? true)
  const before = w.runs.length
  const out = await $.tool.call({ ...BG, ...input })
  return { w, out, before }
}

function expectPromptPath(w: { runs: Run[] }, path: string, cwd: string) {
  const calls = mmCalls(w)
  expect(calls.map((r) => r.argv[2] + (r.argv.includes('--dry-run') ? ' --dry-run' : ''))).toEqual([
    'approve-dispatch --dry-run', 'approve-dispatch', 'dispatch',
  ])
  for (const r of calls) {
    expect(flagValue(r, '--prompt-file')).toBe(path)
    expect(r.cwd).toBe(cwd)
  }
}

test('when the operator picks Approve, runs approve-dispatch then dispatch with the approval id', async ($, on) => {
  const { w, out } = await call($, on, {}, { ask: 'Approve' })
  const calls = mmCalls(w)
  expect(calls).toHaveLength(3)
  const [dry, approve, dispatch] = calls as [Run, Run, Run]
  expect(dry.argv.slice(0, 3)).toEqual([PY, MM, 'approve-dispatch'])
  expect(dry.argv).toContain('--dry-run')
  expect(dry.argv).toContain('--json')
  expect(flagValue(dry, '--channel')).toBe('cc-dialog')
  expect(flagValue(dry, '--session')).toBe(SID)
  expect(flagValue(dry, '--task-dir')).toBe(TASK_DIR)
  expect(flagValue(dry, '--row')).toBe('#2')
  expect(flagValue(dry, '--route')).toBe('bg-it')
  expect(flagValue(dry, '--model')).toBe('sonnet')
  expect(flagValue(dry, '--worker')).toBe('bg')
  expect(approve.argv).not.toContain('--dry-run')
  expect(flagValue(approve, '--expect-sha256')).toBe(fx('approval-dry-run.json').record.prompt_sha256)
  expect(approve.argv).toContain('--json')
  expect(dispatch.argv.slice(0, 3)).toEqual([PY, MM, 'dispatch'])
  expect(flagValue(dispatch, '--approval-id')).toBe('a1')
  expect(flagValue(dispatch, '--worker')).toBe('bg')
  expect(dispatch.argv).not.toContain('--approved-by')
  expect(dispatch.timeoutMs).toBe(30000)
  expect(String(out.result)).toContain('MM-DISPATCH-OK d5')
  expect(w.asks).toHaveLength(1)
  const q = w.asks[0] as string
  for (const part of ['t', '#2', 'Build the parser', 'bg', 'bg-it', 'sonnet', DEFAULT_LAUNCH, '/work/repo/prompts/p.md', '9f86d081884c', '1234']) {
    expect(q).toContain(part)
  }
})

test('when the operator picks Cancel, returns deny and never runs approve-dispatch without --dry-run', async ($, on) => {
  const { w, out } = await call($, on, {}, { ask: 'Cancel' })
  expect(out.deny).toMatch(/operator cancelled/)
  const calls = mmCalls(w)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argv).toContain('--dry-run')
})

test('when the operator answers free text under Other, returns deny', async ($, on) => {
  const { w, out } = await call($, on, {}, { ask: 'approve' })
  expect(out.deny).toMatch(/operator cancelled/)
  expect(mmCalls(w)).toHaveLength(1)
})

test('when ui.ask rejects, returns deny', async ($, on) => {
  const { w, out } = await call($, on, {}, { ask: 'reject' })
  expect(out.deny).toMatch(/operator cancelled/)
  expect(mmCalls(w)).toHaveLength(1)
  expect(runsOf(w, 'dispatch')).toEqual([])
})

test('when the session is noninteractive, returns deny without calling ui.ask', async ($, on) => {
  const { w, out } = await call($, on, {}, { interactive: false })
  expect(out).toEqual({
    deny: 'mm-runtime: attended dispatch needs the operator at the terminal; no one can answer here, so it is refused. Ask in chat and use mm.py dispatch --approved-by',
  })
  expect(w.asks).toEqual([])
  expect(mmCalls(w)).toEqual([])
})

test('when the session is unbound, returns deny naming mm.py bind', async ($, on) => {
  const { w, out } = await call($, on, {}, { status: fx('status-unbound.json') })
  expect(out.deny).toMatch(/mm\.py bind/)
  expect(mmCalls(w)).toEqual([])
})

test('when the task is unattended, runs dispatch without a dialog or approval flags', async ($, on) => {
  const d = fx('status-bound.json')
  d.mode = 'unattended'
  const { w, out } = await call($, on, {}, { status: d, interactive: false })
  expect(w.asks).toEqual([])
  const calls = mmCalls(w)
  expect(calls).toHaveLength(1)
  const run = calls[0]!
  expect(run.argv.slice(0, 3)).toEqual([PY, MM, 'dispatch'])
  expect(run.argv).not.toContain('--approval-id')
  expect(run.argv).not.toContain('--approved-by')
  expect(run.cwd).toBe(TASK_DIR)
  expect(String(out.result)).toContain('MM-DISPATCH-OK d5')
  expect(String(out.result)).toContain('exit 0')
})

test('when approve-dispatch exits 9 prompt-changed, returns its message and never runs dispatch', async ($, on) => {
  const refused = 'MM-APPROVAL-REFUSED PROMPT-CHANGED the prompt file changed while the dialog was open'
  const { w, out } = await call($, on, {}, {
    approve: (run: Run) => (run.argv.includes('--dry-run') ? echoApprove(run) : doc('', 9, refused)),
  })
  expect(JSON.stringify(out)).toContain('PROMPT-CHANGED')
  expect(runsOf(w, 'dispatch')).toEqual([])
})

test('when the call carries launch, the dialog shows it and approve-dispatch and dispatch get the same --launch value', async ($, on) => {
  const { w } = await call($, on, { launch: 'codex exec --file {prompt}' })
  expect(w.asks[0]).toContain('codex exec --file {prompt}')
  const calls = mmCalls(w)
  expect(calls).toHaveLength(3)
  for (const r of calls) expect(flagValue(r, '--launch')).toBe('codex exec --file {prompt}')
})

test('when the call has no launch on a bg route, the dialog shows the default template from the dry-run record and no argv carries --launch', async ($, on) => {
  const { w } = await call($, on, {})
  expect(w.asks[0]).toContain(DEFAULT_LAUNCH)
  const calls = mmCalls(w)
  expect(calls).toHaveLength(3)
  for (const r of calls) expect(r.argv).not.toContain('--launch')
})

test('when the dry-run record launch is empty, the dialog shows (none)', async ($, on) => {
  const { w } = await call($, on, { route: 'subagent', worker: 'subagent' })
  expect(w.asks[0]).toContain('(none)')
})

test('when prompt_file is relative and the session cwd differs from task.dir, the dry run, approve-dispatch and dispatch all get the same absolute path under the session cwd', async ($, on) => {
  const { w } = await call($, on, { prompt_file: 'prompts/p.md' }, { cwd: '/work/repo' })
  expectPromptPath(w, '/work/repo/prompts/p.md', TASK_DIR)
})

test('when prompt_file is POSIX absolute, every argv carries it as written', async ($, on) => {
  const { w } = await call($, on, { prompt_file: '/work/other/p.md' }, { cwd: '/work/repo' })
  expectPromptPath(w, '/work/other/p.md', TASK_DIR)
})

test('when prompt_file is root-relative with a slash, every argv carries the session drive', async ($, on) => {
  const { w } = await call($, on, { prompt_file: '/prompts/p.md' }, { cwd: 'D:/work/repo', status: attended('C:/work/task') })
  expectPromptPath(w, 'D:/prompts/p.md', 'C:/work/task')
})

test('when prompt_file is root-relative with a backslash, every argv carries the session drive', async ($, on) => {
  const { w } = await call($, on, { prompt_file: '\\prompts\\p.md' }, { cwd: 'D:/work/repo', status: attended('C:/work/task') })
  expectPromptPath(w, 'D:\\prompts\\p.md', 'C:/work/task')
})

test('when the session cwd is a UNC path and prompt_file is root-relative, every argv carries the share prefix', async ($, on) => {
  const { w } = await call($, on, { prompt_file: '/prompts/p.md' }, { cwd: '\\\\srv\\share\\repo', status: attended('C:/work/task') })
  expectPromptPath(w, '\\\\srv\\share/prompts/p.md', 'C:/work/task')
})

test('when prompt_file is relative and the session is on another drive than task.dir, every argv carries the path under the session cwd', async ($, on) => {
  const { w } = await call($, on, { prompt_file: 'prompts/p.md' }, { cwd: 'D:/work/repo', status: attended('C:/work/task') })
  expectPromptPath(w, 'D:/work/repo/prompts/p.md', 'C:/work/task')
})

test('when prompt_file is a fully qualified drive path, every argv carries it as written', async ($, on) => {
  const { w } = await call($, on, { prompt_file: 'C:/work/task/prompts/p.md' }, { cwd: 'D:/work/repo', status: attended('C:/work/task') })
  expectPromptPath(w, 'C:/work/task/prompts/p.md', 'C:/work/task')
})

test('when prompt_file is a fully qualified UNC path, every argv carries it as written', async ($, on) => {
  const { w } = await call($, on, { prompt_file: '\\\\srv\\share\\p.md' }, { cwd: 'D:/work/repo', status: attended('C:/work/task') })
  expectPromptPath(w, '\\\\srv\\share\\p.md', 'C:/work/task')
})

test('when prompt_file is drive-relative, returns deny naming drive-relative and runs no process.run', async ($, on) => {
  const { w, out, before } = await call($, on, { prompt_file: 'C:prompts\\p.md' }, { cwd: 'D:/work/repo', status: attended('C:/work/task') })
  expect(out.deny).toMatch(/drive-relative/)
  expect(w.runs.length).toBe(before)
})

test('when prompt_file starts with a drive letter in a POSIX session, returns deny and runs no process.run', async ($, on) => {
  const { w, out, before } = await call($, on, { prompt_file: 'C:/x/p.md' }, { cwd: '/work/repo' })
  expect(typeof out.deny).toBe('string')
  expect(w.runs.length).toBe(before)
})

test('when the session cwd has none of the known forms, returns deny and runs no process.run', async ($, on) => {
  const { w, out, before } = await call($, on, { prompt_file: 'prompts/p.md' }, { cwd: 'work/repo' })
  expect(out.deny).toMatch(/work\/repo/)
  expect(w.runs.length).toBe(before)
})
