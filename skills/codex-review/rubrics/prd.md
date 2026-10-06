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
- A goal with no requirement backing it, an undefined actor or trigger, or personal
  data handled with no stated protection requirement -> `incomplete`.

## Other gaps use `iso_property: null`

Not singular (a requirement bundling more than one need), not traceable, no
out-of-scope section, an unnamed dependency. These are real findings; they are just
outside the six-value ISO mapping above.

## Location and evidence

`location.section` is the heading and requirement number the finding belongs to.
`evidence` is the exact sentence quoted from the document, not a paraphrase. A finding
whose evidence cannot be pointed at a specific sentence is not specific enough to
report.
