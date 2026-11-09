#!/usr/bin/env node
'use strict';

// The only way a contract-2 stage executes a frozen command (docs/v2-design.md section 6.4).
// usage: run-frozen.js --repo <abs> --frozen-dir <dir> --manifest-sha256 <h> --reviewed-sha <sha>
//          --target check:<ID>|proof:<ACC-ID>|live:<ACC-ID>|suite|negative:<ACC-ID> --out-dir <dir>
//          [--patch <file>] [--ledger <file>]
//
// It never takes a command string: the command is read from <frozen-dir>/execution-plan.json, which must hash to
// --manifest-sha256. Ids must match their literal patterns (^CHECK-[A-Z0-9][A-Z0-9-]*$,
// ^[A-Z][A-Z0-9]*-[0-9]{3}-AC[0-9]+$). A command holding the repo's absolute path (its realpath or the --repo
// spelling) is refused. --frozen-dir, --out-dir, --patch and --ledger must be absolute and outside the repo.
//
// Targets:
// - check:<ID>  an applicable manifest check, in the repo; kill limit budget_min when budget_min > 0, else
//               timeout_min (minutes).
// - proof:<ID>  a non-live runtime acceptance's proof_command, in the repo, limit limits.proof_timeout_s; needs
//               --ledger and appends { id, live: false, record_path, record_sha256 } to it. Refused for a live
//               acceptance.
// - live:<ID>   a live acceptance: executes nothing. Needs --ledger; checks that <out-dir>/check:<check_id>.record.json
//               exists, its log hashes as recorded, it ran the acceptance's command on reviewed_sha, exit 0, no
//               timeout, and appends { id, live: true, check_id, record_path, record_sha256 }.
// - suite       suite.command, limit suite.timeout_min; when suite.isolated, in a fresh detached worktree of
//               reviewed_sha at <out-dir>/suite-wt (removed afterwards). suite.setup_command, when set, runs first
//               in the same checkout under the same limit (simplest reading of design 6.4/6.5: "setup exit 0 when
//               set"); a failed setup skips the suite (exit_code null).
// - negative:<ID> an isolated_mutation acceptance; needs --patch. Derives mutated_paths from the patch's
//               `diff --git` headers (renames, copies, deletions, mode changes and binary hunks are refused; a new
//               file only with mode 100644; every line must lie in a header's section, its ---/+++ names must be
//               the header's, and `git apply --numstat` must list exactly those paths), creates a throwaway worktree of reviewed_sha at <out-dir>/wt, runs
//               setup if set, the unmodified proof (baseline), `git apply --check` + `git apply`, the proof again,
//               (git reads the patch bytes hashed into the record on stdin; --patch is read once),
//               and removes the worktree. Each run is bounded by min(limits.proof_timeout_s, the phase time left).
//               Phase time starts at the first negative control: <dirname(out-dir)>/phase-start.json is created
//               once (O_EXCL); a control that would start after limits.negative_controls_total_min of phase time
//               writes a NOT_RUN record and exits 1. A patch that does not apply writes no record (exit 1).
//
// Every run: the checkout (the repo, or the worktree) must be at reviewed_sha and clean outside the manifest's
// clean_ignore before (else refused, nothing runs) and is recorded again after; the command runs with
// /bin/sh -c in its own process group, cwd = that checkout, stdout and stderr to the log. At the limit the group
// gets SIGTERM and, 10 s later, SIGKILL; when the shell exits, any process left in its group is killed too. The
// log is framed: first line `gp-run-frozen header {target, command, cwd, head}`, last line
// `gp-run-frozen footer {exit_code, signal, elapsed_s}`, so it is never empty. The record
// <out-dir>/<target>.record.json (written once) is
//   { target, command, cwd, head_before, head_after, status_before, status_after, timeout_s, timeout_min,
//     budget_min, elapsed_s, exit_code, signal, timed_out, log_path, log_sha256, manifest_sha256,
//     setup: { exit_code, log_path, log_sha256, timed_out } | null }
// (negative adds id, baseline_*, mutation_patch_*, mutated_paths, phase_elapsed_s; its cwd is the throwaway worktree,
// its head/status describe the repo's work checkout, pinned and unchanged around the whole control, and its timeout_s
// is the limit applied to the mutated run).
// Prints { record_path, record_sha256, exit_code, timed_out, setup_exit_code }.
// Exit 0: ran (or linked) and recorded, whatever the command's own exit code (it is in the record); 1: refused,
// or the checkout moved or got dirty during the run (the record is still written), or interrupted by SIGTERM, SIGINT
// or SIGHUP (the command's group is killed, its log footer carries `interrupted`, no record, nothing printed);
// 2: usage/setup error.
//
// Test-only hooks (they can only shorten limits): GP_RUN_FROZEN_SECONDS_PER_MINUTE=<1..60> (seconds per frozen
// minute) and GP_RUN_FROZEN_KILL_GRACE_S=<0..10> (seconds between SIGTERM and SIGKILL). The record's timeout_s
// shows the limit actually applied.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { parse, StrictJsonError } = require('./lib/strict-json.js');
const { writeOnce, Refusal, SetupError } = require('./write-json.js');

