// Pure presentation of an `mm.py status --json` document (schema mm.status/1): the
// status line (R-22) and the pane lines (R-27). No `$`, no I/O. Every field is read
// defensively, so a null object never reaches a template string.

export const STATUS_SCHEMA = 'mm.status/1'

export type PaneLine = { text: string; dim?: boolean }

// A document that passed readStatus; its fields are still read through the guards below.
export type Snapshot = Record<string, unknown> & { schema: 'mm.status/1' }

// `incompatible` is set only on positive proof that mm.py predates this plugin (see readStatus).
export type StatusRead =
  | { snapshot: Snapshot; reason?: undefined; incompatible?: undefined }
  | { snapshot?: undefined; reason: string; incompatible?: boolean }

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function text(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v !== '') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fallback
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const obj = (v: unknown): Obj | undefined => (isObj(v) ? v : undefined)

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '')
  return line === undefined ? '' : line.trim().slice(0, 200)
}

// Positive proof that mm.py predates this plugin's CLI: `status --json --session <sid>` exits 2
// with an argparse usage error (r25 answers "the following arguments are required: --task-dir";
// older or newer mismatches answer "unrecognized arguments" or "invalid choice"), or exits 2
// printing a JSON document that names a schema other than mm.status/1. Anything else is not proof.
const ARGPARSE_REFUSAL = /: error: (argument <command>: invalid choice|unrecognized arguments|the following arguments are required)/

function tooOldReason(run: { exitCode: number; stdout: string; stderr: string }): string | undefined {
  if (run.exitCode !== 2) return undefined
  const refusal = run.stderr.split('\n').find((l) => ARGPARSE_REFUSAL.test(l))
  if (/^usage: /m.test(run.stderr) && refusal !== undefined) return 'mm.py status refused the arguments: ' + refusal.trim().slice(0, 200)
  try {
    const parsed: unknown = JSON.parse(run.stdout)
    if (isObj(parsed) && typeof parsed.schema === 'string' && parsed.schema !== STATUS_SCHEMA) {
      return 'mm.py status answered schema ' + parsed.schema.slice(0, 80) + ' with exit 2, not ' + STATUS_SCHEMA
    }
  } catch {
    return undefined
  }
  return undefined
}

