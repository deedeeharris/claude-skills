// R-26 post-Bash warning (F2, F3): a PM-main-loop Bash or PowerShell call is bracketed by two
// `mm.py product-changes` reads; a change is warned about, and when attributable to the PM the tool
// result carries a stop note asking the PM to stop and ask the operator. The turn is never aborted
// (operator decision "Warn + stop note, no abort"): w.aborts must stay empty in every test.
import { expect, test } from 'claude-code/testing'
import { SID, TASK_DIR, boot, doc, flagValue, fx, gate, quietBound, runsOf, unchanged, world, type Run } from './harness'

function changes(files: string[], head?: string) {
  return (run: Run) => {
    if (!run.argv.includes('--baseline')) return doc(fx('changes-before.json'))
    const after = fx('changes-after.json')
    after.changed = files
    if (head !== undefined) after.head = head
    return doc(after)
  }
}

function warning(files: string[]): string {
  return 'MM boundary: ' + files.length + ' product files changed during a PM shell call: ' + files.join(', ')
}

function stopText(files: string[]): string {
  return 'MM boundary: product files changed during your PM shell call: ' + files.join(', ') +
    '. Stop: do not continue this task; tell the operator what changed and ask how to proceed. Do not revert anything.'
}

async function start($: any): Promise<void> {
  await boot($)
  await $.turn.start({ text: 'go on', turnId: 'turn-1' })
}

test('when a PM Bash call creates a product file, warns naming the file', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/new.py']) })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'echo x > src/new.py' })
  expect(w.toasts).toContain(warning(['src/new.py']))
  const pcs = runsOf(w, 'product-changes')
  expect(pcs).toHaveLength(2)
  expect(pcs[0]!.argv).not.toContain('--baseline')
  expect(pcs[1]!.argv).toContain('--baseline')
  expect(pcs[1]!.stdin).toBe(JSON.stringify(fx('changes-before.json')))
})

test('when a PM Bash call edits an already-dirty file, warns naming it', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/dirty.py']) })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'echo y >> src/dirty.py' })
  expect(w.toasts).toContain(warning(['src/dirty.py']))
})

test('when a PM Bash call edits and commits a product file from a clean tree, warns naming it', async ($, on) => {
  const w = world(on, {
    status: quietBound(),
    changes: (run: Run) => {
      const d = fx('changes-before.json')
      d.files = {}
      if (!run.argv.includes('--baseline')) return doc(d)
      d.head = '2222222222222222222222222222222222222222'
      d.changed = ['src/clean.py']
      return doc(d)
    },
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'echo z >> src/clean.py && git commit -am z' })
  expect(w.toasts).toContain(warning(['src/clean.py']))
})

test('when the Bash call fails after writing a file, still warns and adds the stop note', async ($, on) => {
  const w = world(on, {
    status: quietBound(), changes: changes(['src/new.py']),
    tool: () => ({ result: 'exit 1', text: 'exit 1', isError: true }),
  })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo x > src/new.py; false' })
  expect(out.isError).toBe(true)
  expect(out.context).toEqual([stopText(['src/new.py'])])
  expect(w.toasts).toContain(warning(['src/new.py']))
  expect(w.aborts).toEqual([])
})

test('when a PM Bash call changes a product file, appends the stop note context and aborts no turn', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/dirty.py', 'src/new.py']) })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(out.context).toEqual([stopText(['src/dirty.py', 'src/new.py'])])
  expect(w.aborts).toEqual([])
  expect(w.events).not.toContain('abort')
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY 2 files · MM · t · PM/)
})

test('when the result is returned, its result and text equal next\'s and only context grew', async ($, on) => {
  const answered = { result: { stdout: 'built', stderr: '' }, text: 'built', context: ['from below'] }
  world(on, { status: quietBound(), changes: changes(['src/new.py']), tool: () => answered })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(out.result).toEqual(answered.result)
  expect(out.text).toBe('built')
  expect(out.context).toEqual(['from below', stopText(['src/new.py'])])
  expect(Object.keys(out).sort()).toEqual(['context', 'result', 'text'])
})

