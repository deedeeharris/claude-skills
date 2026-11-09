#!/usr/bin/env node
'use strict';

// scripts/run-frozen.js (docs/v2-design.md section 6.4), against real temp repos built by tests/helpers/v2-repo.js:
// a real design commit, a real frozen compile, real git worktrees and real child processes. Limits measured in
// minutes are shortened with the script's documented test hook GP_RUN_FROZEN_SECONDS_PER_MINUTE (it can only
// shorten them). Also: tests/helpers/script-stub.js, the script-executing stub of the mocked v2 workflow tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { makeRepo, baseFeature, clone, sha256 } = require('./helpers/v2-repo.js');
const { gpExecBlocks, runBlocks, scriptStep } = require('./helpers/script-stub.js');

const FAST = { GP_RUN_FROZEN_SECONDS_PER_MINUTE: '1', GP_RUN_FROZEN_KILL_GRACE_S: '1' };

function frozenRepo(t, edit) {
  const f = baseFeature();
  if (edit) edit(f);
  const c = makeRepo(t, { feature: f });
  c.freeze();
  c.implement();
  return c;
}
const out = r => JSON.parse(r.stdout);
const record = r => JSON.parse(fs.readFileSync(out(r).record_path, 'utf8'));
function framed(log) {
  const lines = log.split('\n');
  assert.equal(lines.pop(), '', 'the log ends with LF');
  const header = lines[0], footer = lines[lines.length - 1];
  assert.match(header, /^gp-run-frozen header \{/);
  assert.match(footer, /^gp-run-frozen footer \{/);
  return { header: JSON.parse(header.slice('gp-run-frozen header '.length)), footer: JSON.parse(footer.slice('gp-run-frozen footer '.length)), body: lines.slice(1, -1).join('\n') };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('run-frozen executes exactly the manifest command of the target and no other', t => {
  const c = makeRepo(t);
  const other = path.join(c.root, 'other-check-ran');
  c.feature.checks[0].command = 'echo lint-ran';
  c.feature.checks.push({ id: 'CHECK-OTHER', name: 'Other', applicable: true, reason: 'Must not run.', command: `touch ${other}`, expected: { exit_code: 0 }, timeout_min: 1, budget_min: 0, quiet: false, effort: 'low', environment: 'shell' });
  c.writeFeature();
  c.freeze();
  c.implement();
  const r = c.runFrozen('check:CHECK-LINT');
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.equal(rec.command, 'echo lint-ran');
  assert.equal(rec.exit_code, 0);
  assert.equal(rec.head_before, c.reviewedSha);
  assert.equal(rec.cwd, c.repo);
  const log = framed(fs.readFileSync(rec.log_path, 'utf8'));
  assert.deepEqual(log.header, { target: 'check:CHECK-LINT', command: 'echo lint-ran', cwd: c.repo, head: c.reviewedSha });
  assert.match(log.body, /lint-ran/);
  assert.deepEqual(log.footer, { exit_code: 0, signal: null, elapsed_s: rec.elapsed_s });
  assert.equal(rec.log_sha256, sha256(fs.readFileSync(rec.log_path)));
  assert.equal(out(r).record_sha256, sha256(fs.readFileSync(out(r).record_path)));
  assert.equal(fs.existsSync(other), false, 'the other check never ran');
  // There is no way to hand it a command string.
  const relayed = c.node('run-frozen.js', ['--repo', c.repo, '--frozen-dir', c.frozenDir, '--manifest-sha256', c.manifestSha, '--reviewed-sha', c.reviewedSha,
    '--target', 'check:CHECK-LINT', '--out-dir', path.join(c.run, 'x'), '--command', `touch ${other}`]);
  assert.equal(relayed.status, 2);
  assert.equal(fs.existsSync(other), false);
  // A record is written once.
  const again = c.runFrozen('check:CHECK-LINT');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
});

test('run-frozen refuses a manifest that does not hash to --manifest-sha256', t => {
  const c = frozenRepo(t);
  const r = c.runFrozen('check:CHECK-LINT', { manifestSha: '0'.repeat(64) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not hash/);
  fs.appendFileSync(c.manifestPath, ' ');
  const edited = c.runFrozen('check:CHECK-LINT');
  assert.equal(edited.status, 1);
  assert.equal(fs.existsSync(path.join(c.frozenRuns, 'check:CHECK-LINT.record.json')), false);
});

test('run-frozen refuses a frozen command holding the repo absolute path', t => {
  const c = makeRepo(t);
  c.feature.checks[0].command = `ls ${c.repo}/src`;
  c.writeFeature();
  c.freeze();
  c.implement();
  const r = c.runFrozen('check:CHECK-LINT');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /absolute path/);
  assert.equal(fs.existsSync(path.join(c.frozenRuns, 'check:CHECK-LINT.record.json')), false);
});

test('run-frozen refuses an id that fails its literal pattern, and a relative --repo', t => {
  const c = frozenRepo(t);
  for (const target of ['check:check-lint', 'check:CHECK-../x', 'proof:../HELLO-001-AC1', 'proof:HELLO-1-AC1', 'negative:hello-001-AC1', 'live:HELLO-001-AC', 'other:X', 'suite:x']) {
    const r = c.runFrozen(target, { patch: target.startsWith('negative') ? c.patchFile('x', c.MUTATION) : undefined });
    assert.equal(r.status, 1, target + ': ' + r.stderr);
    assert.match(r.stderr, /does not match|is not check/, target);
  }
  const rel = c.runFrozen('check:CHECK-LINT', { repo: 'repo' });
  assert.equal(rel.status, 2);
  assert.match(rel.stderr, /absolute/);
});

test('a hanging check is killed with its whole process group at timeout_min and recorded timed_out', t => {
  const c = makeRepo(t);
  const pids = path.join(c.root, 'pids');
  c.feature.checks[0].command = `sh -c 'echo $$ > ${pids}; sleep 60 & echo $! >> ${pids}; wait'`;
  c.feature.checks[0].timeout_min = 1;
  c.writeFeature();
  c.freeze();
  c.implement();
  const r = c.runFrozen('check:CHECK-LINT', { env: FAST });
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.equal(rec.timed_out, true);
  assert.equal(rec.timeout_s, 1);
  assert.ok(rec.elapsed_s >= 1 && rec.elapsed_s < 5, `elapsed ${rec.elapsed_s}`);
  assert.equal(out(r).timed_out, true);
  for (const pid of fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number)) assert.equal(alive(pid), false, `pid ${pid} of the group is gone`);
  assert.equal(framed(fs.readFileSync(rec.log_path, 'utf8')).footer.elapsed_s, rec.elapsed_s);
});

test('a check with budget_min > 0 is killed at budget_min, not timeout_min', t => {
  const c = makeRepo(t);
  const live = c.feature.checks.find(x => x.id === 'CHECK-LIVE');
  live.command = 'sleep 30';
  live.budget_min = 1;
  live.timeout_min = 5;
  c.feature.requirements[0].acceptance[1].verification.command = 'sleep 30';
  c.writeFeature();
  c.freeze();
  c.implement();
  const r = c.runFrozen('check:CHECK-LIVE', { env: FAST });
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.equal(rec.timeout_s, 1);
  assert.equal(rec.budget_min, 1);
  assert.equal(rec.timeout_min, 5);
  assert.equal(rec.timed_out, true);
  assert.ok(rec.elapsed_s < 4, `elapsed ${rec.elapsed_s}`);
});

test('a silent passing command still gives a framed, nonempty log', t => {
  const c = makeRepo(t);
  c.feature.checks[0].command = 'true';
  c.writeFeature();
  c.freeze();
  c.implement();
  const r = c.runFrozen('check:CHECK-LINT');
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  const text = fs.readFileSync(rec.log_path, 'utf8');
  assert.ok(text.length > 0);
  const log = framed(text);
  assert.equal(log.header.command, 'true');
  assert.equal(log.footer.exit_code, 0);
});

test('proof: is refused for a live acceptance; live: links the check record without executing anything', t => {
  const c = makeRepo(t);
  const counter = path.join(c.root, 'live-count');
  const impl = { ...require('./helpers/v2-repo.js').IMPL_FILES, 'test/live.test.js': `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');\n` };
  c.freeze();
  c.implement(impl);
  const refused = c.runFrozen('proof:HELLO-001-AC2');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /live acceptance/);
  assert.equal(fs.existsSync(counter), false);
  const early = c.runFrozen('live:HELLO-001-AC2');
  assert.equal(early.status, 1, 'no check record yet');
  assert.match(early.stderr, /no readable check record/);
  const check = c.runFrozen('check:CHECK-LIVE');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), 'x');
  const link = c.runFrozen('live:HELLO-001-AC2');
  assert.equal(link.status, 0, link.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), 'x', 'live: executed nothing');
  const ledger = JSON.parse(fs.readFileSync(c.ledgerPath, 'utf8'));
  assert.deepEqual(ledger, { version: 2, entries: [{ id: 'HELLO-001-AC2', live: true, check_id: 'CHECK-LIVE', record_path: out(check).record_path, record_sha256: out(check).record_sha256 }] });
  assert.equal(c.runFrozen('live:HELLO-001-AC2').status, 1, 'an id is linked once');
  // proof: appends its own record
  const proof = c.runFrozen('proof:HELLO-001-AC1');
  assert.equal(proof.status, 0, proof.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.ledgerPath, 'utf8')).entries[1], { id: 'HELLO-001-AC1', live: false, record_path: out(proof).record_path, record_sha256: out(proof).record_sha256 });
  assert.equal(c.runFrozen('proof:HELLO-001-AC3').status, 1, 'a static acceptance has no command');
});

