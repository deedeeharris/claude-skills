"""Convert a legacy HANDOFF-only task folder into a ledger task, once.

Usage: python3 <mm>/scripts/mm_migrate.py --task-dir <abs> [--apply]
The operator runs it through `/mm migrate`, which is `mm.py migrate`: that
wrapper dry-runs on a temp copy, prints a report and a unified diff, and on
--apply takes a timestamped backup and the ledger lock before calling
migrate() below.

Before writing anything, migrate proves the ledger it would build is
CONTENT-COMPLETE against the original HANDOFF.md (mm_compile.content_complete):
every line, row id, decision id and Section 0A field must survive. The
generated header is added at the end; the check compares everything after it.

Three legacy shapes are converted, not refused: section headings written as
"\u00a7 N" or with a dash before the title (mm_compile._SECTION_RE; the
output uses the canonical headings); loose text in Section 0A, carried
verbatim to HANDOFF-archive.md (mm_compile.carry_section_0a; the check counts
that block as Section 0A output); and a Section 1 without the wrap-up row,
which gets the standard one, as scaffold adds it. Two shapes are refused up
front, before anything is written: a row id used twice, a lone CR byte
inside a line, and a numbered section heading with a non-canonical title
inside Section 0A (its block would otherwise be carried out of the live
HANDOFF as 0A text).

--apply, in order, all under the ledger lock:
  1. re-hash HANDOFF.md and compare with the hash the completeness check saw
     (TOCTOU guard; a mismatch writes nothing);
  2. refuse a pre-existing HANDOFF.pre-migration.md that is not byte-equal to
     the current HANDOFF.md (a stale backup is never trusted); otherwise
     create it exclusively (O_EXCL: one that appears after the check is never
     replaced, and migrate stops), write it, and verify its bytes by re-reading;
  3. save ledger.json through mm_ledger.save_ledger (revision 0 -> 1), with the
     compile record of the files written next;
  4. write the generated HANDOFF.md and ROADMAP.html (and HANDOFF-archive.md
     when Section 0A text is carried), each starting with the generated header.
If step 4 fails nothing is lost: the ledger holds every line. Recover with
`mm.py compile --task-dir <dir> --accept-ledger`.

A folder that already has ledger.json is never touched: exit 4, or 11 when
that ledger is invalid. Drift in a ledger folder belongs to `/mm repair`.

EXIT CODES (internal; mm.py migrate maps them onto its own table):
  0  applied: ledger.json and the generated files are written.
  1  no HANDOFF.md at the task dir. Nothing written.
  2  the completeness check failed; the report names what would be lost.
  3  no Section 0A Dashboard Index; the folder predates the 0A template.
  4  already migrated (ledger.json exists and is valid); use /mm repair.
  5  dry run OK: migration would succeed; nothing written.
  6  the ledger.json write failed; ledger.json was not persisted. Also: the
     exclusive create or the write of HANDOFF-archive.md failed.
  Once HANDOFF-archive.md is created, no later failure (6, 7, 9) deletes it:
  migrate never deletes a file. The message names it as written by this
  migration and says what to do with it before a rerun.
  7  ledger.json is written; the generated files are not (run mm.py compile
     --accept-ledger).
  9  the HANDOFF.pre-migration.md backup failed to write or to verify. Once
     created it stays (migrate never deletes it), and the message says so.
  10 HANDOFF.md changed between the completeness check and the write.
  11 a stale HANDOFF.pre-migration.md differs from HANDOFF.md, or one appeared
     before migrate's exclusive create of it, or an existing ledger.json is
     invalid (run /mm repair).
  12 the ledger lock is held by another writer.
  13 a Section 1 row id is used by more than one row; the lines are named.
  15 a line holds a lone CR byte (0x0D not followed by LF); the lines are named.
  16 Section 0A text must be carried to HANDOFF-archive.md, and that file
     already exists, or appeared before migrate's exclusive create of it.
     Nothing written.
  17 Section 0A runs into a numbered section heading whose title is not the
     canonical one; the heading lines are named. Nothing written.
"""

import argparse
import contextlib
import hashlib
import os
import pathlib
import re
import sys

if __name__ == "__main__":
    sys.dont_write_bytecode = True
import mm_atomic
import mm_compile
import mm_ledger
import mm_rows
import mm_schema

