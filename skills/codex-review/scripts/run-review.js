#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const SEVERITIES = ['BLOCKING', 'MAJOR', 'MINOR', 'NIT'];
const REVIEW_FINDING_KEYS = ['id', 'severity', 'confidence', 'category', 'iso_property', 'location', 'claim', 'evidence', 'suggested_fix'];
const ISO_SET = new Set(['ambiguous', 'unverifiable', 'missing_acceptance_criteria', 'inconsistent', 'infeasible', 'incomplete']);
const REFUSAL_REGEX = /flagged for possible cybersecurity risk|I can(?:no|')t (?:help|assist) with|unable to assist with/i;

const REVIEW_TEMPLATE = `You are performing a quality assurance review of an artifact the requester owns. The goal is only to find ordinary defects so they can be fixed before the work is used.

Review kind: {{kind}}

Rubric:
{{rubric}}

Severity and confidence definitions:
- BLOCKING: must be fixed before use. Causes data loss, a security exposure, a crash on a normal path, or makes the document unusable as the basis for the next stage.
- MAJOR: a real defect that causes wrong behavior or rework.
- MINOR: real but low-impact.
- NIT: style.
- confidence is the probability the finding is real: >= 0.8 means checked against the artifact text or code path, 0.5-0.8 means likely, < 0.5 means speculative.

Scope to review:
{{scope}}

You may read any other file in the repository you need for context, such as callers, type definitions, tests, or config. Report findings only about the change or the files listed in scope above, never about other files you read only for context.

Report findings that satisfy the rubric above as a JSON object matching the provided schema. Do not include findings the rubric excludes. If you cannot review the artifact at all, set unable_to_review to a short explanation and leave findings empty.`;

// The rule below (REFUTE only with same-location evidence) is enforced by prompt
// instruction only, not by code: validation.schema.json's results carry just
// id/status/evidence, with no location field the runner could cross-check against
// the original finding's location. There is nothing structured here to verify a
// refutation cites the right place, so this cannot be a fake-suite case either — the
// stub always returns whatever status the scenario hardcodes, which only exercises
// plumbing and proves nothing about whether a real model honored the rule.
const VALIDATION_TEMPLATE = `You are validating findings from a prior quality-assurance review of an artifact the requester owns. For each finding below, open the artifact yourself at the cited location and decide:
- CONFIRM if the defect is present as described.
- REFUTE only when your evidence is about the exact same requirement or location the finding names. Evidence about a different requirement or a different part of the artifact never refutes the finding, even if that other evidence is true on its own.
- If your reading of the cited location is unclear or inconclusive, CONFIRM rather than REFUTE — an unclear location is not evidence of absence.
Quote the exact text you relied on as evidence, from the same location the finding names.

Scope:
{{scope}}

Findings to validate:
{{findings}}

Respond as a JSON object matching the provided schema, with one result per finding id.`;

class SetupError extends Error {
  constructor(outcome, message) { super(message); this.name = 'SetupError'; this.outcome = outcome; }
}

const render = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => {
  if (!(k in vars)) throw new Error(`template key ${k}`);
  return String(vars[k]);
});

function computeTriggers(kind, findings) {
  if (kind === 'implementation') {
    return findings.filter((f) => f.severity === 'BLOCKING' || (f.severity === 'MAJOR' && f.confidence >= 0.8));
  }
  const major = findings.filter((f) => f.severity === 'MAJOR');
  const byCount = major.length >= 3 ? major : [];
  const byIso = major.filter((f) => f.iso_property && ISO_SET.has(f.iso_property));
  const blocking = findings.filter((f) => f.severity === 'BLOCKING');
  const byId = new Map();
  for (const f of [...blocking, ...byIso, ...byCount]) byId.set(f.id, f);
  return [...byId.values()];
}