test('an isolated suite runs in a fresh worktree, records its setup run and removes the worktree', t => {
  const c = frozenRepo(t, f => { f.suite.isolated = true; f.suite.setup_command = 'echo setup-ran'; });
  const r = c.runFrozen('suite');
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.equal(out(r).setup_exit_code, 0);
  assert.equal(rec.setup.exit_code, 0);
  assert.equal(rec.setup.timed_out, false);
  assert.match(fs.readFileSync(rec.setup.log_path, 'utf8'), /setup-ran/);
  assert.equal(rec.setup.log_sha256, sha256(fs.readFileSync(rec.setup.log_path)));
  assert.equal(rec.cwd, path.join(c.frozenRuns, 'suite-wt'));
  assert.equal(rec.exit_code, 0);
  assert.equal(fs.existsSync(rec.cwd), false, 'the worktree is removed');
  assert.equal(c.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
});

test('a failed suite setup skips the suite (exit_code null)', t => {
  const c = frozenRepo(t, f => { f.suite.isolated = true; f.suite.setup_command = 'exit 3'; });
  const rec = record(c.runFrozen('suite'));
  assert.equal(rec.setup.exit_code, 3);
  assert.equal(rec.exit_code, null);
});

test('the checkout must be at reviewed_sha and clean before anything runs', t => {
  const c = frozenRepo(t);
  fs.writeFileSync(path.join(c.repo, 'src', 'extra.js'), 'dirty\n');
  const dirty = c.runFrozen('check:CHECK-LINT');
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /not clean/);
  fs.unlinkSync(path.join(c.repo, 'src', 'extra.js'));
  const moved = c.runFrozen('check:CHECK-LINT', { sha: c.designCommit });
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /not reviewed_sha/);
});