const FLAGS = ['repo', 'frozen-dir', 'manifest-sha256', 'reviewed-sha', 'target', 'out-dir', 'patch', 'ledger'];
const REQUIRED = FLAGS.slice(0, 6);
const CHECK_ID = /^CHECK-[A-Z0-9][A-Z0-9-]*$/;
const ACC_ID = /^[A-Z][A-Z0-9]*-[0-9]{3}-AC[0-9]+$/;
const SAFE_PATH = /^[A-Za-z0-9._/ +@-]+$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function hook(name, max, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new SetupError(`${name} must be a number from 0 to ${max}`);
  return n;
}
const SECONDS_PER_MINUTE = () => Math.max(1, hook('GP_RUN_FROZEN_SECONDS_PER_MINUTE', 60, 60));
const KILL_GRACE_S = () => hook('GP_RUN_FROZEN_KILL_GRACE_S', 10, 10);

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
  return args;
}

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 64 * 1024 * 1024, env: opts.env, input: opts.input });
  if (r.status !== 0 && !opts.allowFail) throw new Refusal(`git ${args.join(' ')} failed: ${(r.stderr || '').toString().trim()}`);
  return r;
}

function parseTarget(t) {
  if (t === 'suite') return { kind: 'suite', id: null };
  const m = /^(check|proof|live|negative):(.*)$/.exec(t);
  if (!m) throw new Refusal(`--target ${JSON.stringify(t)} is not check:<ID>, proof:<ID>, live:<ID>, suite or negative:<ID>`);
  const pattern = m[1] === 'check' ? CHECK_ID : ACC_ID;
  if (!pattern.test(m[2])) throw new Refusal(`--target id ${JSON.stringify(m[2])} does not match ${pattern}`);
  return { kind: m[1], id: m[2] };
}

