// R-27 pane and /mm-runtime (PRD decision 1): the task pane drawn from the snapshot, the
// command that opens it, and the text fallback when the pane cannot be placed.
import { expect, test } from 'claude-code/testing'
import { paneLines } from '../hooks/present'
import { BAD_TEXT, boot, doc, fx, MM, PY, SID, world } from './harness'

const PANE = {
  plugin: 'mm-runtime',
  component: 'Pane',
  requestId: 'mm-runtime',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'mm', isFocused: true, bodyColumns: 96, placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 }, view: {},
  },
} as const

const FIXED = [
  'status-bound.json', 'status-unbound.json', 'status-unreadable.json', 'status-legacy.json',
  'status-broad.json', 'status-stale.json', 'status-ledger-invalid.json', 'status-inbox-unreadable.json',
  'status-dispatches-unreadable.json',
]
const CODES = [
  'SESSION-ID-UNUSABLE', 'BINDING-UNREADABLE', 'BINDING-LEGACY', 'TASK-DIR-MISSING', 'NO-TASK',
  'LEDGER-INVALID', 'GIT-FAILED', 'FENCE-ROOT-TOO-BROAD', 'CHECK-RAISED', 'INBOX-UNREADABLE', 'DISPATCHES-UNREADABLE',
]

async function texts(ui: any): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
}

test('when the pane is mounted for a bound snapshot, draws a Text line for every ledger row', async ($, on) => {
  world(on)
  await boot($)
  const ui = await $.ui.mount(PANE as any)
  for (const row of fx('status-bound.json').rows) {
    expect(await ui.find({ type: 'Text', text: row.id + ' ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: row.item })).toBeDefined()
  }
  const header = await ui.find({ type: 'Text', text: /^mm · / })
  expect(header?.text).toBe('mm · t · pm · attended')
  expect(header?.props.bold).toBe(true)
})

test('when the pane is mounted with a waiting row, an in-flight dispatch and a seen agent id, draws all three', async ($, on) => {
  world(on)
  await boot($)
  await $.tool.call({ tool: 'Write', file_path: '/work/repo/src/a.py', content: 'x', agentId: 'agent-7' } as any)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /#3 needs a decision/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /d4/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /agents seen this session \(historical, not live\)/ }))?.text).toContain('agent-7')
})

test('when ui.render fires for another requestId, passes to next', async ($, on) => {
  world(on)
  await boot($)
  const ui = await $.ui.mount({ ...PANE, requestId: 'another-pane' } as any)
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^mm · / })).toBeUndefined()
})

test('when /mm-runtime runs and ui.open answers isPlaced true, opens pane mm-runtime and returns no text', async ($, on) => {
  const w = world(on, { open: { isPlaced: true } })
  await boot($)
  const out = await $.command.run({ command: 'mm-runtime', args: '' } as any)
  expect(out.text).toBeUndefined()
  expect(w.opens).toHaveLength(1)
  expect(w.opens[0]).toMatchObject({ id: 'mm-runtime', title: 'mm', focus: true, closeOnEscape: true })
  expect(w.commands).toEqual([
    { name: 'mm-runtime', description: 'Show the mm task pane', argumentHint: '', immediate: true },
  ])
})

test('when ui.open answers isPlaced false, returns the pane lines as text with the reason', async ($, on) => {
  world(on, { open: { isPlaced: false, reason: 'the terminal is 90 columns wide' } })
  await boot($)
  const out = await $.command.run({ command: 'mm-runtime', args: '' } as any)
  const lines = paneLines(fx('status-bound.json'), [])
  expect(out.text).toBe(lines.map((l) => l.text).join('\n') + '\n(pane not placed: the terminal is 90 columns wide)')
})

test('when ui.open rejects, returns the pane lines as text', async ($, on) => {
  world(on, { open: 'reject' })
  await boot($)
  const out = await $.command.run({ command: 'mm-runtime', args: '' } as any)
  const lines = paneLines(fx('status-bound.json'), [])
  expect(out.text as string).toContain(lines.map((l) => l.text).join('\n'))
  expect(out.text as string).toContain('the surface refused the pane')
})

test('when one snapshot is drawn in the pane and returned as fallback text, the pane\'s Text strings equal the fallback\'s lines before the not-placed note, in order', async ($, on) => {
  world(on, { open: { isPlaced: false, reason: 'narrow' } })
  await boot($)
  await $.tool.call({ tool: 'Write', file_path: '/work/repo/src/a.py', content: 'x', agentId: 'agent-7' } as any)
  const out = await $.command.run({ command: 'mm-runtime', args: '' } as any)
  const ui = await $.ui.mount(PANE as any)
  const drawn = await texts(ui)
  const fallback = (out.text as string).split('\n')
  expect(fallback[fallback.length - 1]).toBe('(pane not placed: narrow)')
  expect(drawn).toEqual(fallback.slice(0, -1))
  for (const t of [...drawn, ...fallback]) expect(t).not.toMatch(BAD_TEXT)
})