const NEGATIVE_PATCHES = {
  rename: 'diff --git a/src/hello.js b/src/greet.js\nsimilarity index 100%\nrename from src/hello.js\nrename to src/greet.js\n',
  delete: "diff --git a/src/hello.js b/src/hello.js\ndeleted file mode 100644\n--- a/src/hello.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-module.exports = () => 'hello';\n",
  mode: 'diff --git a/src/hello.js b/src/hello.js\nold mode 100644\nnew mode 100755\n',
  binary: 'diff --git a/src/hello.js b/src/hello.js\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 1\nIcmZpb0000\n\n',
  empty: '',
};
for (const [kind, text] of Object.entries(NEGATIVE_PATCHES)) {
  test(`negative-control patch derivation rejects a ${kind} patch`, t => {
    const c = frozenRepo(t);
    const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: path.join(c.run, 'negative', 'HELLO-001-AC1'), patch: c.patchFile('HELLO-001-AC1', text) });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, kind === 'empty' ? /empty/ : new RegExp(kind === 'mode' ? 'mode' : kind === 'binary' ? 'binary' : kind === 'rename' ? 'rename' : 'deletes'));
    assert.equal(fs.existsSync(path.join(c.run, 'negative', 'HELLO-001-AC1', 'negative:HELLO-001-AC1.record.json')), false);
  });
}

