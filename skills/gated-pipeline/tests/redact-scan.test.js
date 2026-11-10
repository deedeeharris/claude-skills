'use strict';

// tests/v2-evidence/redact-scan.js (plan section 4, Redaction; WP7). A toy repo with a synthetic identity gets a
// home-directory path planted in an added diff line and in a commit message; the scanner, run on the diff and on
// a bundle of the toy repo, reports both (and the same line in the whole-file and git-grep scans), masks the
// matched text, and stays clean on an unplanted toy. The planted strings are assembled at run time, so this file
// itself never carries one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { gitEnv } = require('./helpers/git-env.js');

const SCANNER = path.join(__dirname, 'v2-evidence', 'redact-scan.js');
const PATTERNS = path.join(__dirname, 'v2-evidence', 'redact-patterns.json');
const TOY = 'gp-v2 toy';
const PLANT = ['', 'home', 'synthetic-person', 'notes', 'plan.txt'].join('/');
const EXCERPT = '/h...(22 chars)'; // the masked form of the home-path match (the first two characters and the length)

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-redact-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function toyRepo(root, author = TOY) {
  const repo = path.join(root, 'toy');
  fs.mkdirSync(repo);
  const env = gitEnv({ GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: '',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  write('src/app.js', 'module.exports = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { repo, git, write, base: git('rev-parse', 'HEAD') };
}

function scan(args) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], { encoding: 'utf8', env: gitEnv() });
  return { ...r, json: () => JSON.parse(r.stdout) };
}

test('a home-directory path planted in an added diff line and in a bundled commit message is reported by every scan', t => {
  const root = tmp(t);
  const toy = toyRepo(root);
  toy.write('src/app.js', 'module.exports = 1;\n// see ' + PLANT + '\n');
  toy.git('add', '-A');
  toy.git('commit', '-qm', 'add a note\n\nCopied from ' + PLANT + ' on the build host.');
  const sha = toy.git('rev-parse', 'HEAD');
  const bundle = path.join(root, 'toy.bundle');
  toy.git('bundle', 'create', '-q', bundle, '--all');

  const text = scan(['--repo', toy.repo, '--base', toy.base, '--bundle', bundle, '--patterns', PATTERNS]);
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.ok(!text.stdout.includes(PLANT) && !text.stdout.includes('synthetic-person'), 'the matched text is masked in the output');
  assert.match(text.stdout, /^allowlisted path: \(none: the pattern file is outside --repo\)$/m);
  assert.match(text.stdout, /^ {2}src\/app\.js:2: home-path: /m, 'the added diff line');
  assert.match(text.stdout, new RegExp(`^  ${sha} message:3: home-path: `, 'm'), 'the bundled commit message');

  const out = scan(['--repo', toy.repo, '--base', toy.base, '--bundle', bundle, '--patterns', PATTERNS, '--json']).json();
  const by = id => out.scans.filter(s => s.id === id).flatMap(s => s.findings);
  assert.deepEqual(by(1), [{ scan: 'added-lines', file: 'src/app.js', line: 2, pattern: 'home-path', excerpt: EXCERPT }]);
  assert.deepEqual(by(2), [{ scan: 'whole-files', file: 'src/app.js', line: 2, pattern: 'home-path', excerpt: EXCERPT }]);
  assert.deepEqual(by(3).filter(f => f.scan === 'bundle-log'), [{ scan: 'bundle-log', commit: sha, field: 'message', line: 3, pattern: 'home-path', excerpt: EXCERPT }]);
  assert.deepEqual(by(3).filter(f => f.scan === 'bundle-grep'), [{ scan: 'bundle-grep', commit: sha, file: 'src/app.js', line: 2, pattern: 'home-path', excerpt: EXCERPT }]);
  assert.equal(out.result, 'FINDINGS');
  assert.equal(out.findings_total, 4);
});

