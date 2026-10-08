import sys
import pathlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import contextlib
import io
import shutil
import tempfile
import unittest
from unittest import mock

import fixture
import mm_compile
import mm_git

DASHBOARD_FIELDS_BLOCK = (
    "- Project: p\n- Task: x\n- Status: active\n- Last updated: t\n"
    "- Target finish date: none\n- Target week: none\n- Deadline type: none\n"
    "- Schedule confidence: unknown\n- At risk: no\n- Owner: o\n"
    "- Waiting on: none\n- Priority: 3\n- Category: c\n"
    "- Strategic value: 3\n- Money value: none\n- Energy cost: low\n"
    "- Review cadence: weekly\n- Next human decision: none\n"
    "- Next agent action: none\n- Blockers summary: none\n"
    "- Executive note: n\n"
)


def _doc(slices):
    return {
        "dashboard_index": slices["dashboard_index"],
        "rows": slices["rows"],
        "decisions": slices["decisions"],
        "passthrough": {
            "title_line": slices["title_line"],
            "section_0b_md": slices["section_0b_md"],
            "section_1_preamble_md": slices.get("section_1_preamble_md", ""),
            "section_1_postamble_md": slices.get("section_1_postamble_md", ""),
            "section_1_header_md": slices.get("section_1_header_md", ""),
            "section_1_sep_md": slices.get("section_1_sep_md", ""),
            "section_3_md": slices["section_3_md"],
            "section_4_md": slices["section_4_md"],
            "trailing_md": slices["trailing_md"],
        },
    }


class ParseCompileRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fixture_doc(self):
        root = fixture.make_fixture_repo(self.tmp)
        handoff_path = root / ".private" / "pm" / "active" / "demo-task" / "HANDOFF.md"
        original = handoff_path.read_text(encoding="utf-8")
        slices = mm_compile.parse_handoff(original)
        return original, slices, _doc(slices)

    def test_fixture_round_trips_byte_exact(self):
        original, _slices, doc = self._fixture_doc()
        recompiled = mm_compile.compile_handoff(doc)
        self.assertTrue(mm_compile.round_trip_identical(original, recompiled))

    def test_has_section_0a_true_for_fixture(self):
        original, slices, _doc = self._fixture_doc()
        self.assertTrue(slices["has_section_0a"])

    def test_dashboard_index_has_21_fields(self):
        import mm_ledger
        _original, slices, _doc = self._fixture_doc()
        for field in mm_ledger.DASHBOARD_FIELDS:
            self.assertIn(field, slices["dashboard_index"])
        self.assertEqual(slices["dashboard_index"]["Task"], "demo-task")
        self.assertEqual(slices["dashboard_index"]["Project"], "smoke-project")

    def test_escaped_pipe_notes_cell_survives_byte_identical(self):
        _original, slices, _doc = self._fixture_doc()
        row1 = next(r for r in slices["rows"] if r["id"] == "#1")
        self.assertEqual(row1["notes_md"], "see `mm_ledger.py` \\| review thread")

    def test_section2_extra_consequence_field_survives(self):
        _original, slices, _doc = self._fixture_doc()
        q2 = next(d for d in slices["decisions"] if d["qid"] == "Q2")
        self.assertIn("- **Consequence:** every migrate run leaves a `<task>.bak-<ts>/` folder behind until pruned.",
                       q2["body_lines"])

    def test_red_glyph_row_round_trips_as_red(self):
        _original, slices, _doc = self._fixture_doc()
        row3 = next(r for r in slices["rows"] if r["id"] == "#3")
        self.assertEqual(row3["state"], "NEEDS_DECISION")
        self.assertTrue(row3["blocked"])

        rendered = mm_compile._render_row(row3)
        self.assertIn("\U0001f534", rendered)

    def test_no_glyph_status_cell_round_trips_verbatim(self):
        text = (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n"
            "| #1 | thing | Done | agent | not scheduled | note |\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )
        slices = mm_compile.parse_handoff(text)
        row = slices["rows"][0]
        self.assertFalse(row["status_glyph_present"])
        self.assertEqual(row["status_label"], "Done")

        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertTrue(mm_compile.round_trip_identical(text, recompiled))
        self.assertIn("| Done |", recompiled)


class Section2SeparatorRoundTripTests(unittest.TestCase):
    """Some real HANDOFFs put a '---' between Section 2 decision entries;
    others don't. Round-trip must preserve that per-entry, not assume a
    fixed style (see mm_migrate.py round-trip failure on real operator data)."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_separator_between_decisions_round_trips_byte_identical(self):
        text = (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n"
            "### Q4: Is this recorded?\n"
            "- **Status:** FINAL\n"
            "- **Source:** contract\n"
            "- **Date:** 2026-08-08\n"
            "- **Who:** operator\n"
            "- **Decision:** yes\n"
            "- **Why:** Recorded in the contract's own text.\n\n"
            "---\n\n"
            "### Q5: Is show_message in v1?\n"
            "- **Status:** TBD\n"
            "- **Source:** chat\n"
            "- **Date:** 2026-08-08\n"
            "- **Who:** operator\n"
            "- **Decision:** no\n"
            "- **Why:** deferred.\n\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )
        slices = mm_compile.parse_handoff(text)
        q4 = next(d for d in slices["decisions"] if d["qid"] == "Q4")
        next(d for d in slices["decisions"] if d["qid"] == "Q5")
        self.assertTrue(q4["sep_after"])

        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)
        self.assertTrue(mm_compile.round_trip_identical(text, recompiled))

    def test_fixture_first_decision_has_no_separator_by_default(self):
        # The fixture has no "---" between Q1 and Q2 inside Section 2 (only
        # the standard section-boundary "---" trails the LAST decision,
        # which compile ignores in favor of its own hardcoded separator --
        # see the sep_after docstring in compile_handoff).
        root = fixture.make_fixture_repo(self.tmp)
        handoff_path = root / ".private" / "pm" / "active" / "demo-task" / "HANDOFF.md"
        slices = mm_compile.parse_handoff(handoff_path.read_text(encoding="utf-8"))
        q1 = next(d for d in slices["decisions"] if d["qid"] == "Q1")
        self.assertFalse(q1["sep_after"])


class RoundTripIdenticalTests(unittest.TestCase):
    """round_trip_identical is byte-exact per SHARED INVARIANT 1: the ONLY
    normalisation is CRLF/CR -> LF. Every other difference -- trailing
    whitespace (a Markdown hard line break), blank-line-run length (structure
    inside a fenced code block) -- must be reported as a real difference. The
    predecessor `semantic_equal` silently ignored both, which would have let a
    lossy recompile pass as green; these tests are demonstrated RED against
    exactly that kind of corruption, not just green on identical input."""

    def test_identical_text_is_equal(self):
        self.assertTrue(mm_compile.round_trip_identical("a\nb\n", "a\nb\n"))

    def test_crlf_normalised_to_lf(self):
        self.assertTrue(mm_compile.round_trip_identical("a\r\nb\r\n", "a\nb\n"))

    def test_bare_cr_normalised_to_lf(self):
        self.assertTrue(mm_compile.round_trip_identical("a\rb\r", "a\nb\n"))

    def test_trailing_whitespace_difference_is_NOT_ignored(self):
        # Two trailing spaces is a Markdown hard line break -- stripping it
        # silently deletes real formatting. This must be RED.
        self.assertFalse(mm_compile.round_trip_identical("a  \nb\n", "a\nb\n"))

    def test_blank_run_length_difference_is_NOT_collapsed(self):
        # Blank-line count inside a fenced code block is significant content,
        # not filler -- collapsing 5 blanks to 3 must be RED.
        self.assertFalse(mm_compile.round_trip_identical("a\n\n\n\n\nb", "a\n\n\nb"))

    def test_real_content_difference_is_not_equal(self):
        self.assertFalse(mm_compile.round_trip_identical("a\nb\n", "a\nc\n"))

    def test_semantic_equal_alias_matches_round_trip_identical(self):
        # mm_migrate.py (not owned by this change) still calls semantic_equal
        # by its old name -- it must be the same strict, byte-exact check.
        self.assertIs(mm_compile.semantic_equal, mm_compile.round_trip_identical)
        self.assertFalse(mm_compile.semantic_equal("a  \nb\n", "a\nb\n"))
        self.assertTrue(mm_compile.semantic_equal("a\r\nb\r\n", "a\nb\n"))


class FencedCodeBlockRoundTripTests(unittest.TestCase):
    """A fenced command block in Section 0B (passthrough) with a Markdown hard
    line break and multi-blank-line spacing must survive parse -> compile
    byte-exact -- the exact shape of real operator handoffs full of fenced
    command blocks."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _text(self):
        fence = (
            "```bash\n"
            "git status  \n"  # trailing two spaces: hard line break
            "\n\n\n"          # a 3-blank-line run inside the fence
            "git diff\n"
            "```"
        )
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\n" + fence + "\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_fence_round_trips_byte_exact(self):
        text = self._text()
        slices = mm_compile.parse_handoff(text)
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)
        self.assertTrue(mm_compile.round_trip_identical(text, recompiled))

    def test_fence_corruption_is_caught_red(self):
        # Simulate what the OLD fuzzy semantic_equal would have masked: a
        # recompile that stripped the hard-break trailing spaces and
        # collapsed the blank-line run. round_trip_identical must say NO.
        text = self._text()
        corrupted = text.replace("git status  \n", "git status\n").replace("\n\n\n\n", "\n\n\n")
        self.assertNotEqual(text, corrupted)
        self.assertFalse(mm_compile.round_trip_identical(text, corrupted))


