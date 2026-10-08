// R-22 status line mapping (matrix A, Q): hooks/present.ts statusLine, and the line the
// plugin pins from each snapshot.
import { expect, test } from 'claude-code/testing'
import { readStatus, statusLine } from '../hooks/present'
import { BAD_TEXT, boot, doc, fx, quietBound, world } from './harness'

const OK = 'MM · t · PM · ATTENDED · row #2 IMPLEMENTING · inbox 2 · builders 1 · waiting 1'
const CODES = [
  'SESSION-ID-UNUSABLE', 'BINDING-UNREADABLE', 'BINDING-LEGACY', 'TASK-DIR-MISSING', 'NO-TASK',
  'LEDGER-INVALID', 'GIT-FAILED', 'FENCE-ROOT-TOO-BROAD', 'CHECK-RAISED', 'INBOX-UNREADABLE', 'DISPATCHES-UNREADABLE',
]

function withError(base: any, code: string): any {
  base.ok = false
  base.errors = [{ code, message: code + ' happened: the recovery instruction' }]
  return base
}

function nulled(code: string): any {
  const d = withError(fx('status-bound.json'), code)
  d.task = null
  d.inbox = null
  d.loop = null
  d.open_row = null
  d.uncommitted = null
  d.mode = null
  return d
}

test('when the snapshot is the ok bound document, the status line reads task, PM, mode, row, inbox, builders and waiting', () => {
  expect(statusLine(fx('status-bound.json'), 0)).toBe(OK)
})

test('when the task is unattended, the status line reads AUTO and the no-op count', () => {
  const d = fx('status-bound.json')
  d.mode = 'unattended'
  d.loop.mode = 'unattended'
  d.loop.noop_count = 1
  expect(statusLine(d, 0)).toBe('MM · t · PM · AUTO · row #2 IMPLEMENTING · inbox 2 · builders 1 · waiting 1 · no-op 1/3')
})

test('when open_row and inbox are null, the status line omits row and inbox', () => {
  const d = quietBound()
  d.open_row = null
  d.inbox = null
  expect(statusLine(d, 0)).toBe('MM · t · PM · ATTENDED · builders 0 · waiting 1')
})

test('when check status is failed, the status line reads CHECK FAILED with the exit code', () => {
  const d = fx('status-bound.json')
  d.check = { status: 'failed', code: 1, lines: ['FAIL something'] }
  expect(statusLine(d, 0)).toBe('MM · t · CHECK FAILED (exit 1)')
})

test('when check status is fixable, the status line appends check fixable to the ok form', () => {
  const d = fx('status-bound.json')
  d.check = { status: 'fixable', code: 3, lines: ['FIX something'] }
  expect(statusLine(d, 0)).toBe(OK + ' · check fixable')
})

test('when a boundary warning is pending, the status line carries the BOUNDARY prefix', () => {
  expect(statusLine(fx('status-bound.json'), 2)).toBe('MM · BOUNDARY 2 files · ' + OK)
})

test('when the snapshot is missing, the status line reads STATUS UNAVAILABLE', () => {
  expect(statusLine(undefined, 0)).toBe('MM · STATUS UNAVAILABLE')
})

test('when mm.py status prints non-JSON, readStatus gives a reason and no snapshot', () => {
  const read = readStatus({ exitCode: 0, stdout: 'Traceback (most recent call last):', stderr: '' })
  expect(read.snapshot).toBeUndefined()
  expect(typeof read.reason).toBe('string')
})

test('when the snapshot schema is mm.status/2, the status line reads STATUS UNAVAILABLE', async ($, on) => {
  const d = fx('status-bound.json')
  d.schema = 'mm.status/2'
  const w = world(on, { status: d })
  await boot($)
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
})

test('when status process.run rejects, the status line reads STATUS UNAVAILABLE', async ($, on) => {
  const w = world(on, { status: () => ({ reject: 'could not start' }) })
  await boot($)
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
})

test('when mm.py status exits non-zero, the status line reads STATUS UNAVAILABLE', async ($, on) => {
  const w = world(on, { status: () => doc('', 2, 'usage: mm.py status') })
  await boot($)
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · STATUS UNAVAILABLE')
})

test('when the snapshot is the unbound document, the status line is removed', async ($, on) => {
  const w = world(on, { status: fx('status-unbound.json') })
  await boot($)
  expect(w.statuses.length).toBeGreaterThan(0)
  expect(w.statuses[w.statuses.length - 1]).toBeUndefined()
  expect(statusLine(fx('status-unbound.json'), 0)).toBeUndefined()
})

