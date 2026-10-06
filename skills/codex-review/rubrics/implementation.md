# Implementation review rubric

Report only actionable defects introduced by this change. That means changed lines and
new files. When the scope is an explicit file list, every listed file counts as new.

## Exclude

- Issues on unchanged lines (pre-existing behavior).
- Anything a linter, formatter, or type checker would already catch.
- Style and naming nits.
- "Consider" suggestions with no concrete failing input.

## Categories

- **correctness** — name the input and the wrong result it produces.
- **security** — injection into SQL, a shell, or HTML; a missing authorization check;
  secret exposure; unsafe path handling; unsafe deserialization.
- **data integrity / error handling** — a swallowed error, or a write of unvalidated
  input that nothing upstream validates.
- **concurrency** — a race, a missing lock, an unsafe shared mutation.
- **resource leaks** — a handle, connection, or listener that is never released.
- **contract break** — a change that breaks a caller's reasonable expectation.
- **changed behavior with no test** — behavior changed by this diff with nothing
  exercising the new path; name the specific input that would exercise it and the
  concrete risk if it misbehaves there (not a failure you ran and watched happen —
  one you can point at).

`iso_property` is always `null` for implementation findings; the ISO/IEC/IEEE 29148
properties apply to requirements documents, not code.

For each finding, name the exact input or call path that triggers it, and the concrete
consequence if it misbehaves (wrong value, crash, exposed data) — observed for most
categories, or the specific risk for an untested path. A finding with no such input or
call path to point at does not belong in the output.