class DecisionHeaderDelimiterTests(unittest.TestCase):
    """DECISION_HEADER_RE must accept both '### Qn: question' (colon) and
    '### Qn - question' (dash) -- 72 of 85 Section 2 headers in a real
    operator HANDOFF use the dash style, and the colon-only regex silently
    dropped all of them from the recompile."""

    def _text(self, header_line):
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n"
            f"{header_line}\n"
            "- **Status:** FINAL\n"
            "- **Source:** chat\n"
            "- **Date:** 2026-08-08\n"
            "- **Who:** operator\n"
            "- **Decision:** yes\n"
            "- **Why:** because.\n\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_dash_style_header_is_parsed_not_dropped(self):
        text = self._text("### Q77 - Is our per-call flag actually honoured?")
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(len(slices["decisions"]), 1)
        d = slices["decisions"][0]
        self.assertEqual(d["qid"], "Q77")
        self.assertEqual(d["header_sep"], " - ")
        self.assertEqual(d["question"], "Is our per-call flag actually honoured?")

    def test_dash_style_header_round_trips_byte_exact(self):
        text = self._text("### Q77 - Is our per-call flag actually honoured?")
        slices = mm_compile.parse_handoff(text)
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_d_prefixed_id_is_parsed_not_dropped(self):
        # A real operator HANDOFF numbers every Section 2 entry "### D111: ..."
        # instead of "### Qn: ..." -- all 99 were silently dropped under the
        # old Q-only pattern.
        text = self._text("### D111: Is the backend actually deployed?")
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(len(slices["decisions"]), 1)
        self.assertEqual(slices["decisions"][0]["qid"], "D111")
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_colon_style_header_still_round_trips_byte_exact(self):
        text = self._text("### Q1: Is this recorded?")
        slices = mm_compile.parse_handoff(text)
        d = slices["decisions"][0]
        self.assertEqual(d["header_sep"], ": ")
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_delimiter_punctuation_is_not_normalised_across_mixed_entries(self):
        text = (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n"
            "### Q1: colon style\n"
            "- **Status:** FINAL\n"
            "- **Source:** chat\n"
            "- **Date:** 2026-08-08\n"
            "- **Who:** operator\n"
            "- **Decision:** yes\n"
            "- **Why:** because.\n\n"
            "### Q2 - dash style\n"
            "- **Status:** FINAL\n"
            "- **Source:** chat\n"
            "- **Date:** 2026-08-08\n"
            "- **Who:** operator\n"
            "- **Decision:** yes\n"
            "- **Why:** because.\n\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(len(slices["decisions"]), 2)
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)


