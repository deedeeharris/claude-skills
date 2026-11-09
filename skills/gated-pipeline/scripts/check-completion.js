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
  for (const key of ['checked_at', 'actual_head', 'state_only_qualification', 'clean_state_qualification', 'trunk_qualification']) delete copy[key];
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
  ensure(build.build_mode !== 'charge-only', 'a charge-only build result never certifies completion (build_mode "charge-only")');
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

// ================================================================================================================
// Contract 2 (manifest version 2): docs/v2-design.md sections 5, 6.2, 6.4 and 6.5. The v1 code above is untouched
// except for the charge-only rejection; v2 is selected by `--mode approvals|design` or by any v2-only flag
// (--frozen-dir, --approvals, --approvals-sha256, --trunk-ref, --commit, --expect-parent, --source). Without them a
// v2 manifest fails the v1 path ("manifest version or feature does not match"), so nothing upgrades silently.
//
//   --mode approvals --repo <abs> --approvals <file> --source <run_dir>/rev-k/feature.json            (no git)
//   --mode design --repo --feature-id --frozen-dir --manifest-sha256 --spec --commit --approvals --approvals-sha256
//                 [--expect-parent <sha>] [--out <file>]
//   --mode plan   --repo --feature-id --reviewed-sha --manifest --manifest-sha256 --spec --frozen-dir --commit
//                 --approvals --approvals-sha256
//   (completion)  --repo --feature-id --reviewed-sha --manifest --manifest-sha256 --spec --build-result
//                 --verify-result --out --frozen-dir --approvals --approvals-sha256 [--trunk-ref] [--previous-proof]
// stdout: one JSON object on PASS (exit 0). stderr: { status: "BLOCKED", code, reason } with exit 1 (blocked) or
// exit 2 (usage/setup: bad arguments, an unreadable schema, a pipeline.yaml bound list that is not a one-line JSON
// array). --manifest, when given, must be <frozen-dir>/execution-plan.json. --spec is the canonical file in the
// repo: the only in-repo path admitted, and only as realpath(<repo>/<source.path>).
//
// Inputs written by the v2 stages (the shapes this file certifies; build.js/verify.js write them):
//   approvals-<n>.json  { run_dir, start_head, previous_design: { commit, repo_path } | null, source_request_path,
//                         source_request_sha256, records: [ { gate: prd|spec, round, rev, rev_dir, verdict, reviewer,
//                         review_dir, result_path | inputs_path + fallback_review_path + fallback_review_sha256,
//                         source_sha256, prd_projection_sha256, spec_view_sha256, manifest_sha256,
//                         source_request_sha256, schema_version, compiler_version } ] }; n records in file n, each
//                         earlier file holding the first records (immutable, contiguous)
//   build result        v1 fields + contract 2, build_mode "v2", plan_identity { design_commit, source_sha256,
//                         manifest_sha256, approvals_sha256, preflight_path, preflight_sha256 }, suite_identity
//                         { command, known_failure_ids, isolated, setup_command, timeout_min, record_path,
//                         record_sha256 }, review_files [ { step: implementation|security, round, reviewer,
//                         review_dir, result_path + result_sha256 | inputs_path + inputs_sha256 +
//                         fallback_review_path + fallback_review_sha256 | raw_path + raw_sha256 } ], history
//                         (tests_added in history[].work / history[].fix), optional repo_config
//   verify result       v1 fields except `results` + contract 2, check_records [ { check_id, record_path,
//                         record_sha256 } ], acceptance_ledger { path, sha256 } (run-frozen.js { version: 2,
//                         entries }), negative_controls [ { id, record_path, record_sha256 } ], review_files
//                         (steps final|compliance), optional repo_config
// Security and compliance raw files are codex's security.json / compliance.json, or the fallback reply wrapped by
// write-json.js as { gate_kind, reviewer, reply } (security: reply.findings, else reply.blocking).
//
// Choices where the design is silent (the simplest reading, fail closed):
// - the source-request mode of the --source-request rules is the form F carries (text or ref);
// - the ledger's start_head must be the design commit's parent; review dirs and rev dirs lie in the ledger's
//   run_dir; source_request_path is <run_dir>/source-request.txt;
// - pipeline.yaml bound lines may carry a trailing `# comment` after the JSON array;
// - "an exempt P0 acceptance cites an alternate_evidence_paths entry" is checked for every exempt acceptance
//   whose manifest entry has alternate_evidence_paths (the manifest carries no priority; the validator's G25 makes
//   the list nonempty exactly for the all-exempt P0 case); static evidence may lie in evidence_paths or there;
// - review files: every round's files are hashed and their kinds give reviewers/fallback_used/cross_family; the
//   verdict is recomputed for the last round of each step;
// - a negative-control phase_elapsed_s may exceed negative_controls_total_min * 60 by the 10 s kill grace.
const os = require('node:os');
const { parse: strictParse } = require('./lib/strict-json.js');
const { compile: compileSchema } = require('./lib/schema-lite.js');
const gateRule = require('./lib/gate-rule.js');

const V2_ONLY = ['frozen-dir', 'approvals', 'approvals-sha256', 'trunk-ref', 'commit', 'expect-parent', 'source'];
const FALLBACK_REVIEWER = 'claude-opus-high (codex unavailable)';
const V2_FLAGS = {
  approvals: { required: ['repo', 'approvals', 'source'], optional: [] },
  design: { required: ['repo', 'feature-id', 'frozen-dir', 'manifest-sha256', 'spec', 'commit', 'approvals', 'approvals-sha256'], optional: ['expect-parent', 'out'] },
  plan: { required: ['repo', 'feature-id', 'reviewed-sha', 'manifest', 'manifest-sha256', 'spec', 'frozen-dir', 'commit', 'approvals', 'approvals-sha256'], optional: [] },
  completion: { required: ['repo', 'feature-id', 'reviewed-sha', 'manifest', 'manifest-sha256', 'spec', 'build-result', 'verify-result', 'out', 'frozen-dir', 'approvals', 'approvals-sha256'], optional: ['trunk-ref', 'previous-proof'] },
};
class GateError extends Error { constructor(code, message) { super(message); this.code = code; } }
class UsageError extends GateError {}
function need(ok, code, message) { if (!ok) throw new GateError(code, message); }
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysExactly = (o, required, optional = []) => isObj(o) && required.every(k => Object.hasOwn(o, k)) && Object.keys(o).every(k => required.includes(k) || optional.includes(k));

function isContract2(argv) {
  const i = argv.indexOf('--mode');
  return (i >= 0 && ['approvals', 'design'].includes(argv[i + 1])) || argv.some(a => a.startsWith('--') && V2_ONLY.includes(a.slice(2)));
}
function parseArgsV2(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!flag || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new UsageError('E_USAGE', 'invalid argument: ' + argv[i]);
    if (Object.hasOwn(args, flag)) throw new UsageError('E_USAGE', 'duplicate argument: ' + flag);
    args[flag] = argv[i + 1];
  }
  args.mode = args.mode || 'completion';
  const spec = V2_FLAGS[args.mode];
  if (!spec) throw new UsageError('E_USAGE', 'mode must be approvals, design, plan or completion');
  const allowed = ['mode', ...spec.required, ...spec.optional];
  const extra = Object.keys(args).filter(k => !allowed.includes(k));
  if (extra.length) throw new UsageError('E_USAGE', `--mode ${args.mode} does not take: ${extra.map(k => '--' + k).join(', ')}`);
  const missing = spec.required.filter(k => !args[k]);
  if (missing.length) throw new UsageError('E_USAGE', 'missing arguments: ' + missing.join(', '));
  if (args['reviewed-sha'] !== undefined && !SHA.test(args['reviewed-sha'])) throw new UsageError('E_USAGE', 'reviewed-sha must be a full 40-hex SHA');
  for (const k of ['commit', 'expect-parent']) if (args[k] !== undefined && !SHA.test(args[k])) throw new UsageError('E_USAGE', k + ' must be a full 40-hex SHA');
  for (const k of ['manifest-sha256', 'approvals-sha256']) if (args[k] !== undefined && !HASH.test(args[k])) throw new UsageError('E_USAGE', k + ' must be a SHA256 hash');
  if (!path.isAbsolute(args.repo)) throw new UsageError('E_USAGE', '--repo must be an absolute path');
  return args;
}

function gitBuf(repo, args, env, input) {
  const r = spawnSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024, env: env || process.env, input });
  return { ok: r.status === 0, stdout: r.stdout || Buffer.alloc(0), stderr: (r.stderr || '').toString() };
}
function blobAt(repo, commit, file) {
  const r = gitBuf(repo, ['cat-file', 'blob', `${commit}:${file}`]);
  return r.ok ? r.stdout : null;
}
function strictJson(loaded, label) {
  try { loaded.value = strictParse(loaded.data).value; } catch (e) { throw new GateError('E_JSON', `${label} is not strict JSON: ${e.message}`); }
  return loaded;
}
function jsonV2(ctx, file, label, { object = true } = {}) {
  const loaded = strictJson(artifact(ctx.repo, file, label, ctx.reads), label);
  if (object) need(isObj(loaded.value), 'E_JSON', label + ' JSON must be an object');
  return loaded;
}
function hashed(ctx, file, expected, label) {
  need(typeof file === 'string' && HASH.test(expected || ''), 'E_HASH', `${label} needs a path and a sha256`);
  const loaded = artifact(ctx.repo, file, label, ctx.reads);
  need(loaded.sha256 === expected, 'E_HASH', `${label} ${file} does not hash to its recorded sha256`);
  return loaded;
}
let compiledSchemas = null;
function schemas() {
  if (compiledSchemas) return compiledSchemas;
  const { loadSchema } = require('./validate-feature.js');
  let manifest;
  try { manifest = compileSchema(strictParse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'execution-plan.v2.schema.json'))).value); }
  catch (e) { throw new UsageError('E_SETUP', 'execution-plan.v2.schema.json: ' + e.message); }
  compiledSchemas = { feature: loadSchema(require('./validate-feature.js').DEFAULT_SCHEMA), manifest };
  return compiledSchemas;
}
const lib = () => ({ ...require('./compile-feature.js'), ...require('./validate-feature.js'), render: require('./lib/feature-render.js'), shape: require('./validate-feature.js').shapeCheck });

