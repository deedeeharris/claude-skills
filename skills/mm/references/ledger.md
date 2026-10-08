# The ledger and the mm.py command set

Load this when you need the row states and transitions, the evidence rules, the size caps, drift diagnosis, the section model, or the exact command for a change (Sections 1, 4.3 and 4.4 of SKILL.md).

## Contents
- The authority chain
- The one write path
- States and transitions
- Evidence
- Row, decision and top-level fields
- Size caps
- Sections and the commands that write them
- Commands
- batch
- Text from files
- Auto-commit
- check and drift
- Exit codes

## The authority chain

`ledger.json` is the only editable source of a task's state. `mm.py` generates `HANDOFF.md`, `HANDOFF-archive.md` and `ROADMAP.html` from it; each starts with the line `<!-- GENERATED from ledger.json by mm.py - do not edit -->`. Nothing flows the other way: a generated file is never parsed back into the ledger, except by the absorb stage of `/mm repair --apply`, which runs only as the approval table in SKILL.md allows.

Every task is ledger-based. A folder with `HANDOFF.md` and no `ledger.json` is a legacy folder: `mm.py` reads it (`status`, `check`, the dashboard) but every write command exits 4 and names `/mm migrate`.

## The one write path

Every write command runs the same steps:
1. `where`: refuse (exit 12) when this worktree copy is behind the canonical copy, and (exit 16) when the copies diverged: two copies at the same revision with different content, or a lower revision that is not in the higher copy's git history; and (exit 21, naming git's first error line) when git itself fails (dubious ownership, a corrupt index) or is not on PATH inside a folder with a .git entry, so neither can be ruled out. Only 'not a git repository' means a single copy;
2. take `ledger.lock` (exit 10 when another writer holds it);
3. load and validate the ledger, including its content check below (exit 11 when it is invalid: run `/mm repair`);
4. refuse (exit 8) when a generated file no longer matches its recorded compile, that is, when it was edited by hand;
5. apply the operation, or every operation of a batch, in memory;
6. validate and check the caps;
7. save the ledger with a revision compare-and-swap (one revision bump per command or batch);
8. write the generated files atomically (exit 7 if this fails after the save: run `mm.py compile`);
9. release the lock;
10. auto-commit the task's PM paths.

`--dry-run` validates and reports without writing. It is taken by exactly these commands: `scaffold`, `add-row`, `edit-row`, `move-row`, `split-row`, `retire-row`, `set-row`, `mark-row`, `add-decision`, `supersede-decision`, `set-field`, `set-section`, `archive`, `batch`, `compile`, `inbox-archive` and `approve-dispatch`.
`archive`, `prune-backups`, `migrate`, `repair` and `close` are dry runs unless given `--apply`.
These write without a dry run, every time they run: `dispatch` (the record and the prompt copy), `inbox-write`, `launch-check` (the verdict), `loop on`, `loop off`, `loop tick`, and `bind` and `unbind` (the session binding, outside the task folder). Check their arguments before running them.

## States and transitions

Twelve states: BACKLOG, INVESTIGATING, NEEDS_DECISION, SPEC_READY, IMPLEMENTING, REVIEW, LOCAL_GREEN, PR_READY, DEV, HUMAN_VERIFIED, DONE, ABANDONED. DONE and ABANDONED are terminal.

| Rule | Refused with |
|---|---|
| any non-terminal state goes to DONE only with evidence | exit 5 |
| `cmd:` evidence must show exit 0 | exit 5 |
| any state goes to HUMAN_VERIFIED only with `human:<name>` evidence | exit 5 |
| a row with `user_facing` true goes to DONE only from HUMAN_VERIFIED | exit 5 |
| ABANDONED needs a reason | exit 5 |
| rows are never deleted; `retire-row` sets ABANDONED with the reason | exit 5 |
| `split-row` retires the parent with the reason `split into <ids>: <reason>` | exit 5 |
| the wrap-up row goes DONE only when every other row is DONE or ABANDONED | exit 5 |
| the wrap-up row cannot be retired, moved, or have a row placed after it | exit 5 |