function absOutside(value, label, realRepo) {
  if (!path.isAbsolute(value)) throw new SetupError(`--${label} must be an absolute path`);
  const abs = path.resolve(value);
  let probe = abs;
  const rest = [];
  while (!fs.existsSync(probe)) { rest.unshift(path.basename(probe)); const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const real = path.join(fs.realpathSync(probe), ...rest);
  if (within(abs, realRepo) || within(real, realRepo)) throw new Refusal(`--${label} ${value} must lie outside the repo`);
  return abs;
}

// Directory-prefix rule of check-completion.js (statePath): an entry covers itself and everything under it.
const covered = (file, entries) => entries.some(e => file === e.replace(/\/$/, '') || file.startsWith(e.endsWith('/') ? e : e + '/'));
function checkoutState(cwd, ignores) {
  const head = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.split('\n').filter(Boolean);
  const dirty = status.filter(line => !line.slice(3).split(' -> ').map(p => p.replace(/^"|"$/g, '')).every(p => covered(p, ignores)));
  return { head, status, dirty };
}

function singleLine(command, label) {
  if (typeof command !== 'string' || !command.trim()) throw new Refusal(`${label} has no command`);
  if (/[\r\n]/.test(command)) throw new Refusal(`${label} command is not a single line`);
  return command;
}

// Interruption (a Bash tool timeout, an interrupted agent, a closed terminal): SIGTERM, SIGINT or SIGHUP to run-frozen.js.
// The running command's process group gets SIGTERM and, at most 1 s later, SIGKILL; its log gets the footer
// { exit_code: null, signal: null, elapsed_s, interrupted: <signal> }; a worktree this run made is removed; no record
// is written and nothing is printed; exit 1. Without this the detached group would outlive run-frozen.js unbounded.
const ACTIVE = new Set(); // running frozen commands: { group, fd, started }
const WORKTREES = new Set(); // worktrees this run made and has not removed yet, as `<repo>\0<path>`
let INTERRUPTED = null;
function onSignal(signal) {
  if (INTERRUPTED) return;
  INTERRUPTED = signal;
  for (const a of ACTIVE) a.group('SIGTERM');
  const end = () => {
    for (const a of ACTIVE) {
      a.group('SIGKILL');
      const elapsed = Math.round(Number(process.hrtime.bigint() - a.started) / 1e6) / 1000;
      try { fs.writeSync(a.fd, '\ngp-run-frozen footer ' + JSON.stringify({ exit_code: null, signal: null, elapsed_s: elapsed, interrupted: signal }) + '\n'); fs.closeSync(a.fd); } catch { /* the log stays unframed */ }
    }
    for (const key of WORKTREES) {
      const [repo, wt] = key.split('\0');
      spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
      spawnSync('git', ['-C', repo, 'worktree', 'prune']);
    }
    process.stderr.write(`run-frozen: interrupted by ${signal}: the frozen command's process group was killed and no record was written\n`);
    process.exit(1);
  };
  if (ACTIVE.size) setTimeout(end, Math.min(KILL_GRACE_S(), 1) * 1000); else end();
}
function addWorktree(repo, wt, sha) {
  WORKTREES.add(`${repo}\0${wt}`);
  git(repo, ['worktree', 'add', '--detach', wt, sha]);
}
function removeWorktree(repo, wt, opts) {
  const r = git(repo, ['worktree', 'remove', '--force', wt], opts);
  WORKTREES.delete(`${repo}\0${wt}`);
  return r;
}

// Runs one command under its limit. Returns { exit_code, signal, timed_out, elapsed_s, log_path, log_sha256 }.
function runFramed({ command, cwd, target, head, logPath, limitS }) {
  fs.writeFileSync(logPath, 'gp-run-frozen header ' + JSON.stringify({ target, command, cwd, head }) + '\n', { flag: 'wx' });
  const fd = fs.openSync(logPath, 'a');
  const started = process.hrtime.bigint();
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', fd, fd] });
    let timedOut = false, killTimer = null;
    const group = sig => { try { process.kill(-child.pid, sig); return true; } catch { return false; } };
    const active = { group, fd, started };
    ACTIVE.add(active);
    const limit = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      killTimer = setTimeout(() => group('SIGKILL'), KILL_GRACE_S() * 1000);
    }, Math.max(1, Math.round(limitS * 1000)));
    let finished = false;
    const finish = (code, signal) => {
      if (finished || INTERRUPTED) return; // an interrupted run is ended by onSignal: no footer here, no record
      finished = true;
      clearTimeout(limit);
      const elapsed = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
      const done = () => {
        if (INTERRUPTED) return;
        ACTIVE.delete(active);
        if (killTimer) clearTimeout(killTimer);
        group('SIGKILL'); // nothing of the command outlives its record
        fs.writeSync(fd, '\ngp-run-frozen footer ' + JSON.stringify({ exit_code: code, signal, elapsed_s: elapsed }) + '\n');
        fs.closeSync(fd);
        resolve({ exit_code: code, signal, timed_out: timedOut, elapsed_s: elapsed, log_path: logPath, log_sha256: sha256(fs.readFileSync(logPath)) });
      };
      if (!timedOut) { done(); return; }
      // After a timeout the rest of the group keeps its SIGTERM grace (the SIGKILL timer above ends it).
      // A hard deadline too: an unreaped zombie (no init reaping in a container) must not hang the run.
      const deadline = Date.now() + KILL_GRACE_S() * 1000 + 2000;
      const poll = setInterval(() => { if (!group(0) || Date.now() > deadline) { clearInterval(poll); done(); } }, 50);
    };
    child.on('error', () => finish(null, null));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

function readManifest(frozenDir, expected) {
  const file = path.join(frozenDir, 'execution-plan.json');
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { throw new SetupError(`manifest ${file}: ${e.code || e.message}`); }
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new SetupError('--manifest-sha256 must be a SHA-256 hex digest');
  if (sha256(bytes) !== expected) throw new Refusal(`manifest ${file} does not hash to --manifest-sha256`);
  let m;
  try { m = parse(bytes).value; } catch (e) { if (e instanceof StrictJsonError) throw new Refusal(`manifest is not strict JSON: ${e.message}`); throw e; }
  if (!m || m.version !== 2) throw new Refusal('run-frozen.js runs only a version 2 manifest');
  return { manifest: m, sha: expected };
}

