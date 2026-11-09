#!/usr/bin/env node
'use strict';

// Writes one workflow-composed JSON record (docs/v2-design.md section 5): approvals ledgers, fallback-review.json,
// wrapped fallback replies. usage: write-json.js --out <file>   (the JSON arrives on stdin, from a quoted heredoc)
//
// - stdin must be one strict JSON object (scripts/lib/strict-json.js: UTF-8, no BOM, no duplicate or forbidden
//   keys, RFC 8259 only); the exact stdin bytes are written, so the printed sha256 is the hash of what was sent;
// - --out must be absolute, its parent must exist and the file must not exist: it is written to a temporary
//   sibling, fsynced, and hard-linked into place (link(2) never replaces an existing file), so a reader never
//   sees a partial file and an existing record is never overwritten;
// - prints { path, sha256 }.
// Exit 0 written, 1 refused (invalid JSON, --out exists), 2 usage/setup error. The reason goes to stderr.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parse, StrictJsonError } = require('./lib/strict-json.js');

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

function main(argv) {
  try {
    if (argv.length !== 2 || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) throw new SetupError('usage: write-json.js --out <file>  (JSON on stdin)');
    const bytes = fs.readFileSync(0);
    let value;
    try { value = parse(bytes).value; } catch (e) {
      if (e instanceof StrictJsonError) throw new Refusal(`stdin is not strict JSON: ${e.code} at "${e.path}": ${e.message}`);
      throw e;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('stdin must be one JSON object');
    process.stdout.write(JSON.stringify(writeOnce(argv[1], bytes)) + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal) && !(e instanceof SetupError)) throw e;
    process.stderr.write(`write-json: ${e.message}\n`);
    return e instanceof Refusal ? 1 : 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { writeOnce, Refusal, SetupError, sha256 };