`blocked` follows NEEDS_DECISION automatically (`mark-row --blocked` or `--unblocked`), and the status glyph and label always follow the state:

| State | Glyph and label |
|---|---|
| BACKLOG | ⚪ Not started |
| ABANDONED | ⚪ Abandoned |
| INVESTIGATING, SPEC_READY, IMPLEMENTING, REVIEW, LOCAL_GREEN, PR_READY, DEV | 🟡 with the state's label |
| NEEDS_DECISION (always blocked) | 🔴 Blocked: needs a decision |
| HUMAN_VERIFIED | 🟢 Human verified |
| DONE | 🟢 Done |

## Evidence

Every transition appends a `history[]` entry with `evidence`, `at`, `by` and `reason`.
- `cmd:<command> exit:<n>`: a command the PM saw run, quoted with its exit code.
- `run by mm: <argv> exit:<n>`: written by `set-row --verify -- <argv>`, which runs the command itself and refuses the transition on a non-zero exit.
- `human:<name>`: a named human's check, taken from the operator's own words.
An agent's report is never evidence on its own: re-run its command with `--verify`, or ask.

## Row, decision and top-level fields

Rows carry `id` (`#<n>`), `item`, `state`, `blocked`, `status_label`, `owner`, `target_date`, `notes_md`, `history`, `is_wrapup`, and optionally `user_facing`, `test_level` (none, unit, integration, e2e, manual), `pr` and `test_page`. Decisions carry `qid` (`Q<n>`), status (TBD, FINAL, REJECTED, REDIRECT, NEEDS CONTEXT, SUPERSEDED, IMPORTED), source, date, who, decision, why and alternatives. Top-level keys include `revision`, `updated`, `dashboard_index` (the 0A fields), `compile_record`, `loop`, `rounds` and `archive`. Unknown keys are preserved, never stripped. Schema version stays 1.

The 0A field names and enum values come from `scripts/mm_schema.py`; the HANDOFF template reference lists the same values, and `set-field` refuses anything else (exit 6).

## Size caps

| Item | Warn | Refused at write | `check` |
|---|---|---|---|
| a 0A value | over 250 chars | over 400 chars (exit 6) | exit 3 over 400 |
| Section 0 (0A and 0B) | over 10 KB | growth past 16 KB (exit 6) | exit 3 over 16 KB |
| a table cell | - | over 600 chars (exit 6) | exit 3 |
| the whole HANDOFF | over 60 KB, pointing to `archive` | - | warning |

A folder already over a cap keeps working: a write that does not grow the oversized part is allowed; a write that grows it is refused. `mm.py archive --keep-done N --keep-decisions N` (dry run, then `--apply`) moves DONE and ABANDONED rows and FINAL or SUPERSEDED decisions to `HANDOFF-archive.md`, after checking nothing is lost.

## Sections and the commands that write them

`mm.py sections --task-dir <dir>` lists every rendered section with its id, kind and writing command (`--json` for a machine-readable list):

| id | Section | Written by |
|---|---|---|
| `title` | `# HANDOFF — <TASK>` | `set-field --field Task` |
| `0a` | Section 0A Dashboard Index | `set-field` |
| `0b` | Section 0B Session Opener | `set-section --id 0b`, `set-field --section 0b --field <name>` |
| `loop` | `### Loop` at the end of 0B | `loop on`, `loop off`, `loop tick` |
| `1-preamble`, `1-postamble` | text around the Section 1 table | `set-section` |
| `1` | Section 1 Status table | `add-row`, `edit-row`, `move-row`, `split-row`, `retire-row`, `set-row`, `mark-row` |
| `2` | Section 2 Decisions log | `add-decision`, `supersede-decision` |
| `3` | Section 3 Open questions | `set-section --id 3` |
| `4` | Section 4 Archive | `set-section --id 4`; `archive` adds pointer lines |
| `trailing` | text after Section 4 | `set-section --id trailing` |

