import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import ast
import re
import unittest

SKILL_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
SKILL_MD = SKILL_DIR / "SKILL.md"
REFS = SKILL_DIR / "references"
BANNER = "\U0001f3a9 PM mode | Task:"
CITED = ["0", "0.5", "1", "2", "2.2", "3", "3.1", "4.3", "4.6", "4.6.1", "4.6.2", "4.7", "4.8", "4.9"]
BARE_LAUNCH = re.compile(r"(?<![A-Za-z0-9:_-])" + "/" + "yolo" + r"\b")
ROUTES = ("bg-it", "workflow-it", "codex-review", "agy", "babysitter:yolo")
LOOP_PHRASES = ("mm tick", "CronList", "CronCreate", "CronDelete", "no-op", "hard-stop", "approved",
                "transcript mtime", "LOOP.md", "conflict", "notifier", "tick report", "launch-check")


def read(path):
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def head_16k():
    return SKILL_MD.read_bytes()[:16000].decode("utf-8", errors="ignore")


def headings(text):
    return set(re.findall(r"^#{2,4}\s+(?:Step\s+)?(\d+(?:\.\d+)*)", text, re.M))


def table_rows(text):
    """Every markdown table row as a list of stripped cells, header and separator rows excluded."""
    rows = []
    for line in text.split("\n"):
        if not line.startswith("|") or re.match(r"^\|[\s:|-]+\|$", line):
            continue
        rows.append([c.strip() for c in line.strip().strip("|").split("|")])
    return rows


def hard_stop_line(text):
    return next((l for l in text.split("\n") if l.startswith("Hard-stop list:")), None)


class InterfaceTests(unittest.TestCase):
    def test_zte_cited_section_headings_exist(self):
        found = headings(read(SKILL_MD))
        self.assertEqual([n for n in CITED if n not in found], [])
        sibling = SKILL_DIR.parent / "zte-dev-loop" / "SKILL.md"
        if sibling.is_file():
            cited = set(re.findall(r"[Ss]ection\s+(\d+(?:\.\d+)*)", read(sibling)))
            self.assertEqual(sorted(cited - found), [])

    def test_banner_string_is_resident(self):
        self.assertIn(BANNER, head_16k())
        hook = read(SKILL_DIR / "hooks" / "pm_status.py")
        self.assertIn("\\U0001f3a9 PM mode | Task: ", hook)
        cli = "".join(read(p) for p in (SKILL_DIR / "scripts").glob("mm*.py"))
        self.assertIn("\\U0001f3a9 PM mode | Task: ", cli)

    def test_hook_symptom_strings_are_resident_in_core(self):
        tree = ast.parse(read(SKILL_DIR / "hooks" / "check-handoff.py"))
        patterns = next(ast.literal_eval(n.value) for n in tree.body
                        if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "patterns")
        self.assertEqual(len(patterns), 5)
        core = read(SKILL_MD)
        for p in patterns:
            self.assertIn("`%s`" % p, core)

    def test_canonical_wrapup_literal_is_in_core(self):
        core = read(SKILL_MD)
        self.assertIn("Wrap up: insights review + move to done/", core)
        self.assertIn("Wrap up: insights review + status.md + move to done/", core)


class LaunchAndRoutingTests(unittest.TestCase):
    def test_no_bare_yolo_launch_anywhere(self):
        hits = []
        for p in sorted(SKILL_DIR.rglob("*")):
            if not p.is_file() or p.name == "mm.local.md" or p.suffix in (".pyc", ".pyo"):
                continue
            for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
                if BARE_LAUNCH.search(line):
                    hits.append("%s:%d" % (p.relative_to(SKILL_DIR).as_posix(), i))
        self.assertEqual(hits, [])
        self.assertIn("/babysitter:yolo", read(SKILL_MD))
        self.assertTrue(BARE_LAUNCH.search("run " + "/" + "yolo x.md"), "the pattern must catch the bare spelling")

    def test_host_table_names_every_route_with_fallback(self):
        text = read(REFS / "dispatch.md")
        self.assertIn("Codex as PM", text)
        self.assertIn("Codex as PM", read(SKILL_MD))
        rows = table_rows(text)
        for route in ROUTES:
            owners = [r for r in rows if len(r) >= 3 and route in r[1]]
            self.assertTrue(owners, "no host-table row names %s as a preferred route" % route)
            for r in owners:
                self.assertNotIn(r[2], ("", "-"), "route %s has no fallback: %r" % (route, r))
        codex = text[text.index("Codex as PM"):]
        codex_rows = [r for r in table_rows(codex) if len(r) >= 3][:3]
        self.assertEqual(len(codex_rows), 3)
        self.assertTrue(all(r[2] not in ("", "-") for r in codex_rows), codex_rows)


