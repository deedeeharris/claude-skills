# Closing a task, and promoting insights

Load this when the wrap-up row is the next open row, on `/mm close`, or for a promotion pass (Sections 4.8 and 4.9 of SKILL.md).

## Contents
- When closing starts
- Step 1: settle every other row
- Step 2: final update
- Step 3: insights review
- Step 4: promote the selected entries
- Step 5: the status log, when the project keeps one
- Step 6: mm.py close
- Step 7: after the move
- Promotion targets per host
- Memory file format

## When closing starts

The wrap-up row carries the literal `Wrap up: insights review + move to done/`; folders scaffolded before this version may carry `Wrap up: insights review + status.md + move to done/`, and both work. Closing starts when every other row is DONE or ABANDONED, or when the operator says `/mm close`. It runs in attended mode only; an unattended tick that reaches the wrap-up row notifies the operator and stops there.

## Step 1: settle every other row

`mm.py close --task-dir <dir> --operator <name>` is a dry run: it lists every row that is not DONE or ABANDONED and exits 5 while any remain. For each one, ask the operator (question protocol) which applies, with a recommendation:
- it is done: `mm.py set-row --id <id> --state DONE --verify -- <argv>`, or `--evidence human:<name>` for a user-facing row that went through HUMAN_VERIFIED;
- it is deferred: `mm.py retire-row --id <id> --reason "deferred at close: <why>"`. There is no separate deferred state; the reason carries it, and the row is never deleted.

## Step 2: final update

Run Update mode once, so every inbox entry is read, applied and archived before the folder moves. `mm.py close` refuses, writing nothing, while the inbox holds an unprocessed or malformed entry, and lists each one. A malformed entry is fixed, or read and archived by name; deferring an entry is an explicit `mm.py inbox-archive --entry <name>`, never something close does.

## Step 3: insights review

Present the entries of `insights.md` inline in chat, grouped by heading, one line each with its confidence, numbered:

```
User preferences (1):
  1. <entry heading>  [high]
Codebase (2):
  2. <entry heading>  [high]
  3. <entry heading>  [staged]
Mistakes (1):
  4. <entry heading>  [high]
```

Then ask which to promote, recommending the high-confidence ones. Accepted answers: 'all', 'all high', numbers, descriptions, or 'none'. Offer the full body of any entry on request; the file path is a deep-dive route, never the summary itself.

## Step 4: promote the selected entries

Promotion happens only in attended mode, and only for entries the operator selected. For each:
1. Write the memory entry at the target for the host (see 'Promotion targets per host').
2. In `insights.md`, add the line `Promoted: yes -> <file>` to the entry; for entries not selected, add `Promoted: no (<discarded or staged>)`.
3. Set line 1 of `insights.md` to `Last promotion review: <today>`.

`insights.md` is a PM text file, not a generated one: edit it directly.

## Step 5: the status log, when the project keeps one

If the repository keeps a status log of finished tasks (for example `docs/status.md`), that file is product documentation outside the PM folder. Draft the one-line entry (date, task, branch, what shipped with PR and commit citations, follow-ups) and dispatch it, or hand it to the operator; the PM does not write outside its folder. Skip this step when there is no such log.

## Step 6: mm.py close

1. Show the dry run output to the operator: it lists the steps below.
2. When the approval table in SKILL.md allows it: `mm.py close --task-dir <dir> --operator <name> --apply`. It:
   - moves prompt folders such as `.codex-prompts/` under `archive/` and rewrites the ledger citations that pointed into them;
   - sets the wrap-up row DONE with `human:<operator>` evidence, and the 0A `Status` to `done`;
   - renames `insights.md` to `insights_archive_<YYYY-MM-DD>.md`;
   - moves the task folder from `active/` to `done/` (it refuses when `done/<TASK>` already exists);
   - makes one auto-commit holding only what close changed (the ledger and the generated files) and the renames it made, the old paths and the new; a renamed tracked file keeps its committed content, so an untracked file or an uncommitted edit of the operator's that moved along with the folder is never committed and stays untracked or modified at its new place;
   - prints `MM-CLOSE-OK <new path>` once that commit succeeded, or was not needed.
3. Nothing is deleted. Evidence, prompts, envelopes and processed inbox entries move with the folder.
4. The close is journaled. Before its first change it writes `close-journal.json` into the task folder and records each finished step there. If a step fails (a locked file, a full disk), close exits 19 and names the step; fix the cause and rerun the same `--apply`: it reads the journal and carries on from the first unfinished step, and never repeats a finished one. If the journal itself cannot be saved after a step, close exits 19 and names what is on disk (where the folder is and what the journal records); the same rerun finishes it. Right before the folder move and again right before the commit, close scans the inbox again: an entry an agent wrote while close ran stops it with exit 20 and the journal intact; read and archive the entry, then rerun `--apply`. A dry run on a folder with a journal shows the steps done and left. The journal stays until the commit succeeds: when git refuses the commit (a hook, for example), close exits 13 with `MM-CLOSE-UNCOMMITTED`, and a rerun of `--apply` with either the old `active/` path or the new `done/` path makes the commit and removes the journal.
5. Close takes no lock against agents writing to the inbox, so one gap remains: an entry written after the scan right before the commit, while the commit runs, is not read by close, which still prints `MM-CLOSE-OK`. It is caught afterwards. For 14 days after a close (counted from the `updated` stamp close writes to the ledger), `mm.py inbox-scan` on any task of the same PM root lists every file in that closed task's inbox, and every inbox file left under the task's old `active/` path, as `INBOX-CLOSED-TASK <path>` and exits 3. Update mode runs `inbox-scan` first, so the next update reports it; `mm.py inbox-scan --task-dir <done path>` checks one closed task directly at any time; within the 14 days it lists that task's own inbox files and its old `active/` path the same way, each file once. Read the entry, apply its facts with the operator, and archive it with `mm.py inbox-archive --task-dir <done path> --entry <name>` (a file under the old `active/` path is moved into the closed task's `inbox/` first). After 14 days nothing rescans a closed task.

## Step 7: after the move

- `mm.py check --task-dir <done path>` must exit 0.
- Rebuild the dashboard: `build_pm_dashboard.py --root <repo>`; the task leaves the active list.
- `mm.py unbind --session ${CLAUDE_SESSION_ID}`.
- Report: the new path, rows done and deferred, entries promoted and discarded, and anything left for the operator.

## Promotion targets per host

- Claude Code: the memory folder named in the overlay's `paths.memory` (typically the project's auto-memory folder). If the overlay names none, or the folder does not exist, say so and ask where the entries go; mark them `Promoted: pending (no memory folder)` meanwhile.
- Codex: there is no memory folder to write. Propose the exact text of an `AGENTS.md` entry or memory note, and let the operator place it; record `Promoted: yes -> <where the operator put it>` once they confirm.
- Promotion is append-only: never reorganize, prune or deduplicate existing memory files.

## Memory file format

One file per entry, named `<type>_<kebab-slug>.md`, where the type comes from the entry's `Promote-to` field (the operator may override it):

| Type | Use for | Body |
|---|---|---|
| user | the operator's role, goals and domain knowledge | prose |
| feedback | a rule about how to work, a correction or a validated approach | the rule, then a `Why:` line and a `How to apply:` line |
| project | ongoing work or project facts that cannot be derived from the code | the fact, then `Why:` and `How to apply:` lines |
| reference | where information lives in external systems | prose |

The file starts with frontmatter holding `name`, a one-line `description` (used to judge relevance later) and `type`. When the memory folder has an index file (`MEMORY.md`), append one line under about 150 characters: `- [<title>](<file>) - <one-line hook>`.