test('when next returns deny while the product-changes snapshots changed, returns that deny object unchanged with no context key, toasts the warning, sets the BOUNDARY status prefix, queues the prompt context and aborts no turn', async ($, on) => {
  const w = world(on, {
    status: quietBound(), changes: changes(['src/new.py']), tool: () => ({ deny: 'refused by a later hook' }),
  })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo x > src/new.py' })
  expect(out).toEqual({ deny: 'refused by a later hook' })
  expect('context' in out).toBe(false)
  expect(w.toasts).toContain(warning(['src/new.py']))
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY 1 files · /)
  expect(w.aborts).toEqual([])
  await $.prompt.submit({ text: 'what happened?' } as any)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0].context).toEqual([warning(['src/new.py'])])
  await $.prompt.submit({ text: 'and now?' } as any)
  expect(w.prompts[1].context).toBeUndefined()
})

test('when no turn.start was seen, still returns the stop note context, toasts only the boundary warning and aborts no turn', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/new.py']) })
  await boot($)
  const out = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(out.context).toEqual([stopText(['src/new.py'])])
  expect(w.aborts).toEqual([])
  expect(w.toasts).toEqual([warning(['src/new.py'])])
})

test('when a worker Write lands during the PM Bash window, warns UNCERTAIN, aborts no turn and returns the Bash result unchanged', async ($, on) => {
  const entered = gate()
  const held = gate()
  const bashAnswer = { result: 'ran', text: 'ran' }
  const w = world(on, {
    status: quietBound(),
    changes: changes(['src/w.py']),
    tool: async (e: any) => {
      if (e.tool !== 'Bash') return { result: 'written', text: 'written' }
      entered.open()
      await held.promise
      return bashAnswer
    },
  })
  await start($)
  const pending = $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  await entered.promise
  await $.tool.call({ tool: 'Write', file_path: '/work/repo/src/w.py', content: 'x', agentId: 'a1' } as any)
  held.open()
  const out = await pending
  expect(out).toEqual(bashAnswer)
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/w.py'])))
  expect(warned).toBeDefined()
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('/work/repo/src/w.py')
  expect(w.toolCalls.map((e) => e.tool)).toEqual(['Bash', 'Write'])
})

test('when a slow worker Write starts before the PM Bash call and returns inside its window, warns UNCERTAIN naming the in-progress worker call, aborts no turn and returns the Bash result unchanged', async ($, on) => {
  const workerEntered = gate()
  const workerHeld = gate()
  const workerDone = gate()
  const baselineTaken = gate()
  const bashAnswer = { result: 'ran', text: 'ran' }
  const w = world(on, {
    status: quietBound(),
    changes: (run: Run) => {
      if (!run.argv.includes('--baseline')) baselineTaken.open()
      return changes(['src/w.py'])(run)
    },
    tool: async (e: any) => {
      if (e.tool === 'Write') {
        workerEntered.open()
        await workerHeld.promise
        return { result: 'written', text: 'written' }
      }
      await workerDone.promise
      return bashAnswer
    },
  })
  await start($)
  const worker = $.tool.call({ tool: 'Write', file_path: '/work/repo/src/w.py', content: 'x', agentId: 'a1' } as any)
  await workerEntered.promise
  const bash = $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  await baselineTaken.promise
  workerHeld.open()
  await worker
  workerDone.open()
  const out = await bash
  expect(out).toEqual(bashAnswer)
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/w.py'])))
  expect(warned).toBeDefined()
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('already in progress')
  expect(warned as string).toContain('Write /work/repo/src/w.py')
})

test('when two PM shell windows overlap, both warnings say UNCERTAIN', async ($, on) => {
  const aEntered = gate()
  const aHeld = gate()
  const w = world(on, {
    status: quietBound(),
    changes: changes(['src/x.py']),
    tool: async (e: any) => {
      if (e.command === 'first') {
        aEntered.open()
        await aHeld.promise
      }
      return { result: e.command, text: e.command }
    },
  })
  await start($)
  const first = $.tool.call({ tool: 'Bash', command: 'first' })
  await aEntered.promise
  const second = await $.tool.call({ tool: 'PowerShell', command: 'second' } as any)
  aHeld.open()
  const firstOut = await first
  expect(firstOut).toEqual({ result: 'first', text: 'first' })
  expect(second).toEqual({ result: 'second', text: 'second' })
  const warnings = w.toasts.filter((t) => t.startsWith(warning(['src/x.py'])))
  expect(warnings).toHaveLength(2)
  for (const t of warnings) expect(t).toContain('; UNCERTAIN: ')
  expect(w.aborts).toEqual([])
})