class DecisionExtraFieldOrderingTests(unittest.TestCase):
    """An operator-invented extra field (e.g. '**Consequence:**', '**PM
    caveat:**') must keep its ORIGINAL position among the canonical fields,
    not be flattened to always trail after Status/Source/Date/Who/Decision/Why.
    Real HANDOFFs interleave extra fields freely, e.g.
    [Status, Source, Date, Who, Decision, Consequence, Why]."""

    def _text(self, field_lines):
        body = "\n".join(field_lines)
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n"
            "### Q91: Extra field in the middle?\n"
            f"{body}\n\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_extra_field_between_decision_and_why_keeps_its_position(self):
        field_lines = [
            "- **Status:** FINAL",
            "- **Source:** chat",
            "- **Date:** 2026-08-08",
            "- **Who:** operator",
            "- **Decision:** yes",
            "- **Provenance caveat:** re-derived first-hand, not relayed.",
            "- **Why:** because.",
        ]
        text = self._text(field_lines)
        slices = mm_compile.parse_handoff(text)
        d = slices["decisions"][0]
        self.assertEqual(d["body_lines"], field_lines)

        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

        # Prove the position actually matters: the caveat line must sit
        # between "Decision" and "Why", not after "Why".
        why_idx = recompiled.index("- **Why:**")
        caveat_idx = recompiled.index("- **Provenance caveat:**")
        decision_idx = recompiled.index("- **Decision:**")
        self.assertTrue(decision_idx < caveat_idx < why_idx)

    def test_canonical_fields_are_still_flattened_onto_the_dict(self):
        field_lines = [
            "- **Status:** FINAL",
            "- **Source:** chat",
            "- **Date:** 2026-08-08",
            "- **Who:** operator",
            "- **Decision:** yes",
            "- **Provenance caveat:** noted.",
            "- **Why:** because.",
        ]
        text = self._text(field_lines)
        slices = mm_compile.parse_handoff(text)
        d = slices["decisions"][0]
        self.assertEqual(d["status"], "FINAL")
        self.assertEqual(d["why"], "because.")


class Section1RowLossTests(unittest.TestCase):
    """A real HANDOFF row can (a) omit the optional trailing '|' and/or (b)
    contain a literal, unescaped '|' inside its Notes prose. Either one used
    to make the row's line fail the old `endswith('|')` gate and vanish
    entirely from the recompile -- 4 of 18 Section 1 rows disappeared this way
    on a real operator task."""

    def _text(self, row_line):
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n"
            f"{row_line}\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_row_with_embedded_pipe_and_no_trailing_pipe_is_not_dropped(self):
        row_line = (
            "| #2 | Backend handler | \U0001f7e2 Done | PM | not scheduled | "
            "risk A | risk B — the one that matters, not ours."
        )
        text = self._text(row_line)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(len(slices["rows"]), 1)
        row = slices["rows"][0]
        self.assertEqual(row["id"], "#2")
        self.assertFalse(row["notes_trailing_pipe"])
        self.assertEqual(row["notes_md"], "risk A | risk B — the one that matters, not ours.")

        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_row_with_normal_trailing_pipe_still_round_trips(self):
        row_line = "| #1 | thing | \U0001f7e2 Done | agent | not scheduled | plain note |"
        text = self._text(row_line)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(len(slices["rows"]), 1)
        row = slices["rows"][0]
        self.assertTrue(row["notes_trailing_pipe"])
        self.assertEqual(row["notes_md"], "plain note")

        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_embedded_pipe_in_status_cell_falls_back_to_verbatim_row(self):
        # A real operator row quoted a JS snippet like `a || b || c` inside the
        # STATUS cell (not Notes) -- this shifts the assumed column boundaries
        # themselves, so the 6-field model cannot safely decompose it. Must
        # fall back to a verbatim whole-row blob instead of corrupting it.
        row_line = (
            "| #8 | wiring | \U0001f7e2 DONE -- `isBotTyping || isSpeaking || "
            "isVideoPlaying` (`WidgetView.tsx:647`) | unassigned | not scheduled | note |"
        )
        text = self._text(row_line)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(len(slices["rows"]), 1)
        row = slices["rows"][0]
        self.assertTrue(row["row_verbatim"])
        self.assertEqual(row["raw_line"], row_line)

        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)


class Section1PreambleRoundTripTests(unittest.TestCase):
    """Section 1 can carry free prose before and/or after the table (a
    sub-heading, a status narrative) -- _parse_rows only ever looks at
    "|"-prefixed lines, so that prose used to be silently dropped rather than
    round-tripped as a verbatim passthrough blob."""

    def _text(self, preamble="", postamble=""):
        table = (
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n"
            "| #1 | thing | \U0001f7e2 Done | agent | not scheduled | note |"
        )
        section_1_body = "\n\n".join(c for c in (preamble, table, postamble) if c)
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n" + section_1_body + "\n\n---\n\n"
            "## Section 2 Decisions log\n\n---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_preamble_before_table_round_trips_byte_exact(self):
        preamble = (
            "### Where the implementation actually stands\n\n"
            "The backend shipped and a five-agent audit checked it against the SPEC."
        )
        text = self._text(preamble=preamble)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(slices["section_1_preamble_md"], preamble)
        self.assertEqual(len(slices["rows"]), 1)
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_postamble_after_table_round_trips_byte_exact(self):
        postamble = "**Confirmed working, so nobody re-audits it** -- with one correction."
        text = self._text(postamble=postamble)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(slices["section_1_postamble_md"], postamble)
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_preamble_and_postamble_together_round_trip_byte_exact(self):
        preamble = "### Status narrative\n\nSome prose before the table."
        postamble = "Some prose after the table."
        text = self._text(preamble=preamble, postamble=postamble)
        slices = mm_compile.parse_handoff(text)
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_no_preamble_or_postamble_is_unaffected(self):
        text = self._text()
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(slices["section_1_preamble_md"], "")
        self.assertEqual(slices["section_1_postamble_md"], "")
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)


