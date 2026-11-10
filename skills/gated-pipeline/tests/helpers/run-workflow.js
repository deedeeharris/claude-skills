'use strict';

// Mocked Workflow harness (shared by the #37 tests). A copy of workflows.test.js's run():
// the real workflow script runs unchanged and only the hosted agent boundary is scripted.
// A reply is either a value or a function (prompt, options, calls) => reply, which may be
// async, so a test can execute what a prompt prescribes and reply with what it observed.
// From WP1 on every reply is also validated against options.schema with schema-lite.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { compile } = require('../../scripts/lib/schema-lite');
const { gitEnv } = require('./git-env.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WORKFLOWS = path.join(__dirname, '..', '..', 'workflows');
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8', env: gitEnv() }).trim();

// The text of a workflow at a git revision (for `before` rows run against the old code).
function sourceAt(rev, name) {
  return execFileSync('git', ['show', `${rev}:skills/gated-pipeline/workflows/${name}.js`], { cwd: REPO_ROOT, encoding: 'utf8', env: gitEnv() });
}

// Every reply is validated against the schema its call declares, as the hosted Workflow tool
// validates a structured reply: a schema outside the schema-lite subset (a setup error) or a
// reply that does not conform fails the test. Two escapes, both explicit:
// - opts.nonConforming: labels whose replies must NOT conform (asserted), for tests of the
//   workflow's own defence against a malformed relay; the reply is passed through unchanged.
// - STOP: a reply that ends the run at that call (result: STOPPED) after recording it, for
//   tests that only read a prompt. It is never handed to the workflow.
const STOP = Symbol('run-workflow STOP');
const STOPPED = Object.freeze({ stopped: true });
const validators = new WeakMap();

function validatorFor(options) {
  const schema = options.schema;
  const cacheable = schema !== null && typeof schema === 'object';
  if (cacheable && validators.has(schema)) return validators.get(schema);
  let validate;
  try { validate = compile(schema); } catch (e) {
    assert.fail(`agent call "${options.label}": its schema is not a schema-lite schema: ${e.message}`);
  }
  if (cacheable) validators.set(schema, validate);
  return validate;
}

function checkReply(options, value, expectInvalid) {
  const errors = validatorFor(options)(value);
  if (expectInvalid) assert.ok(errors.length, `agent call "${options.label}": declared nonConforming, but its reply conforms to its schema`);
  else assert.deepEqual(errors, [], `agent call "${options.label}": scripted reply does not conform to its schema`);
}

class Stop extends Error {}

async function run(name, args, replies, opts = {}) {
  const source = (opts.source != null ? opts.source : fs.readFileSync(path.join(WORKFLOWS, name + '.js'), 'utf8'))
    .replace('export const meta =', 'const meta =');
  const nonConforming = new Set(opts.nonConforming || []);
  const calls = [];
  const queue = [...replies];
  const execute = new AsyncFunction('args', 'agent', 'phase', 'log', source);
  let stopped = false;
  let result;
  try {
    result = await execute(args, async (prompt, options) => {
      calls.push({ prompt, options });
      assert.ok(!stopped, 'agent invoked after STOP: ' + options.label);
      assert.ok(queue.length, 'unexpected agent invocation: ' + options.label);
      const reply = queue.shift();
      const value = await (typeof reply === 'function' ? reply(prompt, options, calls) : reply);
      if (value === STOP) { stopped = true; throw new Stop(); }
      if (options.schema !== undefined) checkReply(options, value, nonConforming.has(options.label));
      else assert.ok(!nonConforming.has(options.label), `agent call "${options.label}": declared nonConforming but has no schema`);
      return value;
    }, () => {}, () => {});
  } catch (e) {
    // A workflow could catch the Stop itself; `stopped` is what counts, and any other error propagates.
    if (!(e instanceof Stop)) throw e;
  }
  if (stopped) return { result: STOPPED, calls };
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

module.exports = { run, sourceAt, gpBlocks, pollLimit, REPO_ROOT, STOP, STOPPED };