test('when the snapshot lists in-flight dispatches, the warning says UNCERTAIN and nothing is stopped', async ($, on) => {
  const w = world(on, { status: fx('status-bound.json'), changes: changes(['src/new.py']) })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/new.py'])))
  expect(warned as string).toContain('d4')
  expect(w.aborts).toEqual([])
})

test('when the Bash call carries agentId, runs no product-changes', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/new.py']) })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'a1' } as any)
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(runsOf(w, 'product-changes')).toEqual([])
  expect(w.toasts).toEqual([])
})

test('when the snapshot is unbound, a PM Bash call runs no product-changes', async ($, on) => {
  const w = world(on, { status: fx('status-unbound.json'), changes: changes(['src/new.py']) })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(runsOf(w, 'product-changes')).toEqual([])
})

// WPMOD-r2 F2: a failed snapshot is never read as "no changes".
function refusal(why: string): string {
  return 'mm-runtime: cannot snapshot product files before this PM shell call (' + why +
    '), so it is refused (fail closed). Fix git for /work/repo, or delegate the command to a worker, or leave PM mode: mm.py unbind --session ' + SID
}

test('when the baseline product-changes fails, refuses the PM shell call without running it (fail closed)', async ($, on) => {
  let n = 0
  const w = world(on, {
    status: quietBound(),
    changes: () => {
      n += 1
      return n === 1 ? doc('', 21, 'mm.py product-changes: git failed') : doc('not json')
    },
  })
  await start($)
  const first = await $.tool.call({ tool: 'Bash', command: 'echo x > src/a.py' })
  const second = await $.tool.call({ tool: 'PowerShell', command: 'Set-Content src/a.py x' } as any)
  expect(first).toEqual({ deny: refusal('mm.py product-changes exited 21: mm.py product-changes: git failed') })
  expect(second).toEqual({ deny: refusal('mm.py product-changes printed no JSON') })
  expect(w.toolCalls).toEqual([])
  expect(runsOf(w, 'product-changes')).toHaveLength(2)
  expect(w.aborts).toEqual([])
})

function afterFails(why: string) {
  return (run: Run) => (run.argv.includes('--baseline') ? doc('', 21, why) : doc(fx('changes-before.json')))
}

test('when the after product-changes fails, returns the Bash result with the stop note context, toasts BOUNDARY MONITOR FAILED, sets its status prefix, queues the prompt context and aborts no turn', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: afterFails('git index locked') })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(out.result).toBe('ok')
  expect(out.text).toBe('ok')
  const context = out.context as readonly string[]
  expect(context).toHaveLength(1)
  expect(context[0] as string).toStartWith('MM boundary monitor failed: ')
  expect(context[0] as string).toContain('git index locked')
  expect(context[0] as string).toContain('Stop: do not continue this task; tell the operator')
  expect(context[0] as string).toContain('Do not revert anything.')
  const warned = w.toasts.find((t) => t.startsWith('MM boundary monitor failed: '))
  expect(warned as string).toContain('mm.py product-changes exited 21: git index locked')
  expect(warned as string).not.toContain('UNCERTAIN')
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY MONITOR FAILED · MM · t · PM/)
  expect(w.aborts).toEqual([])
  await $.prompt.submit({ text: 'what happened?' } as any)
  expect(w.prompts[0].context).toEqual([warned])
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · t · PM/)
})

