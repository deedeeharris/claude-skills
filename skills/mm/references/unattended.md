# Unattended mode: the complete loop contract

Load this for `/mm loop on`, `/mm loop off`, `/mm loop status`, and for every `mm tick <task dir>` prompt (Section 5 of SKILL.md).

This file is the whole loop contract. It does not depend on any host instruction file: nothing needs to live in CLAUDE.md or AGENTS.md, and a machine whose instruction files say nothing about loops, or something different, runs the same loop. Where a host file does conflict, item 10 decides.

In unattended mode the PM still orchestrates and never builds. The invariants and the approval table of SKILL.md apply unchanged; this file adds how a loop starts, ticks and stops.

## Contents
- The contract, item by item
- Switching it on
- One tick
- Switching it off
- Hosts without an in-session cron
- The hard-stop list

## The contract, item by item

1. One-line cron argument. The scheduled prompt is exactly `mm tick <absolute task dir>`. There is no multi-paragraph prompt and no per-task LOOP.md; everything a tick needs is in this file and in the ledger.
2. Single cron owner. Before creating a cron, run `CronList`. If a cron with the same `mm tick <dir>` prompt exists, adopt it instead of creating a second one. Every tick deduplicates again, because crons live only as long as their session and a resumed session can leave copies: keep the recorded cron id, `CronDelete` the other copies, and if the recorded id is gone, `CronCreate` one and record it. Pass the `CronList` result to `mm.py loop tick --begin --crons-file <json>`; it prints which crons to keep, delete or create. The tick report says what was deduplicated.
3. Liveness. In-flight dispatches are judged only by `mm.py launch-check`: the launch command record naming this dispatch's prompt copy after the launch time plus an assistant tool_use in the chain that record started, then a real babysitter run (processId not `bare-run`) that a `run:create` call in that chain returned, then journal growth; a journal that stops growing past the stall limit (60 min by default) is DEAD; for Codex, a `turn.started` event. Never by transcript mtime, file times in general, or a bare run folder.
4. No-op counter with auto-pause. Each tick records `noop` or `productive`. The 5th consecutive no-op (the cap is recorded at loop on; 5 by default) turns the loop off: `mm.py loop tick` prints `MM-LOOP-OFF`, and the PM then runs `CronDelete` and notifies. A productive tick resets the counter. A failing `mm.py check` also turns the loop off (`--result stopped --reason "check failed: <why>"`), with the reason recorded.
5. Loop state in the ledger. The state lives in the ledger's `loop` object and is rendered as `### Loop` at the end of Section 0B. There is no per-task LOOP.md and no separate loop state file. The object holds: mode (off or unattended), approved_by and approved_at, the approved routes, cadence, cron id and owner session, the no-op count and cap, the last tick (time, result, report), the notifier, and the host-rule answers. The HANDOFF line reads like `Loop: unattended | routes bg-it:sonnet | no-ops 2/5 | last tick <time> noop`.
6. Per-task approved route/model list. The operator approves it once, at loop on, as `<route>:<model>` pairs. Inside the list the PM dispatches alone: `mm.py dispatch` checks the pair and exits 9 for anything outside it; in unattended mode `--approved-by` never adds to the list. Anything outside the list waits for the operator. The dispatch row of the approval table in SKILL.md names the one exception; its record is `mm.py dispatch ... --operator-exception <operator> --exception-reason "<the operator's words>"`, kept under `exception` in the dispatch record. Changing the list is operator-only, through `loop on` again in an attended session.
7. Irreversible hard-stop list. The list below is the same as in SKILL.md. Such actions are never taken in unattended mode; the tick notifies and waits, and the action stays on the operator's queue.
8. Optional notifications. If the overlay or `loop on --notifier` names a notifier (for example a messaging skill), tick reports and loop stops go through it; the approval table in SKILL.md is what allows that. Otherwise, or if it fails, they stay in chat and in the ledger. A notifier is never required; a failed notification is noted in the next tick report and never stops the loop.
9. Per-tick report. Every tick ends with a short tick report: printed in chat, saved in `loop.last_tick.report`, and sent to the notifier if there is one. It gives the task, the row worked on, the action taken or 'no-op: <why>', each in-flight dispatch with its liveness verdict, the no-op count as n/5, blockers waiting for the operator, the cron deduplication done, and the next planned action. `mm.py loop tick --result ...` builds it from its options.
10. Conflicting host rules. At loop on, the PM reads the host instruction files in scope (CLAUDE.md and AGENTS.md in the repo and in the home folder) for loop rules: a mandated launch prefix, cloud scheduling, a per-task LOOP.md, a different cadence or no-op cap, a required notifier.
    - It names each conflict: the source file and line, the host rule, and this contract's rule.
    - The operator's explicit instruction decides. The PM asks through the question protocol and records the answer: `mm.py loop on --host-rule "<source>: <conflict> => <answer>"`.
    - Ticks follow the recorded answers. A conflict met later with no recorded answer and no explicit instruction in the session is treated as a hard stop for that point: notify, and take no action on it.

