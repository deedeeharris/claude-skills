# Inbox

Agents report here; the PM reads every entry in Update mode and archives it under `processed/<YYYY-MM>/`. Entries are never deleted.

Write entries with `mm.py inbox-write` when the mm scripts are reachable. Otherwise write the same format by hand.

## File name

`<YYYYMMDD-HHMMSS>-<source>.md`, for example `20260101-093000-builder.md`.

## Frontmatter

```yaml
---
agent: <agent name>
session: <session id>
started: <ISO time>
emitted: <ISO time>
status: in-progress | completed | blocked | error | failed
task_ref: <row id, for example #3>
---
```

## Body: these six sections, in this order

1. `## What was done`
2. `## What's next`
3. `## Blockers`
4. `## Files changed`
5. `## Evidence`
6. `## Notes for PM`

Write an entry at the start and end of each phase, at each long milestone, immediately on a blocker, when you take a fallback, and at the end. Never edit or delete an earlier entry.

Evidence files go under `<task>/evidence/`, not in this folder.
