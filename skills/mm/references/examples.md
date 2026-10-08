# Worked examples

Load this when you are unsure how a labeled finding, a decisions-log entry, a dispatch recommendation, or an insight entry should read on the page — this file holds one worked example of each.

These are illustrations only; the binding rules live in core Sections 4.2, 4.3, 4.6, and 4.8. Nothing on this page is a rule.

---

## Labeled note — FINDING / HYPOTHESIS / INTERPRETATION (illustrates Section 4.2)

Example of correct labeling:

```
FINDING: Job run abc123 failed at step "deliver" on 2026-04-19 17:01 UTC
         (log trace ID xyz789, CI run page).
HYPOTHESIS: The failure is caused by SFTP TLS reuse, following the same
            pattern as the issue tracked in HANDOFF Section 2c.
            To verify: read all 3 retry attempts in the run log
            and check whether each shows a TLS error before EINVAL.
INTERPRETATION: If the hypothesis holds, this is recurrence of an
                already-escalated issue — escalation channel is
                already open with the vendor (see decision log Q-N).
                Recommended: log a verification entry, do not open
                a new escalation, wait on existing one.
```

---

## Decisions-log entry (illustrates Section 4.3)

Example:

```
Q11: Can the background job run more frequently than once per hour?
- Status: FINAL
- Source: Chat message from Product Lead, 2026-04-30 02:14
- Date: 2026-04-30
- Who: Product Lead
- Decision: "More frequent runs are fine if it resolves the queue buildup."
- Why: Processing SLA is fixed, but higher frequency is OK if it unblocks downstream consumers.
- Alternatives: keep hourly runs and add a second worker (rejected: same quota pool)
```

---

## Dispatch recommendation in chat (illustrates Section 4.6)

Example phrasing, attended mode:

> For #4 (add the retry to the export job) I recommend a background build: route `bg-it`, launched with `/babysitter:yolo`, model sonnet, because it is a multi-step change with tests that can run without questions. The prompt is below and saved at `prompts/04-export-retry.md`. Alternatives: an in-session subagent (`workflow-it`) if you want to watch each step, or a Codex build if you want Claude to review it afterwards. Dispatch as recommended?

The PM records it only after the yes: `mm.py dispatch --route bg-it --model sonnet --prompt-file prompts/04-export-retry.md --approved-by <operator> --row #4`.

---

## Insights entries (illustrates Section 4.8)

Entry format — terse, content-as-heading:

```markdown
## Codebase

### API rate-limit and batch job share same credentials pool

- Confidence: high
- Why future-PM cares: increasing batch concurrency looks unrelated to "API 429 errors" until you see they share the same quota bucket
- Promote-to: project

---

### status=ERROR on validation_check blocks downstream processing

- Confidence: staged
- Why future-PM cares: downgrading to `WARNING` re-introduces broken state silently
- Promote-to: project
```
