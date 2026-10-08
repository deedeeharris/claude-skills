"""R-31 contract test: the JSON the real mm.py prints against the plugin's fixtures.

The plugin (integrations/claude-code/mm-runtime) is tested against hand-written
fixtures in its tests/fixtures/. This test runs the real `mm.py status --json`,
`fence --json`, `approve-dispatch --json` and `product-changes --json` as
subprocesses on a synthetic git repository and task, in the binding state each
fixture stands for, and compares the shape of every document with its fixture:
the same keys at every level, and the same JSON type for every value, null
compared as null. Path-keyed maps (`files`, `submodules`) are compared by the
shape of their values. A list must be empty in both or non-empty in both, and
every element is compared with the fixture element at the same index (the last
one when the fixture has fewer). Every fixture file must be produced.
"""
import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import mm

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent
MM_PY = SCRIPTS / "mm.py"
FIXTURES = SCRIPTS.parent / "integrations" / "claude-code" / "mm-runtime" / "tests" / "fixtures"
MAPS = {"files", "submodules"}
BAD_INBOX_ENTRY = "20261003-120000-worker.md"


def kind(value) -> str:
    if value is None:
        return "null"
    for name, types in (("bool", bool), ("int", int), ("float", float), ("str", str), ("array", list),
                        ("object", dict)):
        if isinstance(value, types):
            return name
    return type(value).__name__


def shape_diff(fixture, core, where, out, key=None):
    """Append one line per shape difference between a fixture value and a core value."""
    kf, kc = kind(fixture), kind(core)
    if kf != kc:
        out.append("%s: fixture %s, core %s (core value %s)" % (where, kf, kc, json.dumps(core)[:80]))
        return
    if kf == "object" and key in MAPS:
        _elements(list(fixture.values()), list(core.values()), where + "{}", out)
    elif kf == "object":
        only_fixture, only_core = sorted(set(fixture) - set(core)), sorted(set(core) - set(fixture))
        if only_fixture:
            out.append("%s: keys only in the fixture: %s" % (where, ", ".join(only_fixture)))
        if only_core:
            out.append("%s: keys only in the core output: %s" % (where, ", ".join(only_core)))
        for name in sorted(set(fixture) & set(core)):
            shape_diff(fixture[name], core[name], "%s.%s" % (where, name), out, name)
    elif kf == "array":
        _elements(fixture, core, where + "[]", out)


def _elements(fixture: list, core: list, where, out):
    if bool(fixture) != bool(core):
        out.append("%s: fixture has %d elements, core %d" % (where, len(fixture), len(core)))
        return
    for i, value in enumerate(core):
        shape_diff(fixture[min(i, len(fixture) - 1)], value, where, out)


class ContractCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.state = self.tmp / "state"
        self.env = dict(os.environ)
        self.env.update({
            "MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.state), "HOME": str(self.home),
            "USERPROFILE": str(self.home), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(self.home / "gitconfig"),
            "GIT_CEILING_DIRECTORIES": str(self.tmp), "GIT_AUTHOR_NAME": "Test Operator",
            "GIT_AUTHOR_EMAIL": "operator" + "@example.invalid", "GIT_COMMITTER_NAME": "Test Operator",
            "GIT_COMMITTER_EMAIL": "operator" + "@example.invalid",
        })
        self.env.pop("MM_CC_RUNTIME_MOD_ACTIVE", None)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        (self.repo / "src").mkdir()
        (self.repo / "src" / "dirty.py").write_bytes(b"print('seed')\n")
        self.git("add", "src/dirty.py")
        self.git("commit", "-qm", "seed")
        self.task = self.repo / ".private" / "pm" / "active" / "t"
        self.prompt = self.tmp / "p.md"
        self.prompt.write_bytes(b"Build the parser as row #2 says.\n")

    def git(self, *argv):
        proc = subprocess.run(["git", *argv], cwd=str(self.repo), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", env=self.env)
        self.assertEqual(proc.returncode, 0, "git %s: %s" % (" ".join(argv), proc.stderr))

    def run_mm(self, *argv, stdin=None):
        proc = subprocess.run([sys.executable, str(MM_PY), *[str(a) for a in argv]], input=stdin,
                              capture_output=True, text=True, encoding="utf-8", errors="replace", env=self.env,
                              cwd=str(self.repo))
        return proc.returncode, proc.stdout, proc.stderr

    def ok(self, *argv, stdin=None):
        rc, out, err = self.run_mm(*argv, stdin=stdin)
        self.assertEqual(rc, 0, "mm.py %s -> %d\n%s\n%s" % (" ".join(map(str, argv)), rc, out, err))
        return out

    def doc(self, *argv, stdin=None):
        return json.loads(self.ok(*argv, stdin=stdin))

    def binding(self, session, record):
        path = self.state / "sessions" / ("%s.json" % session)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(record if isinstance(record, str) else json.dumps(record), encoding="utf-8")

    def scaffold(self, task):
        self.ok("scaffold", "--task-dir", task, "--task", task.name, "--project", "contract-project",
                "--row", "Pick the file format", "--row", "Build the parser", "--row", "Choose the storage engine")
        for row in ("#1", "#2", "#3", "#4"):
            self.ok("edit-row", "--task-dir", task, "--id", row, "--test-level", "unit")

    def rich_task(self):
        """A bound, attended task with a blocked row, a past tick, and one in-flight approved dispatch."""
        self.scaffold(self.task)
        self.ok("mark-row", "--task-dir", self.task, "--id", "#3", "--blocked", "--reason", "which storage engine")
        self.ok("loop", "on", "--task-dir", self.task, "--approved-by", "Test Operator", "--route", "bg-it:sonnet",
                "--cadence", "60m")
        self.ok("loop", "tick", "--task-dir", self.task, "--result", "noop", "--report", "nothing to do")
        self.ok("loop", "off", "--task-dir", self.task, "--reason", "stopped by the operator")
        self.ok("approve-dispatch", "--task-dir", self.task, "--row", "#2", "--route", "subagent", "--model",
                "sonnet", "--worker", "subagent", "--prompt-file", self.prompt, "--operator", "Test Operator",
                "--session", "s-bound")
        self.ok("dispatch", "--task-dir", self.task, "--row", "#2", "--route", "subagent", "--model", "sonnet",
                "--prompt-file", self.prompt, "--approval-id", "a1", "--worker", "subagent")
        log = self.tmp / "launch.log"
        log.write_bytes(b"started\n")
        self.ok("launch-check", "--task-dir", self.task, "--dispatch-id", "d1", "--launch-log", log, "--cwd",
                self.repo)
        self.ok("bind", "--task-dir", self.task, "--session", "s-bound")

    def status_with_unreadable_inbox(self, session):
        """INBOX-UNREADABLE needs a read error no file mode gives portably, so this one document comes from
        the same CLI run in-process with that one inbox entry's read failing."""
        inbox = self.task / "inbox"
        inbox.mkdir(exist_ok=True)
        (inbox / BAD_INBOX_ENTRY).write_bytes(b"report\n")
        real = pathlib.Path.read_text

        def read_text(path, *a, **k):
            if path.name == BAD_INBOX_ENTRY:
                raise PermissionError(13, "Permission denied", str(path))
            return real(path, *a, **k)

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(pathlib.Path, "read_text",
                                                                                   read_text), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mm.main(["status", "--json", "--session", session])
        (inbox / BAD_INBOX_ENTRY).unlink()
        self.assertEqual(rc, 0, out.getvalue() + err.getvalue())
        return json.loads(out.getvalue())

    def produce(self) -> dict:
        docs = {}
        self.rich_task()
        bound_at = "2026-10-03T11:00:00+00:00"
        root = str(self.repo.resolve())
        docs["status-bound.json"] = self.doc("status", "--json", "--session", "s-bound")
        docs["status-unbound.json"] = self.doc("status", "--json", "--session", "s-never-bound")
        self.binding("s-unreadable", "{not json")
        docs["status-unreadable.json"] = self.doc("status", "--json", "--session", "s-unreadable")
        self.binding("s-legacy", {"task_dir": str(self.task), "bound_at": bound_at})
        docs["status-legacy.json"] = self.doc("status", "--json", "--session", "s-legacy")
        self.binding("s-broad", {"task_dir": str(self.task), "bound_at": bound_at, "role": "pm",
                                 "repo_root": str(self.home), "repo_root_source": "git"})
        docs["status-broad.json"] = self.doc("status", "--json", "--session", "s-broad")
        self.binding("s-stale", {"task_dir": str(self.repo / ".private" / "pm" / "active" / "moved"),
                                 "bound_at": bound_at, "role": "pm", "repo_root": root, "repo_root_source": "git"})
        docs["status-stale.json"] = self.doc("status", "--json", "--session", "s-stale")
        broken = self.repo / ".private" / "pm" / "active" / "broken"
        self.scaffold(broken)
        self.ok("bind", "--task-dir", broken, "--session", "s-invalid")
        ledger = json.loads((broken / "ledger.json").read_text(encoding="utf-8"))
        ledger["rows"][0]["state"] = "DOING"
        (broken / "ledger.json").write_text(json.dumps(ledger, indent=2), encoding="utf-8")
        docs["status-ledger-invalid.json"] = self.doc("status", "--json", "--session", "s-invalid")

        write = {"hook_event_name": "PreToolUse", "tool_name": "Write", "session_id": "s-bound", "cwd": root,
                 "tool_input": {"file_path": str(self.repo / "src" / "a.py"), "content": "x = 1\n"}}
        docs["fence-deny.json"] = self.doc("fence", "--json", stdin=json.dumps(write))
        docs["fence-allow.json"] = self.doc("fence", "--json", stdin=json.dumps(dict(write, agent_id="agent-1")))

        approve = ["approve-dispatch", "--task-dir", self.task, "--row", "#2", "--route", "bg-it", "--model",
                   "sonnet", "--worker", "bg", "--prompt-file", self.prompt, "--operator", "Test Operator",
                   "--channel", "cc-dialog", "--session", "s-bound", "--json"]
        docs["approval-dry-run.json"] = self.doc(*approve, "--dry-run")
        docs["approval-ok.json"] = self.doc(*approve)

        (self.repo / "src" / "dirty.py").write_bytes(b"print('seed')\nprint('dirty')\n")
        before = self.ok("product-changes", "--task-dir", self.task, "--json")
        docs["changes-before.json"] = json.loads(before)
        (self.repo / "src" / "dirty.py").write_bytes(b"print('seed')\nprint('dirty')\nprint('again')\n")
        (self.repo / "src" / "new.py").write_bytes(b"x = 1\n")
        docs["changes-after.json"] = self.doc("product-changes", "--task-dir", self.task, "--json", "--baseline", "-",
                                              stdin=before)

        store = self.task / "prompts" / "dispatches.jsonl"
        kept = store.read_bytes()
        store.write_bytes(kept + b'{"id":\n')
        docs["status-dispatches-unreadable.json"] = self.doc("status", "--json", "--session", "s-bound")
        store.write_bytes(kept)
        docs["status-inbox-unreadable.json"] = self.status_with_unreadable_inbox("s-bound")
        return docs


class ContractTests(ContractCase):
    def test_when_core_commands_run_their_json_matches_the_plugin_fixtures(self):
        docs = self.produce()
        expected_codes = {
            "status-bound.json": [], "status-unbound.json": [], "status-unreadable.json": ["BINDING-UNREADABLE"],
            "status-legacy.json": ["BINDING-LEGACY"], "status-broad.json": ["FENCE-ROOT-TOO-BROAD"],
            "status-stale.json": ["TASK-DIR-MISSING"], "status-ledger-invalid.json": ["LEDGER-INVALID"],
            "status-dispatches-unreadable.json": ["DISPATCHES-UNREADABLE"],
            "status-inbox-unreadable.json": ["INBOX-UNREADABLE"],
        }
        for name, codes in expected_codes.items():
            self.assertEqual([e["code"] for e in docs[name]["errors"]], codes, "the synthetic state for %s" % name)
        self.assertEqual((docs["fence-deny.json"]["decision"], docs["fence-allow.json"]["decision"]),
                         ("deny", "allow"))
        self.assertEqual(docs["changes-after.json"]["changed"], ["src/dirty.py", "src/new.py"])
        self.assertEqual(len(docs["status-bound.json"]["dispatches_in_flight"]), 1)
        fixtures = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted(FIXTURES.glob("*.json"))}
        problems = []
        for name in sorted(set(fixtures) - set(docs)):
            problems.append("%s: no synthetic state produces this fixture" % name)
        for name in sorted(set(docs) - set(fixtures)):
            problems.append("%s: the core emits this document and the plugin has no fixture for it" % name)
        for name in sorted(set(docs) & set(fixtures)):
            shape_diff(fixtures[name], docs[name], name, problems)
        problems = list(dict.fromkeys(problems))
        self.assertEqual(problems, [], "core output and plugin fixtures differ:\n" + "\n".join(problems))

    def test_when_a_fixture_value_has_another_type_than_the_core_value_shape_diff_names_the_field(self):
        problems = []
        shape_diff({"rows": [{"pr": ""}], "files": {"a": [1, 2]}, "task": None},
                   {"rows": [{"pr": None}], "files": {"b": None}, "task": {"name": "t"}, "extra": 1}, "doc", problems)
        self.assertEqual(problems, [
            "doc: keys only in the core output: extra",
            "doc.files{}: fixture array, core null (core value null)",
            "doc.rows[].pr: fixture str, core null (core value null)",
            'doc.task: fixture null, core object (core value {"name": "t"})',
        ])


if __name__ == "__main__":
    unittest.main()
