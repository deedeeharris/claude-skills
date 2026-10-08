// R-21, run only against the unconfigured copy (hooks/mm-config.ts empty, as in the source).
import { expect, test } from 'claude-code/testing'
import { boot, world } from './harness'

test('when mm-config is empty, sets "MM runtime: not configured" and passes every tool call through', async ($, on) => {
  const w = world(on)
  await boot($)
  expect(w.statuses).toEqual(['MM runtime: not configured'])
  const write = await $.tool.call({ tool: 'Write', file_path: '/work/repo/src/a.py', content: 'x' })
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/work/repo/src/a.py', old_string: 'x', new_string: 'y' })
  const bash = await $.tool.call({ tool: 'Bash', command: 'python mm.py status' })
  const worker = await $.tool.call({ tool: 'Write', file_path: '/work/repo/src/b.py', content: 'x', agentId: 'a1' } as any)
  for (const out of [write, edit, bash, worker]) expect(out).toMatchObject({ result: 'ok' })
  expect(w.toolCalls.map((e) => e.tool)).toEqual(['Write', 'Edit', 'Bash', 'Write'])
  expect(w.runs).toEqual([])
  expect(w.tools).toEqual([])
})