## Switching it on (`/mm loop on`, attended only)

1. The task must be ledger-based; a legacy folder goes through `/mm migrate` first. `mm.py check` must exit 0 or 3.
2. Read the host instruction files for conflicting loop rules (item 10).
3. Run the question protocol, recommending an answer for each, then wait for the operator's answer on all of them together (loop on is operator-only in the approval table):
   - the approved list of `<route>:<model>` pairs (recommend the smallest list that covers the open rows);
   - the cadence (default 60m, scheduled at minute 7 rather than on the hour);
   - the no-op cap (default 5);
   - the notifier (from the overlay, or none);
   - each host-rule conflict.
4. `mm.py loop on --task-dir <dir> --approved-by <operator> --route <route>:<model> [--route ...] --cadence 60m --noop-cap 5 [--notifier <name>] [--host-rule "..."]`. It prints the one-line cron prompt.
5. `CronList`, then adopt the cron with that prompt, or `CronCreate` it with the cadence.
6. `mm.py loop on --task-dir <dir> --cron-id <id> --owner-session ${CLAUDE_SESSION_ID}` records the owner.
7. Report the loop line and the first tick time.

## One tick (`mm tick <dir>`)

1. `mm.py loop tick --task-dir <dir> --begin [--crons-file <CronList json>]` prints the loop state. If it prints `MM-LOOP-OFF`, run `CronDelete` for this prompt's crons and stop: the tick does nothing else.
2. Deduplicate crons (item 2).
3. `mm.py launch-check` on every in-flight dispatch (item 3). If one is still ALIVE or PENDING, the tick is a no-op ('waiting on <id>'). A DEAD one is recorded and reported; relaunching it counts as a new dispatch on the approved list.
4. Run Update mode (the update reference) without the promotion offer.
5. Pick the first open row that is not the wrap-up row:
   - on the operator queue (NEEDS_DECISION, or a user-facing row waiting for HUMAN_VERIFIED): notify; the tick is a no-op;
   - a local command the PM may run (tests, build, lint, a read-only probe): run it through `mm.py set-row --verify -- <argv>` and record the evidence;
   - work for an agent: draft the prompt from `templates/prompt.md`, then `mm.py dispatch` (it succeeds only for a pair on the approved list), launch it, and run `launch-check` at +20 s;
   - anything else, anything outside the approved list, and anything on the hard-stop list: notify and wait for the operator.
   When the only open row is the wrap-up row, notify that the task is ready to close; closing is attended only.
6. `mm.py loop tick --task-dir <dir> --result noop|productive --row <id> --action "<what>" --next "<next>" --dedup "<what was deduplicated>" [--report-file <notes>]` records the tick, applies the no-op cap, and prints the tick report. It prints `MM-LOOP-OFF` when the cap trips: run `CronDelete` and notify.
7. Send the tick report (item 9).

What a tick may do alone is the Unattended column of the approval table in SKILL.md: it never promotes insights, never runs `--apply` on migrate, repair or close, never changes the approved list, and never edits product code.

## Switching it off

- Operator: `/mm loop off` runs `mm.py loop off --task-dir <dir> --reason "<why>"`, then `CronDelete` for the printed cron id.
- The PM itself turns the loop off only on the no-op cap (item 4) or a failed check.
- `mm.py loop status` shows the state, the approved list, host-rule answers, in-flight dispatches and the last tick report.

## Hosts without an in-session cron

Codex has no in-session cron. On Codex, unattended mode means an OS scheduler that runs `codex exec "mm tick <dir>"` at the cadence. That scheduled job is the single cron owner (record its name with `--cron-id`), and the tick contract is the same; where this file says `CronList`, `CronCreate` or `CronDelete`, the operator manages the scheduler entry. mm never creates OS scheduler entries itself.

## The hard-stop list

Hard-stop list: merge or push to a protected or default branch; force-push; deploy; delete files or data outside the PM folder; send messages to people or to external systems; call billed third-party APIs; change secrets or CI; publish packages; discard unpushed work; spend money.
