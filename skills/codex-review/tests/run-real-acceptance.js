#!/usr/bin/env node
'use strict';
// Four real `codex exec` runs through the real runner, against fixtures with known
// planted defects. This is what the skill's own acceptance gate runs before trusting
// a change to run-review.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const RUNNER = path.join(SKILL_DIR, 'scripts', 'run-review.js');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DEFECTS = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'planted-defects.json'), 'utf8'));

function getWorkDir() {
  const idx = process.argv.indexOf('--work-dir');
  if (idx >= 0) return path.resolve(process.argv[idx + 1]);
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-real-'));
}

function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }

function copyNeutral(workDir, neutralName, srcFile) {
  const dir = path.join(workDir, neutralName);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(srcFile));
  fs.copyFileSync(srcFile, dest);
  return dest;
}

function runReview(args, timeoutMs) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  // spawnSync's own result (exit status aside) is never inspected further by a caller
  // that only reads the log file: a hard kill on this script's own timeout, or a spawn
  // failure, leaves no log line at all (the runner's `finally` never ran), so a stale
  // result.json from an earlier invocation under a reused --work-dir could otherwise be
  // read and silently reported as this run's outcome. Surface that explicitly instead.
  if (r.error) return { ...r, scriptError: `spawn error: ${r.error.message}` };
  if (r.signal) return { ...r, scriptError: `runner was killed by ${r.signal} after exceeding this script's own ${timeoutMs}ms timeout (the runner's own --timeout-seconds budget was not reached)` };
  return { ...r, scriptError: null };
}

function readResult(stdoutArgs, outDir) {
  const logFile = path.join(outDir, 'codex-review-log.jsonl');
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  if (!last.run_dir) return { log: last, result: null };
  const resultFile = path.join(last.run_dir, 'result.json');
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  return { log: last, result };
}

function matchesDefect(finding, defect) {
  if (finding.validation && finding.validation.status === 'refuted') return false;
  if (finding.severity !== 'BLOCKING' && finding.severity !== 'MAJOR') return false;
  const loc = finding.location || {};
  // A defect counts as found only when the finding LOCATES it — via the structured
  // location field, never via a keyword found somewhere in free text (claim/evidence),
  // which is what let an off-topic finding at the right file "match" before.
  let locationMatch = false;
  if (defect.location.lineRange && loc.file) {
    const base = path.basename(loc.file).toLowerCase();
    const defectBase = path.basename(defect.location.file).toLowerCase();
    if (base === defectBase && loc.line != null && loc.line >= defect.location.lineRange[0] && loc.line <= defect.location.lineRange[1]) {
      locationMatch = true;
    }
  }
  if (!locationMatch && defect.location.sectionRegex) {
    // A file named by the finding must identify the SAME document as the defect, exactly
    // like the lineRange branch above — never accepted on section text alone when the
    // finding names a (possibly different) file. A spec review also carries the PRD it
    // traces against in scope, so section text is not file-unambiguous on its own. When
    // the finding omits file (the common case for a document-section finding), there is
    // nothing to contradict, so section text alone still applies.
    const fileOk = !loc.file || path.basename(loc.file).toLowerCase() === path.basename(defect.location.file).toLowerCase();
    const re = new RegExp(defect.location.sectionRegex, 'i');
    if (fileOk && loc.section && re.test(loc.section)) locationMatch = true;
  }
  if (!locationMatch) return false;
  // Whether the finding's claim is actually ABOUT this defect (not just co-located with
  // it) is decided first by the finding's own structured category/iso_property fields
  // against a short per-defect acceptance list — deterministic, no document-wide text
  // search, no model call.
  const categoryOk = Array.isArray(defect.categories) && defect.categories.some((c) => (finding.category || '').toLowerCase() === c.toLowerCase());
  const isoOk = Array.isArray(defect.isoProperties) && defect.isoProperties.includes(finding.iso_property);
  if (!categoryOk && !isoOk) return false;
  // category/iso_property alone can still collide: two distinct defects at the same
  // location can share one category (a missing-authorization finding is "security" too,
  // and can sit on the very same lines as a SQL-injection defect). When the defect names
  // claimPattern, the finding's claim/evidence text must additionally match it. This is a
  // single per-defect anchor fixed in the fixture ahead of any run, scoped to a finding
  // that already passed the location check above — not a document-wide keyword scan, and
  // it never substitutes for the location match.
  if (defect.claimPattern) {
    const re = new RegExp(defect.claimPattern, 'i');
    const text = `${finding.claim || ''} ${finding.evidence || ''}`;
    if (!re.test(text)) return false;
  }
  return true;
}