class Section1TableShapeRoundTripTests(unittest.TestCase):
    """compile_handoff used to always emit a hardcoded 6-column Section 1
    header/separator (SECTION_1_HEADER/SECTION_1_SEP) regardless of what the
    source used. A real operator HANDOFF (a large multi-month task)
    uses a 5-column table with no Notes column -- those two lines were
    silently replaced by the 6-column constant on every recompile."""

    def _text(self, header, sep, row):
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            f"{header}\n{sep}\n{row}\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_five_column_table_header_and_separator_round_trip_byte_exact(self):
        header = "| ID | Item | Status | Owner | Target date |"
        sep = "|---|---|---|---|---|"
        row = "| #0 | Recon: scan all three repos | \U0001f7e2 Done | PM | 2026-07-28 |"
        text = self._text(header, sep, row)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(slices["section_1_header_md"], header)
        self.assertEqual(slices["section_1_sep_md"], sep)

        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertIn(header, recompiled)
        self.assertIn(sep, recompiled)
        self.assertEqual(text, recompiled)

    def test_when_header_first_cell_is_hash_it_is_not_parsed_as_a_row(self):
        header = "| # | Item | State | Owner | Notes |"
        sep = "|---|---|---|---|---|"
        row = "| 1 | Locate the code | 🟢 Done | PM | found it |"
        text = self._text(header, sep, row)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual([r["id"] for r in slices["rows"]], ["1"])
        self.assertEqual(slices["section_1_header_md"], header)
        self.assertEqual(text, mm_compile.compile_handoff(_doc(slices)))

    def test_check_cli_passes_on_five_column_table(self):
        header = "| ID | Item | Status | Owner | Target date |"
        sep = "|---|---|---|---|---|"
        row = "| #0 | Recon: scan all three repos | \U0001f7e2 Done | PM | 2026-07-28 |"
        text = self._text(header, sep, row)
        tmp = pathlib.Path(tempfile.mkdtemp())
        try:
            task_dir = tmp / "five-col-task"
            task_dir.mkdir()
            (task_dir / "HANDOFF.md").write_text(text, encoding="utf-8", newline="\n")
            self.assertEqual(mm_compile.main(["--check", str(task_dir)]), 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_standard_six_column_shape_is_unaffected(self):
        # The fixture (and 5 of 6 real task folders) use the standard
        # 6-column shape -- the captured header/sep must equal the module's
        # own constants there, so nothing regresses for the common case.
        header = mm_compile.SECTION_1_HEADER
        sep = mm_compile.SECTION_1_SEP
        row = "| #1 | thing | \U0001f7e2 Done | agent | not scheduled | note |"
        text = self._text(header, sep, row)
        slices = mm_compile.parse_handoff(text)
        self.assertEqual(slices["section_1_header_md"], mm_compile.SECTION_1_HEADER)
        self.assertEqual(slices["section_1_sep_md"], mm_compile.SECTION_1_SEP)
        recompiled = mm_compile.compile_handoff(_doc(slices))
        self.assertEqual(text, recompiled)

    def test_old_hardcoded_constants_are_the_six_column_shape_not_this_source(self):
        # Proves the round-trip above is really reading the SOURCE shape, not
        # coincidentally matching the module's hardcoded 6-column constants.
        self.assertNotEqual(mm_compile.SECTION_1_HEADER, "| ID | Item | Status | Owner | Target date |")
        self.assertNotEqual(mm_compile.SECTION_1_SEP, "|---|---|---|---|---|")


class ContentCompleteSectionOwnershipRedProofTests(unittest.TestCase):
    """content_complete's line-loss check used to build ONE multiset across
    the WHOLE file, so a line relocated from Section 1 into Section 4 still
    passed -- content preserved, meaning scrambled. The OLD whole-file
    algorithm is reproduced here (it no longer exists in the module, so it
    cannot be imported) to PROVE it passes this fixture; today's per-section
    content_complete must FAIL it and name Section 1 as the section the line
    went missing from."""

    def _handoff(self, section_1_postamble, section_4_body):
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            + section_1_postamble + "\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\n" + section_4_body + "\n"
        )

    @staticmethod
    def _old_whole_file_check(original, recompiled):
        from collections import Counter as _Counter

        def norm_counter(text):
            return _Counter(line.strip() for line in text.splitlines() if line.strip())

        missing = norm_counter(original) - norm_counter(recompiled)
        return not missing

    def test_line_relocated_from_section_1_to_section_4_old_check_passes_new_check_fails(self):
        marker = "RELOCATED: this line moved sections but nothing was lost file-wide."
        original = self._handoff(section_1_postamble=marker, section_4_body="none")
        recompiled = self._handoff(section_1_postamble="", section_4_body="none\n\n" + marker)

        # Nothing lost file-wide -- the line still exists exactly once,
        # just under a different heading. The OLD whole-file multiset check
        # calls this a PASS: exactly the defect being fixed.
        self.assertTrue(self._old_whole_file_check(original, recompiled))

        # The per-section check must FAIL this and name Section 1 as where
        # the line went missing from.
        report = mm_compile.content_complete(original, recompiled)
        self.assertFalse(report.passed)
        self.assertIn("1", report.missing_lines_by_section)
        self.assertIn(marker, report.missing_lines_by_section["1"])
        self.assertIn(marker, report.missing_lines)


