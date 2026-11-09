#!/usr/bin/env node
'use strict';

// schema-lite against the official JSON-Schema-Test-Suite (draft2020-12), vendored unmodified at a pinned
// upstream commit under tests/vendor/json-schema-test-suite/ (see SOURCE.json and LICENSE there).
// The suite files are loaded with JSON.parse, not strict-json. Every case falls in exactly one class, decided
// by the classifier below from the plan's WP1 subset list (independently of schema-lite's own code):
//   evaluated        - only subset keywords, each in a supported value form: schema-lite must give the suite's
//                      `valid` for every test of the case;
//   other-keyword    - a keyword outside the subset: compiling must be a setup error;
//   unsupported-form - only subset keywords, but one in an unsupported value form (a boolean schema,
//                      `items: false`, `additionalProperties` with a schema, a remote or non-`#/$defs` `$ref`,
//                      `$id`/`$schema`/`$defs` below the root): compiling must be a setup error.
// It prints per-file counts of the three classes and asserts the floor: at least 80% of the tests in the core
// keyword files are in the evaluated class.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { compile } = require('../scripts/lib/schema-lite.js');

const VENDOR = path.join(__dirname, 'vendor/json-schema-test-suite');
const SOURCE = JSON.parse(fs.readFileSync(path.join(VENDOR, 'SOURCE.json'), 'utf8'));
const FILES = ['type', 'enum', 'const', 'pattern', 'minLength', 'minItems', 'minimum', 'maximum', 'required',
  'properties', 'additionalProperties', 'items', 'ref', 'defs'];
const CORE = FILES.slice(0, 9);
const META = 'https://json-schema.org/draft/2020-12/schema';
const TYPES = ['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'];
const SUBSET = ['type', 'enum', 'const', 'pattern', 'minLength', 'minItems', 'minimum', 'maximum', 'required',
  'properties', 'additionalProperties', 'items', '$ref', '$defs', '$schema', '$id', 'title', 'description'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonNegInt = v => typeof v === 'number' && Number.isInteger(v) && v >= 0;
function defName(ref) {
  const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return null; }
}

function classify(rootSchema) {
  let other = false, form = false;
  const visit = (s, isRoot) => {
    if (!isObj(s)) { form = true; return; }
    for (const [k, v] of Object.entries(s)) {
      if (!SUBSET.includes(k)) { other = true; continue; }
      switch (k) {
        case 'type': {
          const list = Array.isArray(v) ? v : [v];
          if (!list.length || !list.every(t => TYPES.includes(t)) || new Set(list).size !== list.length) form = true;
          break;
        }
        case 'enum': if (!Array.isArray(v) || !v.length) form = true; break;
        case 'const': break;
        case 'pattern': try { new RegExp(v, 'u'); if (typeof v !== 'string') form = true; } catch { form = true; } break;
        case 'minLength': case 'minItems': if (!nonNegInt(v)) form = true; break;
        case 'minimum': case 'maximum': if (typeof v !== 'number' || !Number.isFinite(v)) form = true; break;
        case 'required': if (!Array.isArray(v) || !v.every(x => typeof x === 'string') || new Set(v).size !== v.length) form = true; break;
        case 'properties': if (!isObj(v)) form = true; else for (const sub of Object.values(v)) visit(sub, false); break;
        case 'additionalProperties': if (v !== false) form = true; break;
        case 'items': if (!isObj(v)) form = true; else visit(v, false); break;
        case '$ref': {
          const name = typeof v === 'string' ? defName(v) : null;
          if (name === null || !isObj(rootSchema.$defs) || !Object.hasOwn(rootSchema.$defs, name)) form = true;
          break;
        }
        case '$defs': if (!isRoot || !isObj(v)) form = true; else for (const sub of Object.values(v)) visit(sub, false); break;
        case '$schema': if (!isRoot || v !== META) form = true; break;
        case '$id': if (!isRoot || typeof v !== 'string') form = true; break;
        case 'title': case 'description': if (typeof v !== 'string') form = true; break;
      }
    }
  };
  visit(rootSchema, true);
  return other ? 'other-keyword' : form ? 'unsupported-form' : 'evaluated';
}

const setupError = schema => { try { compile(schema); } catch (e) { return e; } return null; };

test('vendored suite files are the recorded upstream bytes', () => {
  assert.match(SOURCE.commit, /^[0-9a-f]{40}$/);
  for (const [rel, hash] of Object.entries(SOURCE.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR, rel))).digest('hex'), hash, rel);
  }
  for (const f of FILES) assert.ok(Object.hasOwn(SOURCE.files, `tests/draft2020-12/${f}.json`), f);
});

