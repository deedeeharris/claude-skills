---
name: unattended
description: Time-boxed solo mode for an mm task. Trigger on "unattended 60h", "unattended for 10 hours", "work alone for N hours", "go dark for N h", "unattended status", "unattended off". For N hours the PM runs the task alone through mm's loop and the gated pipeline, asks the operator nothing, decides safe questions itself, parks risky ones, may merge and deploy dev behind the full gate, never touches prod, and ends with a return report.
---

# unattended

`unattended <N>h` gives the PM the operator's time, not the operator's authority. For N hours it works the mm task alone. Every rule of `mm` (invariants, approval table, hard-stop list, loop contract in `mm/references/unattended.md`) and of the repo's CLAUDE.md still applies. This skill only adds: a deadline, a decide-or-park rule, a gated dev-merge grant, a notification plan, and a return report.

Defaults baked into this skill: dev merge + dev deploy alone behind the full gate; decide if safe, else park; milestone messages + 12h digest; an mm task is required.

Requires: skills `mm` (with `mm.py loop`) and `gated-pipeline` from this repo. Optional: a notifier (for example the `tg` skill for Telegram) and a `deploy-checks` skill. Without a notifier, every message below is appended to `<T>/evidence/unattended/messages.md` and printed in chat. Without `deploy-checks`, run the checks listed in Section 3 step 4 by hand.

## Commands

| Input | Do |
|---|---|
| `unattended <N>h` (also "for N hours", "go dark N h") | Start a window (Section 1) |
| `unattended status` | Print window line, time left, last tick, return queue count |
| `unattended off`, "stop unattended", "I'm back" | End the window now (Section 5) |
| `mm tick <dir>` while a window is open | One tick (Section 3) |

An operator message in chat during a window gets answered normally. It does not end the window unless it says so. An explicit operator instruction in chat beats this skill.

## 1. Start the window (the last attended moment)

The invocation is the operator's yes to the window itself. Nothing below asks again, with one exception: step 3.

