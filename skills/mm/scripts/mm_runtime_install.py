"""Install the optional Claude Code plugin mm-runtime as a copy outside the skill.

Usage:
    python3 <mm>/scripts/mm_runtime_install.py --dest DIR --python PY [--dry-run]

Copies integrations/claude-code/mm-runtime/ of this skill to DIR, leaving out
its tests/ folder, and writes DIR/hooks/mm-config.ts with the absolute
interpreter PY and this skill's scripts/mm.py, each written as a JSON string
literal (json.dumps), so no path character can break the TypeScript. Claude
Code writes generated types into the folder it loads, so the plugin is never
loaded from the skill folder itself.

Refusals (exit 2, nothing written): DIR inside this skill folder or inside
~/.agents (the shared skills tree Codex and agy read too); DIR holding files
that are not an earlier mm-runtime copy; PY not an existing file.

It prints the CLAUDE_CODE_PLUGIN_DIRS entry to add and edits no settings
file: enabling the plugin is the operator's decision. With --dry-run it
prints what it would do and writes nothing.
"""
import argparse
import json
import os
import pathlib
import shutil
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import mm_fence  # noqa: E402

SKILL = pathlib.Path(__file__).resolve().parent.parent
SOURCE = SKILL / "integrations" / "claude-code" / "mm-runtime"
MM_PY = SKILL / "scripts" / "mm.py"
CONFIG = pathlib.PurePosixPath("hooks", "mm-config.ts")
LEFT_OUT = "tests"


class Refused(Exception):
    pass


def config_text(python: str, mm_py: str) -> str:
    return ("// Written by scripts/mm_runtime_install.py of the mm skill; run it again to change these paths.\n"
            "export const PYTHON = %s\nexport const MM_PY = %s\n" % (json.dumps(python), json.dumps(mm_py)))


def plugin_files() -> list:
    """Source files to copy, as POSIX paths relative to the plugin folder."""
    return [p.relative_to(SOURCE).as_posix() for p in sorted(SOURCE.rglob("*"))
            if p.is_file() and p.relative_to(SOURCE).parts[0] != LEFT_OUT]


def _inside(path: pathlib.Path, root: pathlib.Path) -> bool:
    return mm_fence.within(mm_fence.resolved(path), mm_fence.resolved(root))


def check(dest: pathlib.Path, python: pathlib.Path) -> None:
    if _inside(dest, SKILL):
        raise Refused(f"{dest} is inside the skill folder {SKILL}; Claude Code writes generated files into the "
                      "folder it loads, so install the copy outside the skill, e.g. ~/.claude/mm-runtime")
    agents = pathlib.Path(mm_fence.home()) / ".agents"
    if _inside(dest, agents):
        raise Refused(f"{dest} is inside {agents}, the shared skills tree Codex and agy read too; install the copy "
                      "outside it, e.g. ~/.claude/mm-runtime")
    if dest.exists() and not dest.is_dir():
        raise Refused(f"{dest} exists and is not a folder")
    if dest.is_dir() and any(dest.iterdir()):
        try:
            name = json.loads((dest / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")).get("name")
        except (OSError, ValueError, AttributeError):
            name = None
        if name != "mm-runtime":
            raise Refused(f"{dest} holds files that are not an earlier mm-runtime copy; pick an empty or new folder")
    if not python.is_file():
        raise Refused(f"--python {python} is not a file; pass the absolute path of the interpreter mm.py runs with")


def install(dest: pathlib.Path, python: pathlib.Path, dry_run: bool) -> list:
    files = plugin_files()
    text = config_text(str(python), str(MM_PY))
    if dry_run:
        return files
    for rel in files:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / rel, target)
    (dest / CONFIG).write_text(text, encoding="utf-8", newline="\n")
    return files


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="mm_runtime_install.py",
                                     description="install the mm-runtime Claude Code plugin as a copy outside the "
                                                 "skill; edits no settings file")
    parser.add_argument("--dest", required=True, help="the folder to install into, e.g. ~/.claude/mm-runtime")
    parser.add_argument("--python", required=True, help="the absolute path of the interpreter mm.py runs with")
    parser.add_argument("--dry-run", action="store_true", help="print what would be done and write nothing")
    args = parser.parse_args(argv)
    dest = pathlib.Path(os.path.expanduser(args.dest)).resolve()
    python = pathlib.Path(os.path.abspath(os.path.expanduser(args.python)))  # a venv link is kept, not followed
    try:
        check(dest, python)
    except Refused as exc:
        print(f"mm_runtime_install.py: refused, nothing written: {exc}", file=sys.stderr)
        return 2
    files = install(dest, python, args.dry_run)
    verb = "would copy" if args.dry_run else "copied"
    wrote = "would write" if args.dry_run else "wrote"
    print(f"MM-RUNTIME-INSTALL-DRY-RUN {dest}: nothing written" if args.dry_run else f"MM-RUNTIME-INSTALL-OK {dest}")
    print(f"{verb} {len(files)} files from {SOURCE} ({LEFT_OUT}/ left out)")
    print(f"{wrote} {dest / CONFIG}: PYTHON = {json.dumps(str(python))}, MM_PY = {json.dumps(str(MM_PY))}")
    print(f"enable, with the operator's approval: add {dest} to env.CLAUDE_CODE_PLUGIN_DIRS in "
          f"~/.claude/settings.json (append it after '{os.pathsep}' when the variable already has a value); "
          "this script edited no settings file")
    print(f"check: claude plugin validate --strict {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