INBOX_NAME_RE = re.compile(r"^\d{8}-\d{6}-.*\.md$")
# "## Section N ...", "## \u00a7 N ..." or its mojibake, for any section number N.
SECTION_LIKE_RE = re.compile(r"^ {0,3}##\s+(?:Section\s+|\u05b2?\u00a7\s*)(\d+[A-Za-z]?)(?![A-Za-z0-9])", re.IGNORECASE)
PRE_MIGRATION = "HANDOFF.pre-migration.md"


def _make_stdio_safe() -> None:
    # HANDOFF rows carry status glyphs; a legacy console code page cannot
    # encode them. Substitute instead of crashing while reporting.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def _guess_pm_root(task_dir: pathlib.Path) -> str:
    parts = task_dir.parent.parts
    for i, part in enumerate(parts):
        if part == ".private":
            return "/".join(parts[i:])
    return task_dir.parent.as_posix()


def _report(task_dir: pathlib.Path, doc: dict) -> bool:
    rows = doc.get("rows", [])
    by_state = {}
    for row in rows:
        by_state[row["state"]] = by_state.get(row["state"], 0) + 1
    wrapup_present = any(row.get("is_wrapup") for row in rows)

    inbox_dir = task_dir / "inbox"
    inbox_files = sorted(inbox_dir.glob("*.md")) if inbox_dir.is_dir() else []
    violations = [f.name for f in inbox_files if not INBOX_NAME_RE.match(f.name) and f.name != "README.md"]

    print(f"Section 1 rows: {len(rows)} total")
    for state in mm_ledger.STATES:
        if state in by_state:
            print(f"  {state}: {by_state[state]}")
    print(f"Decisions: {len(doc.get('decisions', []))}")
    print(f"Inbox entries found: {len(inbox_files)}")
    print(f"Inbox entries violating the naming convention (<YYYYMMDD-HHMMSS>-<source>.md): {len(violations)}")
    for name in violations:
        print(f"  - {name}")
    print(f"Wrap-up row present: {'yes' if wrapup_present else 'no'}")
    carried = (doc.get("archive") or {}).get("carried_0a_md")
    if carried:
        print(f"Section 0A loose text: {len(carried.splitlines())} lines carried verbatim to HANDOFF-archive.md "
              f"under '{mm_compile.CARRIED_0A_HEADING}'")
    return wrapup_present


def _build_doc(task_dir: pathlib.Path, slices: dict) -> dict:
    task_name = slices["dashboard_index"].get("Task") or task_dir.name
    project_name = slices["dashboard_index"].get("Project") or "unknown"

    doc = mm_ledger.new_ledger(task_name, project_name)
    for field in mm_ledger.DASHBOARD_FIELDS:
        if field in slices["dashboard_index"]:
            doc["dashboard_index"][field] = slices["dashboard_index"][field]

    rows = []
    for row in slices["rows"]:
        row = dict(row)
        row["history"] = [{"at": doc["created"], "from": "BACKLOG", "to": row["state"], "by": "migrate",
                           "note": "imported from HANDOFF glyph"}]
        rows.append(row)
    doc["rows"] = rows
    doc["decisions"] = slices["decisions"]
    doc["passthrough"] = {key: slices.get(key, "") for key in (
        "title_line", "section_0b_md", "section_1_preamble_md", "section_1_postamble_md", "section_1_header_md",
        "section_1_sep_md", "section_3_md", "section_4_md", "trailing_md")}
    doc["pm_root"] = _guess_pm_root(task_dir)
    mm_compile.carry_section_0a(doc, slices.get("section_0a_loose_md", ""))
    return doc


def _add_wrapup_if_missing(doc: dict):
    """Append the standard wrap-up row, as scaffold does, when no row is one. Returns its id, or None."""
    if any(row.get("is_wrapup") for row in doc["rows"]):
        return None
    row = mm_rows.make_row(mm_rows.next_row_id(doc), mm_schema.WRAPUP_LITERAL, owner="PM",
                           notes="last row: run the closing ritual (mm.py close)")
    doc["rows"].append(row)
    return row["id"]