function computeVerdict(kind, findings, modelVerdict) {
  const reasons = [];
  const counted = findings.filter((f) => !f.validation || f.validation.status !== 'refuted');
  const triggers = computeTriggers(kind, counted);
  if (triggers.length > 0) {
    const confirmed = triggers.filter((f) => f.validation && f.validation.status === 'confirmed');
    if (confirmed.length > 0) {
      for (const f of confirmed) reasons.push(`${f.id} ${f.severity} conf ${f.confidence} (${kind})`);
      return { verdict: 'FAIL', reasons };
    }
    if (triggers.every((f) => f.validation && f.validation.status === 'unvalidated')) {
      reasons.push('validation_unavailable: all triggering findings unvalidated');
      return { verdict: 'NEEDS_HUMAN', reasons };
    }
    reasons.push('triggering findings left in an unexpected validation state');
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  const lowConf = counted.find((f) => (f.severity === 'BLOCKING' || f.severity === 'MAJOR') && f.confidence >= 0.5 && f.confidence < 0.8);
  if (lowConf) {
    reasons.push(`${lowConf.id} ${lowConf.severity} conf ${lowConf.confidence} in 0.5-0.8 band`);
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  // Both computed from `counted` (refuted findings already excluded above), never from
  // the raw `findings` — a refuted BLOCKING/MAJOR must never affect this comparison, the
  // same rule every other branch above already applies.
  const preTriggers = computeTriggers(kind, counted);
  const preVerdict = preTriggers.length > 0 ? 'FAIL'
    : counted.some((f) => (f.severity === 'BLOCKING' || f.severity === 'MAJOR') && f.confidence >= 0.5 && f.confidence < 0.8) ? 'NEEDS_HUMAN' : 'PASS';
  if (modelVerdict !== preVerdict) {
    reasons.push(`model_rule_disagreement: model said ${modelVerdict}, rule says ${preVerdict}`);
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  reasons.push('no triggering findings');
  return { verdict: 'PASS', reasons };
}

const FLAG_ARGS = { '--kind': 'kind', '--out-dir': 'outDir', '--repo': 'repo', '--against': 'against', '--model': 'model', '--effort': 'effort' };

function parseArgs(argv) {
  // Never throws: an unknown flag or a bad value is recorded in args.usageError and
  // scanning continues, so a valid --out-dir appearing anywhere in argv is still
  // captured and the caller can append one log line for the error instead of none.
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { args.help = true; continue; }
    if (a === '--uncommitted') { args.uncommitted = true; continue; }
    if (a === '--files') {
      args.filesMode = true;
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.files.push(argv[++i]);
      continue;
    }
    if (a === '--timeout-seconds') {
      const raw = argv[++i]; const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n) || n <= 0) { if (!args.usageError) args.usageError = `--timeout-seconds must be a positive finite number, got: ${raw}`; }
      else args.timeoutSeconds = n;
      continue;
    }
    if (FLAG_ARGS[a]) { args[FLAG_ARGS[a]] = argv[++i]; continue; }
    if (!args.usageError) args.usageError = `unknown argument: ${a}`;
  }
  if (!args.timeoutSeconds) args.timeoutSeconds = 300;
  return args;
}

function printHelp() {
  console.log([
    'node run-review.js --kind <implementation|prd|spec> --out-dir <dir>',
    '       ( --uncommitted | --files <path...> )',
    '       [--repo <dir>] [--against <prd-path>] [--model <slug>] [--effort <level>]',
    '       [--timeout-seconds <n, default 300>] [--help]',
    '',
    'Exit codes: 0 PASS, 1 FAIL, 3 NEEDS_HUMAN, 2 usage/setup/scope error.',
  ].join('\n'));
}

function validateArgsShape(args) {
  if (!['implementation', 'prd', 'spec'].includes(args.kind)) throw new SetupError('usage_error', 'kind must be implementation, prd, or spec');
  if (!args.outDir) throw new SetupError('usage_error', '--out-dir is required');
  if (args.filesMode && args.files.length === 0) throw new SetupError('usage_error', '--files requires at least one path');
  const flags = ['uncommitted', 'filesMode'].filter((k) => args[k]);
  if (args.kind === 'implementation') {
    if (flags.length !== 1) throw new SetupError('usage_error', 'implementation needs exactly one of --uncommitted, --files');
  } else {
    if (!args.filesMode) throw new SetupError('usage_error', `${args.kind} requires --files`);
    if (args.uncommitted) throw new SetupError('usage_error', `${args.kind} only supports --files`);
  }
  if (args.against && args.kind !== 'spec') throw new SetupError('usage_error', '--against is only allowed for spec');
}

function resolvePathOrThrow(p) {
  const resolved = path.resolve(process.cwd(), p);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new SetupError('scope_error', `file not found: ${p}`);
  return resolved;
}