// mutated paths of a unified git patch (design 6.4: from its `diff --git` headers). Every line must lie inside a
// `diff --git` section and its hunks, so git apply cannot touch a path the headers do not name: a non-blank line
// before the first header, a `---`/`+++` pair whose names differ from the header, text after a hunk's counted
// lines (a plain `---`/`+++` patch git would also apply) and a malformed hunk are refused. Renames, copies,
// deletions, mode changes, binary hunks and symlink or submodule edits are refused; an `index` line may carry
// the unchanged mode 100644 or 100755; a new file only with mode 100644.
function patchPaths(bytes) {
  const text = bytes.toString('utf8');
  if (!text.trim()) throw new Refusal('the mutation patch is empty');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const paths = [];
  let current = null;
  let state = 'preamble'; // preamble | header | hunks | body
  let isNew = false, hunks = 0, oldLeft = 0, newLeft = 0;
  const closeSection = () => {
    if (current === null) return;
    if (state === 'header' && !(isNew && hunks === 0)) throw new Refusal(`the patch section for ${current} has no ---/+++ hunk`);
    if (state === 'body' && (oldLeft || newLeft)) throw new Refusal(`a hunk for ${current} ends early`);
  };
  for (const line of lines) {
    if (state === 'body' && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (line === '' || c === ' ') { oldLeft--; newLeft--; } else if (c === '-') oldLeft--; else if (c === '+') newLeft--;
      else if (c === '\\') continue;
      else throw new Refusal(`a hunk for ${current} ends early: ${line}`);
      if (oldLeft < 0 || newLeft < 0) throw new Refusal(`a hunk for ${current} has more lines than its @@ counts`);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      closeSection();
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Refusal(`unsupported diff header: ${line}`);
      if (m[1] !== m[2]) throw new Refusal(`the patch renames or copies ${m[1]} to ${m[2]}`);
      if (!SAFE_PATH.test(m[1]) || m[1].split('/').some(s => s === '' || s === '.' || s === '..') || m[1].split('/').some(s => s.toLowerCase() === '.git')) throw new Refusal(`unsafe patch path ${m[1]}`);
      current = m[1];
      if (paths.includes(current)) throw new Refusal(`the patch has two sections for ${current}`);
      paths.push(current);
      state = 'header'; isNew = false; hunks = 0;
      continue;
    }
    if (state === 'preamble') {
      if (line.trim() !== '') throw new Refusal(`the patch has text before its first diff --git header: ${line}`);
      continue;
    }
    if (state === 'header') {
      if (/^(rename from|rename to|copy from|copy to|similarity index|dissimilarity index) /.test(line)) throw new Refusal(`the patch renames or copies ${current}`);
      if (/^deleted file mode /.test(line)) throw new Refusal(`the patch deletes ${current}`);
      if (/^(old mode|new mode) /.test(line)) throw new Refusal(`the patch changes the mode of ${current}`);
      if (/^GIT binary patch$/.test(line) || /^Binary files .* differ$/.test(line)) throw new Refusal(`the patch has a binary hunk for ${current}`);
      if (/^new file mode /.test(line)) {
        if (line !== 'new file mode 100644') throw new Refusal(`the patch creates ${current} with ${line.slice(14)}`);
        isNew = true;
        continue;
      }
      // An unchanged mode on the index line: a regular or executable file (a mode change has old/new mode lines).
      if (/^index [0-9a-f]+\.\.[0-9a-f]+( 100644| 100755)?$/.test(line)) continue;
      if (/^index [0-9a-f]+\.\.[0-9a-f]+ (120000|160000)$/.test(line)) throw new Refusal(`the patch edits ${current}, a symlink or submodule`);
      if (line.startsWith('--- ')) {
        if (line !== `--- a/${current}` && !(isNew && line === '--- /dev/null')) throw new Refusal(`the patch's "${line}" does not name ${current} of its diff --git header`);
        state = 'minus';
        continue;
      }
      throw new Refusal(`unsupported line in the patch header for ${current}: ${line}`);
    }
    if (state === 'minus') {
      if (line === '+++ /dev/null') throw new Refusal(`the patch deletes ${current}`);
      if (line !== `+++ b/${current}`) throw new Refusal(`the patch's "${line}" does not name ${current} of its diff --git header`);
      state = 'hunks';
      continue;
    }
    // hunks, or body with its counted lines used up
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (h) { oldLeft = h[1] === undefined ? 1 : Number(h[1]); newLeft = h[2] === undefined ? 1 : Number(h[2]); hunks++; state = 'body'; continue; }
    if (state === 'body' && line.startsWith('\\')) continue;
    if (state === 'hunks') throw new Refusal(`the patch section for ${current} has no @@ hunk: ${line}`);
    if (line.trim() === '') continue;
    throw new Refusal(`the patch has text outside a diff --git section's hunks (git apply would read it as another patch): ${line}`);
  }
  if (!paths.length) throw new Refusal('the mutation patch has no diff --git header');
  if (state === 'minus' || state === 'hunks') throw new Refusal(`the patch section for ${current} has no @@ hunk`);
  closeSection();
  return paths;
}

