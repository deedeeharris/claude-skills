'use strict';

// Path matching shared by check-completion.js (full mode: evidence, test and negative-control paths) and the
// validator (G43), so design and verify hold a negative control to one rule with one matcher.

// file equals entry (a trailing '/' ignored) or lies under it. Exact case, as completion has always compared.
const insideEntry = (file, entry) => file === entry.replace(/\/$/, '') || file.startsWith(entry.endsWith('/') ? entry : entry + '/');

// The repo files an isolated_mutation's prose names. The mutation is prose (verify writes the patch from it), so at
// design time the named files are the only statement of what the patch will touch. A name is a whitespace-separated
// token, stripped of quotes, backticks, brackets and trailing punctuation or a `:<line>` suffix, that is relative (no
// leading '/', no scheme), holds a '/' and ends in a file extension: `src/a.ts` counts; a route such as `/hello`, a
// call such as `hello()` or a bare `a.ts` does not.
function namedMutationPaths(text) {
  const out = [];
  for (const raw of String(text).split(/\s+/)) {
    let t = raw.replace(/^[`'"([{<]+/, '').replace(/[`'")\]}>.,;:!?]+$/, '').replace(/:[0-9]+(-[0-9]+)?$/, '').replace(/^(\.\/)+/, '');
    if (!t || t.startsWith('/') || t.includes('://') || !t.includes('/') || !/\.[A-Za-z0-9]+$/.test(t)) continue;
    if (!/^[A-Za-z0-9._/+@-]+$/.test(t) || t.split('/').includes('..')) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

module.exports = { insideEntry, namedMutationPaths };
