#!/usr/bin/env node
'use strict';

// Redaction scanner for the public evidence of plan section 4 (WP7). The pattern list lives in its own file
// (default: redact-patterns.json beside this script), which is the ONLY allowlisted path; its repo-relative path
// is printed on every run. Three scans:
//   1. the added lines of `git diff -U0 <base>..<head>` in --repo;
//   2. every whole file (at <head>) that the same diff touches, deleted files excepted, binary files skipped;
//   3. for each --bundle, a temp mirror clone's `git log --all --format=%H%n%an%n%ae%n%B` (author names must be
//      in the pattern file's synthetic bundle_authors list) and `git grep -I` over `git rev-list --all`.
// A finding prints its location, pattern id and a masked excerpt (never the full matched text), so the output
// can be quoted in the report.
//
// usage: redact-scan.js [--repo <dir>] [--base <rev>] [--head <rev>] [--bundle <file>]... [--patterns <file>]
//                       [--no-diff] [--json]
//   --repo     default: the repository this script lives in;  --base default c186e5f;  --head default HEAD
//   --no-diff  skip scans 1 and 2 (bundle only)
//   --json     print one JSON object instead of text
// Exit 0: no finding; 1: findings; 2: usage or setup error (reason on stderr).
// Zero dependencies. Every git call runs with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
// GIT_COMMON_DIR and GIT_CONFIG* removed from the environment.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const VERSION = '1.0.0';
const DEFAULT_BASE = 'c186e5f';
const DEFAULT_PATTERNS = path.join(__dirname, 'redact-patterns.json');

class SetupError extends Error {}

function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'].includes(k) || k.startsWith('GIT_CONFIG')) delete env[k];
  }
  return env;
}

function git(cwd, args, { input, binary } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: gitEnv(), input, encoding: binary ? null : 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw new SetupError(`git ${args.join(' ')}: ${r.error.message}`);
  return r;
}

function gitOk(cwd, args, opts) {
  const r = git(cwd, args, opts);
  if (r.status !== 0) throw new SetupError(`git ${args.join(' ')} failed (exit ${r.status}): ${String(r.stderr).trim()}`);
  return r.stdout;
}

