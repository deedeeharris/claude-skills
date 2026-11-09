#!/usr/bin/env node
'use strict';

// Script-side hashes of review inputs (docs/v2-design.md section 5): the pinned source request, the Opus
// fallback's review inputs, a CI failure log. The reviewer never hashes anything itself.
// usage: hash-inputs.js --out <inputs.json> [--files] <file>... [--against <file>...]
//        hash-inputs.js --verify <inputs.json>
//
// --out: every following path is an input with role "files" until --against switches the role to "against"
// (and --files back). Paths are resolved to absolute paths; each must be a regular file, none may repeat.
// Writes { "inputs": [ { "role", "path", "sha256" } ] } (2-space JSON, final LF) once (write-json.js writeOnce:
// atomic, refuses an existing file) and prints { path, sha256, inputs }.
// --verify: re-hashes every listed input and prints { path, sha256, ok, mismatches: [ { path, expected,
// actual } ] } (actual null when the file is unreadable); exit 1 when any input changed.
// Exit 0 ok, 1 refused or changed, 2 usage/setup error (the reason on stderr).

const fs = require('node:fs');
const path = require('node:path');
const { writeOnce, Refusal, SetupError, sha256 } = require('./write-json.js');
const { parse, StrictJsonError } = require('./lib/strict-json.js');

function readFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { throw new SetupError(`input ${file}: ${e.code || e.message}`); }
  if (!st.isFile()) throw new SetupError(`input ${file} is not a regular file`);
  return fs.readFileSync(file);
}

function hashInputs(out, specs) {
  if (!specs.length) throw new SetupError('at least one input file is required');
  const seen = new Set();
  const inputs = specs.map(({ role, file }) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) throw new SetupError(`input ${abs} is listed twice`);
    seen.add(abs);
    return { role, path: abs, sha256: sha256(readFile(abs)) };
  });
  const written = writeOnce(path.resolve(out), Buffer.from(JSON.stringify({ inputs }, null, 2) + '\n', 'utf8'));
  return { ...written, inputs };
}

function readInputs(file) {
  let value;
  try { value = parse(fs.readFileSync(file)).value; } catch (e) {
    if (e instanceof StrictJsonError) throw new Refusal(`${file} is not strict JSON: ${e.message}`);
    throw new SetupError(`${file}: ${e.code || e.message}`);
  }
  const ok = value && Array.isArray(value.inputs) && Object.keys(value).length === 1 && value.inputs.every(i => i && ['files', 'against'].includes(i.role) &&
    typeof i.path === 'string' && path.isAbsolute(i.path) && /^[0-9a-f]{64}$/.test(i.sha256) && Object.keys(i).length === 3);
  if (!ok) throw new Refusal(`${file} is not an inputs file ({ inputs: [ { role, path, sha256 } ] })`);
  return value.inputs;
}

function verify(file) {
  const abs = path.resolve(file);
  const inputs = readInputs(abs);
  const mismatches = [];
  for (const i of inputs) {
    let actual = null;
    try { actual = sha256(fs.readFileSync(i.path)); } catch { /* unreadable */ }
    if (actual !== i.sha256) mismatches.push({ path: i.path, expected: i.sha256, actual });
  }
  return { path: abs, sha256: sha256(fs.readFileSync(abs)), ok: mismatches.length === 0, mismatches };
}

function main(argv) {
  try {
    if (argv[0] === '--verify') {
      if (argv.length !== 2 || !argv[1]) throw new SetupError('usage: hash-inputs.js --verify <inputs.json>');
      const result = verify(argv[1]);
      process.stdout.write(JSON.stringify(result) + '\n');
      return result.ok ? 0 : 1;
    }
    if (argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) throw new SetupError('usage: hash-inputs.js --out <inputs.json> [--files] <file>... [--against <file>...]');
    let role = 'files';
    const specs = [];
    for (const a of argv.slice(2)) {
      if (a === '--files') role = 'files';
      else if (a === '--against') role = 'against';
      else if (a.startsWith('--')) throw new SetupError(`unknown argument ${JSON.stringify(a)}`);
      else specs.push({ role, file: a });
    }
    process.stdout.write(JSON.stringify(hashInputs(argv[1], specs)) + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal) && !(e instanceof SetupError)) throw e;
    process.stderr.write(`hash-inputs: ${e.message}\n`);
    return e instanceof Refusal ? 1 : 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { hashInputs, readInputs, verify };
