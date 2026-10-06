#!/usr/bin/env node
'use strict';
// Stub codex executable for the offline test suite. Behavior is controlled by two
// env vars: FAKE_CODEX_SCENARIO selects a canned response, FAKE_CODEX_STATE is a
// directory the stub appends its invocation history to on every call. It tells a
// review call from a validation call by the schema file named with --output-schema.

const fs = require('fs');
const path = require('path');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function appendState(state, record) {
  if (!state) return;
  try { fs.mkdirSync(state, { recursive: true }); } catch { /* exists */ }
  const file = path.join(state, 'calls.jsonl');
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function writeOut(outPath, payload) {
  fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
}

function getFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  const scenario = process.env.FAKE_CODEX_SCENARIO || 'pass';
  const state = process.env.FAKE_CODEX_STATE || null;

  if (argv[0] === 'debug' && argv[1] === 'models') {
    appendState(state, { argv, stdin: '', call: 'debug-models' });
    if (scenario === 'catalog-fail') process.exit(1);
    const catalog = {
      models: [
        { slug: 'fake-model-old', description: 'Older generation model', priority: 5, visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }] },
        { slug: 'fake-model-best', description: 'Latest workhorse model for coding', priority: 1, visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }] },
        { slug: 'fake-model-hidden', description: 'Internal only', priority: 2, visibility: 'hidden', supported_reasoning_levels: [{ effort: 'high' }] },
      ],
    };
    process.stdout.write(JSON.stringify(catalog));
    process.exit(0);
  }

  const stdin = readStdin();
  const outPath = getFlag(argv, '-o');
  const schemaPath = getFlag(argv, '--output-schema') || '';
  const call = schemaPath.includes('validation') ? 'validate' : 'review';
  const callCountFile = state ? path.join(state, `${call}-count`) : null;
  let callIndex = 1;
  if (callCountFile) {
    try { callIndex = Number(fs.readFileSync(callCountFile, 'utf8')) + 1; } catch { callIndex = 1; }
    fs.writeFileSync(callCountFile, String(callIndex), 'utf8');
  }
  appendState(state, { argv, stdin, call, callIndex });

  const reviewFindings = (name) => {
    const sets = {
      pass: [],
      'one-major-low': [{ id: 'F1', severity: 'MAJOR', confidence: 0.6, category: 'correctness', iso_property: null, location: { file: null, line: null, section: null }, claim: 'x', evidence: 'y', suggested_fix: 'z' }],
      'blocking-and-major': [
        { id: 'F1', severity: 'BLOCKING', confidence: 0.9, category: 'security', iso_property: null, location: { file: 'a.js', line: 1, section: null }, claim: 'sql injection', evidence: 'concat', suggested_fix: 'parameterize' },
        { id: 'F2', severity: 'MAJOR', confidence: 0.9, category: 'correctness', iso_property: null, location: { file: 'a.js', line: 2, section: null }, claim: 'off by one', evidence: 'loop', suggested_fix: 'fix bound' },
      ],
      minor: [{ id: 'F1', severity: 'MINOR', confidence: 0.9, category: 'style', iso_property: null, location: { file: null, line: null, section: null }, claim: 'x', evidence: 'y', suggested_fix: 'z' }],
      'with-unknown-key': [{ id: 'F1', severity: 'MINOR', confidence: 0.9, category: 'style', iso_property: null, location: { file: null, line: null, section: null }, claim: 'x', evidence: 'y', suggested_fix: 'z', confirmed_by_reproduction: 'sneaky leftover field' }],
      special: [{ id: 'F1', severity: 'MAJOR', confidence: 0.9, category: 'template', iso_property: null, location: { file: null, line: null, section: 'rubric' }, claim: 'has $& and {{rubric}}', evidence: 'rubric text present', suggested_fix: 'none' }],
      'three-major-null-iso': [
        { id: 'F1', severity: 'MAJOR', confidence: 0.9, category: 'incomplete', iso_property: null, location: { file: null, line: null, section: 'R1' }, claim: 'gap one', evidence: 'text one', suggested_fix: 'fix one' },
        { id: 'F2', severity: 'MAJOR', confidence: 0.9, category: 'incomplete', iso_property: null, location: { file: null, line: null, section: 'R2' }, claim: 'gap two', evidence: 'text two', suggested_fix: 'fix two' },
        { id: 'F3', severity: 'MAJOR', confidence: 0.9, category: 'incomplete', iso_property: null, location: { file: null, line: null, section: 'R3' }, claim: 'gap three', evidence: 'text three', suggested_fix: 'fix three' },
      ],
    };
    return sets[name] || [];
  };

  if (scenario === 'timeout') {
    const sleepMs = 60000;
    const grandchild = require('child_process').spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${sleepMs})`], { detached: true, stdio: 'ignore' });
    if (state) fs.writeFileSync(path.join(state, 'timeout-child-pid'), String(grandchild.pid), 'utf8');
    grandchild.unref();
    setTimeout(() => {}, sleepMs);
    return;
  }

  if (scenario === 'refuse-then-ok') {
    if (callIndex === 1) { process.stderr.write("I can't help with that request, flagged for possible cybersecurity risk.\n"); process.exit(1); }
    writeOut(outPath, call === 'validate' ? { results: [] } : { verdict: 'PASS', summary: 'ok', unable_to_review: null, findings: reviewFindings('pass') });
    process.exit(0);
  }

  if (scenario === 'refuse-twice') {
    process.stderr.write("I can't assist with that.\n");
    process.exit(1);
  }

  if (scenario === 'empty-output') { fs.writeFileSync(outPath, '', 'utf8'); process.exit(0); }
  if (scenario === 'invalid-json') { fs.writeFileSync(outPath, '{not json', 'utf8'); process.exit(0); }
  if (scenario === 'null-output') { fs.writeFileSync(outPath, 'null', 'utf8'); process.exit(0); }
  if (scenario === 'bad-findings-shape') { fs.writeFileSync(outPath, JSON.stringify({ findings: 'x' }), 'utf8'); process.exit(0); }
  if (scenario === 'nonzero-exit') { writeOut(outPath, { verdict: 'PASS', summary: 'ok', unable_to_review: null, findings: [] }); process.exit(7); }

  if (scenario === 'validation-confirm-refute') {
    if (call === 'review') {
      writeOut(outPath, { verdict: 'FAIL', summary: 'two issues', unable_to_review: null, findings: reviewFindings('blocking-and-major') });
    } else {
      writeOut(outPath, { results: [{ id: 'F1', status: 'REFUTED', evidence: 'not present' }, { id: 'F2', status: 'CONFIRMED', evidence: 'present' }] });
    }
    process.exit(0);
  }

  if (scenario === 'validation-both-refuted') {
    if (call === 'review') writeOut(outPath, { verdict: 'FAIL', summary: 'two issues', unable_to_review: null, findings: reviewFindings('blocking-and-major') });
    else writeOut(outPath, { results: [{ id: 'F1', status: 'REFUTED', evidence: 'n/a' }, { id: 'F2', status: 'REFUTED', evidence: 'n/a' }] });
    process.exit(0);
  }

  if (scenario === 'validation-missing-id') {
    if (call === 'review') writeOut(outPath, { verdict: 'FAIL', summary: 'two issues', unable_to_review: null, findings: reviewFindings('blocking-and-major') });
    else writeOut(outPath, { results: [{ id: 'F1', status: 'REFUTED', evidence: 'n/a' }] });
    process.exit(0);
  }

  if (scenario === 'validation-timeout') {
    if (call === 'review') { writeOut(outPath, { verdict: 'FAIL', summary: 'two issues', unable_to_review: null, findings: reviewFindings('blocking-and-major') }); process.exit(0); }
    setTimeout(() => {}, 60000);
    return;
  }

  if (scenario === 'three-major-one-refuted') {
    if (call === 'review') {
      // Pre-validation the model sees 3 MAJORs, so its own opinion matches the naive
      // (pre-validation) rule: FAIL. One of the three gets refuted below, so the
      // *counted* MAJOR total drops to 2 and the real verdict must be PASS.
      writeOut(outPath, { verdict: 'FAIL', summary: 'three gaps', unable_to_review: null, findings: reviewFindings('three-major-null-iso') });
    } else {
      writeOut(outPath, { results: [{ id: 'F1', status: 'REFUTED', evidence: 'not present' }, { id: 'F2', status: 'CONFIRMED', evidence: 'present' }, { id: 'F3', status: 'CONFIRMED', evidence: 'present' }] });
    }
    process.exit(0);
  }

  if (scenario === 'minor-only-no-validation') {
    writeOut(outPath, { verdict: 'PASS', summary: 'fine', unable_to_review: null, findings: reviewFindings('minor') });
    process.exit(0);
  }

  if (scenario === 'review-unknown-keys') {
    // additionalProperties:false in review.schema.json would stop a real Codex call from
    // emitting this, but the runner must not rely on that alone (section 2.6).
    writeOut(outPath, { verdict: 'PASS', summary: 'fine', unable_to_review: null, findings: reviewFindings('with-unknown-key') });
    process.exit(0);
  }

  if (scenario === 'validation-duplicate-id') {
    if (call === 'review') writeOut(outPath, { verdict: 'FAIL', summary: 'two issues', unable_to_review: null, findings: reviewFindings('blocking-and-major') });
    else writeOut(outPath, { results: [{ id: 'F1', status: 'CONFIRMED', evidence: 'first' }, { id: 'F1', status: 'REFUTED', evidence: 'second, same id' }, { id: 'F2', status: 'CONFIRMED', evidence: 'present' }] });
    process.exit(0);
  }

  if (scenario === 'validation-bad-status') {
    if (call === 'review') writeOut(outPath, { verdict: 'FAIL', summary: 'two issues', unable_to_review: null, findings: reviewFindings('blocking-and-major') });
    else writeOut(outPath, { results: [{ id: 'F1', status: 'MAYBE', evidence: 'not a real enum value' }, { id: 'F2', status: 'CONFIRMED', evidence: 'present' }] });
    process.exit(0);
  }

  if (scenario === 'runner-owned-fields') {
    writeOut(outPath, { verdict: 'PASS', summary: 'ok', unable_to_review: null, model: 'x', effort: 'y', findings: [] });
    process.exit(0);
  }

  if (scenario === 'special-chars') {
    if (call === 'validate') writeOut(outPath, { results: [{ id: 'F1', status: 'CONFIRMED', evidence: 'rubric text present' }] });
    else writeOut(outPath, { verdict: 'FAIL', summary: 'ok', unable_to_review: null, findings: reviewFindings('special') });
    process.exit(0);
  }

  if (scenario === 'one-major-low') {
    writeOut(outPath, { verdict: 'NEEDS_HUMAN', summary: 'uncertain', unable_to_review: null, findings: reviewFindings('one-major-low') });
    process.exit(0);
  }

  writeOut(outPath, { verdict: 'PASS', summary: 'clean', unable_to_review: null, findings: [] });
  process.exit(0);
}

main();
