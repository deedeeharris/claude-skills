#!/usr/bin/env node
'use strict';

// The metric list of plan 3.1 row 5.5 over one v2 design run dir (supplementary data for the evidence report).
// Read-only: it hashes and parses run-dir files, runs the real validate-feature.js on every rev-k snapshot and,
// when --repo is given, check-completion.js --mode approvals and read-only git plumbing. It writes nothing.
//
// Metrics (each a check with status PASS, FAIL or NOT_RUN, plus its data):
//   authoritative_files        files the design commit changes against start_head (or its parent): exactly one,
//                              and no v1 prd.md/spec.md beside the run; NOT_RUN without --repo and --commit
//   shadow_requirements        E_SHADOW_ID diagnostics per revision; the status is the final revision's
//   duplicate_requirements     E_DUP_ID + E_DUP_STATEMENT diagnostics per revision; the status is the final's
//   unresolved_references      E_REF diagnostics per revision; the status is the final's
//   approval_hash_consistency  every record of the last approvals-<n>.json against its rev dir (feature.json,
//                              out/ views, manifest and identity), the pinned source request and its review files;
//                              the frozen dir and, with --repo/--commit, the committed blob against the final spec
//                              PASS record
//   approvals_validator        check-completion.js --mode approvals exit code (NOT_RUN without --repo)
//   reviewer_rounds            records per gate with verdicts and reviewer labels; PASS when the latest PRD and the
//                              latest spec record are PASS
// The summary counts the checks by status.
//
// API: computeMetrics({ runDir, repo?, commit?, repoPath? }) -> { run_dir, revisions, checks, summary, metrics }
// CLI: v2-metrics.js --run-dir <dir> [--repo <abs>] [--commit <sha>] [--repo-path <rel>]  (prints the JSON)

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');

