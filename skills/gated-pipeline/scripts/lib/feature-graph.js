'use strict';

// Graph and cross-field rules of the v2 canonical feature file: docs/v2-design.md section 3, tables
// 4 (G01-G40), 5 (R01-R04, --source-request) and 6 (P01-P02, --previous). Every diagnostic is
// { code, rule, path, id, message }; path is a JSON Pointer into the checked file (for P01 the collection in
// the checked file where the missing id belongs). The functions assume a schema-valid file (validate-feature.js
// runs them only after schema-lite passed) and never execute or evaluate any string of the file.
//
// Choices where the design is silent (the simplest reading, applied uniformly):
// - "empty or missing" for a reason, rationale, command or mutation means absent or only whitespace;
// - relationship rules (G33-G37) use the owned paths of active components and the evidence paths of active
//   acceptances of active requirements, and skip any path that G32 already rejects; G32 checks every path;
// - G03 matches the listed segments case-insensitively, only when followed by the end or a non-alphanumeric
//   character, on every `id`, on `feature_id` and on `title`; `-rev<n>` takes any digits, `-v2` is literal;
// - G04 compares every pair of requirements (active or retired); G07 reports one diagnostic per cycle, at the
//   depends_on of the cycle's smallest id; G26 reports once, at /scope/test_paths;
// - G38 rejects a `.git` segment anywhere in the features_dir, and a feature_id made only of dots (`.`, `..`:
//   the schema pattern admits them, but later stages use feature_id as a path segment);
// - G32 also rejects a `.git` segment (any case) in every scope, owned and evidence path, so no write scope
//   can reach git hooks or config (the same reason G38 keeps features_dir out of `.git/`);
// - G20 also rejects a suite command, unit_command or non-null setup_command that is empty or only whitespace
//   (acceptance and check commands get that check from G18 and G28; the schema's minLength admits "   ");
// - G03 matches title segments the same way as ids, so a title such as "Pre-fix greeting" is rejected (fail
//   closed; the title is free text, so rename it);
// - P02 covers lifecycle status and SRC disposition (checks have no "retired" state; a not-applicable check
//   may become applicable again);
// - G13 and G14 count only active goals and active components (a retired component owns nothing, so a
//   requirement naming only retired items has no live goal and no owned scope);
// - G33, G34, G35 and G37 compare path segments with ASCII case folded, so a path that differs only in case
//   from a protected, state or owned path is rejected (fail closed on case-insensitive filesystems such as
//   default macOS); G36 ("inside allowed_paths") compares exactly, so it must hold on a case-sensitive
//   filesystem too. Paths are ASCII (G32), so folding is lowercasing;
// - G34's owned candidates only add a diagnostic of their own when G36 also fails: an owned path inside an
//   allowed path overlaps every state path it overlaps through that allowed path;
// - R01 normalizes one trailing LF or CRLF on both sides (source_request.text holds no CR, G31; a request
//   file saved with CRLF line ends still mismatches on any inner CRLF);
// - G40 uses the worst cases of scripts/lib/call-limits.js, the same the build and verify preflights use: the suite
//   always, each applicable check, one proof when an active runtime acceptance with live false exists, and the
//   negative-control bound when an active isolated_mutation exists (reported only when one proof fits, since a
//   proof that cannot fit already makes every control unfit). Paths: /suite/timeout_min, the check's budget_min
//   (when > 0) or timeout_min, /limits/proof_timeout_s, and /limits for the negative control (both limits bound it).

const crypto = require('node:crypto');
const { ONE_CALL_S, RUN_GRACE_S, suiteWorstS, checkWorstS, proofWorstS, negativeWorstS } = require('./call-limits.js');

const SHADOW = /-(fix|v2|final|new|addendum|patch|rev[0-9]+)(?![A-Za-z0-9])/i;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/u;
const PATH_CHARS = /^[A-Za-z0-9._/ +@-]+$/;
const MARKER = 'MIGRATION-TODO';

const tok = s => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const blank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const diag = (code, rule, path, id, message) => ({ code, rule, path, id: id === undefined ? null : id, message });

// ---- items ---------------------------------------------------------------------------------------------