function matchedIds(result, fixtureName) {
  if (!result || !Array.isArray(result.findings)) return [];
  const defects = DEFECTS.filter((d) => d.fixture === fixtureName);
  const matched = [];
  for (const defect of defects) {
    if (result.findings.some((f) => matchesDefect(f, defect))) matched.push(defect.id);
  }
  return matched;
}

function listProcessTree() {
  // One snapshot of every live process as {pid, ppid, name}, platform-specific. This is
  // deliberately NOT filtered to codex processes here — ancestry has to be resolved
  // across the whole tree, since a leaked codex.exe can sit several hops below the
  // pid this script actually spawned (e.g. a .cmd shim, or codex invoked via node).
  //
  // Returns {ok, rows, error}. `ok` is false when the snapshot itself could not be taken
  // or parsed — a spawn error, a non-zero exit, or output that parsed to zero rows (which
  // never happens on a real snapshot: this very script's own process tree is always in
  // it). Callers must treat !ok as "unknown", never as "zero leaks", or a sandboxed /
  // permission-denied snapshot silently reports a clean run.
  try {
    if (process.platform === 'win32') {
      // ConvertTo-Json (not CSV) because CommandLine is now captured too, and a command
      // line routinely contains embedded quotes/commas that break the fixed CSV regex
      // below it replaced. -Compress keeps it on one line; a single result comes back as
      // an object rather than an array, so that shape is normalized right after parsing.
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (r.error) return { ok: false, rows: [], error: `spawn error: ${r.error.message}` };
      if (r.status !== 0) return { ok: false, rows: [], error: `powershell exited ${r.status}: ${(r.stderr || '').slice(0, 500)}` };
      // ConvertTo-Json does not reliably escape a raw control character that lands inside
      // a CommandLine string (observed live: some other process's command line carried
      // one), which otherwise makes the whole snapshot unparseable JSON and fails the
      // entire leak check closed on a single unrelated process. Strip raw control bytes
      // before parsing — a real escape sequence is always a two-character `\` + letter in
      // the JSON text, never a lone control byte, so this cannot remove a valid escape.
      const sanitized = (r.stdout || '').replace(/[\x00-\x1F]/g, ' ');
      let parsed;
      try { parsed = JSON.parse(sanitized || 'null'); } catch (e) { return { ok: false, rows: [], error: `failed to parse process snapshot JSON: ${e.message}` }; }
      if (!Array.isArray(parsed)) parsed = parsed ? [parsed] : [];
      const rows = parsed
        .filter((p) => p && Number.isFinite(Number(p.ProcessId)) && Number.isFinite(Number(p.ParentProcessId)))
        .map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: p.Name || '', commandLine: p.CommandLine || '' }));
      if (rows.length === 0) return { ok: false, rows: [], error: 'process snapshot parsed to zero rows' };
      return { ok: true, rows, error: null };
    }
    // args carries the full command line (name + all arguments), which doubles as this
    // row's commandLine field — there is no separate lookup for it on POSIX.
    const r = spawnSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.error) return { ok: false, rows: [], error: `spawn error: ${r.error.message}` };
    if (r.status !== 0) return { ok: false, rows: [], error: `ps exited ${r.status}: ${(r.stderr || '').slice(0, 500)}` };
    const lines = (r.stdout || '').split(/\r?\n/).slice(1).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const commandLine = m[3];
      const name = path.basename((commandLine.split(/\s+/)[0] || ''));
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name, commandLine });
    }
    if (rows.length === 0) return { ok: false, rows: [], error: 'process snapshot parsed to zero rows' };
    return { ok: true, rows, error: null };
  } catch (e) {
    return { ok: false, rows: [], error: `exception: ${e.message}` };
  }
}

function codexPidSet(rows) {
  const set = new Set();
  for (const row of rows) if (/codex/i.test(row.name)) set.add(row.pid);
  return set;
}

