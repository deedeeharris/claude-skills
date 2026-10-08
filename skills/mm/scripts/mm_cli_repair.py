"""mm.py repair and migrate: dry run on a temp copy, report and diff, apply with backup and check.
"""

import pathlib
import re
import sys

import mm_atomic
import mm_ledger
import mm_migrate
import mm_repair
from mm_cli import CliError, LEGACY_MESSAGE, _commit, _is_legacy, _task_dir, _where_check
from mm_cli_state import check_report


MIGRATE_CODES = {0: 0, 1: 4, 2: 1, 3: 1, 4: 4, 6: 1, 7: 7, 9: 1, 10: 10, 11: 11, 12: 10, 13: 1, 15: 1, 16: 1,
                 17: 1}
# migrate exits that are refusals made before its first write: there is nothing to restore.
MIGRATE_NOTHING_WRITTEN = (13, 15, 16, 17)


class _MigrateRefused(Exception):
    def __init__(self, code: int):
        super().__init__(f"migrate exited {code}")
        self.code = code


def _decide(args) -> dict:
    out = {}
    for item in args.decide or []:
        m = re.fullmatch(r"\s*(\d+)\s*=\s*(\S.*?)\s*", item)
        if not m:
            raise CliError(2, f"--decide takes <n>=<choice>, for example --decide 1=keep; got {item!r}")
        out[int(m.group(1))] = m.group(2)
    return out


def _print_plan(plan) -> None:
    for line in plan.report():
        print(line)
    for question in plan.questions:
        print(question.render())


def _print_result_check(code: int, lines: list) -> None:
    verdict = "acceptable" if mm_repair.acceptable(code, lines) else "NOT acceptable"
    print(f"check of the result: exit {code} ({verdict})")
    if verdict != "acceptable":
        for line in lines[:20]:
            print(f"  {line}")


def cmd_repair(args) -> int:
    task_dir = _task_dir(args)
    if _is_legacy(task_dir):
        raise CliError(4, LEGACY_MESSAGE)
    decide = _decide(args)
    try:
        return _repair_apply(args, task_dir, decide) if args.apply else _repair_dry_run(task_dir, decide)
    except mm_repair.RepairError as exc:
        raise CliError(exc.code, str(exc))


def _repair_plan(data: dict, decide: dict):
    raw = mm_repair.load_raw(data)
    plan = mm_repair.analyze(raw, mm_repair.texts_of(data), decide)
    _print_plan(plan)
    return raw, plan


def _repair_dry_run(task_dir: pathlib.Path, decide: dict) -> int:
    raw, plan = _repair_plan(mm_repair.read_folder(task_dir), decide)
    if plan.unanswered:
        print(f"MM-REPAIR-QUESTIONS {len(plan.unanswered)} unanswered; nothing written. Ask the operator, then "
              "rerun with --decide <n>=<choice>")
        return 15
    if not plan.classes:
        print("MM-REPAIR-OK nothing to change")
        return 0
    ledger_text, files = mm_repair.finalize(plan, raw)

    def write(copy_dir):
        mm_repair.write_result(copy_dir, ledger_text, files)
        return check_report(copy_dir)

    before, after, (code, lines) = mm_repair.dry_run_copy(task_dir, write)
    sys.stdout.writelines(mm_repair.unified_diff(before, after))
    _print_result_check(code, lines)
    if not mm_repair.acceptable(code, lines):
        return _dry_run_fails_check("REPAIR")
    print("MM-REPAIR-DRY-RUN changes pending; nothing written. Show this report and diff to the operator; "
          "on their yes rerun with --apply")
    return 14


def _dry_run_fails_check(what: str) -> int:
    print(f"MM-{what}-DRY-RUN-FAILS-CHECK the proposed result fails check, so it must not be applied; nothing "
          "written. Show the operator this report and the failing check lines")
    return 17


def _repair_apply(args, task_dir: pathlib.Path, decide: dict) -> int:
    _where_check(task_dir)
    try:
        with mm_ledger.hold_lock(task_dir):
            data = mm_repair.read_folder(task_dir)
            raw, plan = _repair_plan(data, decide)
            if plan.unanswered:
                print(f"MM-REPAIR-QUESTIONS {len(plan.unanswered)} unanswered; nothing written")
                return 15
            if not plan.classes:
                print("MM-REPAIR-OK nothing to change")
                return 0
            ledger_text, files = mm_repair.finalize(plan, raw)
            backup = mm_repair.backup(task_dir, data, "repair")
            _write_checked(task_dir, data, backup, lambda: mm_repair.write_result(task_dir, ledger_text, files))
            written = [backup, task_dir / "ledger.json"] + [task_dir / name for name in files]
    except mm_ledger.LockTimeout:
        raise CliError(10, f"{task_dir / 'ledger.lock'} is held by another writer; nothing written")
    print(f"MM-REPAIR-OK applied; the original files are in {backup}")
    return _commit(args, task_dir, "repair " + ", ".join(plan.classes), written)