// Every id'd item with its category, JSON Pointer and whether it is active.
function collect(f) {
  const items = [];
  const add = (cat, list, base, isActive) => (list || []).forEach((obj, i) => items.push({ cat, id: obj.id, path: `${base}/${i}`, obj, active: isActive(obj) }));
  const lc = o => o.status === 'active';
  add('SRC', f.coverage, '/coverage', o => o.disposition === 'covered');
  add('GOAL', f.product.goals, '/product/goals', lc);
  add('NG', f.product.non_goals, '/product/non_goals', lc);
  add('DEC', f.architecture.decisions, '/architecture/decisions', lc);
  add('INV', f.architecture.invariants, '/architecture/invariants', lc);
  add('COMP', f.architecture.components, '/architecture/components', lc);
  add('RISK', f.architecture.security.accepted_risks, '/architecture/security/accepted_risks', lc);
  f.requirements.forEach((r, i) => {
    items.push({ cat: 'REQ', id: r.id, path: `/requirements/${i}`, obj: r, active: lc(r) });
    r.acceptance.forEach((a, j) => items.push({ cat: 'ACC', id: a.id, path: `/requirements/${i}/acceptance/${j}`, obj: a, active: lc(a), parent: r, parentIndex: i }));
  });
  add('CHECK', f.checks, '/checks', o => o.applicable === true);
  return items;
}
const COLLECTION = { SRC: '/coverage', GOAL: '/product/goals', NG: '/product/non_goals', DEC: '/architecture/decisions', INV: '/architecture/invariants', COMP: '/architecture/components', RISK: '/architecture/security/accepted_risks', REQ: '/requirements', CHECK: '/checks' };
const LIFECYCLE = new Set(['GOAL', 'NG', 'DEC', 'INV', 'COMP', 'RISK', 'REQ', 'ACC']);

function firstById(list) {
  const m = new Map();
  list.forEach((x, i) => { if (!m.has(x.id)) m.set(x.id, { obj: x, index: i }); });
  return m;
}

