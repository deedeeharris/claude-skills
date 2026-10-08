// WPMOD-r1 F1: an mm.py older than this plugin (no `status --json`) is detected positively from
// the status read and puts the plugin in incompatible mode: the handlers pass through, so the
// portable guard.py classic hook stays the fence, and the dispatch tool refuses. Every other
// status failure keeps the mod fence fail-closed.
import { expect, test } from 'claude-code/testing'
import { boot, doc, runsOf, world, type Reply } from './harness'

const LINE = 'MM runtime: mm.py too old for this plugin (needs status --json); reinstall the plugin from the current skill'
const WRITE = { tool: 'Write', file_path: '/work/repo/src/a.py', content: 'print(1)\n' } as const
const DISPATCH = {
  tool: 'mcp__mm-runtime__dispatch', row: '#2', route: 'bg-it', model: 'sonnet', prompt_file: '/work/repo/prompts/p.md', worker: 'bg',
}

// What an r25 mm.py prints for the argv this plugin sends (captured from the r25 skill's mm.py).
const OLD_FENCE: Reply = {
  exitCode: 2, stdout: '',
  stderr: "usage: mm.py [-h] [--version] <command> ...\nmm.py: error: argument <command>: invalid choice: 'fence' (choose from scaffold, add-row, status)\n",
}

const TOO_OLD: [string, Reply][] = [
  ['status requires --task-dir', {
    exitCode: 2, stdout: '',
    stderr: 'usage: mm.py status [-h] --task-dir TASK_DIR\nmm.py status: error: the following arguments are required: --task-dir\n',
  }],
  ['unrecognized arguments', {
    exitCode: 2, stdout: '',
    stderr: 'usage: mm.py [-h] [--version] <command> ...\nmm.py: error: unrecognized arguments: --json --session x\n',
  }],
  ['invalid choice', {
    exitCode: 2, stdout: '',
    stderr: "usage: mm.py [-h] [--version] <command> ...\nmm.py: error: argument <command>: invalid choice: 'status' (choose from scaffold, add-row)\n",
  }],
  ['a document of another schema with exit 2', doc({ schema: 'mm.where/1', ok: false }, 2)],
]

const OTHER_FAILURES: [string, () => Reply][] = [
  ['exit 1 with a traceback', () => ({ exitCode: 1, stdout: '', stderr: 'Traceback (most recent call last):\n  File "mm.py"\n' })],
  ['exit 2 without an argparse usage error', () => ({ exitCode: 2, stdout: '', stderr: 'mm.py: the ledger could not be read\n' })],
  ['exit 2 with a malformed mm.status/1 document', () => doc({ schema: 'mm.status/1' }, 2)],
  ['exit 0 with non-JSON output', () => doc('Traceback (most recent call last):')],
  ['a process.run rejection (timeout)', () => ({ reject: 'timed out after 20000 ms' })],
]

for (const [name, reply] of TOO_OLD) {
  test('when mm.py status answers ' + name + ', the status line says mm.py is too old for this plugin', async ($, on) => {
    const w = world(on, { status: () => reply, fence: () => OLD_FENCE })
    await boot($)
    expect(w.statuses[w.statuses.length - 1]).toBe(LINE)
  })

  test('when mm.py status answers ' + name + ', a Write passes through without running mm.py fence', async ($, on) => {
    const w = world(on, { status: () => reply, fence: () => OLD_FENCE })
    await boot($)
    const out = await $.tool.call(WRITE)
    expect(out).toMatchObject({ result: 'ok' })
    expect(w.toolCalls.map((e) => e.tool)).toEqual(['Write'])
    expect(runsOf(w, 'fence')).toEqual([])
  })
}

test('when mm.py is too old, Edit, NotebookEdit, a worker Write and a PM Bash call pass through with no fence or product-changes run', async ($, on) => {
  const w = world(on, { status: () => TOO_OLD[0]![1], fence: () => OLD_FENCE })
  await boot($)
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/work/repo/src/a.py', old_string: 'a', new_string: 'b' })
  const nb = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/repo/n.ipynb', new_source: 'x' } as any)
  const worker = await $.tool.call({ ...WRITE, agentId: 'a1' } as any)
  const bash = await $.tool.call({ tool: 'Bash', command: 'echo x > src/new.py' })
  for (const out of [edit, nb, worker, bash]) expect(out).toMatchObject({ result: 'ok' })
  expect(w.toolCalls.map((e) => e.tool)).toEqual(['Edit', 'NotebookEdit', 'Write', 'Bash'])
  expect(runsOf(w, 'fence')).toEqual([])
  expect(runsOf(w, 'product-changes')).toEqual([])
})

test('when mm.py is too old, the dispatch tool returns deny naming the incompatibility and runs no approve-dispatch or dispatch', async ($, on) => {
  const w = world(on, { status: () => TOO_OLD[0]![1], fence: () => OLD_FENCE })
  await boot($)
  const out = await $.tool.call(DISPATCH as any)
  expect(typeof out.deny).toBe('string')
  expect(out.deny).toMatch(/mm\.py too old for this plugin/)
  expect(out.deny).toMatch(/reinstall the plugin from the current skill/)
  expect(runsOf(w, 'approve-dispatch')).toEqual([])
  expect(runsOf(w, 'dispatch')).toEqual([])
  expect(w.asks).toEqual([])
})

test('when mm.py is too old, /mm-runtime answers the incompatibility text and opens no pane', async ($, on) => {
  const w = world(on, { status: () => TOO_OLD[0]![1] })
  await boot($)
  const out = await $.command.run({ command: 'mm-runtime', args: '' } as any)
  expect(out.text).toMatch(/mm\.py too old for this plugin/)
  expect(w.opens).toEqual([])
})

for (const [name, reply] of OTHER_FAILURES) {
  test('when mm.py status fails with ' + name + ', the status line reads STATUS UNAVAILABLE and the fence still runs and denies', async ($, on) => {
    const w = world(on, { status: reply, fence: () => OLD_FENCE })
    await boot($)
    expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
    const out = await $.tool.call(WRITE)
    expect(typeof out.deny).toBe('string')
    expect(out.deny).toMatch(/fail closed/)
    expect(runsOf(w, 'fence')).toHaveLength(1)
    expect(w.toolCalls).toEqual([])
  })
}

test('when mm.py was too old and a later status read fails another way, the fence runs again and denies', async ($, on) => {
  let n = 0
  const w = world(on, {
    status: () => {
      n += 1
      return n === 1 ? TOO_OLD[0]![1] : { reject: 'timed out after 20000 ms' }
    },
    fence: () => OLD_FENCE,
  })
  await boot($)
  expect((await $.tool.call(WRITE)) as any).toMatchObject({ result: 'ok' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'turn-1', reason: 'answer' } as any)
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
  const out = await $.tool.call(WRITE)
  expect(out.deny).toMatch(/fail closed/)
  expect(runsOf(w, 'fence')).toHaveLength(1)
})

test('when mm.py is too old, the session start still registers the dispatch tool and sets the marker', async ($, on) => {
  const w = world(on, { status: () => TOO_OLD[0]![1] })
  await boot($)
  expect(w.tools.map((t) => t.name)).toEqual(['dispatch'])
  expect(w.envSets.map((s) => s.name)).toEqual(['MM_CC_RUNTIME_MOD_ACTIVE'])
})
