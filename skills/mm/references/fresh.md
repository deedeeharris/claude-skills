# Fresh mode: a new task

Load this before the first kickoff question of a new task (Sections 3 and 3.1 of SKILL.md). Nothing is created before the approval table in SKILL.md allows the scaffold, and everything is created by `mm.py scaffold`.

## Kickoff questions

Ask in groups, through the question protocol, and skip anything the operator already said:
1. Goal: the end state, and what 'done' means in checkable terms.
2. Stakeholders: who asks, who answers, who reviews, who verifies user-facing work.
3. Scope: what is in, and what is explicitly out.
4. Constraints: deadlines, environments that are off-limits, things that must not break, earlier decisions to respect.
5. Existing context: research notes, tickets, threads, PR drafts, specs, as paths or links.
6. Schedule: when it should be done (this week, next week, a date), whether that is a hard deadline or a target, and whether it realistically fits.

Convert every schedule answer to absolute values before writing:
- 'this week' or 'next week' becomes the exact week range, using the overlay's week start (for example `2026-10-04 to 2026-10-10`);
- a weekday becomes its date;
- no date at all becomes `none`, `unknown` or `not set`, never vague text.
The answers fill the 0A fields `Target finish date`, `Target week`, `Deadline type`, `Schedule confidence` and `At risk`.

## The proposal

Show the operator, in chat:
- the task name (matching the overlay's task-ID pattern when it has one) and the folder `<repo>/.private/pm/active/<TASK>/`;
- the rows, in order, each marked user-facing when a human must verify it; the wrap-up row is added last automatically;
- the 0A values you will set;
- what gets created: `ledger.json`, the generated `HANDOFF.md` and `ROADMAP.html`, `insights.md`, `inbox/` with its README and `processed/`, and `prompts/` with its README.

Wait for the approval the scaffold row of the approval table in SKILL.md requires.

## Creating it

1. `mm.py scaffold --task-dir <repo>/.private/pm/active/<TASK> --task <TASK> --project <project> --row "<item>" --row "<item>" ...`
   - It prints `MM-SCAFFOLD-OK <dir>`, refuses an existing folder (exit 4), and adds the wrap-up row `Wrap up: insights review + move to done/` as the last row.
   - Pass long or quoted row text through a file: put the scaffold rows in the command, then use `add-row --item-file` for anything awkward.
2. Set the known 0A values in one batch: a JSON file of `{"op": "set-field", "field": "<name>", "value": "<value>"}` entries, then `mm.py batch --task-dir <dir> --file <ops.json>`. Enum fields accept only the values listed in the HANDOFF template reference; a wrong value exits 6.
3. For each user-facing row: `mm.py edit-row --id <id> --user-facing`; set `--test-level` where it is known (none, unit, integration, e2e, manual).
4. Fill Section 0B through `set-field --section 0b --field "<name>"`: `Where I am now`, `Next concrete action`, `Files to read first`, `Active blockers`, `DO-NOT (anti-patterns specific to this task)`.
5. Record kickoff decisions with `add-decision`, and open questions with `set-section --id 3 --text-file <file>`.
6. Bind the session: `mm.py bind --task-dir <dir> --session ${CLAUDE_SESSION_ID}`.
7. `mm.py check --task-dir <dir>` must exit 0.
8. Rebuild the dashboard: `build_pm_dashboard.py --root <repo>` prints `MM-DASHBOARD-OK`.
9. Report the status block (`mm.py status`) and the proposed first action. Dispatching the first row is a separate step with its own approval.

Every step is an `mm.py` write, so each one auto-commits only the task's PM paths (unless the overlay turns auto-commit off) and never pushes.

## What scaffold never does

- It never runs `mm.py migrate`: a new task has no legacy text.
- It never writes outside the task folder, except the dashboard files in `.private/pm/`.
- It never starts an agent.
