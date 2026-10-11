# Proactive scans and notifications

A skill is instructions; it does not run by itself. Use a scheduler that can actually start an assistant with the required tools and private environment. Do not install a cron job that merely prints a prompt and claim it will launch Luna or notify ChatGPT.

## Activation

Bind a schedule to the conversation in which the user asks to activate monitoring. Loading this global skill elsewhere does not create another schedule. A user can move a binding explicitly. Reuse/update a known existing schedule rather than creating duplicates.

Resolve the user's IANA timezone and local scan times. Never substitute the cloud machine's timezone. Keep scheduler prompts generic and reference the private profile; do not embed account/session identifiers, transcripts, or credentials. Follow the selected scheduler's actual API and permissions. A supported template for three daily scans is:

```text
Use claude-cloud-relay to scan the active profile's accessible PM sessions. Use Luna workers for fresh read-only retrieval, then assess which sessions have a current unanswered question, approval request, or blocker requiring the user. Apply profile exclusions, snoozes, checkpoints, reminder rules, and approved automatic-reply rules. Report one concise briefing with evidence and links in the bound conversation. Stay quiet if a complete successful scan has no new actionable items. Report partial access or failed checks explicitly. Do not create or change schedules during this run.
```

For an iCalendar scheduler, convert the actual private timezone/times into a timezone-preserving DTSTART and daily BYHOUR/BYMINUTE rule. Do not paste example times as the user's preference. Persist the resulting automation ID only after a confirmed creation receipt. Mark a schedule enabled only when the scheduler confirms it and the end-to-end check passes.

## Mandatory end-to-end check

Run one real scheduled-context read-only check before enabling recurring monitoring:

1. It loads the installed skill and active private profile on the intended runtime.
2. It can invoke the authenticated CLI without fresh interactive login.
3. It can launch the selected worker model and retrieve a known target.
4. It can persist checkpoints and deduplication state.
5. It can deliver its result to the intended conversation.
6. Its session listing is complete, or the digest explicitly identifies the listing cap and unchecked targets.

If any check fails, report the specific failure and retain `schedule_enabled=false`. Do not create a recurring task with a caveat that access might work later. Request only the missing setup, such as a secret binding or supported scheduled environment.

## A scan iteration

1. Acquire a profile/conversation scan lock; skip overlapping runs instead of duplicating notifications or sends.
2. Discover accessible sessions and record completeness. Apply the private title filter, explicit exclusions, and snoozes.
3. Apply the current-month/year official-source model-selection policy, then read fresh snapshots through the selected supported Luna workers with the configured concurrency and overall deadline. Previously read unchanged sessions can be skipped only if reliable freshness metadata proves they have not changed.
4. Examine the latest relevant conversation turn. A candidate must be a current unanswered question, an explicit approval request, or a blocker that depends on the user. A tool permission dialog must be reported with its native approval route, not answered as ordinary text.
5. Produce an item with session ID/title/link, pending question, evidence UUID/time, confidence, urgency reason, and suggested reply. Do not invent an urgent deadline.
6. Recheck known automatic-reply rules before a send. Empty rules send nothing. Record rule ID and delivery receipt for every automatic send; uncertain delivery must not be retried blindly.
7. Deduplicate using target ID plus the question/evidence digest. A changed question alerts again. An unchanged question alerts only when the selected repeat interval expires. "Changed questions only" means no repetitive reminder.
8. Emit one briefing for new actionable items. Explain failures or incomplete enumeration even when no actionable item could be confirmed. Mark notification history only after actual delivery succeeds.
9. Save private checkpoints and release the lock. Stop at the deadline and list unchecked targets.

Snoozing records a private expiry, not a message to the target. Pause/resume/remove affects the verified bound schedule only. These operations require a scheduler receipt before reporting success.

## Automatic replies

A rule needs an ID, selected targets, an explicit permitted trigger, allowed response/action, exclusions, and an expiry or revocation policy. An approval to support rules without a filled rule is not blanket authorization. Do not approve permission prompts, deployment, deletion, or other material actions unless the user's specific standing authorization covers them and the receiving system supports that approval route. Never fabricate a user's permission.
