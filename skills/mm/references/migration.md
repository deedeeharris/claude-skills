# /mm migrate and /mm repair

Load this for `/mm migrate <task>`, `/mm repair <task>`, a write refused on a legacy folder (exit 4), or a `check` that reports an invalid ledger (exit 11) or drift (exit 1 with HANDOFF-EDITED, LEDGER-AHEAD or UNKNOWN).

## Contents
- Which one
- The shared contract
- Running /mm migrate
- Legacy shapes
- Running /mm repair
- Repair classes
- The direction rule for drift
- Answering questions
- After applying
- Old HANDOFFs without Section 0A

## Which one

| Folder | Tool |
|---|---|
| `HANDOFF.md` and no `ledger.json` (legacy) | `/mm migrate`: a one-time conversion to a ledger task |
| `ledger.json` that fails validation, has invented states or foreign shapes, or disagrees with `HANDOFF.md` | `/mm repair` |
| a ledger folder whose only finding is HEADER-MISSING | nothing: the next `mm.py` write regenerates the file |
| a folder already migrated | `mm.py migrate` exits 4 ('already migrated, use /mm repair') and never rewrites HANDOFF.md |

Migration is operator-run: no hook, tick or update step starts it.

## The shared contract

Both tools default to a dry run on a temporary copy:
1. The task's `ledger.json`, `HANDOFF.md`, `HANDOFF-archive.md` and `ROADMAP.html` are copied to a temp folder.
2. The whole conversion or repair runs there, then validates, compiles and checks.
3. The output is a report (each class found, with counts and ids), a unified diff (`--- a/<file>` / `+++ b/<file>`) of every file that would change, and the result of `check` on the copy.
4. Exit 14: changes pending. Exit 0: nothing to change. Exit 15: a choice is ambiguous; numbered questions are printed. Exit 17: the proposed result fails `check`; the failing lines are printed and it must not be applied.

The real folder is never opened for writing in a dry run.

`--apply` runs only as the approval table in SKILL.md allows. It then:
1. runs `where` (exit 12 when this copy is behind the canonical one);
2. takes the ledger lock (exit 10 when it is held);
3. writes a timestamped backup, `backups/<YYYYMMDD-HHMMSS>-repair/` or `-migrate/`, holding the original files, each verified byte-equal after writing; the folder is always new (a second backup in the same second gets `-2`, `-3`, ...), so no backup is ever overwritten;
4. reruns the same steps on the real folder under the lock;
5. validates, compiles and runs `check`; when the write fails or the result is not acceptable (exit 0, or 3 with only cap findings), it restores every original from the verified backup (temp file, fsync, atomic replace, bytes read back and compared) and exits 1 saying 'restored and verified'. A file the backup does not hold is written without overwrite, so one another writer created after the backup is never replaced (the write fails and the restore runs). It is removed only when the run can prove it wrote it: every write of the run is journaled with the file's identity (device and inode, size, mtime and a SHA-256 of the bytes), the file must still match it, and the platform must give a device and inode. Any other such file is left in place, and the message says why: 'was not written by this run', 'no longer matches this run's recorded write', or 'this platform gives no file id'. If that restore itself fails, it exits 18, never claims the originals are back, and names the backup to copy them from by hand;
6. auto-commits: `mm(<task>): repair <classes>` or `mm(<task>): migrate legacy HANDOFF to ledger`.

## Running /mm migrate

1. `mm.py migrate --task-dir <dir>`: dry run. Show the operator the report and the diff; point out anything the diff reformats (the 0A block and the Section 1 table are re-rendered; prose sections carry through).
2. When the approval table allows it: `mm.py migrate --task-dir <dir> --apply`. It prints `MM-MIGRATE-OK` and the backup path.
3. Migration keeps every content line, row id, decision id and 0A field; it refuses (nothing written) when the result would lose any of them, and names what would be lost.
4. `migrate` asks no questions; `--decide` belongs to `repair`.

## Legacy shapes

