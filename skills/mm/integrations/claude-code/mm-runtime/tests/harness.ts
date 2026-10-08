// Test world for the mm-runtime tests: stubs that answer in Claude Code's place and
// record every call the plugin makes. No real mm.py ever runs: process.run is a stub
// that routes by the mm.py subcommand (argv[2]) to the synthetic fixtures.
import { FIXTURES } from './fixtures'

// The synthetic values the plugin gate writes into hooks/mm-config.ts of the
// configured copy; they are never executed.
export const PY = '/synthetic/bin/python'
export const MM = '/synthetic/skill/scripts/mm.py'
export const SID = '00000000-0000-4000-8000-000000000001'
export const TASK_DIR = '/work/repo/.private/pm/active/t'
export const MARKER = 'MM_CC_RUNTIME_MOD_ACTIVE'

export function fx(name: string): any {
  const doc = FIXTURES[name]
  if (doc === undefined) throw new Error('no fixture ' + name)
  return JSON.parse(JSON.stringify(doc))
}

// A bound, attended snapshot with nothing in flight, so a boundary change is
// attributable to the PM shell call alone.
export function quietBound(): any {
  const doc = fx('status-bound.json')
  doc.dispatches_in_flight = []
  return doc
}

export type Run = { argv: string[]; cwd?: string; stdin?: string; timeoutMs?: number }
export type Reply = { exitCode?: number; stdout?: string; stderr?: string } | { reject: string }
export type Handler = (run: Run) => Reply | Promise<Reply>

export type WorldOptions = {
  status?: unknown
  fence?: unknown
  changes?: Handler
  approve?: Handler
  dispatch?: Handler
  cwd?: string
  sessionIds?: string[]
  sessionIdRejects?: boolean
  ask?: string
  open?: unknown
  tool?: (e: any) => unknown
}

export type World = {
  runs: Run[]
  events: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  logs: string[]
  envSets: { name: string; value?: string }[]
  tools: any[]
  commands: any[]
  aborts: string[]
  opens: any[]
  asks: string[]
  toolCalls: any[]
  prompts: any[]
  invalidations: string[]
  sessionIdCalls: number
}

export function doc(value: unknown, exitCode = 0, stderr = ''): Reply {
  return { exitCode, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr }
}

function answerWith(spec: unknown, run: Run): Reply | Promise<Reply> {
  if (typeof spec === 'function') return (spec as Handler)(run)
  return doc(spec)
}

export function world(on: any, o: WorldOptions = {}): World {
  const w: World = {
    runs: [], events: [], statuses: [], toasts: [], logs: [], envSets: [], tools: [], commands: [],
    aborts: [], opens: [], asks: [], toolCalls: [], prompts: [], invalidations: [], sessionIdCalls: 0,
  }
  const ids = o.sessionIds ?? [SID]

  on('process.run', async ($: any, e: any) => {
    const run: Run = { argv: [...e.argv], cwd: e.init?.cwd, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs }
    w.runs.push(run)
    const sub = String(run.argv[2])
    w.events.push('run:' + sub)
    let reply: Reply
    if (sub === 'status') reply = await answerWith(o.status ?? fx('status-bound.json'), run)
    else if (sub === 'fence') reply = await answerWith(o.fence ?? fx('fence-allow.json'), run)
    else if (sub === 'product-changes') reply = await (o.changes ?? unchanged)(run)
    else if (sub === 'approve-dispatch') reply = await (o.approve ?? approveFixtures)(run)
    else if (sub === 'dispatch') reply = await (o.dispatch ?? dispatched)(run)
    else reply = { exitCode: 2, stdout: '', stderr: 'unknown command ' + sub }
    if ('reject' in reply) return { deny: reply.reject }
    return {
      value: {
        exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '',
        isStdoutTruncated: false, isStderrTruncated: false,
      },
    }
  })
  on('session.id', () => {
    w.sessionIdCalls += 1
    if (o.sessionIdRejects === true) return { deny: 'session id unavailable in this test' }
    return { value: ids[Math.min(w.sessionIdCalls, ids.length) - 1] }
  })
  on('session.cwd', () => ({ value: o.cwd ?? '/work/repo' }))
  on('env.set', ($: any, e: any) => {
    w.envSets.push({ name: e.name, value: e.value })
    return { value: undefined }
  })
  on('tool.register', ($: any, e: any) => {
    w.tools.push(e)
    return { value: { tool: 'mcp__mm-runtime__' + e.name } }
  })
  on('command.register', ($: any, e: any) => {
    w.commands.push(e)
    return { value: undefined }
  })
  on('ui.status', ($: any, e: any) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', ($: any, e: any) => {
    w.invalidations.push(e.event)
    return { value: undefined }
  })
  on('ui.open', ($: any, e: any) => {
    w.opens.push(e)
    const spec = o.open ?? { isPlaced: true }
    if (spec === 'reject') return { deny: 'the surface refused the pane' }
    return { value: spec }
  })
  // The plugin never aborts a turn (R-26, WPMOD-r4); this stub records any call so tests can assert none.
  on('turn.abort', ($: any, e: any) => {
    w.aborts.push(e.turnId)
    w.events.push('abort')
    return { value: undefined }
  })
  on('tool.call', async ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0].question
      w.asks.push(question)
      const answer = o.ask ?? 'Approve'
      if (answer === 'reject') return { deny: 'the dialog was dismissed' }
      return { result: { answers: { [question]: answer } } }
    }
    w.toolCalls.push(e)
    w.events.push('tool:' + e.tool)
    if (o.tool !== undefined) return o.tool(e)
    return { result: 'ok', text: 'ok' }
  })
  on('session.start', () => ({ cwd: '/work/repo' }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($: any, e: any) => {
    w.prompts.push(e)
    return { text: e.text }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return w
}

export function unchanged(run: Run): Reply {
  if (run.argv.includes('--baseline')) {
    const after = fx('changes-before.json')
    after.changed = []
    return doc(after)
  }
  return doc(fx('changes-before.json'))
}

export function approveFixtures(run: Run): Reply {
  return doc(run.argv.includes('--dry-run') ? fx('approval-dry-run.json') : fx('approval-ok.json'))
}

export function dispatched(run: Run): Reply {
  return doc('MM-DISPATCH-OK d5\n')
}

export async function boot($: any, interactive = true): Promise<void> {
  await $.session.start({ surface: interactive ? 'terminal' : null, isInteractive: interactive, cwd: '/work/repo' })
}

export function runsOf(w: World, sub: string): Run[] {
  return w.runs.filter((r) => r.argv[2] === sub)
}

export function flagValue(run: Run, flag: string): string | undefined {
  const i = run.argv.indexOf(flag)
  return i >= 0 ? run.argv[i + 1] : undefined
}

// A promise the test resolves by hand.
export function gate<T = void>(): { promise: Promise<T>; open: (v: T) => void } {
  let open: (v: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

// Lets work the plugin left running unawaited settle without a clock.
export async function settle(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

export const BAD_TEXT = /undefined|null|\[object Object\]/
