#!/usr/bin/env node
'use strict';

// Deterministic gates of the v2 canonical feature file (docs/v2-design.md section 3).
// usage: validate-feature.js --file <feature.json> --repo-path <repo-relative path of the file>
//          [--schema <feature.schema.json>] [--source-request <file> [--source-mode text|ref]] [--previous <feature.json>]
// Prints one JSON object { valid, validator_version, schema_version, source_sha256, errors: [ { code, rule, path,
// id, message } ] } with errors sorted by (path, code, rule); exit 0 valid, 1 invalid, 2 usage/setup error
// (the reason goes to stderr and nothing to stdout).
// Order: 1. parse (strict-json), 2. version (schema_version must be 2; nothing else is reported otherwise),
// 3. schema (schema-lite against --schema), 4. graph rules G01-G40, 5. --source-request rules R01-R04,
// 6. --previous rules P01-P02. Steps 4-6 run only on a schema-valid file, because they rely on its shape.
// --previous must itself parse, carry schema_version 2 and pass the schema, else exit 2.
// The source request file must be valid UTF-8 (both modes), else exit 2.
// It never executes, evaluates or shells out any string from the file: proof commands are data.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parse, StrictJsonError } = require('./lib/strict-json.js');
const { compile, SchemaSetupError } = require('./lib/schema-lite.js');
const { graphRules, sourceRules, previousRules } = require('./lib/feature-graph.js');

const VALIDATOR_VERSION = '1.1.0';
const SCHEMA_VERSION = 2;
const DEFAULT_SCHEMA = path.resolve(__dirname, '../schemas/feature.schema.json');
const FLAGS = ['file', 'repo-path', 'schema', 'source-request', 'source-mode', 'previous'];

class SetupError extends Error {}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!FLAGS.includes(flag)) throw new SetupError(`unknown argument ${JSON.stringify(argv[i])}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new SetupError(`--${flag} needs a value`);
    if (Object.hasOwn(args, flag)) throw new SetupError(`--${flag} given twice`);
    args[flag] = argv[i + 1];
  }
  if (!args.file || !args['repo-path']) throw new SetupError('--file and --repo-path are required');
  if (args['source-mode'] !== undefined && args['source-request'] === undefined) throw new SetupError('--source-mode needs --source-request');
  if (args['source-mode'] !== undefined && !['text', 'ref'].includes(args['source-mode'])) throw new SetupError('--source-mode must be text or ref');
  return args;
}

function readBytes(file, what) {
  try { return fs.readFileSync(file); } catch (e) { throw new SetupError(`cannot read ${what} ${file}: ${e.code || e.message}`); }
}

function loadSchema(file) {
  let schema;
  try { schema = parse(readBytes(file, 'schema')).value; } catch (e) {
    if (e instanceof StrictJsonError) throw new SetupError(`schema ${file}: ${e.code} at "${e.path}": ${e.message}`);
    throw e;
  }
  try { return compile(schema); } catch (e) {
    if (e instanceof SchemaSetupError) throw new SetupError(e.message);
    throw e;
  }
}

// The id of the innermost object on the pointer path that carries a string id.
function idAt(root, pointer) {
  let node = root, id = null;
  const parts = pointer === '' ? [] : pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const part of [null, ...parts]) {
    if (part !== null) {
      if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) break;
      node = node[part];
    }
    if (isObject(node) && typeof node.id === 'string') id = node.id;
  }
  return id;
}

// Steps 1-3 for one file; returns { value, errors } where errors are parse, version or schema diagnostics.
function shapeCheck(bytes, validateSchema) {
  let value;
  try { value = parse(bytes).value; } catch (e) {
    if (!(e instanceof StrictJsonError)) throw e;
    return { value: null, errors: [{ code: e.code, rule: null, path: e.path, id: null, message: e.offset === null ? e.message : `${e.message} (offset ${e.offset})` }] };
  }
  if (!isObject(value)) return { value, errors: [{ code: 'E_SCHEMA_VERSION', rule: null, path: '', id: null, message: 'the file must be a JSON object with schema_version 2' }] };
  if (value.schema_version !== SCHEMA_VERSION) {
    return { value, errors: [{ code: 'E_SCHEMA_VERSION', rule: null, path: '/schema_version', id: null, message: `schema_version must be ${SCHEMA_VERSION}, got ${JSON.stringify(value.schema_version)}` }] };
  }
  const errors = validateSchema(value).map(e => ({ code: e.code, rule: null, path: e.path, id: idAt(value, e.path), message: e.message }));
  return { value, errors };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function sortErrors(errors) {
  const seen = new Set();
  return errors
    .filter(e => { const k = JSON.stringify([e.code, e.rule, e.path, e.id, e.message]); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code) || cmp(a.rule || '', b.rule || '') || cmp(a.id || '', b.id || '') || cmp(a.message, b.message));
}

// Library entry point (also used by later scripts): returns the printed object.
function validateFeature({ bytes, repoPath, validateSchema, request = null, previous = null }) {
  const { value, errors } = shapeCheck(bytes, validateSchema);
  if (!errors.length) {
    errors.push(...graphRules(value, { repoPath }));
    if (request) errors.push(...sourceRules(value, request));
    if (previous) errors.push(...previousRules(value, previous));
  }
  const sorted = sortErrors(errors);
  return { valid: sorted.length === 0, validator_version: VALIDATOR_VERSION, schema_version: SCHEMA_VERSION, source_sha256: sha256(bytes), errors: sorted };
}

function loadInputs(args) {
  const validateSchema = loadSchema(args.schema || DEFAULT_SCHEMA);
  const bytes = readBytes(args.file, 'file');
  let request = null;
  if (args['source-request'] !== undefined) {
    const requestBytes = readBytes(args['source-request'], 'source request');
    let requestText;
    try { requestText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(requestBytes); } catch {
      throw new SetupError(`source request ${args['source-request']} is not valid UTF-8`);
    }
    request = { requestBytes, requestText, mode: args['source-mode'] || 'text' };
  }
  let previous = null;
  if (args.previous !== undefined) {
    const shaped = shapeCheck(readBytes(args.previous, 'previous revision'), validateSchema);
    if (shaped.errors.length) {
      const e = shaped.errors[0];
      throw new SetupError(`--previous ${args.previous} is not a schema-valid revision: ${e.code} at "${e.path}": ${e.message}`);
    }
    previous = shaped.value;
  }
  return { bytes, repoPath: args['repo-path'], validateSchema, request, previous };
}

function main(argv) {
  let inputs;
  try { inputs = loadInputs(parseArgs(argv)); } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    process.stderr.write(`validate-feature: ${e.message}\n`);
    return 2;
  }
  const result = validateFeature(inputs);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.valid ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateFeature, loadSchema, shapeCheck, VALIDATOR_VERSION, SCHEMA_VERSION, DEFAULT_SCHEMA };