test('an unplanted toy repo and bundle are CLEAN; a non-synthetic author and an email address are reported', t => {
  const root = tmp(t);
  const toy = toyRepo(root);
  toy.write('README.md', 'Synthetic toy.\nAn empty identity <> is fine.\n');
  toy.git('add', '-A');
  toy.git('commit', '-qm', 'readme');
  const bundle = path.join(root, 'toy.bundle');
  toy.git('bundle', 'create', '-q', bundle, '--all');
  const clean = scan(['--repo', toy.repo, '--base', toy.base, '--bundle', bundle, '--patterns', PATTERNS]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^result: CLEAN$/m);
  assert.match(clean.stdout, /^scan 3: bundle toy\.bundle: .*2 commits, 2 revisions, 4 grep lines, 0 finding\(s\)$/m);

  fs.mkdirSync(path.join(root, 'o'));
  const other = toyRepo(path.join(root, 'o'), 'Some Person');
  other.write('src/contact.txt', ['reach', 'someone' + '@' + 'example.org'].join(' ') + '\n');
  other.git('add', '-A');
  other.git('commit', '-qm', 'contact');
  const b2 = path.join(root, 'other.bundle');
  other.git('bundle', 'create', '-q', b2, '--all');
  const out = scan(['--repo', other.repo, '--base', other.base, '--bundle', b2, '--patterns', PATTERNS, '--json']);
  assert.equal(out.status, 1);
  const findings = out.json().scans.flatMap(s => s.findings);
  assert.ok(findings.some(f => f.scan === 'added-lines' && f.pattern === 'email' && f.file === 'src/contact.txt'));
  assert.ok(findings.some(f => f.scan === 'bundle-log' && f.field === 'author' && f.pattern === 'author-not-synthetic'));
  assert.ok(findings.some(f => f.scan === 'bundle-log' && f.field === 'committer' && f.pattern === 'author-not-synthetic'));
});

test('the pattern file is the only allowlisted path, and its repo-relative path is printed', t => {
  const root = tmp(t);
  const toy = toyRepo(root);
  const patterns = JSON.parse(fs.readFileSync(PATTERNS, 'utf8'));
  patterns.about = 'planted for the test: ' + PLANT;
  toy.write('tools/patterns.json', JSON.stringify(patterns, null, 2) + '\n');
  toy.write('tools/other.json', JSON.stringify({ about: 'planted for the test: ' + PLANT }, null, 2) + '\n');
  toy.git('add', '-A');
  toy.git('commit', '-qm', 'tools');
  const r = scan(['--repo', toy.repo, '--base', toy.base, '--patterns', path.join(toy.repo, 'tools/patterns.json'), '--json']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.json();
  assert.equal(out.allowlisted_path, 'tools/patterns.json');
  const files = new Set(out.scans.flatMap(s => s.findings).map(f => f.file));
  assert.deepEqual([...files], ['tools/other.json'], 'only the non-allowlisted file is reported');
  const textRun = scan(['--repo', toy.repo, '--base', toy.base, '--patterns', path.join(toy.repo, 'tools/patterns.json')]);
  assert.match(textRun.stdout, /^allowlisted path: tools\/patterns\.json$/m);
});

test('usage and setup errors exit 2: unknown flag, unknown base, missing bundle', t => {
  const root = tmp(t);
  const toy = toyRepo(root);
  assert.equal(scan(['--bogus']).status, 2);
  assert.equal(scan(['--repo', toy.repo, '--base', 'f'.repeat(40), '--patterns', PATTERNS]).status, 2);
  const r = scan(['--no-diff', '--bundle', path.join(root, 'missing.bundle'), '--patterns', PATTERNS]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist/);
});

test('the shipped pattern list matches each generic shape and none of the listed synthetic identities', () => {
  const { loadPatterns, matchLine } = require(SCANNER);
  const P = loadPatterns(PATTERNS);
  const ids = s => matchLine(s, P).map(h => h.pattern);
  const samples = {
    email: ['x', 'y'].join('@') + '.example',
    'root-path': 'cd ' + ['', 'root', 'x'].join('/'),
    'home-path': ['', 'home', 'someone', 'x'].join('/'),
    'session-scratch': ['', 'tmp', 'claude-0', 'x'].join('/'),
    'session-id': 'session' + '_' + 'A1b2C3d4E5f6G7h8J9k0',
    'env-id': 'env' + '_' + 'A1b2C3d4E5f6G7h8J9k0',
    'session-link': 'https://' + ['claude.ai', 'code', 'session_x'].join('/'),
  };
  for (const [id, s] of Object.entries(samples)) assert.ok(ids(s).includes(id), `${id} matches its sample`);
  for (const s of ['a' + '@b.c', 'gate-test' + '@example.invalid', 'commit <>', 'react' + '@18.3.1', 'src/root/x', 'fixtures/home/x', 'process.env_x']) {
    assert.deepEqual(ids(s), [], `no finding in ${JSON.stringify(s)}`);
  }
});