Converted, and shown in the dry-run diff:
- Section headings are recognized by number and canonical title in the forms `## Section 1 Status`, `## Section 1 - Status`, `## Section 1 — Status`, `## § 1 Status`, `## § 1 — Status`, and `§` preceded by the stray character a legacy code page adds to it. The output uses `## Section N Title`. A numbered heading with any other title (`## Section 2 Open Questions`) is not a section boundary: it stays text of the section it sits in, as any unknown `##` heading does.
- Loose text in Section 0A: the first line of each 0A field holds its value; every other line of the 0A body (a repeated field, a field-like line with an unknown name, a rationale paragraph, an old-values block such as a `Section 0A-history` heading and its lines) moves verbatim, with its own line endings and blank-line edges, to `HANDOFF-archive.md`, under `## Carried from Section 0A at migration`. It is kept in the ledger's `archive`, so the file is regenerated with it, and Section 4 of HANDOFF.md points to it. The archive, not Section 0B, is the destination because this text is history, and Section 0 has a size cap. The completeness check counts that block, and only that block, as Section 0A output, so every line and field name must still arrive.
- A Section 1 without the wrap-up row gets the standard one, last, as `scaffold` adds it; the report prints a WARNING naming its id.

Refused up front, before any backup or write, and never with 'Safe to re-run --apply':
- `MM-MIGRATE-DUPLICATE-ROW-ID`: two rows use one id; each id is named with its lines. Give each row its own id in HANDOFF.md, then rerun.
- `MM-MIGRATE-STRAY-CR`: a line holds a lone CR byte (0x0D not followed by LF), often a `\r` typed as an escape. The file, the line numbers and an excerpt (the byte shown as `<CR>`) are printed; migrate never guesses a repair. Fix the byte in an editor, then rerun.
- `MM-MIGRATE-NONCANONICAL-SECTION-HEADING`: the 0A body runs into a numbered section heading, indented by up to three spaces or not (`## Section N ...`, `## § N ...` or the code-page form, any N but 0A) whose title is not canonical, such as `## § 1 — Status table`; its block would be carried out of the live HANDOFF as 0A text. Each heading line is named. Rename each to its canonical heading (or, for a block that is no such section, to a heading without a section number), then rerun. Plain `##` headings are carried as 0A text.
- `MM-MIGRATE-ARCHIVE-EXISTS`: 0A loose text needs `HANDOFF-archive.md` and a hand-kept one already exists. Move it aside, then rerun. migrate creates the file exclusively as its first write, so one that appears after the checks is never replaced: migrate stops with the same marker, and nothing is written.

