'use strict';

// Strict JSON parser for the v2 canonical feature file (docs/v2-design.md section 3, step 1).
// parse(bytes) -> { value } or throws a StrictJsonError { code, path, offset, message }.
//   - bytes are decoded with TextDecoder('utf-8', { fatal: true }): invalid UTF-8 is E_PARSE, never U+FFFD;
//   - a byte order mark is E_PARSE (offset 0);
//   - RFC 8259 grammar only: no comments, trailing commas, single quotes, NaN/Infinity, leading zeros,
//     raw control characters in strings, unknown escapes, or lone surrogates in \u escapes; a number that
//     overflows to Infinity is E_PARSE; nesting deeper than MAX_DEPTH is E_PARSE;
//   - duplicate keys at any depth are E_DUP_KEY; the keys __proto__, constructor and prototype are
//     E_FORBIDDEN_KEY; objects are built with Object.create(null).
// path is the JSON Pointer (RFC 6901) of the member or value being parsed when the error occurred ("" for
// the root, for decoding errors and for content after the root value); offset is a UTF-16 code-unit index
// into the decoded text, or the byte index for decoding errors.

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 256;

class StrictJsonError extends Error {
  constructor(code, path, offset, message) {
    super(message);
    this.name = 'StrictJsonError';
    this.code = code;
    this.path = path;
    this.offset = offset;
  }
}

const escapeToken = key => key.replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = segments => segments.map(s => '/' + escapeToken(String(s))).join('');

// Byte index of the first invalid UTF-8 sequence (for the error offset only; the decision is TextDecoder's).
function firstInvalidUtf8(bytes) {
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let n, min;
    if (b < 0x80) { i += 1; continue; }
    if (b >= 0xc2 && b <= 0xdf) { n = 1; min = 0x80; } else if (b >= 0xe0 && b <= 0xef) { n = 2; min = 0x800; } else if (b >= 0xf0 && b <= 0xf4) { n = 3; min = 0x10000; } else return i;
    let cp = b & (0x3f >> n);
    for (let k = 1; k <= n; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += n + 1;
  }
  return null;
}

function decode(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('strict-json: input must be a Buffer, Uint8Array or string');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError('E_PARSE', '', 0, 'byte order mark is not allowed');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError('E_PARSE', '', firstInvalidUtf8(bytes), 'invalid UTF-8');
  }
}

function parse(input) {
  const text = decode(input);
  let i = 0;
  const segs = [];
  const fail = (code, message, at = i) => { throw new StrictJsonError(code, pointer(segs), at, message); };
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const describe = () => (i >= text.length ? 'end of input' : JSON.stringify(text[i]));

  function value(depth) {
    if (depth > MAX_DEPTH) fail('E_PARSE', `nesting deeper than ${MAX_DEPTH}`);
    ws();
    const ch = text[i];
    if (ch === '{') return object(depth);
    if (ch === '[') return array(depth);
    if (ch === '"') return string();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    return fail('E_PARSE', `unexpected ${describe()}, expected a JSON value`);
  }

  function object(depth) {
    i++;
    const out = Object.create(null);
    const seen = new Set();
    ws();
    if (text[i] === '}') { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('E_PARSE', `unexpected ${describe()}, expected a string key`);
      const keyAt = i;
      const key = string();
      segs.push(key);
      if (FORBIDDEN_KEYS.has(key)) fail('E_FORBIDDEN_KEY', `forbidden key ${JSON.stringify(key)}`, keyAt);
      if (seen.has(key)) fail('E_DUP_KEY', `duplicate key ${JSON.stringify(key)}`, keyAt);
      seen.add(key);
      ws();
      if (text[i] !== ':') fail('E_PARSE', `unexpected ${describe()}, expected ':'`);
      i++;
      out[key] = value(depth + 1);
      segs.pop();
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return out; }
      fail('E_PARSE', `unexpected ${describe()}, expected ',' or '}'`);
    }
  }

  function array(depth) {
    i++;
    const out = [];
    ws();
    if (text[i] === ']') { i++; return out; }
    for (;;) {
      segs.push(out.length);
      out.push(value(depth + 1));
      segs.pop();
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return out; }
      fail('E_PARSE', `unexpected ${describe()}, expected ',' or ']'`);
    }
  }

  function hex4() {
    const h = text.slice(i, i + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(h)) fail('E_PARSE', 'invalid \\u escape');
    i += 4;
    return parseInt(h, 16);
  }

  function string() {
    const start = i;
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('E_PARSE', 'unterminated string', start);
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) fail('E_PARSE', `raw control character U+${c.toString(16).padStart(4, '0').toUpperCase()} in a string`);
      if (c !== 0x5c) { out += text[i]; i++; continue; }
      const e = text[i + 1];
      i += 2;
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (e !== undefined && Object.hasOwn(simple, e)) { out += simple[e]; continue; }
      if (e !== 'u') { i -= 2; fail('E_PARSE', `invalid escape \\${e === undefined ? '' : e}`); }
      const at = i - 2;
      const u = hex4();
      if (u >= 0xdc00 && u <= 0xdfff) fail('E_PARSE', 'lone low surrogate in a \\u escape', at);
      if (u >= 0xd800 && u <= 0xdbff) {
        if (text[i] !== '\\' || text[i + 1] !== 'u') fail('E_PARSE', 'lone high surrogate in a \\u escape', at);
        i += 2;
        const lo = hex4();
        if (lo < 0xdc00 || lo > 0xdfff) fail('E_PARSE', 'lone high surrogate in a \\u escape', at);
        out += String.fromCharCode(u, lo);
        continue;
      }
      out += String.fromCharCode(u);
    }
  }

  function number() {
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) fail('E_PARSE', 'invalid number');
    const after = text[i + m[0].length];
    if (after !== undefined && /[0-9.eE+\-A-Za-z]/.test(after)) fail('E_PARSE', 'invalid number');
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail('E_PARSE', 'number out of range');
    i += m[0].length;
    return n;
  }

  const result = value(0);
  ws();
  if (i < text.length) fail('E_PARSE', `unexpected ${describe()} after the JSON value`);
  return { value: result };
}

module.exports = { parse, pointer, StrictJsonError, FORBIDDEN_KEYS };