def _stray_cr(handoff_path: pathlib.Path, data: bytes):
    """A lone CR (0x0D not followed by LF) inside a line: one reader splits the line there and
    another does not, so what the line says cannot be proven. Never repaired by guessing."""
    hits = [m.start() for m in re.finditer(rb"\r(?!\n)", data)]
    if not hits:
        return None
    out = [f"MM-MIGRATE-STRAY-CR {handoff_path} holds {len(hits)} lone carriage return byte(s) (CR, 0x0D not "
           "followed by LF) inside a line, shown as <CR>:"]
    for pos in hits:
        start = data.rfind(b"\n", 0, pos) + 1
        end = data.find(b"\n", pos)
        line = data[start:len(data) if end < 0 else end].decode("utf-8", errors="replace")
        at = len(data[start:pos].decode("utf-8", errors="replace"))
        excerpt = line[max(at - 40, 0):at + 40].replace("\r", "<CR>")
        number = data.count(b"\n", 0, pos) + 1
        out.append(f"  line {number}: ...{excerpt}...")
    out.append("Refusing to migrate. Nothing written. Fix each byte in an editor (a CR typed where the text "
               "meant a backslash escape such as \\r is common), then rerun.")
    return "\n".join(out)


def _duplicate_row_ids(text: str, rows: list):
    """Row ids used by more than one Section 1 row, each with the lines that use it."""
    counts = {}
    for row in rows:
        counts[row["id"]] = counts.get(row["id"], 0) + 1
    dups = {rid for rid, n in counts.items() if n > 1}
    if not dups:
        return None
    m = mm_compile._section_matches(text)
    start = m["1"].end() if m["1"] else 0
    end = m["2"].start() if m["2"] and m["2"].start() > start else len(text)
    first = text.count("\n", 0, start) + 1
    lines = {rid: [] for rid in sorted(dups)}
    for number, line in enumerate(text[start:end].split("\n"), first):
        cells = mm_compile._ROW_SPLIT_RE.split(line.strip())
        if line.strip().startswith("|") and len(cells) > 1 and cells[1].strip() in dups:
            lines[cells[1].strip()].append(str(number))
    named = "; ".join(f"{rid!r} on lines {', '.join(found) or 'unknown'}" for rid, found in lines.items())
    return (f"MM-MIGRATE-DUPLICATE-ROW-ID Section 1 uses a row id more than once: {named}. A ledger row id is "
            "unique, and which row keeps the id is the operator's call. Give each row its own id in the "
            "HANDOFF.md, then rerun. Refusing to migrate. Nothing written.")


def _section_headings_in_0a(text: str) -> list:
    """(line number, heading) for each numbered section heading inside the Section 0A body whose title is
    not canonical, outside code fences. A heading numbered 0A (an old-values block such as "Section
    0A-history") belongs to 0A and is not one of them."""
    m = mm_compile._section_matches(text)
    if not m["0a"]:
        return []
    start = text.find("\n", m["0a"].start()) + 1
    end = next((m[k].start() for k in ("0b", "1", "2", "3", "4") if m[k]), len(text))
    if start <= 0 or start >= end:
        return []
    fenced = mm_compile._fenced_line_starts(text)
    found, offset, number = [], start, text.count("\n", 0, start) + 1
    for line in text[start:end].split("\n"):
        heading = line.rstrip("\r")
        hm = SECTION_LIKE_RE.match(heading)
        if (hm and offset not in fenced and hm.group(1).upper() != "0A"
                and not mm_compile.is_section_heading(heading)):
            found.append((number, heading))
        offset += len(line) + 1
        number += 1
    return found


def up_front_refusal(task_dir: pathlib.Path, original_bytes: bytes) -> int:
    """The refusals made before anything else, from the HANDOFF bytes alone: prints the marker and
    returns the exit code, or returns 0. mm.py migrate --apply runs it before taking its backup."""
    handoff_path = task_dir / "HANDOFF.md"
    message = _stray_cr(handoff_path, original_bytes)
    if message:
        print(message)
        return 15
    text = original_bytes.decode("utf-8")
    slices = mm_compile.parse_handoff(text)
    message = _duplicate_row_ids(text, slices["rows"])
    if message:
        print(message)
        return 13
    headings = _section_headings_in_0a(text)
    if headings:
        canonical = ", ".join(mm_compile.SECTION_HEADINGS[k] for k in ("0b", "1", "2", "3", "4"))
        print("MM-MIGRATE-NONCANONICAL-SECTION-HEADING Section 0A runs into numbered section headings whose "
              "titles are not the canonical ones, so their blocks would be read as 0A text and carried out of "
              "the live HANDOFF:")
        for number, heading in headings:
            print(f"  line {number}: {heading}")
        print(f"The operator must rename each one to its canonical heading ({canonical}), or, for a block "
              "that is none of those sections, to a heading without a section number. migrate does not guess "
              "which section a title means. Then rerun. Refusing to migrate. Nothing written.")
        return 17
    archive = task_dir / "HANDOFF-archive.md"
    if slices.get("section_0a_loose_md") and archive.exists():
        print(f"MM-MIGRATE-ARCHIVE-EXISTS Section 0A holds text that migrate carries to {archive}, and that file "
              "already exists, so writing it would replace what it holds. Move it aside (it is not generated "
              "from a ledger), then rerun. Refusing to migrate. Nothing written.")
        return 16
    return 0