// The paths git itself would touch (`git apply --numstat -z`, which applies nothing); they must be exactly the
// header-derived ones, so a patch construct the parser above misreads is refused rather than trusted. `patch` is
// the patch bytes (fed on stdin, so git reads exactly what was hashed) or a patch file path.
function gitPatchPaths(cwd, patch, env) {
  const bytes = Buffer.isBuffer(patch);
  const r = spawnSync('git', ['apply', '--numstat', '-z', ...(bytes ? [] : [patch])], { cwd, env: env || process.env, input: bytes ? patch : undefined, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Refusal(`git apply --numstat cannot read the mutation patch: ${r.error ? r.error.message : r.stderr.toString().trim()}`);
  const out = [];
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (!rec) continue;
    const m = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/s.exec(rec);
    if (!m) throw new Refusal(`unexpected git apply --numstat entry: ${JSON.stringify(rec)}`);
    out.push(m[1]);
  }
  return out;
}
// `patchFile` names where the bytes came from; git reads `bytes` themselves.
function checkedPatchPaths(cwd, patchFile, bytes, env) {
  const paths = patchPaths(bytes);
  const touched = gitPatchPaths(cwd, bytes, env);
  if (JSON.stringify([...touched].sort()) !== JSON.stringify([...paths].sort())) throw new Refusal(`git apply would touch ${JSON.stringify(touched)}, not the patch headers' ${JSON.stringify(paths)}`);
  return paths;
}

function readLedger(file) {
  if (!fs.existsSync(file)) return { version: 2, entries: [] };
  let v;
  try { v = parse(fs.readFileSync(file)).value; } catch (e) { throw new Refusal(`ledger ${file} is not strict JSON: ${e.message}`); }
  if (!v || v.version !== 2 || !Array.isArray(v.entries) || Object.keys(v).length !== 2) throw new Refusal(`ledger ${file} is not an acceptance ledger { version: 2, entries }`);
  return { version: 2, entries: v.entries };
}
function appendLedger(file, entry) {
  const ledger = readLedger(file);
  if (ledger.entries.some(e => e && e.id === entry.id)) throw new Refusal(`ledger ${file} already holds ${entry.id}`);
  ledger.entries.push(entry);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeSync(fd, JSON.stringify(ledger, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

const recordName = target => `${target}.record.json`;

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`run-frozen: ${e.message}\n`); return 2; }
  try {
    if (!path.isAbsolute(args.repo)) throw new SetupError('--repo must be an absolute path');
    const target = parseTarget(args.target);
    if (!/^[0-9a-f]{40}$/.test(args['reviewed-sha'])) throw new SetupError('--reviewed-sha must be a full 40-hex SHA');
    const sha = args['reviewed-sha'];
    let realRepo;
    try { realRepo = fs.realpathSync(git(args.repo, ['rev-parse', '--show-toplevel']).stdout.trim()); } catch (e) { throw new SetupError(`--repo ${args.repo}: ${e.message}`); }
    const frozenDir = absOutside(args['frozen-dir'], 'frozen-dir', realRepo);
    const outDir = absOutside(args['out-dir'], 'out-dir', realRepo);
    const patch = args.patch !== undefined ? absOutside(args.patch, 'patch', realRepo) : null;
    const ledger = args.ledger !== undefined ? absOutside(args.ledger, 'ledger', realRepo) : null;
    const { manifest, sha: manifestSha } = readManifest(frozenDir, args['manifest-sha256']);
    const ignores = Array.isArray(manifest.clean_ignore) ? manifest.clean_ignore : [];
    const spm = SECONDS_PER_MINUTE();
    const reqs = Array.isArray(manifest.requirements) ? manifest.requirements : [];
    const acceptance = id => {
      const a = reqs.find(r => r && r.id === id);
      if (!a) throw new Refusal(`the manifest has no acceptance ${id}`);
      if (a.kind !== 'runtime') throw new Refusal(`${id} is a ${a.kind} acceptance; it has no command`);
      return a;
    };
    if ((target.kind === 'proof' || target.kind === 'live') && !ledger) throw new SetupError(`--target ${target.kind}: needs --ledger`);
    if (target.kind === 'negative' && !patch) throw new SetupError('--target negative: needs --patch');
    if (target.kind !== 'negative' && patch) throw new SetupError('--patch is only for --target negative:<ID>');

    let spec; // { command, limitS, timeoutMin, budgetMin }
    if (target.kind === 'check') {
      const c = (Array.isArray(manifest.checks) ? manifest.checks : []).find(x => x && x.id === target.id);
      if (!c) throw new Refusal(`the manifest has no check ${target.id}`);
      if (c.applicable !== true) throw new Refusal(`check ${target.id} is not applicable: ${c.reason}`);
      const minutes = c.budget_min > 0 ? c.budget_min : c.timeout_min;
      spec = { command: singleLine(c.command, target.id), limitS: minutes * spm, timeoutMin: c.timeout_min, budgetMin: c.budget_min };
    } else if (target.kind === 'proof' || target.kind === 'negative') {
      const a = acceptance(target.id);
      if (a.live) throw new Refusal(`${target.id} is a live acceptance: its check record proves it (--target live:${target.id}); it is never run as a proof`);
      if (target.kind === 'negative' && (!a.negative_control || a.negative_control.method !== 'isolated_mutation')) throw new Refusal(`${target.id} has no isolated_mutation negative control`);
      spec = { command: singleLine(a.proof_command, target.id), limitS: manifest.limits.proof_timeout_s, timeoutMin: null, budgetMin: null };
    } else if (target.kind === 'suite') {
      const s = manifest.suite;
      spec = { command: singleLine(s.command, 'suite'), limitS: s.timeout_min * spm, timeoutMin: s.timeout_min, budgetMin: null, setup: s.setup_command };
    }
    for (const cmd of spec ? [spec.command, spec.setup].filter(x => typeof x === 'string') : []) {
      if (cmd.includes(realRepo) || cmd.includes(args.repo) || cmd.includes(path.resolve(args.repo))) throw new Refusal(`the frozen command holds the repo's absolute path: ${cmd}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const recordPath = path.join(outDir, recordName(args.target));
    if (fs.existsSync(recordPath)) throw new Refusal(`${recordPath} already exists; use a fresh --out-dir`);
    const printed = (bytesWritten, rec, extra = {}) => ({ record_path: recordPath, record_sha256: bytesWritten.sha256, exit_code: rec.exit_code ?? null,
      timed_out: rec.timed_out ?? false, setup_exit_code: rec.setup ? rec.setup.exit_code : null, ...extra });
    const write = rec => writeOnce(recordPath, Buffer.from(JSON.stringify(rec, null, 2) + '\n', 'utf8'));

    if (target.kind === 'live') {
      const a = acceptance(target.id);
      if (!a.live) throw new Refusal(`${target.id} is not a live acceptance; run --target proof:${target.id}`);
      if (readLedger(ledger).entries.some(e => e && e.id === target.id)) throw new Refusal(`ledger ${ledger} already holds ${target.id}`);
      const checkRecord = path.join(outDir, recordName('check:' + a.check_id));
      let bytes, rec;
      try { bytes = fs.readFileSync(checkRecord); rec = parse(bytes).value; } catch (e) { throw new Refusal(`live ${target.id}: no readable check record ${checkRecord}: ${e.message}`); }
      const problems = [];
      if (rec.target !== 'check:' + a.check_id) problems.push('target');
      if (rec.command !== a.proof_command) problems.push('command differs from the acceptance');
      if (rec.exit_code !== 0) problems.push('exit_code not 0');
      if (rec.timed_out !== false) problems.push('timed out');
      if (rec.head_before !== sha || rec.head_after !== sha) problems.push('not run on reviewed_sha');
      let logOk = false;
      try { logOk = sha256(fs.readFileSync(rec.log_path)) === rec.log_sha256; } catch { /* missing log */ }
      if (!logOk) problems.push('log does not hash as recorded');
      if (problems.length) throw new Refusal(`live ${target.id}: check record ${checkRecord} cannot prove it: ${problems.join(', ')}`);
      const entry = { id: target.id, live: true, check_id: a.check_id, record_path: checkRecord, record_sha256: sha256(bytes) };
      appendLedger(ledger, entry);
      process.stdout.write(JSON.stringify({ record_path: checkRecord, record_sha256: entry.record_sha256, exit_code: 0, timed_out: false, setup_exit_code: null, linked: true }) + '\n');
      return 0;
    }
    if (target.kind === 'proof' && readLedger(ledger).entries.some(e => e && e.id === target.id)) throw new Refusal(`ledger ${ledger} already holds ${target.id}`);

    if (target.kind === 'negative') return await negative({ args, target, manifest, manifestSha, sha, realRepo, outDir, patch, ignores, spec, recordPath, write, printed });

    // check, proof, suite
    let cwd = realRepo, worktree = null;
    if (target.kind === 'suite' && manifest.suite.isolated) {
      worktree = path.join(outDir, 'suite-wt');
      addWorktree(realRepo, worktree, sha);
      cwd = worktree;
    }
    try {
      const before = checkoutState(cwd, ignores);
      if (before.head !== sha) throw new Refusal(`the checkout ${cwd} is at ${before.head}, not reviewed_sha ${sha}`);
      if (before.dirty.length) throw new Refusal(`the checkout ${cwd} is not clean outside clean_ignore: ${before.dirty.join('; ')}`);
      let setup = null;
      if (target.kind === 'suite' && typeof spec.setup === 'string') {
        const s = await runFramed({ command: spec.setup, cwd, target: 'suite.setup', head: sha, logPath: path.join(outDir, 'suite.setup.log'), limitS: spec.limitS });
        setup = { exit_code: s.exit_code, log_path: s.log_path, log_sha256: s.log_sha256, timed_out: s.timed_out };
      }
      const logPath = path.join(outDir, args.target + '.log');
      let run;
      if (setup && (setup.exit_code !== 0 || setup.timed_out)) {
        fs.writeFileSync(logPath, 'gp-run-frozen header ' + JSON.stringify({ target: args.target, command: spec.command, cwd, head: sha }) +
          '\nsuite not run: setup failed\n\ngp-run-frozen footer ' + JSON.stringify({ exit_code: null, signal: null, elapsed_s: 0 }) + '\n', { flag: 'wx' });
        run = { exit_code: null, signal: null, timed_out: false, elapsed_s: 0, log_path: logPath, log_sha256: sha256(fs.readFileSync(logPath)) };
      } else run = await runFramed({ command: spec.command, cwd, target: args.target, head: sha, logPath, limitS: spec.limitS });
      const after = checkoutState(cwd, ignores);
      const rec = { target: args.target, command: spec.command, cwd, head_before: before.head, head_after: after.head, status_before: before.status,
        status_after: after.status, timeout_s: spec.limitS, timeout_min: spec.timeoutMin, budget_min: spec.budgetMin, elapsed_s: run.elapsed_s,
        exit_code: run.exit_code, signal: run.signal, timed_out: run.timed_out, log_path: run.log_path, log_sha256: run.log_sha256,
        manifest_sha256: manifestSha, setup };
      const w = write(rec);
      if (target.kind === 'proof') appendLedger(ledger, { id: target.id, live: false, record_path: recordPath, record_sha256: w.sha256 });
      process.stdout.write(JSON.stringify(printed(w, rec)) + '\n');
      if (after.head !== sha || after.dirty.length) { process.stderr.write(`run-frozen: the checkout moved or got dirty during the run: ${after.head} ${after.dirty.join('; ')}\n`); return 1; }
      return 0;
    } finally {
      if (worktree) { removeWorktree(realRepo, worktree, { allowFail: true }); git(realRepo, ['worktree', 'prune'], { allowFail: true }); }
    }
  } catch (e) {
    if (!(e instanceof Refusal) && !(e instanceof SetupError)) throw e;
    process.stderr.write(`run-frozen: ${e.message}\n`);
    return e instanceof Refusal ? 1 : 2;
  }
}

async function negative({ args, target, manifest, manifestSha, sha, realRepo, outDir, patch, ignores, spec, recordPath, write, printed }) {
  const patchBytes = (() => { try { return fs.readFileSync(patch); } catch (e) { throw new Refusal(`--patch ${patch}: ${e.code || e.message}`); } })();
  const mutatedPaths = checkedPatchPaths(realRepo, patch, patchBytes);
  const spm = SECONDS_PER_MINUTE();
  const totalS = manifest.limits.negative_controls_total_min * spm;
  const phaseFile = path.join(path.dirname(outDir), 'phase-start.json');
  try { fs.writeFileSync(phaseFile, JSON.stringify({ started_ms: Date.now() }) + '\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  let phaseStart;
  try { phaseStart = parse(fs.readFileSync(phaseFile)).value.started_ms; } catch (e) { throw new Refusal(`phase file ${phaseFile}: ${e.message}`); }
  if (!Number.isFinite(phaseStart)) throw new Refusal(`phase file ${phaseFile} has no started_ms`);
  const phaseElapsed = () => Math.round(Date.now() - phaseStart) / 1000;
  if (phaseElapsed() >= totalS) {
    const rec = { target: args.target, id: target.id, status: 'NOT_RUN', reason: `negative_controls_total_min (${manifest.limits.negative_controls_total_min}) of phase time used before this control`,
      phase_elapsed_s: phaseElapsed(), manifest_sha256: manifestSha };
    const w = write(rec);
    process.stdout.write(JSON.stringify(printed(w, rec, { not_run: true })) + '\n');
    process.stderr.write(`run-frozen: ${target.id} NOT RUN: ${rec.reason}\n`);
    return 1;
  }
  const before = checkoutState(realRepo, ignores);
  if (before.head !== sha) throw new Refusal(`the work checkout is at ${before.head}, not reviewed_sha ${sha}`);
  if (before.dirty.length) throw new Refusal(`the work checkout is not clean outside clean_ignore: ${before.dirty.join('; ')}`);
  const wt = path.join(outDir, 'wt');
  addWorktree(realRepo, wt, sha);
  try {
    const left = () => Math.max(0.001, Math.min(spec.limitS, totalS - phaseElapsed()));
    let setup = null;
    const setupCommand = manifest.suite.setup_command;
    if (typeof setupCommand === 'string') {
      const s = await runFramed({ command: setupCommand, cwd: wt, target: args.target + '.setup', head: sha, logPath: path.join(outDir, args.target + '.setup.log'), limitS: left() });
      setup = { exit_code: s.exit_code, log_path: s.log_path, log_sha256: s.log_sha256, timed_out: s.timed_out };
    }
    const baseline = await runFramed({ command: spec.command, cwd: wt, target: args.target + '.baseline', head: sha, logPath: path.join(outDir, args.target + '.baseline.log'), limitS: left() });
    // The bytes read and hashed before the baseline go to git on stdin; the --patch file is not read again.
    const check = git(wt, ['apply', '--check'], { allowFail: true, input: patchBytes });
    if (check.status !== 0) throw new Refusal(`the mutation patch does not apply to ${sha}: ${check.stderr.trim()}`);
    git(wt, ['apply'], { input: patchBytes });
    const mutatedLimitS = left();
    const mutated = await runFramed({ command: spec.command, cwd: wt, target: args.target, head: sha, logPath: path.join(outDir, args.target + '.log'), limitS: mutatedLimitS });
    removeWorktree(realRepo, wt);
    const after = checkoutState(realRepo, ignores);
    const rec = { target: args.target, id: target.id, command: spec.command, cwd: wt, head_before: before.head, head_after: after.head,
      status_before: before.status, status_after: after.status, timeout_s: mutatedLimitS, timeout_min: null, budget_min: null,
      elapsed_s: mutated.elapsed_s, exit_code: mutated.exit_code, signal: mutated.signal, timed_out: mutated.timed_out,
      log_path: mutated.log_path, log_sha256: mutated.log_sha256, manifest_sha256: manifestSha, setup,
      baseline_exit_code: baseline.exit_code, baseline_log_path: baseline.log_path, baseline_log_sha256: baseline.log_sha256,
      baseline_timed_out: baseline.timed_out, mutation_patch_path: patch, mutation_patch_sha256: sha256(patchBytes),
      mutated_paths: mutatedPaths, phase_elapsed_s: phaseElapsed() };
    const w = write(rec);
    process.stdout.write(JSON.stringify(printed(w, rec)) + '\n');
    if (after.head !== sha || after.dirty.length) { process.stderr.write(`run-frozen: the work checkout moved or got dirty: ${after.head} ${after.dirty.join('; ')}\n`); return 1; }
    return 0;
  } finally {
    removeWorktree(realRepo, wt, { allowFail: true });
    git(realRepo, ['worktree', 'prune'], { allowFail: true });
  }
}

if (require.main === module) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => onSignal(signal));
  main(process.argv.slice(2)).then(code => { if (!INTERRUPTED) process.exitCode = code; });
}

module.exports = { patchPaths, gitPatchPaths, checkedPatchPaths, CHECK_ID, ACC_ID };
