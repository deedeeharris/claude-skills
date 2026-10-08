"""Proof tests for the ledger-only rule.

The random-sequence test drives mm.py through PROPERTY_SEQUENCES seeded
random operation sequences, each in a fresh temp task, and checks after every
sequence that the ledger is valid, compiling is deterministic, check reports
zero drift, refused operations left the ledger byte-identical, and nothing
written was lost. The sequences run in worker processes of this same file
(`--worker <first> <count>`) so the file-system cost of hundreds of writes is
spread over the machine's cores.
"""

import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import io
import json
import os
import random
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import mm
import mm_cli
import mm_compile
import mm_ledger

PROPERTY_SEED = 20260925
PROPERTY_SEQUENCES = 300

ALPHABET = list("abcdefghijk XYZ 0123 \"'$`|\\-_.,;:!?()[]{}<>#*%&=+/~^") + list("éüñçøΩμέγαδ")
PLAIN_FIELDS = ("Next agent action", "Executive note", "Owner", "Category", "Blockers summary",
                "Next human decision", "Target week")


def run_mm(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = mm.main([str(a) for a in argv])
    return rc, out.getvalue() + err.getvalue()


def text(rng, low=1, high=24):
    body = "".join(rng.choice(ALPHABET) for _ in range(rng.randint(low, high))).strip()
    return "w" + body if body else "w"


class Sequence:
    """One random sequence against one fresh task, with a shadow model of
    every value written."""

    def __init__(self, rng, root: pathlib.Path):
        self.rng = rng
        self.root = root
        self.task = root / ".private" / "pm" / "active" / "prop-task"
        self.rows = {}
        self.order = []
        self.notes = {}
        self.states = {}
        self.history = {}
        self.decisions = {}
        self.sections = {}
        self.fields = {}
        self.archived_rows = {}
        self.archived_decisions = {}
        self.next_row = 1
        self.next_q = 1
        self.file_n = 0

    def fail(self, message):
        raise AssertionError(message)

    def opt(self, name, value):
        if self.rng.random() < 0.3:
            self.file_n += 1
            path = self.root / ("arg%d.txt" % self.file_n)
            path.write_text(value + "\n", encoding="utf-8", newline="\n")
            return ["--%s-file=%s" % (name, path)]
        return ["--%s=%s" % (name, value)]

    def doc(self):
        return json.loads((self.task / "ledger.json").read_text(encoding="utf-8"))

    def snapshot(self):
        return {name: (self.task / name).read_bytes() for name in ("ledger.json", "HANDOFF.md")}

    def pick(self, predicate):
        rows = [r for r in self.doc()["rows"] if predicate(r)]
        return self.rng.choice(rows) if rows else None

    def run(self, argv, expect=None):
        before = self.snapshot()
        rev = self.doc()["revision"]
        rc, output = run_mm(*argv)
        if rc not in mm.EXIT_CODES:
            self.fail("undocumented exit %d for %s" % (rc, argv))
        if expect == "ok" and rc != 0:
            self.fail("expected success, got %d for %s: %s" % (rc, argv, output[-400:]))
        if expect == "refused" and rc == 0:
            self.fail("expected a refusal for %s" % (argv,))
        if rc != 0 and self.snapshot() != before:
            self.fail("refused op %s (exit %d) changed the ledger or HANDOFF" % (argv, rc))
        if rc == 0 and self.doc()["revision"] != rev + 1:
            self.fail("op %s did not bump the revision exactly once" % (argv,))
        return rc

    def start(self):
        items = [text(self.rng) for _ in range(self.rng.randint(1, 3))]
        argv = ["scaffold", "--task-dir", self.task, "--task", "prop-task", "--project", "smoke-project"]
        via_file = self.rng.random() < 0.3
        for item in items:
            if via_file:
                self.file_n += 1
                path = self.root / ("row%d.txt" % self.file_n)
                path.write_text(item + "\n", encoding="utf-8", newline="\n")
                argv.append("--row-file=%s" % path)
            else:
                argv.append("--row=%s" % item)
        rc, output = run_mm(*argv)
        if rc != 0:
            self.fail("scaffold failed: " + output[-400:])
        for item in items:
            self.new_row("#%d" % self.next_row, item, at=len(self.order))
            self.next_row += 1
        self.new_row("#%d" % self.next_row, None, notes="last row: run the closing ritual (mm.py close)",
                     at=len(self.order))
        self.next_row += 1

    def new_row(self, rid, item, notes="", at=None, history=()):
        """A new BACKLOG row; `at` defaults to just before the wrap-up row."""
        if item is not None:
            self.rows[rid] = item
        self.notes[rid] = notes
        self.states[rid] = "BACKLOG"
        self.history[rid] = list(history)
        self.order.insert(len(self.order) - 1 if at is None else at, rid)

    def moved_state(self, rid, state, evidence="", reason=""):
        """A successful state change; a change to the current state is a no-op with no history entry."""
        if self.states[rid] != state:
            self.states[rid] = state
            self.history[rid].append(("to", state, evidence, reason))

    def op_add_row(self):
        item = text(self.rng)
        notes = text(self.rng) if self.rng.random() < 0.4 else ""
        argv = ["add-row", "--task-dir", self.task] + self.opt("item", item)
        argv += self.opt("notes", notes) if notes else []
        if self.run(argv, "ok") == 0:
            rid = "#%d" % self.next_row
            self.next_row += 1
            self.new_row(rid, item, notes)
            order = [r["id"] for r in self.doc()["rows"]]
            if order[-2] != rid or not self.doc()["rows"][-1]["is_wrapup"]:
                self.fail("add-row put %s at %s" % (rid, order))

    def op_edit_row(self):
        row = self.pick(lambda r: not r["is_wrapup"])
        if row is None:
            return
        rid, choice = row["id"], self.rng.random()
        item = text(self.rng) if choice < 0.7 else self.rows[rid]
        notes = text(self.rng) if choice > 0.4 else self.notes[rid]
        argv = ["edit-row", "--task-dir", self.task, "--id", rid]
        argv += (self.opt("item", item) if choice < 0.7 else []) + (self.opt("notes", notes) if choice > 0.4 else [])
        self.run(argv, "ok")
        changed = sorted(k for k, old, new in (("item", self.rows[rid], item), ("notes_md", self.notes[rid], notes))
                         if old != new)
        if changed:
            self.history[rid].append(("edit", tuple(changed)))
        self.rows[rid], self.notes[rid] = item, notes

    def op_move_row(self):
        row = self.pick(lambda r: True)
        anchor = self.pick(lambda r: True)
        where = self.rng.choice(["--before", "--after"])
        argv = ["move-row", "--task-dir", self.task, "--id", row["id"], where, anchor["id"]]
        bad = row["is_wrapup"] or row is anchor or row["id"] == anchor["id"] or (
            where == "--after" and anchor["is_wrapup"])
        if self.run(argv, "refused" if bad else "ok") == 0:
            self.order.remove(row["id"])
            at = self.order.index(anchor["id"])
            self.order.insert(at if where == "--before" else at + 1, row["id"])
        if not self.doc()["rows"][-1]["is_wrapup"]:
            self.fail("wrap-up row is not last after move-row")

    def op_split_row(self):
        row = self.pick(lambda r: not r["is_wrapup"] and r["state"] not in ("DONE", "ABANDONED"))
        if row is None:
            return
        if self.rng.random() < 0.15:
            self.run(["split-row", "--task-dir", self.task, "--id", row["id"], "--item=only one", "--reason=x"],
                     "refused")
            return
        items = [text(self.rng) for _ in range(self.rng.randint(2, 3))]
        argv = ["split-row", "--task-dir", self.task, "--id", row["id"]]
        for item in items:
            argv.append("--item=%s" % item)
        reason = text(self.rng)
        argv += self.opt("reason", reason)
        self.run(argv, "ok")
        ids = ["#%d" % (self.next_row + n) for n in range(len(items))]
        self.moved_state(row["id"], "ABANDONED", reason="split into %s: %s" % (", ".join(ids), reason))
        at = self.order.index(row["id"]) + 1
        for n, (rid, item) in enumerate(zip(ids, items)):
            self.new_row(rid, item, at=at + n, history=[("note", "split from %s" % row["id"])])
        self.next_row += len(items)
        if self.doc()["rows"][[r["id"] for r in self.doc()["rows"]].index(row["id"])]["state"] != "ABANDONED":
            self.fail("split parent %s is not ABANDONED" % row["id"])

    def op_retire_row(self):
        if self.rng.random() < 0.2:
            wrap = self.pick(lambda r: r["is_wrapup"])
            self.run(["retire-row", "--task-dir", self.task, "--id", wrap["id"], "--reason=x"], "refused")
            return
        row = self.pick(lambda r: not r["is_wrapup"] and r["state"] != "DONE")
        if row is None:
            return
        reason = text(self.rng)
        recorded = next((h[3] for h in reversed(self.history[row["id"]]) if h[:2] == ("to", "ABANDONED")), None)
        dropped = row["state"] == "ABANDONED" and reason != recorded
        self.run(["retire-row", "--task-dir", self.task, "--id", row["id"]] + self.opt("reason", reason),
                 "refused" if dropped else "ok")
        if not dropped:
            self.moved_state(row["id"], "ABANDONED", reason=reason)

    def op_set_row(self):
        row = self.pick(lambda r: not r["is_wrapup"])
        if row is None:
            return
        base = ["set-row", "--task-dir", self.task, "--id", row["id"]]
        choice = self.rng.random()
        if choice < 0.3 and row["state"] not in ("DONE", "HUMAN_VERIFIED"):
            self.run(base + ["--state", "DONE"], "refused")
        elif choice < 0.6:
            evidence = "cmd:%s exit:0" % text(self.rng, 1, 8)
            rc = self.run(base + ["--state", "DONE"] + self.opt("evidence", evidence))
            if rc == 0 and self.doc()["rows"][[r["id"] for r in self.doc()["rows"]].index(row["id"])]["state"] != "DONE":
                self.fail("set-row DONE succeeded but the row is not DONE")
            if rc == 0:
                self.moved_state(row["id"], "DONE", evidence=evidence)
        else:
            state = self.rng.choice(["IMPLEMENTING", "REVIEW", "INVESTIGATING"])
            if self.run(base + ["--state", state]) == 0:
                self.moved_state(row["id"], state)

    def op_add_decision(self):
        decision = text(self.rng)
        argv = ["add-decision", "--task-dir", self.task, "--status=FINAL", "--date=2026-01-01"]
        for name, value in (("source", text(self.rng)), ("who", text(self.rng)), ("decision", decision),
                            ("why", text(self.rng))):
            argv += self.opt(name, value)
        self.run(argv, "ok")
        self.decisions["Q%d" % self.next_q] = decision
        self.next_q += 1

    def op_supersede_decision(self):
        live = [d for d in self.doc()["decisions"] if d.get("status") != "SUPERSEDED"]
        if len(live) < 2:
            return
        old, new = self.rng.sample(live, 2)
        self.run(["supersede-decision", "--task-dir", self.task, "--qid", old["qid"], "--by", new["qid"]]
                 + self.opt("reason", text(self.rng)), "ok")

    def op_set_field(self):
        name = self.rng.choice(PLAIN_FIELDS)
        value = text(self.rng)
        self.run(["set-field", "--task-dir", self.task, "--field", name] + self.opt("value", value), "ok")
        self.fields[name] = value

    def op_set_section(self):
        sid = self.rng.choice(sorted(mm_compile.TEXT_SECTIONS))
        body = "\n".join(text(self.rng) for _ in range(self.rng.randint(1, 3)))
        self.run(["set-section", "--task-dir", self.task, "--id", sid] + self.opt("text", body), "ok")
        self.sections[sid] = body

    def op_archive(self):
        keep = self.rng.randint(0, 2)
        before = self.doc()
        self.run(["archive", "--task-dir", self.task, "--keep-done", keep, "--keep-decisions", keep, "--apply"],
                 "ok")
        after = self.doc()
        moved_rows = {r["id"] for r in before["rows"]} - {r["id"] for r in after["rows"]}
        closed = [rid for rid in self.order if self.states[rid] in ("DONE", "ABANDONED") and rid in self.rows]
        expected = set(closed[:max(len(closed) - keep, 0)])
        if moved_rows != expected:
            self.fail("archive moved %s, the shadow expected %s" % (sorted(moved_rows), sorted(expected)))
        self.order = [rid for rid in self.order if rid not in moved_rows]
        moved_q = {d["qid"] for d in before["decisions"]} - {d["qid"] for d in after["decisions"]}
        for rid in moved_rows:
            if rid in self.rows:
                self.archived_rows[rid] = self.rows.pop(rid)
        for qid in moved_q:
            if qid in self.decisions:
                self.archived_decisions[qid] = self.decisions.pop(qid)

    def op_batch(self):
        ops, effects = [], []
        for _ in range(self.rng.randint(2, 4)):
            kind = self.rng.choice(["add-row", "set-field", "set-section"])
            if kind == "add-row":
                item = text(self.rng)
                ops.append({"op": "add-row", "item": item})
                effects.append(("row", item))
            elif kind == "set-field":
                name, value = self.rng.choice(PLAIN_FIELDS), text(self.rng)
                ops.append({"op": "set-field", "field": name, "value": value})
                effects.append(("field", (name, value)))
            else:
                sid, body = self.rng.choice(sorted(mm_compile.TEXT_SECTIONS)), text(self.rng)
                ops.append({"op": "set-section", "id": sid, "text": body})
                effects.append(("section", (sid, body)))
        bad = self.rng.random() < 0.25
        if bad:
            ops.insert(self.rng.randint(0, len(ops)), {"op": "retire-row", "id": "#999", "reason": "x"})
        self.file_n += 1
        path = self.root / ("batch%d.json" % self.file_n)
        path.write_text(json.dumps(ops, ensure_ascii=False), encoding="utf-8")
        self.run(["batch", "--task-dir", self.task, "--file", path], "refused" if bad else "ok")
        if bad:
            return
        for kind, value in effects:
            if kind == "row":
                self.new_row("#%d" % self.next_row, value)
                self.next_row += 1
            elif kind == "field":
                self.fields[value[0]] = value[1]
            else:
                self.sections[value[0]] = value[1]

    OPS = ("add_row", "edit_row", "move_row", "split_row", "retire_row", "set_row", "add_decision",
           "supersede_decision", "set_field", "set_section", "archive", "batch")

    def verify_final(self):
        doc = mm_ledger.load_ledger(self.task)
        mm_ledger.validate_ledger(doc)
        first, second = mm_compile.render_files(doc), mm_compile.render_files(doc)
        if first != second:
            self.fail("compiling the same ledger twice gave different bytes")
        rc, output = run_mm("check", "--task-dir", self.task)
        if rc != 0:
            self.fail("check exited %d after the sequence: %s" % (rc, output[-600:]))
        handoff = (self.task / "HANDOFF.md").read_text(encoding="utf-8")
        archive_path = self.task / "HANDOFF-archive.md"
        archive = archive_path.read_text(encoding="utf-8") if archive_path.is_file() else ""
        ledger_rows = {r["id"]: r["item"] for r in doc["rows"]}
        self.verify_rows(doc, handoff)
        for rid, item in self.rows.items():
            if ledger_rows.get(rid) != item:
                self.fail("row %s holds %r, the shadow wrote %r" % (rid, ledger_rows.get(rid), item))
            if mm_compile.escape_cell(item) not in handoff:
                self.fail("row %s text %r is missing from HANDOFF.md" % (rid, item))
        for rid, item in self.archived_rows.items():
            if mm_compile.escape_cell(item) not in archive:
                self.fail("archived row %s text %r is missing from HANDOFF-archive.md" % (rid, item))
        for qid, decision in self.decisions.items():
            if "- **Decision:** %s" % decision not in handoff:
                self.fail("decision %s text %r is missing from HANDOFF.md" % (qid, decision))
        for qid, decision in self.archived_decisions.items():
            if "- **Decision:** %s" % decision not in archive:
                self.fail("archived decision %s is missing from HANDOFF-archive.md" % qid)
        for sid, body in self.sections.items():
            if body not in handoff:
                self.fail("section %s text %r is missing from HANDOFF.md" % (sid, body))
        for name, value in self.fields.items():
            if "- %s: %s\n" % (name, value) not in handoff:
                self.fail("field %s value %r is missing from HANDOFF.md" % (name, value))

    def verify_rows(self, doc, handoff):
        """Row order, notes, evidence and every history entry, live and archived."""
        order = [r["id"] for r in doc["rows"]]
        if order != self.order:
            self.fail("row order is %s, the shadow expects %s" % (order, self.order))
        rendered = [line.split("|")[1].strip() for line in handoff.split("\n") if line.startswith("| #")]
        if rendered != self.order:
            self.fail("HANDOFF.md lists rows %s, the shadow expects %s" % (rendered, self.order))
        archived = (doc.get("archive") or {}).get("rows") or []
        for row in doc["rows"] + archived:
            rid = row["id"]
            if row.get("notes_md", "") != self.notes[rid]:
                self.fail("row %s notes are %r, the shadow wrote %r" % (rid, row.get("notes_md"), self.notes[rid]))
            got = [history_key(h) for h in row.get("history", [])]
            if got != self.history[rid]:
                self.fail("row %s history is %r, the shadow expects %r" % (rid, got, self.history[rid]))
            if row in doc["rows"] and self.notes[rid] and " | %s |" % self.notes[rid] not in handoff:
                self.fail("row %s notes %r are missing from HANDOFF.md" % (rid, self.notes[rid]))
        if {r["id"] for r in archived} | set(order) != set(self.history):
            self.fail("rows were lost: the shadow holds %s" % sorted(set(self.history) - set(order)))


def history_key(entry: dict) -> tuple:
    if "edit" in entry:
        return ("edit", tuple(sorted(entry["edit"])))
    if "to" in entry:
        return ("to", entry["to"], entry.get("evidence", ""), entry.get("reason", ""))
    return ("note", entry.get("note", ""))


def run_sequence(index: int) -> str:
    rng = random.Random(PROPERTY_SEED + index)
    root = pathlib.Path(tempfile.mkdtemp(prefix="mm-prop-"))
    try:
        seq = Sequence(rng, root)
        seq.start()
        for _ in range(rng.randint(5, 25)):
            getattr(seq, "op_" + rng.choice(Sequence.OPS))()
        seq.verify_final()
        return ""
    except AssertionError as exc:
        return "sequence %d: %s" % (index, exc)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def worker(first: int, count: int) -> None:
    os.environ["MM_AUTO_COMMIT"] = "off"
    failures = [f for f in (run_sequence(i) for i in range(first, first + count)) if f]
    print("PROPERTY-RESULT " + json.dumps({"ran": count, "failures": failures}))


class PropertyTests(unittest.TestCase):
    def test_random_op_sequences_keep_ledger_valid_compile_deterministic_and_lossless(self):
        workers = max(1, min(8, os.cpu_count() or 1))
        size = -(-PROPERTY_SEQUENCES // workers)
        env = dict(os.environ, MM_AUTO_COMMIT="off", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
        procs = [subprocess.Popen([sys.executable, __file__, "--worker", str(first),
                                   str(min(size, PROPERTY_SEQUENCES - first))],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                 for first in range(0, PROPERTY_SEQUENCES, size)]
        ran, failures = 0, []
        for proc in procs:
            out, err = proc.communicate(timeout=900)
            lines = [l for l in out.decode("utf-8", "replace").splitlines() if l.startswith("PROPERTY-RESULT ")]
            self.assertEqual(len(lines), 1, "worker printed no result: " + err.decode("utf-8", "replace")[-800:])
            result = json.loads(lines[0].split(" ", 1)[1])
            ran += result["ran"]
            failures += result["failures"]
        self.assertEqual(ran, PROPERTY_SEQUENCES)
        self.assertEqual(failures, [], "\n".join(failures[:10]))
        self.assertEqual(run_sequence(PROPERTY_SEQUENCES + PROPERTY_SEED % 7), "")


def _drop_notes(doc):
    for row in doc["rows"]:
        row["notes_md"] = ""


def _drop_evidence(doc):
    for row in doc["rows"]:
        for entry in row.get("history", []):
            if entry.get("evidence"):
                entry["evidence"] = ""


def _drop_history(doc):
    for row in doc["rows"]:
        row["history"] = row.get("history", [])[:1]


def _swap_order(doc):
    rows = doc["rows"]
    if len(rows) >= 5 and not rows[0]["is_wrapup"] and not rows[1]["is_wrapup"]:
        rows[0], rows[1] = rows[1], rows[0]


class ShadowModelTests(unittest.TestCase):
    """The random sequences must notice a writer that loses notes, evidence,
    history or row order while keeping the ledger valid and the HANDOFF in
    sync with it."""

    SEQUENCES = 6

    def test_shadow_model_catches_lost_notes_evidence_history_and_row_order(self):
        real = mm_cli._save_and_render
        missed = []
        for mutate in (_drop_notes, _drop_evidence, _drop_history, _swap_order):
            def lossy(task_dir, doc, before_revision, verb, now, mutate=mutate):
                mutate(doc)
                return real(task_dir, doc, before_revision, verb, now)

            with mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off"}), \
                    mock.patch.object(mm_cli, "_save_and_render", lossy):
                caught = [f for f in (run_sequence(i) for i in range(self.SEQUENCES)) if f]
            if not caught:
                missed.append(mutate.__name__)
        self.assertEqual(missed, [])


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.task = self.tmp / ".private" / "pm" / "active" / "cover-task"
        rc, output = run_mm("scaffold", "--task-dir", self.task, "--task", "cover-task", "--project",
                            "smoke-project", "--row", "First row")
        self.assertEqual(rc, 0, output)

    def handoff(self):
        return (self.task / "HANDOFF.md").read_text(encoding="utf-8")

    def section_text(self, entry):
        text = self.handoff()
        if entry["kind"] == "derived" and entry["id"] == "title":
            return text.split("\n")[1]
        heading = entry["heading"]
        start = text.index(heading)
        rest = text[start + len(heading):]
        nxt = [rest.find(h) for h in mm_compile.SECTION_HEADINGS.values() if rest.find(h) >= 0]
        return rest[: min(nxt)] if nxt else rest

    def test_every_rendered_handoff_section_is_changed_by_a_command(self):
        doc = mm_ledger.load_ledger(self.task)
        registry = mm_compile.section_registry(doc)
        headings = {e["heading"] for e in registry}
        for line in self.handoff().splitlines():
            if line.startswith("## "):
                self.assertIn(line, headings)
        writers = {
            "fields": lambda m: ("set-field", "--field", "Executive note", "--value", m),
            "rows": lambda m: ("add-row", "--item", m),
            "decisions": lambda m: ("add-decision", "--status", "FINAL", "--source", "s", "--date", "2026-01-01",
                                    "--who", "w", "--decision", m, "--why", "y"),
            "text": None,
            "derived": lambda m: ("set-field", "--field", "Task", "--value", m),
        }
        self.assertEqual({e["kind"] for e in registry}, set(writers))
        for n, entry in enumerate(registry):
            marker = "coverage-marker-%d-%s" % (n, entry["id"])
            before = self.section_text(entry)
            if entry["kind"] == "text":
                argv = ("set-section", "--id", entry["id"], "--text", marker)
            else:
                argv = writers[entry["kind"]](marker)
            rc, output = run_mm(argv[0], "--task-dir", self.task, *argv[1:])
            self.assertEqual(rc, 0, output)
            after = self.section_text(entry)
            self.assertNotEqual(before, after, entry)
            self.assertIn(marker, after, entry)

    def test_generated_header_present_and_one_byte_hand_edit_fails_check(self):
        for argv in (("set-row", "--id", "#1", "--state", "DONE", "--evidence", "human:Test Operator"),
                     ("archive", "--keep-done", "0", "--apply")):
            rc, output = run_mm(argv[0], "--task-dir", self.task, *argv[1:])
            self.assertEqual(rc, 0, output)
        names = ("HANDOFF.md", "HANDOFF-archive.md", "ROADMAP.html")
        for name in names:
            first = (self.task / name).read_text(encoding="utf-8").split("\n", 1)[0]
            self.assertEqual(first, mm_compile.GENERATED_HEADER, name)
        self.assertEqual(run_mm("check", "--task-dir", self.task)[0], 0)
        for name in names:
            path = self.task / name
            original = path.read_bytes()
            data = bytearray(original)
            i = max(j for j, b in enumerate(data) if 97 <= b <= 122)
            data[i] = 98 if data[i] == 97 else 97
            path.write_bytes(bytes(data))
            rc, output = run_mm("check", "--task-dir", self.task)
            self.assertEqual(rc, 1, name)
            self.assertIn("HANDOFF-EDITED", output)
            path.write_bytes(original)
            self.assertEqual(run_mm("check", "--task-dir", self.task)[0], 0)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--worker"]:
        worker(int(sys.argv[2]), int(sys.argv[3]))
    else:
        unittest.main()