migrate never deletes a file. If a later step fails after it created `HANDOFF-archive.md` (the pre-migration backup, the ledger write, or the archive's own write), the file stays, and the message starts `Partial state:`, names it as written by this migration, and names what was not written. Delete it or move it aside before a rerun; while it is there, a rerun refuses with `MM-MIGRATE-ARCHIVE-EXISTS`. `mm.py migrate --apply` restores the other files from its backup, leaves `HANDOFF-archive.md` in place (it is not in the backup), and says so.

Cap and enum findings (SECTION0-OVER-CAP, FIELD-OVER-CAP, FIELD-OFF-ENUM, CELL-OVER-CAP) and a missing Section 0A stay operator work.

## Running /mm repair

1. `mm.py repair --task-dir <dir>`: dry run. Show the report, the questions if any, and the diff.
2. If it exits 15, answer the questions (next sections), then rerun the dry run with `--decide <n>=<choice>` for each.
3. When the approval table allows it (the final report and diff shown): `mm.py repair --task-dir <dir> --apply [--decide ...]`. It prints `MM-REPAIR-OK applied` and the backup path.
4. A clean, in-sync folder prints `MM-REPAIR-OK nothing to change` and exits 0.

`normalize` and `absorb` are stages inside `repair`, not commands of their own.

## Repair classes

| Class | Fix | Asks when |
|---|---|---|
| invented state NEEDS_FIX, IN_PROGRESS or 'IN PROGRESS' | IMPLEMENTING | never |
| invented state TODO | BACKLOG | never |
| any other unknown state | - | always |
| illegal state/blocked pair | `blocked` on a non-NEEDS_DECISION state becomes NEEDS_DECISION; NEEDS_DECISION with `blocked` false gets `blocked` true | the row is DONE or ABANDONED and blocked |
| missing row keys | defaults: `is_wrapup` (true only for the wrap-up literal), empty `history`, `status_label` from the state, empty text keys | no row, or several rows, carry the wrap-up literal |
| foreign row shape (`due`, `title`) | `item` from `title`, `target_date` from `due`; the originals kept under `legacy` | both `item` and `title` exist and differ |
| foreign decision shape (id, at, by, decision, provenance) | the text kept verbatim so it renders as before; qid, date, who, decision and source filled from the known keys; status IMPORTED | the id collides with another decision's qid |
| `rounds` as a list | `{"max_rounds": 3, "rubric_sha256": "", "residual": [], "history": <the list>}` | never |
| wrap-up row not last | moved to the end | two wrap-up rows |
| bare-date `updated` | ISO time at 00:00 of that date | never |
| ledger ahead | the compile of the repaired ledger replaces HANDOFF.md | see the direction rule |
| HANDOFF ahead | the absorb stage parses the rows, decisions and section text the ledger lacks into it, then compiles | see the direction rule |
| header missing only | compile | never |
| unproven state (`unproven-state`): a row's state is not reached through its recorded history, or a DONE or HUMAN_VERIFIED lacks its evidence (a hand edit of ledger.json, or a ledger from before evidence was required) | a DONE or HUMAN_VERIFIED moves to REVIEW and `status` lists it as needing verification until `set-row --verify` or `--evidence` takes it to DONE again; any other state is kept. A history entry by `mm.py repair` records the origin, and the report names each row before `--apply`. A green that repair would take from a hand-edited HANDOFF.md also lands in REVIEW, reported as `unverified-green`, including a switch between DONE and HUMAN_VERIFIED; only a move the normal rules already prove stays green (a proven HUMAN_VERIFIED taken to DONE) | never |

No class deletes a row or a decision: every decision id in the original ledger or HANDOFF is still there afterwards. Check that in the diff before asking for the yes.

## The direction rule for drift

The ledger and HANDOFF.md are compared entity by entity: rows by id, decisions by qid, 0A fields by name, text sections by id.
- The newer side is the one with the later date: the ledger's `updated` against HANDOFF's 0A `Last updated`.
- The newer side wins for entities that exist on both sides.
- Repair asks when the dates are equal or missing, or when the older side holds an id the newer side lacks (both sides ahead).

## Answering questions

Exit 15 prints numbered questions, each with its options and a recommendation, and writes nothing. Before asking, run the question protocol: read the rows or decisions the question names in both files, so each option says concretely what would be kept and what would change. Ask the operator; never guess. Record each answer as `--decide <n>=<choice>` and rerun the dry run, so the operator sees the final diff before `--apply`.

## After applying

- `mm.py check` must exit 0 (or 3 with only cap findings).
- For a folder far over the caps, run the `mm.py archive` dry run and show the size it would reach; then apply it (an ordinary `mm.py` write).
- Large evidence inside `inbox/` stays where it is; moving it to `evidence/` is a separate operator step.
- `mm.py prune-backups` (dry run) shows old backups beyond the retention cap.
- Rebuild the dashboard.

## Old HANDOFFs without Section 0A

A HANDOFF that still has the single old `Section 0 Session opener` and no `## Section 0A Dashboard Index` cannot be migrated: `mm.py migrate` prints `MM-MIGRATE-NO-SECTION-0A` and writes nothing. The 0A block (field names and order from the HANDOFF template reference; unknown values as `unknown`, `none` or `not set`) must be inserted above the old opener, which becomes Section 0B. The guard blocks edit tools on HANDOFF.md, so this one-time insertion is done by the operator in an editor, or by a shell command the operator approves; then rerun the migrate dry run.