const SCRIPTS = path.resolve(__dirname, '../../scripts');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = p => { try { fs.statSync(p); return true; } catch { return false; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const hashFile = p => (exists(p) ? sha256(fs.readFileSync(p)) : null);

function node(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported by the caller */ }
  return { status: r.status, json, stderr: r.stderr };
}

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function revisionDirs(runDir) {
  return fs.readdirSync(runDir, { withFileTypes: true })
    .map(e => e.isDirectory() && /^rev-(0|[1-9][0-9]*)$/.exec(e.name))
    .filter(Boolean)
    .map(m => ({ rev: Number(m[1]), dir: path.join(runDir, m[0]) }))
    .filter(r => exists(path.join(r.dir, 'feature.json')))
    .sort((a, b) => a.rev - b.rev);
}

function repoPathFor(runDir, rev, opts, feature) {
  if (opts.repoPath) return opts.repoPath;
  for (const id of [path.join(rev.dir, 'out', 'compile-identity.json'), path.join(runDir, 'frozen', 'compile-identity.json')]) {
    const j = readJson(id);
    if (j && typeof j.source_path === 'string') return j.source_path;
  }
  return `features/${feature && typeof feature.feature_id === 'string' ? feature.feature_id : 'unknown'}.feature.json`;
}

function analyseRevision(runDir, rev, opts) {
  const file = path.join(rev.dir, 'feature.json');
  const feature = readJson(file);
  const reqs = feature && Array.isArray(feature.requirements) ? feature.requirements : null;
  const v = node('validate-feature.js', ['--file', file, '--repo-path', repoPathFor(runDir, rev, opts, feature)]);
  const errors = v.json && Array.isArray(v.json.errors) ? v.json.errors : [];
  const count = (...codes) => errors.filter(e => codes.includes(e.code)).length;
  return {
    rev: rev.rev,
    source_sha256: sha256(fs.readFileSync(file)),
    validator_exit: v.status,
    valid: v.status === 0,
    compiled: exists(path.join(rev.dir, 'out', 'execution-plan.json')),
    requirements: reqs ? reqs.length : null,
    active_requirements: reqs ? reqs.filter(r => r && r.status === 'active').length : null,
    shadow: count('E_SHADOW_ID'),
    duplicate: count('E_DUP_ID', 'E_DUP_STATEMENT'),
    unresolved: count('E_REF'),
    codes: [...new Set(errors.map(e => e.code))].sort(),
  };
}

function latestLedger(runDir) {
  const ns = fs.readdirSync(runDir).map(n => /^approvals-([1-9][0-9]*)\.json$/.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
  if (!ns.length) return null;
  const n = ns[ns.length - 1];
  const file = path.join(runDir, `approvals-${n}.json`);
  return { n, file, contiguous: ns.every((x, i) => x === i + 1), sha256: hashFile(file), doc: readJson(file) };
}

function recordMismatches(rec, ledger) {
  const out = [];
  const want = (what, actual, expected) => { if (actual !== expected) out.push(`${what}: ${actual === null ? 'missing' : 'differs'}`); };
  const dir = typeof rec.rev_dir === 'string' ? rec.rev_dir : '';
  want('feature.json sha256', hashFile(path.join(dir, 'feature.json')), rec.source_sha256);
  const id = readJson(path.join(dir, 'out', 'compile-identity.json'));
  want('identity source_sha256', id ? id.source_sha256 : null, rec.source_sha256);
  want('identity prd_projection_sha256', id ? id.prd_projection_sha256 : null, rec.prd_projection_sha256);
  want('identity spec.view.md', id && id.files ? id.files['spec.view.md'] : null, rec.spec_view_sha256);
  want('identity execution-plan.json', id && id.files ? id.files['execution-plan.json'] : null, rec.manifest_sha256);
  want('out/spec.view.md sha256', hashFile(path.join(dir, 'out', 'spec.view.md')), rec.spec_view_sha256);
  want('out/execution-plan.json sha256', hashFile(path.join(dir, 'out', 'execution-plan.json')), rec.manifest_sha256);
  want('record source_request_sha256', rec.source_request_sha256, ledger.source_request_sha256);
  if (rec.result_path !== undefined) {
    if (!exists(rec.result_path)) out.push('result.json: missing');
  } else {
    if (!exists(rec.inputs_path || '')) out.push('inputs.json: missing');
    want('fallback-review.json sha256', hashFile(rec.fallback_review_path || ''), rec.fallback_review_sha256);
  }
  return out;
}

function computeMetrics(opts) {
  const runDir = path.resolve(opts.runDir);
  if (!exists(runDir)) throw new Error(`run dir ${runDir} does not exist`);
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const metrics = {};

  // revisions and the three structural counts
  const revisions = revisionDirs(runDir).map(r => analyseRevision(runDir, r, opts));
  const reviewed = revisions.filter(r => r.rev > 0);
  const final = reviewed.length ? reviewed[reviewed.length - 1] : null;
  for (const [id, key] of [['shadow_requirements', 'shadow'], ['duplicate_requirements', 'duplicate'], ['unresolved_references', 'unresolved']]) {
    metrics[id] = { final: final ? final[key] : null, max: reviewed.length ? Math.max(...reviewed.map(r => r[key])) : null, per_rev: Object.fromEntries(revisions.map(r => [r.rev, r[key]])) };
    if (!final) add(id, 'NOT_RUN', 'no rev-k (k >= 1) snapshot in the run dir');
    else add(id, final[key] === 0 ? 'PASS' : 'FAIL', `final rev-${final.rev}: ${final[key]}; max over revisions: ${metrics[id].max}`);
  }

  // approvals ledger
  const ledger = latestLedger(runDir);
  const records = ledger && ledger.doc && Array.isArray(ledger.doc.records) ? ledger.doc.records : [];
  const lastOf = gate => [...records].reverse().find(r => r && r.gate === gate) || null;
  const lastSpec = lastOf('spec');
  if (!ledger) {
    metrics.approval_hash_consistency = null;
    add('approval_hash_consistency', 'NOT_RUN', 'no approvals-<n>.json in the run dir');
  } else {
    const doc = ledger.doc || {};
    const problems = [];
    if (!ledger.doc) problems.push(`approvals-${ledger.n}.json does not parse`);
    if (!ledger.contiguous) problems.push('the approvals-<n>.json files are not contiguous from 1');
    const reqSha = hashFile(doc.source_request_path || '');
    if (reqSha !== doc.source_request_sha256) problems.push(`source request: ${reqSha === null ? 'missing' : 'sha256 differs from the ledger'}`);
    const perRecord = records.map((rec, i) => ({ index: i, gate: rec.gate, rev: rec.rev, mismatches: recordMismatches(rec, doc) }));
    for (const r of perRecord) for (const m of r.mismatches) problems.push(`record ${r.index} (${r.gate} rev-${r.rev}): ${m}`);
    const frozenId = readJson(path.join(runDir, 'frozen', 'compile-identity.json'));
    const frozen = frozenId ? (lastSpec && frozenId.source_sha256 === lastSpec.source_sha256) : null;
    if (frozen === false) problems.push('frozen/compile-identity.json source_sha256 is not the final spec record\'s');
    let committed = null;
    if (opts.repo && opts.commit && frozenId && typeof frozenId.source_path === 'string') {
      const blob = spawnSync('git', ['cat-file', 'blob', `${opts.commit}:${frozenId.source_path}`], { cwd: opts.repo, env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
      committed = blob.status === 0 && lastSpec ? sha256(blob.stdout) === lastSpec.source_sha256 : false;
      if (!committed) problems.push('the committed blob is not the final spec record\'s bytes');
    }
    metrics.approval_hash_consistency = { ledger: path.basename(ledger.file), ledger_sha256: ledger.sha256, records: records.length,
      consistent_records: perRecord.filter(r => !r.mismatches.length).length, frozen_matches_final: frozen, committed_matches_final: committed, problems };
    add('approval_hash_consistency', problems.length ? 'FAIL' : 'PASS',
      problems.length ? problems.join('; ') : `${records.length} record(s) consistent with their rev dirs, the source request and their review files`);
  }

  if (!opts.repo) add('approvals_validator', 'NOT_RUN', 'no --repo given');
  else if (!ledger || !lastSpec) add('approvals_validator', 'NOT_RUN', 'no ledger with a spec record');
  else {
    const r = node('check-completion.js', ['--mode', 'approvals', '--repo', opts.repo, '--approvals', ledger.file, '--source', path.join(lastSpec.rev_dir, 'feature.json')]);
    metrics.approvals_validator = { exit: r.status, rule: r.json ? r.json.rule || null : null, errors: r.json && Array.isArray(r.json.errors) ? r.json.errors.map(e => e.code) : [] };
    add('approvals_validator', r.status === 0 ? 'PASS' : 'FAIL', `check-completion --mode approvals exit ${r.status}`);
  }

  // reviewer rounds
  const byGate = {};
  for (const rec of records) {
    const g = byGate[rec.gate] || (byGate[rec.gate] = { rounds: 0, verdicts: [], reviewers: [] });
    g.rounds++;
    g.verdicts.push(rec.verdict);
    if (!g.reviewers.includes(rec.reviewer)) g.reviewers.push(rec.reviewer);
  }
  metrics.reviewer_rounds = { total: records.length, by_gate: byGate, review_dirs: new Set(records.map(r => r.review_dir)).size };
  if (!records.length) add('reviewer_rounds', 'NOT_RUN', 'no ledger records');
  else {
    const prd = lastOf('prd');
    const ok = prd && prd.verdict === 'PASS' && lastSpec && lastSpec.verdict === 'PASS';
    add('reviewer_rounds', ok ? 'PASS' : 'FAIL', Object.entries(byGate).map(([g, v]) => `${g}: ${v.rounds} round(s) ${v.verdicts.join('/')}`).join('; '));
  }

  // authoritative files
  const v1Docs = ['prd.md', 'spec.md'].filter(n => exists(path.join(runDir, n)));
  if (!(opts.repo && opts.commit)) {
    metrics.authoritative_files = { count: null, files: null, v1_documents: v1Docs };
    add('authoritative_files', 'NOT_RUN', 'needs --repo and --commit (the design commit)');
  } else {
    const start = readJson(path.join(runDir, 'start-head.json'));
    const parent = start && typeof start.start_head === 'string' ? start.start_head : `${opts.commit}^`;
    const out = git(opts.repo, ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', parent, opts.commit]);
    const files = out === null ? null : out.split('\n').filter(Boolean);
    metrics.authoritative_files = { count: files ? files.length : null, files, v1_documents: v1Docs, parent };
    const ok = files && files.length === 1 && !v1Docs.length && !files.some(f => /(^|\/)(prd|spec)\.md$|(^|\/)execution-plan\.json$/.test(f));
    add('authoritative_files', ok ? 'PASS' : 'FAIL', files ? `${files.length} file(s): ${files.join(', ')}${v1Docs.length ? `; v1 documents in the run dir: ${v1Docs.join(', ')}` : ''}` : 'git diff-tree failed');
  }

  const order = ['authoritative_files', 'shadow_requirements', 'duplicate_requirements', 'unresolved_references', 'approval_hash_consistency', 'approvals_validator', 'reviewer_rounds'];
  checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const summary = { PASS: 0, FAIL: 0, NOT_RUN: 0 };
  for (const c of checks) summary[c.status]++;
  return { run_dir: runDir, revisions, checks, summary, metrics };
}

function cli(argv) {
  const flags = { '--run-dir': 'runDir', '--repo': 'repo', '--commit': 'commit', '--repo-path': 'repoPath' };
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = flags[argv[i]];
    if (!k || argv[i + 1] === undefined) { process.stderr.write(`usage: v2-metrics.js --run-dir <dir> [--repo <abs>] [--commit <sha>] [--repo-path <rel>]\n`); return 2; }
    opts[k] = argv[i + 1];
  }
  if (!opts.runDir) { process.stderr.write('--run-dir is required\n'); return 2; }
  try { process.stdout.write(JSON.stringify(computeMetrics(opts), null, 2) + '\n'); } catch (e) { process.stderr.write(e.message + '\n'); return 2; }
  return 0;
}

if (require.main === module) process.exitCode = cli(process.argv.slice(2));

module.exports = { computeMetrics };
