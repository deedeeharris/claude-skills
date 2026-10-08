// R-21 session start and re-init (matrix A, R).
import { expect, test } from 'claude-code/testing'
import { boot, fx, MARKER, runsOf, SID, world, flagValue } from './harness'

test('when the session starts bound, sets MM_CC_RUNTIME_MOD_ACTIVE to the session id and pins the status line', async ($, on) => {
  const w = world(on)
  await boot($)
  expect(w.envSets).toEqual([{ name: MARKER, value: SID }])
  expect(runsOf(w, 'status')).toHaveLength(1)
  expect(flagValue(runsOf(w, 'status')[0]!, '--session')).toBe(SID)
  expect(w.statuses[w.statuses.length - 1]).toBe(
    'MM · t · PM · ATTENDED · row #2 IMPLEMENTING · inbox 2 · builders 1 · waiting 1',
  )
})

test('when the session starts unbound, removes the status line and still sets the marker', async ($, on) => {
  const w = world(on, { status: fx('status-unbound.json') })
  await boot($)
  expect(w.envSets).toEqual([{ name: MARKER, value: SID }])
  expect(w.statuses.length).toBeGreaterThan(0)
  expect(w.statuses[w.statuses.length - 1]).toBeUndefined()
})

test('when classic SessionStart fires after clear, re-reads the session id and refreshes', async ($, on) => {
  const w = world(on, { sessionIds: [SID, 'ffffffff-0000-4000-8000-000000000002'] })
  await boot($)
  await $.classic.SessionStart({ source: 'clear' })
  expect(w.sessionIdCalls).toBe(2)
  expect(w.envSets).toEqual([
    { name: MARKER, value: SID },
    { name: MARKER, value: 'ffffffff-0000-4000-8000-000000000002' },
  ])
  const status = runsOf(w, 'status')
  expect(status).toHaveLength(2)
  expect(flagValue(status[1]!, '--session')).toBe('ffffffff-0000-4000-8000-000000000002')
})