// Patches git apply reads as touching more than their `diff --git` headers name (review fix: mutated_paths must be what
// git will touch). Each breaks test/hello.test.js while the headers name only src/hello.js; expectations are literals.
const TEST_BREAK = "--- a/test/hello.test.js\n+++ b/test/hello.test.js\n@@ -1,3 +1,3 @@\n const assert = require('assert');\n-assert.equal(require('../src/hello.js')(), 'hello');\n+process.exit(1);\n console.log('hello test ok');\n";
const NOOP_HELLO = "diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1 +1,2 @@\n module.exports = () => 'hello';\n+// a comment changes nothing\n";
const SMUGGLING_PATCHES = {
  'leading plain hunk': [TEST_BREAK + NOOP_HELLO, /text before its first diff --git header/],
  'trailing plain hunk': [NOOP_HELLO + TEST_BREAK, /outside a diff --git section's hunks/],
  'trailing plain hunk after a blank line': [NOOP_HELLO + '\n' + TEST_BREAK, /outside a diff --git section's hunks/],
  'mismatched ---/+++ names': ["diff --git a/src/hello.js b/src/hello.js\n" + TEST_BREAK, /does not name src\/hello.js/],
  'mismatched +++ name': ["diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/test/hello.test.js\n@@ -1 +1 @@\n-x\n+y\n", /does not name src\/hello.js/],
  'hunk longer than its counts': ["diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1 +1 @@\n-module.exports = () => 'hello';\n+module.exports = () => 'goodbye';\n+extra\n", /outside a diff --git section's hunks/],
  'hunk shorter than its counts': ["diff --git a/src/hello.js b/src/hello.js\n--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1,2 +1,2 @@\n-module.exports = () => 'hello';\n+module.exports = () => 'goodbye';\n", /ends early/],
};
for (const [kind, [text, pattern]] of Object.entries(SMUGGLING_PATCHES)) {
  test(`negative-control patch derivation rejects a ${kind}`, t => {
    const c = frozenRepo(t);
    const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
    const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch: c.patchFile('HELLO-001-AC1', text) });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(fs.existsSync(path.join(dir, 'negative:HELLO-001-AC1.record.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'wt')), false);
  });
}

test('git apply --numstat lists the paths a smuggling patch really touches, and the cross-check refuses it', t => {
  const c = frozenRepo(t);
  const { gitPatchPaths, checkedPatchPaths } = require('../scripts/run-frozen.js');
  const file = c.patchFile('HELLO-001-AC1', TEST_BREAK + NOOP_HELLO);
  assert.deepEqual(gitPatchPaths(c.repo, file), ['test/hello.test.js', 'src/hello.js']);
  assert.throws(() => checkedPatchPaths(c.repo, file, fs.readFileSync(file)), /text before its first diff --git header/);
  const good = c.patchFile('HELLO-001-AC1', c.MUTATION + "diff --git a/src/new.js b/src/new.js\nnew file mode 100644\nindex 0000000..e69de29\n");
  assert.deepEqual(checkedPatchPaths(c.repo, good, fs.readFileSync(good)), ['src/hello.js', 'src/new.js']);
});

// Review fix: `git diff` of a content-only edit to an executable file writes `index <a>..<b> 100755`; the mode is
// unchanged, so the patch is a plain mutation. Symlinks (120000) and gitlinks (160000) stay refused.
test('negative-control patch derivation accepts an unchanged 100755 index line and refuses 120000 and 160000', () => {
  const { patchPaths } = require('../scripts/run-frozen.js');
  const edit = mode => Buffer.from(`diff --git a/bin/run.sh b/bin/run.sh\nindex de98044..7be73ce${mode}\n--- a/bin/run.sh\n+++ b/bin/run.sh\n@@ -1 +1 @@\n-echo hi\n+echo bye\n`);
  assert.deepEqual(patchPaths(edit(' 100755')), ['bin/run.sh']);
  assert.deepEqual(patchPaths(edit(' 100644')), ['bin/run.sh']);
  assert.deepEqual(patchPaths(edit('')), ['bin/run.sh']);
  assert.throws(() => patchPaths(edit(' 120000')), /symlink or submodule/);
  assert.throws(() => patchPaths(edit(' 160000')), /symlink or submodule/);
  assert.throws(() => patchPaths(edit(' 100700')), /unsupported line/);
});

test('a git-generated patch editing an executable owned file runs as a negative control', t => {
  const f = baseFeature();
  const c = makeRepo(t, { feature: f });
  c.freeze();
  c.implement(undefined, ['src/hello.js']);
  const text = c.gitDiff('src/hello.js', "module.exports = () => 'goodbye';\n");
  assert.match(text, /^index [0-9a-f]+\.\.[0-9a-f]+ 100755$/m, 'git writes the executable mode on the index line');
  const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch: c.patchFile('HELLO-001-AC1', text) });
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.equal(rec.baseline_exit_code, 0);
  assert.equal(rec.exit_code, 1);
  assert.deepEqual(rec.mutated_paths, ['src/hello.js']);
});

// Review fix: the patch is read once; git applies those bytes, not whatever sits at --patch after the baseline.
// The setup command (run before the baseline) swaps the --patch file for a weak no-op patch.
test('a negative control applies the bytes it hashed, even if the --patch file is swapped during the run', t => {
  const c = frozenRepo(t, f => { f.suite.setup_command = 'if [ -f ../swap.patch ]; then cp ../swap.patch ../mutation.patch; fi'; });
  const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  const patch = c.patchFile('HELLO-001-AC1', c.MUTATION);
  fs.writeFileSync(path.join(dir, 'swap.patch'), NOOP_HELLO);
  const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(patch, 'utf8'), NOOP_HELLO, 'the setup command did swap the file');
  const rec = record(r);
  assert.equal(rec.exit_code, 1, 'the hashed mutation, not the swapped no-op, was applied');
  assert.equal(rec.mutation_patch_sha256, sha256(Buffer.from(c.MUTATION)));
  assert.deepEqual(rec.mutated_paths, ['src/hello.js']);
});

test('a negative control records the limit applied to its mutated run', t => {
  const c = frozenRepo(t, f => { f.limits.proof_timeout_s = 30; });
  const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch: c.patchFile('HELLO-001-AC1', c.MUTATION), env: { GP_RUN_FROZEN_SECONDS_PER_MINUTE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.ok(rec.timeout_s > 0 && rec.timeout_s < 30, `timeout_s ${rec.timeout_s} is the phase-bounded limit, not proof_timeout_s`);
});

test('a negative control runs baseline and mutation in a throwaway worktree and records both', t => {
  const c = frozenRepo(t);
  const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch: c.patchFile('HELLO-001-AC1', c.MUTATION) });
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.equal(rec.baseline_exit_code, 0);
  assert.equal(rec.exit_code, 1, 'the mutated proof fails');
  assert.deepEqual(rec.mutated_paths, ['src/hello.js']);
  assert.equal(rec.mutation_patch_sha256, sha256(fs.readFileSync(path.join(dir, 'mutation.patch'))));
  assert.equal(rec.head_before, c.reviewedSha);
  assert.equal(rec.head_after, c.reviewedSha);
  assert.deepEqual(rec.status_after, []);
  assert.equal(fs.existsSync(path.join(dir, 'wt')), false);
  assert.equal(fs.readFileSync(path.join(c.repo, 'src', 'hello.js'), 'utf8'), "module.exports = () => 'hello';\n", 'the work checkout is untouched');
  assert.equal(framed(fs.readFileSync(rec.baseline_log_path, 'utf8')).header.target, 'negative:HELLO-001-AC1.baseline');
  assert.ok(typeof rec.phase_elapsed_s === 'number' && rec.phase_elapsed_s >= 0);
});

