// R-23 refresh triggers (F5): session.start, classic.SessionStart, turn.complete, after
// every dispatch tool call, after every Bash or PowerShell call whose command contains mm.py.
import { expect, mock, test } from 'claude-code/testing'
import { boot, doc, fx, gate, runsOf, world } from './harness'

test('when a Bash command contains mm.py, runs status --json after the call', async ($, on) => {
  const w = world(on)
  await boot($)
  expect(runsOf(w, 'status')).toHaveLength(1)
  await $.tool.call({ tool: 'Bash', command: 'python scripts/mm.py status --task-dir x' })
  const status = runsOf(w, 'status')
  expect(status).toHaveLength(2)
  expect(status[1]!.argv.slice(2, 4)).toEqual(['status', '--json'])
  expect(w.events.lastIndexOf('run:status')).toBeGreaterThan(w.events.indexOf('tool:Bash'))
})

test('when a PowerShell command contains mm.py, runs status --json after the call', async ($, on) => {
  const w = world(on)
  await boot($)
  await $.tool.call({ tool: 'PowerShell', command: '& py mm.py check --task-dir x' } as any)
  expect(runsOf(w, 'status')).toHaveLength(2)
})

test('when a worker Bash command contains mm.py, runs status --json after the call', async ($, on) => {
  const w = world(on)
  await boot($)
  await $.tool.call({ tool: 'Bash', command: 'python mm.py inbox-scan', agentId: 'a1' } as any)
  expect(runsOf(w, 'status')).toHaveLength(2)
})

test('when a Bash command does not contain mm.py, does not refresh', async ($, on) => {
  const w = world(on)
  await boot($)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Write', file_path: '/work/repo/.private/pm/active/t/notes.md', content: 'x' })
  expect(runsOf(w, 'status')).toHaveLength(1)
})

test('when turn.complete fires, refreshes once', async ($, on) => {
  const w = world(on)
  await boot($)
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
  expect(runsOf(w, 'status')).toHaveLength(2)
})

test('when a dispatch tool call ends, refreshes once', async ($, on) => {
  const w = world(on, { status: (() => { const d = fx('status-bound.json'); d.mode = 'unattended'; return () => doc(d) })() })
  await boot($, false)
  await $.tool.call({
    tool: 'mcp__mm-runtime__dispatch', row: '#2', route: 'subagent', model: 'sonnet',
    prompt_file: 'prompts/p.md', worker: 'subagent',
  } as any)
  // one status at start, one fresh read inside the tool, one refresh after it
  expect(runsOf(w, 'status')).toHaveLength(3)
})

test('when three triggers arrive during one refresh, runs exactly one follow-up refresh', async ($, on) => {
  const clock = mock.clock(on)
  const held = gate()
  const entered = gate()
  let calls = 0
  const w = world(on, {
    status: async () => {
      calls += 1
      if (calls === 2) {
        entered.open()
        await held.promise
      }
      return doc(fx('status-bound.json'))
    },
  })
  await boot($)
  const first = $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await entered.promise
  const more = [
    $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'answer' }),
    $.turn.complete({ turnId: 't3', answer: '', durationMs: 1, isAborted: false, reason: 'answer' }),
    $.turn.complete({ turnId: 't4', answer: '', durationMs: 1, isAborted: false, reason: 'answer' }),
  ]
  await clock.settle()
  held.open()
  await Promise.all([first, ...more])
  // boot's refresh, the held one, and exactly one coalesced follow-up
  expect(runsOf(w, 'status')).toHaveLength(3)
})
