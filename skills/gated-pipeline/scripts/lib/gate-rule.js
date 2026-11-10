'use strict';

// The #37 gate rule as a library, for the certifying scripts (check-completion.js --mode approvals and contract-2
// completion, docs/v2-design.md sections 5, 6.5 and 9). ISO_SET, computeTriggers and computeVerdict are
// byte-identical copies of codex-review's scripts/run-review.js (tests/fallback-parity.test.js checks); the rest
// mirrors gateCodex/gateFallback of the workflows, over the files the scripts read instead of a relay reply:
// - codexGate(kind, result): result is a codex-review result.json. runner = computeVerdict over its findings and
//   model_verdict (each finding keeps its own validation object); gate = runner, except a runner PASS with any
//   validated-confirmed BLOCKING/MAJOR is FAIL (a revise or fix round).
// - fallbackGate(kind, reply): reply is the structured Opus fallback reply. Ids F1, F2, ... in reply order, every
//   BLOCKING/MAJOR counts as confirmed and every MINOR/NIT as not_required, the model verdict passed is PASS (the
//   rule never disagrees with itself), and the same PASS -> FAIL step applies.
// Both return { verdict, reasons, confirmed } (confirmed: the ids of the validated-confirmed BLOCKING/MAJOR).

const ISO_SET = new Set(['ambiguous', 'unverifiable', 'missing_acceptance_criteria', 'inconsistent', 'infeasible', 'incomplete']);
function computeTriggers(kind, findings) {
  if (kind === 'implementation') {
    return findings.filter((f) => f.severity === 'BLOCKING' || (f.severity === 'MAJOR' && f.confidence >= 0.8));
  }
  const major = findings.filter((f) => f.severity === 'MAJOR');
  const byCount = major.length >= 3 ? major : [];
  const byIso = major.filter((f) => f.iso_property && ISO_SET.has(f.iso_property));
  const blocking = findings.filter((f) => f.severity === 'BLOCKING');
  const byId = new Map();
  for (const f of [...blocking, ...byIso, ...byCount]) byId.set(f.id, f);
  return [...byId.values()];
}
function computeVerdict(kind, findings, modelVerdict) {
  const reasons = [];
  const counted = findings.filter((f) => !f.validation || f.validation.status !== 'refuted');
  const triggers = computeTriggers(kind, counted);
  if (triggers.length > 0) {
    const confirmed = triggers.filter((f) => f.validation && f.validation.status === 'confirmed');
    if (confirmed.length > 0) {
      for (const f of confirmed) reasons.push(`${f.id} ${f.severity} conf ${f.confidence} (${kind})`);
      return { verdict: 'FAIL', reasons };
    }
    if (triggers.every((f) => f.validation && f.validation.status === 'unvalidated')) {
      reasons.push('validation_unavailable: all triggering findings unvalidated');
      return { verdict: 'NEEDS_HUMAN', reasons };
    }
    reasons.push('triggering findings left in an unexpected validation state');
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  const lowConf = counted.find((f) => (f.severity === 'BLOCKING' || f.severity === 'MAJOR') && f.confidence >= 0.5 && f.confidence < 0.8);
  if (lowConf) {
    reasons.push(`${lowConf.id} ${lowConf.severity} conf ${lowConf.confidence} in 0.5-0.8 band`);
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  // Both computed from `counted` (refuted findings already excluded above), never from
  // the raw `findings` — a refuted BLOCKING/MAJOR must never affect this comparison, the
  // same rule every other branch above already applies.
  const preTriggers = computeTriggers(kind, counted);
  const preVerdict = preTriggers.length > 0 ? 'FAIL'
    : counted.some((f) => (f.severity === 'BLOCKING' || f.severity === 'MAJOR') && f.confidence >= 0.5 && f.confidence < 0.8) ? 'NEEDS_HUMAN' : 'PASS';
  if (modelVerdict !== preVerdict) {
    reasons.push(`model_rule_disagreement: model said ${modelVerdict}, rule says ${preVerdict}`);
    return { verdict: 'NEEDS_HUMAN', reasons };
  }
  reasons.push('no triggering findings');
  return { verdict: 'PASS', reasons };
}
const big = f => f && (f.severity === 'BLOCKING' || f.severity === 'MAJOR');
function gate(kind, findings, modelVerdict) {
  const v = computeVerdict(kind, findings, modelVerdict);
  const confirmed = findings.filter(f => big(f) && f.validation && f.validation.status === 'confirmed').map(f => f.id);
  if (v.verdict === 'PASS' && confirmed.length) return { verdict: 'FAIL', reasons: [...v.reasons, 'PASS with confirmed findings: ' + confirmed.join(', ')], confirmed };
  return { verdict: v.verdict, reasons: v.reasons, confirmed };
}
function codexGate(kind, result) {
  if (!result || !Array.isArray(result.findings)) throw new Error('result.json has no findings array');
  return gate(kind, result.findings, result.model_verdict);
}
function fallbackGate(kind, reply) {
  if (!reply || !Array.isArray(reply.findings)) throw new Error('the fallback reply has no findings array');
  const findings = reply.findings.map((x, i) => ({ id: 'F' + (i + 1), severity: x && x.severity, confidence: Number(x && x.confidence) || 0,
    iso_property: kind === 'implementation' ? null : (x && x.iso_property) ?? null,
    validation: { status: big(x) ? 'confirmed' : 'not_required' } }));
  return gate(kind, findings, 'PASS');
}

module.exports = { ISO_SET, computeTriggers, computeVerdict, codexGate, fallbackGate };
