'use strict';

// Hardening (plan WP7): every helper that runs git in a temp repo passes an env without GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR and the GIT_CONFIG* family. The proof: a child process
// whose inherited environment points all of them at a decoy repository runs every git-running helper (v2-repo
// makeRepo + freeze, the v1 completion fixture, the script-executing stub, run-workflow's repo lookup, and
// codex-review's test git()), and the decoy's config, HEAD, refs, index and object store stay byte-identical. A
// positive control first shows that the same environment really does redirect a plain `git config` into a decoy.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { gitEnv, isGitRedirectVar, GIT_REDIRECT_VARS } = require('./helpers/git-env.js');

const HELPERS = path.join(__dirname, 'helpers');
const CODEX_GIT_ENV = path.resolve(__dirname, '../../codex-review/tests/git-env.js');
const SKILLS_REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A decoy repository with one commit, an index, and a global config file of its own.
function makeDecoy(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  cleanGit(dir, 'init', '-q', '-b', 'main');
  cleanGit(dir, 'config', 'user.name', 'Decoy Owner');
  cleanGit(dir, 'config', 'user.email', '');
  cleanGit(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'decoy.txt'), 'decoy\n');
  cleanGit(dir, 'add', 'decoy.txt');
  cleanGit(dir, 'commit', '-qm', 'decoy base');
  const globalConfig = path.join(root, `${name}.global.gitconfig`);
  fs.writeFileSync(globalConfig, '[decoy]\n\tmarker = untouched\n');
  return { dir, gitDir: path.join(dir, '.git'), globalConfig };
}

// Every byte git could write for a repository: all files under .git (config, HEAD, refs, index, objects, logs),
// plus the decoy's global config file.
function snapshot(decoy) {
  const out = {};
  const walk = rel => {
    const abs = path.join(decoy.gitDir, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(decoy.gitDir, r))).digest('hex');
    }
  };
  walk('');
  out['<global config>'] = fs.readFileSync(decoy.globalConfig, 'utf8');
  return out;
}

