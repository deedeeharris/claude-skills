'use strict';

// The one-foreground-call bound of the frozen steps (docs/v2-design.md 6.4, "One foreground Bash call"), shared by
// the validator's rule G40. Every frozen step's gp-exec block is one foreground Bash call (600 s at most); a frozen
// run inside it counts as its limit plus RUN_GRACE_S, and a step must finish within ONE_CALL_S. The workflows
// (workflows/build.js, workflows/verify.js) cannot require a module, so they carry the same two constants inline;
// tests/feature-validate.test.js asserts that the copies equal these values.
//
// Each worst case below is ONE run-frozen.js invocation, which cannot be split across calls:
// - the suite: its setup (when set) and the suite in the same checkout, each bounded by suite.timeout_min;
// - a check: budget_min when > 0 (a live or paid check is killed at its budget), else timeout_min;
// - a runtime proof: proof_timeout_s (verify runs the proofs in batches that each fit one call);
// - a negative control: the setup (when set), the baseline and the mutated run, each bounded by proof_timeout_s,
//   all capped by negative_controls_total_min of phase time.

const ONE_CALL_S = 570;
const RUN_GRACE_S = 15;
const run1 = seconds => seconds + RUN_GRACE_S;

const suiteWorstS = suite => (typeof suite.setup_command === 'string' ? 2 : 1) * run1(suite.timeout_min * 60);
const checkWorstS = check => run1((check.budget_min > 0 ? check.budget_min : check.timeout_min) * 60);
const proofWorstS = limits => run1(limits.proof_timeout_s);
function negativeWorstS(limits, setup) {
  const runs = setup ? 3 : 2;
  return Math.min(runs * run1(limits.proof_timeout_s), limits.negative_controls_total_min * 60 + runs * RUN_GRACE_S);
}

module.exports = { ONE_CALL_S, RUN_GRACE_S, run1, suiteWorstS, checkWorstS, proofWorstS, negativeWorstS };