// Reads one `mm.py status --json` run. A non-zero exit, non-JSON, another schema or a
// malformed document gives a reason and no snapshot (the STATUS UNAVAILABLE case).
export function readStatus(run: { exitCode: number; stdout: string; stderr: string }): StatusRead {
  if (run.exitCode !== 0) {
    const tooOld = tooOldReason(run)
    if (tooOld !== undefined) return { reason: tooOld, incompatible: true }
    const why = firstLine(run.stderr) || firstLine(run.stdout)
    return { reason: 'mm.py status exited ' + run.exitCode + (why === '' ? '' : ': ' + why) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return { reason: 'mm.py status printed no JSON document' }
  }
  if (!isObj(parsed)) return { reason: 'mm.py status printed no JSON object' }
  if (parsed.schema !== STATUS_SCHEMA) {
    return { reason: 'mm.py status answered schema ' + text(parsed.schema, 'none') + ', not ' + STATUS_SCHEMA }
  }
  const session = obj(parsed.session)
  if (session === undefined || typeof session.bound !== 'boolean' || !Array.isArray(parsed.errors)) {
    return { reason: 'mm.py status answered a malformed ' + STATUS_SCHEMA + ' document' }
  }
  return { snapshot: parsed as Snapshot }
}

export function isBound(s: Snapshot | undefined): boolean {
  return s !== undefined && obj(s.session)?.bound === true
}

export function isUnbound(s: Snapshot | undefined): boolean {
  return s !== undefined && obj(s.session)?.bound === false
}

// The bound task's name, folder and repository root (the folder when the document names no
// root), or undefined when the document carries no task.
export function taskOf(s: Snapshot | undefined): { name: string; dir: string; repo: string } | undefined {
  const task = s === undefined ? undefined : obj(s.task)
  if (task === undefined || typeof task.dir !== 'string' || task.dir === '') return undefined
  return { name: text(task.name, lastComponent(task.dir)), dir: task.dir, repo: text(task.repo_root, task.dir) }
}

export function modeOf(s: Snapshot | undefined): string | undefined {
  return s !== undefined && typeof s.mode === 'string' ? s.mode : undefined
}

export function inFlightIds(s: Snapshot | undefined): string[] {
  return s === undefined ? [] : list(s.dispatches_in_flight).map((d) => text(obj(d)?.id, 'unnamed'))
}

export function rowItem(s: Snapshot | undefined, id: string): string | undefined {
  if (s === undefined) return undefined
  const row = list(s.rows).map(obj).find((r) => r !== undefined && r.id === id)
  return row === undefined ? undefined : text(row.item, '')
}

export function errorsOf(s: Snapshot | undefined): { code: string; message: string }[] {
  if (s === undefined) return []
  return list(s.errors).map((e) => ({ code: text(obj(e)?.code, 'UNKNOWN-ERROR'), message: text(obj(e)?.message, 'no message') }))
}

function lastComponent(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter((p) => p !== '')
  return parts.length === 0 ? dir : (parts[parts.length - 1] as string)
}

// First matching code wins, in this order (R-22 rule 3).
const ERROR_ORDER = [
  'BINDING-UNREADABLE', 'TASK-DIR-MISSING', 'BINDING-LEGACY', 'FENCE-ROOT-TOO-BROAD', 'LEDGER-INVALID',
  'GIT-FAILED', 'CHECK-RAISED', 'NO-TASK', 'SESSION-ID-UNUSABLE',
]

function errorLine(code: string, s: Snapshot): string {
  const task = taskOf(s)
  const name = task === undefined ? 'no task' : task.name
  const folder = task === undefined ? 'no task' : lastComponent(task.dir)
  switch (code) {
    case 'BINDING-UNREADABLE':
      return 'MM · PM · BINDING UNREADABLE: mm.py unbind, then bind'
    case 'TASK-DIR-MISSING':
      return 'MM · ' + folder + ' · PM · TASK FOLDER MISSING: mm.py unbind'
    case 'BINDING-LEGACY':
      return 'MM · ' + name + ' · PM · REBIND NEEDED: mm.py bind'
    case 'FENCE-ROOT-TOO-BROAD':
      return 'MM · ' + name + ' · PM · FENCE ROOT TOO BROAD: mm.py unbind'
    case 'LEDGER-INVALID':
      return 'MM · ' + name + ' · LEDGER INVALID: mm.py check'
    case 'GIT-FAILED':
      return 'MM · ' + name + ' · GIT FAILED: fix git'
    case 'CHECK-RAISED':
      return 'MM · ' + name + ' · CHECK RAISED: mm.py check'
    case 'NO-TASK':
      return 'MM · NO TASK: mm.py bind'
    case 'SESSION-ID-UNUSABLE':
      return 'MM · SESSION ID UNUSABLE: see /mm-runtime'
    default:
      return 'MM · ' + name + ' · ' + code + ': see /mm-runtime'
  }
}

function baseLine(s: Snapshot | undefined): string | undefined {
  if (s === undefined) return 'MM · STATUS UNAVAILABLE'
  const errors = errorsOf(s)
  if (isUnbound(s) && errors.length === 0) return undefined
  if (errors.length > 0) {
    const codes = errors.map((e) => e.code)
    const code = ERROR_ORDER.find((c) => codes.includes(c)) ?? (codes[0] as string)
    return errorLine(code, s) + (errors.length > 1 ? ' · +' + (errors.length - 1) + ' more' : '')
  }
  const task = taskOf(s)
  const name = task === undefined ? 'no task' : task.name
  const check = obj(s.check)
  if (check?.status === 'failed') return 'MM · ' + name + ' · CHECK FAILED (exit ' + text(check.code, 'unknown') + ')'
  const parts = ['MM', name, 'PM']
  if (s.mode === 'unattended') parts.push('AUTO')
  else if (s.mode === 'attended') parts.push('ATTENDED')
  const open = obj(s.open_row)
  if (open !== undefined) parts.push('row ' + text(open.id, 'unnamed') + ' ' + text(open.state, 'unknown'))
  const inbox = obj(s.inbox)
  if (inbox !== undefined) parts.push('inbox ' + text(inbox.entries, '0'))
  parts.push('builders ' + list(s.dispatches_in_flight).length)
  parts.push('waiting ' + list(s.waiting_on_operator).length)
  const loop = obj(s.loop)
  if (s.mode === 'unattended' && loop !== undefined) {
    parts.push('no-op ' + text(loop.noop_count, '0') + '/' + text(loop.noop_cap, 'unknown'))
  }
  if (check?.status === 'fixable') parts.push('check fixable')
  return parts.join(' · ')
}

// The status line (R-22); undefined removes it. A pending boundary warning of
// `boundaryFiles` files adds the BOUNDARY prefix to any form, and a pending boundary
// monitor failure the BOUNDARY MONITOR FAILED prefix before it.
export function statusLine(s: Snapshot | undefined, boundaryFiles: number, monitorFailed = false): string | undefined {
  const parts: string[] = []
  if (monitorFailed) parts.push('MM · BOUNDARY MONITOR FAILED')
  if (boundaryFiles > 0) parts.push('MM · BOUNDARY ' + boundaryFiles + ' files')
  const line = baseLine(s)
  if (line !== undefined) parts.push(line)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

// The pane (R-27): header, one line per error, the rows, waiting, inbox, dispatches in
// flight, agent ids seen, loop, check lines (dim) and the uncommitted count.
export function paneLines(s: Snapshot | undefined, agentIdsSeen: readonly string[]): PaneLine[] {
  if (s === undefined) return [{ text: 'mm · no task · no role · no mode' }, { text: 'status: unavailable' }]
  const lines: PaneLine[] = []
  const task = taskOf(s)
  const session = obj(s.session)
  lines.push({
    text: 'mm · ' + (task === undefined ? 'no task' : task.name) + ' · ' + text(session?.role, 'no role') + ' · ' +
      text(s.mode, 'no mode'),
  })
  for (const e of errorsOf(s)) lines.push({ text: e.code + ': ' + e.message })
  const open = obj(s.open_row)
  const rows = list(s.rows).map(obj).filter((r): r is Obj => r !== undefined)
  if (rows.length === 0) lines.push({ text: 'rows: none' })
  for (const r of rows) {
    const marker = open !== undefined && r.id === open.id ? '> ' : ''
    lines.push({
      text: marker + text(r.id, 'unnamed') + ' ' + text(r.state, 'unknown') + ' (' + text(r.status_label, 'no label') + ') ' +
        text(r.item, 'no item'),
    })
  }
  const waiting = list(s.waiting_on_operator).map(obj).filter((w): w is Obj => w !== undefined)
  if (waiting.length === 0) lines.push({ text: 'waiting on operator: none' })
  for (const w of waiting) {
    lines.push({ text: 'waiting on operator: ' + text(w.kind, 'item') + ' for ' + text(w.row, 'no row') + ': ' + text(w.text, '') })
  }
  const inbox = obj(s.inbox)
  lines.push({
    text: inbox === undefined
      ? 'inbox: unavailable'
      : 'inbox: ' + text(inbox.entries, '0') + ' entries, ' + text(inbox.problems, '0') + ' problems, ' +
        text(inbox.closed_task_files, '0') + ' closed-task files',
  })
  const flying = list(s.dispatches_in_flight).map(obj).filter((d): d is Obj => d !== undefined)
  if (flying.length === 0) lines.push({ text: 'dispatches in flight: none' })
  for (const d of flying) {
    let line = 'dispatch in flight: ' + text(d.id, 'unnamed') + ' row ' + text(d.row, 'none') + ' ' + text(d.route, 'unknown') +
      ':' + text(d.model, 'unknown')
    if (typeof d.worker === 'string' && d.worker !== '') line += ' worker ' + d.worker
    if (typeof d.approval_id === 'string' && d.approval_id !== '') line += ' approval ' + d.approval_id
    lines.push({ text: line + ' · last check ' + text(d.last_verdict, 'never') })
  }
  lines.push({
    text: 'agents seen this session (historical, not live): ' + (agentIdsSeen.length === 0 ? 'none' : agentIdsSeen.join(', ')),
  })
  const loop = obj(s.loop)
  if (loop === undefined) {
    lines.push({ text: 'loop: unavailable' })
  } else {
    let line = 'loop: ' + text(loop.mode, 'unknown') + ' · cadence ' + text(loop.cadence, 'not set') + ' · no-op ' +
      text(loop.noop_count, '0') + '/' + text(loop.noop_cap, 'unknown')
    const tick = obj(loop.last_tick)
    if (tick !== undefined && typeof tick.at === 'string' && tick.at !== '') {
      line += ' · last tick ' + tick.at + ' ' + text(tick.result, '')
    }
    if (typeof loop.stopped_reason === 'string' && loop.stopped_reason !== '') line += ' · stopped: ' + loop.stopped_reason
    lines.push({ text: line.trimEnd() })
  }
  const check = obj(s.check)
  const code = check?.code
  lines.push({
    text: 'check: ' + text(check?.status, 'unknown') + (typeof code === 'number' ? ' (exit ' + code + ')' : ''),
    dim: true,
  })
  for (const l of list(check?.lines)) {
    if (typeof l === 'string' && l !== '') lines.push({ text: 'check | ' + l, dim: true })
  }
  const uncommitted = s.uncommitted
  lines.push({
    text: Array.isArray(uncommitted) ? 'uncommitted: ' + uncommitted.length + ' files' : 'uncommitted: unavailable',
  })
  return lines
}
