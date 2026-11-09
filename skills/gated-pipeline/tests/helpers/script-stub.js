'use strict';

// Script-executing stub for mocked v2 workflow tests (plan WP3). A deterministic step of a v2 prompt is one fenced
// ```gp-exec block (untagged; role-tagged relay blocks `gp-exec <role>` are run-workflow.js gpBlocks' business).
// The stub finds every such block in the prompt, FAILS when a deterministic step has none, runs each block
// verbatim with bash in the temp repo (cp, write-json.js, git plumbing, the node scripts), in order, stopping at
// the first nonzero exit, and replies with the real stdout and exit code. Model steps keep scripted replies.
// Everything driven by this stub is MOCKED at the agent boundary only: the scripts and git really run.
//
// API:
//   gpExecBlocks(prompt)                      -> [body, ...] (untagged gp-exec blocks, in order)
//   runBlocks(prompt, { cwd, env })           -> { blocks: [ { body, status, stdout, stderr } ], stdout, exit_code }
//   scriptStep(toReply, { cwd, env })         -> a run-workflow.js reply function: (prompt, options, calls) =>
//                                                toReply({ prompt, options, ...runBlocks(prompt) }); the default
//                                                toReply returns { stdout, exit_code }.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('./v2-repo.js');

const MOCKED = 'mocked: scripted agent boundary, real scripts';

function gpExecBlocks(prompt) {
  return [...String(prompt).matchAll(/```gp-exec\n([\s\S]*?)\n```/g)].map(m => m[1]);
}

function runBlocks(prompt, { cwd, env } = {}) {
  const bodies = gpExecBlocks(prompt);
  assert.ok(bodies.length > 0, 'a deterministic step must carry a ```gp-exec block; this prompt has none');
  const blocks = [];
  for (const body of bodies) {
    const r = spawnSync('bash', ['-c', body], { cwd, env: env || cleanEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    blocks.push({ body, status: r.status, stdout: r.stdout, stderr: r.stderr });
    if (r.status !== 0) break;
  }
  const last = blocks[blocks.length - 1];
  return { blocks, stdout: blocks.map(b => b.stdout).join(''), exit_code: last.status };
}

function scriptStep(toReply, opts = {}) {
  const reply = toReply || (r => ({ stdout: r.stdout, exit_code: r.exit_code }));
  return (prompt, options, calls) => reply({ prompt, options, calls, ...runBlocks(prompt, opts) });
}

module.exports = { gpExecBlocks, runBlocks, scriptStep, MOCKED };