test('when the after product-changes fails during an UNCERTAIN window, warns BOUNDARY MONITOR FAILED and UNCERTAIN, aborts no turn and returns the Bash result unchanged', async ($, on) => {
  const w = world(on, { status: fx('status-bound.json'), changes: afterFails('git index locked') })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  const warned = w.toasts.find((t) => t.startsWith('MM boundary monitor failed: '))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY MONITOR FAILED · /)
  expect(w.aborts).toEqual([])
})

test('when a boundary change is found, runs no process.run other than product-changes', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/a.py']) })
  await start($)
  const before = w.runs.length
  await $.tool.call({ tool: 'Bash', command: 'echo x >> src/a.py' })
  const during = w.runs.slice(before)
  expect(during.map((r) => r.argv[2])).toEqual(['product-changes', 'product-changes'])
  expect(w.toolCalls.map((e) => e.tool)).toEqual(['Bash'])
})

// WPMOD-r1 F3 (superseded in r4): no turn is ever aborted, whichever turns started.
test('when a subagent turn.start follows the PM turn.start, a PM boundary change adds the stop note and aborts no turn', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/new.py']) })
  await boot($)
  await $.turn.start({ text: 'go on', turnId: 'pm-turn' })
  await $.turn.start({ text: '', turnId: 'worker-turn', agentId: 'a1' } as any)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo x > src/new.py' })
  expect(out.context).toEqual([stopText(['src/new.py'])])
  expect(w.aborts).toEqual([])
})

// WPMOD-r1 F4: a shell call whose next rejects is still bracketed by the after read.
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return 'resolved'
}

test('when next rejects after the PM shell call changed product files, warns, then propagates the original rejection without an abort', async ($, on) => {
  const w = world(on, {
    status: quietBound(), changes: changes(['src/new.py']),
    tool: () => {
      throw new Error('shell transport failed')
    },
  })
  await start($)
  const worker = await rejection($.tool.call({ tool: 'Bash', command: 'true', agentId: 'a1' } as any))
  expect(worker).not.toBe('resolved')
  const pm = await rejection($.tool.call({ tool: 'Bash', command: 'echo x > src/new.py; crash' }))
  expect(pm).toBe(worker)
  const pcs = runsOf(w, 'product-changes')
  expect(pcs).toHaveLength(2)
  expect(pcs[1]!.argv).toContain('--baseline')
  expect(w.toasts).toContain(warning(['src/new.py']))
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY 1 files · /)
  expect(w.aborts).toEqual([])
})

// WPMOD-r2 F1: a background PM shell call keeps its baseline and stays watched until it is known
// finished (classic.Stop no longer lists its task) or the re-check bound is spent.
const BG = { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'Command running in background with ID: bg1' }

// The baseline read, then the after reads answer from `afters` in order, the last repeating.
function sequence(afters: string[][]) {
  let n = 0
  return (run: Run) => {
    if (!run.argv.includes('--baseline')) return doc(fx('changes-before.json'))
    const after = fx('changes-after.json')
    after.changed = afters[Math.min(n, afters.length - 1)]
    n += 1
    return doc(after)
  }
}

function complete($: any): Promise<unknown> {
  return $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

test('when a background PM Bash call writes a product file after the tool returned, the next turn.complete warns UNCERTAIN naming the file and the background shell, and nothing is stopped', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: sequence([[], ['src/a.py']]), tool: () => BG })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'sleep 1; echo x > src/a.py', run_in_background: true } as any)
  expect(out).toEqual(BG)
  expect(w.toasts).toEqual([])
  await complete($)
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/a.py'])))
  expect(warned).toBeDefined()
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('background shell')
  expect(w.aborts).toEqual([])
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY 1 files · /)
  await $.prompt.submit({ text: 'next' } as any)
  expect(w.prompts[0].context).toEqual([warned])
})

test('when a background write is found at prompt.submit, that prompt carries the UNCERTAIN warning', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: sequence([[], ['src/a.py']]), tool: () => BG })
  await start($)
  await $.tool.call({ tool: 'PowerShell', command: 'Start-Sleep 1; Set-Content src/a.py x', run_in_background: true } as any)
  await $.prompt.submit({ text: 'anything new?' } as any)
  expect(w.prompts[0].context).toHaveLength(1)
  expect(w.prompts[0].context[0]).toStartWith(warning(['src/a.py']))
  expect(w.prompts[0].context[0]).toContain('background shell')
  expect(w.aborts).toEqual([])
})