// Leak detection is before/after PID-set difference, not parent-pid ancestry walking.
// Ancestry walking was tried first and has two structural holes a BFS over a single
// snapshot cannot close: (1) a leaked grandchild reconnects to a tracked root only
// through its intermediate parent's row — if that parent has already exited by the time
// the final snapshot is taken, the chain is severed and the real leak is invisible even
// though it is still running; (2) Windows never reparents a child when its parent exits
// (unlike POSIX), so a leaked process can carry a long-dead parent pid, and that same pid
// number can legitimately be reused by a wholly unrelated process started later — a
// tracked-root pid match is therefore not proof of ancestry either way.
// Before/after diffing needs neither fact: any codex-named pid present in the snapshot
// taken once at the very start of main() (preExistingCodexPids) is excluded outright,
// however deep or short-lived its own ancestry; any codex-named pid that was NOT running
// then but IS running after all four review calls have returned must have been created
// during this run's own window, regardless of which hop spawned it or whether that hop is
// still alive. The only residual gap — a pre-existing codex process exits and a different
// one is coincidentally assigned the exact same pid before the final snapshot — is a far
// smaller window than full-run ancestry reuse and is accepted here.
function diffLeakedCodex(preExistingCodexPids, afterRows) {
  // Pure decision logic, split out from the OS snapshot call so it can be unit-tested
  // directly (no process spawning) with fabricated before/after rows. This is only the
  // candidate set (new + codex-named) — see isLeakAttributableToRun for why a candidate
  // still is not reported as a leak on its own.
  return afterRows.filter((row) => /codex/i.test(row.name) && !preExistingCodexPids.has(row.pid));
}

// A candidate from diffLeakedCodex is still only a NEW codex-named process, which on a
// shared machine running other, unrelated codex sessions is routinely true of processes
// this run never touched. A candidate counts as leaked only when it is attributable to
// this run specifically: either a live descendant of a pid this run itself spawned
// (walked via ppid through the same snapshot the candidate came from), or its command
// line names this run's own --work-dir (the shape an orphaned grandchild takes once its
// tracked parent has already exited and the ppid chain no longer reconnects it).
function isDescendantOfAny(pid, rows, rootPids) {
  const byPid = new Map();
  for (const row of rows) byPid.set(row.pid, row);
  const seen = new Set();
  let current = pid;
  while (current != null && !seen.has(current)) {
    if (rootPids.has(current)) return true;
    seen.add(current);
    const row = byPid.get(current);
    if (!row) return false;
    current = row.ppid;
  }
  return false;
}

function commandLineMatchesWorkDir(commandLine, workDir) {
  if (!commandLine || !workDir) return false;
  const normalize = (s) => String(s).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  const haystack = normalize(commandLine);
  const needle = normalize(workDir);
  if (!needle) return false;
  // A plain substring match makes one run's --work-dir a false-positive match for a
  // different run whose --work-dir happens to be a longer string that starts with the
  // same characters (e.g. ".../codex-review-real-A" is a substring of
  // ".../codex-review-real-ABC/out-code-planted"). Require a path/word boundary on both
  // sides: the character right after the needle must be absent or a non-identifier
  // character (path separator, quote, space, etc.), never a letter/digit/dash/underscore
  // that would mean the real directory name continues further than this run's own.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:[^a-z0-9_-]|$)`);
  return re.test(haystack);
}

function isLeakAttributableToRun(row, afterRows, rootPids, workDir) {
  return isDescendantOfAny(row.pid, afterRows, rootPids) || commandLineMatchesWorkDir(row.commandLine, workDir);
}

// The candidate-to-leak reduction used both by the real grace-period loop below and
// directly by the fake suite (no process spawning): never flags a candidate that is
// neither a live descendant of this run's own spawned roots nor command-line-tagged
// with this run's own --work-dir.
function attributableLeaks(preExistingCodexPids, afterRows, rootPids, workDir) {
  const candidates = diffLeakedCodex(preExistingCodexPids, afterRows);
  return candidates.filter((row) => isLeakAttributableToRun(row, afterRows, rootPids, workDir));
}

const LEAK_GRACE_MS = 60000;
const LEAK_POLL_INTERVAL_MS = 5000;

