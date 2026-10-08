"""`/mm repair`: bring an invalid or drifted ledger folder back to a valid,
in-sync state, without guessing and without losing content.

analyze() works on copies in memory. It runs the repair classes in stages
(PLAN 15.2) and records every change as a class with its ids. Where a
choice is ambiguous it asks a numbered question instead of guessing; the
operator answers with --decide <n>=<choice>. A stage runs only when every
question of the earlier stages has an answer, so question numbers stay the
same between runs.

Stages:
  1. shapes: missing top-level keys, `rounds` as a list, foreign row shapes
     (title/due), missing row keys, invented and unknown states, foreign
     decision shapes and id collisions, decisions without a status;
  2. pairs and the wrap-up row: illegal state/blocked pairs, no or several
     wrap-up rows;
  3. drift between ledger.json and HANDOFF.md, entity by entity (rows by
     id, decisions by qid, 0A fields by name, text sections by id). The side
     with the later date wins where both hold an entity; the newer side's
     extra ids are taken; the older side's extra ids are a question;
  4. Section 0A fields, the bare-date `updated`, the wrap-up row last, rows
     whose state their history does not prove (kept, with repair recorded
     as the origin and named in the report), and the generated files.

run() is the command: a dry run on a temp copy that prints the report and a
unified diff (exit 14, or 0 when nothing would change, or 15 with questions),
or --apply under the ledger lock with a verified timestamped backup, a
check of the result and a restore when that check fails.
"""

import copy
import difflib
import json
import pathlib
import shutil
import tempfile

import mm_atomic
import mm_compile
import mm_ledger
from mm_repair_shape import (  # noqa: F401 (re-exported)
    Plan, Question, RepairError, _dates, _decision_shape, _fields, _now, _order, _pairs, _row_shape, _top_level,
    _unproven, _wrapup,
)
from mm_repair_drift import _drift

FILES = ("ledger.json", "HANDOFF.md", "HANDOFF-archive.md", "ROADMAP.html")
CAP_CODES = ("FIELD-OVER-CAP", "SECTION0-OVER-CAP", "CELL-OVER-CAP")


# ---------------------------------------------------------------- stage 1: shapes


# ---------------------------------------------------------------- stage 2: pairs and wrap-up


# ---------------------------------------------------------------- stage 3: drift


# ---------------------------------------------------------------- stage 4: fields, dates, order, files


def analyze(raw, texts: dict, decide: dict) -> Plan:
    """Plan the repair of `raw` (the parsed ledger.json) against `texts`
    (file name -> text, None when absent). Never touches the disk."""
    if not isinstance(raw, dict):
        raise RepairError(11, "ledger.json is not a JSON object; restore it from git or a backup")
    plan = Plan(decide)
    doc = copy.deepcopy(raw)
    _top_level(doc, plan)
    _row_shape(doc, plan)
    _decision_shape(doc, plan)
    stages = (lambda: (_pairs(doc, plan), _wrapup(doc, plan)), lambda: _drift(raw, doc, texts, plan),
              lambda: (_fields(doc, plan), _dates(doc, plan), _order(doc, plan), _unproven(doc, plan)))
    for stage in stages:
        if plan.unanswered:
            break
        stage()
    for n in decide:
        if n > len(plan.questions):
            raise RepairError(2, f"--decide {n}=...: there are only {len(plan.questions)} questions so far; "
                                 "answer the printed questions, then rerun")
    if plan.unanswered:
        return plan
    try:
        mm_ledger.validate_ledger(doc)
    except mm_ledger.LedgerValidationError as exc:
        raise RepairError(11, "repair cannot make this ledger valid; fix these by hand in a copy, then rerun: "
                              + "; ".join(exc.problems))
    for name in ("HANDOFF-archive.md", "ROADMAP.html"):
        expected = mm_compile.render_files(doc).get(name)
        actual = texts.get(name)
        if (actual or "").replace("\r\n", "\n") != (expected or "").replace("\r\n", "\n"):
            plan.note("generated-files", f"{name} {'missing' if actual is None else 'regenerated'}"
                      if expected is not None else f"{name} is not modelled by the ledger (kept)")
    plan.doc = doc
    return plan


def finalize(plan: Plan, raw) -> tuple:
    """The ledger text and generated files the plan writes."""
    doc = plan.doc
    now = _now()
    revision = raw.get("revision") if isinstance(raw.get("revision"), int) else 0
    doc["revision"] = revision + 1
    doc["updated"] = now.isoformat()
    doc["updated_by"] = "mm.py repair"
    doc["dashboard_index"]["Last updated"] = now.strftime("%Y-%m-%d %H:%M") + " by mm.py repair"
    doc.pop("compile_record", None)
    files = mm_compile.render_files(doc)
    mm_compile.record_compile(doc, files, doc["revision"])
    mm_ledger.validate_ledger(doc)
    return mm_ledger.ledger_text(doc), files


