// R-24 mod fence, fail-closed (matrix E, P, J): Edit, Write, MultiEdit and NotebookEdit go
// through `mm.py fence --json`; only exit 0 + mm.fence/1 + decision allow lets the call run.
import { expect, test } from 'claude-code/testing'
import { boot, doc, fx, MM, PY, runsOf, SID, world } from './harness'

const WRITE = { tool: 'Write', file_path: '/work/repo/src/a.py', content: 'print(1)\n' } as const

test('when mm.py fence answers deny, returns deny with its message and the tool does not run', async ($, on) => {
  const deny = fx('fence-deny.json')
  const w = world(on, { fence: deny })
  await boot($)
  const out = await $.tool.call(WRITE)
  expect(out).toEqual({ deny: deny.messages[0] })
  expect(w.toolCalls).toEqual([])
})

test('when mm.py fence answers deny for Edit, MultiEdit and NotebookEdit, none of them runs', async ($, on) => {
  const w = world(on, { fence: fx('fence-deny.json') })
  await boot($)
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/work/repo/src/a.py', old_string: 'a', new_string: 'b' })
  const multi = await $.tool.call({
    tool: 'MultiEdit', file_path: '/work/repo/src/a.py', edits: [{ old_string: 'a', new_string: 'b' }],
  } as any)
  const nb = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/repo/n.ipynb', new_source: 'x' } as any)
  for (const out of [edit, multi, nb]) expect(typeof out.deny).toBe('string')
  expect(w.toolCalls).toEqual([])
  expect(runsOf(w, 'fence')).toHaveLength(3)
})

test('when mm.py fence answers allow, passes the call through', async ($, on) => {
  const w = world(on, { fence: fx('fence-allow.json') })
  await boot($)
  const out = await $.tool.call(WRITE)
  expect(out).toMatchObject({ result: 'ok' })
  expect(w.toolCalls.map((e) => e.tool)).toEqual(['Write'])
  const fence = runsOf(w, 'fence')
  expect(fence).toHaveLength(1)
  expect(fence[0]!.argv).toEqual([PY, MM, 'fence', '--json'])
  expect(fence[0]!.timeoutMs).toBe(15000)
})

test('when process.run rejects, returns deny naming fail-closed', async ($, on) => {
  const w = world(on, { fence: () => ({ reject: 'timed out after 15000 ms' }) })
  await boot($)
  const out = await $.tool.call(WRITE)
  expect(out.deny).toMatch(/fail closed/)
  expect(w.toolCalls).toEqual([])
})

test('when mm.py prints non-JSON, returns deny', async ($, on) => {
  const w = world(on, { fence: () => doc('Traceback (most recent call last):') })
  await boot($)
  const out = await $.tool.call(WRITE)
  expect(out.deny).toMatch(/fail closed/)
  expect(w.toolCalls).toEqual([])
})

test('when mm.py fence exits non-zero or answers another schema, returns deny', async ($, on) => {
  let n = 0
  const w = world(on, {
    fence: () => {
      n += 1
      if (n === 1) return doc(fx('fence-allow.json'), 2, 'usage')
      const other = fx('fence-allow.json')
      other.schema = 'mm.fence/2'
      return doc(other)
    },
  })
  await boot($)
  const first = await $.tool.call(WRITE)
  const second = await $.tool.call(WRITE)
  expect(first.deny).toMatch(/fail closed/)
  expect(second.deny).toMatch(/fail closed/)
  expect(w.toolCalls).toEqual([])
})

test('when the hook throws before next, the catch handler returns deny', async ($, on) => {
  const w = world(on, { sessionIdRejects: true })
  const out = await $.tool.call(WRITE)
  expect(typeof out.deny).toBe('string')
  expect(out.deny).toMatch(/fail closed/)
  expect(w.toolCalls).toEqual([])
  expect(runsOf(w, 'fence')).toEqual([])
})

test('when the call carries agentId, forwards agent_id to mm.py fence', async ($, on) => {
  const w = world(on, { fence: fx('fence-allow.json') })
  await boot($)
  const out = await $.tool.call({ ...WRITE, agentId: 'a1' } as any)
  expect(out).toMatchObject({ result: 'ok' })
  const fence = runsOf(w, 'fence')
  expect(fence).toHaveLength(1)
  const payload = JSON.parse(fence[0]!.stdin as string)
  expect(payload.hook_event_name).toBe('PreToolUse')
  expect(payload.tool_name).toBe('Write')
  expect(payload.session_id).toBe(SID)
  expect(payload.cwd).toBe('/work/repo')
  expect(payload.agent_id).toBe('a1')
  expect(payload.tool_input).toEqual({ file_path: '/work/repo/src/a.py', content: 'print(1)\n' })
})

test('when the call carries no agentId, the fence payload has no agent_id key', async ($, on) => {
  const w = world(on, { fence: fx('fence-deny.json') })
  await boot($)
  await $.tool.call(WRITE)
  const payload = JSON.parse(runsOf(w, 'fence')[0]!.stdin as string)
  expect('agent_id' in payload).toBe(false)
})

test('when the snapshot says unbound, passes through without running mm.py', async ($, on) => {
  const w = world(on, { status: fx('status-unbound.json'), fence: fx('fence-deny.json') })
  await boot($)
  const out = await $.tool.call(WRITE)
  expect(out).toMatchObject({ result: 'ok' })
  expect(runsOf(w, 'fence')).toEqual([])
})

// WPMOD-r1 F2: the unbound shortcut trusts only the current status read, never a stale snapshot
// kept after a failed refresh.
test('when the session started unbound, was bound by mm.py and the refresh failed, a product write runs mm.py fence and is denied', async ($, on) => {
  let n = 0
  const deny = fx('fence-deny.json')
  const w = world(on, {
    status: () => {
      n += 1
      return n === 1 ? doc(fx('status-unbound.json')) : doc('', 1, 'Traceback (most recent call last):')
    },
    fence: deny,
  })
  await boot($)
  await $.tool.call({ tool: 'Bash', command: 'python mm.py bind --task-dir /work/repo/.private/pm/active/t --session ' + SID })
  expect(runsOf(w, 'status')).toHaveLength(2)
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
  const out = await $.tool.call(WRITE)
  expect(out).toEqual({ deny: deny.messages[0] })
  expect(runsOf(w, 'fence')).toHaveLength(1)
  expect(w.toolCalls.map((e) => e.tool)).toEqual(['Bash'])
})

test('when the session started unbound and the refresh rejects, a product write fails closed when mm.py fence fails too', async ($, on) => {
  let n = 0
  const w = world(on, {
    status: () => {
      n += 1
      return n === 1 ? doc(fx('status-unbound.json')) : { reject: 'timed out after 20000 ms' }
    },
    fence: () => ({ reject: 'timed out after 15000 ms' }),
  })
  await boot($)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  const out = await $.tool.call(WRITE)
  expect(out.deny).toMatch(/fail closed/)
  expect(runsOf(w, 'fence')).toHaveLength(1)
  expect(w.toolCalls).toEqual([])
})