function walkStrings(v, p, fn) {
  if (typeof v === 'string') fn(v, p);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${p}/${i}`, fn));
  else if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) walkStrings(v[k], `${p}/${tok(k)}`, fn);
}

// ---- paths ---------------------------------------------------------------------------------------------

function unsafePath(p) {
  if (p.startsWith('/')) return 'is absolute';
  if (p.includes('\\')) return 'contains a backslash';
  if (p.includes('~')) return 'contains ~';
  if (CONTROL.test(p) || /[\u0000-\u001F]/.test(p)) return 'contains a control character';
  if (!PATH_CHARS.test(p)) return 'contains a character outside [A-Za-z0-9._/ +@-]';
  if (p.split('/').includes('..')) return 'has a .. segment';
  if (p.split('/').some(s => s.toLowerCase() === '.git')) return 'has a .git segment';
  return null;
}
const segs = p => p.split('/').filter(s => s !== '' && s !== '.');
const isPrefix = (a, b) => a.length <= b.length && a.every((s, i) => s === b[i]);
const folded = p => segs(p.toLowerCase());
const overlap = (a, b) => { const x = folded(a), y = folded(b); return isPrefix(x, y) || isPrefix(y, x); }; // case folded
const inside = (a, b) => isPrefix(segs(b), segs(a)); // a equal to or inside b, exact case

// ---- G01-G40 -------------------------------------------------------------------------------------------

function checkRepoPath(f, repoPath) {
  const out = [];
  let featuresDir = null;
  const why = unsafePath(repoPath);
  const parts = repoPath.split('/');
  const dir = parts.slice(0, -1).join('/');
  if (why) out.push(diag('E_SCOPE', 'G38', '', null, `--repo-path ${JSON.stringify(repoPath)} ${why}`));
  else if (!segs(dir).length) out.push(diag('E_SCOPE', 'G38', '', null, 'features_dir (the dirname of --repo-path) must be a directory inside the repo'));
  else if (segs(dir).some(s => s.toLowerCase() === '.git')) out.push(diag('E_SCOPE', 'G38', '', null, `features_dir ${JSON.stringify(dir)} is under .git/`));
  else featuresDir = segs(dir).join('/') + '/';
  if (/^\.+$/.test(f.feature_id)) out.push(diag('E_SCOPE', 'G38', '/feature_id', null, `feature_id ${JSON.stringify(f.feature_id)} is only dots, which is no safe path segment`));
  const base = parts[parts.length - 1];
  if (base !== `${f.feature_id}.feature.json`) out.push(diag('E_SCOPE', 'G38', '/feature_id', null, `--repo-path basename ${JSON.stringify(base)} is not "${f.feature_id}.feature.json"`));
  return { out, featuresDir };
}

function graphRules(f, { repoPath }) {
  const out = [];
  const items = collect(f);
  const reqs = f.requirements;
  const reqIndex = firstById(reqs);
  const checkIndex = firstById(f.checks);
  const allIds = new Set(items.map(x => x.id));

  // G01 any id repeated across the whole file
  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.id)) out.push(diag('E_DUP_ID', 'G01', `${it.path}/id`, it.id, `id ${it.id} is already used at ${seen.get(it.id)}`));
    else seen.set(it.id, it.path);
  }
  // G02 acceptance id format
  for (const it of items) {
    if (it.cat === 'ACC' && !(it.id.startsWith(`${it.parent.id}-AC`) && /^[0-9]+$/.test(it.id.slice(it.parent.id.length + 3)))) {
      out.push(diag('E_ID_FORMAT', 'G02', `${it.path}/id`, it.id, `acceptance id ${it.id} is not ${it.parent.id}-AC<n>`));
    }
  }
  // G03 shadow segments
  for (const it of items) if (SHADOW.test(it.id)) out.push(diag('E_SHADOW_ID', 'G03', `${it.path}/id`, it.id, `id ${it.id} has a shadow segment ${SHADOW.exec(it.id)[0]}`));
  if (SHADOW.test(f.feature_id)) out.push(diag('E_SHADOW_ID', 'G03', '/feature_id', null, `feature_id has a shadow segment ${SHADOW.exec(f.feature_id)[0]}`));
  if (SHADOW.test(f.title)) out.push(diag('E_SHADOW_ID', 'G03', '/title', null, `title has a shadow segment ${SHADOW.exec(f.title)[0]}`));
  // G04 identical normalized statements
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const statements = new Map();
  reqs.forEach((r, i) => {
    const n = norm(r.statement);
    if (statements.has(n)) out.push(diag('E_DUP_STATEMENT', 'G04', `/requirements/${i}/statement`, r.id, `statement of ${r.id} equals that of ${statements.get(n)} after normalization`));
    else statements.set(n, r.id);
  });
  // G05 dangling references, G06 depends_on retired
  const goalIds = new Set(f.product.goals.map(g => g.id));
  const srcIds = new Set(f.coverage.map(c => c.id));
  const compIds = new Set(f.architecture.components.map(c => c.id));
  const ref = (ok, p, id, what, v) => { if (!ok) out.push(diag('E_REF', 'G05', p, id, `${what} ${JSON.stringify(v)} does not exist`)); };
  f.coverage.forEach((c, i) => (c.requirement_ids || []).forEach((r, j) => ref(reqIndex.has(r), `/coverage/${i}/requirement_ids/${j}`, c.id, 'requirement', r)));
  f.product.goals.forEach((g, i) => g.source_ids.forEach((s, j) => ref(srcIds.has(s), `/product/goals/${i}/source_ids/${j}`, g.id, 'source', s)));
  f.architecture.security.accepted_risks.forEach((k, i) => k.cites.forEach((c, j) => ref(allIds.has(c), `/architecture/security/accepted_risks/${i}/cites/${j}`, k.id, 'cited id', c)));
  reqs.forEach((r, i) => {
    r.goal_ids.forEach((g, j) => ref(goalIds.has(g), `/requirements/${i}/goal_ids/${j}`, r.id, 'goal', g));
    r.component_ids.forEach((c, j) => ref(compIds.has(c), `/requirements/${i}/component_ids/${j}`, r.id, 'component', c));
    r.depends_on.forEach((d, j) => {
      const p = `/requirements/${i}/depends_on/${j}`;
      ref(reqIndex.has(d), p, r.id, 'requirement', d);
      if (reqIndex.has(d) && reqIndex.get(d).obj.status === 'retired') out.push(diag('E_REF', 'G06', p, r.id, `depends_on names the retired requirement ${d}`));
    });
    r.acceptance.forEach((a, j) => {
      const v = a.verification;
      if (has(v, 'check_id')) ref(checkIndex.has(v.check_id), `/requirements/${i}/acceptance/${j}/verification/check_id`, a.id, 'check', v.check_id);
    });
  });
  // G07 depends_on cycles (Tarjan SCC, one diagnostic per cycle)
  {
    const edges = new Map(reqs.map(r => [r.id, r.depends_on.filter(d => reqIndex.has(d))]));
    const index = new Map(), low = new Map(), stack = [], onStack = new Set();
    let counter = 0;
    const sccs = [];
    const strong = v => {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of edges.get(v)) {
        if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        sccs.push(comp);
      }
    };
    for (const id of edges.keys()) if (!index.has(id)) strong(id);
    for (const comp of sccs) {
      const members = new Set(comp);
      const start = [...comp].sort()[0];
      if (comp.length === 1 && !edges.get(start).includes(start)) continue;
      const cycle = [start];
      const visited = new Set([start]);
      const dfs = v => {
        for (const w of edges.get(v)) {
          if (w === start) return true;
          if (members.has(w) && !visited.has(w)) { visited.add(w); cycle.push(w); if (dfs(w)) return true; cycle.pop(); }
        }
        return false;
      };
      dfs(start);
      out.push(diag('E_CYCLE', 'G07', `/requirements/${reqIndex.get(start).index}/depends_on`, start, `depends_on cycle: ${[...cycle, start].join(' -> ')}`));
    }
  }
  // G08 source_request form
  const sr = f.source_request;
  const refKeys = ['ref', 'sha256', 'summary'].filter(k => has(sr, k));
  if (!has(sr, 'text') && !refKeys.length) out.push(diag('E_SOURCE_FORM', 'G08', '/source_request', null, 'source_request has no form: { text } or { ref, sha256, summary }'));
  else if (has(sr, 'text') && refKeys.length) out.push(diag('E_SOURCE_FORM', 'G08', '/source_request', null, 'source_request has both the text and the ref form'));
  else if (refKeys.length && refKeys.length < 3) out.push(diag('E_SOURCE_FORM', 'G08', '/source_request', null, `ref form lacks ${['ref', 'sha256', 'summary'].filter(k => !has(sr, k)).join(', ')}`));
  // G09-G16 coverage
  const listedByCovered = new Set();
  f.coverage.forEach((c, i) => {
    if (c.disposition === 'covered') {
      if (!c.requirement_ids || !c.requirement_ids.length) out.push(diag('E_COVERAGE', 'G09', `/coverage/${i}/requirement_ids`, c.id, `covered ${c.id} names no requirement`));
      (c.requirement_ids || []).forEach(r => listedByCovered.add(r));
    } else if (blank(c.rationale)) out.push(diag('E_COVERAGE', 'G10', `/coverage/${i}/rationale`, c.id, `excluded ${c.id} has no rationale`));
  });
  const coveredSrc = new Set(f.coverage.filter(c => c.disposition === 'covered').map(c => c.id));
  const activeReqs = reqs.filter(r => r.status === 'active');
  const activeGoals = new Set(f.product.goals.filter(g => g.status === 'active').map(g => g.id));
  const activeComps = new Set(f.architecture.components.filter(c => c.status === 'active').map(c => c.id));
  f.product.goals.forEach((g, i) => {
    if (g.status !== 'active') return;
    if (!activeReqs.some(r => r.goal_ids.includes(g.id))) out.push(diag('E_COVERAGE', 'G11', `/product/goals/${i}`, g.id, `active goal ${g.id} has no active requirement`));
    if (!g.source_ids.some(s => coveredSrc.has(s))) out.push(diag('E_COVERAGE', 'G12', `/product/goals/${i}/source_ids`, g.id, `active goal ${g.id} names no covered SRC`));
  });
  reqs.forEach((r, i) => {
    if (r.status !== 'active') return;
    if (!r.goal_ids.some(g => activeGoals.has(g))) out.push(diag('E_COVERAGE', 'G13', `/requirements/${i}/goal_ids`, r.id, `active requirement ${r.id} has no active goal`));
    if (!r.component_ids.some(c => activeComps.has(c))) out.push(diag('E_COVERAGE', 'G14', `/requirements/${i}/component_ids`, r.id, `active requirement ${r.id} has no active component`));
    if (!r.acceptance.some(a => a.status === 'active')) out.push(diag('E_COVERAGE', 'G15', `/requirements/${i}/acceptance`, r.id, `active requirement ${r.id} has no active acceptance`));
    if (!listedByCovered.has(r.id) && blank(r.derived_rationale)) out.push(diag('E_COVERAGE', 'G16', `/requirements/${i}`, r.id, `active requirement ${r.id} is listed by no covered SRC and has no derived_rationale`));
  });
  // G17 retired without rationale
  for (const it of items) {
    if (LIFECYCLE.has(it.cat) && it.obj.status === 'retired' && blank(it.obj.retired_rationale)) {
      out.push(diag('E_REASON_MISSING', 'G17', `${it.path}/retired_rationale`, it.id, `retired ${it.id} has no retired_rationale`));
    }
  }
  // G18-G26 proofs and negative controls
  const budgeted = f.checks.filter(c => c.applicable === true && c.budget_min > 0 && typeof c.command === 'string');
  let isolatedSeen = false;
  for (const it of items.filter(x => x.cat === 'ACC')) {
    const a = it.obj, v = a.verification, nc = a.negative_control, p = it.path;
    if (v.kind === 'runtime') {
      if (blank(v.command)) out.push(diag('E_PROOF', 'G18', `${p}/verification/command`, a.id, `runtime acceptance ${a.id} has no command`));
      if (!has(v, 'expected')) out.push(diag('E_PROOF', 'G18', `${p}/verification/expected`, a.id, `runtime acceptance ${a.id} has no expected`));
      if (!has(v, 'live')) out.push(diag('E_PROOF', 'G18', `${p}/verification/live`, a.id, `runtime acceptance ${a.id} does not declare live`));
    } else {
      if (has(v, 'command')) out.push(diag('E_PROOF', 'G19', `${p}/verification/command`, a.id, `static acceptance ${a.id} has a command`));
      if (has(v, 'live')) out.push(diag('E_PROOF', 'G19', `${p}/verification/live`, a.id, `static acceptance ${a.id} declares live`));
      if (!has(v, 'evidence')) out.push(diag('E_PROOF', 'G19', `${p}/verification/evidence`, a.id, `static acceptance ${a.id} has no evidence`));
    }
    if (typeof v.command === 'string' && v.command.includes('\n')) out.push(diag('E_PROOF', 'G20', `${p}/verification/command`, a.id, `command of ${a.id} spans several lines`));
    if (v.live === true) {
      if (!has(v, 'check_id')) out.push(diag('E_PROOF', 'G21', `${p}/verification/check_id`, a.id, `live acceptance ${a.id} has no check_id`));
      else if (checkIndex.has(v.check_id)) {
        const c = checkIndex.get(v.check_id).obj;
        if (c.applicable !== true || !(c.budget_min > 0)) out.push(diag('E_PROOF', 'G21', `${p}/verification/check_id`, a.id, `live acceptance ${a.id} names ${c.id}, which is not an applicable check with budget_min > 0`));
        if (v.command !== c.command) out.push(diag('E_PROOF', 'G21', `${p}/verification/command`, a.id, `live acceptance ${a.id} has a command different from ${c.id}'s`));
      }
    }
    if (v.kind === 'runtime' && v.live === false && typeof v.command === 'string') {
      const c = budgeted.find(x => x.command === v.command);
      if (c) out.push(diag('E_PROOF', 'G22', `${p}/verification/command`, a.id, `acceptance ${a.id} has live: false but the command of the budgeted check ${c.id}`));
    }
    if (nc.method === 'isolated_mutation') {
      isolatedSeen = true;
      if (blank(nc.mutation)) out.push(diag('E_NEGATIVE_CONTROL', 'G23', `${p}/negative_control/mutation`, a.id, `isolated_mutation of ${a.id} has no mutation`));
    } else if (blank(nc.exemption_reason)) out.push(diag('E_NEGATIVE_CONTROL', 'G23', `${p}/negative_control/exemption_reason`, a.id, `exempt control of ${a.id} has no exemption_reason`));
    if ((v.kind === 'static' || v.live === true) && nc.method !== 'exempt') out.push(diag('E_NEGATIVE_CONTROL', 'G24', `${p}/negative_control/method`, a.id, `${v.kind === 'static' ? 'static' : 'live'} acceptance ${a.id} must use an exempt control`));
  }
  reqs.forEach((r, i) => {
    if (r.status !== 'active' || r.priority !== 'P0') return;
    const live = r.acceptance.map((a, j) => [a, j]).filter(([a]) => a.status === 'active');
    if (!live.length || !live.every(([a]) => a.negative_control.method === 'exempt')) return;
    for (const [a, j] of live) {
      if (!has(a.negative_control, 'alternate_evidence')) out.push(diag('E_NEGATIVE_CONTROL', 'G25', `/requirements/${i}/acceptance/${j}/negative_control/alternate_evidence`, a.id, `every active acceptance of P0 ${r.id} is exempt; ${a.id} needs alternate_evidence`));
    }
  });
  if (isolatedSeen && !f.scope.test_paths.length) out.push(diag('E_NEGATIVE_CONTROL', 'G26', '/scope/test_paths', null, 'an isolated_mutation exists while scope.test_paths is empty'));
  // G27-G30 checks, known failures, limits
  f.checks.forEach((c, i) => {
    const p = `/checks/${i}`;
    if (blank(c.reason)) out.push(diag('E_REASON_MISSING', 'G27', `${p}/reason`, c.id, `check ${c.id} has no reason`));
    if (c.applicable === true) {
      if (blank(c.command)) out.push(diag('E_REASON_MISSING', 'G28', `${p}/command`, c.id, `applicable check ${c.id} has no command`));
      if (!has(c, 'expected')) out.push(diag('E_REASON_MISSING', 'G28', `${p}/expected`, c.id, `applicable check ${c.id} has no expected`));
      if (!has(c, 'timeout_min')) out.push(diag('E_REASON_MISSING', 'G28', `${p}/timeout_min`, c.id, `applicable check ${c.id} has no timeout_min`));
    }
    if (typeof c.command === 'string' && c.command.includes('\n')) out.push(diag('E_PROOF', 'G20', `${p}/command`, c.id, `command of ${c.id} spans several lines`));
    if (has(c, 'timeout_min') && c.budget_min > c.timeout_min) out.push(diag('E_LIMIT', 'G30', `${p}/budget_min`, c.id, `budget_min ${c.budget_min} of ${c.id} is above timeout_min ${c.timeout_min}`));
  });
  for (const k of ['command', 'unit_command', 'setup_command']) {
    if (typeof f.suite[k] === 'string' && f.suite[k].includes('\n')) out.push(diag('E_PROOF', 'G20', `/suite/${k}`, null, `suite ${k} spans several lines`));
    else if (typeof f.suite[k] === 'string' && blank(f.suite[k])) out.push(diag('E_PROOF', 'G20', `/suite/${k}`, null, `suite ${k} is empty or only whitespace`));
  }
  f.suite.known_failures.forEach((k, i) => { if (blank(k.reason)) out.push(diag('E_REASON_MISSING', 'G29', `/suite/known_failures/${i}/reason`, null, `known failure ${JSON.stringify(k.test_id)} has no reason`)); });
  // G40 a frozen run whose worst case cannot finish inside one foreground Bash call (scripts/lib/call-limits.js)
  const overCall = (at, id, what, seconds) => {
    if (seconds > ONE_CALL_S) out.push(diag('E_LIMIT', 'G40', at, id, `${what} can take up to ${seconds} s, more than one foreground Bash call allows (${ONE_CALL_S} s, each run counted as its limit + ${RUN_GRACE_S} s)`));
  };
  const setup = typeof f.suite.setup_command === 'string';
  overCall('/suite/timeout_min', null, `the suite (${setup ? 'setup and suite, each ' : ''}timeout_min ${f.suite.timeout_min})`, suiteWorstS(f.suite));
  f.checks.forEach((c, i) => {
    if (c.applicable !== true || (!(c.budget_min > 0) && !has(c, 'timeout_min'))) return; // G28 reports a missing timeout_min
    const byBudget = c.budget_min > 0;
    overCall(`/checks/${i}/${byBudget ? 'budget_min' : 'timeout_min'}`, c.id, `check ${c.id} (${byBudget ? `budget_min ${c.budget_min}` : `timeout_min ${c.timeout_min}`})`, checkWorstS(c));
  });
  const activeAcc = items.filter(x => x.cat === 'ACC' && x.active && x.parent.status === 'active');
  const proofs = activeAcc.some(x => x.obj.verification.kind === 'runtime' && x.obj.verification.live !== true);
  const controls = activeAcc.some(x => x.obj.negative_control.method === 'isolated_mutation');
  if (proofs && proofWorstS(f.limits) > ONE_CALL_S) overCall('/limits/proof_timeout_s', null, `one acceptance proof (proof_timeout_s ${f.limits.proof_timeout_s})`, proofWorstS(f.limits));
  else if (controls) {
    overCall('/limits', null, `a negative control (${setup ? 'setup, ' : ''}baseline and mutated run, each proof_timeout_s ${f.limits.proof_timeout_s}, within negative_controls_total_min ${f.limits.negative_controls_total_min})`,
      negativeWorstS(f.limits, setup));
  }
  // G31 control characters, G39 migration marker
  walkStrings(f, '', (s, p) => {
    if (CONTROL.test(s)) out.push(diag('E_CONTROL_CHAR', 'G31', p, null, 'string holds a forbidden control or line-separator character'));
    if (s.includes(MARKER)) out.push(diag('E_MIGRATION_TODO', 'G39', p, null, `string holds ${MARKER}`));
  });
  // G32-G38 paths
  const { out: scopeOut, featuresDir } = checkRepoPath(f, repoPath);
  out.push(...scopeOut);
  const lists = [];
  for (const k of ['allowed_paths', 'protected_paths', 'state_paths', 'clean_ignore', 'test_paths']) f.scope[k].forEach((v, i) => lists.push({ kind: k, value: v, path: `/scope/${k}/${i}` }));
  const comps = f.architecture.components;
  comps.forEach((c, i) => c.owned_paths.forEach((v, j) => lists.push({ kind: 'owned', value: v, path: `/architecture/components/${i}/owned_paths/${j}`, active: c.status === 'active', comp: i, exclusive: c.exclusive })));
  for (const it of items.filter(x => x.cat === 'ACC')) {
    const act = it.active && it.parent.status === 'active';
    const ev = it.obj.verification.evidence, alt = it.obj.negative_control.alternate_evidence;
    if (ev) ev.paths.forEach((v, k) => lists.push({ kind: 'evidence', value: v, path: `${it.path}/verification/evidence/paths/${k}`, active: act }));
    if (alt) alt.paths.forEach((v, k) => lists.push({ kind: 'alternate', value: v, path: `${it.path}/negative_control/alternate_evidence/paths/${k}`, active: act }));
  }
  const safe = [];
  for (const e of lists) {
    const why = unsafePath(e.value);
    if (why) out.push(diag('E_UNSAFE_PATH', 'G32', e.path, null, `path ${JSON.stringify(e.value)} ${why}`));
    else safe.push(e);
  }
  const of = (...kinds) => safe.filter(e => kinds.includes(e.kind) && e.active !== false);
  const protectedPaths = of('protected_paths').map(e => e.value).concat(featuresDir ? [featuresDir] : []);
  for (const e of of('allowed_paths', 'state_paths', 'clean_ignore', 'test_paths', 'owned')) {
    const hit = protectedPaths.find(q => overlap(e.value, q));
    if (hit !== undefined) out.push(diag('E_PROTECTED_OVERLAP', 'G33', e.path, null, `${JSON.stringify(e.value)} overlaps the protected path ${JSON.stringify(hit)}`));
  }
  const notState = of('allowed_paths', 'owned', 'test_paths', 'evidence', 'alternate');
  for (const e of of('state_paths', 'clean_ignore')) {
    const hit = notState.find(q => overlap(e.value, q.value));
    if (hit) out.push(diag('E_STATE_OVERLAP', 'G34', e.path, null, `${JSON.stringify(e.value)} overlaps ${JSON.stringify(hit.value)} (${hit.path})`));
  }
  const owned = of('owned');
  for (const e of owned) {
    if (e.exclusive) {
      const hit = owned.find(q => q.exclusive && q.comp < e.comp && overlap(e.value, q.value));
      if (hit) out.push(diag('E_OWNERSHIP', 'G35', e.path, comps[e.comp].id, `exclusive ${comps[e.comp].id} overlaps exclusive ${comps[hit.comp].id} at ${JSON.stringify(hit.value)}`));
    }
    if (!of('allowed_paths').some(q => inside(e.value, q.value))) out.push(diag('E_OWNERSHIP', 'G36', e.path, comps[e.comp].id, `owned path ${JSON.stringify(e.value)} is outside allowed_paths`));
  }
  for (const e of of('test_paths')) {
    const hit = owned.find(q => overlap(e.value, q.value));
    if (hit) out.push(diag('E_OWNERSHIP', 'G37', e.path, null, `test path ${JSON.stringify(e.value)} overlaps the owned path ${JSON.stringify(hit.value)} of ${comps[hit.comp].id}`));
  }
  return out;
}