function spawnTracked(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, shell: false, detached: !isWin, windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err.message || err), timedOut: false, spawnError: err });
      return;
    }
    // Buffers are collected as-is and decoded once at the end (not per chunk via
    // implicit toString()), so a multi-byte UTF-8 character split across two 'data'
    // events is never decoded as replacement characters in either half.
    let stdoutChunks = [], stderrChunks = [], timedOut = false, settled = false, killTimer = null;
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already dead */ }
          killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already dead */ } }, 5000);
          killTimer.unref();
        }
      } catch { /* best effort */ }
    }, opts.timeoutMs) : null;
    if (timer) timer.unref();
    child.stdout.on('data', (d) => { stdoutChunks.push(d); });
    child.stderr.on('data', (d) => { stderrChunks.push(d); });
    const decode = (chunks) => Buffer.concat(chunks).toString('utf8');
    child.on('error', (err) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      const stdout = decode(stdoutChunks), stderr = decode(stderrChunks);
      resolve({ code: null, stdout, stderr: stderr || String(err.message || err), timedOut, spawnError: err });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout: decode(stdoutChunks), stderr: decode(stderrChunks), timedOut });
    });
    try { if (opts.input != null) child.stdin.write(opts.input); child.stdin.end(); } catch { /* child may be gone */ }
  });
}

const runGit = (repo, args) => spawnTracked('git', args, { cwd: repo, timeoutMs: 30000 });

function resolveCodexInvocation() {
  if (process.platform !== 'win32') return { cmd: 'codex', prefixArgs: [] };
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, 'codex.exe');
    if (fs.existsSync(exe)) return { cmd: exe, prefixArgs: [] };
  }
  for (const dir of dirs) {
    const cmd = path.join(dir, 'codex.cmd');
    const codexJs = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(cmd) && fs.existsSync(codexJs)) return { cmd: process.execPath, prefixArgs: [codexJs] };
  }
  throw new SetupError('codex_not_found', 'codex not found on PATH: expected codex.exe, or codex.cmd beside node_modules/@openai/codex/bin/codex.js');
}

async function getCatalog(runDir) {
  let invocation;
  try { invocation = resolveCodexInvocation(); } catch { return { status: 'unavailable', models: [] }; }
  const result = await spawnTracked(invocation.cmd, [...invocation.prefixArgs, 'debug', 'models'], { timeoutMs: 30000 });
  try { fs.writeFileSync(path.join(runDir, 'catalog.stdout.txt'), result.stdout || '', 'utf8'); fs.writeFileSync(path.join(runDir, 'catalog.stderr.txt'), result.stderr || '', 'utf8'); } catch { /* best effort */ }
  if (result.code !== 0) return { status: 'unavailable', models: [] };
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed && parsed.models) ? { status: 'ok', models: parsed.models } : { status: 'unavailable', models: [] };
  } catch { return { status: 'unavailable', models: [] }; }
}

function resolveModelEffort(args, catalog) {
  let model = args.model;
  if (!model) {
    if (catalog.status !== 'ok') throw new SetupError('catalog_error', 'model catalog unavailable; pass --model');
    const eligible = catalog.models.filter((m) => m.visibility === 'list' && !/older|previous|legacy|deprecated/i.test(m.description || '')).sort((a, b) => a.priority - b.priority);
    if (!eligible.length) throw new SetupError('catalog_error', 'no eligible model in catalog; pass --model');
    model = eligible[0].slug;
  } else if (catalog.status === 'ok' && !catalog.models.find((m) => m.slug === model)) {
    throw new SetupError('usage_error', `unknown model ${model}; available: ${catalog.models.map((m) => m.slug).join(', ')}`);
  }
  return { model, effort: args.effort || 'high' };
}

