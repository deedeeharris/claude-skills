#!/usr/bin/env node
'use strict';

// Writes one JSON record (docs/v2-design.md section 5): approvals ledgers composed by the workflow, and the
// fallback-review.json and wrapped fallback replies the Opus fallback reviewer writes itself.
// usage: write-json.js --out <file>   (the JSON arrives on stdin, from a quoted heredoc)
//        write-json.js --check <file> --sha256 <hex>   (a JSON Schema arrives on stdin)
//
// - stdin must be one strict JSON object (scripts/lib/strict-json.js: UTF-8, no BOM, no duplicate or forbidden
//   keys, RFC 8259 only); the exact stdin bytes are written, so the printed sha256 is the hash of what was sent;
// - --out must be absolute, its parent must exist and the file must not exist: it is written to a temporary
//   sibling, fsynced, and hard-linked into place (link(2) never replaces an existing file), so a reader never
//   sees a partial file and an existing record is never overwritten;
// - prints { path, sha256 }.
// --check re-reads a record another step wrote (the reviewer's own fallback-review.json): the file must exist as a
// regular file, hash to --sha256 (the hash its write printed), be one strict JSON object and conform to the stdin
// schema (scripts/lib/schema-lite.js; the workflow sends its review schema wrapped as { gate_kind, reviewer, reply }).
// It prints { path, sha256, verdict_inputs } on one line and writes nothing. verdict_inputs (verdictInputs below) is
// only what the workflows' verdict rule reads from the record: the gate_kind and reviewer label, and from the reply
// the per-finding id (F<n> = reply.findings[n-1], B<n> = reply.blocking[n-1]), severity, confidence and iso_property,
// the verdict and blocked fields, head_sha and changed, and the pinned git state (head_before, status_before,
// head_after, status_after). No title, detail, location, note, summary, requirement evidence or other review text is
// ever printed: the agent that runs --check hands its stdout back to the workflow, and an agent carrying another
// model's review text is refused as reasoning extraction. Every reader that needs the text reads the file itself.
// Exit 0 written/checked, 1 refused (invalid JSON, --out exists; for --check a missing, changed, non-strict or
// off-schema record), 2 usage/setup error (a schema outside schema-lite). The reason goes to stderr.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parse, StrictJsonError } = require('./lib/strict-json.js');
const { compile, SchemaSetupError } = require('./lib/schema-lite.js');

