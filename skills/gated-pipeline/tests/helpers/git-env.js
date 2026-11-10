'use strict';

// The environment every test helper and test passes to a process that runs git (plan WP7, hardening).
// An inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY or GIT_COMMON_DIR would point a
// `git init`, `git config` or `git commit` meant for a temp repo at another repository; GIT_CONFIG,
// GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM, GIT_CONFIG_COUNT/KEY_n/VALUE_n and GIT_CONFIG_PARAMETERS would inject
// configuration (identity, hooks, signing) above the temp repo's own. All of them are removed, from the inherited
// environment and from `extra` alike, so no caller can reintroduce one by accident.
//
// API:
//   GIT_REDIRECT_VARS            -> the exact names removed (the GIT_CONFIG* family is matched by prefix)
//   isGitRedirectVar(name)       -> true for a name that is removed
//   gitEnv(extra = {}, base = process.env) -> a new env object: base, then extra (an undefined value deletes the
//                                   key), without any removed name

const GIT_REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

function isGitRedirectVar(name) {
  return GIT_REDIRECT_VARS.includes(name) || name.startsWith('GIT_CONFIG');
}

function gitEnv(extra = {}, base = process.env) {
  const env = { ...base, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  for (const k of Object.keys(env)) if (isGitRedirectVar(k)) delete env[k];
  return env;
}

module.exports = { GIT_REDIRECT_VARS, isGitRedirectVar, gitEnv };
