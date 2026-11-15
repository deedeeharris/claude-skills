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
// It prints { path, sha256, value } on one line, value being the record parsed from the file, and writes nothing.
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
  const dfd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  return { path: target, sha256: sha256(bytes) };
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
  return { path: file, sha256: actual, value };
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

module.exports = { writeOnce, check, Refusal, SetupError, sha256 };
