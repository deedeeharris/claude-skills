'use strict';

// A fixed JSON Schema 2020-12 keyword subset with exactly the 2020-12 meaning (docs/v2-design.md section 2,
// plan WP1). compile(schema) -> validate(instance) -> [ { code, path, message } ] (empty = valid).
//
// Supported, and nothing else: type (a name or an array of unique names), enum (a nonempty array), const,
// pattern (an unanchored ECMA-262 match, compiled once with the u flag), minLength (code points), minItems,
// minimum, maximum, required, properties, additionalProperties (only `false`), items (a schema object),
// $ref (only "#/$defs/<name>", percent- and ~-decoded, naming a root $defs entry), $defs (root only),
// $schema (root only, the 2020-12 meta-schema URI), $id (root only; never used for resolution), title and
// description (strings). Any other keyword, or a supported keyword in another value form (a boolean schema
// anywhere, `items: false`, `additionalProperties` with a schema, a remote, root or non-$defs $ref, $id,
// $schema or $defs below the root, a $ref cycle that consumes no instance), throws a SchemaSetupError with
// code E_SCHEMA_SETUP, so a schema can never silently loosen the contract.
//
// Error codes: type E_TYPE, enum E_ENUM, const E_CONST, pattern E_PATTERN, minLength E_MIN_LENGTH,
// minItems E_MIN_ITEMS, minimum E_MINIMUM, maximum E_MAXIMUM, required E_REQUIRED (path of the missing
// property), additionalProperties E_UNKNOWN_FIELD (path of the extra property). Paths are JSON Pointers.
// Instances may be plain objects or Object.create(null) objects (strict-json output).

const META_SCHEMA = 'https://json-schema.org/draft/2020-12/schema';
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);
const KEYWORDS = new Set(['type', 'enum', 'const', 'pattern', 'minLength', 'minItems', 'minimum', 'maximum',
  'required', 'properties', 'additionalProperties', 'items', '$ref', '$defs', '$schema', '$id', 'title', 'description']);

class SchemaSetupError extends Error {
  constructor(where, message) {
    super(`schema ${where || '#'}: ${message}`);
    this.name = 'SchemaSetupError';
    this.code = 'E_SCHEMA_SETUP';
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = v => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const tok = s => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // boolean, string, object
}
const matchesType = (v, t) => { const k = typeOf(v); return k === t || (t === 'number' && k === 'integer'); };

function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => has(b, k) && equal(a[k], b[k]));
}

function decodeDefRef(ref) {
  const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[1]); } catch { return null; }
  return name.replace(/~1/g, '/').replace(/~0/g, '~');
}

