#!/usr/bin/env node
'use strict';

// One revision snapshot of the canonical feature file (docs/v2-design.md section 5).
// usage: feature-snapshot.js --repo <abs repo> --from <working file> --repo-path <rel> --rev-dir <run_dir>/rev-k
//          --source-request <file> --source-mode text|ref [--previous <run_dir>/rev-(k-1)/feature.json]
//
// - --rev-dir must be absolute, must not exist, must lie outside realpath(--repo) and its parent must exist; it is
//   created with a plain mkdir, so a snapshot is never written over another one;
// - copies the bytes of --from to <rev-dir>/feature.json, then runs the real validate-feature.js on that copy
//   (with --source-request, --source-mode and --previous) and, when it is valid, compile-feature.js --out
//   <rev-dir>/out, so reviewers read only files derived from the snapshot bytes;
// - prints { valid: true, rev_dir, feature_path, out_dir, source_sha256, prd_projection_sha256, prd_view_sha256,
//   spec_view_sha256, manifest_sha256 } (exit 0), or { valid: false, rev_dir, feature_path, source_sha256, errors }
//   with the validator's diagnostics (exit 1; the snapshot stays, without out/, for the repair prompt).
// Exit 2: usage/setup error (the reason on stderr, also a setup exit of either child).
// It never executes, evaluates or shells out any string from the file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FLAGS = ['repo', 'from', 'repo-path', 'rev-dir', 'source-request', 'source-mode', 'previous'];
const REQUIRED = FLAGS.slice(0, 6);
const VALIDATE = path.join(__dirname, 'validate-feature.js');
const COMPILE = path.join(__dirname, 'compile-feature.js');
class SetupError extends Error {}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!FLAGS.includes(flag)) throw new SetupError(`unknown argument ${JSON.stringify(argv[i])}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new SetupError(`--${flag} needs a value`);
    if (Object.hasOwn(args, flag)) throw new SetupError(`--${flag} given twice`);
    args[flag] = argv[i + 1];
  }
  const missing = REQUIRED.filter(f => args[f] === undefined);
  if (missing.length) throw new SetupError('missing arguments: ' + missing.map(f => '--' + f).join(', '));
  if (!['text', 'ref'].includes(args['source-mode'])) throw new SetupError('--source-mode must be text or ref');
  for (const f of ['repo', 'rev-dir']) if (!path.isAbsolute(args[f])) throw new SetupError(`--${f} must be an absolute path`);
  return args;
}

function node(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(argv) {
  let args, revDir, featurePath, bytes;
  try {
    args = parseArgs(argv);
    let realRepo;
    try { realRepo = fs.realpathSync(args.repo); } catch (e) { throw new SetupError(`--repo ${args.repo}: ${e.code || e.message}`); }
    revDir = path.resolve(args['rev-dir']);
    let parent;
    try { parent = fs.realpathSync(path.dirname(revDir)); } catch (e) { throw new SetupError(`--rev-dir parent ${path.dirname(revDir)}: ${e.code || e.message}`); }
    if (within(path.join(parent, path.basename(revDir)), realRepo)) throw new SetupError(`--rev-dir ${revDir} lies inside --repo`);
    try { bytes = fs.readFileSync(args.from); } catch (e) { throw new SetupError(`cannot read --from ${args.from}: ${e.code || e.message}`); }
    try { fs.mkdirSync(revDir); } catch (e) { throw new SetupError(`--rev-dir ${revDir}: ${e.code === 'EEXIST' ? 'already exists' : e.code || e.message}`); }
    featurePath = path.join(revDir, 'feature.json');
    fs.writeFileSync(featurePath, bytes, { flag: 'wx' });
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    process.stderr.write(`feature-snapshot: ${e.message}\n`);
    return 2;
  }
  const print = o => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  const validateArgs = ['--file', featurePath, '--repo-path', args['repo-path'], '--source-request', args['source-request'], '--source-mode', args['source-mode']];
  if (args.previous !== undefined) validateArgs.push('--previous', args.previous);
  const v = node(VALIDATE, validateArgs);
  if (v.status !== 0 && v.status !== 1) { process.stderr.write(`feature-snapshot: validate-feature exit ${v.status}: ${v.stderr}`); return 2; }
  const verdict = JSON.parse(v.stdout);
  if (v.status === 1) {
    print({ valid: false, rev_dir: revDir, feature_path: featurePath, source_sha256: sha256(bytes), errors: verdict.errors });
    return 1;
  }
  const outDir = path.join(revDir, 'out');
  const c = node(COMPILE, ['--file', featurePath, '--repo', args.repo, '--repo-path', args['repo-path'], '--out', outDir]);
  if (c.status !== 0) {
    if (c.status === 1) { print({ valid: false, rev_dir: revDir, feature_path: featurePath, source_sha256: sha256(bytes), errors: JSON.parse(c.stdout).errors }); return 1; }
    process.stderr.write(`feature-snapshot: compile-feature exit ${c.status}: ${c.stderr}`);
    return 2;
  }
  const h = JSON.parse(c.stdout);
  print({ valid: true, rev_dir: revDir, feature_path: featurePath, out_dir: outDir, source_sha256: h.source_sha256,
    prd_projection_sha256: h.prd_projection_sha256, prd_view_sha256: h.prd_view_sha256, spec_view_sha256: h.spec_view_sha256,
    manifest_sha256: h.manifest_sha256 });
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
