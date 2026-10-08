// R-29 closed typed-tool list (F6): exactly one $.tool.register call, name dispatch.
import { expect, test } from 'claude-code/testing'
import { boot, world } from './harness'

test('when the session starts, registers exactly one tool named dispatch', async ($, on) => {
  const w = world(on)
  await boot($)
  expect(w.tools).toHaveLength(1)
  const tool = w.tools[0]
  expect(tool.name).toBe('dispatch')
  expect(typeof tool.description).toBe('string')
  expect(tool.inputSchema.type).toBe('object')
  expect([...tool.inputSchema.required].sort()).toEqual(['model', 'prompt_file', 'route', 'row', 'worker'])
  expect(tool.inputSchema.properties.worker.enum).toEqual(['subagent', 'workflow', 'codex', 'bg', 'other'])
  expect(tool.inputSchema.properties.launch.type).toBe('string')
  expect(tool.inputSchema.properties.prompt_file.description).toMatch(/drive-relative/)
})
