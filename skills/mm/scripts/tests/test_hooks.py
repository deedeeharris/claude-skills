import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import ast
import json
import os
import shutil
import subprocess
import tempfile
import unittest

PYTHON = sys.executable
SKILL = pathlib.Path(__file__).resolve().parent.parent.parent
MM_PY = SKILL / "scripts" / "mm.py"
GUARD = SKILL / "hooks" / "guard.py"
PM_STATUS = SKILL / "hooks" / "pm_status.py"
CHECK_HANDOFF = SKILL / "hooks" / "check-handoff.py"
LEGACY_FIXTURE = pathlib.Path(__file__).resolve().parent / "fixtures" / "legacy_task" / "HANDOFF.md"
BANNER = "\U0001f3a9 PM mode | Task: "
MARKER = "MM_CC_RUNTIME_MOD_ACTIVE"


class HookCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, MM_AUTO_COMMIT="off", MM_STATE_DIR=str(self.tmp / "state"),
                        PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
        self.env.pop(MARKER, None)
        self.pm =self.tmp / "proj" / ".private" / "pm" / "active"

    def run_py(self, script, *argv, stdin=""):
        return subprocess.run([PYTHON, str(script), *map(str, argv)], input=stdin, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", env=self.env)

    def scaffold(self, name="widget"):
        task = self.pm / name
        proc = self.run_py(MM_PY, "scaffold", "--task-dir", task, "--task", name, "--project", "smoke-project",
                           "--row", "Row one")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return task

    def legacy(self, name="legacy-widget"):
        task = self.pm / name
        task.mkdir(parents=True)
        shutil.copyfile(LEGACY_FIXTURE, task / "HANDOFF.md")
        return task

    def guard(self, payload):
        return self.run_py(GUARD, stdin=json.dumps(payload))

    def edit(self, path, tool="Edit"):
        return self.guard({"tool_name": tool, "tool_input": {"file_path": str(path), "old_string": "a",
                                                             "new_string": "b"}, "cwd": str(self.tmp)})

    def apply_patch(self, path, shell=False):
        patch = "*** Begin Patch\n*** Update File: %s\n@@\n-old\n+new\n*** End Patch\n" % path
        tool_input = {"command": ["apply_patch", patch]} if shell else {"input": patch}
        return self.guard({"tool_name": "shell" if shell else "apply_patch", "tool_input": tool_input,
                           "cwd": str(self.tmp)})


class GuardTests(HookCase):
    def test_guard_denies_edit_of_ledger_json(self):
        task = self.scaffold()
        before = (task / "ledger.json").read_bytes()
        for tool in ("Edit", "Write", "MultiEdit"):
            proc = self.edit(task / "ledger.json", tool)
            self.assertEqual(proc.returncode, 2, tool)
            self.assertIn("mm guard:", proc.stderr)
            self.assertIn("mm.py", proc.stderr)
        self.assertEqual((task / "ledger.json").read_bytes(), before)

    def test_guard_denies_edit_of_handoff_in_ledger_mode(self):
        task = self.scaffold()
        proc = self.edit(task / "HANDOFF.md")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("is generated from ledger.json by mm.py and never edited by hand; use:", proc.stderr)
        self.assertNotIn("/mm migrate", proc.stderr)
        archive = self.edit(task / "HANDOFF-archive.md", "Write")
        self.assertEqual(archive.returncode, 2)

    def test_guard_denies_edit_of_handoff_in_legacy_folder_and_names_mm_migrate(self):
        task = self.legacy()
        proc = self.edit(task / "HANDOFF.md")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("/mm migrate", proc.stderr)
        self.assertIn("mm.py migrate --task-dir", proc.stderr)

    def test_guard_denies_codex_apply_patch_touching_ledger_json(self):
        task = self.scaffold()
        proc = self.apply_patch(task / "ledger.json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("ledger.json", proc.stderr)
        shell = self.apply_patch(task / "ledger.json", shell=True)
        self.assertEqual(shell.returncode, 2)

    def test_guard_denies_codex_apply_patch_touching_handoff(self):
        task = self.scaffold()
        relative = (task / "HANDOFF.md").relative_to(self.tmp).as_posix()
        proc = self.apply_patch(relative)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("HANDOFF.md", proc.stderr)
        self.assertIn("never edited by hand", proc.stderr)

    def test_guard_denies_edit_of_generated_roadmap_in_ledger_mode(self):
        task = self.scaffold()
        proc = self.edit(task / "ROADMAP.html", "Write")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("ROADMAP.html", proc.stderr)
        legacy = self.legacy()
        allowed = self.edit(legacy / "ROADMAP.html", "Write")
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_when_edit_targets_other_task_files_guard_allows_it(self):
        task = self.scaffold()
        for path in (task / "insights.md", task / "inbox" / "20260101-120000-agent.md",
                     self.tmp / "proj" / "src" / "HANDOFF.md", self.tmp / "proj" / "ledger.json"):
            proc = self.edit(path)
            self.assertEqual(proc.returncode, 0, "%s: %s" % (path, proc.stderr))
            self.assertEqual(proc.stderr, "")

    def test_when_a_write_tools_target_cannot_be_determined_guard_fails_closed(self):
        for payload in ({"tool_name": "Edit", "tool_input": {}},
                        {"tool_name": "Write", "tool_input": {"file_path": 123}},
                        {"tool_name": "MultiEdit", "tool_input": "not an object"},
                        {"tool_name": "NotebookEdit", "tool_input": {"notebook_path": ""}},
                        {"tool_name": "apply_patch", "tool_input": {"input": "no file headers here"}},
                        {"tool_name": "shell", "tool_input": {"command": ["apply_patch", "no headers"]}}):
            proc = self.guard(dict(payload, cwd=str(self.tmp)))
            self.assertEqual(proc.returncode, 2, payload)
            self.assertIn("mm guard:", proc.stderr)
            self.assertIn("cannot tell", proc.stderr)

    def test_when_the_path_check_raises_for_a_write_tool_guard_fails_closed(self):
        wrapper = self.tmp / "guard_boom.py"
        wrapper.write_text("import sys\nsys.path.insert(0, %r)\nimport guard, hookio\n\n\ndef boom(path):\n"
                           "    raise OSError('boom')\n\n\nhookio.pm_task_dir = boom\nsys.exit(guard.main())\n"
                           % str(GUARD.parent), encoding="utf-8")
        edit = json.dumps({"tool_name": "Edit", "tool_input": {"file_path": str(self.tmp / "notes.md")},
                           "cwd": str(self.tmp)})
        proc = self.run_py(wrapper, stdin=edit)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("boom", proc.stderr)

    def test_irrelevant_tools_pass_the_guard_silently(self):
        for payload in ({"tool_name": "Read", "tool_input": {"file_path": "x"}},
                        {"tool_name": "Bash", "tool_input": {"command": "ls"}},
                        {"tool_name": "shell", "tool_input": {"command": ["ls", "-l"]}}):
            proc = self.guard(dict(payload, cwd=str(self.tmp)))
            self.assertEqual(proc.returncode, 0, payload)
            self.assertEqual(proc.stdout + proc.stderr, "")

    def test_when_an_object_event_has_no_string_tool_name_guard_fails_closed(self):
        ledger = str(self.tmp / "proj" / ".private" / "pm" / "active" / "w" / "ledger.json")
        for payload in ({}, {"tool_input": {"file_path": "x"}}, {"tool_input": {"file_path": ledger}},
                        {"tool_name": None, "tool_input": {"file_path": ledger}}, {"tool_name": ""},
                        {"tool_name": 7, "tool_input": {}}, {"tool_name": ["Edit"]},
                        {"hook_event_name": "PreToolUse", "tool_input": {"file_path": ledger}}):
            proc = self.guard(dict(payload, cwd=str(self.tmp)))
            self.assertEqual(proc.returncode, 2, payload)
            self.assertIn("mm guard:", proc.stderr, payload)
            self.assertIn("tool name", proc.stderr, payload)
        for payload in ({"hook_event_name": "PostToolUse", "tool_input": {"file_path": ledger}},
                        {"hook_event_name": "UserPromptSubmit", "prompt": "hello"}):
            proc = self.guard(dict(payload, cwd=str(self.tmp)))
            self.assertEqual(proc.returncode, 0, payload)
            self.assertEqual(proc.stdout + proc.stderr, "")

    def test_when_the_pretooluse_payload_is_unreadable_guard_fails_closed(self):
        truncated = json.dumps({"tool_name": "Edit", "tool_input": {"file_path": "x/.private/pm/active/w/ledger.json"}})
        for stdin in ("not json {{", truncated[:-7], "", "[]", "null", '"Edit"'):
            proc = self.run_py(GUARD, stdin=stdin)
            self.assertEqual(proc.returncode, 2, repr(stdin))
            self.assertIn("mm guard:", proc.stderr, repr(stdin))
            self.assertIn("refused", proc.stderr, repr(stdin))
        proc = subprocess.run([PYTHON, str(GUARD)], input=b"\xff\xfe{", capture_output=True, env=self.env)
        self.assertEqual(proc.returncode, 2)

    def test_guard_help_needs_no_payload_and_exits_0(self):
        for flag in ("--help", "-h"):
            proc = self.run_py(GUARD, flag)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("PreToolUse", proc.stdout)


class PmStatusTests(HookCase):
    def test_pm_status_prints_banner_for_bound_session(self):
        task = self.scaffold()
        bound = self.run_py(MM_PY, "bind", "--task-dir", task, "--session", "sess-bound-1")
        self.assertEqual(bound.returncode, 0, bound.stdout + bound.stderr)
        proc = self.run_py(PM_STATUS, stdin=json.dumps({"session_id": "sess-bound-1", "prompt": "hi"}))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["systemMessage"].startswith(BANNER + "widget"), out)
        self.assertIn("attended", out["systemMessage"])
        context = out["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertIn(str(task), context)
        self.assertIn("mm.py status", context)

    def test_pm_status_prints_nothing_for_unbound_session(self):
        self.scaffold()
        for payload in ({"session_id": "sess-never-bound", "prompt": "hi"}, {"prompt": "no session"}):
            proc = self.run_py(PM_STATUS, stdin=json.dumps(payload))
            self.assertEqual(proc.returncode, 0)
            self.assertEqual(proc.stdout, "")


class RuntimeMarkerTests(HookCase):
    def bound_prompt(self, marker=None, session="sess-bound-1"):
        task = self.scaffold(session)
        bound = self.run_py(MM_PY, "bind", "--task-dir", task, "--session", session)
        self.assertEqual(bound.returncode, 0, bound.stdout + bound.stderr)
        plain = self.run_py(PM_STATUS, stdin=json.dumps({"session_id": session, "prompt": "hi"}))
        if marker is not None:
            self.env[MARKER] = marker
        marked = self.run_py(PM_STATUS, stdin=json.dumps({"session_id": session, "prompt": "hi"}))
        self.assertEqual((plain.returncode, marked.returncode), (0, 0), plain.stderr + marked.stderr)
        return json.loads(plain.stdout), marked

    def test_when_the_marker_equals_the_session_pm_status_omits_system_message_and_keeps_context(self):
        plain, marked = self.bound_prompt(marker="sess-bound-1")
        self.assertIn("systemMessage", plain)
        out = json.loads(marked.stdout)
        self.assertNotIn("systemMessage", out)
        self.assertEqual(out["hookSpecificOutput"], plain["hookSpecificOutput"])
        self.assertIn("mm.py status", out["hookSpecificOutput"]["additionalContext"])

    def test_when_the_marker_names_another_session_pm_status_prints_the_banner(self):
        for marker in ("another-session", "1", ""):
            with self.subTest(marker=marker):
                self.env.pop(MARKER, None)
                plain, marked = self.bound_prompt(marker=marker, session="sess-%d" % len(marker))
                self.assertEqual(json.loads(marked.stdout), plain)
                self.assertTrue(plain["systemMessage"].startswith(BANNER), plain)

    def test_guard_and_check_handoff_never_read_the_marker(self):
        for script in (GUARD, CHECK_HANDOFF):
            self.assertNotIn(MARKER, script.read_text(encoding="utf-8"), script.name)
        task = self.scaffold()
        self.assertEqual(self.run_py(MM_PY, "bind", "--task-dir", task, "--session", "sess-m").returncode, 0)
        edit = {"tool_name": "Edit", "session_id": "sess-m", "cwd": str(self.tmp),
                "tool_input": {"file_path": str(task / "ledger.json"), "old_string": "a", "new_string": "b"}}
        bash = {"tool_name": "Bash", "session_id": "sess-m", "tool_input": {"command": "echo x >> HANDOFF.md"},
                "cwd": str(task)}
        runs = []
        for marker in (None, "sess-m"):
            if marker is None:
                self.env.pop(MARKER, None)
            else:
                self.env[MARKER] = marker
            guard = self.run_py(GUARD, stdin=json.dumps(edit))
            check = self.run_py(CHECK_HANDOFF, stdin=json.dumps(bash))
            runs.append((guard.returncode, guard.stderr, check.returncode, check.stdout))
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[0][0], 2)


class ArchaeologyHookTests(HookCase):
    def test_archaeology_hook_reports_0a_field_over_400_chars(self):
        task = self.legacy()
        handoff = task / "HANDOFF.md"
        text = handoff.read_text(encoding="utf-8")
        long_value = "x" * 401
        lines = [("- Executive note: " + long_value) if l.startswith("- Executive note:") else l
                 for l in text.split("\n")]
        self.assertIn("- Executive note: " + long_value, lines)
        handoff.write_text("\n".join(lines), encoding="utf-8", newline="\n")
        proc = self.run_py(CHECK_HANDOFF, stdin=json.dumps({"tool_name": "Write",
                                                            "tool_input": {"file_path": str(handoff)}}))
        self.assertEqual(proc.returncode, 0)
        context = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Section 0A field 'Executive note' is 401 chars (cap 400)", context)
        cli = self.run_py(CHECK_HANDOFF, "--check", handoff)
        self.assertIn("'Executive note' is 401 chars", cli.stderr)

    def test_when_handoff_is_hand_edited_in_ledger_folder_hook_reports_check_failure(self):
        task = self.scaffold()
        handoff = task / "HANDOFF.md"
        handoff.write_text(handoff.read_text(encoding="utf-8") + "\nhand edit\n", encoding="utf-8", newline="\n")
        proc = self.run_py(CHECK_HANDOFF, stdin=json.dumps({
            "tool_name": "Bash", "tool_input": {"command": "echo x >> HANDOFF.md"}, "cwd": str(task)}))
        self.assertEqual(proc.returncode, 0)
        context = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("mm.py check exited 1", context)

    def test_codex_apply_patch_on_dirty_handoff_is_scanned(self):
        task = self.legacy()
        handoff = task / "HANDOFF.md"
        text = handoff.read_text(encoding="utf-8")
        self.assertIn("## Section 3 Open questions\n", text)
        text = text.replace("## Section 3 Open questions\n", "## Section 3 Open questions\n\npreserved for audit trail\n")
        handoff.write_text(text, encoding="utf-8", newline="\n")
        patch = "*** Begin Patch\n*** Update File: %s\n@@\n+x\n*** End Patch\n" % handoff
        proc = self.run_py(CHECK_HANDOFF, stdin=json.dumps({"tool_name": "apply_patch",
                                                            "tool_input": {"input": patch}}))
        self.assertEqual(proc.returncode, 0)
        self.assertIn("No Archaeology", json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"])


ENTRY_POINTS = (
    ("hooks/guard.py", (), {"tool_name": "Read", "tool_input": {"file_path": "notes.md"}}),
    ("hooks/pm_status.py", (), {"session_id": "sess-never-bound", "prompt": "hi"}),
    ("hooks/check-handoff.py", (), {"tool_name": "Read", "tool_input": {}}),
    ("scripts/mm.py", ("--help",), None),
    ("scripts/build_pm_dashboard.py", ("--help",), None),
    ("scripts/validate_envelope.py", ("--help",), None),
    ("scripts/mm_compile.py", ("--help",), None),
    ("scripts/mm_migrate.py", ("--help",), None),
)


class BytecodeTests(unittest.TestCase):
    def test_when_hooks_and_entry_points_run_from_the_skill_folder_no_pycache_appears_in_it(self):
        env = {k: v for k, v in os.environ.items() if k not in ("PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX")}
        for rel, argv, payload in ENTRY_POINTS:
            with self.subTest(entry=rel):
                tmp = pathlib.Path(tempfile.mkdtemp())
                self.addCleanup(shutil.rmtree, tmp, True)
                copy = tmp / "mm"
                shutil.copytree(SKILL, copy, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
                env.update(MM_AUTO_COMMIT="off", MM_STATE_DIR=str(tmp / "state"), PYTHONIOENCODING="utf-8")
                proc = subprocess.run([PYTHON, str(copy / rel), *argv], input=json.dumps(payload) if payload else "",
                                      capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
                                      cwd=str(tmp))
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertEqual([p.relative_to(copy).as_posix() for p in copy.rglob("__pycache__")], [])

    def copy_skill(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        copy = tmp / "mm"
        shutil.copytree(SKILL, copy, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        env = {k: v for k, v in os.environ.items() if k not in ("PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX")}
        env.update(MM_AUTO_COMMIT="off", MM_STATE_DIR=str(tmp / "state"), PYTHONIOENCODING="utf-8")
        return copy, env

    def run_copy(self, copy, env, *argv):
        return subprocess.run([PYTHON, *argv], capture_output=True, text=True, encoding="utf-8", errors="replace",
                              env=env, cwd=str(copy.parent))

    def test_when_run_all_discovers_tests_from_the_skill_folder_no_pycache_appears_in_it(self):
        copy, env = self.copy_skill()
        tests = copy / "scripts" / "tests"
        for p in tests.glob("test_*.py"):
            if p.name != "test_mm_schema.py":
                p.unlink()
        proc = self.run_copy(copy, env, str(tests / "run_all.py"))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("modules=test_mm_schema", proc.stdout)
        self.assertEqual([p.relative_to(copy).as_posix() for p in copy.rglob("__pycache__")], [])

    def test_when_a_test_file_runs_directly_from_the_skill_folder_no_pycache_appears_in_it(self):
        copy, env = self.copy_skill()
        proc = self.run_copy(copy, env, str(copy / "scripts" / "tests" / "test_mm_schema.py"))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual([p.relative_to(copy).as_posix() for p in copy.rglob("__pycache__")], [])

    def test_when_a_test_file_has_a_main_path_it_sets_the_flag_before_any_skill_local_import(self):
        tests = SKILL / "scripts" / "tests"
        local = {p.stem for p in (SKILL / "scripts").glob("*.py")} | {p.stem for p in tests.glob("*.py")}
        runnable = [p for p in sorted(tests.glob("*.py")) if '__name__ == "__main__"' in p.read_text(encoding="utf-8")]
        self.assertEqual(len(runnable), len(list(tests.glob("test_*.py"))) + 1)
        for path in runnable:
            with self.subTest(file=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                flags = [n.lineno for n in tree.body if isinstance(n, ast.Assign) and ast.unparse(n) ==
                         "sys.dont_write_bytecode = True"]
                imports = [n.lineno for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) and
                           {(a.name if isinstance(n, ast.Import) else n.module or "").split(".")[0]
                            for a in n.names} & local]
                self.assertTrue(flags, "no module-level sys.dont_write_bytecode = True")
                self.assertLess(flags[0], min(imports, default=flags[0] + 1))

    def test_when_mm_compile_or_mm_migrate_is_imported_the_callers_bytecode_setting_is_unchanged(self):
        for module in ("mm_compile", "mm_migrate"):
            with self.subTest(module=module):
                copy, env = self.copy_skill()
                code = "import sys; sys.path.insert(0, %r); import %s; print(sys.dont_write_bytecode)" % (
                    str(copy / "scripts"), module)
                proc = self.run_copy(copy, env, "-c", code)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertEqual(proc.stdout.strip(), "False")


if __name__ == "__main__":
    unittest.main()