## Commands

| Command | Purpose |
|---|---|
| `--version` | prints `mm-cli <version>` |
| `scaffold --task-dir --task --project --row ...` | new task folder; wrap-up row last; refuses an existing folder |
| `add-row --item [--user-facing] [--test-level] [--pr] [--test-page] [--owner] [--target-date] [--notes]` | new row before the wrap-up row |
| `edit-row --id [...same options, --not-user-facing]` | reword or update a row; logged in history |
| `move-row --id --before <id> / --after <id>` | reorder; the wrap-up row stays last |
| `split-row --id --item <text> --item <text> ... --reason` | children take the parent's place; the parent is retired |
| `retire-row --id --reason` | ABANDONED with the reason; on a row already ABANDONED it refuses a different reason with exit 2 (use `add-decision` or `edit-row --notes`) and repeating the recorded reason changes nothing. Retiring clears a blocked reason; it stays in history |
| `set-row --id --state [--evidence] [--reason] [--note] [--verify -- <argv>]` | change state under the transition rules; to the row's current state it records nothing, so it refuses `--note`, `--evidence`, `--verify` and (unless blocked) `--reason` with exit 2, even when empty and before a `--verify` command runs: use `add-decision` or `edit-row --notes`. A blocked row keeps its blocked reason unless `--reason` replaces it, logged in history. `--verify` with `--evidence` is refused with exit 2 before anything runs. `--verify` runs under the ledger lock, so another writer meanwhile gets exit 10 |
| `mark-row --id --blocked / --unblocked [--reason]` | block or unblock (NEEDS_DECISION); blocking a blocked row keeps its reason unless `--reason` replaces it, logged in history |
| `add-decision --status --source --date --who --decision --why [--alternatives]` | a decision with the seven fields |
| `supersede-decision --qid --by <qid> --reason` | old decision SUPERSEDED and linked both ways |
| `set-field --field <0A name> --value` / `--section 0b --field <0B name> --value` | replace one value |
| `set-section --id <section id> --text` | replace one text section |
| `sections [--json]` | the section registry |
| `batch --file <ops.json>` | several operations, all or nothing |
| `compile [--accept-ledger]` | regenerate the generated files |
| `check` | read-only validity, drift and cap check |
| `status` | the status block, starting with the banner |
| `archive [--keep-done N] [--keep-decisions N] [--apply]` | move finished rows and old decisions to HANDOFF-archive.md |
| `prune-backups [--keep N] [--apply]` | keep the newest backups per kind (3 by default); deletes only a backup that is fully committed and clean, never one holding untracked files, a symlink or junction, or uncommitted changes, staged or not; `--keep` must be 0 or more |
| `migrate`, `repair` | the migration reference |
| `inbox-write`, `inbox-scan`, `inbox-archive` | the inbox reference |
| `where`, `bind`, `whoami`, `unbind` | copies across worktrees and session binding |
| `loop on / off / status / tick` | the unattended reference |
| `dispatch`, `launch-check` | the dispatch reference |
| `close --operator [--apply]` | the closing reference |

`absorb` and `normalize` are stages of `repair`, not commands; `mm.py absorb` exits 2.

## batch

The file is a JSON array. Each element is `{"op": "<command>", ...}` whose keys are that command's long options without the leading dashes, with hyphens turned into underscores; the `_file` variants are allowed. Example: `[{"op": "set-row", "id": "#2", "state": "DONE", "evidence": "cmd:python -m unittest exit:0"}, {"op": "set-field", "field": "Next agent action", "value": "none"}]`.

Allowed operations: add-row, edit-row, move-row, split-row, retire-row, set-row (without `--verify`), mark-row, add-decision, supersede-decision, set-field, set-section and archive. The operations apply in memory, in order; the first failure stops the batch with its exit code and index, and nothing is written. Success means one lock, one revision bump, one compile and one commit.

## Text from files