class ReferenceShapeTests(unittest.TestCase):
    def test_no_nested_reference_links(self):
        core = read(SKILL_MD)
        refs = sorted(REFS.glob("*.md"))
        self.assertGreaterEqual(len(refs), 11)
        for p in refs:
            text = read(p)
            self.assertNotIn("references/", text, p.name)
            for target in re.findall(r"\]\(([^)#\s]+)\)", text):
                self.assertFalse(target.endswith(".md"), "%s links %s" % (p.name, target))
            self.assertIn("references/" + p.name, core, "orphan reference " + p.name)
            lines = text.split("\n")
            self.assertLessEqual(len(lines), 300, p.name)
            if len(text.splitlines()) > 100:
                self.assertIn("## Contents", "\n".join(lines[:20]), p.name)

    def test_every_skill_relative_path_in_text_exists(self):
        path_re = re.compile(r"(?<![A-Za-z0-9_./~-])((?:references|templates|hooks|scripts)/[A-Za-z0-9_./-]*[A-Za-z0-9_])")
        broken = []
        for p in [SKILL_MD] + sorted(REFS.glob("*.md")) + sorted((SKILL_DIR / "templates").glob("*")):
            for m in path_re.finditer(read(p).replace("${CLAUDE_SKILL_DIR}/", " ")):
                if not (SKILL_DIR / m.group(1)).exists():
                    broken.append("%s -> %s" % (p.name, m.group(1)))
        self.assertEqual(broken, [])

    def test_core_fits_its_caps_and_bold_budget(self):
        raw = SKILL_MD.read_bytes()
        self.assertLessEqual(len(raw), 20000)
        self.assertLessEqual(len(raw.decode("utf-8").splitlines()), 260)
        bold = re.findall(r"\*\*[^*\n]+?\*\*", raw.decode("utf-8"))
        self.assertEqual(len(bold), 5, bold)
        head = head_16k()
        for marker in ("## Invariants", "## Mode router", "## Approval table", "mm.local.md",
                       "Every task is ledger-based", "/mm migrate", "/mm repair"):
            self.assertIn(marker, head)
        self.assertLess(head.index("## Invariants"), head.index("## Mode router"))
        self.assertLess(head.index("## Mode router"), head.index("## Approval table"))
        self.assertIn("${CLAUDE_SKILL_DIR}", raw.decode("utf-8"))


class OperatorContractTests(unittest.TestCase):
    def test_question_protocol_and_precedence_line_are_resident(self):
        head = head_16k()
        self.assertIn("take precedence over this skill", head)
        self.assertIn("exit PM mode", head)
        self.assertIn("most professional move", head)
        self.assertIn("AskUserQuestion", head)
        self.assertIn("recommended option first", head)
        self.assertLess(head.index("take precedence over this skill"), head.index("## Invariants"))

    def test_unattended_reference_carries_complete_loop_contract(self):
        text = read(REFS / "unattended.md")
        for phrase in LOOP_PHRASES:
            self.assertIn(phrase, text)
        self.assertIsNotNone(hard_stop_line(text))
        self.assertEqual(hard_stop_line(text), hard_stop_line(read(SKILL_MD)))
        for item in ("One-line cron argument", "Single cron owner", "Liveness", "No-op counter",
                     "Loop state in the ledger", "approved route/model list", "Irreversible hard-stop list",
                     "Optional notifications", "Per-tick report", "Conflicting host rules"):
            self.assertIn(item, text)
        self.assertIn("5th consecutive no-op", text)
        self.assertIn("MM-LOOP-OFF", text)
        self.assertIn("CLAUDE.md", text)
        self.assertIn("AGENTS.md", text)
        self.assertNotIn("loop.json", "".join(read(p) for p in (SKILL_DIR / "scripts").glob("*.py")))

    def test_approval_table_holds_every_approval_rule_and_no_other_file_restates_one(self):
        core = read(SKILL_MD)
        section = core.split("## Approval table", 1)[1].split("\n## ", 1)[0]
        table = "\n".join(l for l in section.split("\n") if l.startswith("|"))
        actions = " ".join(r[0] for r in table_rows(table))
        for needle in ("scaffold", "close --apply", "notifier", "--apply", "hard-stop list"):
            self.assertIn(needle, actions)
        self.assertNotIn("needs no approval", core)
        self.assertIn("'go' is that yes", table)
        outside = [core.replace(table, "")] + [read(p) for p in sorted(REFS.glob("*.md"))]
        for phrase in ("operator's yes", "operator says yes", "counts as the yes", "is not a hard-stop action",
                       "separate yes", "always wait for the operator"):
            hits = [i for i, text in enumerate(outside) if phrase in text]
            self.assertEqual(hits, [], phrase)
        unattended = read(REFS / "unattended.md")
        self.assertIn("approval table in SKILL.md", unattended)
        self.assertEqual(hard_stop_line(unattended), hard_stop_line(core))

    def test_continuing_mode_prints_the_status_block_and_waits_without_writing(self):
        head = head_16k()
        section = head.split("## 2. Continuing mode", 1)[1].split("### 2.2", 1)[0]
        self.assertIn("writes nothing", section)
        self.assertIn("no prompt draft", section)
        self.assertIn("test level", section)
        self.assertIn("Waiting on the operator", section)
        self.assertIn("not retold in prose", section)
        self.assertIn("wait for the operator", section)
        core = read(SKILL_MD)
        table = core.split("## Approval table", 1)[1].split("\n## ", 1)[0]
        draft = next(r for r in table_rows(table) if r[0].startswith("Draft a dispatch prompt"))
        self.assertTrue(draft[1].startswith("only after"), draft)
        self.assertIn("Continuing mode", draft[1])

    def test_overlay_example_documents_every_key(self):
        text = read(SKILL_DIR / "mm.local.example.md")
        for key in ("python:", "operator_name:", "task_id_pattern:", "pm_roots:", "projects:", "paths:",
                    "models:", "launch_override:", "auto_commit:", "notifier:", "locale:"):
            self.assertIn(key, text)
        self.assertIn("mm.local.md", read(SKILL_DIR / ".gitignore").split("\n"))


