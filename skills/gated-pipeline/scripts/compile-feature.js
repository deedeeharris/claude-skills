#!/usr/bin/env node
'use strict';

// Compiler of the v2 canonical feature file (docs/v2-design.md section 4).
// usage: compile-feature.js --file <feature.json> --repo <abs repo> --repo-path <rel> --out <dir>
//        compile-feature.js --file <feature.json> --repo <abs repo> --repo-path <rel> --check <dir>   (drift check)
//
// --repo is used only for containment (realpath), never for git; --file may be a snapshot outside it.
// The full validator (validate-feature.js steps 1-4, bundled schema) runs first: an invalid file is exit 1 and
// nothing is written.
// --out <dir>: must not exist and must lie outside realpath(--repo) (else exit 2). The four files
// (execution-plan.json, prd.view.md, spec.view.md, compile-identity.json; scripts/lib/feature-render.js) are
// written into <out>.tmp-<pid>-<rand>, each fsynced, the directory fsynced, and only then renamed to <out>, so an
// interrupted compile never leaves a valid-looking directory at <out> (a stale .tmp-* sibling may remain).
// --check <dir>: recompiles in memory and compares the four files byte for byte, and that <dir> holds no other
// entry; exit 1 with one E_DRIFT error per differing, missing or extra file. Nothing is written.
//
// Prints one JSON object. Success: { ok: true, mode, out|check, source_sha256, prd_projection_sha256,
// prd_view_sha256, spec_view_sha256, manifest_sha256, identity_sha256 }. Failure (exit 1): { ok: false, mode,
// errors } where errors are the validator's diagnostics { code, rule, path, id, message } or drift errors
// { code: "E_DRIFT", file, message }. Exit 2 (usage/setup): the reason on stderr, nothing on stdout.
//
// Test-only hook: GP_COMPILE_ABORT_AFTER=<n> (n = 0..4) makes an --out compile kill itself with SIGKILL right
// after the n-th output file is written and fsynced into the temporary directory (0: right after creating it,
// 4: after all four, before the rename). It exists so the tests can prove the atomic --out; it never changes
// what a compile that is not killed writes.
//
// It never executes, evaluates or shells out any string from the file: commands are data.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { validateFeature, loadSchema, DEFAULT_SCHEMA } = require('./validate-feature.js');
const { parse } = require('./lib/strict-json.js');
const { renderAll, FILE_NAMES } = require('./lib/feature-render.js');