def _exclusive_backup_with_verify(source_text: str, dest_path: pathlib.Path):
    """Create dest_path exclusively (FileExistsError when it exists, so another writer's file is never
    replaced), write source_text, then re-read the bytes and compare. An unverified backup is not a
    backup. Returns None, or (what failed, whether the file was created: it then stays, as migrate
    never deletes a file)."""
    try:
        _create_exclusive(dest_path, source_text)
    except _CreatedPartial as exc:
        return f"backup {dest_path} was created, but writing it failed: {exc}", True
    except FileExistsError:
        raise
    except OSError as exc:
        return f"backup {dest_path} could not be created (no file was made): {exc}", False
    source = source_text.encode("utf-8")
    try:
        written = dest_path.read_bytes()
    except OSError as exc:
        return f"backup written to {dest_path} but could not be re-read to verify: {exc}", True
    if written != source:
        return (f"backup verify FAILED -- {dest_path} does not match the source it was copied from "
                f"(re-read length {len(written)} vs source length {len(source)} bytes)"), True
    return None


def _held_backup(task_dir: pathlib.Path, original_bytes: bytes) -> bool:
    """True when HANDOFF.pre-migration.md is there and byte-equal to the original HANDOFF.md."""
    try:
        return (task_dir / PRE_MIGRATION).read_bytes() == original_bytes
    except OSError:
        return False


def _backup_left(backup: pathlib.Path) -> str:
    """The partial-state report for a pre-migration backup this migration created and could not verify."""
    return (f"Partial state: {backup} was created by this migration and is left in place; migrate never deletes "
            "a file. It is not a verified copy of HANDOFF.md. Before a rerun, delete it or move it aside: while "
            "it differs from HANDOFF.md, a rerun refuses with MM-MIGRATE-STALE-BACKUP.")


def _write_handoff(handoff_path: pathlib.Path, handoff_text: str):
    """One atomic write of the generated HANDOFF.md. Returns the exception on
    failure; the caller reports exit 7 (the ledger is already correct)."""
    try:
        mm_atomic.atomic_write_text(handoff_path, handoff_text, encoding="utf-8", newline="\n")
        return None
    except Exception as exc:
        return exc


def _existing_ledger(task_dir: pathlib.Path) -> int:
    try:
        existing = mm_ledger.load_ledger(task_dir)
    except (ValueError, OSError, mm_ledger.LedgerValidationError) as exc:
        print(f"MM-MIGRATE-LEDGER-INVALID ledger.json exists but is invalid ({exc}). "
              "migrate never touches a ledger folder: run /mm repair.")
        return 11
    print(f"MM-MIGRATE-ALREADY-MIGRATED revision={existing.get('revision')} -- ledger.json exists; migrate never "
          "rewrites HANDOFF.md in a ledger folder. For drift or hand edits use /mm repair.")
    return 4


def _stale_backup(task_dir: pathlib.Path, original_bytes: bytes):
    backup = task_dir / PRE_MIGRATION
    if backup.is_file() and backup.read_bytes() != original_bytes:
        return (f"MM-MIGRATE-STALE-BACKUP {backup} exists and differs from the current HANDOFF.md, so it is not a "
                "backup of this content. Move it aside (it may hold an older original), then rerun. Nothing written.")
    return None