// ---- approvals (design section 5) --------------------------------------------------------------------------------
const RECORD_KEYS = ['gate', 'round', 'rev', 'rev_dir', 'verdict', 'reviewer', 'review_dir', 'source_sha256', 'prd_projection_sha256',
  'spec_view_sha256', 'manifest_sha256', 'source_request_sha256', 'schema_version', 'compiler_version'];
const LEDGER_KEYS = ['run_dir', 'start_head', 'previous_design', 'source_request_path', 'source_request_sha256', 'records'];
function gateInputs(gate, revDir, requestPath) {
  const out = path.join(revDir, 'out');
  return gate === 'prd'
    ? [{ role: 'files', path: path.join(out, 'prd.view.md') }, { role: 'against', path: requestPath }]
    : [{ role: 'files', path: path.join(out, 'spec.view.md') }, { role: 'files', path: path.join(out, 'execution-plan.json') }, { role: 'against', path: path.join(out, 'prd.view.md') }];
}
function sameInputs(ctx, actual, expected, label) {
  need(Array.isArray(actual) && actual.every(i => keysExactly(i, ['role', 'path', 'sha256'])), 'E_APPROVALS', `${label}: inputs must be [ { role, path, sha256 } ]`);
  const key = i => `${i.role}\u0000${path.resolve(String(i.path))}`;
  const want = expected.map(key).sort(), got = actual.map(key).sort();
  need(JSON.stringify(want) === JSON.stringify(got), 'E_APPROVALS', `${label}: review inputs are not exactly ${expected.map(i => i.role + ' ' + i.path).join(', ')}`);
  for (const i of actual) {
    const bytes = artifact(ctx.repo, path.resolve(i.path), `${label} input`, ctx.reads);
    need(bytes.sha256 === i.sha256, 'E_APPROVALS', `${label}: input ${i.path} does not hash as recorded`);
  }
}
function inside(child, parent) { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); }

function checkApprovals(ctx, { approvalsPath, approvalsSha, F, repoPath: knownRepoPath, sourcePath }) {
  const L = lib();
  const ledgerFile = jsonV2(ctx, approvalsPath, 'approvals');
  if (approvalsSha) need(ledgerFile.sha256 === approvalsSha, 'E_APPROVALS', 'approvals file does not hash to --approvals-sha256');
  const m = /^approvals-([1-9][0-9]*)\.json$/.exec(path.basename(ledgerFile.path));
  need(m, 'E_APPROVALS', 'the approvals file must be named approvals-<n>.json');
  const n = Number(m[1]);
  const ledger = ledgerFile.value;
  need(keysExactly(ledger, LEDGER_KEYS), 'E_APPROVALS', 'approvals ledger must have exactly ' + LEDGER_KEYS.join(', '));
  const runDir = path.dirname(ledgerFile.path);
  need(typeof ledger.run_dir === 'string' && path.resolve(ledger.run_dir) === runDir, 'E_APPROVALS', 'the ledger run_dir is not the directory of the approvals file');
  need(SHA.test(ledger.start_head || ''), 'E_APPROVALS', 'the ledger start_head must be a 40-hex SHA');
  need(ledger.previous_design === null || (keysExactly(ledger.previous_design, ['commit', 'repo_path']) && SHA.test(ledger.previous_design.commit) &&
    typeof ledger.previous_design.repo_path === 'string'), 'E_APPROVALS', 'previous_design must be null or { commit, repo_path }');
  need(!fs.existsSync(path.join(runDir, `approvals-${n + 1}.json`)), 'E_APPROVALS', `approvals-${n + 1}.json exists beside the named ledger: a later review is not in it`);
  need(Array.isArray(ledger.records) && ledger.records.length === n, 'E_APPROVALS', `approvals-${n}.json must hold exactly ${n} records`);
  const header = JSON.stringify(LEDGER_KEYS.slice(0, 5).map(k => ledger[k]));
  for (let i = 1; i < n; i++) {
    const earlier = jsonV2(ctx, path.join(runDir, `approvals-${i}.json`), `approvals-${i}.json`).value;
    need(keysExactly(earlier, LEDGER_KEYS) && JSON.stringify(LEDGER_KEYS.slice(0, 5).map(k => earlier[k])) === header &&
      isDeepStrictEqual(JSON.parse(JSON.stringify(earlier.records)), JSON.parse(JSON.stringify(ledger.records.slice(0, i)))), 'E_APPROVALS', `approvals-${i}.json is not the first ${i} records of approvals-${n}.json`);
  }
  const requestPath = path.join(runDir, 'source-request.txt');
  need(path.resolve(String(ledger.source_request_path)) === requestPath, 'E_APPROVALS', 'source_request_path must be <run_dir>/source-request.txt');
  const request = artifact(ctx.repo, requestPath, 'source request', ctx.reads);
  need(request.sha256 === ledger.source_request_sha256, 'E_APPROVALS', 'the source request does not hash to the ledger source_request_sha256');
  const pin = jsonV2(ctx, path.join(runDir, 'source-request.inputs.json'), 'source-request.inputs.json').value;
  need(keysExactly(pin, ['inputs']) && Array.isArray(pin.inputs) && pin.inputs.length === 1 && pin.inputs[0].role === 'files' &&
    path.resolve(String(pin.inputs[0].path)) === requestPath && pin.inputs[0].sha256 === ledger.source_request_sha256, 'E_APPROVALS', 'source-request.inputs.json does not pin the ledger source_request_sha256');
  let requestText;
  try { requestText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(request.data); } catch { throw new GateError('E_APPROVALS', 'the source request is not valid UTF-8'); }

  const records = ledger.records;
  for (const [i, r] of records.entries()) {
    const label = `approval record ${i + 1}`;
    const codex = isObj(r) && Object.hasOwn(r, 'result_path');
    need(keysExactly(r, [...RECORD_KEYS, ...(codex ? ['result_path'] : ['inputs_path', 'fallback_review_path', 'fallback_review_sha256'])]), 'E_APPROVALS', `${label}: unexpected or missing fields`);
    need(['prd', 'spec'].includes(r.gate) && Number.isInteger(r.round) && r.round > 0 && Number.isInteger(r.rev) && r.rev > 0, 'E_APPROVALS', `${label}: gate, round or rev invalid`);
    need(['PASS', 'FAIL', 'NEEDS_HUMAN'].includes(r.verdict), 'E_APPROVALS', `${label}: verdict must be PASS, FAIL or NEEDS_HUMAN`);
    need(path.resolve(String(r.rev_dir)) === path.join(runDir, `rev-${r.rev}`), 'E_APPROVALS', `${label}: rev_dir must be <run_dir>/rev-${r.rev}`);
    need(typeof r.review_dir === 'string' && inside(path.resolve(r.review_dir), runDir), 'E_APPROVALS', `${label}: review_dir must lie in the run dir`);
    need(r.source_request_sha256 === ledger.source_request_sha256, 'E_APPROVALS', `${label}: source_request_sha256 is not the pinned one`);
  }
  // repo path of the snapshots: the frozen manifest's (design/plan/completion) or the --source rev's compile.
  let repoPath = knownRepoPath;
  if (sourcePath !== undefined) {
    const named = records.find(r => sameFile(path.join(path.resolve(r.rev_dir), 'feature.json'), sourcePath));
    need(named, 'E_APPROVALS', '--source must be the feature.json of a rev snapshot named by a ledger record');
    if (!repoPath) {
      const outManifest = strictJson(artifact(ctx.repo, path.join(path.resolve(named.rev_dir), 'out', 'execution-plan.json'), 'rev manifest', ctx.reads), 'rev manifest').value;
      repoPath = outManifest && outManifest.source && outManifest.source.path;
    }
  }
  need(typeof repoPath === 'string' && repoPath, 'E_APPROVALS', 'cannot tell the repo path of the snapshots');
  const S = schemas();
  const revs = new Map();
  const revOf = k => {
    if (revs.has(k)) return revs.get(k);
    const dir = path.join(runDir, `rev-${k}`);
    const bytes = artifact(ctx.repo, path.join(dir, 'feature.json'), `rev-${k} snapshot`, ctx.reads).data;
    const compiled = L.compileFeature({ bytes, repoPath, validateSchema: S.feature });
    need(compiled.valid, 'E_APPROVALS', `rev-${k} does not validate: ${compiled.valid ? '' : compiled.errors.map(e => e.code + ' ' + e.path).join('; ')}`);
    const drift = L.driftErrors(path.join(dir, 'out'), compiled.files);
    need(!drift.length, 'E_DRIFT', `rev-${k}/out differs from a recompile of rev-${k}: ${drift.map(d => d.file).join(', ')}`);
    const value = L.shape(bytes, S.feature).value;
    const entry = { k, dir, bytes, hashes: compiled.hashes, value };
    revs.set(k, entry);
    return entry;
  };
  const reviewers = [];
  const echo = [];
  for (const [i, r] of records.entries()) {
    const label = `approval record ${i + 1} (${r.gate} round ${r.round}, rev ${r.rev})`;
    const rev = revOf(r.rev);
    for (const k of ['source_sha256', 'prd_projection_sha256', 'spec_view_sha256', 'manifest_sha256']) need(r[k] === rev.hashes[k], 'E_APPROVALS', `${label}: ${k} differs from the recompile of rev-${r.rev}`);
    need(r.schema_version === 2 && r.compiler_version === L.render.COMPILER_VERSION, 'E_APPROVALS', `${label}: schema or compiler version differs`);
    const expected = gateInputs(r.gate, rev.dir, requestPath);
    const reviewDir = path.resolve(r.review_dir);
    let verdict;
    if (Object.hasOwn(r, 'result_path')) {
      need(r.reviewer === 'codex', 'E_APPROVALS', `${label}: a result.json record is a codex review`);
      need(inside(path.resolve(r.result_path), reviewDir), 'E_APPROVALS', `${label}: result_path must lie in review_dir`);
      const result = jsonV2(ctx, path.resolve(r.result_path), `${label} result.json`).value;
      need(result.kind === r.gate, 'E_APPROVALS', `${label}: result.json kind ${result.kind} is not the ${r.gate} gate`);
      need(result.outcome === 'ok' && result.unable_to_review === null, 'E_APPROVALS', `${label}: result.json outcome must be ok with unable_to_review null`);
      need(isObj(result.scope) && result.scope.mode === 'files', 'E_APPROVALS', `${label}: result.json scope.mode must be files`);
      sameInputs(ctx, result.inputs, expected, label);
      need(Array.isArray(result.findings), 'E_APPROVALS', `${label}: result.json has no findings`);
      const runner = gateRule.computeVerdict(r.gate, result.findings, result.model_verdict);
      need(result.verdict === runner.verdict, 'E_APPROVALS', `${label}: result.json verdict ${result.verdict} is not computeVerdict's ${runner.verdict}`);
      verdict = gateRule.codexGate(r.gate, result).verdict;
    } else {
      need(r.reviewer === FALLBACK_REVIEWER, 'E_APPROVALS', `${label}: a fallback record's reviewer is ${FALLBACK_REVIEWER}`);
      for (const k of ['inputs_path', 'fallback_review_path']) need(typeof r[k] === 'string' && inside(path.resolve(r[k]), reviewDir), 'E_APPROVALS', `${label}: ${k} must lie in review_dir`);
      const fb = hashed(ctx, path.resolve(r.fallback_review_path), r.fallback_review_sha256, `${label} fallback-review.json`);
      strictJson(fb, `${label} fallback-review.json`);
      need(keysExactly(fb.value, ['gate_kind', 'reviewer', 'reply']), 'E_APPROVALS', `${label}: fallback-review.json must be { gate_kind, reviewer, reply }`);
      need(fb.value.gate_kind === r.gate, 'E_APPROVALS', `${label}: fallback-review.json gate_kind ${fb.value.gate_kind} is not the ${r.gate} gate`);
      need(fb.value.reviewer === FALLBACK_REVIEWER, 'E_APPROVALS', `${label}: fallback-review.json reviewer must be ${FALLBACK_REVIEWER}`);
      const inputs = jsonV2(ctx, path.resolve(r.inputs_path), `${label} inputs.json`).value;
      need(keysExactly(inputs, ['inputs']), 'E_APPROVALS', `${label}: inputs.json must be { inputs }`);
      sameInputs(ctx, inputs.inputs, expected, label);
      try { verdict = gateRule.fallbackGate(r.gate, fb.value.reply).verdict; } catch (e) { throw new GateError('E_APPROVALS', `${label}: ${e.message}`); }
    }
    need(r.verdict === verdict, 'E_APPROVALS', `${label}: recorded verdict ${r.verdict} is not the gate verdict ${verdict}`);
    reviewers.push({ stage: 'design', step: r.gate, round: r.round, reviewer: r.reviewer });
    echo.push({ gate: r.gate, round: r.round, rev: r.rev, verdict: r.verdict });
  }
  // --previous rules across consecutive snapshots rev-0 ... and the --source-request rules on each.
  const rev0File = path.join(runDir, 'rev-0', 'feature.json');
  const chain = [...new Set(records.map(r => r.rev))].sort((a, b) => a - b).map(revOf);
  let prev = null;
  if (fs.existsSync(rev0File)) {
    const bytes = artifact(ctx.repo, rev0File, 'rev-0 snapshot', ctx.reads).data;
    const shaped = L.shape(bytes, S.feature);
    need(!shaped.errors.length, 'E_REV0', 'rev-0 is not a schema-valid revision');
    prev = shaped.value;
  }
  for (const rev of chain) {
    const mode = isObj(rev.value.source_request) && Object.hasOwn(rev.value.source_request, 'text') ? 'text' : 'ref';
    const v = L.validateFeature({ bytes: rev.bytes, repoPath, validateSchema: S.feature, request: { requestBytes: request.data, requestText, mode }, previous: prev });
    need(v.valid, 'E_APPROVALS', `rev-${rev.k} fails the --source-request/--previous rules: ${v.errors.map(e => e.code + ' ' + (e.rule || '') + ' ' + e.path).join('; ')}`);
    prev = rev.value;
  }
  // Freeze rule on F.
  const fHashes = L.compileFeature({ bytes: F, repoPath, validateSchema: S.feature });
  need(fHashes.valid, 'E_FREEZE_RULE', 'the final bytes F do not validate');
  const lastSpec = [...records].reverse().find(r => r.gate === 'spec');
  const lastPrd = [...records].reverse().find(r => r.gate === 'prd');
  need(lastSpec && lastSpec.verdict === 'PASS', 'E_FREEZE_RULE', 'the latest spec review is not a PASS');
  need(revOf(lastSpec.rev).bytes.equals(F), 'E_FREEZE_RULE', `the latest spec PASS (rev ${lastSpec.rev}) is not on the final bytes`);
  need(lastPrd && lastPrd.verdict === 'PASS', 'E_FREEZE_RULE', 'the latest PRD review is not a PASS');
  need(lastPrd.prd_projection_sha256 === fHashes.hashes.prd_projection_sha256, 'E_FREEZE_RULE', 'the latest PRD PASS is on another PRD projection than the final bytes');
  need(lastPrd.source_request_sha256 === ledger.source_request_sha256, 'E_FREEZE_RULE', 'the latest PRD PASS is not on the pinned source request');
  const rule = revOf(lastPrd.rev).bytes.equals(F) ? 'same-revision' : 'unchanged-prd-projection';
  return { ledger, runDir, approvals_sha256: ledgerFile.sha256, records: echo, rule, reviewers, rev0File, repoPath, fHashes: fHashes.hashes };
}