test('when paneLines runs, every entry has a string text and dim is a boolean or absent', () => {
  for (const name of FIXED) {
    const lines = paneLines(fx(name), ['agent-1'])
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(typeof line.text).toBe('string')
      expect(line.dim === undefined || typeof line.dim === 'boolean').toBe(true)
    }
    expect(lines.filter((l) => l.dim === true).every((l) => l.text.startsWith('check'))).toBe(true)
  }
})

test('when the session is unbound, returns not-bound text and calls no ui.open', async ($, on) => {
  const w = world(on, { status: fx('status-unbound.json') })
  await boot($)
  const out = await $.command.run({ command: 'mm-runtime', args: '' } as any)
  expect(out).toEqual({ text: 'mm-runtime: this session is not bound to an MM task' })
  expect(w.opens).toEqual([])
})

test('when a refresh lands, calls ui.invalidate for ui.render', async ($, on) => {
  const w = world(on)
  await boot($)
  expect(w.invalidations).toContain('ui.render')
  const n = w.invalidations.length
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(w.invalidations.length).toBeGreaterThan(n)
})

test('when the pane is mounted for the unreadable-binding document, draws the no-task header and the BINDING-UNREADABLE line naming unbind and bind', async ($, on) => {
  world(on, { status: fx('status-unreadable.json') })
  await boot($)
  const ui = await $.ui.mount(PANE as any)
  const drawn = await texts(ui)
  expect(drawn[0]).toBe('mm · no task · pm · no mode')
  expect(drawn[1]).toMatch(/^BINDING-UNREADABLE: .*mm\.py unbind --session .*mm\.py bind --task-dir/)
  expect(drawn).toContain('rows: none')
  expect(drawn).toContain('inbox: unavailable')
  expect(drawn).toContain('loop: unavailable')
  expect(drawn).toContain('uncommitted: unavailable')
  for (const t of drawn) expect(t).not.toMatch(BAD_TEXT)
})

test('when the pane is mounted for the stale-binding document, draws the TASK-DIR-MISSING line naming unbind', async ($, on) => {
  world(on, { status: fx('status-stale.json') })
  await boot($)
  const ui = await $.ui.mount(PANE as any)
  const drawn = await texts(ui)
  expect(drawn[1]).toMatch(/^TASK-DIR-MISSING: .*mm\.py unbind --session/)
})

test('when the pane is mounted for the legacy and broad-root documents, draws the BINDING-LEGACY line naming bind and the FENCE-ROOT-TOO-BROAD line naming unbind above the rows', () => {
  const legacy = paneLines(fx('status-legacy.json'), []).map((l) => l.text)
  expect(legacy[1]).toMatch(/^BINDING-LEGACY: .*mm\.py bind --task-dir/)
  expect(legacy.findIndex((t) => t.includes('#1 '))).toBeGreaterThan(1)
  const broad = paneLines(fx('status-broad.json'), []).map((l) => l.text)
  expect(broad[1]).toMatch(/^FENCE-ROOT-TOO-BROAD: .*mm\.py unbind --session/)
  expect(broad.findIndex((t) => t.includes('#1 '))).toBeGreaterThan(1)
})

test('when the pane is mounted for the legacy document through the plugin, draws the error line above the rows', async ($, on) => {
  world(on, { status: fx('status-legacy.json') })
  await boot($)
  const ui = await $.ui.mount(PANE as any)
  const drawn = await texts(ui)
  expect(drawn[1]).toMatch(/^BINDING-LEGACY: /)
})

test('when paneLines runs on each §2.2 fixed document and on a document carrying each error code with task, inbox, loop and open_row null, it returns without throwing and no text contains undefined, null or [object Object]', () => {
  const docs: any[] = FIXED.map((name) => fx(name))
  for (const code of CODES) {
    const d = fx('status-bound.json')
    d.ok = false
    d.errors = [{ code, message: code + ': the recovery instruction' }]
    d.task = null
    d.inbox = null
    d.loop = null
    d.open_row = null
    d.mode = null
    d.uncommitted = null
    docs.push(d)
  }
  for (const d of docs) {
    let lines: { text: string; dim?: boolean }[] = []
    expect(() => {
      lines = paneLines(d, ['agent-1'])
    }).not.toThrow()
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.text).not.toMatch(BAD_TEXT)
  }
})

test('when /mm-runtime runs with no valid snapshot, returns the status-unavailable text and calls no ui.open', async ($, on) => {
  const w = world(on, { status: () => doc('not json at all') })
  await boot($)
  const out = await $.command.run({ command: 'mm-runtime', args: '' } as any)
  expect(out.text as string).toMatch(/^mm-runtime: mm status is unavailable \(.+\); run /)
  expect(out.text as string).toContain(PY + ' ' + MM + ' status --json --session ' + SID + ' to see why')
  expect(w.opens).toEqual([])
})