test('when the result carries backgroundTaskId without run_in_background, the window stays open and the next turn.complete warns UNCERTAIN', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: sequence([[], ['src/a.py']]), tool: () => BG })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'make long' })
  await complete($)
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/a.py'])))
  expect(warned as string).toContain('background shell')
  expect(w.aborts).toEqual([])
})

test('when a later PM shell call runs while a background one is pending, re-checks the background baseline first and the later call warns UNCERTAIN without a stop', async ($, on) => {
  const w = world(on, {
    status: quietBound(),
    changes: sequence([[], ['src/a.py'], ['src/b.py']]),
    tool: (e: any) => (e.run_in_background === true ? BG : { result: 'ok', text: 'ok' }),
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 1; echo x > src/a.py', run_in_background: true } as any)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo y > src/b.py' })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  const bg = w.toasts.find((t) => t.startsWith(warning(['src/a.py'])))
  expect(bg as string).toContain('background shell')
  const fg = w.toasts.find((t) => t.startsWith(warning(['src/b.py'])))
  expect(fg as string).toContain('; UNCERTAIN: ')
  expect(w.aborts).toEqual([])
})

test('when classic.Stop no longer lists the background task, runs one final check and closes the window', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: sequence([[]]), tool: () => BG })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true } as any)
  expect(runsOf(w, 'product-changes')).toHaveLength(2)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg1', type: 'shell', status: 'running', description: 'sleep 9' }] })
  expect(runsOf(w, 'product-changes')).toHaveLength(2)
  await complete($)
  expect(runsOf(w, 'product-changes')).toHaveLength(3)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(runsOf(w, 'product-changes')).toHaveLength(4)
  await complete($)
  await $.prompt.submit({ text: 'done?' } as any)
  await $.tool.call({ tool: 'Bash', command: 'true' })
  // the closed window adds no re-check; the last call is a fresh foreground pair
  expect(runsOf(w, 'product-changes')).toHaveLength(6)
  expect(w.toasts.filter((t) => t.includes('UNCERTAIN'))).toEqual([])
})

test('when no completion signal arrives, closes the background window after 30 re-checks and toasts that it stopped watching', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: sequence([[]]), tool: () => BG })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 9999', run_in_background: true } as any)
  for (let i = 0; i < 30; i += 1) await complete($)
  expect(runsOf(w, 'product-changes')).toHaveLength(32)
  expect(w.toasts.some((t) => t.startsWith('MM boundary: stopped watching a background PM shell call'))).toBe(true)
  await complete($)
  expect(runsOf(w, 'product-changes')).toHaveLength(32)
})

// WPMOD-r3 F1: only a current successful status read proving session.bound === false skips the
// monitor; after a failed read the handler refreshes once, and if that fails too it monitors.
// WPMOD-r4 F1: with no status snapshot the dispatch state is unknown, so the window is UNCERTAIN.
test('when the session was bound after an unbound start and the status refresh failed, a PM Bash write is monitored and warned UNCERTAIN without a stop note', async ($, on) => {
  let bound = false
  const w = world(on, {
    status: () => (bound ? doc('', 1, 'Traceback (most recent call last):') : doc(fx('status-unbound.json'))),
    changes: changes(['src/a.py']),
    tool: (e: any) => {
      if (String(e.command).includes('mm.py bind')) bound = true
      return { result: 'ok', text: 'ok' }
    },
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'python mm.py bind --task-dir ' + TASK_DIR + ' --session ' + SID })
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
  const out = await $.tool.call({ tool: 'Bash', command: 'echo x > src/a.py' })
  expect(runsOf(w, 'product-changes')).toHaveLength(2)
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/a.py'])))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('dispatch state is unknown')
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.aborts).toEqual([])
})