test('when the snapshot is the unreadable-binding document, the status line reads BINDING UNREADABLE naming unbind and bind', async ($, on) => {
  const d = fx('status-unreadable.json')
  expect(d.task).toBeNull()
  expect(d.inbox).toBeNull()
  expect(d.loop).toBeNull()
  const w = world(on, { status: d })
  await boot($)
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · PM · BINDING UNREADABLE: mm.py unbind, then bind')
})

test('when the snapshot is the stale-binding document, the status line reads TASK FOLDER MISSING with the folder name', () => {
  const d = fx('status-stale.json')
  d.task.dir = '/work/repo/.private/pm/active/moved-task'
  expect(statusLine(d, 0)).toBe('MM · moved-task · PM · TASK FOLDER MISSING: mm.py unbind')
  expect(statusLine(fx('status-stale.json'), 0)).toBe('MM · t · PM · TASK FOLDER MISSING: mm.py unbind')
})

test('when the snapshot is the legacy-binding document, the status line reads REBIND NEEDED', () => {
  expect(statusLine(fx('status-legacy.json'), 0)).toBe('MM · t · PM · REBIND NEEDED: mm.py bind')
})

test('when the snapshot is the broad-root document, the status line reads FENCE ROOT TOO BROAD', () => {
  expect(statusLine(fx('status-broad.json'), 0)).toBe('MM · t · PM · FENCE ROOT TOO BROAD: mm.py unbind')
})

test('when the snapshot is the invalid-ledger document, the status line reads LEDGER INVALID', () => {
  expect(statusLine(fx('status-ledger-invalid.json'), 0)).toBe('MM · t · LEDGER INVALID: mm.py check')
})

test('when git failed, check raised, no task or the session id is unusable, each status line names its recovery', () => {
  expect(statusLine(withError(fx('status-bound.json'), 'GIT-FAILED'), 0)).toBe('MM · t · GIT FAILED: fix git')
  expect(statusLine(withError(fx('status-bound.json'), 'CHECK-RAISED'), 0)).toBe('MM · t · CHECK RAISED: mm.py check')
  expect(statusLine(withError(fx('status-unbound.json'), 'NO-TASK'), 0)).toBe('MM · NO TASK: mm.py bind')
  expect(statusLine(withError(fx('status-unbound.json'), 'SESSION-ID-UNUSABLE'), 0)).toBe(
    'MM · SESSION ID UNUSABLE: see /mm-runtime',
  )
})

test('when several errors are present, the first in precedence order is shown with the count of the rest', () => {
  const d = fx('status-legacy.json')
  d.errors = [{ code: 'GIT-FAILED', message: 'git failed: fix git' }, ...d.errors]
  expect(statusLine(d, 0)).toBe('MM · t · PM · REBIND NEEDED: mm.py bind · +1 more')
})

test('when a document has task, inbox, loop and open_row null and an error code, the status line names the code and contains no undefined, null or [object Object]', () => {
  const short: Record<string, string> = {
    'SESSION-ID-UNUSABLE': 'SESSION ID UNUSABLE', 'BINDING-UNREADABLE': 'BINDING UNREADABLE',
    'BINDING-LEGACY': 'REBIND NEEDED', 'TASK-DIR-MISSING': 'TASK FOLDER MISSING', 'NO-TASK': 'NO TASK',
    'LEDGER-INVALID': 'LEDGER INVALID', 'GIT-FAILED': 'GIT FAILED', 'FENCE-ROOT-TOO-BROAD': 'FENCE ROOT TOO BROAD',
    'CHECK-RAISED': 'CHECK RAISED', 'INBOX-UNREADABLE': 'INBOX-UNREADABLE: see /mm-runtime',
    'DISPATCHES-UNREADABLE': 'DISPATCHES-UNREADABLE: see /mm-runtime',
  }
  for (const code of CODES) {
    let line: string | undefined
    expect(() => {
      line = statusLine(nulled(code), 0)
    }).not.toThrow()
    expect(typeof line).toBe('string')
    expect(line as string).toContain(short[code] as string)
    expect(line as string).not.toMatch(BAD_TEXT)
  }
})

test('when check fails, no process.run argv contains repair or compile', async ($, on) => {
  const d = fx('status-bound.json')
  d.check = { status: 'failed', code: 1, lines: ['FAIL something'] }
  const w = world(on, { status: d })
  await boot($)
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
  await $.tool.call({ tool: 'Bash', command: 'python mm.py check --task-dir x' })
  expect(w.statuses[w.statuses.length - 1]).toBe('MM · t · CHECK FAILED (exit 1)')
  expect(w.runs.length).toBeGreaterThan(0)
  for (const run of w.runs) {
    expect(run.argv.join(' ')).not.toMatch(/repair|compile/)
  }
})