class Refusal extends Error {}
class SetupError extends Error {}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Atomic no-clobber write of bytes to an absolute path whose parent exists. Shared by hash-inputs.js and
// run-frozen.js. Throws a Refusal when the target exists.
function writeOnce(target, bytes) {
  if (!path.isAbsolute(target)) throw new SetupError(`output path ${target} must be absolute`);
  const dir = path.dirname(target);
  let st;
  try { st = fs.statSync(dir); } catch (e) { throw new SetupError(`output directory ${dir}: ${e.code || e.message}`); }
  if (!st.isDirectory()) throw new SetupError(`output directory ${dir} is not a directory`);
  if (exists(target)) throw new Refusal(`${target} already exists; records are written once`);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.linkSync(tmp, target);
  } catch (e) {
    if (e.code === 'EEXIST') throw new Refusal(`${target} already exists; records are written once`);
    throw e;
  } finally { fs.rmSync(tmp, { force: true }); }
  fsyncDir(dir);
  return { path: target, sha256: sha256(bytes) };
}
// fsync of a directory, so a new entry in it survives a crash. Windows cannot open a directory for fsync (EPERM or
// EISDIR) and NTFS journals the entry itself, so there it is skipped; a file's own fsync stays on every OS.
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  const dfd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}
function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function strictObject(bytes, what, Err) {
  let value;
  try { value = parse(bytes).value; } catch (e) {
    if (e instanceof StrictJsonError) throw new Err(`${what} is not strict JSON: ${e.code} at "${e.path}": ${e.message}`);
    throw e;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Err(`${what} must be one JSON object`);
  return value;
}

// --check: the record at file, re-read and checked against the reported hash and the stdin schema.
function check(file, expected, schemaBytes) {
  if (!path.isAbsolute(file)) throw new SetupError(`record path ${file} must be absolute`);
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new SetupError('--sha256 must be 64 lowercase hex characters');
  let validate;
  try { validate = compile(strictObject(schemaBytes, 'the stdin schema', SetupError)); } catch (e) {
    if (e instanceof SchemaSetupError) throw new SetupError(e.message);
    throw e;
  }
  let st;
  try { st = fs.lstatSync(file); } catch (e) { throw new Refusal(`record ${file} is missing (${e.code || e.message})`); }
  if (!st.isFile()) throw new Refusal(`record ${file} is not a regular file`);
  const bytes = fs.readFileSync(file);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Refusal(`record ${file} has sha256 ${actual}, not the reported ${expected}`);
  const value = strictObject(bytes, `record ${file}`, Refusal);
  const errors = validate(value);
  if (errors.length) throw new Refusal(`record ${file} does not match its schema: ` + errors.slice(0, 5).map(e => `${e.code} at "${e.path}": ${e.message}`).join('; '));
  return { path: file, sha256: actual, verdict_inputs: verdictInputs(value) };
}

// The verdict inputs of a review record { gate_kind, reviewer, reply }. Every printed string is bounded to a shape that
// cannot hold prose: a word token (anything else prints as "other", which no verdict rule counts), a 40-hex SHA (else
// null), a one-line porcelain status or path. An unreadable status line or path prints as a fixed value that is never clean or safe.
const WORD = /^[A-Za-z_]{1,32}$/;
const LABEL = /^[A-Za-z0-9 ()._:-]{1,64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const STATUS_LINE = /^[ MTADRCU?!]{2} [^\r\n]{1,4096}$/;
const UNREADABLE_STATUS = 'GP_UNREADABLE_STATUS_LINE';
const UNREADABLE_PATH = '../GP_UNREADABLE_PATH'; // never a safe repo-relative path, so build refuses it
const word = v => (typeof v === 'string' && WORD.test(v) ? v : 'other');
const label = v => (typeof v === 'string' && LABEL.test(v) ? v : 'other');
const sha40 = v => (typeof v === 'string' && SHA40.test(v) ? v : null);
const statusLines = v => (Array.isArray(v) ? v.map(l => (l === '' ? '' : typeof l === 'string' && STATUS_LINE.test(l) ? l : UNREADABLE_STATUS)) : null);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function verdictInputs(record) {
  const reply = isObj(record.reply) ? record.reply : {};
  const out = {};
  if (Array.isArray(reply.findings)) {
    out.findings = reply.findings.map((x, i) => {
      const f = isObj(x) ? x : {};
      return { id: `F${i + 1}`, severity: word(f.severity), confidence: typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? f.confidence : null,
        iso_property: f.iso_property == null ? null : word(f.iso_property) };
    });
  }
  if (Array.isArray(reply.blocking)) out.blocking = reply.blocking.map((x, i) => ({ id: `B${i + 1}`, severity: word(isObj(x) ? x.severity : null) }));
  if ('verdict' in reply) out.verdict = word(reply.verdict);
  if (typeof reply.blocked === 'boolean') out.blocked = reply.blocked;
  for (const k of ['head_sha', 'head_before', 'head_after']) if (k in reply) out[k] = sha40(reply[k]);
  for (const k of ['status_before', 'status_after']) if (k in reply) out[k] = statusLines(reply[k]);
  if (Array.isArray(reply.changed)) {
    out.changed = reply.changed.map(x => {
      const c = isObj(x) ? x : {};
      return { status: typeof c.status === 'string' && /^[A-Z][0-9]{0,3}$/.test(c.status) ? c.status : 'X',
        path: typeof c.path === 'string' && /^[^\r\n]{1,4096}$/.test(c.path) ? c.path : UNREADABLE_PATH };
    });
  }
  return { gate_kind: label(record.gate_kind), reviewer: label(record.reviewer), reply: out };
}

function main(argv) {
  try {
    if (argv[0] === '--check') {
      if (argv.length !== 4 || !argv[1] || argv[1].startsWith('--') || argv[2] !== '--sha256') throw new SetupError('usage: write-json.js --check <file> --sha256 <hex>  (schema on stdin)');
      process.stdout.write(JSON.stringify(check(argv[1], argv[3], fs.readFileSync(0))) + '\n');
      return 0;
    }
    if (argv.length !== 2 || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) throw new SetupError('usage: write-json.js --out <file>  (JSON on stdin) | --check <file> --sha256 <hex>  (schema on stdin)');
    const bytes = fs.readFileSync(0);
    strictObject(bytes, 'stdin', Refusal);
    process.stdout.write(JSON.stringify(writeOnce(argv[1], bytes)) + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal) && !(e instanceof SetupError)) throw e;
    process.stderr.write(`write-json: ${e.message}\n`);
    return e instanceof Refusal ? 1 : 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { writeOnce, fsyncDir, check, verdictInputs, Refusal, SetupError, sha256 };
