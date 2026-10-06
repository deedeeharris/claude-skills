#!/usr/bin/env node
'use strict';
// Offline suite: runs the real runner against the fake-codex.js stub, installed in
// all three resolution shapes (codex, codex.cmd, node_modules/@openai/codex/bin/codex.js)
// so the runner's real PATH-walking resolution (not a shortcut) is exercised. No network.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const RUNNER = path.join(SKILL_DIR, 'scripts', 'run-review.js');
const FAKE_CODEX_SRC = fs.readFileSync(path.join(__dirname, 'fake-codex.js'), 'utf8');
const { computeVerdict, makeRunDir } = require(RUNNER.replace(/\\/g, '/'));
const REAL_ACCEPTANCE = path.join(__dirname, 'run-real-acceptance.js');
const {
  matchesDefect, codexPidSet, diffLeakedCodex, leakedCodexSincePreRun,
  isDescendantOfAny, commandLineMatchesWorkDir, isLeakAttributableToRun, attributableLeaks,
} = require(REAL_ACCEPTANCE.replace(/\\/g, '/'));
const PLANTED_DEFECTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'planted-defects.json'), 'utf8'));
const defectById = (id) => PLANTED_DEFECTS.find((d) => d.id === id);

let passCount = 0;
let failCount = 0;
function check(label, cond, detail) {
  if (cond) { passCount++; console.log(`  ok - ${label}`); } else { failCount++; console.log(`  FAIL - ${label}${detail ? `: ${detail}` : ''}`); }
}

function getWorkDir() {
  const idx = process.argv.indexOf('--work-dir');
  if (idx >= 0) return path.resolve(process.argv[idx + 1]);
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-fake-'));
}

function installStub(workDir) {
  const bin = path.join(workDir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const codexPath = path.join(bin, 'codex');
  fs.writeFileSync(codexPath, FAKE_CODEX_SRC, 'utf8');
  try { fs.chmodSync(codexPath, 0o755); } catch { /* n/a on Windows */ }
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n', 'utf8');
  const nested = path.join(bin, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'codex.js'), FAKE_CODEX_SRC, 'utf8');
  return bin;
}

function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }

function makeRepo(workDir, name) {
  const repo = path.join(workDir, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'a@b.c']);
  git(repo, ['config', 'user.name', 'test']);
  return repo;
}

function runRunner(bin, scenario, stateDir, args, timeoutMs) {
  const env = Object.assign({}, process.env, {
    PATH: bin + path.delimiter + process.env.PATH,
    FAKE_CODEX_SCENARIO: scenario,
    FAKE_CODEX_STATE: stateDir,
  });
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', timeout: timeoutMs || 20000, env });
}