test('when the latest status read failed and the fresh read proves the session unbound, a PM Bash call runs no product-changes', async ($, on) => {
  let n = 0
  const w = world(on, {
    status: () => {
      n += 1
      return n === 2 ? doc('', 1, 'Traceback (most recent call last):') : doc(fx('status-unbound.json'))
    },
  })
  await start($)
  await complete($)
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(runsOf(w, 'status')).toHaveLength(3)
  expect(runsOf(w, 'product-changes')).toEqual([])
})

// WPMOD-r3 F2: snapshots anchor at the stable repository root (task.repo_root, the fence root),
// not the task folder mm.py close moves; the core's product-changes refuses a folder that is gone.
function missingTask(): any {
  const d = quietBound()
  d.ok = false
  d.task.dir_exists = false
  d.errors = [{
    code: 'TASK-DIR-MISSING',
    message: 'the task folder ' + TASK_DIR + ' was moved or closed: run mm.py unbind --session ' + SID + ', then bind the task where it now lives',
  }]
  return d
}

function core(state: { moved: boolean }, afterChanged: string[] = []) {
  return (run: Run) => {
    if (state.moved && flagValue(run, '--task-dir') === TASK_DIR) return doc('', 4, 'mm.py: no task at ' + TASK_DIR)
    return afterChanged.length === 0 ? unchanged(run) : changes(afterChanged)(run)
  }
}

test('when mm.py close moves the bound task folder, the close call is not stopped and the later PM shell call running mm.py unbind runs', async ($, on) => {
  const state = { moved: false }
  const closeCmd = 'python mm.py close --task-dir ' + TASK_DIR + ' --apply'
  const unbindCmd = 'python mm.py unbind --session ' + SID
  const w = world(on, {
    status: () => doc(state.moved ? missingTask() : quietBound()),
    changes: core(state),
    tool: (e: any) => {
      if (String(e.command).includes('mm.py close')) state.moved = true
      return { result: 'ok', text: 'ok' }
    },
  })
  await start($)
  const close = await $.tool.call({ tool: 'Bash', command: closeCmd })
  expect(close).toEqual({ result: 'ok', text: 'ok' })
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · t · PM · TASK FOLDER MISSING: mm.py unbind')
  const unbind = await $.tool.call({ tool: 'Bash', command: unbindCmd })
  expect(unbind).toEqual({ result: 'ok', text: 'ok' })
  expect(w.toolCalls.map((e) => e.command)).toEqual([closeCmd, unbindCmd])
  expect(w.aborts).toEqual([])
  expect(w.toasts).toEqual([])
  const pcs = runsOf(w, 'product-changes')
  expect(pcs).toHaveLength(4)
  for (const run of pcs) expect(flagValue(run, '--task-dir')).toBe('/work/repo')
})

test('when the bound task folder was moved, a non-mm.py PM shell call is still monitored against the repository root and a product change adds the stop note', async ($, on) => {
  const w = world(on, { status: missingTask(), changes: core({ moved: true }, ['src/a.py']) })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo x > src/a.py' })
  expect(out.context).toEqual([stopText(['src/a.py'])])
  expect(w.toasts).toContain(warning(['src/a.py']))
  expect(w.aborts).toEqual([])
  for (const run of runsOf(w, 'product-changes')) expect(flagValue(run, '--task-dir')).toBe('/work/repo')
})

test('when the baseline product-changes fails for a PM shell call running mm.py, runs it with a BOUNDARY MONITOR FAILED warning and no stop', async ($, on) => {
  const unbindCmd = 'python mm.py unbind --session ' + SID
  const w = world(on, { status: quietBound(), changes: () => doc('', 21, 'mm.py product-changes: git failed') })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: unbindCmd })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.toolCalls.map((e) => e.command)).toEqual([unbindCmd])
  const warned = w.toasts.find((t) => t.startsWith('MM boundary monitor failed: '))
  expect(warned as string).toContain('mm.py product-changes exited 21: mm.py product-changes: git failed')
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY MONITOR FAILED · /)
  expect(w.aborts).toEqual([])
  expect(runsOf(w, 'product-changes')).toHaveLength(1)
  await $.prompt.submit({ text: 'next' } as any)
  expect(w.prompts[0].context).toEqual([warned])
})