class ContentCompleteTests(unittest.TestCase):
    """content_complete is the CONTENT-COMPLETE acceptance bar: no lost lines
    (as a multiset, whitespace-insensitive), no lost Section 1 row IDs, no
    lost Section 2 decision IDs, no lost Section 0A field names. Extra lines
    and layout differences are NOT failures -- only loss is."""

    def _handoff(self, section_1_rows="", section_2_body=""):
        table = (
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n" + section_1_rows
        )
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n" + table + "\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n" + section_2_body + "\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_identical_text_passes(self):
        text = self._handoff()
        report = mm_compile.content_complete(text, text)
        self.assertTrue(report.passed)
        self.assertEqual(report.missing_lines, [])
        self.assertEqual(report.missing_lines_total, 0)

    def test_extra_lines_in_recompiled_do_not_fail(self):
        original = "a\nb\nc\n"
        recompiled = "a\nb\nc\nd\ne\n"
        report = mm_compile.content_complete(original, recompiled)
        self.assertTrue(report.passed)

    def test_a_dropped_line_fails_and_is_named(self):
        original = "a\nb\nc\n"
        recompiled = "a\nc\n"
        report = mm_compile.content_complete(original, recompiled)
        self.assertFalse(report.passed)
        self.assertEqual(report.missing_lines, ["b"])
        self.assertEqual(report.missing_lines_total, 1)

    def test_multiset_line_loss_is_a_failure_even_though_the_line_still_exists(self):
        # "b" appears 3x in original, 2x in recompiled -- one occurrence lost.
        # A naive set-based diff would call this a pass; it must not.
        original = "b\nb\nb\n"
        recompiled = "b\nb\n"
        report = mm_compile.content_complete(original, recompiled)
        self.assertFalse(report.passed)
        self.assertEqual(report.missing_lines, ["b"])
        self.assertEqual(report.missing_lines_total, 1)

    def test_whitespace_only_line_difference_is_not_a_failure(self):
        original = "hello world\n"
        recompiled = "  hello world  \n"
        report = mm_compile.content_complete(original, recompiled)
        self.assertTrue(report.passed)

    def test_blank_lines_are_never_counted_as_missing(self):
        original = "a\n\n\nb\n"
        recompiled = "a\nb\n"
        report = mm_compile.content_complete(original, recompiled)
        self.assertTrue(report.passed)

    def test_dropped_section_1_row_id_is_named(self):
        original = self._handoff(
            "| #1 | thing one | \U0001f7e2 Done | agent | not scheduled | note one |\n"
            "| #2 | thing two | \U0001f7e2 Done | agent | not scheduled | note two |\n"
        )
        recompiled = self._handoff(
            "| #1 | thing one | \U0001f7e2 Done | agent | not scheduled | note one |\n"
        )
        report = mm_compile.content_complete(original, recompiled)
        self.assertFalse(report.passed)
        self.assertEqual(report.missing_row_ids, {"#2"})

    def test_dropped_section_2_decision_id_is_named(self):
        section_2 = (
            "### Q1: first?\n- **Status:** FINAL\n- **Source:** chat\n- **Date:** 2026-08-08\n"
            "- **Who:** operator\n- **Decision:** yes\n- **Why:** because.\n\n"
            "### Q2: second?\n- **Status:** FINAL\n- **Source:** chat\n- **Date:** 2026-08-08\n"
            "- **Who:** operator\n- **Decision:** yes\n- **Why:** because.\n"
        )
        original = self._handoff(section_2_body=section_2)
        recompiled = self._handoff(
            section_2_body=(
                "### Q1: first?\n- **Status:** FINAL\n- **Source:** chat\n- **Date:** 2026-08-08\n"
                "- **Who:** operator\n- **Decision:** yes\n- **Why:** because.\n"
            )
        )
        report = mm_compile.content_complete(original, recompiled)
        self.assertFalse(report.passed)
        self.assertEqual(report.missing_decision_ids, {"Q2"})

    def test_dropped_section_0a_field_is_named(self):
        original = self._handoff()
        recompiled = original.replace("- Owner: o\n", "")
        report = mm_compile.content_complete(original, recompiled)
        self.assertFalse(report.passed)
        self.assertIn("Owner", report.missing_0a_fields)

    def test_report_is_falsy_on_fail_and_truthy_on_pass(self):
        self.assertTrue(bool(mm_compile.content_complete("a\n", "a\n")))
        self.assertFalse(bool(mm_compile.content_complete("a\n", "")))


