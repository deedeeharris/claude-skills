# PRD review rubric

Check each requirement against the ISO/IEC/IEEE 29148 properties: necessary,
unambiguous, consistent, complete, singular, feasible, traceable, verifiable.

## Map a gap to `iso_property`

- A vague term with no definition ("fast", "reliable", "secure") -> `ambiguous`.
- No measurable pass/fail condition -> `unverifiable`.
- A requirement with no acceptance criterion -> `missing_acceptance_criteria`
  (at least MAJOR).
- Two requirements conflict with each other -> `inconsistent`.
- An impossible or self-contradictory constraint -> `infeasible`.
- Two active requirements (or acceptance items) that state the same rule, even in
  other words (a paraphrase, the same scenario with renamed terms): not necessary and
  not singular, `iso_property: null`, at least MAJOR. The fix names the one to retire
  (`status: retired` with a rationale) or how to merge them; a duplicate must never be
  frozen with both active.
- A goal with no requirement backing it, an undefined actor or trigger, or personal
  data handled with no stated protection requirement -> `incomplete`.

## Other gaps use `iso_property: null`

Not singular (a requirement bundling more than one need), not traceable, no
out-of-scope section, an unnamed dependency. These are real findings; they are just
outside the six-value ISO mapping above.

## Checks

- **Coverage of the reference request** named by `--against` (the original request the
  PRD was written from), when one is given: every item of the reference request is
  covered by a requirement or explicitly excluded with a reason, and every derived
  requirement's rationale holds. A request item that is neither covered nor excluded
  with a reason -> `incomplete`. A derived requirement (no request item behind it)
  whose stated rationale does not hold is not necessary -> `iso_property: null`.

## Location and evidence

`location.section` is the heading and requirement number the finding belongs to.
`evidence` is the exact sentence quoted from the document, not a paraphrase. A finding
whose evidence cannot be pointed at a specific sentence is not specific enough to
report.