// The environment an unlucky test process could inherit: every redirect var aims at the decoy, and injected
// config would override the temp repo's identity.
function hostileEnv(decoy) {
  return {
    ...gitEnv(),
    GIT_DIR: decoy.gitDir,
    GIT_WORK_TREE: decoy.dir,
    GIT_INDEX_FILE: path.join(decoy.gitDir, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(decoy.gitDir, 'objects'),
    GIT_COMMON_DIR: decoy.gitDir,
    GIT_CONFIG: path.join(decoy.gitDir, 'config'),
    GIT_CONFIG_GLOBAL: decoy.globalConfig,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Injected Identity',
  };
}

test('gitEnv removes the redirect vars and the whole GIT_CONFIG* family, from the base and from extra', () => {
  const base = { PATH: '/bin', GIT_DIR: 'a', GIT_WORK_TREE: 'b', GIT_INDEX_FILE: 'c', GIT_OBJECT_DIRECTORY: 'd', GIT_COMMON_DIR: 'e',
    GIT_CONFIG: 'f', GIT_CONFIG_GLOBAL: 'g', GIT_CONFIG_SYSTEM: 'h', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x', GIT_CONFIG_PARAMETERS: "'user.name'='x'", GIT_AUTHOR_NAME: 'kept' };
  const env = gitEnv({ GIT_DIR: 'again', EXTRA: '1', PATH: undefined }, base);
  assert.deepEqual(env, { GIT_AUTHOR_NAME: 'kept', EXTRA: '1' });
  assert.deepEqual(GIT_REDIRECT_VARS, ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']);
  assert.ok(isGitRedirectVar('GIT_CONFIG_KEY_7') && !isGitRedirectVar('GIT_AUTHOR_DATE'));
  const codex = require(CODEX_GIT_ENV);
  assert.deepEqual(codex.gitEnv({ GIT_DIR: 'again', EXTRA: '1', PATH: undefined }, base), env, 'codex-review strips the same set');
});

test('with GIT_DIR and the GIT_CONFIG* family pointing at a decoy repo, the git-running helpers leave the decoy unchanged', t => {
  const root = tmp(t, 'gp-git-decoy-');

  // Positive control: the hostile env really does redirect an unsanitized `git config` into a decoy.
  const control = makeDecoy(root, 'control');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const before = fs.readFileSync(path.join(control.gitDir, 'config'), 'utf8');
  const raw = spawnSync('git', ['config', 'user.name', 'Leaked Name'], { cwd: elsewhere, encoding: 'utf8', env: hostileEnv(control) });
  assert.equal(raw.status, 0, raw.stderr);
  assert.notEqual(fs.readFileSync(path.join(control.gitDir, 'config'), 'utf8'), before, 'control: the hostile env must reach the decoy');

  // The real check: every helper, in a child process that inherits the hostile env.
  const decoy = makeDecoy(root, 'decoy');
  const pristine = snapshot(decoy);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const child = `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const { spawnSync } = require('node:child_process');
    const work = ${JSON.stringify(work)};
    const cleanups = [];
    const t = { after: fn => cleanups.push(fn) };
    const out = {};
    const { makeRepo, cleanEnv } = require(${JSON.stringify(path.join(HELPERS, 'v2-repo.js'))});
    const c = makeRepo(t);
    c.freeze();
    out.v2_author = c.git('log', '-1', '--format=%an');
    out.v2_toplevel = c.git('rev-parse', '--show-toplevel');
    out.v2_repo = c.repo;
    const { fixture } = require(${JSON.stringify(path.join(HELPERS, 'v1-completion-cases.js'))});
    fs.mkdirSync(path.join(work, 'v1'));
    fixture(path.join(work, 'v1'));
    const v1Repo = path.join(work, 'v1', 'repo');
    out.v1_author = spawnSync('git', ['-C', v1Repo, 'log', '-1', '--format=%an'], { encoding: 'utf8', env: cleanEnv() }).stdout.trim();
    const { runBlocks } = require(${JSON.stringify(path.join(HELPERS, 'script-stub.js'))});
    const stubRepo = path.join(work, 'stub');
    fs.mkdirSync(stubRepo);
    const stub = runBlocks('\`\`\`gp-exec\\ngit init -q && git config user.name stub && git config user.email "" && git commit -q --allow-empty -m stub && git log -1 --format=%an\\n\`\`\`', { cwd: stubRepo });
    out.stub = { exit_code: stub.exit_code, stdout: stub.stdout.trim() };
    const { REPO_ROOT, sourceAt } = require(${JSON.stringify(path.join(HELPERS, 'run-workflow.js'))});
    out.run_workflow_root = REPO_ROOT;
    out.source_at_head = sourceAt('HEAD', 'design').length > 0;
    const codex = require(${JSON.stringify(CODEX_GIT_ENV)});
    const cr = path.join(work, 'codex');
    fs.mkdirSync(cr);
    const steps = [['init', '-q'], ['config', 'user.email', ''], ['config', 'user.name', 'test'], ['commit', '-q', '--allow-empty', '-m', 'x']];
    out.codex_status = steps.map(a => codex.git(cr, a).status);
    out.codex_author = codex.git(cr, ['log', '-1', '--format=%an']).stdout.trim();
    for (const fn of cleanups) fn();
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['-e', child], { cwd: work, encoding: 'utf8', env: hostileEnv(decoy), maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `child: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout);

  assert.deepEqual(snapshot(decoy), pristine, 'the decoy repository (config, HEAD, refs, index, objects, global config) is unchanged');
  assert.equal(out.v2_author, 'alice', 'v2-repo commits carry the temp repo identity, not the injected one');
  assert.equal(out.v2_toplevel, out.v2_repo, 'v2-repo git runs in its own temp repo');
  assert.equal(out.v1_author, 'Gate Test', 'v1 completion fixture commits carry its own identity');
  assert.deepEqual(out.stub, { exit_code: 0, stdout: 'stub' }, 'the script-executing stub runs git in its cwd');
  assert.equal(out.run_workflow_root, SKILLS_REPO, 'run-workflow resolves this repository, not the decoy');
  assert.equal(out.source_at_head, true);
  assert.deepEqual(out.codex_status, [0, 0, 0, 0]);
  assert.equal(out.codex_author, 'test', 'codex-review test git() commits carry the scratch identity');
});
