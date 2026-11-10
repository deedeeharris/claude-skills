'use strict';
// The environment the offline and real suites pass to git and to the runner (which runs git in the temp repos).
// An inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY or GIT_COMMON_DIR would point a
// `git init`/`git config`/`git commit` meant for a scratch repo at another repository, and the GIT_CONFIG* family
// (GIT_CONFIG, GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM, GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS) would
// inject configuration above the scratch repo's own. All are removed, from the inherited env and from `extra`.

const { spawnSync } = require('child_process');

const GIT_REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];
const isGitRedirectVar = (name) => GIT_REDIRECT_VARS.includes(name) || name.startsWith('GIT_CONFIG');

function gitEnv(extra = {}, base = process.env) {
  const env = Object.assign({}, base, extra);
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete env[k];
  for (const k of Object.keys(env)) if (isGitRedirectVar(k)) delete env[k];
  return env;
}

// git in `cwd` with the sanitized env; returns the raw spawnSync result (callers inspect status themselves).
function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }); }

module.exports = { GIT_REDIRECT_VARS, isGitRedirectVar, gitEnv, git };