1. **Task.** Resolve the mm task (mm mode router). There is no task: ask once whether to scaffold one (mm Fresh mode), and start nothing until it exists. Run `mm.py where`, `mm.py check` and `mm.py status`. If `check` fails, stop and report: a window never starts on a broken ledger.
2. **Times.** Take the start from the clock (the operator's local time zone). End = start + N hours. Write both as absolute ISO times with an offset. N is greater than 0 and at most 168. A session crontab lives only as long as the session, so the session must stay open; say so in the start message.
3. **Ask now, not later (optional, once).** Collect the open operator questions the next rows will hit: spec open questions, NEEDS_DECISION rows, pending merges. If any exist, ask them in ONE question-protocol call (at most 4, recommendation first). Record each answer with `mm.py add-decision`. The operator may skip it. Anything unanswered is handled by Section 2 during the window. If the loop is not on yet, this same call also asks for the approved `<route>:<model>` list (mm loop on is operator-only).
4. **Loop.** Reuse an existing `loop on` and its routes. Otherwise use the routes from step 3. Then run:
   `mm.py loop on --task-dir <T> --approved-by <operator> [--route ...] --cadence <c> --noop-cap <k> --notifier <notifier or none> --host-rule "unattended skill <start>: window until <end> (N h); dev merge+deploy behind the gate; decide-if-safe-else-park; milestones + 12h digest => granted by <operator>"`
   - Cadence: keep the task's recorded cadence, else 60m.
   - Noop cap k = ceil(8h / cadence), minimum 5. Waiting on a live build is a no-op tick; a 4-6h build must not switch the loop off.
   - Then adopt or create the cron per the loop contract (CronList first, one owner) and record `--cron-id` and `--owner-session`.
5. **Window file.** Write `<T>/evidence/unattended/window.json`: `{start, end, hours, cadence, noop_cap, operator, last_digest_at: start, milestones: [], parked: [], autonomous_decisions: []}`. The ledger stays the source of task state; this file holds only window bookkeeping.
6. **Start message.** Send one message through the notifier (header `[<project>] [PM]`):
   - window start and end in the operator's local time;
   - the rows it plans to work, in order;
   - what it will never do alone (Section 4);
   - "session must stay open".
   Then run the first tick right away.

## 2. Decide or park

When work hits a question that would normally go to the operator, work out the most production-quality answer first (read-only work, files, a subagent if needed). Then:

**Decide alone** only if ALL of these hold:
- it stays inside scope the operator already approved (PRD, frozen spec, a recorded decision);
- it is reversible on dev (a revert or a new pipeline round undoes it), with nothing on prod;
- no money, secret, env var, CI, real data, real SMS or messages to people;
- no change to product behaviour or UX the operator has not approved;
- it is the option the PM would recommend first to the operator anyway.

Record it with `mm.py add-decision --status FINAL --who "PM (autonomous, unattended window until <end>)"` and the full why and alternatives. Add its Q-id to `autonomous_decisions` in window.json.

**Park** everything else:
- `mm.py add-decision --status TBD` with the recommendation and its trade-off.
- Row to NEEDS_DECISION when the state machine allows it; otherwise put the note on the row.
- Add it to `parked` in window.json. Send a milestone message only if it blocks the critical path.
- Then work the next open row. A parked row never stops the window.

When unsure which side applies: park.

## 3. One tick inside the window

Run the mm tick exactly as `mm/references/unattended.md` "One tick" says, with these additions:

1. **Deadline first.** Before anything else: if now >= end, go to Section 5. Do no other work in that tick.
2. **Late-start guard.** Start no new build or design dispatch when less than its expected run time is left (use the task's own past durations, else 3h for a build, 1h for a design). In-flight work keeps running. After the deadline the PM records results but merges nothing.
3. **Work the rows** in the task's own order and rules (for example one build at a time). Code always goes through the gated pipeline: design, then build, then the PM completion check, then verify. Never hand-edit product code.
4. **Dev merge grant.** The PM may merge a PR to the repo's dev or integration branch and deploy that dev environment ONLY when all of these hold:
   - build PASS at a pushed reviewed_sha;
   - the PM completion check re-ran against the real files: HEAD equals origin, the diff equals the allowed paths, every final proof is green, every control went red, the suite is green, and verify printed PASS (assurance: verified), not WEAK, limited or BLOCKED;
   - the PR body passed the repo's text rules (for example the CLAUDE.md grep counts at zero);
   - the merge uses `--match-head-commit <reviewed_sha>`.
   Then run the dev deploy and skill `deploy-checks`: the deploy JOB's conclusion, the image digest equals the merged commit's image, the env count is unchanged, health is 200, and there are no new errors.
   Any red check: stop all further dev merges for the rest of the window, send a milestone message at once, and park the row. No fix-forward and no hand rollback. A fix is a new pipeline round.
5. **Repeat-failure guard.** If the same row comes back BLOCKED or FAIL twice for the same reason, park it with both reasons. Never relaunch it a third time unchanged.
6. **Notify.**
   - A milestone message for each: build PASS, BLOCKED or FAIL; PR opened; merge; deploy-check result; a parked item on the critical path; the loop stopping.
   - A digest when now - last_digest_at >= 12h: done since the last digest, in flight, parked, autonomous decisions, next. Update `last_digest_at`.
   - No per-tick messages.
   - A failed send is noted in the next tick and never stops the window.
7. **Ledger never stale.** Every step updates 0A/0B, the row state and the dispatch close, not only notes. Record each tick with `mm.py loop tick`.

## 4. Never alone, even inside a window

These go straight to `parked`, whatever the window says:
- anything on prod: deploy, env, traffic, data, Terraform apply, secrets;
- a merge or push to main or the default branch; force-push; a branch rename or delete; discarding unpushed work;
- changing secrets, env vars of any environment, CI or deploy workflows, IAM, billing;
- deleting files or data outside the PM folder, except removing a worktree after its PR merged;
- real SMS, email, chat to people, a paid or live third-party call, a purchase;
- a hand test that needs a human or a device: prepare the test instructions, never fake the result;
- widening scope, adding a feature, or changing approved UX copy or behaviour;
- anything the repo's CLAUDE.md, mm's hard-stop list or a recorded decision marks operator-only (for example prod OTP entry or access grants);
- touching processes, ports or worktrees the PM did not start for this task.

Do nothing drastic to keep the window busy. An idle window that parks cleanly is a success. A busy window that breaks dev is a failure.

## 5. End the window

On the deadline, `unattended off`, or the loop stopping by itself (noop cap, failed check):

1. `mm.py loop off --task-dir <T> --reason "unattended window ended: <deadline|operator|noop cap|check failed>"`, then `CronDelete` the cron.
2. Write `<T>/evidence/unattended/<start-date>-return-report.md` with:
   - window start, end and actual stop reason;
   - done: rows moved, PRs, merges, deploys, each with evidence (run id, revision, digest match);
   - in flight: dispatch ids, state, and what to do when each returns;
   - autonomous decisions to review: Q-ids with one line each;
   - return queue: the parked items in priority order, each with the recommendation;
   - anything that went wrong.
3. Send the report through the notifier (short form plus the file, when the notifier supports files) and print it in chat.
4. In-flight builds that finish after the end: record their results in the ledger. Merge nothing. Open a PR only if the operator is back.