class CommandReferenceTests(unittest.TestCase):
    def test_ledger_reference_scopes_dry_run_to_the_commands_that_implement_it(self):
        import argparse
        import mm
        subs = next(a for a in mm.PARSER._actions if isinstance(a, argparse._SubParsersAction))
        takes = sorted(name for name, parser in subs.choices.items()
                       if any("--dry-run" in a.option_strings for a in parser._actions))
        text = read(REFS / "ledger.md")
        self.assertNotIn("Every write command takes `--dry-run`", text)
        line = next((l for l in text.splitlines() if "exactly these commands:" in l), "")
        listed = sorted(re.findall(r"`([a-z-]+)`", line.split("exactly these commands:", 1)[-1]))
        self.assertEqual(listed, takes)
        without = next((l for l in text.splitlines() if "without a dry run" in l), "")
        for name in ("dispatch", "inbox-write", "launch-check", "loop"):
            self.assertIn("`%s" % name, without)
            self.assertNotIn(name, takes)


    def test_closing_reference_names_the_close_inbox_gap_and_how_update_catches_it(self):
        import mm_inbox
        text = read(REFS / "closing.md")
        self.assertIn("Close takes no lock", text)
        self.assertIn("still prints `MM-CLOSE-OK`", text)
        self.assertIn("For %d days after a close" % mm_inbox.CLOSED_RECHECK_DAYS, text)
        self.assertIn("`INBOX-CLOSED-TASK <path>`", text)
        self.assertIn("INBOX-CLOSED-TASK", read(REFS / "update.md"))


    def test_runtime_reference_documents_every_status_json_field(self):
        path = REFS / "runtime.md"
        self.assertTrue(path.is_file(), path)
        text = read(path)
        fields = ("schema", "ok", "generated_at", "mm_version", "session", "task_source", "task", "mode",
                  "open_row", "rows", "waiting_on_operator", "inbox", "dispatches_in_flight", "loop", "check",
                  "uncommitted", "errors", "binding_state", "bound", "role", "role_source", "bound_at",
                  "repo_root", "repo_root_source", "dir_exists", "legacy", "revision", "last_verdict",
                  "approval_id", "worker")
        self.assertEqual([f for f in fields if "`%s`" % f not in text], [])
        codes = ("SESSION-ID-UNUSABLE", "BINDING-UNREADABLE", "BINDING-LEGACY", "TASK-DIR-MISSING", "NO-TASK",
                 "LEDGER-INVALID", "GIT-FAILED", "FENCE-ROOT-TOO-BROAD", "CHECK-RAISED", "INBOX-UNREADABLE",
                 "DISPATCHES-UNREADABLE")
        self.assertEqual([c for c in codes if c not in text], [])
        self.assertIn("mm.status/1", text)
        self.assertIn("2.1.287", text)
        self.assertNotIn("references/", text)
        lines = text.split("\n")
        self.assertLessEqual(len(lines), 300)
        self.assertIn("## Contents", lines[:20])
        self.assertIn("`references/runtime.md`", read(SKILL_MD))

    def test_runtime_reference_states_the_fence_is_not_enforced_under_safe_mode_and_bare(self):
        path = REFS / "runtime.md"
        self.assertTrue(path.is_file(), path)
        text = read(path)
        for needle in ("--safe-mode", "--bare", "not enforced", "disableAllHooks", "managed-policy"):
            self.assertIn(needle, text)
        paragraph = next((p for p in text.split("\n\n") if "not enforced" in p and not p.startswith("#")), "")
        self.assertIn("--safe-mode", paragraph)
        self.assertIn("--bare", paragraph)


if __name__ == "__main__":
    unittest.main()