def migrate(task_dir, *, apply: bool, pre_migration_backup: bool = True, lock_held: bool = False) -> int:
    task_dir = pathlib.Path(task_dir)
    handoff_path = task_dir / "HANDOFF.md"
    if mm_ledger.is_migrated(task_dir):
        return _existing_ledger(task_dir)
    if not handoff_path.is_file():
        print(f"MM-MIGRATE-NO-HANDOFF no HANDOFF.md found at {handoff_path}", file=sys.stderr)
        return 1

    original_bytes = handoff_path.read_bytes()
    refused = up_front_refusal(task_dir, original_bytes)
    if refused:
        return refused
    original_text = original_bytes.decode("utf-8")
    original_hash = hashlib.sha256(original_bytes).hexdigest()
    slices = mm_compile.parse_handoff(original_text)
    if not slices.get("has_section_0a"):
        print("MM-MIGRATE-NO-SECTION-0A Section 0A Dashboard Index not found. Rebuild Section 0A from the "
              "template in references/handoff-template.md first. Exiting without changes.")
        return 3

    doc = _build_doc(task_dir, slices)
    added_wrapup = _add_wrapup_if_missing(doc)
    completeness = mm_compile.complete_against(original_text, doc)
    if not completeness.passed:
        print("MM-MIGRATE-COMPLETENESS-FAIL -- recompiling the proposed ledger would lose content present in "
              "the original HANDOFF.md. Refusing to migrate. Nothing written.")
        mm_compile._print_completeness_report(completeness)
        return 2

    _report(task_dir, doc)
    if added_wrapup:
        print(f"WARNING: no wrap-up row found in Section 1; migrate adds the standard wrap-up row as "
              f"{added_wrapup}, last, as scaffold does (the closing ritual lands on it).")
    stale = _stale_backup(task_dir, original_bytes) if pre_migration_backup else None
    if stale:
        print(stale)
        return 11
    print("Files that would be written:")
    if pre_migration_backup:
        print(f"  {task_dir / PRE_MIGRATION} (backup of the original, unless an identical one exists)")
    print(f"  {mm_ledger.ledger_path(task_dir)}")
    print(f"  {handoff_path} and {task_dir / 'ROADMAP.html'} (generated)")
    if "carried_0a_md" in (doc.get("archive") or {}):
        print(f"  {task_dir / 'HANDOFF-archive.md'} (generated; holds the carried Section 0A text)")
    if not apply:
        print("MM-MIGRATE-DRY-RUN-OK -- nothing written. Re-run with --apply to confirm.")
        return 5

    try:
        with contextlib.nullcontext() if lock_held else mm_ledger.hold_lock(task_dir):
            return _commit(task_dir, doc, original_bytes, original_hash, pre_migration_backup)
    except mm_ledger.LockTimeout:
        print(f"MM-MIGRATE-LOCKED {task_dir / 'ledger.lock'} is held by another writer; nothing written.",
              file=sys.stderr)
        return 12


class _CreatedPartial(Exception):
    """A file was created exclusively, but writing its content failed; the file stays."""


def _write_and_sync(handle, data: bytes) -> None:
    handle.write(data)
    handle.flush()
    os.fsync(handle.fileno())