function modeApprovals(args) {
  const ctx = { repo: fs.realpathSync(args.repo), reads: [] };
  const source = artifact(ctx.repo, args.source, 'source', ctx.reads);
  const a = checkApprovals(ctx, { approvalsPath: args.approvals, F: source.data, sourcePath: source.path });
  for (const r of ctx.reads) need(artifact(ctx.repo, r.path, 'recheck').sha256 === r.sha256, 'E_RACE', 'input changed during the approvals check: ' + r.path);
  return { status: 'PASS', mode: 'approvals', approvals_sha256: a.approvals_sha256, records: a.records, rule: a.rule };
}

// ---- pipeline.yaml upper bound (design section 2) ------------------------------------------------------------
function boundList(text, parent, key) {
  if (text === null) return [];
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const parentRe = new RegExp(`^${parent}:\\s*(#.*)?$`);
  const starts = lines.flatMap((l, i) => (parentRe.test(l) ? [i] : []));
  if (!starts.length) return [];
  if (starts.length > 1) throw new UsageError('E_CONFIG_FORM', `.claude/pipeline.yaml has more than one ${parent}: block`);
  const block = [];
  for (const l of lines.slice(starts[0] + 1)) { if (/^\S/.test(l) && !/^#/.test(l)) break; block.push(l); }
  // The direct children sit at the indent of the block's first key line; only a match at exactly that indent is the
  // owner's key. A match at any other indent (a nested key, text inside a block scalar) is refused, never read.
  const first = block.find(l => l.trim() !== '' && !/^\s*#/.test(l));
  if (first === undefined) return [];
  const indent = first.length - first.trimStart().length;
  const hits = block.map(l => new RegExp(`^(\\s+)${key}:(.*)$`).exec(l)).filter(Boolean);
  if (hits.some(h => h[1].length !== indent)) throw new UsageError('E_CONFIG_FORM', `.claude/pipeline.yaml ${parent}.${key} appears at a nested level or inside a block scalar; under contract 2 it must be a direct child of ${parent}:`);
  if (!hits.length) return [];
  const direct = hits;
  if (direct.length !== 1) throw new UsageError('E_CONFIG_FORM', `.claude/pipeline.yaml ${parent}.${key} appears more than once`);
  const m = /^\s*(\[.*\])\s*(#.*)?$/.exec(direct[0][2]);
  let value;
  try { value = m && strictParse(Buffer.from(m[1], 'utf8')).value; } catch { value = null; }
  if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) throw new UsageError('E_CONFIG_FORM', `.claude/pipeline.yaml ${parent}.${key} must be a one-line JSON array of strings under contract 2`);
  return value;
}

// ---- --mode design (design section 6.2) -------------------------------------------------------------------------
function designIdentity(ctx, args, commit, expectParent) {
  const L = lib();
  const S = schemas();
  const frozenDir = outside(ctx.repo, args['frozen-dir'], 'frozen-dir');
  const manifestPath = path.join(frozenDir, 'execution-plan.json');
  if (args.manifest !== undefined) need(sameFile(outside(ctx.repo, args.manifest, 'manifest'), manifestPath), 'E_IDENTITY', '--manifest must be <frozen-dir>/execution-plan.json');
  const mf = jsonV2(ctx, manifestPath, 'manifest');
  need(mf.sha256 === args['manifest-sha256'], 'E_IDENTITY', 'manifest hash differs from the frozen manifest hash');
  const manifest = mf.value;
  need(manifest.version === 2 && manifest.feature_id === args['feature-id'], 'E_IDENTITY', 'manifest version or feature does not match (contract 2 needs a version 2 manifest)');
  const schemaErrors = S.manifest(manifest);
  need(!schemaErrors.length, 'E_MANIFEST_SCHEMA', 'the manifest does not validate against execution-plan.v2.schema.json: ' + schemaErrors.slice(0, 5).map(e => e.code + ' ' + e.path).join('; '));
  const sourcePath = repoPath(manifest.source.path, false, 'source path');
  need(manifest.spec_sha256 === manifest.source.sha256, 'E_IDENTITY', 'manifest spec_sha256 differs from source.sha256');
  const resolved = gitBuf(ctx.repo, ['rev-parse', '--verify', '--quiet', commit + '^{commit}']);
  need(resolved.ok && resolved.stdout.toString().trim() === commit, 'E_IDENTITY', 'the design commit does not resolve: ' + commit);
  const blob = blobAt(ctx.repo, commit, sourcePath);
  need(blob, 'E_IDENTITY', `the design commit has no ${sourcePath}`);
  need(hash(blob) === manifest.source.sha256, 'E_IDENTITY', `the blob ${commit}:${sourcePath} does not hash to the manifest source.sha256`);
  // --spec: the canonical file in the checkout, byte-equal to the blob and clean.
  need(path.isAbsolute(args.spec), 'E_IDENTITY', '--spec must be an absolute path');
  const expectedSpec = path.join(ctx.repo, sourcePath);
  let realSpec;
  try { realSpec = fs.realpathSync(args.spec); } catch (e) { throw new GateError('E_IDENTITY', '--spec is unreadable: ' + e.message); }
  need(fs.existsSync(expectedSpec) && realSpec === fs.realpathSync(expectedSpec) && within(ctx.repo, realSpec), 'E_IDENTITY', `--spec must be ${expectedSpec}`);
  const specBytes = fs.readFileSync(realSpec);
  need(specBytes.equals(blob), 'E_IDENTITY', `the canonical file in the checkout differs from the committed blob ${commit}:${sourcePath} (an uncommitted edit, a CRLF checkout or a rewritten file)`);
  const specStatus = git(ctx.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', sourcePath]);
  need(specStatus === '', 'E_IDENTITY', `the canonical file is not clean: ${specStatus.replace(/\0/g, ' ')}`);
  ctx.spec = { path: realSpec, sha256: hash(specBytes) };
  // compile --check of the blob against the frozen dir.
  const compiled = L.compileFeature({ bytes: blob, repoPath: sourcePath, validateSchema: S.feature });
  need(compiled.valid, 'E_INVALID', 'the committed canonical file does not validate: ' + (compiled.errors || []).map(e => e.code + ' ' + e.path).join('; '));
  const drift = L.driftErrors(frozenDir, compiled.files);
  need(!drift.length, 'E_DRIFT', 'the frozen dir differs from a recompile of the committed blob: ' + drift.map(d => d.file + ' (' + d.message + ')').join('; '));
  need(manifest.compiler_version === L.render.COMPILER_VERSION && manifest.schema_version === 2, 'E_IDENTITY', 'compiler or schema version differs');
  // the design commit touches only the canonical file and has one parent.
  const names = git(ctx.repo, ['diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', commit]).split('\0').filter(Boolean);
  need(names.length === 1 && names[0] === sourcePath, 'E_IDENTITY', `the design commit must change exactly ${sourcePath}, it changes: ${names.join(', ') || '(nothing)'}`);
  const parents = git(ctx.repo, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ');
  need(parents.length === 2 && parents[0] === commit, 'E_IDENTITY', 'the design commit must have exactly one parent');
  const parent = parents[1];
  if (expectParent) need(parent === expectParent, 'E_IDENTITY', `the design commit's parent ${parent} is not --expect-parent ${expectParent}`);
  // approvals with F = the blob.
  const a = checkApprovals(ctx, { approvalsPath: args.approvals, approvalsSha: args['approvals-sha256'], F: blob, repoPath: sourcePath });
  need(a.ledger.start_head === parent, 'E_IDENTITY', `the ledger start_head ${a.ledger.start_head} is not the design commit's parent ${parent}`);
  // rev-0 fails closed.
  const rev0 = fs.existsSync(a.rev0File) ? artifact(ctx.repo, a.rev0File, 'rev-0 snapshot', ctx.reads).data : null;
  if (a.ledger.previous_design) {
    const pd = a.ledger.previous_design;
    const prior = blobAt(ctx.repo, pd.commit, pd.repo_path);
    need(prior, 'E_REV0', `previous_design ${pd.commit}:${pd.repo_path} does not exist`);
    need(rev0 && rev0.equals(prior), 'E_REV0', 'rev-0 must exist and equal the previous_design blob');
  } else {
    const prior = blobAt(ctx.repo, parent, sourcePath);
    if (prior) need(rev0 && rev0.equals(prior), 'E_REV0', `the design commit's parent holds ${sourcePath}: rev-0 must exist and equal it (a design without previous_design cannot drop its predecessor)`);
    else need(rev0 === null, 'E_REV0', 'rev-0 exists although neither previous_design nor the parent commit holds the canonical file');
  }
  // upper bound of model-authored exceptions.
  const configBlob = blobAt(ctx.repo, commit, '.claude/pipeline.yaml');
  let configText = null;
  if (configBlob) { try { configText = new TextDecoder('utf-8', { fatal: true }).decode(configBlob); } catch { throw new UsageError('E_CONFIG_FORM', '.claude/pipeline.yaml is not valid UTF-8'); } }
  const bound = { state_paths: boundList(configText, 'state', 'paths'), clean_ignore: boundList(configText, 'tests', 'clean_ignore'), known_failures: boundList(configText, 'tests', 'known_failures') };
  const knownIds = manifest.suite.known_failures.map(k => k.test_id);
  for (const [label, list, limit] of [['state_paths', manifest.state_paths, bound.state_paths], ['clean_ignore', manifest.clean_ignore, bound.clean_ignore], ['known_failures', knownIds, bound.known_failures]]) {
    const outsideBound = list.filter(x => !limit.includes(x));
    need(!outsideBound.length, 'E_CONFIG_BOUND', `${label} ${JSON.stringify(outsideBound)} lie outside the repo owner's .claude/pipeline.yaml list ${JSON.stringify(limit)} at the design commit`);
  }
  const output = {
    status: 'PASS', mode: 'design', contract: 2, feature_id: manifest.feature_id, design_commit: commit, design_parent: parent, design_paths: [sourcePath],
    source: { path: sourcePath, sha256: manifest.source.sha256 }, manifest_sha256: mf.sha256, prd_projection_sha256: manifest.views.prd_projection_sha256,
    prd_view_sha256: manifest.views.prd_view_sha256, spec_view_sha256: manifest.views.spec_view_sha256, compiler_version: manifest.compiler_version,
    schema_version: manifest.schema_version, approvals_sha256: a.approvals_sha256, approval_rule: a.rule, records: a.records,
    config_bound: { config_path: '.claude/pipeline.yaml', config_sha256: configBlob ? hash(configBlob) : null, ...bound },
    state_paths: manifest.state_paths, clean_ignore: manifest.clean_ignore, test_paths: manifest.test_paths, known_failure_ids: knownIds,
    unit_command: manifest.suite.unit_command, live_budget_min: manifest.suite.live_budget_min,
  };
  return { output, manifest, manifestSource: mf, blob, approvals: a, sourcePath, frozenDir };
}
function recheckV2(ctx, out) {
  for (const source of ctx.reads) {
    if (out) need(!sameFile(source.path, out), 'E_ALIAS', 'output must not overwrite or alias a read artifact: ' + source.path);
    need(artifact(ctx.repo, source.path, 'recheck').sha256 === source.sha256, 'E_RACE', 'input artifact changed during completion check: ' + source.path);
  }
  if (ctx.spec) need(hash(fs.readFileSync(ctx.spec.path)) === ctx.spec.sha256, 'E_RACE', 'the canonical file changed during the check');
}
function writeOnceJson(out, value) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temporary = out + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, out);
  } catch (e) {
    if (e.code === 'EEXIST') throw new GateError('E_OUT_EXISTS', 'the preflight record already exists: ' + out);
    throw e;
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function modeDesign(args) {
  const ctx = { repo: fs.realpathSync(git(args.repo, ['rev-parse', '--show-toplevel']).trim()), reads: [] };
  const out = args.out !== undefined ? outside(ctx.repo, args.out, 'output') : null;
  const d = designIdentity(ctx, args, args.commit, args['expect-parent']);
  recheckV2(ctx, out);
  if (out) writeOnceJson(out, d.output);
  return d.output;
}

// ---- shared contract-2 rules -------------------------------------------------------------------------------------
function commandsHoldRepo(manifest, repo, spelling) {
  const commands = [...manifest.requirements.map(r => r.proof_command), ...manifest.checks.map(c => c.command),
    manifest.suite.command, manifest.suite.unit_command, manifest.suite.setup_command].filter(c => typeof c === 'string' && c);
  const bad = commands.filter(c => c.includes(repo) || (spelling && c.includes(spelling)) || c.includes(path.resolve(spelling || repo)));
  need(!bad.length, 'E_REPO_PATH', 'a frozen command holds the repo absolute path: ' + bad.join(' | '));
}
function manifestPaths(manifest) {
  return {
    allowed: manifest.allowed_paths.map(p => repoPath(p, true, 'allowed path')),
    protectedPaths: manifest.protected_paths.map(p => repoPath(p, true, 'protected path')),
    statePaths: manifest.state_paths.map(p => repoPath(p, true, 'state path')),
    cleanIgnore: manifest.clean_ignore.map(p => repoPath(p, true, 'clean_ignore path')),
    testPaths: manifest.test_paths.map(p => repoPath(p, true, 'test path')),
  };
}
const insideEntry = (file, entry) => file === entry.replace(/\/$/, '') || file.startsWith(entry.endsWith('/') ? entry : entry + '/');

function modePlanV2(args) {
  const ctx = { repo: fs.realpathSync(git(args.repo, ['rev-parse', '--show-toplevel']).trim()), reads: [] };
  const sha = args['reviewed-sha'];
  const d = designIdentity(ctx, args, args.commit);
  const m = d.manifest;
  commandsHoldRepo(m, ctx.repo, args.repo);
  const p = manifestPaths(m);
  need(spawnSync('git', ['-C', ctx.repo, 'merge-base', '--is-ancestor', args.commit, sha]).status === 0, 'E_IDENTITY', 'the design commit must be an ancestor of the reviewed SHA');
  const atReviewed = blobAt(ctx.repo, sha, d.sourcePath);
  need(atReviewed && atReviewed.equals(d.blob), 'E_IDENTITY', `the canonical file at the reviewed SHA differs from the design blob`);
  assertCurrent(ctx.repo, sha, p.statePaths, p.cleanIgnore, p.protectedPaths);
  recheckV2(ctx, null);
  const checks = m.checks.filter(c => c.applicable).map(c => ({ id: c.id, name: c.name, quiet: c.quiet, effort: c.effort, budget_min: c.budget_min, timeout_min: c.timeout_min }));
  return {
    status: 'PASS', mode: 'plan', contract: 2, manifest_version: 2, feature_id: m.feature_id, reviewed_sha: sha, design_commit: args.commit,
    manifest_sha256: d.manifestSource.sha256, spec_sha256: m.spec_sha256, approvals_sha256: d.approvals.approvals_sha256,
    state_paths: m.state_paths, clean_ignore: m.clean_ignore, checks,
    limits: { proof_timeout_s: m.limits.proof_timeout_s, negative_controls_total_min: m.limits.negative_controls_total_min }, suite_setup: m.suite.setup_command !== null,
    runtime_acceptance_ids: m.requirements.filter(r => r.kind === 'runtime' && !r.live).map(r => r.id),
    live_acceptances: m.requirements.filter(r => r.kind === 'runtime' && r.live).map(r => ({ id: r.id, check_id: r.check_id })),
    negative_controls: m.requirements.filter(r => r.negative_control.method === 'isolated_mutation').map(r => ({ id: r.id, mutation_sha256: hash(Buffer.from(r.negative_control.mutation, 'utf8')) })),
  };
}

// A run-frozen record: hash, framed log, command, head, clean checkout.
function frozenRecord(ctx, file, expectedSha, label, { target, command, sha, ignores, protectedPaths }) {
  const loaded = strictJson(hashed(ctx, file, expectedSha, label), label);
  const r = loaded.value;
  need(isObj(r) && r.target === target, 'E_RECORD', `${label}: record target ${r && r.target} is not ${target}`);
  need(r.status !== 'NOT_RUN', 'E_RECORD', `${label}: NOT RUN`);
  need(r.command === command, 'E_RECORD', `${label}: the recorded command is not the frozen one`);
  need(r.head_before === sha && r.head_after === sha, 'E_RECORD', `${label}: not run on the reviewed SHA`);
  try {
    cleanReports(r.status_before, ignores, label + ' status_before', protectedPaths);
    cleanReports(r.status_after, ignores, label + ' status_after', protectedPaths);
  } catch (e) { throw new GateError('E_RECORD', e.message); }
  framedLog(ctx, r.log_path, r.log_sha256, label, { target, command: r.command, cwd: r.cwd, head: r.head_before }, r);
  return { record: r, sha256: loaded.sha256, path: loaded.path };
}
function framedLog(ctx, file, expectedSha, label, header, footerOf) {
  const log = hashed(ctx, file, expectedSha, label + ' log');
  const lines = log.data.toString('utf8').split('\n');
  need(lines[lines.length - 1] === '' && lines.length >= 3, 'E_RECORD', `${label}: the log is not framed`);
  const first = lines[0], last = lines[lines.length - 2];
  const parseLine = (line, prefix) => { try { return line.startsWith(prefix) ? JSON.parse(line.slice(prefix.length)) : null; } catch { return null; } };
  const h = parseLine(first, 'gp-run-frozen header '), f = parseLine(last, 'gp-run-frozen footer ');
  need(h && isDeepStrictEqual(h, header), 'E_RECORD', `${label}: the log header does not match the record`);
  need(f && isDeepStrictEqual(f, { exit_code: footerOf.exit_code, signal: footerOf.signal, elapsed_s: footerOf.elapsed_s }), 'E_RECORD', `${label}: the log footer does not match the record`);
}
const crashCode = code => [124, 126, 127].includes(code) || code >= 128;

// Review files of a stage: hashes, kinds, recomputed last-round verdicts.
function reviewFiles(ctx, stage, entries, steps, stageVerdicts, manifest) {
  need(Array.isArray(entries), 'E_REVIEW', `${stage} result has no review_files`);
  const byStep = new Map();
  const derived = [];
  for (const [i, e] of entries.entries()) {
    const label = `${stage} review_files[${i}]`;
    need(isObj(e) && steps.includes(e.step) && Number.isInteger(e.round) && e.round > 0 && typeof e.review_dir === 'string', 'E_REVIEW', `${label}: needs step (${steps.join('|')}), round and review_dir`);
    const keysCodex = ['result_path', 'result_sha256'], keysFallback = ['inputs_path', 'inputs_sha256', 'fallback_review_path', 'fallback_review_sha256'], keysRaw = ['raw_path', 'raw_sha256'];
    const base = ['step', 'round', 'reviewer', 'review_dir'];
    const kind = ['security', 'compliance'].includes(e.step) ? 'raw' : Object.hasOwn(e, 'result_path') ? 'codex' : 'fallback';
    need(keysExactly(e, [...base, ...(kind === 'raw' ? keysRaw : kind === 'codex' ? keysCodex : keysFallback)]), 'E_REVIEW', `${label}: unexpected or missing fields for a ${kind} review file`);
    for (const k of Object.keys(e).filter(k => k.endsWith('_path') && k !== 'review_dir')) need(inside(path.resolve(e[k]), path.resolve(e.review_dir)), 'E_REVIEW', `${label}: ${k} must lie in review_dir`);
    let reviewer, verdict, raw = null;
    if (kind === 'codex') {
      const result = strictJson(hashed(ctx, e.result_path, e.result_sha256, label + ' result.json'), label + ' result.json').value;
      need(isObj(result) && result.kind === 'implementation' && result.outcome === 'ok' && result.unable_to_review === null, 'E_REVIEW',
        `${label}: a codex review file must be an implementation result.json with outcome ok and unable_to_review null`);
      need(Array.isArray(result.findings), 'E_REVIEW', `${label}: result.json has no findings`);
      reviewer = 'codex';
      verdict = gateRule.codexGate('implementation', result).verdict;
    } else if (kind === 'fallback') {
      hashed(ctx, e.inputs_path, e.inputs_sha256, label + ' inputs.json');
      const fb = strictJson(hashed(ctx, e.fallback_review_path, e.fallback_review_sha256, label + ' fallback-review.json'), label + ' fallback-review.json').value;
      need(keysExactly(fb, ['gate_kind', 'reviewer', 'reply']) && fb.gate_kind === e.step && fb.reviewer === FALLBACK_REVIEWER, 'E_REVIEW',
        `${label}: fallback-review.json must be { gate_kind: ${e.step}, reviewer: ${FALLBACK_REVIEWER}, reply }`);
      reviewer = FALLBACK_REVIEWER;
      try { verdict = gateRule.fallbackGate('implementation', fb.reply).verdict; } catch (err) { throw new GateError('E_REVIEW', `${label}: ${err.message}`); }
    } else {
      raw = strictJson(hashed(ctx, e.raw_path, e.raw_sha256, label + ' raw file'), label + ' raw file').value;
      need(isObj(raw), 'E_REVIEW', `${label}: the raw file must be an object`);
      const wrapped = Object.hasOwn(raw, 'gate_kind');
      if (wrapped) need(keysExactly(raw, ['gate_kind', 'reviewer', 'reply']) && raw.gate_kind === e.step && raw.reviewer === FALLBACK_REVIEWER && isObj(raw.reply), 'E_REVIEW',
        `${label}: a wrapped fallback reply must be { gate_kind: ${e.step}, reviewer: ${FALLBACK_REVIEWER}, reply }`);
      reviewer = wrapped ? FALLBACK_REVIEWER : 'codex';
      const body = wrapped ? raw.reply : raw;
      if (e.step === 'security') {
        // Every list the file carries counts: codex security.json uses findings, the fallback reply blocking.
        const lists = [body.findings, body.blocking].filter(Array.isArray);
        need(lists.length > 0, 'E_REVIEW', `${label}: the security file has no findings`);
        const findings = lists.flat();
        verdict = findings.some(x => isObj(x) && ['critical', 'high'].includes(x.severity)) ? 'FAIL' : 'PASS';
      } else {
        const reqs = body.requirements;
        need(Array.isArray(reqs), 'E_REVIEW', `${label}: the compliance file has no requirements`);
        const ids = manifest.requirements.map(r => r.id).sort();
        const got = reqs.map(r => r && r.id).sort();
        const extraFindings = [body.findings, body.blocking].filter(Array.isArray).some(l => l.length);
        verdict = JSON.stringify(ids) === JSON.stringify(got) && reqs.every(r => r.status === 'PASS') && !extraFindings ? 'PASS' : 'FAIL';
      }
    }
    need(e.reviewer === reviewer, 'E_REVIEW', `${label}: labelled ${e.reviewer}, but its file is a ${reviewer} review`);
    derived.push({ stage, step: e.step, round: e.round, reviewer });
    if (!byStep.has(e.step)) byStep.set(e.step, []);
    byStep.get(e.step).push({ entry: e, verdict, raw });
  }
  const last = {};
  for (const step of steps) {
    const list = byStep.get(step) || [];
    need(list.length, 'E_REVIEW', `${stage} review_files has no ${step} entry`);
    const rounds = list.map(x => x.entry.round);
    need(new Set(rounds).size === rounds.length, 'E_REVIEW', `${stage} review_files repeats a ${step} round`);
    const top = list.reduce((a, b) => (b.entry.round > a.entry.round ? b : a));
    need(top.verdict === stageVerdicts[step], 'E_REVIEW', `${stage} ${step} verdict ${stageVerdicts[step]} differs from the verdict its review file gives: ${top.verdict}`);
    last[step] = top;
  }
  return { derived, last, fallback: derived.some(x => x.reviewer === FALLBACK_REVIEWER) };
}

function completionV2(args) {
  const ctx = { repo: fs.realpathSync(git(args.repo, ['rev-parse', '--show-toplevel']).trim()), reads: [] };
  const repo = ctx.repo;
  const sha = args['reviewed-sha'];
  const feature = text(args['feature-id'], 'feature-id');
  const out = outside(repo, args.out, 'output');
  const inputPaths = ['manifest', 'build-result', 'verify-result', 'approvals'].map(k => outside(repo, args[k], k));
  need(!inputPaths.some(file => sameFile(file, out)), 'E_ALIAS', 'output must not overwrite or alias an input artifact');
  const previousSource = args['previous-proof'] ? strictJson(artifact(repo, args['previous-proof'], 'previous proof'), 'previous proof') : null;
  const buildSource = jsonV2(ctx, args['build-result'], 'build result');
  const verifySource = jsonV2(ctx, args['verify-result'], 'verify result');
  const build = buildSource.value, verify = verifySource.value;
  need(build.build_mode !== 'charge-only', 'E_BUILD_MODE', 'a charge-only build result never certifies completion (build_mode "charge-only")');
  need(build.build_mode === 'v2', 'E_BUILD_MODE', 'a contract-2 completion needs a build result stamped build_mode "v2"');
  const pi = build.plan_identity;
  need(keysExactly(pi, ['design_commit', 'source_sha256', 'manifest_sha256', 'approvals_sha256', 'preflight_path', 'preflight_sha256']) && SHA.test(pi.design_commit),
    'E_BUILD', 'build plan_identity must be { design_commit, source_sha256, manifest_sha256, approvals_sha256, preflight_path, preflight_sha256 }');
  const designCommit = pi.design_commit;
  for (const [label, report] of [['build', build], ['verify', verify]]) {
    need(report.status === 'PASS', 'E_COMPLETION', label + ' result must PASS');
    need(report.feature_id === feature, 'E_COMPLETION', label + ' feature does not match');
    need(report.reviewed_sha === sha, 'E_COMPLETION', label + ' reviewed SHA does not match');
  }
  need(/^[0-9a-f]{7,40}$/.test(build.base_commit) && verify.base_commit === build.base_commit, 'E_COMPLETION', 'build and verify must retain the same original base commit');
  const base = git(repo, ['rev-parse', '--verify', build.base_commit + '^{commit}']).trim();
  need(base === designCommit, 'E_BUILD', `the build base_commit ${base} is not the design commit ${designCommit}`);
  need(spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', base, sha]).status === 0, 'E_COMPLETION', 'original base must be an ancestor of the reviewed SHA');

  // identity: a fresh --mode design, the reviewed blob, the schema, the repo-path rule.
  const d = designIdentity(ctx, args, designCommit);
  const manifest = d.manifest, manifestSource = d.manifestSource;
  need(pi.source_sha256 === manifest.source.sha256 && pi.manifest_sha256 === manifestSource.sha256 && pi.approvals_sha256 === d.approvals.approvals_sha256,
    'E_BUILD', 'build plan_identity differs from the manifest or approvals');
  const preflight = strictJson(hashed(ctx, pi.preflight_path, pi.preflight_sha256, 'build design preflight'), 'build design preflight');
  need(isDeepStrictEqual(JSON.parse(JSON.stringify(preflight.value)), JSON.parse(JSON.stringify(d.output))), 'E_BUILD', 'the build design preflight differs from a fresh --mode design output');
  const atReviewed = blobAt(repo, sha, d.sourcePath);
  need(atReviewed && atReviewed.equals(d.blob), 'E_IDENTITY', 'the canonical file at the reviewed SHA differs from the design blob');
  commandsHoldRepo(manifest, repo, args.repo);
  const p = manifestPaths(manifest);
  const { allowed, protectedPaths, statePaths, cleanIgnore, testPaths } = p;

  // v1 checks that keep their meaning.
  const initialState = assertCurrent(repo, sha, statePaths, cleanIgnore, protectedPaths);
  const changed = git(repo, ['diff', '--name-only', '--no-renames', '-z', base, sha]).split('\0').filter(Boolean).sort();
  for (const file of changed) {
    repoPath(file, false, 'changed path');
    need(allowed.some(entry => matchPath(file, entry)), 'E_SCOPE', 'scope violation: ' + file);
    need(!protectedPaths.some(entry => matchPath(file, entry)), 'E_SCOPE', 'protected path changed: ' + file);
  }
  review(build.review, sha, 'build review');
  need(build.security && build.security.verdict === 'PASS' && list(build.security.blocking, 'security blocking').length === 0, 'E_REVIEW', 'security review must PASS without blocking findings');
  const suite = build.suite;
  need(suite && suite.completed === true && typeof suite.passed === 'boolean', 'E_SUITE', 'suite must complete and report passed');
  pinned(suite, sha, 'suite', cleanIgnore, protectedPaths);
  need(list(suite.other_failures, 'suite other_failures').length === 0, 'E_SUITE', 'suite has non-test failures');
  const failures = [...unique(suite.failures, null, 'suite failures').keys()].sort();
  const seen = [...unique(build.known_failures_seen, null, 'known failures').keys()].sort();
  need(JSON.stringify(failures) === JSON.stringify(seen), 'E_SUITE', 'suite failures must exactly match known failures seen');
  need(suite.passed === (failures.length === 0), 'E_SUITE', 'suite passed flag contradicts its failure inventory');
  const suiteLog = artifact(repo, suite.log_path, 'suite output', ctx.reads);
  capturedHash(suite.log_sha256, suiteLog, 'suite output');
  review(verify.final_review, sha, 'final review');
  need(verify.manifest_sha256 === manifestSource.sha256, 'E_COMPLETION', 'verify manifest hash does not match the frozen manifest hash');
  const compliance = verify.compliance;
  need(compliance && compliance.verdict === 'PASS' && list(compliance.blocking, 'compliance blocking').length === 0, 'E_REVIEW', 'compliance must PASS without blocking findings');
  pinned(compliance, sha, 'compliance', cleanIgnore, protectedPaths);

  // suite identity and record (design 6.3, 6.5).
  const si = build.suite_identity;
  const ms = manifest.suite;
  const knownIds = ms.known_failures.map(k => k.test_id);
  need(keysExactly(si, ['command', 'known_failure_ids', 'isolated', 'setup_command', 'timeout_min', 'record_path', 'record_sha256']), 'E_SUITE', 'build suite_identity has unexpected or missing fields');
  need(isDeepStrictEqual({ command: si.command, known_failure_ids: si.known_failure_ids, isolated: si.isolated, setup_command: si.setup_command, timeout_min: si.timeout_min },
    { command: ms.command, known_failure_ids: knownIds, isolated: ms.isolated, setup_command: ms.setup_command, timeout_min: ms.timeout_min }), 'E_SUITE', 'build suite_identity differs from the manifest suite');
  const sr = frozenRecord(ctx, si.record_path, si.record_sha256, 'suite record', { target: 'suite', command: ms.command, sha, ignores: cleanIgnore, protectedPaths }).record;
  need(sr.timed_out === false, 'E_SUITE', 'the suite timed out');
  need(sr.timeout_s > 0 && sr.timeout_s <= ms.timeout_min * 60, 'E_SUITE', 'the suite ran under another limit than its timeout_min');
  if (ms.setup_command !== null) {
    need(isObj(sr.setup) && sr.setup.exit_code === 0 && sr.setup.timed_out === false, 'E_SUITE', 'the suite setup_command did not exit 0');
    const sf = readFooter(sr.setup.log_path);
    framedLog(ctx, sr.setup.log_path, sr.setup.log_sha256, 'suite setup', { target: 'suite.setup', command: ms.setup_command, cwd: sr.cwd, head: sha }, { exit_code: sr.setup.exit_code, signal: sf.signal, elapsed_s: sf.elapsed_s });
  } else need(sr.setup === null, 'E_SUITE', 'a suite record without setup_command must have setup null');
  need(path.resolve(String(suite.log_path)) === path.resolve(sr.log_path) && suite.log_sha256 === sr.log_sha256, 'E_SUITE', 'the build suite log is not the run-frozen suite log');
  need(Number.isInteger(sr.exit_code), 'E_SUITE', 'the suite record has no integer exit_code');
  need(failures.every(id => knownIds.includes(id)), 'E_SUITE', 'a suite failure is not a manifest known-failure id: ' + failures.filter(id => !knownIds.includes(id)).join(', '));
  if (seen.length === 0) need(sr.exit_code === 0, 'E_SUITE', `the suite exited ${sr.exit_code} while no known failure was seen`);
  else need(sr.exit_code !== 0 && !crashCode(sr.exit_code), 'E_SUITE', `known failures need a nonzero, non-crash suite exit (got ${sr.exit_code})`);
  need(suite.passed === (sr.exit_code === 0), 'E_SUITE', 'the build suite.passed contradicts the recorded exit code');
  const testsAdded = [...new Set((Array.isArray(build.history) ? build.history : []).flatMap(h => [h && h.work, h && h.fix].filter(isObj).flatMap(x => Array.isArray(x.tests_added) ? x.tests_added : [])))];
  const changedTests = changed.filter(f => testPaths.some(t => insideEntry(f, t)));
  for (const id of seen) {
    const named = [...testsAdded, ...changedTests].filter(t => typeof t === 'string' && t && id.includes(t));
    need(!named.length, 'E_SUITE', `known failure ${id} names a test this build added or changed: ${named.join(', ')}`);
  }

  // reviews, re-derived from the files.
  const br = reviewFiles(ctx, 'build', build.review_files, ['implementation', 'security'], { implementation: build.review.verdict, security: build.security.verdict }, manifest);
  const vr = reviewFiles(ctx, 'verify', verify.review_files, ['final', 'compliance'], { final: verify.final_review.verdict, compliance: compliance.verdict }, manifest);
  for (const [label, report, r] of [['build', build, br], ['verify', verify, vr]]) {
    if (Object.hasOwn(report, 'fallback_used')) need(report.fallback_used === r.fallback, 'E_REVIEW', `${label} result fallback_used ${report.fallback_used} differs from its review files (${r.fallback})`);
  }

  // checks (run-frozen records).
  const applicable = manifest.checks.filter(c => c.applicable);
  const recs = unique(verify.check_records, 'check_id', 'check records');
  for (const id of recs.keys()) need(applicable.some(c => c.id === id), 'E_CHECK', 'unknown or not applicable check record: ' + id);
  const checks = [];
  const checkRecords = new Map();
  for (const c of manifest.checks) {
    if (!c.applicable) { checks.push({ id: c.id, name: c.name, applicable: false, reason: c.reason }); continue; }
    need(recs.has(c.id), 'E_CHECK', 'missing check record: ' + c.id);
    const e = recs.get(c.id);
    const fr = frozenRecord(ctx, e.record_path, e.record_sha256, c.id + ' check record', { target: 'check:' + c.id, command: c.command, sha, ignores: cleanIgnore, protectedPaths });
    const r = fr.record;
    need(r.timeout_min === c.timeout_min && r.budget_min === c.budget_min, 'E_CHECK', `${c.id}: timeout_min or budget_min differ from the manifest`);
    const limitMin = c.budget_min > 0 ? c.budget_min : c.timeout_min;
    need(r.timeout_s > 0 && r.timeout_s <= limitMin * 60, 'E_CHECK', `${c.id}: run under a limit above the frozen one`);
    need(Number.isInteger(r.exit_code) && r.exit_code === 0, 'E_CHECK', `${c.id} check must exit 0 (got ${r.exit_code})`);
    need(r.timed_out === false, 'E_CHECK', `${c.id} check timed out`);
    if (c.budget_min > 0) need(typeof r.elapsed_s === 'number' && r.elapsed_s <= c.budget_min * 60 + 10, 'E_CHECK', `${c.id}: measured ${r.elapsed_s} s exceeds its budget of ${c.budget_min} min`);
    checkRecords.set(c.id, fr);
    checks.push({ id: c.id, name: c.name, applicable: true, status: 'PASS', record_path: fr.path, record_sha256: fr.sha256, log_path: r.log_path, log_sha256: r.log_sha256, elapsed_s: r.elapsed_s });
  }

  // proofs (acceptance ledger) and static evidence (compliance raw file).
  const al = verify.acceptance_ledger;
  need(keysExactly(al, ['path', 'sha256']), 'E_PROOF', 'verify acceptance_ledger must be { path, sha256 }');
  const ledger = strictJson(hashed(ctx, al.path, al.sha256, 'acceptance ledger'), 'acceptance ledger').value;
  need(keysExactly(ledger, ['version', 'entries']) && ledger.version === 2 && Array.isArray(ledger.entries), 'E_PROOF', 'the acceptance ledger must be { version: 2, entries }');
  const entries = unique(ledger.entries, 'id', 'acceptance ledger entries');
  const runtime = manifest.requirements.filter(r => r.kind === 'runtime');
  need(JSON.stringify([...entries.keys()].sort()) === JSON.stringify(runtime.map(r => r.id).sort()), 'E_PROOF',
    `the acceptance ledger ids ${JSON.stringify([...entries.keys()].sort())} are not the manifest runtime acceptance ids ${JSON.stringify(runtime.map(r => r.id).sort())}`);
  const rawCompliance = vr.last.compliance.raw;
  const traceReqs = (Object.hasOwn(rawCompliance, 'gate_kind') ? rawCompliance.reply : rawCompliance).requirements;
  const traces = unique(traceReqs, 'id', 'compliance requirements');
  const requirements = [];
  for (const acc of manifest.requirements) {
    const evidence = [];
    if (acc.kind === 'runtime') {
      const e = entries.get(acc.id);
      if (acc.live) {
        need(keysExactly(e, ['id', 'live', 'check_id', 'record_path', 'record_sha256']) && e.live === true && e.check_id === acc.check_id, 'E_PROOF', `${acc.id}: needs a live: link to ${acc.check_id}`);
        const fr = checkRecords.get(acc.check_id);
        need(fr && path.resolve(e.record_path) === fr.path && e.record_sha256 === fr.sha256, 'E_PROOF', `${acc.id}: the live link is not the ${acc.check_id} check record`);
        need(fr.record.command === acc.proof_command, 'E_PROOF', `${acc.id}: the linked check did not run the acceptance command`);
        evidence.push({ kind: 'runtime', live: true, check_id: acc.check_id, head_sha: sha, command: acc.proof_command, exit_code: 0, record_path: fr.path, record_sha256: fr.sha256, log_path: fr.record.log_path, log_sha256: fr.record.log_sha256 });
      } else {
        need(keysExactly(e, ['id', 'live', 'record_path', 'record_sha256']) && e.live === false, 'E_PROOF', `${acc.id}: needs a proof: record`);
        const fr = frozenRecord(ctx, e.record_path, e.record_sha256, acc.id + ' proof record', { target: 'proof:' + acc.id, command: acc.proof_command, sha, ignores: cleanIgnore, protectedPaths });
        need(Number.isInteger(fr.record.exit_code) && fr.record.exit_code === 0 && fr.record.timed_out === false, 'E_PROOF', `${acc.id} proof must exit 0 without timing out (got ${fr.record.exit_code})`);
        need(fr.record.timeout_s > 0 && fr.record.timeout_s <= manifest.limits.proof_timeout_s, 'E_PROOF', `${acc.id}: run under a limit above proof_timeout_s`);
        evidence.push({ kind: 'runtime', live: false, head_sha: sha, command: acc.proof_command, exit_code: 0, record_path: fr.path, record_sha256: fr.sha256, log_path: fr.record.log_path, log_sha256: fr.record.log_sha256 });
      }
    }
    need(traces.has(acc.id) && traces.get(acc.id).status === 'PASS', 'E_PROOF', `${acc.id} requirement must PASS in the compliance trace`);
    const items = list(traces.get(acc.id).evidence, acc.id + ' evidence').filter(x => isObj(x) && x.kind === 'static');
    const allowedStatic = [...acc.evidence_paths, ...acc.alternate_evidence_paths];
    let citesAlternate = false;
    for (const item of items) {
      need(item.head_sha === sha, 'E_PROOF', acc.id + ' evidence must have the reviewed SHA');
      const file = repoPath(item.file, false, acc.id + ' static file');
      need(allowedStatic.some(entry => insideEntry(file, entry)), 'E_PROOF', `${acc.id}: static evidence ${file} lies outside the frozen evidence_paths`);
      if (acc.alternate_evidence_paths.some(entry => insideEntry(file, entry))) citesAlternate = true;
      need(Number.isInteger(item.line) && item.line > 0, 'E_PROOF', acc.id + ' static line must be positive');
      const content = blobAt(repo, sha, file);
      need(content, 'E_PROOF', `${acc.id} static file does not exist at the reviewed SHA: ${file}`);
      const lines = content.toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      need(item.line <= lines.length && !content.includes(0), 'E_PROOF', `${acc.id} static line does not exist in a text file: ${file}:${item.line}`);
      evidence.push({ kind: 'static', head_sha: sha, file, line: item.line, file_sha256: hash(content) });
    }
    need(acc.kind !== 'static' || evidence.some(x => x.kind === 'static'), 'E_PROOF', acc.id + ' requirement needs static evidence');
    if (acc.negative_control.method === 'exempt' && acc.alternate_evidence_paths.length) need(citesAlternate, 'E_PROOF', `${acc.id}: an exempt P0 acceptance must cite an alternate_evidence_paths entry`);
    requirements.push({ id: acc.id, requirement_id: acc.requirement_id, kind: acc.kind, live: acc.live, status: 'PASS', evidence });
  }
  for (const id of traces.keys()) need(manifest.requirements.some(r => r.id === id), 'E_PROOF', 'unknown requirement trace: ' + id);

  // negative controls.
  const controls = unique(verify.negative_controls, 'id', 'negative controls');
  const isolated = manifest.requirements.filter(r => r.negative_control.method === 'isolated_mutation');
  for (const id of controls.keys()) need(isolated.some(r => r.id === id), 'E_NEGATIVE_CONTROL', 'negative control record for an id without isolated_mutation: ' + id);
  const negative = { isolated: [], exempt: [] };
  for (const acc of isolated) {
    need(controls.has(acc.id), 'E_NEGATIVE_CONTROL', `negative control ${acc.id} is NOT RUN (no record)`);
    const e = controls.get(acc.id);
    const label = acc.id + ' negative control';
    const loaded = strictJson(hashed(ctx, e.record_path, e.record_sha256, label), label);
    const r = loaded.value;
    need(isObj(r) && r.target === 'negative:' + acc.id && r.id === acc.id, 'E_NEGATIVE_CONTROL', `${label}: not a negative:${acc.id} record`);
    need(r.status !== 'NOT_RUN', 'E_NEGATIVE_CONTROL', `negative control ${acc.id} is NOT RUN: ${r.reason || ''}`);
    need(r.command === acc.proof_command, 'E_NEGATIVE_CONTROL', `${label}: not the frozen proof command`);
    need(r.head_before === sha && r.head_after === sha, 'E_NEGATIVE_CONTROL', `${label}: the work checkout was not pinned at the reviewed SHA`);
    try { cleanReports(r.status_before, cleanIgnore, label + ' status_before', protectedPaths); cleanReports(r.status_after, cleanIgnore, label + ' status_after', protectedPaths); }
    catch (err) { throw new GateError('E_NEGATIVE_CONTROL', err.message); }
    need(r.baseline_exit_code === 0 && r.baseline_timed_out === false, 'E_NEGATIVE_CONTROL', `${label}: the baseline proof must pass (exit ${r.baseline_exit_code}${r.baseline_timed_out ? ', timed out' : ''})`);
    need(r.timed_out === false, 'E_NEGATIVE_CONTROL', `${label}: the mutated proof timed out, which proves nothing`);
    need(Number.isInteger(r.exit_code), 'E_NEGATIVE_CONTROL', `${label}: exit codes must be integers (baseline ${r.baseline_exit_code}, mutated ${r.exit_code})`);
    need(r.exit_code !== 0, 'E_NEGATIVE_CONTROL', `${label}: the mutated proof still passes (weak control)`);
    need(!crashCode(r.exit_code), 'E_NEGATIVE_CONTROL', `${label}: the mutated proof crashed (exit ${r.exit_code}), which proves nothing`);
    need(typeof r.timeout_s === 'number' && r.timeout_s > 0 && r.timeout_s <= manifest.limits.proof_timeout_s, 'E_NEGATIVE_CONTROL', `${label}: run under a limit above proof_timeout_s`);
    if (ms.setup_command !== null) {
      need(isObj(r.setup) && r.setup.exit_code === 0 && r.setup.timed_out === false, 'E_NEGATIVE_CONTROL', `${label}: setup did not exit 0`);
      const sf = readFooter(r.setup.log_path);
      framedLog(ctx, r.setup.log_path, r.setup.log_sha256, label + ' setup', { target: r.target + '.setup', command: ms.setup_command, cwd: r.cwd, head: sha }, { exit_code: r.setup.exit_code, signal: sf.signal, elapsed_s: sf.elapsed_s });
    } else need(r.setup === null, 'E_NEGATIVE_CONTROL', `${label}: a control without setup_command must have setup null`);
    const bf = readFooter(r.baseline_log_path);
    framedLog(ctx, r.baseline_log_path, r.baseline_log_sha256, label + ' baseline', { target: r.target + '.baseline', command: r.command, cwd: r.cwd, head: sha }, { exit_code: r.baseline_exit_code, signal: bf.signal, elapsed_s: bf.elapsed_s });
    framedLog(ctx, r.log_path, r.log_sha256, label, { target: r.target, command: r.command, cwd: r.cwd, head: sha }, r);
    const patch = hashed(ctx, r.mutation_patch_path, r.mutation_patch_sha256, label + ' patch');
    need(patch.data.length > 0, 'E_NEGATIVE_CONTROL', `${label}: the patch is empty`);
    let derivedPaths;
    try { derivedPaths = require('./run-frozen.js').checkedPatchPaths(repo, patch.path, patch.data); } catch (err) { throw new GateError('E_NEGATIVE_CONTROL', `${label}: ${err.message}`); }
    need(isDeepStrictEqual(derivedPaths, r.mutated_paths), 'E_NEGATIVE_CONTROL', `${label}: recorded mutated_paths ${JSON.stringify(r.mutated_paths)} are not the patch's ${JSON.stringify(derivedPaths)}`);
    const index = path.join(os.tmpdir(), `gp-completion-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: index };
      need(gitBuf(repo, ['read-tree', sha], env).ok, 'E_NEGATIVE_CONTROL', `${label}: cannot read the reviewed tree`);
      const applies = gitBuf(repo, ['apply', '--cached', '--check'], env, patch.data); // the hashed bytes, on stdin
      need(applies.ok, 'E_NEGATIVE_CONTROL', `${label}: the patch does not apply to the reviewed SHA: ${applies.stderr.trim()}`);
    } finally { fs.rmSync(index, { force: true }); }
    const owned = manifest.components.filter(cmp => acc.component_ids.includes(cmp.id)).flatMap(cmp => cmp.owned_paths);
    for (const file of derivedPaths) {
      need(owned.some(o => insideEntry(file, o)), 'E_NEGATIVE_CONTROL', `${label}: ${file} lies outside the owned paths of ${acc.component_ids.join(', ')}`);
      need(!testPaths.some(t => insideEntry(file, t)), 'E_NEGATIVE_CONTROL', `${label}: ${file} lies under test_paths`);
      need(!testsAdded.includes(file), 'E_NEGATIVE_CONTROL', `${label}: ${file} is a test this build added`);
      need(!acc.proof_command.includes(file), 'E_NEGATIVE_CONTROL', `${label}: ${file} is named in the proof command`);
    }
    need(typeof r.phase_elapsed_s === 'number' && r.phase_elapsed_s <= manifest.limits.negative_controls_total_min * 60 + 10, 'E_NEGATIVE_CONTROL', `${label}: ran past negative_controls_total_min`);
    negative.isolated.push({ id: acc.id, record_path: loaded.path, record_sha256: loaded.sha256, baseline_exit_code: 0, mutated_exit_code: r.exit_code,
      mutation_patch_sha256: patch.sha256, mutated_paths: derivedPaths, phase_elapsed_s: r.phase_elapsed_s });
  }
  for (const acc of manifest.requirements.filter(r => r.negative_control.method === 'exempt')) negative.exempt.push({ id: acc.id, reason: acc.negative_control.exemption_reason });
  negative.counts = { isolated: negative.isolated.length, exempt: negative.exempt.length };

  // trunk qualification (land).
  let trunk = null;
  if (args['trunk-ref']) {
    const ref = args['trunk-ref'];
    const resolved = gitBuf(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
    need(resolved.ok, 'E_TRUNK', 'trunk-ref does not resolve: ' + ref);
    const trunkSha = resolved.stdout.toString().trim();
    const escaped = git(repo, ['rev-list', `${trunkSha}..${designCommit}^`]).trim();
    need(escaped === '', 'E_TRUNK', `commits before the design commit are not on ${ref}: ${escaped.split('\n').join(', ')}`);
    trunk = { ref, sha: trunkSha, pre_design_range_empty: true, pr_paths: [...new Set([...d.output.design_paths, ...changed, ...initialState.state_only_qualification.changed_paths])].sort() };
  }

  recheckV2(ctx, out);
  if (previousSource) need(artifact(repo, previousSource.path, 'previous proof recheck').sha256 === previousSource.sha256, 'E_RACE', 'previous proof changed during completion check');
  const finalState = assertCurrent(repo, sha, statePaths, cleanIgnore, protectedPaths);
  need(isDeepStrictEqual(initialState, finalState), 'E_RACE', 'Git state changed during completion check');
  const reviewers = [...d.approvals.reviewers, ...br.derived, ...vr.derived];
  const fallbackUsed = reviewers.some(x => x.reviewer === FALLBACK_REVIEWER);
  const proof = {
    version: 2, contract: 2, certification: 'design-gated', status: 'PASS', feature_id: feature, base_commit: base, reviewed_sha: sha,
    manifest_sha256: manifestSource.sha256, spec_sha256: manifest.spec_sha256, source: d.output.source, design_commit: designCommit, design_paths: d.output.design_paths,
    approvals_sha256: d.approvals.approvals_sha256, approval_rule: d.approvals.rule, approvals: d.approvals.records, config_bound: d.output.config_bound,
    state_paths: statePaths, clean_ignore: cleanIgnore,
    artifact_hashes: { build_result: buildSource.sha256, verify_result: verifySource.sha256, preflight: preflight.sha256, acceptance_ledger: al.sha256 },
    ...finalState,
    requirements, changed_files: changed, checks,
    reviews: { implementation: 'PASS', security: 'PASS', final: 'PASS', compliance: 'PASS' },
    reviewers, fallback_used: fallbackUsed, cross_family: !fallbackUsed,
    suite: { status: seen.length ? 'KNOWN_BASELINE_FAILURES' : 'GREEN', completed: true, exit_code: sr.exit_code, log_path: suiteLog.path, log_sha256: suiteLog.sha256,
      record_path: path.resolve(si.record_path), record_sha256: si.record_sha256 },
    known_failures_seen: seen,
    negative_controls: negative,
    repo_config: { build: isObj(build.repo_config) ? build.repo_config : null, verify: isObj(verify.repo_config) ? verify.repo_config : null },
    trunk_qualification: trunk,
    resume: { manifest_path: manifestSource.path, verify_result_path: verifySource.path, original_base_commit: base,
      note: 'Retain the frozen dir, the approvals ledger and the evidence. On interruption, rerun the stage as a new call with a fresh run_dir.' },
    handoff: { manifest_path: manifestSource.path, frozen_dir: d.frozenDir, spec_path: ctx.spec.path, approvals_path: path.resolve(args.approvals), build_result_path: buildSource.path,
      verify_result_path: verifySource.path, note: 'Only this reviewed commit is certified. The human or orchestrator decides whether to merge.' },
    checked_at: new Date().toISOString(),
  };
  if (previousSource) {
    const previous = previousSource.value;
    need(isObj(previous) && previous.contract === 2 && previous.status === 'PASS' && previous.feature_id === feature && previous.reviewed_sha === sha &&
      previous.base_commit === base && previous.manifest_sha256 === manifestSource.sha256, 'E_PREVIOUS', 'previous proof identity does not match this certification');
    need(isDeepStrictEqual(certification(JSON.parse(JSON.stringify(previous))), certification(JSON.parse(JSON.stringify(proof)))), 'E_PREVIOUS', 'previous proof differs from the current certified source hashes, traces or artifacts');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temporary = out + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temporary, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, out);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { status: 'PASS', contract: 2, certification: 'design-gated', proof_path: out, proof_sha256: hash(fs.readFileSync(out)), reviewed_sha: sha,
    design_commit: designCommit, manifest_sha256: manifestSource.sha256, state_paths: statePaths, clean_ignore: cleanIgnore,
    cross_family: !fallbackUsed, fallback_used: fallbackUsed, trunk_qualification: trunk };
}
function readFooter(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const last = lines[lines.length - 2] || '';
    return last.startsWith('gp-run-frozen footer ') ? JSON.parse(last.slice('gp-run-frozen footer '.length)) : {};
  } catch { return {}; }
}

function mainV2(argv) {
  try {
    const args = parseArgsV2(argv);
    const handler = { approvals: modeApprovals, design: modeDesign, plan: modePlanV2, completion: completionV2 }[args.mode];
    console.log(JSON.stringify(handler(args)));
    return 0;
  } catch (error) {
    const code = error instanceof GateError ? error.code : 'E_BLOCKED';
    console.error(JSON.stringify({ status: 'BLOCKED', code, reason: error.message }));
    return error instanceof UsageError ? 2 : 1;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (isContract2(argv)) process.exitCode = mainV2(argv);
  else {
    try { console.log(JSON.stringify(check(parseArgs(argv)))); }
    catch (error) { console.error(JSON.stringify({ status: 'BLOCKED', reason: error.message })); process.exitCode = 1; }
  }
}
module.exports = { check, parseArgs, mainV2, boundList };