// ---- R01-R04 -------------------------------------------------------------------------------------------

function sourceRules(f, { requestBytes, requestText, mode }) {
  const out = [];
  const sr = f.source_request;
  const refKeys = ['ref', 'sha256', 'summary'].filter(k => has(sr, k));
  const form = has(sr, 'text') && !refKeys.length ? 'text' : !has(sr, 'text') && refKeys.length === 3 ? 'ref' : null; // else G08
  const strip = s => (s.endsWith('\r\n') ? s.slice(0, -2) : s.endsWith('\n') ? s.slice(0, -1) : s);
  if (form !== null && form !== mode) out.push(diag('E_SOURCE_FORM', 'R03', '/source_request', null, `source_request uses the ${form} form but --source-mode is ${mode}`));
  if (form === 'text' && strip(sr.text) !== strip(requestText)) out.push(diag('E_SOURCE_MISMATCH', 'R01', '/source_request/text', null, 'source_request.text differs from the source request file'));
  if (form === 'ref') {
    const actual = crypto.createHash('sha256').update(requestBytes).digest('hex');
    if (sr.sha256 !== actual) out.push(diag('E_SOURCE_MISMATCH', 'R02', '/source_request/sha256', null, `source_request.sha256 differs from the request bytes (${actual})`));
  }
  if (mode === 'ref') {
    f.coverage.forEach((c, i) => {
      const cps = [...c.excerpt];
      for (let k = 0; k + 40 <= cps.length; k++) {
        if (requestText.includes(cps.slice(k, k + 40).join(''))) {
          out.push(diag('E_SOURCE_LEAK', 'R04', `/coverage/${i}/excerpt`, c.id, `excerpt of ${c.id} copies 40 code points of the request text`));
          break;
        }
      }
    });
  }
  return out;
}