// WPMOD-r3 F3: a worker's background shell is tracked past its tool response, like a PM
// background window; while it may still run, every PM shell window is UNCERTAIN.
const WORKER_BG = {
  result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'wbg1' }, text: 'Command running in background with ID: wbg1',
}

function workerWorld(on: any, files: string[]) {
  return world(on, {
    status: quietBound(),
    changes: changes(files),
    tool: (e: any) => (e.agentId !== undefined ? WORKER_BG : { result: 'ok', text: 'ok' }),
  })
}

test('when a worker background Bash started earlier and a later PM read-only Bash sees a product change, warns UNCERTAIN naming the worker shell and aborts no turn', async ($, on) => {
  const w = workerWorld(on, ['src/worker.py'])
  await start($)
  const worker = await $.tool.call({ tool: 'Bash', command: 'sleep 5; echo x > src/worker.py', run_in_background: true, agentId: 'a1' } as any)
  expect(worker).toEqual(WORKER_BG)
  const out = await $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/worker.py'])))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('wbg1')
})

test('when a worker Bash result carries backgroundTaskId without run_in_background, a later PM Bash change is UNCERTAIN with no abort', async ($, on) => {
  const w = workerWorld(on, ['src/worker.py'])
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'make long', agentId: 'a1' } as any)
  const out = await $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.aborts).toEqual([])
  expect(w.toasts.find((t) => t.startsWith(warning(['src/worker.py']))) as string).toContain('; UNCERTAIN: ')
})

test('when classic.Stop no longer lists the worker background shell, a later PM Bash change is attributed and carries the stop note', async ($, on) => {
  const w = workerWorld(on, ['src/a.py'])
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 5', run_in_background: true, agentId: 'a1' } as any)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'wbg1', type: 'shell', status: 'running', description: 'sleep 5' }] })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  const out = await $.tool.call({ tool: 'Bash', command: 'echo x > src/a.py' })
  expect(out.context).toEqual([stopText(['src/a.py'])])
  expect(w.aborts).toEqual([])
})

test('when no completion signal arrives, the worker background shell stops making PM windows UNCERTAIN after 30 checks', async ($, on) => {
  const w = workerWorld(on, ['src/a.py'])
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 9999', run_in_background: true, agentId: 'a1' } as any)
  for (let i = 0; i < 30; i += 1) await complete($)
  await $.turn.start({ text: 'go on', turnId: 'turn-2' })
  const out = await $.tool.call({ tool: 'Bash', command: 'echo x > src/a.py' })
  expect(out.context).toEqual([stopText(['src/a.py'])])
  expect(w.aborts).toEqual([])
})

// WPMOD-r4 F1: when the dispatch state is unknown (DISPATCHES-UNREADABLE, or no status snapshot),
// every open PM window is UNCERTAIN: the change is warned about and no stop note is added.
test('WPMOD-r4 F1: when the status reports DISPATCHES-UNREADABLE, a PM read-only Bash change is UNCERTAIN with no stop note and no abort', async ($, on) => {
  const w = world(on, { status: fx('status-dispatches-unreadable.json'), changes: changes(['src/worker.py']) })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/worker.py'])))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('dispatch state is unknown')
  expect(warned as string).toContain('may come from a worker')
  await $.prompt.submit({ text: 'what happened?' } as any)
  expect(w.prompts[0].context).toEqual([warned])
})

test('WPMOD-r4 F1: when no status snapshot can be read, a PM Bash change is UNCERTAIN with no stop note and no abort', async ($, on) => {
  const w = world(on, { status: () => doc('', 1, 'Traceback (most recent call last):'), changes: changes(['src/worker.py']) })
  await start($)
  const out = await $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(runsOf(w, 'product-changes')).toHaveLength(2)
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/worker.py'])))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('dispatch state is unknown')
})