Every free-text option `--X` also accepts `--X-file <path>`, read as UTF-8 with one trailing newline stripped: `--item-file`, `--notes-file`, `--reason-file`, `--value-file`, `--text-file`, `--decision-file`, `--why-file`, `--alternatives-file`, `--source-file` and the rest. Giving both forms is a usage error (exit 2). Use the file form for anything with quotes, `$`, backticks or several lines; the text is kept byte for byte.

## Auto-commit

After every write that changes a task folder, `mm.py` commits the paths that command wrote, moved or deleted, and only those, on the current branch, with the message `mm(<task>): <verb> <what>`. Other files in the task folder, such as an operator's own edit to `insights.md`, are never swept in. It never pushes and never skips hooks. It refuses with exit 13, leaving the files written, when anything is already staged (inside the task folder or outside it; the index is left as it was), a merge, rebase, cherry-pick or revert is in progress, HEAD is detached, or a commit hook fails; after a failed staging or commit it unstages what it staged, so the index is again as it found it. Outside a git work tree it does nothing. Turn it off per command with `--no-commit`, per shell with `MM_AUTO_COMMIT=off`, or per machine with the overlay's `auto_commit: off`. `build_pm_dashboard.py` commits `DASHBOARD.md`, `DASHBOARD.html` and `dashboard.json`, and nothing else, the same way (`mm(dashboard): rebuild the repo dashboard`, exit 13 on a refusal; `--no-commit` skips it). `status` lists PM changes still uncommitted; the next write commits the files it writes again (the ledger and the generated files), and the operator commits anything else.

## check and drift

`mm.py check` validates the ledger, checks its content, compiles in memory and compares each generated file byte for byte:
- `INVALID STATE-UNRECORDED`, `INVALID HISTORY-BROKEN`, `INVALID GREEN-WITHOUT-EVIDENCE` (exit 1): a row's state is not proven by its own history. Every row starts at BACKLOG, each recorded move must start where the last one ended and the last must end at the row's state, and a move into DONE or HUMAN_VERIFIED needs its evidence (an import by migrate or `/mm repair` counts as the recorded origin). A move without a from or to state is never walked: the row's place after it is unknown until an import records one. Only a hand edit of `ledger.json` breaks this. `compile` and every write then refuse with exit 11, so the edit is never regenerated or committed as legitimate; `/mm repair` names each row, moves an unproven DONE or HUMAN_VERIFIED to REVIEW (listed by `status` as needing verification, so DONE again needs evidence) and keeps any other state.
- `HANDOFF-EDITED` (exit 1): a generated file differs from the recorded compile while the ledger is unchanged; a hand edit, even of one byte. The comparison is on raw bytes, so a line-ending rewrite is a hand edit too. The one exception is the exact form git itself writes on checkout: check asks git whether the file on disk is byte for byte what git would check out (under this repository's `core.autocrlf`, `core.eol` and attributes) of a blob git already holds, and if so compares the content git stores. A rewrite made before git held the content (auto-commit off, or a refused commit), or one that differs in any byte from git's own conversion, is a hand edit. The limit is inherent: a hand rewrite that produces exactly the bytes git's checkout would produce is identical to a checkout and passes, since no byte comparison can tell the two apart. `compile` refuses and names the lost lines; `compile --accept-ledger` overrides after a backup.
- `LEDGER-AHEAD` (exit 1): the file equals an older compile; `compile` regenerates it, unless the content check above failed, in which case check says to run `/mm repair` instead.
- `UNKNOWN` (exit 1): no compile record, which is every folder written before this version; route to `/mm repair`.
- `HEADER-MISSING` (exit 3): identical apart from the missing header line; the next write regenerates it.
- caps, a wrap-up row that is not last, off-enum 0A values, missing 0A fields: exit 3.
- a legacy folder: the read-only round-trip check plus caps, exit 3 with 'legacy folder: run /mm migrate'.
A clean folder prints `MM-CHECK-OK` and exits 0.

## Exit codes

The only copy of the exit-code table is in `mm.py --help`. Read it there; the codes named above are examples.