function sleepSync(ms) {
  // Blocking sleep with no added dependency: Atomics.wait on a throwaway
  // SharedArrayBuffer parks this thread for exactly ms without a CPU-burning busy-loop.
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function leakedCodexSincePreRun(preExistingCodexPids, rootPids, workDir, snapshotFn) {
  // Returns {ok, leaked, error}; see listProcessTree for why !ok must never be read as
  // "no leaks". preExistingCodexPids === null means no baseline could be established
  // (the pre-run snapshot itself failed), which must also never be read as "no leaks".
  if (preExistingCodexPids === null) return { ok: false, leaked: [], error: 'no pre-run baseline snapshot was available' };
  const takeSnapshot = snapshotFn || listProcessTree;
  const roots = rootPids || new Set();
  // A single snapshot taken immediately after the four runReview() calls return can still
  // catch a codex-named process mid-teardown: spawnTracked only waits for its direct
  // child's own 'close' event, not for that child's descendants (observed: codex.exe and
  // codex-code-mode-host.exe present in the immediate snapshot, both gone within about a
  // minute, with the rest of the baseline unchanged). Re-snapshot on a grace period and
  // only report pids that survive every recheck — a genuine leak stays present the whole
  // window, a teardown straggler clears within it.
  const deadline = Date.now() + LEAK_GRACE_MS;
  let leaked;
  for (;;) {
    const snapshot = takeSnapshot();
    if (!snapshot.ok) return { ok: false, leaked: [], error: snapshot.error };
    leaked = attributableLeaks(preExistingCodexPids, snapshot.rows, roots, workDir);
    if (leaked.length === 0 || Date.now() >= deadline) break;
    sleepSync(LEAK_POLL_INTERVAL_MS);
  }
  return { ok: true, leaked, error: null };
}

const RUNNER_TIMEOUT_SECONDS = 600;
// SKILL.md's own documented worst case per run is 2 x (T + 2T) = 6T (a review call that
// retries once at 2x the timeout, plus a validation call doing the same). This script's
// outer spawnSync timeout must exceed that, or it kills the runner before the runner's
// own documented budget is reached, discarding the real exit/timeout state and the
// log line the runner would otherwise have appended in its own `finally` block.
// +10 min margin covers the catalog call and process/IO overhead outside that formula.
const SCRIPT_TIMEOUT_MS = (6 * RUNNER_TIMEOUT_SECONDS + 10 * 60) * 1000;

function freshOutDir(dir) {
  // Output directories under a reused --work-dir are never freshened otherwise, so a
  // stale result.json / codex-review-log.jsonl from an earlier invocation could be
  // silently read back and reported as this run's outcome.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const workDir = getWorkDir();
  fs.mkdirSync(workDir, { recursive: true });
  // Baseline taken before any of the four runReview() calls below — the leak check at the
  // end only ever flags a codex-named process that was NOT in this snapshot, never a
  // pre-existing one (a long-lived codex desktop process, or one a person starts by hand
  // mid-run). See leakedCodexSincePreRun for why this replaced ancestry walking.
  const preRunSnapshot = listProcessTree();
  const preExistingCodexPids = preRunSnapshot.ok ? codexPidSet(preRunSnapshot.rows) : null;
  // The pid of the node process spawned for each of the four runReview() calls below, kept
  // only for the diagnostic line printed on a leak — it plays no part in the pass/fail
  // decision itself.
  const spawnedRootPids = [];
  const trackPid = (r) => { if (Number.isInteger(r.pid) && r.pid > 0) spawnedRootPids.push(r.pid); };
  const rows = [];

  // prd-planted
  {
    const out = path.join(workDir, 'out-prd');
    freshOutDir(out);
    const file = copyNeutral(workDir, 'doc-1', path.join(FIXTURES_DIR, 'prd-planted.md'));
    const r = runReview(['--kind', 'prd', '--out-dir', out, '--files', file, '--timeout-seconds', String(RUNNER_TIMEOUT_SECONDS)], SCRIPT_TIMEOUT_MS);
    trackPid(r);
    const { log, result } = (!r.scriptError && readResult(null, out)) || {};
    const matched = matchedIds(result, 'prd-planted');
    rows.push({ run: 'prd-planted', run_id: log && log.run_id, verdict: log && log.verdict, matched, run_dir: log && log.run_dir, error: r.scriptError, ok: !r.scriptError && log && log.verdict === 'FAIL' && matched.includes('D1') && matched.includes('D2') });
  }

  // spec-planted, traced against the PRD it was written from (D3 is an ownership
  // conflict within the spec itself, but --against is also what exercises spec.md's
  // bidirectional-traceability-to-the-PRD check — a real run must pass it).
  {
    const out = path.join(workDir, 'out-spec');
    freshOutDir(out);
    const file = copyNeutral(workDir, 'doc-2', path.join(FIXTURES_DIR, 'spec-planted.md'));
    const against = copyNeutral(workDir, 'doc-2-against', path.join(FIXTURES_DIR, 'prd-planted.md'));
    const r = runReview(['--kind', 'spec', '--out-dir', out, '--files', file, '--against', against, '--timeout-seconds', String(RUNNER_TIMEOUT_SECONDS)], SCRIPT_TIMEOUT_MS);
    trackPid(r);
    const { log, result } = (!r.scriptError && readResult(null, out)) || {};
    const matched = matchedIds(result, 'spec-planted');
    rows.push({ run: 'spec-planted', run_id: log && log.run_id, verdict: log && log.verdict, matched, run_dir: log && log.run_dir, error: r.scriptError, ok: !r.scriptError && log && log.verdict === 'FAIL' && matched.includes('D3') });
  }

  // code-planted: untracked file in a scratch repo, reviewed via --uncommitted. The
  // copied filename must stay code-planted.js: planted-defects.json's D4/D5 match on
  // that exact basename and have no sectionRegex fallback, so renaming it here would
  // make those two rows structurally unmatchable regardless of review quality.
  {
    const repo = path.join(workDir, 'repo-planted');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 'test']);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'code-planted.js'), path.join(repo, 'code-planted.js'));
    const out = path.join(workDir, 'out-code-planted');
    freshOutDir(out);
    const r = runReview(['--kind', 'implementation', '--out-dir', out, '--uncommitted', '--repo', repo, '--timeout-seconds', String(RUNNER_TIMEOUT_SECONDS)], SCRIPT_TIMEOUT_MS);
    trackPid(r);
    const { log, result } = (!r.scriptError && readResult(null, out)) || {};
    const matched = matchedIds(result, 'code-planted');
    rows.push({ run: 'code-planted', run_id: log && log.run_id, verdict: log && log.verdict, matched, run_dir: log && log.run_dir, error: r.scriptError, ok: !r.scriptError && log && log.verdict === 'FAIL' && (matched.includes('D4') || matched.includes('D5')) });
  }

  // code-clean
  {
    const out = path.join(workDir, 'out-code-clean');
    freshOutDir(out);
    const file = copyNeutral(workDir, 'snippet-a', path.join(FIXTURES_DIR, 'code-clean.js'));
    const r = runReview(['--kind', 'implementation', '--out-dir', out, '--files', file, '--timeout-seconds', String(RUNNER_TIMEOUT_SECONDS)], SCRIPT_TIMEOUT_MS);
    trackPid(r);
    const { log } = (!r.scriptError && readResult(null, out)) || {};
    rows.push({ run: 'code-clean', run_id: log && log.run_id, verdict: log && log.verdict, matched: [], run_dir: log && log.run_dir, error: r.scriptError, ok: !r.scriptError && log && log.verdict === 'PASS' });
  }

  console.log('run'.padEnd(16), 'verdict'.padEnd(14), 'matched'.padEnd(14), 'run_dir');
  for (const row of rows) {
    console.log(String(row.run).padEnd(16), String(row.verdict).padEnd(14), String(row.matched.join(',') || '-').padEnd(14), row.run_dir || '(none)');
    if (row.error) console.error(`  ERROR (${row.run}): ${row.error}`);
  }

  const allOk = rows.every((r) => r.ok);
  const leakCheck = leakedCodexSincePreRun(preExistingCodexPids, new Set(spawnedRootPids), workDir);
  if (!leakCheck.ok) {
    console.error(`FAIL: could not verify no leaked codex processes remain (${leakCheck.error}) — treating as unverified, not clean`);
  } else if (leakCheck.leaked.length > 0) {
    console.error(`FAIL: codex process(es) not present before this run (spawned root pids were ${spawnedRootPids.join(', ') || '(none tracked)'}) are still alive: ${leakCheck.leaked.map((p) => `${p.name}(${p.pid})`).join(', ')}`);
  }
  const childrenClear = leakCheck.ok && leakCheck.leaked.length === 0;

  process.exitCode = allOk && childrenClear ? 0 : 1;
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    matchesDefect, matchedIds, codexPidSet, diffLeakedCodex, leakedCodexSincePreRun,
    isDescendantOfAny, commandLineMatchesWorkDir, isLeakAttributableToRun, attributableLeaks,
  };
}