test('JSON-Schema-Test-Suite draft2020-12 conformance of the schema-lite subset', t => {
  const totals = { evaluated: 0, 'other-keyword': 0, 'unsupported-form': 0 };
  const core = { evaluated: 0, all: 0 };
  const failures = [];
  for (const file of FILES) {
    const groups = JSON.parse(fs.readFileSync(path.join(VENDOR, 'tests/draft2020-12', file + '.json'), 'utf8'));
    const counts = { evaluated: 0, 'other-keyword': 0, 'unsupported-form': 0 };
    for (const group of groups) {
      const cls = classify(group.schema);
      counts[cls] += group.tests.length;
      if (CORE.includes(file)) { core.all += group.tests.length; if (cls === 'evaluated') core.evaluated += group.tests.length; }
      if (cls === 'evaluated') {
        let validate;
        try { validate = compile(group.schema); } catch (e) { failures.push(`${file}: "${group.description}": compile failed: ${e.message}`); continue; }
        for (const tc of group.tests) {
          const errors = validate(tc.data);
          if ((errors.length === 0) !== tc.valid) failures.push(`${file}: "${group.description}" / "${tc.description}": expected valid=${tc.valid}, got ${JSON.stringify(errors)}`);
        }
      } else {
        const e = setupError(group.schema);
        if (!e || e.code !== 'E_SCHEMA_SETUP') failures.push(`${file}: "${group.description}" (${cls}): expected a setup error, got ${e ? e.message : 'none'}`);
      }
    }
    for (const k of Object.keys(totals)) totals[k] += counts[k];
    t.diagnostic(`${file}: evaluated ${counts.evaluated}, other-keyword ${counts['other-keyword']}, unsupported-form ${counts['unsupported-form']} (tests)`);
  }
  t.diagnostic(`total: evaluated ${totals.evaluated}, other-keyword ${totals['other-keyword']}, unsupported-form ${totals['unsupported-form']}`);
  t.diagnostic(`core files evaluated: ${core.evaluated}/${core.all} = ${(100 * core.evaluated / core.all).toFixed(1)}%`);
  assert.deepEqual(failures, []);
  assert.ok(core.evaluated / core.all >= 0.8, `floor: ${core.evaluated}/${core.all} core tests evaluated`);
});

// Hand-written cases for the subset's edges (not from the suite).
test('schema-lite setup errors for keywords outside the subset and unsupported value forms', () => {
  const bad = [
    true, false, { maxLength: 3 }, { allOf: [] }, { if: {} }, { format: 'email' }, { $comment: 'x' }, { default: 1 },
    { items: false }, { items: true }, { items: [{}] }, { additionalProperties: {} }, { additionalProperties: true },
    { properties: { a: true } }, { $ref: 'https://example.com/x.json' }, { $ref: '#' }, { $ref: '#/properties/a' },
    { $ref: '#/$defs/missing', $defs: {} }, { $ref: '#/$defs/a/b', $defs: { a: { $defs: { b: {} } } } },
    { properties: { a: { $id: 'x' } } }, { properties: { a: { $schema: META } } }, { $schema: 'http://json-schema.org/draft-07/schema#' },
    { properties: { a: { $defs: {} } } }, { type: 'float' }, { type: [] }, { type: ['string', 'string'] }, { pattern: '(' },
    { pattern: 5 }, { minLength: -1 }, { minLength: 1.5 }, { minimum: '1' }, { required: 'a' }, { required: ['a', 'a'] },
    { enum: [] }, { enum: 'a' }, { title: 5 }, { $defs: { a: { $ref: '#/$defs/a' } } },
  ];
  for (const schema of bad) {
    const e = setupError(schema);
    assert.ok(e, `expected a setup error for ${JSON.stringify(schema)}`);
    assert.equal(e.code, 'E_SCHEMA_SETUP', JSON.stringify(schema));
  }
});

test('schema-lite reports one code per keyword at the instance path', () => {
  const schema = {
    $schema: META, $id: 'urn:example:test', title: 't', description: 'd', type: 'object', additionalProperties: false,
    required: ['s', 'n', 'a', 'e', 'c', 'missing'],
    properties: {
      s: { type: 'string', minLength: 3, pattern: '^[a-z]+$' }, n: { type: 'integer', minimum: 1, maximum: 5 },
      a: { type: 'array', minItems: 2, items: { $ref: '#/$defs/item' } }, e: { enum: ['x', 'y'] }, c: { const: 0 },
      missing: {}, u: { type: ['string', 'null'] },
    },
    $defs: { item: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } } },
  };
  const validate = compile(schema);
  const codes = errors => errors.map(e => `${e.code} ${e.path}`).sort();
  assert.deepEqual(validate({ s: 'abc', n: 2, a: [{ id: 'x' }, { id: 'y' }], e: 'x', c: 0, missing: 1, u: null }), []);
  assert.deepEqual(codes(validate({ s: 'A', n: 9.5, a: [{ id: 1, z: 0 }], e: 'q', c: 1, u: 3, extra: 1 })), [
    'E_CONST /c', 'E_ENUM /e', 'E_MAXIMUM /n', 'E_MIN_ITEMS /a', 'E_MIN_LENGTH /s', 'E_PATTERN /s', 'E_REQUIRED /missing',
    'E_TYPE /a/0/id', 'E_TYPE /n', 'E_TYPE /u', 'E_UNKNOWN_FIELD /a/0/z', 'E_UNKNOWN_FIELD /extra',
  ].sort());
  assert.deepEqual(codes(validate({ s: 'abc', n: 0, a: [{ id: 'x' }, { id: 'y' }], e: 'y', c: 0, missing: null })), ['E_MINIMUM /n']);
  assert.deepEqual(codes(validate([])), ['E_TYPE ']);
  // type integer accepts 1.0 (2020-12); minLength counts code points; pattern is unanchored unless the schema anchors it.
  assert.deepEqual(compile({ type: 'integer' })(1.0), []);
  assert.deepEqual(compile({ minLength: 2 })('\u{1F600}'), [{ code: 'E_MIN_LENGTH', path: '', message: compile({ minLength: 2 })('\u{1F600}')[0].message }]);
  assert.deepEqual(compile({ pattern: 'b' })('abc'), []);
  // Property names that are Object.prototype members are ordinary names.
  const p = compile({ type: 'object', required: ['constructor'], properties: { ['__proto__']: { type: 'number' } } });
  assert.equal(p(JSON.parse('{"__proto__": "x", "constructor": 1}')).length, 1);
  assert.equal(p(Object.create(null)).length, 1);
});