async function buildScope(args) {
  const repo = path.resolve(args.repo || process.cwd());
  if (args.filesMode) {
    const files = args.files.map(resolvePathOrThrow);
    const against = args.against ? resolvePathOrThrow(args.against) : null;
    const lines = [`Review kind: ${args.kind}`, 'Scope: explicit file list', '', 'Files (read each from disk):', ...files];
    if (against) lines.push('', 'Reference document to trace against (read from disk):', against);
    return { mode: 'files', repo, files, against, scopeText: lines.join('\n') };
  }
  const staged = await runGit(repo, ['diff', '--staged']);
  if (staged.code !== 0) throw new SetupError('scope_error', staged.stderr);
  const unstaged = await runGit(repo, ['diff']);
  if (unstaged.code !== 0) throw new SetupError('scope_error', unstaged.stderr);
  const untrackedRaw = await runGit(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedRaw.code !== 0) throw new SetupError('scope_error', untrackedRaw.stderr);
  let untracked = untrackedRaw.stdout.split('\0').filter(Boolean).map((f) => path.resolve(repo, f));
  const outDirResolved = path.resolve(args.outDir);
  const before = untracked.length;
  untracked = untracked.filter((f) => f !== outDirResolved && !f.startsWith(outDirResolved + path.sep));
  if (untracked.length !== before) console.error('warning: excluded out-dir files from untracked scope');
  if (!staged.stdout.trim() && !unstaged.stdout.trim() && untracked.length === 0) throw new SetupError('empty_scope', 'no uncommitted changes and no untracked files');
  const lines = [
    `Review kind: ${args.kind}`, `Scope: uncommitted changes in ${repo}`, '',
    'Staged diff:', staged.stdout.trim() || '(none)', '',
    'Unstaged diff:', unstaged.stdout.trim() || '(none)', '',
    'New files (read from disk):', untracked.length ? untracked.join('\n') : '(none)',
  ];
  return { mode: 'uncommitted', repo, files: untracked, against: null, scopeText: lines.join('\n') };
}

// Shared by both shapes: every item needs a unique, non-empty string id, plus checkItem.
function validateIdArray(parsed, key, checkItem) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed[key])) return false;
  const ids = new Set();
  for (const item of parsed[key]) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !checkItem(item)) return false;
    ids.add(item.id);
  }
  return true;
}

const validateReviewShape = (parsed) => validateIdArray(parsed, 'findings', (f) => SEVERITIES.includes(f.severity) && typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1);
const validateValidationShape = (parsed) => validateIdArray(parsed, 'results', (r) => (r.status === 'CONFIRMED' || r.status === 'REFUTED') && typeof r.evidence === 'string');

const formatFindingsForValidation = (findings) => findings.map((f) => `id: ${f.id}\nseverity: ${f.severity}\ncategory: ${f.category}\nlocation: ${JSON.stringify(f.location)}\nclaim: ${f.claim}\nevidence: ${f.evidence}`).join('\n\n');

async function callCodexWithRetry({ call, runDir, promptBase, schemaPath, model, effort, repo, timeoutMs }) {
  let timeout = timeoutMs;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const f = {
      prompt: path.join(runDir, `${call}-${attempt}.prompt.md`), stdout: path.join(runDir, `${call}-${attempt}.stdout.txt`),
      stderr: path.join(runDir, `${call}-${attempt}.stderr.txt`), out: path.join(runDir, `${call}-${attempt}.out.json`),
    };
    fs.writeFileSync(f.prompt, promptBase, 'utf8');
    const invocation = resolveCodexInvocation();
    const args = [...invocation.prefixArgs, 'exec', '--skip-git-repo-check', '-C', repo, '--sandbox', 'read-only', '-m', model, '-c', `model_reasoning_effort=${effort}`, '--color', 'never', '--output-schema', schemaPath, '-o', f.out, '-'];
    const result = await spawnTracked(invocation.cmd, args, { cwd: repo, input: promptBase, timeoutMs: timeout });
    fs.writeFileSync(f.stdout, result.stdout || '', 'utf8');
    fs.writeFileSync(f.stderr, result.stderr || '', 'utf8');
    if (result.spawnError && result.spawnError.code === 'ENOENT') throw new SetupError('codex_not_found', 'codex executable not found (ENOENT)');
    if (result.timedOut) {
      if (attempt === 1) { timeout = timeoutMs * 2; continue; }
      return { outcome: 'timeout', attempts: attempt, exitCode: null, data: null };
    }
    if (result.code === 0 && fs.existsSync(f.out) && fs.statSync(f.out).size > 0) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(f.out, 'utf8')); } catch { return { outcome: 'invalid_output', attempts: attempt, exitCode: result.code, data: null }; }
      const shapeOk = call === 'review' ? validateReviewShape(parsed) : validateValidationShape(parsed);
      return shapeOk ? { outcome: 'ok', attempts: attempt, exitCode: result.code, data: parsed } : { outcome: 'invalid_output', attempts: attempt, exitCode: result.code, data: null };
    }
    if (REFUSAL_REGEX.test(`${result.stdout}\n${result.stderr}`)) {
      if (attempt === 1) continue;
      return { outcome: 'refused', attempts: attempt, exitCode: result.code, data: null };
    }
    if (result.code !== 0) return { outcome: 'codex_error', attempts: attempt, exitCode: result.code, data: null };
    return { outcome: 'invalid_output', attempts: attempt, exitCode: result.code, data: null };
  }
  return { outcome: 'invalid_output', attempts: 2, exitCode: null, data: null };
}

