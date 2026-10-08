#!/usr/bin/env node
'use strict';

// Restores codex's own compliance evidence into verify-result.json before the completion gate reads it.
// The agent that relays the compliance trace can flatten requirements[].evidence to summary strings or
// re-escape quotes in a copied command; check-completion.js needs the records codex itself wrote.
// It copies the requirements verbatim from compliance.json, then:
//   - a runtime record whose command is not the frozen proof_command takes the command from the acceptance
//     ledger, but only when id, log_path, log_sha256 and exit_code all match the ledger record;
//   - a static record with an absolute path inside the compliance checkout becomes repo-relative;
//   - any other runtime record off the frozen command, or static record outside the repo, is left out.
// Everything left out stays in compliance.json and is listed in the compliance note.
// It never changes a verdict: it refuses unless codex said PASS with no findings and every ID passed.
// usage: merge-compliance.js --verify-result F --compliance F --manifest F [--ledger F] [--checkout DIR]
// exit: 0 merged | 1 refused (the reason is printed) | 2 usage error
const fs = require('node:fs');
const path = require('node:path');

const FLAGS = ['verify-result', 'compliance', 'manifest', 'ledger', 'checkout'];
const REQUIRED = FLAGS.slice(0, 3);
function ensure(ok, reason) { if (!ok) throw new Error(reason); }
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Codex writes Windows paths in either slash style and case; compare by form, not by spelling.
const isWindows = p => /^[A-Za-z]:/.test(p) || p.includes('\\');
const pathForm = p => (isWindows(p) ? path.win32 : path.posix).normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
const pathKey = p => (isWindows(p) ? pathForm(p).toLowerCase() : pathForm(p));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!FLAGS.includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(args, flag)) return null;
    args[flag] = argv[i + 1];
  }
  return REQUIRED.every(f => args[f]) ? args : null;
}

// The acceptance ledger holds per-ID records ({id, status, evidence}), as a bare list or under `records`.
// Any other shape is reported in the note and disables command repair; it is never read as empty.
function ledgerIndex(file, notes) {
  const index = new Map();
  if (!file) return index;
  if (!fs.existsSync(file)) { notes.push(['-', 'acceptance ledger not found; no command repair', file]); return index; }
  const data = readJson(file);
  const records = Array.isArray(data) ? data : Array.isArray(data && data.records) ? data.records : null;
  if (!records) { notes.push(['-', 'acceptance ledger shape not recognized; no command repair', file]); return index; }
  for (const rec of records) {
    for (const e of [].concat(rec.evidence || [])) index.set(JSON.stringify([rec.id, e.log_path, e.log_sha256]), e);
  }
  return index;
}

function merge(args) {
  const vr = readJson(args['verify-result']);
  const cj = readJson(args.compliance);
  const frozen = new Map(readJson(args.manifest).requirements.map(r => [r.id, r.proof_command || '']));
  const notes = [];
  const ledger = ledgerIndex(args.ledger, notes);
  const checkout = args.checkout || null;

  ensure(vr.compliance && Array.isArray(vr.compliance.requirements), 'verify result has no compliance requirements');
  ensure(cj.verdict === 'PASS' && !(cj.findings || []).length, 'codex compliance is not PASS with zero findings');
  ensure(cj.requirements.every(r => r.status === 'PASS'), 'a codex requirement is not PASS');
  // Same IDs, each once; the order may differ.
  const ids = (list, label) => {
    const out = list.map(r => r.id);
    ensure(new Set(out).size === out.length, 'duplicate requirement ID in ' + label);
    return JSON.stringify([...out].sort());
  };
  ensure(ids(vr.compliance.requirements, 'the verify result') === ids(cj.requirements, 'compliance.json'),
    'requirement IDs differ between verify result and compliance.json');

  const requirements = cj.requirements.map(r => {
    ensure(frozen.has(r.id), 'requirement not in the frozen manifest: ' + r.id);
    const keep = [];
    for (let e of [].concat(r.evidence || [])) {
      ensure(e && typeof e === 'object', r.id + ' evidence in compliance.json is not a record');
      if (e.kind === 'runtime' && e.command !== frozen.get(r.id)) {
        const src = ledger.get(JSON.stringify([r.id, e.log_path, e.log_sha256]));
        // Borrow only from the same run: same log, exit code and reviewed commit on both records.
        const sameRun = src && src.exit_code === e.exit_code && vr.reviewed_sha &&
          src.head_sha === vr.reviewed_sha && e.head_sha === vr.reviewed_sha;
        if (sameRun && src.command === frozen.get(r.id)) {
          notes.push([r.id, 'runtime command taken from the acceptance ledger', e.command]);
          e = { ...e, command: src.command };
        } else {
          notes.push([r.id, 'left out: runtime command is not the frozen proof_command', e.command]);
          continue;
        }
      }
      if (e.kind === 'static' && typeof e.file === 'string' && (path.isAbsolute(e.file) || /^[A-Za-z]:/.test(e.file))) {
        // Match on the case-folded key, but keep the file's own spelling for the repo-relative part.
        const root = checkout && pathForm(checkout) + '/';
        if (root && pathKey(e.file).startsWith(pathKey(checkout) + '/')) {
          notes.push([r.id, 'static path made repo-relative', e.file]);
          e = { ...e, file: pathForm(e.file).slice(root.length) };
        } else {
          notes.push([r.id, 'left out: static path outside the repo', e.file]);
          continue;
        }
      } else if (e.kind === 'static' && typeof e.file === 'string') {
        // A repo-relative path in Windows spelling (src\a.py) or with ./ segments, in the validator's form.
        const rel = path.posix.normalize(e.file.replace(/\\/g, '/'));
        if (rel.split('/').some(part => !part || part === '.' || part === '..')) {
          notes.push([r.id, 'left out: static path leaves the repo', e.file]);
          continue;
        }
        if (rel !== e.file) {
          notes.push([r.id, 'static path normalized', e.file]);
          e = { ...e, file: rel };
        }
      }
      keep.push(e);
    }
    ensure(keep.length, r.id + ' would have no evidence left');
    return { ...r, evidence: keep };
  });

  const vrPath = args['verify-result'];
  const relay = vrPath.replace(/\.json$/, '') + '.relay.json';
  if (!fs.existsSync(relay)) fs.copyFileSync(vrPath, relay);
  vr.compliance.requirements = requirements;
  vr.compliance.note = (vr.compliance.note || '') + ' [merge-compliance: requirements copied from ' + args.compliance +
    '; relay copy kept at ' + relay + '; changes: ' + JSON.stringify(notes) + ']';
  fs.writeFileSync(vrPath + '.tmp', JSON.stringify(vr));
  fs.renameSync(vrPath + '.tmp', vrPath);
  return { requirements: requirements.length, notes };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: merge-compliance.js --verify-result F --compliance F --manifest F [--ledger F] [--checkout DIR]');
    process.exit(2);
  }
  try {
    const out = merge(args);
    console.log(`MERGED requirements=${out.requirements} changes=${out.notes.length}`);
    for (const n of out.notes) console.log('  ' + JSON.stringify(n));
  } catch (e) {
    console.log('REFUSED ' + e.message);
    process.exit(1);
  }
}

module.exports = { merge };