test('WPMOD-r4 F1: when a refresh during an open PM window reports DISPATCHES-UNREADABLE, that window is UNCERTAIN', async ($, on) => {
  const entered = gate()
  const held = gate()
  let unreadable = false
  const w = world(on, {
    status: () => doc(unreadable ? fx('status-dispatches-unreadable.json') : quietBound()),
    changes: changes(['src/worker.py']),
    tool: async () => {
      entered.open()
      await held.promise
      return { result: 'ok', text: 'ok' }
    },
  })
  await start($)
  const pending = $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  await entered.promise
  unreadable = true
  await $.turn.complete({ turnId: 'worker-turn', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'a1' } as any)
  held.open()
  const out = await pending
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/worker.py'])))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('dispatch state is unknown')
})

// WPMOD-r4 F2: in-flight dispatches that appear while a PM shell window is open make it UNCERTAIN.
test('WPMOD-r4 F2: when a refresh during an open PM window discovers a new in-flight dispatch, that window is UNCERTAIN naming it', async ($, on) => {
  const entered = gate()
  const held = gate()
  let flying = false
  const w = world(on, {
    status: () => {
      const d = quietBound()
      if (flying) d.dispatches_in_flight = [{ ...fx('status-bound.json').dispatches_in_flight[0], id: 'd5' }]
      return doc(d)
    },
    changes: changes(['src/worker.py']),
    tool: async () => {
      entered.open()
      await held.promise
      return { result: 'ok', text: 'ok' }
    },
  })
  await start($)
  const pending = $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  await entered.promise
  flying = true
  await $.turn.complete({ turnId: 'worker-turn', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'a1' } as any)
  held.open()
  const out = await pending
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/worker.py'])))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('d5')
})

test('WPMOD-r4 F2: when a dispatch tool call runs during an open PM window, that window is UNCERTAIN', async ($, on) => {
  const entered = gate()
  const held = gate()
  const w = world(on, {
    status: quietBound(),
    changes: changes(['src/worker.py']),
    tool: async (e: any) => {
      if (e.tool !== 'Bash') return { result: 'ok', text: 'ok' }
      entered.open()
      await held.promise
      return { result: 'ok', text: 'ok' }
    },
  })
  await start($)
  const pending = $.tool.call({ tool: 'Bash', command: 'cat README.md' })
  await entered.promise
  const dispatched = await $.tool.call({
    tool: 'mcp__mm-runtime__dispatch', row: '#2', route: 'bg-it', model: 'sonnet', prompt_file: '/work/repo/prompts/p.md', worker: 'bg',
  } as any)
  expect(String((dispatched as any).result)).toContain('MM-DISPATCH-OK d5')
  held.open()
  const out = await pending
  expect(out).toEqual({ result: 'ok', text: 'ok' })
  expect(w.aborts).toEqual([])
  const warned = w.toasts.find((t) => t.startsWith(warning(['src/worker.py'])))
  expect(warned as string).toContain('; UNCERTAIN: ')
  expect(warned as string).toContain('dispatch')
})

// WPMOD-r4 F3: a new session id (classic.SessionStart after /clear) drops the previous session's
// pending boundary warnings, status prefix and windows; the same id keeps them.
test('WPMOD-r4 F3: when classic.SessionStart brings a different session id, the pending boundary warning and BOUNDARY prefix are dropped', async ($, on) => {
  const w = world(on, {
    status: quietBound(), changes: changes(['src/old-task.py']), sessionIds: [SID, 'ffffffff-0000-4000-8000-000000000002'],
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'echo x > src/old-task.py' })
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY 1 files · /)
  await $.classic.SessionStart({ source: 'clear' })
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · t · PM/)
  await $.prompt.submit({ text: 'unrelated' } as any)
  expect(w.prompts[0].context).toBeUndefined()
})

test('WPMOD-r4 F3: when classic.SessionStart brings the same session id, the pending boundary warning and BOUNDARY prefix are kept', async ($, on) => {
  const w = world(on, { status: quietBound(), changes: changes(['src/a.py']) })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'echo x > src/a.py' })
  await $.classic.SessionStart({ source: 'resume' })
  expect(w.statuses[w.statuses.length - 1]).toMatch(/^MM · BOUNDARY 1 files · /)
  await $.prompt.submit({ text: 'what happened?' } as any)
  expect(w.prompts[0].context).toEqual([warning(['src/a.py'])])
})