const FLAGS = ['file', 'repo', 'repo-path', 'out', 'check'];
class SetupError extends Error {}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!FLAGS.includes(flag)) throw new SetupError(`unknown argument ${JSON.stringify(argv[i])}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new SetupError(`--${flag} needs a value`);
    if (Object.hasOwn(args, flag)) throw new SetupError(`--${flag} given twice`);
    args[flag] = argv[i + 1];
  }
  if (!args.file || !args.repo || !args['repo-path']) throw new SetupError('--file, --repo and --repo-path are required');
  if ((args.out === undefined) === (args.check === undefined)) throw new SetupError('exactly one of --out and --check is required');
  if (!path.isAbsolute(args.repo)) throw new SetupError('--repo must be an absolute path');
  return args;
}

const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// The absolute, symlink-resolved location <out> would have; it must not exist, its parent must.
function resolveOut(out, realRepo) {
  const abs = path.resolve(out);
  if (fs.existsSync(abs) || isSymlink(abs)) throw new SetupError(`--out ${out} already exists`);
  let parent;
  try { parent = fs.realpathSync(path.dirname(abs)); } catch (e) { throw new SetupError(`--out parent ${path.dirname(abs)}: ${e.code || e.message}`); }
  const target = path.join(parent, path.basename(abs));
  if (within(target, realRepo)) throw new SetupError(`--out ${out} lies inside --repo ${realRepo}`);
  return target;
}
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Library entry point: validate and render. Returns { valid, errors, files, hashes }.
function compileFeature({ bytes, repoPath, validateSchema }) {
  const result = validateFeature({ bytes, repoPath, validateSchema });
  if (!result.valid) return { valid: false, errors: result.errors, files: null, hashes: null };
  const { files, hashes } = renderAll(parse(bytes).value, bytes, repoPath);
  return { valid: true, errors: [], files, hashes };
}

// Drift errors of <dir> against the compiled files, sorted by file name (empty: identical).
function driftErrors(dir, files) {
  const errors = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { throw new SetupError(`--check ${dir}: ${e.code || e.message}`); }
  for (const name of FILE_NAMES) {
    const p = path.join(dir, name);
    let st = null;
    try { st = fs.lstatSync(p); } catch { /* missing */ }
    if (!st) errors.push({ code: 'E_DRIFT', file: name, message: `${name} is missing` });
    else if (!st.isFile()) errors.push({ code: 'E_DRIFT', file: name, message: `${name} is not a regular file` });
    else if (!fs.readFileSync(p).equals(files[name])) errors.push({ code: 'E_DRIFT', file: name, message: `${name} differs from a recompile of the source` });
  }
  for (const name of entries) if (!FILE_NAMES.includes(name)) errors.push({ code: 'E_DRIFT', file: name, message: `${name} is not a compiler output` });
  return errors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function fsyncPath(p, flags) {
  const fd = fs.openSync(p, flags);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function abortHook(count) {
  const n = process.env.GP_COMPILE_ABORT_AFTER;
  if (n !== undefined && n !== '' && Number(n) === count) process.kill(process.pid, 'SIGKILL');
}

// Atomic write of the four files to target (which must not exist).
function writeOut(target, files) {
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(tmp);
  try {
    abortHook(0);
    FILE_NAMES.forEach((name, i) => {
      const fd = fs.openSync(path.join(tmp, name), 'wx');
      try { fs.writeSync(fd, files[name]); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      abortHook(i + 1);
    });
    fsyncPath(tmp, 'r');
    // rename(2) would replace an empty directory created at <out> meanwhile: refuse instead.
    if (fs.existsSync(target) || isSymlink(target)) throw new SetupError(`--out ${target} appeared during the compile`);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  fsyncPath(path.dirname(target), 'r');
}

function main(argv) {
  const mode = argv.includes('--check') ? 'check' : 'out';
  let args, realRepo, target = null, bytes, validateSchema;
  try {
    args = parseArgs(argv);
    try { realRepo = fs.realpathSync(args.repo); } catch (e) { throw new SetupError(`--repo ${args.repo}: ${e.code || e.message}`); }
    if (!fs.statSync(realRepo).isDirectory()) throw new SetupError(`--repo ${args.repo} is not a directory`);
    if (mode === 'out') target = resolveOut(args.out, realRepo);
    else {
      let st;
      try { st = fs.statSync(args.check); } catch (e) { throw new SetupError(`--check ${args.check}: ${e.code || e.message}`); }
      if (!st.isDirectory()) throw new SetupError(`--check ${args.check} is not a directory`);
    }
    try { bytes = fs.readFileSync(args.file); } catch (e) { throw new SetupError(`cannot read --file ${args.file}: ${e.code || e.message}`); }
    validateSchema = loadSchema(DEFAULT_SCHEMA);
  } catch (e) {
    process.stderr.write(`compile-feature: ${e.message}\n`);
    return 2;
  }
  const compiled = compileFeature({ bytes, repoPath: args['repo-path'], validateSchema });
  const print = o => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  if (!compiled.valid) { print({ ok: false, mode, errors: compiled.errors }); return 1; }
  try {
    if (mode === 'check') {
      const errors = driftErrors(args.check, compiled.files);
      if (errors.length) { print({ ok: false, mode, errors }); return 1; }
      print({ ok: true, mode, check: path.resolve(args.check), ...compiled.hashes });
      return 0;
    }
    writeOut(target, compiled.files);
  } catch (e) {
    process.stderr.write(`compile-feature: ${e.message}\n`);
    return 2;
  }
  print({ ok: true, mode, out: target, ...compiled.hashes });
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { compileFeature, driftErrors };