function compile(root) {
  if (!isObject(root)) throw new SchemaSetupError('#', 'the root schema must be an object (boolean schemas are not supported)');
  const defs = new Map();
  const pendingRefs = [];

  function build(s, where, isRoot) {
    if (!isObject(s)) throw new SchemaSetupError(where, 'a schema must be an object (boolean schemas are not supported)');
    const node = { checks: [], props: null, closed: false, items: null, ref: null, where };
    for (const k of Object.keys(s)) {
      if (!KEYWORDS.has(k)) throw new SchemaSetupError(where, `unsupported keyword "${k}"`);
    }
    if (has(s, '$schema') && (!isRoot || s.$schema !== META_SCHEMA)) throw new SchemaSetupError(where, `$schema must be "${META_SCHEMA}" and only at the root`);
    if (has(s, '$id') && (!isRoot || typeof s.$id !== 'string')) throw new SchemaSetupError(where, '$id is supported only as a string at the root (no $id-relative resolution)');
    if (has(s, '$defs') && (!isRoot || !isObject(s.$defs))) throw new SchemaSetupError(where, '$defs is supported only as an object at the root');
    for (const k of ['title', 'description']) if (has(s, k) && typeof s[k] !== 'string') throw new SchemaSetupError(where, `${k} must be a string`);

    if (has(s, 'type')) {
      const list = Array.isArray(s.type) ? s.type : [s.type];
      if (!list.length || !list.every(t => typeof t === 'string' && TYPES.has(t)) || new Set(list).size !== list.length) {
        throw new SchemaSetupError(where, 'type must be a type name or a nonempty array of unique type names');
      }
      node.checks.push((v, p, out) => { if (!list.some(t => matchesType(v, t))) out.push({ code: 'E_TYPE', path: p, message: `expected ${list.join(' or ')}, got ${typeOf(v)}` }); });
    }
    if (has(s, 'enum')) {
      if (!Array.isArray(s.enum) || !s.enum.length) throw new SchemaSetupError(where, 'enum must be a nonempty array');
      const values = s.enum;
      node.checks.push((v, p, out) => { if (!values.some(e => equal(e, v))) out.push({ code: 'E_ENUM', path: p, message: `must be one of ${JSON.stringify(values)}` }); });
    }
    if (has(s, 'const')) {
      const c = s.const;
      node.checks.push((v, p, out) => { if (!equal(c, v)) out.push({ code: 'E_CONST', path: p, message: `must equal ${JSON.stringify(c)}` }); });
    }
    if (has(s, 'pattern')) {
      if (typeof s.pattern !== 'string') throw new SchemaSetupError(where, 'pattern must be a string');
      let re;
      try { re = new RegExp(s.pattern, 'u'); } catch (e) { throw new SchemaSetupError(where, `pattern does not compile: ${e.message}`); }
      const src = s.pattern;
      node.checks.push((v, p, out) => { if (typeof v === 'string' && !re.test(v)) out.push({ code: 'E_PATTERN', path: p, message: `does not match ${src}` }); });
    }
    for (const [k, code, applies, size] of [
      ['minLength', 'E_MIN_LENGTH', v => typeof v === 'string', v => [...v].length],
      ['minItems', 'E_MIN_ITEMS', v => Array.isArray(v), v => v.length],
    ]) {
      if (!has(s, k)) continue;
      if (!isNonNegInt(s[k])) throw new SchemaSetupError(where, `${k} must be a non-negative integer`);
      const n = s[k];
      node.checks.push((v, p, out) => { if (applies(v) && size(v) < n) out.push({ code, path: p, message: `${k} ${n}` }); });
    }
    for (const [k, code, bad] of [['minimum', 'E_MINIMUM', (v, n) => v < n], ['maximum', 'E_MAXIMUM', (v, n) => v > n]]) {
      if (!has(s, k)) continue;
      if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) throw new SchemaSetupError(where, `${k} must be a number`);
      const n = s[k];
      node.checks.push((v, p, out) => { if (typeof v === 'number' && bad(v, n)) out.push({ code, path: p, message: `${k} ${n}` }); });
    }
    if (has(s, 'required')) {
      const req = s.required;
      if (!Array.isArray(req) || !req.every(x => typeof x === 'string') || new Set(req).size !== req.length) {
        throw new SchemaSetupError(where, 'required must be an array of unique strings');
      }
      node.checks.push((v, p, out) => {
        if (!isObject(v)) return;
        for (const k of req) if (!has(v, k)) out.push({ code: 'E_REQUIRED', path: `${p}/${tok(k)}`, message: `missing required property "${k}"` });
      });
    }
    if (has(s, 'properties')) {
      if (!isObject(s.properties)) throw new SchemaSetupError(where, 'properties must be an object');
      node.props = new Map();
      for (const k of Object.keys(s.properties)) node.props.set(k, build(s.properties[k], `${where}/properties/${tok(k)}`, false));
    }
    if (has(s, 'additionalProperties')) {
      if (s.additionalProperties !== false) throw new SchemaSetupError(where, 'additionalProperties is supported only as false');
      node.closed = true;
    }
    if (has(s, 'items')) {
      if (!isObject(s.items)) throw new SchemaSetupError(where, 'items is supported only as a schema object');
      node.items = build(s.items, `${where}/items`, false);
    }
    if (has(s, '$ref')) {
      const name = typeof s.$ref === 'string' ? decodeDefRef(s.$ref) : null;
      if (name === null) throw new SchemaSetupError(where, `$ref is supported only as "#/$defs/<name>", got ${JSON.stringify(s.$ref)}`);
      node.ref = name;
      pendingRefs.push([name, where]);
    }
    return node;
  }

  const rootNode = build(root, '#', true);
  if (has(root, '$defs')) {
    for (const name of Object.keys(root.$defs)) defs.set(name, build(root.$defs[name], `#/$defs/${tok(name)}`, false));
  }
  for (const [name, where] of pendingRefs) {
    if (!defs.has(name)) throw new SchemaSetupError(where, `$ref names a missing definition "${name}"`);
  }
  // A chain of $refs that returns to itself without descending into the instance would never terminate.
  for (const start of defs.keys()) {
    const seen = new Set([start]);
    for (let n = defs.get(start).ref; n !== null; n = defs.get(n).ref) {
      if (seen.has(n)) throw new SchemaSetupError(`#/$defs/${tok(start)}`, '$ref cycle that consumes no instance');
      seen.add(n);
    }
  }

  function run(node, v, p, out) {
    for (const check of node.checks) check(v, p, out);
    if (node.ref !== null) run(defs.get(node.ref), v, p, out);
    if (isObject(v)) {
      if (node.props) for (const [k, sub] of node.props) if (has(v, k)) run(sub, v[k], `${p}/${tok(k)}`, out);
      if (node.closed) {
        for (const k of Object.keys(v)) if (!node.props || !node.props.has(k)) out.push({ code: 'E_UNKNOWN_FIELD', path: `${p}/${tok(k)}`, message: `unknown field "${k}"` });
      }
    }
    if (node.items && Array.isArray(v)) v.forEach((item, i) => run(node.items, item, `${p}/${i}`, out));
  }

  return function validate(instance) {
    const out = [];
    run(rootNode, instance, '', out);
    return out;
  };
}

module.exports = { compile, SchemaSetupError, META_SCHEMA };
