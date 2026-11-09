'use strict';

// Mocked Workflow harness (shared by the #37 tests). A copy of workflows.test.js's run():
// the real workflow script runs unchanged and only the hosted agent boundary is scripted.
// A reply is either a value or a function (prompt, options, calls) => reply, which may be
// async, so a test can execute what a prompt prescribes and reply with what it observed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WORKFLOWS = path.join(__dirname, '..', '..', 'workflows');
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8' }).trim();

// The text of a workflow at a git revision (for `before` rows run against the old code).
function sourceAt(rev, name) {
  return execFileSync('git', ['show', `${rev}:skills/gated-pipeline/workflows/${name}.js`], { cwd: REPO_ROOT, encoding: 'utf8' });
}

async function run(name, args, replies, opts = {}) {
  const source = (opts.source != null ? opts.source : fs.readFileSync(path.join(WORKFLOWS, name + '.js'), 'utf8'))
    .replace('export const meta =', 'const meta =');
  const calls = [];
  const queue = [...replies];
  const execute = new AsyncFunction('args', 'agent', 'phase', 'log', source);
  const result = await execute(args, async (prompt, options) => {
    calls.push({ prompt, options });
    assert.ok(queue.length, 'unexpected agent invocation: ' + options.label);
    const reply = queue.shift();
    return typeof reply === 'function' ? reply(prompt, options, calls) : reply;
  }, () => {}, () => {});
  return { result, calls };
}

// The role-tagged blocks of a relay prompt (```gp-exec <role>), in order. Fails when a role
// is missing, repeated or out of order, or when another gp-exec block is present.
function gpBlocks(prompt, roles) {
  const found = [...prompt.matchAll(/```gp-exec ([a-z]+)\n([\s\S]*?)\n```/g)].map(m => ({ role: m[1], body: m[2] }));
  assert.deepEqual(found.map(b => b.role), roles, 'gp-exec block roles, in order');
  return Object.fromEntries(found.map(b => [b.role, b.body]));
}

// K: how many times the prompt allows the poll block to run.
function pollLimit(prompt) {
  const m = prompt.match(/poll block[^\n]*?at most (\d+) times/);
  assert.ok(m, 'the prompt states how many times the poll block may run');
  return Number(m[1]);
}

module.exports = { run, sourceAt, gpBlocks, pollLimit, REPO_ROOT };