function readLastLog(outDir) {
  const file = path.join(outDir, 'codex-review-log.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

function readResult(runDir) {
  const file = path.join(runDir, 'result.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function findRunDir(outDir, logLine) {
  return logLine && logLine.run_dir ? logLine.run_dir : null;
}

function main() {
  const workDir = getWorkDir();
  fs.mkdirSync(workDir, { recursive: true });
  const bin = installStub(workDir);
  let caseIndex = 0;
  const nextDir = (prefix) => path.join(workDir, `${prefix}-${++caseIndex}`);

  console.log('== unit: computeVerdict verdict table ==');
  {
    const f = (sev, conf, iso, status) => ({ id: `F${Math.random()}`, severity: sev, confidence: conf, iso_property: iso || null, validation: { status: status || 'confirmed' } });
    const table = [
      ['implementation', [f('BLOCKING', 0.3)], 'FAIL', 'FAIL'],
      ['implementation', [f('MAJOR', 0.85)], 'FAIL', 'FAIL'],
      ['implementation', [f('MAJOR', 0.6)], 'NEEDS_HUMAN', 'NEEDS_HUMAN'],
      ['implementation', [f('MAJOR', 0.3)], 'PASS', 'PASS'],
      ['implementation', [f('MINOR', 0.9), f('MINOR', 0.9)], 'PASS', 'PASS'],
      ['implementation', [f('MINOR', 0.9)], 'FAIL', 'NEEDS_HUMAN'],
      ['prd', [f('MAJOR', 0.9, 'ambiguous')], 'FAIL', 'FAIL'],
      ['prd', [f('MAJOR', 0.9, null), f('MAJOR', 0.9, null)], 'PASS', 'PASS'],
      ['prd', [f('MAJOR', 0.9, null), f('MAJOR', 0.9, null), f('MAJOR', 0.9, null)], 'FAIL', 'FAIL'],
      ['prd', [f('MAJOR', 0.6, null)], 'NEEDS_HUMAN', 'NEEDS_HUMAN'],
      ['spec', [f('MAJOR', 0.9, 'inconsistent')], 'FAIL', 'FAIL'],
      // The only trigger (the BLOCKING) is refuted, so the refutation-filtered rule has
      // nothing left and says PASS; the model's own self-reported verdict (always taken
      // pre-validation) was FAIL. model-FAIL vs rule-PASS is a genuine disagreement, so
      // NEEDS_HUMAN is correct here — a refuted finding never gets to decide FAIL or PASS
      // on its own, but it can still surface a real model/rule disagreement for a human.
      ['spec', [f('BLOCKING', 0.9, null, 'refuted')], 'FAIL', 'NEEDS_HUMAN'],
      // Model-disagreement branch (run-review.js computeVerdict): the only trigger is
      // refuted, so `counted` has nothing and the model's own PASS must be left alone.
      // Before the fix this branch recomputed its own pre-verdict from the raw,
      // unfiltered `findings` array (still containing the refuted BLOCKING), got
      // preVerdict='FAIL', disagreed with modelVerdict='PASS', and returned NEEDS_HUMAN
      // — a refuted finding turning a PASS into NEEDS_HUMAN, exactly the defect this row
      // exists to catch.
      ['spec', [f('BLOCKING', 0.9, null, 'refuted')], 'PASS', 'PASS'],
    ];
    for (const [kind, findings, modelVerdict, expected] of table) {
      const r = computeVerdict(kind, findings, modelVerdict);
      check(`${kind} ${findings.map((x) => `${x.severity}/${x.confidence}`).join('+')} model=${modelVerdict}`, r.verdict === expected, `got ${r.verdict}`);
    }
  }

  console.log('== case 1: pass (0 findings) ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const stateDir = nextDir('state');
    const r = runRunner(bin, 'pass', stateDir, ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('exit 0', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
    const log = readLastLog(out);
    check('log outcome ok', log && log.outcome === 'ok');
    const runDir = findRunDir(out, log);
    check('review-1.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stdout.txt')));
    check('review-1.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stderr.txt')));
    const result = readResult(runDir);
    check('verdict PASS', result && result.verdict === 'PASS');
    check('validation skipped', result && result.validation && result.validation.outcome === 'skipped');
    const callLog = fs.readFileSync(path.join(stateDir, 'calls.jsonl'), 'utf8');
    const callLines = callLog.trim().split('\n').map((l) => JSON.parse(l));
    const argv = callLines.find((c) => c.call === 'review').argv;
    check('argv has --sandbox read-only', argv.includes('--sandbox') && argv.includes('read-only'));
    check('argv has -m', argv.includes('-m'));
    check('argv has --output-schema', argv.includes('--output-schema'));
    check('argv has -o', argv.includes('-o'));
    check('argv ends with -', argv[argv.length - 1] === '-');
    check('no dangerous flag', !argv.some((a) => String(a).includes('dangerously')));
  }

  console.log('== case 2: refuse-then-ok ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'refuse-then-ok', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('exit 0', r.status === 0, `exit=${r.status}`);
    const log = readLastLog(out);
    const runDir = findRunDir(out, log);
    check('review-2.prompt.md exists (retried)', runDir && fs.existsSync(path.join(runDir, 'review-2.prompt.md')));
    check('review-1.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stdout.txt')));
    check('review-1.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stderr.txt')));
    check('review-2.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-2.stdout.txt')));
    check('review-2.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-2.stderr.txt')));
  }

  console.log('== case 3: refuse-twice ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'refuse-twice', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('exit 3', r.status === 3);
    const log = readLastLog(out);
    check('outcome refused', log && log.outcome === 'refused');
    check('verdict NEEDS_HUMAN', log && log.verdict === 'NEEDS_HUMAN');
    const runDir = findRunDir(out, log);
    check('review-1.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stdout.txt')));
    check('review-1.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stderr.txt')));
    check('review-2.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-2.stdout.txt')));
    check('review-2.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-2.stderr.txt')));
  }

  console.log('== case 4: timeout kills process tree ==');
  {
    const out = nextDir('out');
    const state = nextDir('state');
    fs.mkdirSync(state, { recursive: true });
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'timeout', state, ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo, '--timeout-seconds', '1'], 30000);
    check('exit 3', r.status === 3, `exit=${r.status}`);
    const log = readLastLog(out);
    check('outcome timeout', log && log.outcome === 'timeout');
    check('2 attempts', log && log.review_attempts === 2);
    const runDir = findRunDir(out, log);
    check('review-1.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stdout.txt')));
    check('review-1.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stderr.txt')));
    check('review-2.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-2.stdout.txt')));
    check('review-2.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-2.stderr.txt')));
    const pidFile = path.join(state, 'timeout-child-pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      check('grandchild process no longer alive', !alive);
    } else {
      check('grandchild pid file written', false, 'pid file missing');
    }
  }

  console.log('== case 5/6/7: invalid output shapes ==');
  for (const scenario of ['empty-output', 'invalid-json', 'null-output', 'bad-findings-shape']) {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, scenario, nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    const log = readLastLog(out);
    check(`${scenario}: outcome invalid_output`, log && log.outcome === 'invalid_output', JSON.stringify(log));
    check(`${scenario}: exit 3`, r.status === 3);
    const runDir = findRunDir(out, log);
    check(`${scenario}: review-1.stdout.txt exists`, runDir && fs.existsSync(path.join(runDir, 'review-1.stdout.txt')));
    check(`${scenario}: review-1.stderr.txt exists`, runDir && fs.existsSync(path.join(runDir, 'review-1.stderr.txt')));
  }

  console.log('== case 8: nonzero exit with valid -o is not accepted ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'nonzero-exit', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    const log = readLastLog(out);
    check('outcome codex_error', log && log.outcome === 'codex_error');
    check('exit 3 (NEEDS_HUMAN)', r.status === 3);
    const runDir = findRunDir(out, log);
    check('review-1.stdout.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stdout.txt')));
    check('review-1.stderr.txt exists', runDir && fs.existsSync(path.join(runDir, 'review-1.stderr.txt')));
  }

  console.log('== case 9: catalog failure ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r1 = runRunner(bin, 'catalog-fail', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('no --model: exit 2', r1.status === 2);
    const log1 = readLastLog(out);
    check('no --model: outcome catalog_error', log1 && log1.outcome === 'catalog_error');
    const out2 = nextDir('out');
    const r2 = runRunner(bin, 'catalog-fail', nextDir('state'), ['--kind', 'implementation', '--out-dir', out2, '--uncommitted', '--repo', repo, '--model', 'fake-model-best']);
    check('with --model: completes', r2.status === 0 || r2.status === 1 || r2.status === 3);
    const log2 = readLastLog(out2);
    check('with --model: catalog_status unavailable', log2 && log2.catalog_status === 'unavailable');
  }

  console.log('== case 10: unknown --model ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'pass', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo, '--model', 'no-such-model']);
    check('exit 2', r.status === 2);
    const log = readLastLog(out);
    check('outcome usage_error', log && log.outcome === 'usage_error');
  }

  console.log('== case 11: run-id uniqueness (sequential) ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const runIds = new Set();
    for (let i = 0; i < 3; i++) {
      const r = runRunner(bin, 'pass', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
      const log = readLastLog(out);
      check(`run ${i} exit 0`, r.status === 0);
      runIds.add(log.run_id);
    }
    check('3 distinct run_ids', runIds.size === 3);
    for (const id of runIds) check(`run_id format ${id}`, /^implementation-\d{8}T\d{9}Z-\d+(-\d+)?$/.test(id), id);
  }

  console.log('== case 11b: makeRunDir EEXIST suffix (direct, forced collision) ==');
  {
    // Three sequential real runs never actually collide (timestamps differ), so case 11
    // above exercises only the format, never the retry branch in makeRunDir
    // (scripts/run-review.js). Force the collision directly against the real function.
    const out = nextDir('out');
    fs.mkdirSync(out, { recursive: true });
    const runId = 'implementation-forced-collision-id';
    fs.mkdirSync(path.join(out, runId));
    const first = makeRunDir(out, runId);
    check('first collision gets -2 suffix', first.runId === `${runId}-2`, first.runId);
    check('-2 directory actually created', fs.existsSync(first.dir) && fs.statSync(first.dir).isDirectory());
    const second = makeRunDir(out, runId);
    check('second collision gets -3 suffix', second.runId === `${runId}-3`, second.runId);
    check('-3 directory actually created', fs.existsSync(second.dir) && fs.statSync(second.dir).isDirectory());
    check('no suffix needed when id is free', makeRunDir(out, 'implementation-free-id').runId === 'implementation-free-id');
  }

  console.log('== case 12: literal rendering ($&, {{rubric}}) ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line one\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'init']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line one changed with $& and $1 and $$ and {{rubric}}\n');
    const r = runRunner(bin, 'special-chars', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('exit 0 or 1', r.status === 0 || r.status === 1, `exit=${r.status}`);
    const log = readLastLog(out);
    const promptPath = path.join(log.run_dir, 'review-1.prompt.md');
    const prompt = fs.readFileSync(promptPath, 'utf8');
    check('contains literal $&', prompt.includes('$&'));
    check('contains literal $1', prompt.includes('$1'));
    check('contains literal $$', prompt.includes('$$'));
    check('contains literal {{rubric}}', prompt.includes('{{rubric}}'));
    // The rubric file's own text (not the static REVIEW_TEMPLATE wrapper) — this is
    // what a double-expansion bug would duplicate, since the literal "{{rubric}}" sits
    // in the substituted scope text and a second render pass would re-expand it.
    const rubricSource = fs.readFileSync(path.join(SKILL_DIR, 'rubrics', 'implementation.md'), 'utf8');
    const rubricMarker = rubricSource.trim().split('\n')[0];
    const rubricOccurrences = prompt.split(rubricMarker).length - 1;
    check('rubric content appears exactly once', rubricOccurrences === 1, String(rubricOccurrences));
    check('special-chars: review-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('special-chars: review-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
  }

  console.log('== case 13: untracked file absolute path, out-dir excluded ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'new content');
    const outInsideRepo = path.join(repo, 'review-out');
    fs.mkdirSync(outInsideRepo, { recursive: true });
    fs.writeFileSync(path.join(outInsideRepo, 'leftover.txt'), 'stale');
    const r = runRunner(bin, 'pass', nextDir('state'), ['--kind', 'implementation', '--out-dir', outInsideRepo, '--uncommitted', '--repo', repo]);
    check('exit 0', r.status === 0);
    const log = readLastLog(outInsideRepo);
    const prompt = fs.readFileSync(path.join(log.run_dir, 'review-1.prompt.md'), 'utf8');
    check('untracked file listed as absolute path', prompt.includes(path.resolve(repo, 'new-file.txt')));
    check('out-dir leftover excluded', !prompt.includes('leftover.txt'));
  }

  console.log('== case 14: relative --files resolved; missing file errors ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    const prdFile = path.join(repo, 'prd.md');
    fs.writeFileSync(prdFile, '# PRD\n');
    const r = runRunner(bin, 'pass', nextDir('state'), ['--kind', 'prd', '--out-dir', out, '--files', path.relative(process.cwd(), prdFile) || prdFile, '--repo', repo]);
    check('exit 0', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
    const log = readLastLog(out);
    const prompt = fs.readFileSync(path.join(log.run_dir, 'review-1.prompt.md'), 'utf8');
    check('prompt has absolute resolved path', prompt.includes(path.resolve(prdFile)));
    const out2 = nextDir('out');
    const r2 = runRunner(bin, 'pass', nextDir('state'), ['--kind', 'prd', '--out-dir', out2, '--files', path.join(repo, 'does-not-exist.md'), '--repo', repo]);
    check('missing file: exit 2', r2.status === 2);
    const log2 = readLastLog(out2);
    check('missing file: outcome scope_error', log2 && log2.outcome === 'scope_error');
  }

  console.log('== case 16: empty uncommitted scope ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const r = runRunner(bin, 'pass', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('exit 2', r.status === 2);
    const log = readLastLog(out);
    check('outcome empty_scope', log && log.outcome === 'empty_scope');
  }

  console.log('== case 17: runner-owned fields ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'runner-owned-fields', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo, '--model', 'fake-model-best']);
    check('exit 0', r.status === 0);
    const log = readLastLog(out);
    const result = readResult(log.run_dir);
    check('result.model is runner model, not stub value', result.model === 'fake-model-best');
  }

  console.log('== case 18: validation confirm/refute paths ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    let r = runRunner(bin, 'validation-confirm-refute', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    let log = readLastLog(out);
    let result = readResult(log.run_dir);
    check('confirm/refute: FAIL', result.verdict === 'FAIL');
    const f1 = result.findings.find((f) => f.id === 'F1');
    check('F1 kept and marked refuted', f1 && f1.validation.status === 'refuted');
    check('validate-1.prompt.md exists', fs.existsSync(path.join(log.run_dir, 'validate-1.prompt.md')));
    check('validate-1.out.json exists', fs.existsSync(path.join(log.run_dir, 'validate-1.out.json')));
    check('confirm/refute: review-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('confirm/refute: review-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
    check('confirm/refute: validate-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stdout.txt')));
    check('confirm/refute: validate-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stderr.txt')));

    const out2 = nextDir('out');
    r = runRunner(bin, 'validation-both-refuted', nextDir('state'), ['--kind', 'implementation', '--out-dir', out2, '--uncommitted', '--repo', repo]);
    log = readLastLog(out2);
    result = readResult(log.run_dir);
    // The model self-reported FAIL (it saw the BLOCKING+MAJOR pre-validation); both are
    // then refuted, so the refutation-filtered rule has nothing left and says PASS —
    // model said FAIL, rule says PASS, a genuine disagreement the check must surface as
    // NEEDS_HUMAN rather than silently resolving to either side. (Before the model-
    // disagreement fix this came out PASS instead, for the wrong reason: the bug computed
    // its own pre-verdict from the unfiltered findings, which still had the BLOCKING,
    // and that accidentally matched the model's FAIL, skipping the disagreement branch
    // entirely rather than evaluating it correctly.)
    check('both refuted: NEEDS_HUMAN (model said FAIL, refutation-filtered rule says PASS)', result.verdict === 'NEEDS_HUMAN', JSON.stringify(result.verdict_reasons));
    check('both refuted: review-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('both refuted: review-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
    check('both refuted: validate-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stdout.txt')));
    check('both refuted: validate-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stderr.txt')));

    const out3 = nextDir('out');
    r = runRunner(bin, 'validation-missing-id', nextDir('state'), ['--kind', 'implementation', '--out-dir', out3, '--uncommitted', '--repo', repo]);
    log = readLastLog(out3);
    result = readResult(log.run_dir);
    const f2 = result.findings.find((f) => f.id === 'F2');
    check('missing id: unvalidated', f2 && f2.validation.status === 'unvalidated');
    check('missing id: NEEDS_HUMAN', result.verdict === 'NEEDS_HUMAN');
    check('missing id: review-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('missing id: review-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
    check('missing id: validate-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stdout.txt')));
    check('missing id: validate-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stderr.txt')));

    const out4 = nextDir('out');
    r = runRunner(bin, 'validation-timeout', nextDir('state'), ['--kind', 'implementation', '--out-dir', out4, '--uncommitted', '--repo', repo, '--timeout-seconds', '1'], 30000);
    log = readLastLog(out4);
    check('validation timeout: NEEDS_HUMAN', log.verdict === 'NEEDS_HUMAN');
    check('validation timeout: validation outcome timeout', log.validation_outcome === 'timeout');
    check('validation timeout: review-1.stdout.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('validation timeout: review-1.stderr.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
    check('validation timeout: validate-1.stdout.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'validate-1.stdout.txt')));
    check('validation timeout: validate-1.stderr.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'validate-1.stderr.txt')));
    check('validation timeout: validate-2.stdout.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'validate-2.stdout.txt')));
    check('validation timeout: validate-2.stderr.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'validate-2.stderr.txt')));

    // A refuted finding must not still count toward the prd/spec "3+ MAJOR" threshold.
    // Only an implementation fixture was covered above, where a single surviving
    // confirmed MAJOR (0.9) already triggers FAIL on its own regardless of any count,
    // so it could not catch a bug that let refuted findings count toward 3+.
    // The count-exclusion itself is confirmed by `matched`/counts below; the verdict
    // comes out NEEDS_HUMAN rather than PASS for the same reason as "both refuted"
    // above — the model self-reported FAIL (it saw 3 raw MAJORs pre-validation), one
    // gets refuted, the refutation-filtered rule then has only 2 MAJORs (below the 3+
    // threshold) and says PASS, and model-FAIL-vs-rule-PASS is a genuine disagreement.
    const out5 = nextDir('out');
    r = runRunner(bin, 'three-major-one-refuted', nextDir('state'), ['--kind', 'prd', '--out-dir', out5, '--files', path.join(repo, 'a.txt')]);
    log = readLastLog(out5);
    result = readResult(log.run_dir);
    check('prd 3 MAJOR with 1 refuted: NEEDS_HUMAN (refuted excluded from count, model said FAIL, rule says PASS)', result && result.verdict === 'NEEDS_HUMAN', JSON.stringify(result && result.verdict_reasons));
    const refutedOne = result && result.findings.find((f) => f.id === 'F1');
    check('prd: F1 kept and marked refuted', refutedOne && refutedOne.validation.status === 'refuted');
    check('three-major-one-refuted: review-1.stdout.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('three-major-one-refuted: review-1.stderr.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
    check('three-major-one-refuted: validate-1.stdout.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'validate-1.stdout.txt')));
    check('three-major-one-refuted: validate-1.stderr.txt exists', log.run_dir && fs.existsSync(path.join(log.run_dir, 'validate-1.stderr.txt')));
  }

  console.log('== case 19: only MINOR findings skip validation ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'minor-only-no-validation', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    const log = readLastLog(out);
    check('validation skipped', log.validation_outcome === 'skipped');
    check('no validate-1 files', !fs.existsSync(path.join(log.run_dir, 'validate-1.prompt.md')));
  }

  console.log('== case 20: unknown finding keys are stripped, never copied ==');
  {
    // Section 2.6: "Unknown keys are ignored and never copied." The real schema's
    // additionalProperties:false would stop a genuine Codex call from emitting this,
    // so this has to go through the stub to exercise the runner's own defensive code.
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'review-unknown-keys', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('exit 0', r.status === 0);
    const log = readLastLog(out);
    const result = readResult(log.run_dir);
    const f1 = result && result.findings.find((f) => f.id === 'F1');
    check('finding present', !!f1);
    check('unknown key not copied', f1 && !('confirmed_by_reproduction' in f1), JSON.stringify(f1));
    check('documented keys survive', f1 && f1.claim === 'x' && f1.severity === 'MINOR');
  }

  console.log('== case 21: validation shape rejects a duplicate id ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'validation-duplicate-id', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    const log = readLastLog(out);
    check('validation outcome invalid_output', log.validation_outcome === 'invalid_output', JSON.stringify(log));
    const result = readResult(log.run_dir);
    check('verdict NEEDS_HUMAN (validation_unavailable, not a silently-kept overwrite)', result && result.verdict === 'NEEDS_HUMAN', JSON.stringify(result && result.verdict_reasons));
    const f1 = result && result.findings.find((f) => f.id === 'F1');
    check('F1 unvalidated, not silently confirmed by the later duplicate', f1 && f1.validation.status === 'unvalidated', JSON.stringify(f1));
    check('duplicate id: review-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('duplicate id: review-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
    check('duplicate id: validate-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stdout.txt')));
    check('duplicate id: validate-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stderr.txt')));
  }

  console.log('== case 22: validation shape rejects a non-enum status instead of treating it as refuted ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'validation-bad-status', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    const log = readLastLog(out);
    check('validation outcome invalid_output', log.validation_outcome === 'invalid_output', JSON.stringify(log));
    const result = readResult(log.run_dir);
    const f1 = result && result.findings.find((f) => f.id === 'F1');
    check('F1 unvalidated, not coerced to refuted', f1 && f1.validation.status === 'unvalidated', JSON.stringify(f1));
    check('verdict NEEDS_HUMAN', result && result.verdict === 'NEEDS_HUMAN');
    check('bad status: review-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stdout.txt')));
    check('bad status: review-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'review-1.stderr.txt')));
    check('bad status: validate-1.stdout.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stdout.txt')));
    check('bad status: validate-1.stderr.txt exists', fs.existsSync(path.join(log.run_dir, 'validate-1.stderr.txt')));
  }

  console.log('== case 23: real-acceptance matcher — category/iso alone cannot cross-match defects ==');
  {
    // Reproduces the exact false positive Codex demonstrated against the pre-fix matcher:
    // an unrelated "missing authorization check" finding at code-planted.js:10 (inside
    // D4's own line range) with category=security must NOT count as locating D4 (the SQL
    // injection defect) just because location and category both happen to line up.
    const d4 = defectById('D4');
    const authFinding = { severity: 'MAJOR', category: 'security', iso_property: null, location: { file: 'code-planted.js', line: 10, section: null }, claim: 'missing authorization check before returning the user row', evidence: 'no role check in findUserById' };
    check('D4: co-located, same-category auth finding does not match', !matchesDefect(authFinding, d4), JSON.stringify(authFinding));

    const sqlFinding = { severity: 'MAJOR', category: 'security', iso_property: null, location: { file: 'code-planted.js', line: 9, section: null }, claim: 'SQL injection: userId is concatenated directly into the query string', evidence: "'...WHERE id = ' + userId" };
    check('D4: genuine SQL-injection claim at the same location matches', matchesDefect(sqlFinding, d4), JSON.stringify(sqlFinding));

    const d5 = defectById('D5');
    check('D5: the same auth finding (wrong location) does not match either', !matchesDefect(authFinding, d5));
  }

  console.log('== case 24: real-acceptance matcher — sectionRegex is file-identity-checked ==');
  {
    // D3's sectionRegex matches a bare "A" or "B" section header. Section text from the
    // OTHER document in scope (the PRD a spec run traces against) must not count just
    // because its section label happens to match the same regex.
    const d3 = defectById('D3');
    const wrongFileFinding = { severity: 'MAJOR', category: 'inconsistent', iso_property: 'inconsistent', location: { file: 'prd-planted.md', line: null, section: 'A' }, claim: 'unrelated PRD-side note', evidence: 'x' };
    check('D3: right section text, wrong named file does not match', !matchesDefect(wrongFileFinding, d3), JSON.stringify(wrongFileFinding));

    const rightFileFinding = { severity: 'MAJOR', category: 'inconsistent', iso_property: 'inconsistent', location: { file: 'spec-planted.md', line: null, section: 'Work item A' }, claim: 'A and B both own delivery-router.ts', evidence: 'Owns: delivery-router.ts (both items)' };
    check('D3: right file still matches', matchesDefect(rightFileFinding, d3), JSON.stringify(rightFileFinding));

    const noFileFinding = { severity: 'MAJOR', category: 'inconsistent', iso_property: 'inconsistent', location: { file: null, line: null, section: 'Work item B' }, claim: 'A and B both own delivery-router.ts', evidence: 'x' };
    check('D3: omitted file (the common case for a doc-section finding) still matches on section alone', matchesDefect(noFileFinding, d3), JSON.stringify(noFileFinding));
  }

  console.log('== case 24b: real-acceptance matcher — the real round-3 SQLi finding (no literal sql/inject/concat) matches D4 ==');
  {
    // Copied verbatim (claim+evidence) from the real codex exec result that broke the old
    // "sql|inject|concat" claimPattern: chain 7's wf_ec95bb24-c4c journal, build:codexfix-r3,
    // and the surviving result.json under
    // scratchpad/chain-7/cf-real/out-code-planted/implementation-20261002T161244560Z-11476/
    // result.json. It describes the exploit by payload ("OR 1=1") and mechanism
    // ("unparameterized"), never using the literal words sql/inject/concat anywhere in
    // either field — that is exactly why the old bare keyword regex rejected it.
    const d4 = defectById('D4');
    const realSqlFinding = {
      severity: 'BLOCKING', category: 'security', iso_property: null,
      location: { file: 'code-planted.js', line: 9, section: 'findUserById and searchUsersByName' },
      claim: "Unparameterized inputs can bypass lookup predicates and expose unrelated users' IDs, email addresses, and display names.",
      evidence: "Captured calls confirm findUserById('0 OR 1=1') submits WHERE id = 0 OR 1=1. At line 15, searchUsersByName(\"' OR 1=1 -- \") submits WHERE display_name LIKE '' OR 1=1 -- %', which matches every user and comments out the suffix.",
    };
    check('D4: real round-3 SQLi finding (no literal sql/inject/concat) matches', matchesDefect(realSqlFinding, d4), JSON.stringify(realSqlFinding));

    // Same missing-authorization red-proof as case 23, re-run against the broadened
    // pattern: a claim/evidence pair that shares the location and category but names
    // none of the broadened defect-specific terms either must still not match.
    const authFinding = { severity: 'MAJOR', category: 'security', iso_property: null, location: { file: 'code-planted.js', line: 10, section: null }, claim: 'missing authorization check before returning the user row', evidence: 'no role check in findUserById' };
    check('D4: missing-authorization claim at the same lines still does not match the broadened pattern', !matchesDefect(authFinding, d4), JSON.stringify(authFinding));
  }

  console.log('== case 25: leftover-process check is a before/after PID diff, not ancestry ==');
  {
    const before = codexPidSet([{ pid: 100, ppid: 1, name: 'codex-desktop.exe' }, { pid: 200, ppid: 1, name: 'unrelated.exe' }]);
    check('pre-existing codex pid captured in the baseline', before.has(100) && !before.has(200));

    // A real leak: pid 100 (pre-existing, unrelated) is still there; a NEW codex pid 300
    // now exists that was not in the baseline, two hops below a tracked root that has
    // itself already exited (300's ppid, 250, is absent from this final snapshot) — the
    // exact shape that broke ancestry-walking, since there is no live row to reconnect
    // through. The before/after diff does not need that row at all.
    const afterRowsLeak = [{ pid: 100, ppid: 1, name: 'codex-desktop.exe' }, { pid: 300, ppid: 250, name: 'codex.exe' }];
    const leaked = diffLeakedCodex(before, afterRowsLeak);
    check('leak detected despite the dead intermediate hop', leaked.some((p) => p.pid === 300), JSON.stringify(leaked));
    check('pre-existing codex pid is not reported as a leak', !leaked.some((p) => p.pid === 100), JSON.stringify(leaked));

    const unknownBaseline = leakedCodexSincePreRun(null);
    check('a missing pre-run baseline is unverified, never read as clean', unknownBaseline.ok === false);
  }

  console.log('== case 25b: leak attribution — only a run-owned descendant or a work-dir-tagged orphan counts ==');
  {
    // This machine always runs other, unrelated codex sessions, so a new codex-named pid
    // is not by itself proof this run leaked it. A candidate only counts when it is
    // attributable to this run: a live descendant of a pid this run spawned, or an
    // orphan whose own command line names this run's unique --work-dir.
    const before = codexPidSet([{ pid: 1, ppid: 0, name: 'init' }]);
    const workDir = 'C:\\scratch\\codex-review-real-20261002162652';
    const rootPids = new Set([500]); // this run's own spawned root pid

    // An unrelated codex process starts mid-run (its own session, nothing to do with this
    // run): new pid, not a descendant of any root this run spawned, command line carries
    // no trace of this run's work dir. Must NOT be flagged.
    const unrelatedAfter = [
      { pid: 1, ppid: 0, name: 'init', commandLine: '' },
      { pid: 500, ppid: 1, name: 'node', commandLine: 'node run-real-acceptance.js' },
      { pid: 777, ppid: 1, name: 'codex.exe', commandLine: 'codex exec --sandbox read-only -C C:\\someone-elses\\unrelated-repo' },
    ];
    check('unrelated mid-run codex process is NOT flagged', attributableLeaks(before, unrelatedAfter, rootPids, workDir).length === 0, JSON.stringify(attributableLeaks(before, unrelatedAfter, rootPids, workDir)));

    // A live descendant: pid 888 is a child of 500 (this run's own spawned root). Must be
    // flagged regardless of its command line.
    const descendantAfter = [
      { pid: 1, ppid: 0, name: 'init', commandLine: '' },
      { pid: 500, ppid: 1, name: 'node', commandLine: 'node run-real-acceptance.js' },
      { pid: 888, ppid: 500, name: 'codex.exe', commandLine: 'codex exec --sandbox read-only' },
    ];
    const descendantLeaks = attributableLeaks(before, descendantAfter, rootPids, workDir);
    check('a live descendant of a pid this run spawned IS flagged', descendantLeaks.some((p) => p.pid === 888), JSON.stringify(descendantLeaks));

    // An orphan: pid 999's tracked parent (250) has already exited and is absent from
    // this snapshot, so ancestry cannot reconnect it — exactly the dead-intermediate-hop
    // shape case 25 already covers for the plain before/after diff. It is not a
    // descendant of any tracked root in THIS snapshot, but its own command line carries
    // this run's unique --work-dir. Must be flagged.
    const orphanAfter = [
      { pid: 1, ppid: 0, name: 'init', commandLine: '' },
      { pid: 500, ppid: 1, name: 'node', commandLine: 'node run-real-acceptance.js' },
      { pid: 999, ppid: 250, name: 'codex-code-mode-host.exe', commandLine: `codex-code-mode-host --work-dir ${workDir}\\out-code-planted` },
    ];
    const orphanLeaks = attributableLeaks(before, orphanAfter, rootPids, workDir);
    check('an orphan whose command line carries this run\'s work dir IS flagged', orphanLeaks.some((p) => p.pid === 999), JSON.stringify(orphanLeaks));
    check('that same orphan is NOT a descendant of any tracked root (the attribution came from its command line)', !isDescendantOfAny(999, orphanAfter, rootPids));
    check('commandLineMatchesWorkDir is case- and slash-insensitive', commandLineMatchesWorkDir(`CODEX --WORK-DIR ${workDir.replace(/\\/g, '/').toUpperCase()}`, workDir));

    // Two concurrent runs whose --work-dir strings share a prefix (e.g. this run's
    // "...-real-A" vs another run's "...-real-ABC"): an unanchored substring match would
    // make this run's workDir match the OTHER run's orphan, a false-positive leak
    // attribution this run never caused. Must NOT be flagged.
    const otherRunWorkDir = `${workDir}BC`;
    check('sanity: otherRunWorkDir really does share workDir as a string prefix', otherRunWorkDir.startsWith(workDir));
    const prefixCollisionAfter = [
      { pid: 1, ppid: 0, name: 'init', commandLine: '' },
      { pid: 500, ppid: 1, name: 'node', commandLine: 'node run-real-acceptance.js' },
      { pid: 1111, ppid: 250, name: 'codex-code-mode-host.exe', commandLine: `codex-code-mode-host --work-dir ${otherRunWorkDir}\\out-code-planted` },
    ];
    check('a different run\'s work dir that string-prefixes this run\'s own work dir is NOT flagged', !commandLineMatchesWorkDir(prefixCollisionAfter[2].commandLine, workDir));
    const prefixCollisionLeaks = attributableLeaks(before, prefixCollisionAfter, rootPids, workDir);
    check('that other run\'s orphan is NOT attributed to this run', prefixCollisionLeaks.length === 0, JSON.stringify(prefixCollisionLeaks));

    // Snapshot failure must fail closed: never read as "no leaks". leakedCodexSincePreRun
    // takes an injectable snapshot function precisely so this is testable without
    // spawning a real OS process or waiting out the real grace period.
    const failingSnapshot = () => ({ ok: false, rows: [], error: 'simulated snapshot failure' });
    const onFailure = leakedCodexSincePreRun(before, rootPids, workDir, failingSnapshot);
    check('a snapshot failure during the leak check fails closed (ok:false, never a clean pass)', onFailure.ok === false, JSON.stringify(onFailure));
  }

  console.log('== case 26: review prompt instructs reading beyond scope for context ==');
  {
    const out = nextDir('out');
    const repo = makeRepo(workDir, `repo-${caseIndex}`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
    const r = runRunner(bin, 'pass', nextDir('state'), ['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo]);
    check('exit 0', r.status === 0);
    const log = readLastLog(out);
    const prompt = fs.readFileSync(path.join(log.run_dir, 'review-1.prompt.md'), 'utf8');
    check('prompt tells Codex it may read other files for context', prompt.includes('you need for context'));
    check('prompt limits findings to the scoped change/files', prompt.includes('Report findings only about the change or the files listed in scope'));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main();
