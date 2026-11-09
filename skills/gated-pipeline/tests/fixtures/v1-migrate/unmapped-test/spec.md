# Settings page

## Acceptance
- UI-001-AC1: the settings page renders. Proof:

```
node --test test/ui.test.js
```

- UI-001-AC2: the page layout matches the snapshot in test/snapshot.test.js.

## Test plan
Add test/extra.test.js for the empty state.