const loadRubric = (kind) => fs.readFileSync(path.join(SKILL_DIR, 'rubrics', `${kind}.md`), 'utf8');

const makeRunId = (kind) => `${kind}-${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}-${process.pid}`;

function makeRunDir(outDir, runId) {
  let id = runId, dir = path.join(outDir, id), suffix = 1;
  for (;;) {
    try { fs.mkdirSync(dir); return { dir, runId: id }; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      suffix++; id = `${runId}-${suffix}`; dir = path.join(outDir, id);
    }
  }
}

function countFindings(findings) {
  const c = { blocking: 0, major: 0, minor: 0, nit: 0, refuted: 0, unvalidated: 0 };
  for (const f of findings) {
    if (f.severity === 'BLOCKING') c.blocking++; else if (f.severity === 'MAJOR') c.major++;
    else if (f.severity === 'MINOR') c.minor++; else if (f.severity === 'NIT') c.nit++;
    if (f.validation && f.validation.status === 'refuted') c.refuted++;
    if (f.validation && f.validation.status === 'unvalidated') c.unvalidated++;
  }
  return c;
}

function writeResultIfPossible(state) {
  if (!state.run_dir) return;
  try {
    const result = {
      run_id: state.run_id, kind: state.kind, model: state.model, effort: state.effort, catalog_status: state.catalog_status,
      scope: state.scope, outcome: state.outcome, verdict: state.verdict, verdict_reasons: state.verdict_reasons,
      model_verdict: state.model_verdict, summary: state.summary, unable_to_review: state.unable_to_review,
      review: state.review, validation: state.validation, findings: state.findings, counts: state.counts,
    };
    fs.writeFileSync(path.join(state.run_dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  } catch { /* best effort */ }
}

function appendLog(outDir, state, exitCode) {
  try {
    const line = {
      ts: new Date().toISOString(), run_id: state.run_id, kind: state.kind, outcome: state.outcome, verdict: state.verdict,
      exit_code: exitCode, model: state.model, effort: state.effort, catalog_status: state.catalog_status,
      run_dir: state.run_dir || null, counts: state.counts, review_attempts: state.review ? state.review.attempts : null,
      validation_outcome: state.validation ? state.validation.outcome : null, duration_ms: state.duration_ms, error: state.error || null,
    };
    fs.appendFileSync(path.join(outDir, 'codex-review-log.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  } catch { /* best effort */ }
}

async function main() {
  const state = {
    run_id: null, run_dir: null, kind: null, model: null, effort: null, catalog_status: null, scope: null,
    outcome: null, verdict: null, verdict_reasons: [], model_verdict: null, summary: null, unable_to_review: null,
    review: null, validation: null, findings: [], counts: null, error: null,
  };
  const startedAt = Date.now();
  let code = 2;
  let outDir = null;

  // --help needs no out-dir and appends no log line; parseArgs() itself never throws.
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exitCode = 0; return; }
  state.kind = args.kind || null;

  try {
    if (!args.outDir) throw new SetupError('usage_error', '--out-dir is required');
    outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    fs.accessSync(outDir, fs.constants.W_OK);

    // Raised after --out-dir is resolved, so a parse-time error (unknown flag, bad
    // --timeout-seconds) still gets exactly one log line instead of none.
    if (args.usageError) throw new SetupError('usage_error', args.usageError);

    validateArgsShape(args);
    const runDirResult = makeRunDir(outDir, makeRunId(args.kind));
    state.run_id = runDirResult.runId; state.run_dir = runDirResult.dir;

    const catalog = await getCatalog(state.run_dir);
    state.catalog_status = catalog.status;
    const resolved = resolveModelEffort(args, catalog);
    state.model = resolved.model; state.effort = resolved.effort;

    const scope = await buildScope(args);
    state.scope = { mode: scope.mode, repo: scope.repo, files: scope.files, against: scope.against };

    const reviewPrompt = render(REVIEW_TEMPLATE, { kind: args.kind, rubric: loadRubric(args.kind), scope: scope.scopeText });
    const reviewResult = await callCodexWithRetry({
      call: 'review', runDir: state.run_dir, promptBase: reviewPrompt, schemaPath: path.join(SKILL_DIR, 'schemas', 'review.schema.json'),
      model: resolved.model, effort: resolved.effort, repo: scope.repo, timeoutMs: args.timeoutSeconds * 1000,
    });
    state.review = { attempts: reviewResult.attempts, exit_code: reviewResult.exitCode, timed_out: reviewResult.outcome === 'timeout', refused: reviewResult.outcome === 'refused' };

    if (reviewResult.outcome !== 'ok') {
      state.outcome = reviewResult.outcome; state.verdict = 'NEEDS_HUMAN';
      state.verdict_reasons = [`review outcome: ${reviewResult.outcome}`]; code = 3;
    } else {
      state.outcome = 'ok';
      const reviewData = reviewResult.data;
      state.summary = reviewData.summary ?? null;
      state.unable_to_review = reviewData.unable_to_review ?? null;
      state.model_verdict = reviewData.verdict ?? null;

      if (state.unable_to_review) {
        state.verdict = 'NEEDS_HUMAN'; state.verdict_reasons = ['unable_to_review set by model']; code = 3;
      } else {
        // 2.6: unknown keys are ignored and never copied (the schema enforces this too).
        let findings = (reviewData.findings || []).map((f) => ({
          ...Object.fromEntries(REVIEW_FINDING_KEYS.map((k) => [k, f[k]])), fingerprint: null,
        }));
        const needsValidation = findings.some((f) => f.severity === 'BLOCKING' || f.severity === 'MAJOR');
        let validationState = { outcome: 'skipped', attempts: 0 };
        if (needsValidation) {
          const toValidate = findings.filter((f) => f.severity === 'BLOCKING' || f.severity === 'MAJOR');
          const validationPrompt = render(VALIDATION_TEMPLATE, { scope: scope.scopeText, findings: formatFindingsForValidation(toValidate) });
          const validationResult = await callCodexWithRetry({
            call: 'validate', runDir: state.run_dir, promptBase: validationPrompt, schemaPath: path.join(SKILL_DIR, 'schemas', 'validation.schema.json'),
            model: resolved.model, effort: resolved.effort, repo: scope.repo, timeoutMs: args.timeoutSeconds * 1000,
          });
          validationState = { outcome: validationResult.outcome, attempts: validationResult.attempts };
          const byId = new Map();
          if (validationResult.outcome === 'ok') for (const r of validationResult.data.results) byId.set(r.id, r);
          findings = findings.map((f) => {
            if (f.severity !== 'BLOCKING' && f.severity !== 'MAJOR') return { ...f, validation: { status: 'not_required', evidence: null } };
            if (validationResult.outcome !== 'ok') return { ...f, validation: { status: 'unvalidated', evidence: null } };
            const r = byId.get(f.id);
            return r ? { ...f, validation: { status: r.status === 'CONFIRMED' ? 'confirmed' : 'refuted', evidence: r.evidence } } : { ...f, validation: { status: 'unvalidated', evidence: null } };
          });
        } else {
          findings = findings.map((f) => ({ ...f, validation: { status: 'not_required', evidence: null } }));
        }
        state.validation = validationState;
        const verdictResult = computeVerdict(args.kind, findings, state.model_verdict);
        state.verdict = verdictResult.verdict; state.verdict_reasons = verdictResult.reasons;
        state.findings = findings; state.counts = countFindings(findings);
        code = verdictResult.verdict === 'PASS' ? 0 : verdictResult.verdict === 'FAIL' ? 1 : 3;
      }
    }
  } catch (e) {
    if (e instanceof SetupError) { state.outcome = e.outcome; state.error = e.message; } else { state.outcome = state.outcome || 'runner_error'; state.error = e.message; }
    console.error(state.error);
    code = 2;
  } finally {
    state.duration_ms = Date.now() - startedAt;
    writeResultIfPossible(state);
    if (outDir) appendLog(outDir, state, code);
    process.exitCode = code;
  }
}

const fingerprint = () => null; // field kept for schema stability, always null

if (require.main === module) {
  main();
} else {
  module.exports = { computeVerdict, render, fingerprint, makeRunDir };
}
