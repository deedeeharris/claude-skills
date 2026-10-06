#!/usr/bin/env node
'use strict';

// Mechanical completion gate. It reads evidence; it never executes proof commands.
// Command/exit metadata are host attestations: hashes detect changes, not fabricated runs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const FLAGS = ['repo', 'feature-id', 'reviewed-sha', 'manifest', 'manifest-sha256', 'spec', 'build-result', 'verify-result', 'out'];
const OPTIONAL = ['mode', 'previous-proof'];
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function ensure(ok, reason) { if (!ok) throw new Error(reason); }
function list(value, label) { ensure(Array.isArray(value), label + ' must be an array'); return value; }
function text(value, label) { ensure(typeof value === 'string' && value.trim(), label + ' must be nonempty'); return value; }
function unique(items, key, label) {
  const byId = new Map();
  for (const item of list(items, label)) {
    const id = text(key ? item && item[key] : item, label + ' identifier');
    ensure(!byId.has(id), `duplicate ${label}: ${id}`);
    byId.set(id, item);
  }
  return byId;
}
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    ensure([...FLAGS, ...OPTIONAL].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'invalid argument: ' + argv[i]);
    ensure(!Object.hasOwn(args, flag), 'duplicate argument: ' + flag);
    args[flag] = argv[i + 1];
  }
  args.mode = args.mode || 'completion';
  ensure(['plan', 'completion'].includes(args.mode), 'mode must be plan or completion');
  const required = args.mode === 'plan' ? FLAGS.slice(0, 6) : FLAGS;
  const missing = required.filter(flag => !args[flag]);
  ensure(!missing.length, 'missing arguments: ' + missing.join(', '));
  ensure(SHA.test(args['reviewed-sha']), 'reviewed-sha must be a full 40-hex SHA');
  ensure(HASH.test(args['manifest-sha256']), 'manifest-sha256 must be a SHA256 hash');
  return args;
}
function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  ensure(result.status === 0, 'git ' + args[0] + ' failed: ' + (result.stderr || result.error || 'unknown error'));
  return result.stdout;
}
function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function physicalPath(file) {
  const missing = [];
  let parent = file;
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    ensure(next !== parent, 'cannot resolve artifact path: ' + file);
    missing.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...missing);
}
function outside(repo, file, label) {
  text(file, label + ' path');
  ensure(path.isAbsolute(file), label + ' artifact path must be absolute');
  ensure(!within(repo, path.resolve(file)) && !within(repo, physicalPath(path.resolve(file))), label + ' artifact must be outside the repo');
  return path.resolve(file);
}
function artifact(repo, file, label, reads) {
  const target = outside(repo, file, label);
  let data;
  try {
    ensure(fs.statSync(target).isFile(), label + ' artifact must be a file');
    data = fs.readFileSync(target);
  } catch (error) { throw new Error(label + ' artifact is unreadable: ' + error.message); }
  ensure(data.length > 0 && data.toString('utf8').trim(), label + ' artifact must be nonempty');
  const loaded = { path: target, sha256: hash(data), data };
  if (reads) reads.push(loaded);
  return loaded;
}
function jsonArtifact(repo, file, label, reads) {
  const loaded = artifact(repo, file, label, reads);
  try { loaded.value = JSON.parse(loaded.data); }
  catch (error) { throw new Error(label + ' artifact has invalid JSON: ' + error.message); }
  ensure(loaded.value && typeof loaded.value === 'object' && !Array.isArray(loaded.value), label + ' JSON must be an object');
  return loaded;
}
function repoPath(value, prefix, label) {
  text(value, label);
  const bare = prefix && value.endsWith('/') ? value.slice(0, -1) : value;
  ensure(bare && !path.posix.isAbsolute(bare) && !/^[A-Za-z]:/.test(bare) &&
    !/[\x00-\x1f\x7f\\"'`$]/.test(bare) && bare.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe ' + label + ': ' + value);
  ensure(prefix || !value.endsWith('/'), 'unsafe ' + label + ': ' + value);
  return value;
}
function matchPath(file, entry) { return entry.endsWith('/') ? file.startsWith(entry) : file === entry; }
// Preserve the existing pipeline convention: state/ignore entries are directory prefixes.
function statePath(file, entries) {
  return entries.some(entry => file === entry.replace(/\/$/, '') || file.startsWith(entry.endsWith('/') ? entry : entry + '/'));
}
function cleanReports(lines, ignores, label, protectedPaths) {
  for (const line of list(lines, label)) {
    ensure(typeof line === 'string' && line.length > 3, label + ' has invalid status output');
    for (const file of line.slice(3).split(' -> ').map(p => p.replace(/^"|"$/g, ''))) {
      repoPath(file, false, label + ' path');
      ensure(!protectedPaths.some(entry => matchPath(file, entry)), label + ' has a dirty protected path: ' + file);
      ensure(statePath(file, ignores), label + ' must be clean outside frozen clean_ignore');
    }
  }
}
function pinned(report, sha, label, ignores, protectedPaths) {
  ensure(report && report.head_before === sha && report.head_after === sha, label + ' must have the reviewed SHA before and after');
  cleanReports(report.status_before, ignores, label + ' status_before', protectedPaths);
  cleanReports(report.status_after, ignores, label + ' status_after', protectedPaths);
}
function review(report, sha, label) {
  ensure(report && report.verdict === 'PASS', label + ' must PASS');
  ensure(report.head_sha === sha, label + ' must have the reviewed SHA');
  ensure(list(report.confirmed_findings, label + ' confirmed_findings').length === 0, label + ' has confirmed findings');
}
function assertCurrent(repo, sha, statePaths, ignores, protectedPaths) {
  const actual = git(repo, ['rev-parse', 'HEAD']).trim();
  const commits = [], changed = new Set();
  if (actual !== sha) {
    const ancestor = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, actual]);
    ensure(ancestor.status === 0, 'actual Git HEAD must retain the reviewed SHA in its history');
    commits.push(...git(repo, ['rev-list', sha + '..' + actual]).trim().split('\n').filter(Boolean));
    for (const commit of commits) {
      const files = git(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-m', '-z', commit]).split('\0').filter(Boolean);
      for (const file of files) {
        repoPath(file, false, 'post-review changed path');
        ensure(!protectedPaths.some(entry => matchPath(file, entry)), 'protected path changed after review: ' + file);
        ensure(statePath(file, statePaths), 'actual Git HEAD differs from reviewed SHA with an unreviewed non-state-only change: ' + file);
        changed.add(file);
      }
    }
  }
  const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const dirty = [];
  for (let i = 0; i < status.length; i++) {
    const record = status[i];
    const files = [record.slice(3)];
    if (/[RC]/.test(record.slice(0, 2))) files.push(status[++i]);
    for (const file of files) {
      repoPath(file, false, 'dirty path');
      ensure(!protectedPaths.some(entry => matchPath(file, entry)), 'dirty protected path: ' + file);
      ensure(statePath(file, ignores), 'actual Git tree must be clean outside frozen clean_ignore: ' + file);
      dirty.push(file);
    }
  }
  return { actual_head: actual, state_only_qualification: { applied: actual !== sha, commits, changed_paths: [...changed].sort() },
    clean_state_qualification: { clean_ignore: ignores, ignored_dirty_paths: [...new Set(dirty)].sort() } };
}
function sameFile(a, b) {
  if (physicalPath(a) === physicalPath(b)) return true;
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  const left = fs.statSync(a), right = fs.statSync(b);
  return left.dev === right.dev && left.ino === right.ino;
}
function capturedHash(expected, source, label) {
  ensure(HASH.test(expected) && expected === source.sha256, label + ' hash differs from captured output hash');
}
function certification(proof) {
  const copy = { ...proof };
  // State-only commits and ignored state dirt may change between verify and land.
  for (const key of ['checked_at', 'actual_head', 'state_only_qualification', 'clean_state_qualification']) delete copy[key];
  return copy;
}

function check(args) {
  const repo = fs.realpathSync(git(args.repo, ['rev-parse', '--show-toplevel']).trim());
  const sha = args['reviewed-sha'];
  const feature = text(args['feature-id'], 'feature-id');
  const reads = [];
  const out = args.mode === 'plan' ? null : outside(repo, args.out, 'output');
  const inputKeys = args.mode === 'plan' ? ['manifest', 'spec'] : ['manifest', 'spec', 'build-result', 'verify-result'];
  const inputPaths = inputKeys.map(key => outside(repo, args[key], key));
  if (out) ensure(!inputPaths.some(file => sameFile(file, out)), 'output must not overwrite or alias an input artifact');
  const manifestSource = jsonArtifact(repo, args.manifest, 'manifest', reads);
  ensure(manifestSource.sha256 === args['manifest-sha256'], 'manifest hash differs from the frozen manifest hash');
  const manifest = manifestSource.value;
  ensure(manifest.version === 1 && manifest.feature_id === feature, 'manifest version or feature does not match');
  const specSource = artifact(repo, args.spec, 'spec', reads);
  ensure(HASH.test(manifest.spec_sha256) && manifest.spec_sha256 === specSource.sha256, 'spec hash differs from the frozen spec hash');
  const allowed = [...unique(manifest.allowed_paths, null, 'allowed paths').keys()].map(p => repoPath(p, true, 'allowed path'));
  const protectedPaths = [...unique(manifest.protected_paths, null, 'protected paths').keys()].map(p => repoPath(p, true, 'protected path'));
  const statePaths = [...unique(manifest.state_paths || [], null, 'state paths').keys()].map(p => repoPath(p, true, 'state path'));
  const cleanIgnore = [...unique(manifest.clean_ignore || [], null, 'clean_ignore').keys()].map(p => repoPath(p, true, 'clean_ignore path'));
  for (const [label, entries] of [['state_paths', statePaths], ['clean_ignore', cleanIgnore]]) {
    for (const entry of entries) {
      const overlap = protectedPaths.find(protectedPath => statePath(protectedPath.replace(/\/$/, ''), [entry]) ||
        (protectedPath.endsWith('/') && statePath(entry.replace(/\/$/, ''), [protectedPath])));
      ensure(!overlap, label + ' declaration overlaps protected path: ' + entry + ' and ' + overlap);
    }
  }
  const inventory = unique(manifest.requirements, 'id', 'requirements');
  ensure(inventory.size > 0, 'manifest requirements must not be empty');
  for (const requirement of inventory.values()) {
    ensure(['runtime', 'static'].includes(requirement.kind), 'invalid requirement kind: ' + requirement.id);
    ensure(typeof requirement.proof_command === 'string', 'requirement proof_command must be a string: ' + requirement.id);
    if (requirement.kind === 'runtime') text(requirement.proof_command, 'requirement proof_command: ' + requirement.id);
  }
  const configuredChecks = unique(manifest.checks, 'name', 'checks');
  for (const c of configuredChecks.values()) {
    ensure(typeof c.applicable === 'boolean' && typeof c.reason === 'string', 'check applicability and reason are required: ' + c.name);
    ensure(c.applicable || c.reason.trim(), 'inapplicable check needs a reason: ' + c.name);
  }
  if (args.mode === 'plan') {
    assertCurrent(repo, sha, statePaths, cleanIgnore, protectedPaths);
    return { status: 'PASS', mode: 'plan', feature_id: feature, reviewed_sha: sha,
      manifest_sha256: manifestSource.sha256, spec_sha256: specSource.sha256, state_paths: statePaths, clean_ignore: cleanIgnore };
  }

  const previousSource = args['previous-proof'] ? jsonArtifact(repo, args['previous-proof'], 'previous proof') : null;
  const previous = previousSource && previousSource.value;
  const buildSource = jsonArtifact(repo, args['build-result'], 'build result', reads);
  const verifySource = jsonArtifact(repo, args['verify-result'], 'verify result', reads);
  const build = buildSource.value;
  const verify = verifySource.value;
  for (const [label, report] of [['build', build], ['verify', verify]]) {
    ensure(report.status === 'PASS', label + ' result must PASS');
    ensure(report.feature_id === feature, label + ' feature does not match');
    ensure(report.reviewed_sha === sha, label + ' reviewed SHA does not match');
  }
  ensure(/^[0-9a-f]{7,40}$/.test(build.base_commit) && verify.base_commit === build.base_commit, 'build and verify must retain the same original base commit');
  const base = git(repo, ['rev-parse', '--verify', build.base_commit + '^{commit}']).trim();
  ensure(SHA.test(base), 'base commit must resolve to a full SHA');
  const ancestor = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', base, sha], { encoding: 'utf8' });
  ensure(ancestor.status === 0, 'original base must be an ancestor of the reviewed SHA');
  const initialState = assertCurrent(repo, sha, statePaths, cleanIgnore, protectedPaths);
  const changed = git(repo, ['diff', '--name-only', '--no-renames', '-z', base, sha]).split('\0').filter(Boolean).sort();
  for (const file of changed) {
    repoPath(file, false, 'changed path');
    ensure(allowed.some(entry => matchPath(file, entry)), 'scope violation: ' + file);
    ensure(!protectedPaths.some(entry => matchPath(file, entry)), 'protected path changed: ' + file);
  }
  review(build.review, sha, 'build review');
  ensure(build.security && build.security.verdict === 'PASS' && list(build.security.blocking, 'security blocking').length === 0, 'security review must PASS without blocking findings');
  const suite = build.suite;
  ensure(suite && suite.completed === true && typeof suite.passed === 'boolean', 'suite must complete and report passed');
  pinned(suite, sha, 'suite', cleanIgnore, protectedPaths);
  ensure(list(suite.other_failures, 'suite other_failures').length === 0, 'suite has non-test failures');
  const failures = [...unique(suite.failures, null, 'suite failures').keys()].sort();
  const baseline = [...unique(build.known_failures_seen, null, 'known failures').keys()].sort();
  ensure(JSON.stringify(failures) === JSON.stringify(baseline), 'suite failures must exactly match known failures seen');
  ensure(suite.passed === (failures.length === 0), 'suite passed flag contradicts its failure inventory');
  const suiteLog = artifact(repo, suite.log_path, 'suite output', reads);
  capturedHash(suite.log_sha256, suiteLog, 'suite output');
  review(verify.final_review, sha, 'final review');
  ensure(verify.manifest_sha256 === manifestSource.sha256, 'verify manifest hash does not match the frozen manifest hash');
  const compliance = verify.compliance;
  ensure(compliance && compliance.verdict === 'PASS' && list(compliance.blocking, 'compliance blocking').length === 0, 'compliance must PASS without blocking findings');
  pinned(compliance, sha, 'compliance', cleanIgnore, protectedPaths);

  const results = unique(verify.results, 'name', 'check results');
  for (const name of results.keys()) ensure(configuredChecks.has(name), 'unknown check result: ' + name);
  const checks = [];
  for (const c of configuredChecks.values()) {
    if (!c.applicable) {
      ensure(!results.has(c.name) || results.get(c.name).status === 'NOT_RUN', 'inapplicable check must be omitted or NOT_RUN: ' + c.name);
      checks.push({ name: c.name, applicable: false, reason: c.reason });
      continue;
    }
    ensure(results.has(c.name), 'missing check result: ' + c.name);
    const result = results.get(c.name);
    ensure(result.status === 'PASS', c.name + ' check must PASS');
    pinned(result, sha, c.name + ' check', cleanIgnore, protectedPaths);
    const evidence = artifact(repo, result.evidence_path, c.name + ' check output', reads);
    capturedHash(result.evidence_sha256, evidence, c.name + ' check output');
    checks.push({ name: c.name, applicable: true, status: 'PASS', evidence_path: evidence.path, evidence_sha256: evidence.sha256 });
  }

  const traces = unique(compliance.requirements, 'id', 'requirement traces');
  for (const id of traces.keys()) ensure(inventory.has(id), 'unknown requirement trace: ' + id);
  const requirements = [];
  for (const [id, requirement] of inventory) {
    ensure(traces.has(id), 'missing requirement trace: ' + id);
    const trace = traces.get(id);
    ensure(trace.status === 'PASS', id + ' requirement must PASS');
    const evidence = list(trace.evidence, id + ' evidence');
    ensure(evidence.length, id + ' requirement needs evidence');
    const checked = [];
    for (const item of evidence) {
      ensure(item && item.head_sha === sha, id + ' evidence must have the reviewed SHA');
      ensure(['runtime', 'static'].includes(item.kind), id + ' evidence kind must be runtime or static');
      if (item.kind === 'runtime') {
        ensure(item.command === requirement.proof_command, id + ' evidence must use the frozen proof command');
        ensure(item.exit_code === 0, id + ' runtime exit code must be zero');
        const output = artifact(repo, item.log_path, id + ' runtime output', reads);
        capturedHash(item.log_sha256, output, id + ' runtime output');
        checked.push({ kind: 'runtime', head_sha: sha, command: item.command, exit_code: 0, log_path: output.path, log_sha256: output.sha256 });
      } else {
        const file = repoPath(item.file, false, id + ' static file');
        ensure(Number.isInteger(item.line) && item.line > 0, id + ' static line must be positive');
        const content = spawnSync('git', ['-C', repo, 'show', sha + ':' + file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        ensure(content.status === 0, id + ' static file does not exist at the reviewed SHA: ' + file);
        const lines = content.stdout.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        ensure(item.line <= lines.length && !content.stdout.includes('\0'), id + ' static line does not exist in a text file: ' + file + ':' + item.line);
        checked.push({ kind: 'static', head_sha: sha, file, line: item.line, file_sha256: hash(content.stdout) });
      }
    }
    ensure(requirement.kind !== 'runtime' || checked.some(item => item.kind === 'runtime'), id + ' requirement needs runtime evidence');
    ensure(requirement.kind !== 'static' || checked.some(item => item.kind === 'static'), id + ' requirement needs static evidence');
    requirements.push({ id, kind: requirement.kind, status: 'PASS', evidence: checked });
  }

  // Recheck after reading evidence; an artifact or Git race must not certify a different state.
  for (const source of reads) {
    ensure(!sameFile(source.path, out), 'output must not overwrite or alias a read artifact: ' + source.path);
    ensure(artifact(repo, source.path, 'recheck').sha256 === source.sha256, 'input artifact changed during completion check: ' + source.path);
  }
  if (previousSource) ensure(artifact(repo, previousSource.path, 'previous proof recheck').sha256 === previousSource.sha256, 'previous proof changed during completion check');
  const finalState = assertCurrent(repo, sha, statePaths, cleanIgnore, protectedPaths);
  ensure(isDeepStrictEqual(initialState, finalState), 'Git state changed during completion check');
  const proof = {
    version: 1, status: 'PASS', feature_id: feature, base_commit: base, reviewed_sha: sha,
    manifest_sha256: manifestSource.sha256, spec_sha256: specSource.sha256,
    state_paths: statePaths, clean_ignore: cleanIgnore,
    artifact_hashes: { build_result: buildSource.sha256, verify_result: verifySource.sha256 },
    ...finalState,
    requirements, changed_files: changed, checks,
    reviews: { implementation: 'PASS', security: 'PASS', final: 'PASS', compliance: 'PASS' },
    suite: { status: failures.length ? 'KNOWN_BASELINE_FAILURES' : 'GREEN', completed: true, log_path: suiteLog.path, log_sha256: suiteLog.sha256 },
    known_failures_seen: baseline,
    resume: { manifest_path: manifestSource.path, verify_result_path: verifySource.path, original_base_commit: base,
      note: 'Retain the frozen inventory and evidence. On interruption, resume missing traces; rerun smoke and final checks on the reviewed commit.' },
    handoff: { manifest_path: manifestSource.path, spec_path: specSource.path, build_result_path: buildSource.path,
      verify_result_path: verifySource.path, note: 'Only this reviewed commit is certified. The human or orchestrator decides whether to merge.' },
    checked_at: new Date().toISOString(),
  };
  if (previous) {
    ensure(previous.status === 'PASS' && previous.feature_id === feature && previous.reviewed_sha === sha &&
      previous.base_commit === base && previous.manifest_sha256 === manifestSource.sha256,
    'previous proof identity does not match this certification');
    ensure(isDeepStrictEqual(certification(previous), certification(proof)), 'previous proof differs from the current certified source hashes, traces or artifacts');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temporary = out + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temporary, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, out);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { status: 'PASS', proof_path: out, proof_sha256: hash(fs.readFileSync(out)), reviewed_sha: sha,
    manifest_sha256: manifestSource.sha256, state_paths: statePaths, clean_ignore: cleanIgnore };
}

if (require.main === module) {
  try { console.log(JSON.stringify(check(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ status: 'BLOCKED', reason: error.message })); process.exitCode = 1; }
}
module.exports = { check, parseArgs };