// ---- P01-P02 -------------------------------------------------------------------------------------------

function previousRules(f, prev) {
  const out = [];
  const cur = collect(f);
  const key = it => `${it.cat} ${it.id}`;
  const curIndex = new Map();
  for (const it of cur) if (!curIndex.has(key(it))) curIndex.set(key(it), it);
  const curReq = firstById(f.requirements);
  for (const it of collect(prev)) {
    const now = curIndex.get(key(it));
    if (!now) {
      let where = COLLECTION[it.cat];
      if (it.cat === 'ACC') where = curReq.has(it.parent.id) ? `/requirements/${curReq.get(it.parent.id).index}/acceptance` : '/requirements';
      out.push(diag('E_ID_REMOVED', 'P01', where, it.id, `${it.id} of the previous revision is missing (retire it, exclude it or mark it not applicable instead)`));
      continue;
    }
    if ((LIFECYCLE.has(it.cat) || it.cat === 'SRC') && !it.active && now.active) {
      out.push(diag('E_ID_REACTIVATED', 'P02', `${now.path}/${it.cat === 'SRC' ? 'disposition' : 'status'}`, it.id, `${it.id} was ${it.cat === 'SRC' ? 'excluded' : 'retired'} in the previous revision and is active here`));
    }
  }
  return out;
}

module.exports = { graphRules, sourceRules, previousRules, unsafePath, overlap };