def _create_exclusive(path: pathlib.Path, text: str) -> None:
    """Create `path` holding `text`. FileExistsError when it exists already (O_EXCL, so a file another
    writer created after the checks is never replaced); any other OSError from the create leaves no file.
    When the write after the create fails, the file stays (migrate never deletes a file): _CreatedPartial."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0))
    try:
        with os.fdopen(fd, "wb") as handle:
            _write_and_sync(handle, text.encode("utf-8"))
    except OSError as exc:
        raise _CreatedPartial(exc) from exc


def _archive_left(archive: pathlib.Path, expected: str, not_written: str) -> str:
    """The partial-state report for a failure after this migration created HANDOFF-archive.md."""
    try:
        same = archive.read_bytes() == expected.encode("utf-8")
    except OSError:
        same = False
    held = ("It holds only Section 0A text that HANDOFF.md still holds." if same else
            "It no longer holds exactly what migrate wrote (an incomplete write, or another writer changed it): "
            "check it before deciding.")
    return (f"Partial state: {archive} was written by this migration and is left in place; migrate never deletes "
            f"a file. {held} {not_written} Before a rerun, delete {archive} or move it aside: while it is there, "
            "a rerun refuses with MM-MIGRATE-ARCHIVE-EXISTS.")


def _commit(task_dir, doc, original_bytes, original_hash, pre_migration_backup) -> int:
    handoff_path = task_dir / "HANDOFF.md"
    current = handoff_path.read_bytes()
    if hashlib.sha256(current).hexdigest() != original_hash:
        print("MM-MIGRATE-HANDOFF-CHANGED-SINCE-CHECK -- HANDOFF.md was modified between the completeness check "
              "and this write. Refusing to migrate. Nothing written. Re-run to check the current file.",
              file=sys.stderr)
        return 10
    if mm_ledger.is_migrated(task_dir):
        return _existing_ledger(task_dir)
    if pre_migration_backup:
        stale = _stale_backup(task_dir, original_bytes)
        if stale:
            print(stale)
            return 11

    files = mm_compile.render_files(doc)
    mm_compile.record_compile(doc, files, 1)
    # The first write: HANDOFF-archive.md, created exclusively. migrate never deletes it again: a later
    # failure leaves it in place and reports the partial state (_archive_left).
    archive = task_dir / "HANDOFF-archive.md"
    created = False
    unwritten = "ledger.json, HANDOFF.md and ROADMAP.html were not written."
    if "HANDOFF-archive.md" in files:
        try:
            _create_exclusive(archive, files["HANDOFF-archive.md"])
            created = True
        except _CreatedPartial as exc:
            print(f"MM-MIGRATE-ARCHIVE-WRITE-FAILED -- {archive} was created, but writing it failed ({exc}), so it "
                  f"is incomplete. " + _archive_left(archive, files["HANDOFF-archive.md"], unwritten),
                  file=sys.stderr)
            return 6
        except FileExistsError:
            print(f"MM-MIGRATE-ARCHIVE-EXISTS {archive} appeared after the checks, before migrate could create "
                  "it; it is another writer's file and is left as it is. Move it aside, then rerun. Refusing to "
                  "migrate. Nothing written.")
            return 16
        except OSError as exc:
            print(f"MM-MIGRATE-ARCHIVE-WRITE-FAILED -- {archive} could not be created (no file was made): {exc}. "
                  "Nothing written.", file=sys.stderr)
            return 6

    # An identical backup already there is kept; any other file there is refused, never replaced.
    backup = task_dir / PRE_MIGRATION
    if pre_migration_backup and not _held_backup(task_dir, original_bytes):
        try:
            failed = _exclusive_backup_with_verify(original_bytes.decode("utf-8"), backup)
        except FileExistsError:
            tail = _archive_left(archive, files["HANDOFF-archive.md"], unwritten) if created else "Nothing written."
            print(f"MM-MIGRATE-STALE-BACKUP {backup} appeared after the checks, before migrate could create it; it "
                  "is another writer's file and is left as it is. Move it aside (it may hold an older original), "
                  f"then rerun. Refusing to migrate. {tail}")
            return 11
        if failed is not None:
            error, left = failed
            tail = [_archive_left(archive, files["HANDOFF-archive.md"], unwritten) if created else
                    "ledger.json and HANDOFF.md are untouched."]
            if left:
                tail.append(_backup_left(backup))
            elif not created:
                tail.append("Safe to re-run --apply.")
            print(f"MM-MIGRATE-BACKUP-FAILED -- {error}. {' '.join(tail)}", file=sys.stderr)
            return 9

    try:
        saved = mm_ledger.save_ledger(task_dir, doc, expected_revision=0, updated_by="mm.py migrate",
                                      lock_held=True)
    except Exception as exc:
        tail = (_archive_left(archive, files["HANDOFF-archive.md"], unwritten) if created else
                "Safe to re-run --apply.")
        print(f"MM-MIGRATE-LEDGER-WRITE-FAILED -- ledger.json was not persisted: {exc}. {tail}", file=sys.stderr)
        return 6

    written = ["HANDOFF-archive.md"] if created else []
    error = _write_handoff(handoff_path, files["HANDOFF.md"])
    if error is None:
        written.append("HANDOFF.md")
        try:
            mm_atomic.atomic_write_text(task_dir / "ROADMAP.html", files["ROADMAP.html"], encoding="utf-8",
                                        newline="\n")
        except Exception as exc:
            error = exc
    if error is not None:
        missing = [n for n in ("HANDOFF.md", "ROADMAP.html") if n not in written]
        print(f"MM-MIGRATE-HANDOFF-REGEN-FAILED -- ledger.json is correct and durable (revision="
              f"{saved['revision']}); written: {', '.join(written) or 'none'}; not written: {', '.join(missing)}: "
              f"{error}. Nothing is lost: run mm.py compile --task-dir {task_dir} --accept-ledger.", file=sys.stderr)
        return 7
    backup_note = f" pre_migration_backup={task_dir / PRE_MIGRATION}" if pre_migration_backup else ""
    print(f"MM-MIGRATE-OK {saved['task']} revision={saved['revision']}{backup_note}")
    return 0


def main(argv=None) -> int:
    _make_stdio_safe()
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    return migrate(pathlib.Path(args.task_dir).resolve(), apply=args.apply)


if __name__ == "__main__":
    sys.exit(main())