def read_folder(folder: pathlib.Path) -> dict:
    return {name: (folder / name).read_bytes() for name in FILES if (folder / name).is_file()}


def texts_of(data: dict) -> dict:
    return {name: data[name].decode("utf-8", errors="replace") if name in data else None for name in FILES}


def write_result(folder: pathlib.Path, ledger_text: str, files: dict) -> None:
    mm_atomic.atomic_write_text(folder / "ledger.json", ledger_text, encoding="utf-8", newline="\n")
    mm_atomic.atomic_write_many([(folder / name, text) for name, text in files.items()])


class RestoreError(RuntimeError):
    """The restore after a failed write did not complete; `problems` names
    each file that is not back to its original bytes, `left` the (name,
    status) of each file the backup does not hold that was left in place
    (see restore())."""

    def __init__(self, problems: list, left=()):
        super().__init__("; ".join(problems))
        self.problems = problems
        self.left = list(left)


def backup(folder: pathlib.Path, data: dict, kind: str) -> pathlib.Path:
    """A new, never reused backups/<YYYYMMDD-HHMMSS>-<kind>[-n]/ holding
    `data`, each file verified byte-equal after writing."""
    target = mm_atomic.exclusive_dir(folder / "backups", f"{_now().strftime('%Y%m%d-%H%M%S')}-{kind}")
    for name, content in data.items():
        (target / name).write_bytes(content)
        if (target / name).read_bytes() != content:
            raise RepairError(1, f"the backup of {name} did not verify; nothing written")
    return target


def restore(folder: pathlib.Path, data: dict, backup_dir: pathlib.Path, keep=(), created=None) -> list:
    """Put every file back to the bytes of the verified backup: each file is
    written to a temp file beside it, fsynced and swapped in with os.replace,
    then read back and compared. A file the backup does not hold is removed
    only when this run provably wrote it: `created` (an mm_atomic.journal()
    of the run's writes) records it, and the file on disk still has the
    recorded identity, including a real file id (mm_atomic.write_status()
    "match"). Any other such file is left in place, and so is one named in
    `keep`; neither is ever deleted. Returns (name, status) for each file
    left in place that is not in `keep`, status being "unrecorded",
    "changed" or "unproven". The identity check and the removal are two
    steps: a file replaced between them is removed (a known residual).
    Every file is attempted; RestoreError names each one that failed."""
    problems, left = [], []
    for name in FILES:
        path = folder / name
        try:
            if name not in data and name in keep:
                continue
            if name in data:
                saved = (backup_dir / name).read_bytes()
                if saved != data[name]:
                    raise OSError(f"the backup copy {backup_dir / name} no longer matches the original")
                mm_atomic.atomic_write_bytes(path, saved)
                if path.read_bytes() != saved:
                    raise OSError("the restored bytes did not verify")
            elif path.exists():
                status = mm_atomic.write_status(created, path)
                if status == "match":
                    path.unlink()
                else:
                    left.append((name, status))
        except Exception as exc:
            problems.append(f"{name}: {exc}")
    if problems:
        raise RestoreError(problems, left)
    return left


def acceptable(code: int, lines: list) -> bool:
    """check exit 0, or 3 when every finding is a size cap (the ratchet rule
    keeps an over-cap folder working)."""
    fixes = [line for line in lines if line.startswith("FIX ")]
    return code == 0 or (code == 3 and bool(fixes) and all(line.split()[1].rstrip(":") in CAP_CODES
                                                          for line in fixes))


def unified_diff(before: dict, after: dict) -> list:
    out = []
    for name in FILES:
        old, new = before.get(name), after.get(name)
        if old == new:
            continue
        a = (old or b"").decode("utf-8", errors="replace").replace("\r\n", "\n").splitlines(keepends=True)
        b = (new or b"").decode("utf-8", errors="replace").replace("\r\n", "\n").splitlines(keepends=True)
        out.extend(difflib.unified_diff(a, b, fromfile=f"a/{name}" if old is not None else "/dev/null",
                                        tofile=f"b/{name}" if new is not None else "/dev/null"))
        if out and not out[-1].endswith("\n"):
            out[-1] += "\n"
    return out


def dry_run_copy(folder: pathlib.Path, write) -> tuple:
    """Copy the task's files to a temp dir, let `write(tmp)` change the copy,
    and return (before, after) bytes. The real folder is only read."""
    before = read_folder(folder)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="mm-dry-run-"))
    try:
        task = tmp / folder.name
        task.mkdir()
        for name, content in before.items():
            (task / name).write_bytes(content)
        result = write(task)
        return before, read_folder(task), result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def load_raw(data: dict):
    if "ledger.json" not in data:
        raise RepairError(4, "no ledger.json here")
    try:
        return json.loads(data["ledger.json"].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RepairError(11, f"ledger.json is not JSON ({exc}); restore it from git or from a backup")
