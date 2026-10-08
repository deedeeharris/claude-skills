// R-28 no MM state in the mod: mm.py is reached only by argv arrays that begin with the
// configured python and mm.py, never through a shell string.
import { expect, test } from 'claude-code/testing'
import { boot, MM, PY, quietBound, world, type Run } from './harness'

const SHELL = 'echo x >> src/a.py; python mm.py status | tee $(whoami) && rm -rf "/tmp/x"'

test('when any handler runs mm.py, argv is an array beginning with the configured python and mm.py', async ($, on) => {
  const w = world(on, {
    status: quietBound(),
    changes: (run: Run) => ({
      exitCode: 0,
      stdout: JSON.stringify({ schema: 'mm.changes/1', repo_root: '/work/repo', head: null, files: {}, ...(run.argv.includes('--baseline') ? { changed: [] } : {}) }),
      stderr: '',
    }),
  })
  await boot($)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Write', file_path: '/work/repo/src/a.py', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: SHELL })
  await $.tool.call({
    tool: 'mcp__mm-runtime__dispatch', row: '#2; echo pwned', route: 'bg-it', model: 'sonnet',
    prompt_file: 'prompts/p $(id).md', worker: 'bg', launch: 'x && y {prompt}',
  } as any)
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await $.classic.SessionStart({ source: 'clear' })
  const subs = new Set(w.runs.map((r) => r.argv[2]))
  for (const sub of ['status', 'fence', 'product-changes', 'approve-dispatch', 'dispatch']) expect(subs.has(sub)).toBe(true)
  for (const run of w.runs) {
    expect(Array.isArray(run.argv)).toBe(true)
    expect(run.argv[0]).toBe(PY)
    expect(run.argv[1]).toBe(MM)
    for (const arg of run.argv) {
      expect(typeof arg).toBe('string')
      expect(arg).not.toContain('rm -rf')
    }
    for (const value of ['#2; echo pwned', 'x && y {prompt}']) {
      const joined = run.argv.join('\u0000')
      if (joined.includes(value)) expect(run.argv).toContain(value)
    }
  }
})