function parseArgs(argv) {
  const a = { bundles: [], diff: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--no-diff') { a.diff = false; continue; }
    if (flag === '--json') { a.json = true; continue; }
    const key = { '--repo': 'repo', '--base': 'base', '--head': 'head', '--bundle': 'bundle', '--patterns': 'patterns' }[flag];
    if (!key) throw new SetupError(`unknown argument ${JSON.stringify(flag)}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new SetupError(`${flag} needs a value`);
    if (key === 'bundle') { a.bundles.push(v); continue; }
    if (Object.hasOwn(a, key)) throw new SetupError(`${flag} given twice`);
    a[key] = v;
  }
  return a;
}

function loadPatterns(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new SetupError(`cannot read pattern file ${file}: ${e.message}`); }
  if (!Array.isArray(doc.patterns) || !doc.patterns.length) throw new SetupError('pattern file: patterns[] is required');
  const patterns = doc.patterns.map(p => {
    if (!p || typeof p.id !== 'string' || typeof p.regex !== 'string') throw new SetupError('pattern file: every pattern needs id and regex');
    const flags = (p.flags || '').includes('g') ? p.flags : (p.flags || '') + 'g';
    try { return { id: p.id, re: new RegExp(p.regex, flags) }; } catch (e) { throw new SetupError(`pattern ${p.id}: ${e.message}`); }
  });
  const allow = {};
  for (const [id, list] of Object.entries(doc.allow || {})) allow[id] = new Set(list);
  return { patterns, allow, bundleAuthors: new Set(doc.bundle_authors || []), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

const mask = s => `${s.slice(0, 2)}...(${s.length} chars)`;

function matchLine(line, P) {
  const hits = [];
  for (const { id, re } of P.patterns) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      if (P.allow[id] && P.allow[id].has(m[0])) continue;
      hits.push({ pattern: id, excerpt: mask(m[0]) });
    }
  }
  return hits;
}

function scanText(text, where, P, findings) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) for (const h of matchLine(lines[i], P)) findings.push({ ...where(i + 1), ...h });
  return lines.length;
}

// Scan 1: added lines of git diff -U0, with their line numbers in the new file.
function scanAddedLines(repo, base, head, allowRel, P) {
  const diff = gitOk(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', `${base}..${head}`]);
  const findings = [];
  let file = null, line = 0, added = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(4).replace(/^b\//, ''); continue; }
    if (l.startsWith('--- ') || l.startsWith('diff --git ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (l.startsWith('+') && file !== null) {
      if (file !== allowRel) {
        added++;
        for (const h of matchLine(l.slice(1), P)) findings.push({ scan: 'added-lines', file, line, ...h });
      }
      line++;
    }
  }
  return { added_lines: added, findings };
}

// Scan 2: every whole file at <head> touched by the diff (deleted files excepted), via one cat-file --batch.
function scanWholeFiles(repo, base, head, allowRel, P) {
  const names = gitOk(repo, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', `${base}..${head}`]).split('\0').filter(Boolean)
    .filter(n => n !== allowRel && !n.includes('\n'));
  const findings = [];
  let binary = 0;
  if (!names.length) return { files: 0, binary_skipped: 0, findings };
  const out = gitOk(repo, ['cat-file', '--batch'], { input: names.map(n => `${head}:${n}`).join('\n') + '\n', binary: true });
  let off = 0;
  for (const name of names) {
    const nl = out.indexOf(0x0a, off);
    const header = out.subarray(off, nl).toString('utf8');
    off = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) throw new SetupError(`cat-file: unexpected header ${JSON.stringify(header)} for ${name}`);
    const size = Number(m[2]);
    const bytes = out.subarray(off, off + size);
    off += size + 1;
    if (m[1] !== 'blob') continue;
    if (bytes.subarray(0, 8000).includes(0)) { binary++; continue; }
    scanText(bytes.toString('utf8'), n => ({ scan: 'whole-files', file: name, line: n }), P, findings);
  }
  return { files: names.length, binary_skipped: binary, findings };
}

// Scan 3: a temp mirror clone of the bundle; its log metadata and every text line of every revision.
function scanBundle(bundle, P) {
  if (!fs.existsSync(bundle)) throw new SetupError(`bundle ${bundle} does not exist`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-scan-'));
  try {
    const clone = path.join(tmp, 'clone.git');
    gitOk(tmp, ['clone', '-q', '--mirror', path.resolve(bundle), clone]);
    const findings = [];
    const log = gitOk(clone, ['log', '--all', '-z', '--format=%H%n%an%n%ae%n%B']);
    const entries = log.split('\0').filter(e => e.trim());
    for (const entry of entries) {
      const [sha, an, ae, ...body] = entry.replace(/^\n/, '').split('\n');
      if (!P.bundleAuthors.has(an)) findings.push({ scan: 'bundle-log', commit: sha, field: 'author', pattern: 'author-not-synthetic', excerpt: mask(an) });
      for (const [field, text] of [['author', an], ['email', ae], ['message', body.join('\n')]]) {
        const lines = text.split('\n');
        lines.forEach((l, i) => { for (const h of matchLine(l, P)) findings.push({ scan: 'bundle-log', commit: sha, field, line: i + 1, ...h }); });
      }
    }
    const committers = gitOk(clone, ['log', '--all', '--format=%cn']).split('\n').filter(Boolean);
    for (const cn of new Set(committers)) if (!P.bundleAuthors.has(cn)) findings.push({ scan: 'bundle-log', field: 'committer', pattern: 'author-not-synthetic', excerpt: mask(cn) });
    const revs = gitOk(clone, ['rev-list', '--all']).split('\n').filter(Boolean);
    let grepLines = 0;
    for (let i = 0; i < revs.length; i += 100) {
      const r = git(clone, ['grep', '-I', '-n', '-z', '-e', '', ...revs.slice(i, i + 100)]);
      if (r.status === 1) continue; // no line at all
      if (r.status !== 0) throw new SetupError(`git grep failed (exit ${r.status}): ${r.stderr.trim()}`);
      for (const l of r.stdout.split('\n')) {
        if (!l) continue;
        const a = l.indexOf('\0');
        const b = l.indexOf('\0', a + 1);
        if (a < 0 || b < 0) continue;
        grepLines++;
        const [rev, file] = [l.slice(0, 40), l.slice(41, a)];
        for (const h of matchLine(l.slice(b + 1), P)) findings.push({ scan: 'bundle-grep', commit: rev, file, line: Number(l.slice(a + 1, b)), ...h });
      }
    }
    return { bundle: path.basename(bundle), commits: entries.length, revisions: revs.length, grep_lines: grepLines, findings };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function where(f) {
  if (f.scan === 'added-lines' || f.scan === 'whole-files') return `${f.file}:${f.line}`;
  if (f.scan === 'bundle-grep') return `${f.commit}:${f.file}:${f.line}`;
  return `${f.commit || '-'} ${f.field}${f.line ? ':' + f.line : ''}`;
}

function main(argv) {
  const a = parseArgs(argv);
  const patternsFile = path.resolve(a.patterns || DEFAULT_PATTERNS);
  const P = loadPatterns(patternsFile);
  const report = { scanner: 'redact-scan.js', version: VERSION, patterns_file: null, patterns_sha256: P.sha256, allowlisted_path: null, scans: [] };
  let repo = null;
  if (a.diff) {
    repo = gitOk(path.resolve(a.repo || __dirname), ['rev-parse', '--show-toplevel']).trim();
    const real = fs.realpathSync(patternsFile);
    const rel = path.relative(fs.realpathSync(repo), real).split(path.sep).join('/');
    report.allowlisted_path = rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
    report.patterns_file = report.allowlisted_path || path.basename(patternsFile);
    const base = a.base || DEFAULT_BASE;
    const head = a.head || 'HEAD';
    for (const rev of [base, head]) if (git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]).status !== 0) throw new SetupError(`unknown revision ${rev}`);
    report.scans.push({ id: 1, what: `added lines of git diff -U0 ${base}..${head}`, ...scanAddedLines(repo, base, head, report.allowlisted_path, P) });
    report.scans.push({ id: 2, what: `whole files at ${head} touched by git diff ${base}..${head}`, ...scanWholeFiles(repo, base, head, report.allowlisted_path, P) });
  } else {
    report.patterns_file = path.basename(patternsFile);
  }
  for (const b of a.bundles) {
    report.scans.push({ id: 3, what: `bundle ${path.basename(b)}: git log --all --format=%H%n%an%n%ae%n%B and git grep -I over git rev-list --all`, ...scanBundle(b, P) });
  }
  const total = report.scans.reduce((n, s) => n + s.findings.length, 0);
  report.result = total ? 'FINDINGS' : 'CLEAN';
  report.findings_total = total;
  if (a.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const out = [`redact-scan ${VERSION}`, `patterns: ${report.patterns_file} (sha256 ${P.sha256})`, `allowlisted path: ${report.allowlisted_path || '(none: the pattern file is outside --repo)'}`];
    for (const s of report.scans) {
      const counts = s.id === 1 ? `${s.added_lines} added lines` : s.id === 2 ? `${s.files} files, ${s.binary_skipped} binary skipped`
        : `${s.commits} commits, ${s.revisions} revisions, ${s.grep_lines} grep lines`;
      out.push(`scan ${s.id}: ${s.what}: ${counts}, ${s.findings.length} finding(s)`);
      for (const f of s.findings) out.push(`  ${where(f)}: ${f.pattern}: ${f.excerpt}`);
    }
    out.push(`result: ${report.result}${total ? ' ' + total : ''}`);
    process.stdout.write(out.join('\n') + '\n');
  }
  return total ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (e instanceof SetupError) { process.stderr.write(`redact-scan: ${e.message}\n`); process.exitCode = 2; } else throw e;
  }
}

module.exports = { main, loadPatterns, matchLine, VERSION };