class ContentCompleteGuardrailsShapeRedProofTests(unittest.TestCase):
    """Reproduces the shape of the real defect on
    widget-latency-task: most Section 2 decision headers use the
    '### Qn - question' dash delimiter, and the historical colon-only
    DECISION_HEADER_RE silently dropped every one of them -- 72 of 85
    decisions on the real HANDOFF. This is NOT a test that today's parser has
    that bug (it doesn't -- DECISION_HEADER_RE now accepts both delimiters);
    it is a test that content_complete WOULD catch that exact regression if
    it ever returned: it must FAIL and name every missing Q identifier, a
    check nobody has seen fail is not a check."""

    def _decision_block(self, qid, sep):
        return (
            f"### {qid}{sep}Is this covered?\n"
            "- **Status:** FINAL\n- **Source:** chat\n- **Date:** 2026-08-08\n"
            "- **Who:** operator\n- **Decision:** yes\n- **Why:** because.\n"
        )

    def _handoff(self, section_2_body):
        return (
            "# HANDOFF - widget-latency-task\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n" + section_2_body + "\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_five_of_six_dash_style_decisions_dropped_is_caught_and_named(self):
        dash_qids = ["Q1", "Q2", "Q3", "Q4", "Q5"]
        all_blocks = "\n".join(self._decision_block(q, " - ") for q in dash_qids)
        all_blocks += "\n" + self._decision_block("Q6", ": ")  # one colon-style survivor
        original = self._handoff(all_blocks)

        # Simulate the historical regression: only the colon-style entry (Q6)
        # survives recompile -- exactly the "72 of 85 dropped" shape, scaled
        # down to 5 of 6.
        recompiled = self._handoff(self._decision_block("Q6", ": "))

        report = mm_compile.content_complete(original, recompiled)

        self.assertFalse(report.passed)
        self.assertEqual(report.missing_decision_ids, {"Q1", "Q2", "Q3", "Q4", "Q5"})
        self.assertGreater(report.missing_lines_total, 0)
        # Every dropped decision's own question line must be named as missing.
        for qid in dash_qids:
            self.assertTrue(
                any(qid in ln and "Is this covered?" in ln for ln in report.missing_lines),
                f"{qid} question line not named in missing_lines",
            )


class ContentCompleteWhitespaceOnlyGreenProofTests(unittest.TestCase):
    """A recompile that differs from the original ONLY in blank-line count,
    leading indentation, and trailing whitespace -- exactly what a
    from-scratch regeneration produces on the very first migration write --
    must PASS. Defending byte-exact layout against that shape was the wrong
    bar; three rounds were spent on it before this change."""

    def _text(self):
        return (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
            "## Section 0B Session Opener\n\nbody\n\n---\n\n"
            "## Section 1 Status\n\n"
            "| ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n"
            "| #1 | thing | \U0001f7e2 Done | agent | not scheduled | note |\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n"
            "### Q1: recorded?\n"
            "- **Status:** FINAL\n- **Source:** chat\n- **Date:** 2026-08-08\n"
            "- **Who:** operator\n- **Decision:** yes\n- **Why:** because.\n\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )

    def test_blank_lines_and_indentation_only_diff_passes(self):
        original = self._text()
        recompiled = (
            "# HANDOFF - x\n\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n\n"
            "## Section 0B Session Opener\n\n  body  \n\n\n---\n\n"
            "## Section 1 Status\n\n"
            "  | ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n\n"
            "  | #1 | thing | \U0001f7e2 Done | agent | not scheduled | note |   \n\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n"
            "### Q1: recorded?\n"
            "  - **Status:** FINAL\n- **Source:** chat  \n- **Date:** 2026-08-08\n"
            "- **Who:** operator\n- **Decision:** yes\n- **Why:** because.\n\n\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )
        self.assertNotEqual(original, recompiled)
        self.assertFalse(mm_compile.round_trip_identical(original, recompiled))

        report = mm_compile.content_complete(original, recompiled)
        self.assertTrue(report.passed)
        self.assertEqual(report.missing_lines, [])
        self.assertEqual(report.missing_row_ids, set())
        self.assertEqual(report.missing_decision_ids, set())
        self.assertEqual(report.missing_0a_fields, set())


class CliCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_check_exits_0_on_a_byte_exact_fixture(self):
        root = fixture.make_fixture_repo(self.tmp)
        task_dir = root / ".private" / "pm" / "active" / "demo-task"
        self.assertEqual(mm_compile.main(["--check", str(task_dir)]), 0)

    def test_check_exits_1_when_no_handoff_present(self):
        empty_dir = self.tmp / "no-handoff-here"
        empty_dir.mkdir()
        self.assertEqual(mm_compile.main(["--check", str(empty_dir)]), 1)

    def test_check_exits_0_on_content_complete_but_not_byte_exact_handoff(self):
        # The whole point of DECISION 1: a HANDOFF.md whose on-disk formatting
        # (indentation, extra blank lines) differs from what compile_handoff
        # would itself emit must still PASS, because no CONTENT was lost.
        text = (
            "# HANDOFF - x\n\n"
            "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n\n"
            "## Section 0B Session Opener\n\n  body  \n\n\n---\n\n"
            "## Section 1 Status\n\n"
            "  | ID | Item | Status | Owner | Target date | Notes |\n"
            "|----|------|--------|-------|-------------|-------|\n"
            "  | #1 | thing | \U0001f7e2 Done | agent | not scheduled | note |   \n\n\n"
            "---\n\n"
            "## Section 2 Decisions log\n\n"
            "### Q1: recorded?\n"
            "  - **Status:** FINAL\n- **Source:** chat  \n- **Date:** 2026-08-08\n"
            "- **Who:** operator\n- **Decision:** yes\n- **Why:** because.\n\n\n"
            "---\n\n"
            "## Section 3 Open questions\n\nnone\n\n---\n\n"
            "## Section 4 Archive\n\nnone\n"
        )
        task_dir = self.tmp / "quirky-task"
        task_dir.mkdir()
        (task_dir / "HANDOFF.md").write_text(text, encoding="utf-8", newline="\n")

        recompiled_would_be = mm_compile.compile_handoff(
            mm_compile._doc_from_slices(mm_compile.parse_handoff(text))
        )
        self.assertFalse(mm_compile.round_trip_identical(text, recompiled_would_be))

        self.assertEqual(mm_compile.main(["--check", str(task_dir)]), 0)

    def test_print_completeness_report_names_missing_lines_ids_and_truncates_at_40(self):
        missing_lines = [f"line {i}" for i in range(45)]
        report = mm_compile.CompletenessReport(
            passed=False, missing_lines=missing_lines, missing_lines_total=45,
            missing_row_ids={"#3"}, missing_decision_ids={"Q7", "Q8"}, missing_0a_fields={"Owner"},
        )
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            mm_compile._print_completeness_report(report)
        out = buf.getvalue()
        self.assertIn("showing first 40 of 45 total", out)
        self.assertIn("line 0", out)
        self.assertIn("line 39", out)
        self.assertNotIn("line 40", out)
        self.assertIn("#3", out)
        self.assertIn("Q7", out)
        self.assertIn("Q8", out)
        self.assertIn("Owner", out)



def _ledger_doc():
    import mm_ledger
    doc = mm_ledger.new_ledger("widget", "smoke-project")
    base = {"blocked": False, "blocked_reason": "", "owner": "agent", "target_date": "not scheduled",
            "notes_md": "", "history": []}
    doc["rows"] = [
        dict(base, id="#1", item="Build the <widget> & its tests", state="DONE", status_label="Done",
             is_wrapup=False, test_level="unit"),
        dict(base, id="#2", item="Review the widget", state="IMPLEMENTING", status_label="In progress",
             is_wrapup=False),
        dict(base, id="#3", item="Wrap up: insights review + move to done/", state="BACKLOG",
             status_label="Not started", is_wrapup=True, owner="PM"),
    ]
    doc["decisions"] = [{
        "qid": "Q1", "header_sep": ": ", "question": "Use plan A", "status": "FINAL", "source": "chat",
        "date": "2026-01-01", "who": "Test Operator", "decision": "Use plan A", "why": "simplest",
        "body_lines": ["- **Status:** FINAL", "- **Decision:** Use plan A"], "sep_after": False,
    }]
    return doc


class FenceAwareSectionTests(unittest.TestCase):
    TEXT = (
        "# HANDOFF — fenced\n\n"
        "## Section 0A Dashboard Index\n\n" + DASHBOARD_FIELDS_BLOCK + "\n"
        "## Section 0B Session Opener\n\n"
        "An example of a HANDOFF, quoted:\n\n"
        "```markdown\n## Section 1 Status\n| #9 | quoted row | x | y | z | w |\n```\n\n"
        "---\n\n"
        "## Section 1 Status\n\n"
        "| ID | Item | Status | Owner | Target date | Notes |\n"
        "|----|------|--------|-------|-------------|-------|\n"
        "| #1 | real row | \U0001f7e1 In progress | agent | not scheduled | note |\n\n"
        "---\n\n"
        "## Section 2 Decisions log\n\n---\n\n"
        "## Section 3 Open questions\n\n---\n\n"
        "## Section 4 Archive\n"
    )

    def test_heading_inside_code_fence_does_not_split_sections(self):
        slices = mm_compile.parse_handoff(self.TEXT)
        self.assertIn("```markdown\n## Section 1 Status\n", slices["section_0b_md"])
        self.assertEqual([r["id"] for r in slices["rows"]], ["#1"])
        spans = mm_compile._section_spans(self.TEXT)
        self.assertIn("quoted row", spans["0b"])
        self.assertNotIn("quoted row", spans["1"])

    def test_fenced_heading_handoff_round_trips_byte_exact(self):
        slices = mm_compile.parse_handoff(self.TEXT)
        self.assertEqual(mm_compile.compile_handoff(_doc(slices)), self.TEXT)


class GeneratedFilesTests(unittest.TestCase):
    def test_generated_handoff_starts_with_header_and_parses_like_the_body(self):
        doc = _ledger_doc()
        files = mm_compile.render_files(doc)
        text = files["HANDOFF.md"]
        self.assertEqual(text.split("\n", 1)[0], mm_compile.GENERATED_HEADER)
        self.assertEqual(text.split("\n", 1)[1], mm_compile.compile_handoff(doc))
        self.assertEqual(mm_compile.parse_handoff(text)["title_line"], "# HANDOFF — widget")

    def test_compile_generates_roadmap_from_ledger(self):
        doc = _ledger_doc()
        roadmap = mm_compile.render_files(doc)["ROADMAP.html"]
        self.assertEqual(roadmap.split("\n", 1)[0], mm_compile.GENERATED_HEADER)
        self.assertNotIn("{{", roadmap)
        self.assertIn("widget — PM Roadmap", roadmap)
        self.assertIn("Build the &lt;widget&gt; &amp; its tests", roadmap)
        self.assertIn("Review the widget", roadmap)
        self.assertIn("Use plan A", roadmap)
        self.assertEqual(roadmap, mm_compile.render_files(doc)["ROADMAP.html"])
        doc["rows"][1]["item"] = "Review the gadget"
        self.assertIn("Review the gadget", mm_compile.render_files(doc)["ROADMAP.html"])

    def test_archive_file_exists_only_when_the_ledger_holds_archived_entries(self):
        doc = _ledger_doc()
        self.assertNotIn("HANDOFF-archive.md", mm_compile.render_files(doc))
        doc["archive"] = {"file": "HANDOFF-archive.md", "rows": [doc["rows"].pop(0)],
                          "decisions": [doc["decisions"].pop(0)]}
        files = mm_compile.render_files(doc)
        archive = files["HANDOFF-archive.md"]
        self.assertEqual(archive.split("\n", 1)[0], mm_compile.GENERATED_HEADER)
        self.assertIn("Build the <widget> & its tests", archive)
        self.assertIn("### Q1: Use plan A", archive)
        self.assertIn("HANDOFF-archive.md", files["HANDOFF.md"].split("## Section 4 Archive", 1)[1])

    def test_loop_state_renders_at_the_end_of_section_0b(self):
        doc = _ledger_doc()
        doc["loop"] = {"mode": "unattended", "routes": ["bg-it:sonnet"], "noop_count": 2, "noop_cap": 5,
                       "last_tick": {"at": "2026-01-01T10:00:00+00:00", "result": "noop"}}
        text = mm_compile.compile_handoff(doc)
        section_0b = text.split("## Section 0B Session Opener", 1)[1].split("## Section 1 Status", 1)[0]
        self.assertIn("### Loop", section_0b)
        self.assertIn("Loop: unattended | routes bg-it:sonnet | no-ops 2/5 | last tick "
                      "2026-01-01T10:00:00+00:00 noop", section_0b)

    def test_table_cells_escape_unescaped_pipes_but_notes_stay_verbatim(self):
        doc = _ledger_doc()
        doc["rows"][1]["item"] = "a|b"
        doc["rows"][1]["notes_md"] = "x|y"
        line = [l for l in mm_compile.compile_handoff(doc).splitlines() if l.startswith("| #2 ")][0]
        self.assertIn("| a\\|b |", line)
        self.assertTrue(line.endswith("| x|y |"))


class SectionRegistryTests(unittest.TestCase):
    def test_every_heading_of_a_compiled_handoff_is_in_the_registry(self):
        doc = _ledger_doc()
        headings = {s["heading"] for s in mm_compile.section_registry(doc)}
        for line in mm_compile.compile_handoff(doc).splitlines():
            if line.startswith("## "):
                self.assertIn(line, headings)

    def test_text_sections_map_to_passthrough_keys(self):
        ids = {s["id"] for s in mm_compile.section_registry(_ledger_doc()) if s["kind"] == "text"}
        self.assertEqual(ids, set(mm_compile.TEXT_SECTIONS))
        self.assertEqual(set(mm_compile.TEXT_SECTIONS),
                         {"0b", "1-preamble", "1-postamble", "3", "4", "trailing"})


class DriftDiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.doc = _ledger_doc()
        self.doc["revision"] = 4
        self.files = mm_compile.render_files(self.doc)
        mm_compile.record_compile(self.doc, self.files, 4)
        for name, text in self.files.items():
            (self.tmp / name).write_text(text, encoding="utf-8", newline="\n")

    def _kinds(self):
        return {name: kind for name, kind, _ in mm_compile.diagnose(self.tmp, self.doc)}

    def test_in_sync_folder_is_ok(self):
        self.assertEqual(set(self._kinds().values()), {"OK"})

    def test_crlf_checkout_is_still_ok(self):
        path = self.tmp / "HANDOFF.md"
        compiled = path.read_bytes()
        path.write_bytes(compiled.replace(b"\n", b"\r\n"))
        with mock.patch.object(mm_git, "checkout_form", return_value=compiled) as asked:
            self.assertEqual(self._kinds()["HANDOFF.md"], "OK")
        self.assertEqual(asked.call_args[0][1], compiled.replace(b"\n", b"\r\n"))
        with mock.patch.object(mm_git, "checkout_form", return_value=None):
            self.assertEqual(self._kinds()["HANDOFF.md"], "HANDOFF-EDITED")

    def test_one_byte_hand_edit_is_handoff_edited(self):
        path = self.tmp / "HANDOFF.md"
        data = bytearray(path.read_bytes())
        data[-2] = ord("q") if data[-2] != ord("q") else ord("r")
        path.write_bytes(bytes(data))
        self.assertEqual(self._kinds()["HANDOFF.md"], "HANDOFF-EDITED")

    def test_ledger_moved_on_is_ledger_ahead(self):
        self.doc["rows"][1]["item"] = "Review the gadget"
        self.doc["revision"] = 5
        self.assertEqual(self._kinds()["HANDOFF.md"], "LEDGER-AHEAD")

    def test_folder_without_record_and_without_header_is_header_missing(self):
        del self.doc["compile_record"]
        (self.tmp / "HANDOFF.md").write_text(mm_compile.compile_handoff(self.doc), encoding="utf-8",
                                              newline="\n")
        (self.tmp / "ROADMAP.html").write_text("<html>hand made</html>\n", encoding="utf-8")
        kinds = self._kinds()
        self.assertEqual(kinds["HANDOFF.md"], "HEADER-MISSING")
        self.assertEqual(kinds["ROADMAP.html"], "NOT-GENERATED")

    def test_folder_without_record_that_differs_is_unknown(self):
        del self.doc["compile_record"]
        (self.tmp / "HANDOFF.md").write_text("# something else\n", encoding="utf-8")
        self.assertEqual(self._kinds()["HANDOFF.md"], "UNKNOWN")


class CapFindingsTests(unittest.TestCase):
    def _codes(self, doc):
        return {code: level for level, code, _ in mm_compile.findings(doc)}

    def test_clean_ledger_has_no_findings(self):
        self.assertEqual(self._codes(_ledger_doc()), {})

    def test_field_warn_and_fail_tiers(self):
        doc = _ledger_doc()
        doc["dashboard_index"]["Executive note"] = "x" * 251
        self.assertEqual(self._codes(doc).get("FIELD-LONG"), "warn")
        doc["dashboard_index"]["Executive note"] = "x" * 401
        self.assertEqual(self._codes(doc).get("FIELD-OVER-CAP"), "fix")

    def test_cell_over_600_chars_and_wrapup_not_last_are_fixable(self):
        doc = _ledger_doc()
        doc["rows"][1]["notes_md"] = "n" * 601
        doc["rows"].append(dict(doc["rows"][0], id="#4", is_wrapup=False))
        codes = self._codes(doc)
        self.assertEqual(codes.get("CELL-OVER-CAP"), "fix")
        self.assertEqual(codes.get("WRAPUP-NOT-LAST"), "fix")

    def test_off_enum_0a_value_is_fixable(self):
        doc = _ledger_doc()
        doc["dashboard_index"]["Status"] = "in-progress"
        self.assertEqual(self._codes(doc).get("FIELD-OFF-ENUM"), "fix")

    def test_section_0_over_16kb_is_fixable_and_over_10kb_warns(self):
        doc = _ledger_doc()
        doc["passthrough"]["section_0b_md"] = "y" * (11 * 1024)
        self.assertEqual(self._codes(doc).get("SECTION0-LARGE"), "warn")
        doc["passthrough"]["section_0b_md"] = "y" * (17 * 1024)
        self.assertEqual(self._codes(doc).get("SECTION0-OVER-CAP"), "fix")



class ArchaeologyCheckTests(unittest.TestCase):
    def setUp(self):
        import os
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"MM_AUTO_COMMIT": "off", "MM_STATE_DIR": str(self.tmp / "state")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.task = self.tmp / "proj" / ".private" / "pm" / "active" / "widget"
        self.mm("scaffold", "--task-dir", self.task, "--task", "widget", "--project", "smoke-project",
                "--row", "Build the widget")

    def mm(self, *argv, code=0):
        import mm
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            rc = mm.main([str(a) for a in argv])
        self.assertEqual(rc, code, out.getvalue())
        return out.getvalue()

    def test_when_a_ledger_note_contains_re_diagnosed_check_prints_warning_archaeology_and_keeps_exit_0(self):
        self.mm("edit-row", "--task-dir", self.task, "--id", "#1", "--notes", "the crash was Re-diagnosed today")
        out = self.mm("check", "--task-dir", self.task)
        self.assertIn("warning ARCHAEOLOGY:", out)
        self.assertIn("re-diagnosed", out)
        self.assertIn("MM-CHECK-OK", out)
        self.mm("set-section", "--task-dir", self.task, "--id", "3", "--text", "Old content below: the first plan")
        out = self.mm("check", "--task-dir", self.task)
        self.assertIn("old content below", out)

    def test_when_the_symptom_sits_in_section_4_archive_check_reports_nothing(self):
        self.mm("set-section", "--task-dir", self.task, "--id", "4", "--text",
                "re-diagnosed twice; preserved for audit trail\nold content below")
        out = self.mm("check", "--task-dir", self.task)
        self.assertNotIn("ARCHAEOLOGY", out)
        self.assertIn("MM-CHECK-OK", out)

    def test_when_old_content_below_is_not_at_a_line_start_check_reports_nothing(self):
        self.mm("edit-row", "--task-dir", self.task, "--id", "#1", "--notes", "see the old content below the fold")
        self.assertNotIn("ARCHAEOLOGY", self.mm("check", "--task-dir", self.task))

    def test_check_handoff_patterns_equal_the_core_archaeology_symptoms(self):
        import ast
        import mm_schema
        hook = pathlib.Path(__file__).resolve().parent.parent.parent / "hooks" / "check-handoff.py"
        tree = ast.parse(hook.read_text(encoding="utf-8"))
        values = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                if node.targets[0].id in ("patterns", "ANCHOR_AT_LINE_START"):
                    values[node.targets[0].id] = node.value
        patterns = ast.literal_eval(values["patterns"])
        anchored = set(ast.literal_eval(values["ANCHOR_AT_LINE_START"].args[0]))
        self.assertEqual(len(patterns), 5)
        self.assertEqual(tuple(patterns), getattr(mm_schema, "ARCHAEOLOGY_SYMPTOMS", None))
        self.assertEqual(anchored, set(getattr(mm_schema, "ARCHAEOLOGY_LINE_START", ())))


if __name__ == "__main__":
    unittest.main()
