# Spec review rubric

Apply the ISO/IEC/IEEE 29148 properties to spec work items: necessary, unambiguous,
consistent, complete, singular, feasible, traceable, verifiable.

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

Not singular (a work item bundling more than one need), no out-of-scope section, an
unnamed dependency. These are real findings; they are just outside the six-value ISO
mapping above. Traceability gaps are not listed here — see the Traceability check
below, which is the one rule for them and always maps to `incomplete`.

## Checks

- **Traceability to the PRD** named by `--against`, in both directions. A spec work
  item with no PRD requirement behind it, or a PRD requirement no work item covers, is
  an orphan -> `incomplete`.
- **File ownership.** Each work item should name the files it owns. Two work items
  marked as parallel that claim the same file is a conflict -> `inconsistent`.
- **"Done when" must be a runnable command with an expected result.** A done-when
  clause with no command at all is `missing_acceptance_criteria`. A done-when clause
  that names a command but gives no way to tell pass from fail is `unverifiable`.
- **Premises about the existing tree**, when the repo is readable, are checked against
  it. A premise that is impossible or self-contradictory on its own is `infeasible`. A
  premise that contradicts a specific statement elsewhere in the document is
  `inconsistent` — cite both locations as evidence.
- **A ranked cut list.** Its absence is a MINOR finding, not a blocking one.

`location.section` is the work item id or heading. `evidence` is the exact quoted
sentence or line.