def _write_checked(task_dir, data, backup, write, keep=()) -> None:
    """Run `write`, then check the folder; restore the backed-up files when
    either fails. A restore that does not verify exits 18 and never claims
    the originals are back. The run's writes are journaled, so the restore
    removes a file the backup does not hold only when it can prove this run
    wrote it; any other such file, and one named in `keep`, is left in place,
    and the message says why. A file the backup does not hold is created
    without overwrite, so one another writer made after the backup is never
    replaced (mm_atomic.journal())."""
    try:
        with mm_atomic.journal(task_dir / name for name in mm_repair.FILES if name not in data) as created:
            write()
        code, lines = check_report(task_dir)
    except _MigrateRefused as exc:
        raise CliError(MIGRATE_CODES[exc.code], f"migrate refused (its exit {exc.code}) before writing anything, "
                                                f"so nothing was restored; the original files are also in {backup}")
    except Exception as exc:
        left = _restore(task_dir, data, backup, f"writing failed ({exc})", keep, created)
        raise CliError(1, f"writing failed ({exc}); the original files were restored and verified from {backup}"
                          + _kept(task_dir, data, keep) + _left(left))
    if not mm_repair.acceptable(code, lines):
        _print_result_check(code, lines)
        left = _restore(task_dir, data, backup, f"the result failed check (exit {code})", keep, created)
        raise CliError(1, f"the result failed check (exit {code}); the original files were restored and verified "
                          f"from {backup}" + _kept(task_dir, data, keep) + _left(left))


def _kept(task_dir, data, keep) -> str:
    left = [name for name in keep if name not in data and (task_dir / name).exists()]
    return "".join(f"; {name} is not in the backup and was left in place (restore never deletes it: it may not be "
                   f"this run's file). Before a rerun, delete it or move it aside, or the rerun refuses with "
                   f"MM-MIGRATE-ARCHIVE-EXISTS" for name in left)


_LEFT = {"unrecorded": "{} is not in the backup and was not written by this run; left in place",
         "changed": "{} is not in the backup and no longer matches this run's recorded write; left in place",
         "unproven": "{} is not in the backup and matches this run's recorded write, but this platform gives no "
                     "file id (st_dev, st_ino) to prove it is the same file; left in place"}


def _left(left) -> str:
    return "".join("; " + _LEFT[status].format(name) for name, status in left)


def _restore(task_dir, data, backup, cause: str, keep=(), created=None) -> list:
    try:
        return mm_repair.restore(task_dir, data, backup, keep, created)
    except mm_repair.RestoreError as exc:
        raise CliError(18, f"{cause}, and the restore failed ({exc}): the folder may hold a mix of old and new "
                           f"files. Copy the originals back by hand from {backup}, then run mm.py check"
                           + _left(exc.left))


def cmd_migrate(args) -> int:
    task_dir = _task_dir(args)
    if args.decide:
        raise CliError(2, "migrate asks no questions; --decide belongs to repair")
    if (task_dir / "ledger.json").is_file():
        return mm_migrate._existing_ledger(task_dir)
    if not (task_dir / "HANDOFF.md").is_file():
        raise CliError(4, f"no HANDOFF.md at {task_dir}")
    if not args.apply:
        return _migrate_dry_run(task_dir)
    _where_check(task_dir)
    try:
        with mm_ledger.hold_lock(task_dir):
            refused = mm_migrate.up_front_refusal(task_dir, (task_dir / "HANDOFF.md").read_bytes())
            if refused:
                raise CliError(MIGRATE_CODES[refused], f"migrate refused (its exit {refused}); nothing written")
            data = mm_repair.read_folder(task_dir)
            backup = mm_repair.backup(task_dir, data, "migrate")

            def write():
                code = mm_migrate.migrate(task_dir, apply=True, pre_migration_backup=False, lock_held=True)
                if code in MIGRATE_NOTHING_WRITTEN:
                    raise _MigrateRefused(code)
                if code != 0:
                    raise RuntimeError(f"migrate exited {code}")

            _write_checked(task_dir, data, backup, write, keep=("HANDOFF-archive.md",))
    except mm_ledger.LockTimeout:
        raise CliError(10, f"{task_dir / 'ledger.lock'} is held by another writer; nothing written")
    print(f"MM-MIGRATE-OK applied; the original files are in {backup}")
    written = [backup] + [task_dir / name for name in ("ledger.json", "HANDOFF.md", "ROADMAP.html",
                                                       "HANDOFF-archive.md") if (task_dir / name).is_file()]
    return _commit(args, task_dir, "migrate legacy HANDOFF to ledger", written)


def _migrate_dry_run(task_dir: pathlib.Path) -> int:
    print(f"dry run on a temp copy of {task_dir}:")
    refused = mm_migrate.up_front_refusal(task_dir, (task_dir / "HANDOFF.md").read_bytes())
    if refused:
        raise CliError(MIGRATE_CODES[refused], f"migrate would fail (its exit {refused}); nothing written")

    def write(copy_dir):
        code = mm_migrate.migrate(copy_dir, apply=True, pre_migration_backup=False)
        return code, (check_report(copy_dir) if code == 0 else (1, []))

    before, after, (code, (check_code, lines)) = mm_repair.dry_run_copy(task_dir, write)
    if code != 0:
        raise CliError(MIGRATE_CODES.get(code, 1), f"migrate would fail (its exit {code}); nothing written")
    sys.stdout.writelines(mm_repair.unified_diff(before, after))
    _print_result_check(check_code, lines)
    if not mm_repair.acceptable(check_code, lines):
        return _dry_run_fails_check("MIGRATE")
    print("MM-MIGRATE-DRY-RUN changes pending; nothing written. Show this report and diff to the operator; "
          "on their yes rerun with --apply")
    return 14