test('a negative-control patch that does not apply is exit 1 and writes no record', t => {
  const c = frozenRepo(t);
  const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  const bad = c.MUTATION.replace("-module.exports = () => 'hello';", "-module.exports = () => 'nothing like this';");
  const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch: c.patchFile('HELLO-001-AC1', bad) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not apply/);
  assert.equal(fs.existsSync(path.join(dir, 'negative:HELLO-001-AC1.record.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'wt')), false);
});

test('a hanging mutation is killed at limits.proof_timeout_s', t => {
  const c = frozenRepo(t, f => { f.limits.proof_timeout_s = 1; });
  const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  const hang = c.MUTATION.replace("+module.exports = () => 'goodbye';", '+for (;;) {}');
  const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch: c.patchFile('HELLO-001-AC1', hang), env: { GP_RUN_FROZEN_KILL_GRACE_S: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const rec = record(r);
  assert.equal(rec.baseline_exit_code, 0);
  assert.equal(rec.timed_out, true);
  assert.ok(rec.elapsed_s < 5, `elapsed ${rec.elapsed_s}`);
});

test('a negative control that would start after negative_controls_total_min is NOT RUN', t => {
  const c = frozenRepo(t);
  const dir = path.join(c.run, 'negative', 'HELLO-001-AC1');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(dir), 'phase-start.json'), JSON.stringify({ started_ms: Date.now() - 6 * 60 * 1000 }) + '\n');
  const r = c.runFrozen('negative:HELLO-001-AC1', { outDir: dir, patch: c.patchFile('HELLO-001-AC1', c.MUTATION) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NOT RUN/);
  assert.equal(record(r).status, 'NOT_RUN');
});

// --- interrupted: a Bash tool timeout or an interrupted agent ends run-frozen.js with a signal -------------------------
// The frozen command runs in its own process group, so without a handler it would outlive run-frozen.js as an orphan
// with no limit and no record. Interrupted: the group is killed, the log gets a footer, no record, exit 1.
const { spawn } = require('node:child_process');
const { cleanEnv } = require('./helpers/v2-repo.js');
async function interrupted(t, signal, { target = 'check:CHECK-LINT', edit, extra = [] } = {}) {
  const f = baseFeature();
  const c0 = makeRepo(t, { feature: f });
  const started = path.join(c0.root, 'started');
  const marker = path.join(c0.root, 'survived');
  const cmd = `echo started > ${started}; sleep 4; echo survived > ${marker}`;
  edit(c0.feature, cmd);
  c0.writeFeature();
  c0.freeze();
  c0.implement();
  const args = ['--repo', c0.repo, '--frozen-dir', c0.frozenDir, '--manifest-sha256', c0.manifestSha, '--reviewed-sha', c0.reviewedSha,
    '--target', target, '--out-dir', c0.frozenRuns, ...extra];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'run-frozen.js'), ...args], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
  for (let i = 0; i < 200 && !fs.existsSync(started); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(fs.existsSync(started), 'the frozen command started');
  child.kill(signal);
  const { code, sig } = await exited;
  await new Promise(r => setTimeout(r, 5000));
  return { c: c0, code, sig, stdout, stderr, marker };
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`run-frozen ended by ${signal} kills the frozen command's group, writes no record, frames the log as interrupted and exits 1`, async t => {
    const r = await interrupted(t, signal, { edit: (f, cmd) => { f.checks[0].command = cmd; } });
    assert.equal(r.sig, null, `run-frozen handled ${signal} itself`);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`interrupted by ${signal}`));
    assert.equal(fs.existsSync(r.marker), false, 'the frozen command did not outlive run-frozen.js');
    assert.equal(fs.existsSync(path.join(r.c.frozenRuns, 'check:CHECK-LINT.record.json')), false, 'no record for an interrupted run');
    assert.equal(r.stdout, '', 'nothing printed: no record line');
    const log = framed(fs.readFileSync(path.join(r.c.frozenRuns, 'check:CHECK-LINT.log'), 'utf8'));
    assert.equal(log.footer.interrupted, signal);
    assert.equal(log.footer.exit_code, null);
  });
}
test('an interrupted isolated suite also removes its worktree', async t => {
  const r = await interrupted(t, 'SIGTERM', { target: 'suite', edit: (f, cmd) => { f.suite.command = cmd; f.suite.isolated = true; } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(fs.existsSync(r.marker), false);
  assert.equal(fs.existsSync(path.join(r.c.frozenRuns, 'suite-wt')), false, 'the worktree is removed');
  assert.equal(r.c.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
});

test('negative: is refused for an exempt acceptance, without --patch, and --patch elsewhere', t => {
  const c = frozenRepo(t);
  assert.equal(c.runFrozen('negative:HELLO-001-AC2', { patch: c.patchFile('a', c.MUTATION) }).status, 1);
  assert.equal(c.runFrozen('negative:HELLO-001-AC1').status, 2);
  assert.equal(c.runFrozen('check:CHECK-LINT', { patch: c.patchFile('b', c.MUTATION) }).status, 2);
  assert.equal(c.runFrozen('check:CHECK-UI').status, 1, 'a not-applicable check never runs');
});

// --- script-stub.js ------------------------------------------------------------------------------------------
test('script-stub runs the gp-exec blocks of a prompt verbatim and replies with their real stdout and exit code (mocked boundary)', t => {
  const c = frozenRepo(t);
  const file = path.join(c.run, 'stub-record.json');
  const prompt = 'Run this block verbatim.\n```gp-exec\n' +
    `node ${path.join(require('./helpers/v2-repo.js').SCRIPTS, 'write-json.js')} --out ${file} <<'GP_JSON'\n{"a":1}\nGP_JSON\n` +
    '```\nThen this one.\n```gp-exec\n' +
    `node ${path.join(require('./helpers/v2-repo.js').SCRIPTS, 'run-frozen.js')} --repo ${c.repo} --frozen-dir ${c.frozenDir} --manifest-sha256 ${c.manifestSha} --reviewed-sha ${c.reviewedSha} --target check:CHECK-LINT --out-dir ${c.frozenRuns}\n` +
    '```\n```gp-exec setup\necho relay blocks are not deterministic steps\n```\n';
  assert.equal(gpExecBlocks(prompt).length, 2);
  const reply = scriptStep(null, { cwd: c.repo, env: c.env })(prompt, { label: 'x' }, []);
  assert.equal(reply.exit_code, 0);
  assert.match(reply.stdout, /"sha256"/);
  assert.match(reply.stdout, /check:CHECK-LINT\.record\.json/);
  assert.ok(fs.existsSync(file));
  const failing = runBlocks('```gp-exec\nexit 7\n```\n```gp-exec\necho never\n```', { cwd: c.repo, env: c.env });
  assert.equal(failing.exit_code, 7);
  assert.equal(failing.blocks.length, 1, 'stops at the first nonzero exit');
  assert.throws(() => runBlocks('a prompt with no deterministic block', { cwd: c.repo }), /gp-exec block/);
});
