"""HANDOFF.md compiler: the ONLY writer of HANDOFF.md. ROADMAP.html and the status cell are rendered in
mm_roadmap, the section registry lives in mm_sections; both are re-exported here.

parse_handoff turns text into ledger-shaped slices; compile_handoff regenerates
Section 0A/1/2 from structure and re-emits passthrough blobs byte-for-byte. The
"---" separators BETWEEN sections (references/handoff-template.md) are a
template constant this module emits on compile and strips on parse; the
passthrough shape has no slot for them. A "---" seen INSIDE Section 2, between
two decision entries, is not a fixed template constant -- real HANDOFFs carry
it on some entries and not others, so each decision dict carries a per-entry
`sep_after` flag recording whether one followed it in the source text; compile
re-emits it only where parse saw it. Rows carry an internal
`status_glyph_present` flag, not part of the shared row shape: real HANDOFFs
sometimes have a plain-English Status cell with no emoji glyph. True means the
cell round-trips through state_to_glyph(state, blocked); False means
status_label holds the whole original cell and compile re-emits it verbatim,
untouched by state. Rows also carry an internal `notes_trailing_pipe` flag:
a GFM table row's closing "|" is optional, and a real Notes cell can contain
its own literal, unescaped "|" as prose -- so parsing splits only the first 5
column delimiters and keeps the Notes cell as one verbatim tail, recording
whether that tail itself ended in a real closing pipe. That still is not
enough for every real row: a Status or Item cell can ALSO carry a literal
unescaped "|" (e.g. a `a || b` JS snippet quoted mid-sentence), which shifts
the assumed column boundaries themselves and makes 6-field decomposition
ambiguous. Parsing self-checks every row by immediately re-rendering it and
comparing to the source line; a mismatch means the row cannot be represented
by the model, so it is kept as a verbatim passthrough blob (`row_verbatim` +
`raw_line`) per SHARED INVARIANT 1, instead of guessed at. Section 1 itself
can carry free prose before and/or after the table (a sub-heading, a status
narrative) -- `section_1_preamble_md` and `section_1_postamble_md` passthrough
blobs capture whatever sits outside the first/last table-shaped line, the
same verbatim-blob treatment as section_0b_md/section_3_md/section_4_md.

Decision entries are stored as `body_lines`: the entry's field/content lines,
VERBATIM, IN ORIGINAL ORDER -- canonical fields (Status/Source/Date/Who/
Decision/Why), operator-invented extra fields ("**Consequence:**", "**PM
caveat:**", ...), and bare continuation lines all interleave freely in real
HANDOFFs, and only preserving the raw original sequence keeps that lossless.
A parsed decision ALSO carries the canonical fields flattened onto the dict
(status/source/date/who/decision/why) for callers that just want a value by
name; those are derived from body_lines and are not used for rendering.
"""

import argparse
import hashlib
import pathlib
import re
import sys
from collections import Counter
from dataclasses import dataclass, field

if __name__ == "__main__":
    sys.dont_write_bytecode = True
import mm_atomic
import mm_git
import mm_ledger
import mm_schema
from mm_roadmap import render_roadmap, status_cell
from mm_sections import SECTION_HEADINGS, TEXT_SECTIONS, section_registry  # noqa: F401 (re-exported)

GENERATED_HEADER = mm_schema.GENERATED_HEADER

# A Section 0A-4 heading is its number plus its canonical title. Legacy HANDOFFs also write the number as
# "\u00a7 N" (or its legacy code-page mojibake "\u05b2\u00a7 N") and put a hyphen or an em dash before the
# title; compile always emits the canonical "## Section N Title". A numbered heading with any other title is
# not a section boundary: it stays text of the section it sits in.
_HEADING_NUMBER = "(?:Section\\s+|\u05b2?\u00a7\\s*)"
_HEADING_SEP = "(?:\\s*[\u2014-]\\s*|\\s+)"
_SECTION_RE = {
    key: re.compile(rf"^##\s+{_HEADING_NUMBER}{number}{_HEADING_SEP}{title}\s*$", re.IGNORECASE | re.MULTILINE)
    for key, number, title in (
        ("0a", "0A", r"Dashboard\s+Index"), ("0b", "0B", r"Session\s+Opener"), ("1", "1", r"Status"),
        ("2", "2", r"Decisions\s+log"), ("3", "3", r"Open\s+questions"), ("4", "4", r"Archive"),
    )
}
_SECTION_ORDER = ("0a", "0b", "1", "2", "3", "4")


_FENCE_OPEN_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def _fenced_line_starts(text: str) -> set:
    """Offsets of every line that sits inside a fenced code block, fence
    lines included. A heading quoted inside a fence is content, not a
    section boundary."""
    inside = set()
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        m = _FENCE_OPEN_RE.match(line)
        if fence is None and m:
            fence = m.group(1)
            inside.add(offset)
        elif fence is not None:
            inside.add(offset)
            stripped = line.strip()
            if stripped and set(stripped) == {fence[0]} and len(stripped) >= len(fence):
                fence = None
        offset += len(line)
    return inside


def _section_matches(text: str) -> dict:
    fenced = _fenced_line_starts(text)
    found = {}
    for key, rx in _SECTION_RE.items():
        found[key] = next((m for m in rx.finditer(text) if m.start() not in fenced), None)
    return found


def is_section_heading(line: str) -> bool:
    """True for a line compile_handoff emits as a Section 0A-4 heading."""
    return any(rx.match(line) for rx in _SECTION_RE.values())


def strip_generated_header(text: str) -> str:
    first, sep, rest = text.partition("\n")
    return rest if sep and first.rstrip("\r") == GENERATED_HEADER else text


def _section_spans(text: str) -> dict:
    """Slice `text` into its structural regions -- "preamble" (everything
    before the first "## Section" marker) plus each of 0A/0B/1/2/3/4 -- using
    the same markers parse_handoff locates. content_complete compares line
    multisets PER SECTION using this, instead of one multiset across the
    whole file, so a line that moved from one section into another (content
    preserved, meaning scrambled) is caught rather than silently passing.
    """
    matches = _section_matches(text)
    present = [k for k in _SECTION_ORDER if matches[k]]
    spans = {"preamble": text[:matches[present[0]].start()] if present else text}
    for i, key in enumerate(present):
        start = matches[key].end()
        end = matches[present[i + 1]].start() if i + 1 < len(present) else len(text)
        spans[key] = text[start:end]
    for key in _SECTION_ORDER:
        spans.setdefault(key, "")
    return spans


FIELD_LINE_RE = re.compile(r"^\s*-\s+([^:]+):\s*(.*)$")
# Real HANDOFFs use two header styles interchangeably: "### Q77 - question"
# (dash) and "### Q1: question" (colon). Group 2 captures the exact delimiter
# text (including its surrounding whitespace) verbatim, so compile re-emits
# whichever punctuation the operator actually used instead of normalising it.
# The ID letter is not fixed to "Q" either -- one real HANDOFF numbers every
# Section 2 entry "### D111: ..." instead, dropping all 99 of them under the
# old Q-only pattern. Accept any uppercase-letter-prefixed ID.
DECISION_HEADER_RE = re.compile(r"^###\s+([A-Z]+\d+)(\s*[:\-]\s*)(.*)$", re.MULTILINE)
DECISION_FIELD_RE = re.compile(r"^-\s+\*\*([^*:]+):\*\*\s?(.*)$")
_ROW_SPLIT_RE = re.compile(r"(?<!\\)\|")
_UNESCAPED_TRAILING_PIPE_RE = re.compile(r"(?<!\\)\|$")
WRAPUP_LITERALS = mm_schema.WRAPUP_LITERALS
_FALLBACK_KEYWORDS = (
    ("blocked", "NEEDS_DECISION", True), ("waiting", "NEEDS_DECISION", True),
    ("in progress", "IMPLEMENTING", False), ("done", "DONE", False), ("abandoned", "ABANDONED", False),
    ("deferred", "BACKLOG", False), ("not started", "BACKLOG", False),
)
SECTION_1_HEADER = "| ID | Item | Status | Owner | Target date | Notes |"
SECTION_1_SEP = "|----|------|--------|-------|-------------|-------|"
DECISION_FIELD_ORDER = ("status", "source", "date", "who", "decision", "why")
DECISION_FIELD_LABELS = dict(zip(DECISION_FIELD_ORDER, ("Status", "Source", "Date", "Who", "Decision", "Why")))

def _strip_trailing_separator(body: str) -> str:
    lines = body.lstrip("\n").rstrip().split("\n")
    if lines and lines[-1].strip() == "---":
        lines.pop()
        while lines and lines[-1].strip() == "":
            lines.pop()
    return "\n".join(lines)


def _parse_status_cell(cell: str):
    if cell and cell[0] in mm_ledger.GLYPH_TO_STATE:
        state, blocked = mm_ledger.GLYPH_TO_STATE[cell[0]]
        return state, blocked, cell[1:].strip(), True
    lowered = cell.lower()
    for keyword, state, blocked in _FALLBACK_KEYWORDS:
        if keyword in lowered:
            return state, blocked, cell, False
    return "BACKLOG", False, cell, False


def _split_section1(body: str) -> tuple:
    """Split Section 1's raw body into (preamble_md, table_md, postamble_md).

    The table region is everything from the first "|"-prefixed line through
    the last one; free prose the operator wrote before or after the table
    (a sub-heading, a status narrative) is carved off as verbatim passthrough
    rather than silently dropped by _parse_rows, which only ever looks at
    "|"-prefixed lines.
    """
    lines = body.splitlines()
    row_line_idxs = [i for i, ln in enumerate(lines) if ln.strip().startswith("|")]
    if not row_line_idxs:
        return body.strip("\n"), "", ""
    start, end = row_line_idxs[0], row_line_idxs[-1]
    preamble_md = "\n".join(lines[:start]).strip("\n")
    table_md = "\n".join(lines[start:end + 1])
    postamble_md = "\n".join(lines[end + 1:]).strip("\n")
    return preamble_md, table_md, postamble_md


def _extract_table_shape(table_md: str) -> tuple:
    """Return (header_line, sep_line) as found in the source table region.

    compile_handoff used to always emit a hardcoded 6-column header/separator
    (SECTION_1_HEADER/SECTION_1_SEP). A real operator HANDOFF can use a
    different column shape (e.g. 5 columns, no Notes) -- re-emitting the
    constant instead of the source shape silently lost those two lines.
    Capturing them here lets compile re-emit whatever shape the source had.
    """
    lines = [ln for ln in table_md.splitlines() if ln.strip()]
    if not lines:
        return "", ""
    header_line = lines[0]
    sep_line = ""
    if len(lines) > 1:
        candidate = lines[1].strip()
        if candidate.startswith("|") and set(candidate) <= set("-|: \t"):
            sep_line = lines[1]
    return header_line, sep_line


def _is_separator(line: str) -> bool:
    return line.startswith("|") and set(line) <= set("-|: \t")


def _parse_rows(body: str) -> list:
    rows = []
    lines = [raw.strip() for raw in body.splitlines() if raw.strip()]
    for i, line in enumerate(lines):
        if not line.startswith("|") or _is_separator(line):
            continue
        if i + 1 < len(lines) and _is_separator(lines[i + 1]):
            continue  # a table header: the line right above the separator, whatever its first cell says
        # Split only the first 5 unescaped "|" delimiters (id/item/status/owner/
        # target date). Everything after the 5th is the Notes cell, kept as ONE
        # verbatim tail -- whether or not it contains its own literal unescaped
        # "|" and whether or not it ends in a closing pipe (GFM makes the
        # trailing "|" optional). Splitting on every pipe instead would either
        # misalign a row whose prose contains "|" or drop rows outright when the
        # closing pipe is absent -- both seen in real operator HANDOFFs.
        segments = _ROW_SPLIT_RE.split(line, maxsplit=6)
        cells = [c.strip() for c in segments[1:6]]
        if not cells or cells[0].lower() == "id":
            continue
        tail = segments[6] if len(segments) > 6 else ""
        trailing_pipe = bool(_UNESCAPED_TRAILING_PIPE_RE.search(tail))
        notes_md = tail[:-1].strip() if trailing_pipe else tail.strip()
        row_id, item, status_cell, owner, target_date = (cells + [""] * 5)[:5]
        state, blocked, status_label, glyph_present = _parse_status_cell(status_cell)
        row = {
            "id": row_id, "item": item, "state": state, "blocked": blocked, "blocked_reason": "",
            "status_label": status_label, "status_glyph_present": glyph_present, "owner": owner,
            "target_date": target_date, "notes_md": notes_md, "notes_trailing_pipe": trailing_pipe,
            "history": [],
            "is_wrapup": any(item.startswith(w) for w in WRAPUP_LITERALS),
        }
        if _render_row(row) != line:
            # A cell other than Notes (commonly Status) also carries a literal
            # unescaped "|" -- e.g. a quoted `a || b` JS snippet -- which shifts
            # the assumed 5-delimiter column boundaries and makes structured
            # decomposition unsafe. Fall back to a verbatim whole-row blob
            # rather than silently corrupt or re-format it.
            row["row_verbatim"] = True
            row["raw_line"] = line
        rows.append(row)
    return rows


def _parse_decisions(body: str) -> list:
    decisions = []
    matches = list(DECISION_HEADER_RE.finditer(body))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        body_lines = []
        fields = {k: "" for k in DECISION_FIELD_ORDER}
        sep_after = False
        for raw in body[m.end():end].splitlines():
            line = raw.strip()
            if line == "---":
                # Some HANDOFFs put a "---" divider between decision entries
                # within Section 2 (in addition to the standard block "---"
                # already emitted between sections). Record its presence per
                # entry rather than assuming a fixed style, so compile can
                # re-emit it losslessly only where it was actually there.
                sep_after = True
                continue
            if not line:
                continue
            # Every non-blank, non-separator line is kept verbatim, IN ORIGINAL
            # ORDER -- canonical field, operator-invented extra field, or a bare
            # continuation line. This is what lets interleaved extra fields
            # ("**Consequence:**" between "**Decision:**" and "**Why:**", etc.)
            # round-trip byte-exact instead of being reordered to the end.
            body_lines.append(line)
            fm = DECISION_FIELD_RE.match(line)
            name = fm.group(1).strip().lower() if fm else None
            if fm and name in fields:
                fields[name] = fm.group(2).strip()
        decisions.append({"qid": m.group(1), "header_sep": m.group(2), "question": m.group(3),
                           "body_lines": body_lines, "sep_after": sep_after, **fields})
    return decisions


def parse_handoff(text: str) -> dict:
    text = strip_generated_header(text)
    m = _section_matches(text)
    title_line = text.split("\n", 1)[0].rstrip("\r")
    if not m["0a"]:
        return {"title_line": title_line, "has_section_0a": False, "dashboard_index": {}, "section_0a_loose_md": "",
                "section_0b_md": "", "section_1_preamble_md": "", "rows": [], "section_1_postamble_md": "",
                "section_1_header_md": "", "section_1_sep_md": "", "decisions": [],
                "section_3_md": "", "section_4_md": "", "trailing_md": ""}

    def end_of(*fallback_keys):
        for key in fallback_keys:
            if m[key]:
                return m[key].start()
        return len(text)

    # The first line of each Section 0A field holds its value. Every other line of the 0A body (a later
    # repeat of a field, a field-like line with an unknown name, a rationale paragraph, an old-values
    # block) is loose text, which migrate carries verbatim to HANDOFF-archive.md (carry_section_0a): the
    # exact body lines with their own terminators, blank-line edges included, with only the field lines
    # taken out. A body that is blank apart from its fields carries nothing.
    dashboard_index = {}
    loose = []
    heading_end = text.find("\n", m["0a"].start())
    body_end = end_of("0b", "1", "2", "3", "4")
    for line in (text[heading_end + 1:body_end] if 0 <= heading_end < body_end else "").splitlines(True):
        fm = FIELD_LINE_RE.match(line.rstrip("\r\n"))
        name = fm.group(1).strip() if fm else None
        if name is not None and name not in dashboard_index:
            dashboard_index[name] = fm.group(2).strip()
            if name in mm_schema.FIELDS:
                continue
        loose.append(line)
    section_0a_loose_md = "".join(loose) if "".join(loose).strip() else ""

    section_0b_md = _strip_trailing_separator(text[m["0b"].end():end_of("1")]) if m["0b"] else ""
    section_1_preamble_md, section_1_table_md, section_1_postamble_md = (
        _split_section1(_strip_trailing_separator(text[m["1"].end():end_of("2")])) if m["1"] else ("", "", "")
    )
    section_1_header_md, section_1_sep_md = _extract_table_shape(section_1_table_md)
    rows = _parse_rows(section_1_table_md)
    decisions = _parse_decisions(text[m["2"].end():end_of("3")]) if m["2"] else []
    section_3_md = _strip_trailing_separator(text[m["3"].end():end_of("4")]) if m["3"] else ""
    section_4_md = text[m["4"].end():].lstrip("\n").rstrip() if m["4"] else ""
    return {"title_line": title_line, "has_section_0a": True, "dashboard_index": dashboard_index,
            "section_0a_loose_md": section_0a_loose_md, "section_0b_md": section_0b_md,
            "section_1_preamble_md": section_1_preamble_md, "rows": rows,
            "section_1_postamble_md": section_1_postamble_md, "section_1_header_md": section_1_header_md,
            "section_1_sep_md": section_1_sep_md, "decisions": decisions,
            "section_3_md": section_3_md, "section_4_md": section_4_md, "trailing_md": ""}


def escape_cell(value: str) -> str:
    """Escape the unescaped pipes of a non-final table cell. Parsed cells
    never hold one (such a row is kept verbatim), so parsed rows re-render
    unchanged."""
    return _ROW_SPLIT_RE.sub(r"\\|", value)


def _render_row(row: dict) -> str:
    if row.get("row_verbatim"):
        return row["raw_line"]
    first_cells = [escape_cell(row.get("id", "")), escape_cell(row.get("item", "")),
                   escape_cell(status_cell(row)), escape_cell(row.get("owner", "")),
                   escape_cell(row.get("target_date", ""))]
    line = "| " + " | ".join(first_cells) + " | " + row.get("notes_md", "")
    if row.get("notes_trailing_pipe", True):
        line += " |"
    return line


def _render_decision(d: dict) -> str:
    header_sep = d.get("header_sep", ": ")
    lines = [f"### {d.get('qid', '')}{header_sep}{d.get('question', '')}"]
    body_lines = d.get("body_lines")
    if body_lines is not None:
        lines.extend(body_lines)
    else:
        # No parsed body (a decision built by hand rather than via parse_handoff)
        # -- fall back to the canonical-field template.
        lines += [f"- **{DECISION_FIELD_LABELS[k]}:** {d.get(k, '')}" for k in DECISION_FIELD_ORDER]
    return "\n".join(lines)


def _join_chunks(*chunks: str) -> str:
    """Join non-empty chunks with a single blank line between each."""
    return "\n\n".join(c for c in chunks if c)


def loop_line(loop: dict) -> str:
    routes = ", ".join(loop.get("routes") or []) or "none"
    last = loop.get("last_tick") or {}
    tick = f"{last.get('at', '')} {last.get('result', '')}".strip() if last else "never"
    return (f"Loop: {loop.get('mode', 'off')} | routes {routes} | no-ops "
            f"{loop.get('noop_count', 0)}/{loop.get('noop_cap', 5)} | last tick {tick}")


def _render_loop(doc: dict) -> str:
    loop = doc.get("loop")
    return _join_chunks("### Loop", loop_line(loop)) if isinstance(loop, dict) else ""


def _archive(doc: dict) -> dict:
    archive = doc.get("archive")
    return archive if isinstance(archive, dict) else {}


CARRIED_0A_HEADING = "## Carried from Section 0A at migration"


def carry_section_0a(doc: dict, loose_md: str) -> None:
    """Keep Section 0A's loose text (parse_handoff's section_0a_loose_md) in the ledger's archive. It is
    rendered verbatim at the end of HANDOFF-archive.md under CARRIED_0A_HEADING, out of Section 0."""
    if loose_md:
        doc.setdefault("archive", {"file": "HANDOFF-archive.md", "rows": [], "decisions": []})
        doc["archive"]["carried_0a_md"] = loose_md


def _archive_pointer(doc: dict) -> str:
    archive = _archive(doc)
    rows, decisions = archive.get("rows") or [], archive.get("decisions") or []
    name = archive.get("file", "HANDOFF-archive.md")
    lines = [f"Archived: {len(rows)} rows and {len(decisions)} decisions are in {name}."] if rows or decisions else []
    if archive.get("carried_0a_md"):
        lines.append(f"Section 0A text carried at migration is in {name}.")
    return "\n\n".join(lines)


def _decisions_md(decisions: list) -> str:
    decisions_md = ""
    for i, d in enumerate(decisions):
        block = _render_decision(d)
        if i == 0:
            decisions_md = block
        else:
            sep = "\n\n---\n\n" if decisions[i - 1].get("sep_after") else "\n\n"
            decisions_md += sep + block
    return decisions_md


def section0_text(doc: dict) -> str:
    passthrough = doc.get("passthrough", {})
    dashboard_index = doc.get("dashboard_index", {})
    field_lines = "\n".join(f"- {f}: {dashboard_index.get(f, 'unknown')}" for f in mm_ledger.DASHBOARD_FIELDS)
    block_0a = _join_chunks("## Section 0A Dashboard Index", field_lines)
    block_0b = _join_chunks("## Section 0B Session Opener", passthrough.get("section_0b_md", ""),
                            _render_loop(doc))
    return _join_chunks(block_0a, block_0b)


def compile_handoff(doc: dict) -> str:
    passthrough = doc.get("passthrough", {})
    block_0 = section0_text(doc)
    row_lines = "\n".join(_render_row(r) for r in doc.get("rows", []))
    # Re-emit the table shape found in the SOURCE (header + separator), not a
    # hardcoded constant -- a real HANDOFF can use a different column count
    # (e.g. no Notes column). Fall back to the standard 6-column shape only
    # when no source shape was captured (a doc built by hand, not parsed).
    header = passthrough.get("section_1_header_md") or SECTION_1_HEADER
    sep = passthrough.get("section_1_sep_md") or SECTION_1_SEP
    table = header + "\n" + sep + ("\n" + row_lines if row_lines else "")
    block_1 = _join_chunks("## Section 1 Status", passthrough.get("section_1_preamble_md", ""), table,
                            passthrough.get("section_1_postamble_md", ""))
    # A "---" seen between a decision and the previous one on parse
    # (decisions[i - 1]["sep_after"]) is re-emitted as a blank-line-wrapped
    # divider; the last decision's own sep_after is unused because the
    # section-boundary "---" before Section 3 is always emitted.
    block_2 = _join_chunks("## Section 2 Decisions log", _decisions_md(doc.get("decisions", [])))
    block_3 = _join_chunks("## Section 3 Open questions", passthrough.get("section_3_md", ""))
    block_4 = _join_chunks("## Section 4 Archive", passthrough.get("section_4_md", ""), _archive_pointer(doc),
                           passthrough.get("trailing_md", ""))
    text = _join_chunks(passthrough.get("title_line", ""), block_0, "---", block_1, "---",
                        block_2, "---", block_3, "---", block_4)
    return text if text.endswith("\n") else text + "\n"


def compile_archive(doc: dict):
    archive = _archive(doc)
    rows, decisions = archive.get("rows") or [], archive.get("decisions") or []
    carried = archive.get("carried_0a_md") or ""
    if not rows and not decisions and not carried:
        return None
    chunks = [f"# HANDOFF archive — {doc.get('task', '')}"]
    if rows or decisions:
        table = "\n".join([SECTION_1_HEADER, SECTION_1_SEP] + [_render_row(r) for r in rows])
        chunks += ["Rows and decisions moved out of HANDOFF.md by mm.py archive.",
                   "## Archived rows", table, "## Archived decisions", _decisions_md(decisions)]
    if carried:
        chunks += [CARRIED_0A_HEADING, carried]
    return _join_chunks(*chunks) + "\n"


def carried_section_0a(archive_text) -> str:
    """The Section 0A text a migration carried into HANDOFF-archive.md: everything after its heading."""
    m = re.search(rf"^{re.escape(CARRIED_0A_HEADING)}[ \t]*$", archive_text or "", re.MULTILINE)
    return archive_text[m.end():] if m else ""


def render_files(doc: dict) -> dict:
    """Every generated file of a ledger task, keyed by file name, each
    starting with the generated header. HANDOFF-archive.md is present only
    when the ledger holds archived rows or decisions."""
    files = {
        "HANDOFF.md": GENERATED_HEADER + "\n" + compile_handoff(doc),
        "ROADMAP.html": GENERATED_HEADER + "\n" + render_roadmap(doc),
    }
    archive = compile_archive(doc)
    if archive is not None:
        files["HANDOFF-archive.md"] = GENERATED_HEADER + "\n" + archive
    return files


def sha256_text(text: str) -> str:
    """The hash of the exact bytes mm writes for `text` (no line-ending
    normalisation: a generated file is compared byte for byte)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def as_written(path: pathlib.Path, data: bytes) -> tuple:
    """(bytes, converted): a generated file's bytes as mm wrote them. They
    are the raw bytes, so any hand edit, a line-ending rewrite included, is
    a difference. The one exception is the exact form git itself writes on
    checkout of content it holds (core.autocrlf, eol=crlf): those bytes read
    back as the content git stores (converted is True). A rewrite that is
    byte-identical to that checkout cannot be told apart from it."""
    if b"\r" not in data:
        return data, False
    stored = mm_git.checkout_form(path, data)
    return (data, False) if stored is None or stored == data else (stored, True)


def record_compile(doc: dict, files: dict, revision: int) -> None:
    record = doc.setdefault("compile_record", {})
    for name, text in files.items():
        entry = {"sha256": sha256_text(text), "revision": revision}
        previous = [e for e in record.get(name, []) if e.get("sha256") != entry["sha256"]]
        record[name] = [entry] + previous[:1]


def diagnose(task_dir, doc: dict) -> list:
    """(file, kind, detail) per generated file. Kinds: OK, MISSING,
    LEDGER-AHEAD (the file is an earlier compile), HANDOFF-EDITED (a hand
    edit), HEADER-MISSING and NOT-GENERATED (a folder from before generated
    headers), UNKNOWN (no record explains the difference)."""
    task_dir = pathlib.Path(task_dir)
    files = render_files(doc)
    record = doc.get("compile_record") if isinstance(doc.get("compile_record"), dict) else {}
    out = []
    for name in mm_schema.GENERATED_FILES:
        path = task_dir / name
        expected = files.get(name)
        if expected is None:
            if path.is_file():
                out.append((name, "UNKNOWN", "exists but the ledger archives nothing"))
            continue
        if not path.is_file():
            out.append((name, "MISSING", "not written yet"))
            continue
        raw, wanted = path.read_bytes(), expected.encode("utf-8")
        data, converted = (raw, False) if raw == wanted else as_written(path, raw)
        if data == wanted or (converted and data == wanted.replace(b"\r\n", b"\n")):
            out.append((name, "OK", ""))
            continue
        actual = data.decode("utf-8", errors="replace")
        entries = record.get(name) or []
        sha = hashlib.sha256(data).hexdigest()
        if entries:
            if sha in {e.get("sha256") for e in entries}:
                kind = "LEDGER-AHEAD"
            elif entries[0].get("revision") == doc.get("revision"):
                kind = "HANDOFF-EDITED"
            else:
                kind = "UNKNOWN"
        elif actual == expected.split("\n", 1)[1]:
            kind = "HEADER-MISSING"
        elif name == "ROADMAP.html" and not actual.startswith(GENERATED_HEADER):
            kind = "NOT-GENERATED"
        else:
            kind = "UNKNOWN"
        out.append((name, kind, ""))
    return out


def row_cells(row: dict) -> list:
    return [row.get("id", ""), row.get("item", ""), status_cell(row), row.get("owner", ""),
            row.get("target_date", ""), row.get("notes_md", "")]


def findings(doc: dict) -> list:
    """(level, code, message): level "fix" makes check exit 3, "warn" only
    reports."""
    out = []
    index = doc.get("dashboard_index", {})
    for name in mm_schema.FIELDS:
        value = index.get(name)
        if value is None:
            out.append(("fix", "FIELD-MISSING", f"Section 0A field {name!r} is missing"))
            continue
        if len(value) > mm_schema.FIELD_FAIL_CHARS:
            out.append(("fix", "FIELD-OVER-CAP", f"Section 0A {name!r} is {len(value)} chars (cap 400)"))
        elif len(value) > mm_schema.FIELD_WARN_CHARS:
            out.append(("warn", "FIELD-LONG", f"Section 0A {name!r} is {len(value)} chars (warn at 250)"))
        allowed = mm_schema.ALLOWED.get(name)
        if allowed and value.strip().lower() not in allowed:
            out.append(("fix", "FIELD-OFF-ENUM", f"Section 0A {name!r} value {value!r} is not one of "
                                                 f"{sorted(allowed)}"))
    size = len(section0_text(doc).encode("utf-8"))
    if size > mm_schema.SECTION0_FAIL_BYTES:
        out.append(("fix", "SECTION0-OVER-CAP", f"Section 0 is {size} bytes (cap 16384)"))
    elif size > mm_schema.SECTION0_WARN_BYTES:
        out.append(("warn", "SECTION0-LARGE", f"Section 0 is {size} bytes (warn at 10240)"))
    rows = [r for r in doc.get("rows", []) if isinstance(r, dict)]
    for row in rows:
        if row.get("row_verbatim"):
            continue
        longest = max(len(c) for c in row_cells(row))
        if longest > mm_schema.CELL_FAIL_CHARS:
            out.append(("fix", "CELL-OVER-CAP", f"row {row.get('id')} has a {longest}-char cell (cap 600)"))
    wrapups = [i for i, r in enumerate(rows) if r.get("is_wrapup")]
    if not wrapups:
        out.append(("fix", "WRAPUP-MISSING", "no wrap-up row"))
    elif len(wrapups) > 1:
        out.append(("fix", "WRAPUP-DUPLICATE", f"{len(wrapups)} wrap-up rows"))
    elif wrapups[0] != len(rows) - 1:
        out.append(("fix", "WRAPUP-NOT-LAST", f"the wrap-up row is not last ({len(rows) - 1 - wrapups[0]} rows follow it)"))
    handoff = compile_handoff(doc)
    size = len(handoff.encode("utf-8"))
    if size > mm_schema.HANDOFF_WARN_BYTES:
        out.append(("warn", "HANDOFF-LARGE", f"HANDOFF.md is {size} bytes; run mm.py archive"))
    for number, symptom in archaeology(handoff):
        out.append(("warn", "ARCHAEOLOGY", f"HANDOFF.md line {number} holds the archaeology symptom {symptom!r}; "
                                           "state the current fact through mm.py and drop the history"))
    return out


_ARCHAEOLOGY_ANCHOR = r"^\s*(?:[-*>]\s*)?(?:\*\*)?"


def archaeology(text: str) -> list:
    """(line number, symptom) for each line before Section 4 Archive that holds
    one of mm_schema.ARCHAEOLOGY_SYMPTOMS, case-insensitive; a line-start
    symptom counts only at the start of a line (after a list marker or bold),
    as hooks/check-handoff.py reads them."""
    out = []
    for number, line in enumerate(text.splitlines(), 1):
        lowered = line.lower()
        if lowered.startswith("## section 4 archive"):
            break
        for symptom in mm_schema.ARCHAEOLOGY_SYMPTOMS:
            if symptom in mm_schema.ARCHAEOLOGY_LINE_START:
                hit = re.match(_ARCHAEOLOGY_ANCHOR + re.escape(symptom), line, re.IGNORECASE)
            else:
                hit = symptom in lowered
            if hit:
                out.append((number, symptom))
                break
    return out


def round_trip_identical(a: str, b: str) -> bool:
    """Byte-exact per SHARED INVARIANT 1: the ONLY normalisation is CRLF/CR -> LF.

    No trailing-whitespace stripping, no blank-run collapsing, no reordering --
    those would silently pass a recompile that destroyed a Markdown hard line
    break (two trailing spaces) or mangled blank-line structure inside a fenced
    code block.
    """
    def normalize(s: str) -> str:
        return s.replace("\r\n", "\n").replace("\r", "\n")
    return normalize(a) == normalize(b)


# mm_migrate.py (not owned by this change) still calls this function by its old
# name. Keep it as a plain alias so that caller keeps working unchanged -- it is
# no longer fuzzy: this name now IS round_trip_identical, byte-exact after
# CRLF->LF normalisation only.
semantic_equal = round_trip_identical


@dataclass
class CompletenessReport:
    """What content_complete found. A bool alone can't tell a caller WHAT is
    missing -- this carries every piece needed to print a report that names
    the loss, not just its existence."""
    passed: bool
    missing_lines: list = field(default_factory=list)          # ordered, first appearance in `original`
    missing_lines_total: int = 0
    missing_lines_by_section: dict = field(default_factory=dict)  # section key -> ordered missing lines
    missing_row_ids: set = field(default_factory=set)
    missing_decision_ids: set = field(default_factory=set)
    missing_0a_fields: set = field(default_factory=set)

    def __bool__(self) -> bool:
        return self.passed


def content_complete(original: str, recompiled: str, archive=None) -> CompletenessReport:
    """The acceptance bar for a recompile is CONTENT-COMPLETE, not byte-exact.

    Once a task is migrated, HANDOFF.md is GENERATED: every subsequent update
    regenerates it in the compiler's own format. Requiring the FIRST
    regeneration to match the original hand-written formatting protects a
    property (exact layout) with a lifespan of exactly one write. What must
    survive is CONTENT -- every line the operator wrote, every Section 1 row,
    every Section 2 decision, every Section 0A field -- not whitespace, not
    separator style, not blank-line count.

    Per-line comparison uses a MULTISET (collections.Counter) of
    `line.strip()` over non-blank lines, so a line present 3x in the original
    and only 2x in the recompile is a real loss even though "the line exists
    somewhere". Extra lines in the recompile (e.g. an added separator) are NOT
    a failure -- only LOSS counts.

    The multiset is built PER SECTION (preamble, 0A, 0B, 1, 2, 3, 4 -- see
    _section_spans), not once across the whole file. A whole-file multiset
    would pass a line that moved from Section 1 into Section 4: content
    preserved, meaning scrambled. Comparing section-by-section means a line
    present in the original's Section 1 must appear in the recompiled
    Section 1, not merely somewhere in the file; missing_lines_by_section
    names which section each loss came from.

    On top of the line multiset, three structural identifier sets are
    compared original-vs-recompiled: Section 1 row IDs, Section 2 decision
    IDs (the Q<n>/D<n> token), and Section 0A field names -- catching a
    whole-entry drop (e.g. a decision header regex that silently swallows an
    entire block) that a partial-line diff could still miss if a stray
    fragment of the block happened to survive.

    `archive` is the HANDOFF-archive.md text written with the recompile, when there is one. The block a
    migration carried there from Section 0A (carried_section_0a) counts as Section 0A output, for its lines
    and its field names; nothing else in the archive counts, and it counts for no other section.
    """
    def norm_counter(text: str) -> Counter:
        return Counter(line.strip() for line in text.splitlines() if line.strip())

    orig_spans = _section_spans(original)
    recomp_spans = _section_spans(recompiled)
    carried = carried_section_0a(archive)
    recomp_spans["0a"] += "\n" + carried

    # Walk each section in `original`'s own line order so "first N" means the
    # first N as the operator would encounter them, not an arbitrary Counter
    # order; sections are walked in file order (preamble, 0A, 0B, 1, 2, 3, 4)
    # so the flat `missing_lines` list stays in overall file order too.
    missing_lines = []
    missing_lines_by_section = {}
    for section_key in ("preamble",) + _SECTION_ORDER:
        orig_section_text = orig_spans.get(section_key, "")
        missing_counter = norm_counter(orig_section_text) - norm_counter(recomp_spans.get(section_key, ""))
        if not missing_counter:
            continue
        remaining = dict(missing_counter)
        section_missing = []
        for raw_line in orig_section_text.splitlines():
            stripped = raw_line.strip()
            if stripped and remaining.get(stripped, 0) > 0:
                section_missing.append(stripped)
                remaining[stripped] -= 1
        missing_lines_by_section[section_key] = section_missing
        missing_lines.extend(section_missing)

    orig_slices = parse_handoff(original)
    recomp_slices = parse_handoff(recompiled)

    orig_row_ids = {r.get("id", "") for r in orig_slices.get("rows", []) if r.get("id")}
    recomp_row_ids = {r.get("id", "") for r in recomp_slices.get("rows", []) if r.get("id")}
    missing_row_ids = orig_row_ids - recomp_row_ids

    orig_decision_ids = {d.get("qid", "") for d in orig_slices.get("decisions", []) if d.get("qid")}
    recomp_decision_ids = {d.get("qid", "") for d in recomp_slices.get("decisions", []) if d.get("qid")}
    missing_decision_ids = orig_decision_ids - recomp_decision_ids

    orig_0a_fields = set(orig_slices.get("dashboard_index", {}).keys())
    recomp_0a_fields = set(recomp_slices.get("dashboard_index", {}).keys()) | {
        fm.group(1).strip() for fm in map(FIELD_LINE_RE.match, carried.splitlines()) if fm}
    missing_0a_fields = orig_0a_fields - recomp_0a_fields

    passed = not (missing_lines or missing_row_ids or missing_decision_ids or missing_0a_fields)
    return CompletenessReport(
        passed=passed, missing_lines=missing_lines, missing_lines_total=len(missing_lines),
        missing_lines_by_section=missing_lines_by_section,
        missing_row_ids=missing_row_ids, missing_decision_ids=missing_decision_ids,
        missing_0a_fields=missing_0a_fields,
    )


def write_handoff(task_dir, doc: dict) -> None:
    path = pathlib.Path(task_dir) / "HANDOFF.md"
    mm_atomic.atomic_write_text(path, compile_handoff(doc), encoding="utf-8", newline="\n")


def complete_against(original: str, doc: dict) -> CompletenessReport:
    """content_complete of `original` against everything compiling `doc` writes: HANDOFF.md and, when
    the doc carries Section 0A text, HANDOFF-archive.md."""
    return content_complete(original, compile_handoff(doc), compile_archive(doc))


def _doc_from_slices(slices: dict) -> dict:
    doc = {
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
    carry_section_0a(doc, slices.get("section_0a_loose_md", ""))
    return doc


def _print_completeness_report(report: CompletenessReport) -> None:
    if report.missing_lines_by_section:
        # Attribute each missing line to the section it was lost from --
        # that is the whole point of the per-section check: a line that
        # merely relocated to a different section still gets named here,
        # tied to the section it was supposed to stay in.
        shown_total = 0
        print(f"missing lines (showing first 40 of {report.missing_lines_total} total, by section):")
        for section_key in ("preamble",) + _SECTION_ORDER:
            lines = report.missing_lines_by_section.get(section_key)
            if not lines:
                continue
            for line in lines:
                if shown_total >= 40:
                    break
                print(f"  [section {section_key}] {line}")
                shown_total += 1
            if shown_total >= 40:
                break
    elif report.missing_lines:
        shown = report.missing_lines[:40]
        print(f"missing lines (showing first {len(shown)} of {report.missing_lines_total} total):")
        for line in shown:
            print(f"  {line}")
    if report.missing_row_ids:
        print("missing Section 1 row IDs: " + ", ".join(sorted(report.missing_row_ids)))
    if report.missing_decision_ids:
        print("missing Section 2 decision IDs: " + ", ".join(sorted(report.missing_decision_ids)))
    if report.missing_0a_fields:
        print("missing Section 0A field names: " + ", ".join(sorted(report.missing_0a_fields)))


def _cli_check(task_dir: pathlib.Path) -> int:
    handoff_path = pathlib.Path(task_dir) / "HANDOFF.md"
    if not handoff_path.is_file():
        print(f"FAIL {handoff_path}: no HANDOFF.md found")
        return 1
    original = handoff_path.read_text(encoding="utf-8")
    slices = parse_handoff(original)
    if not slices.get("has_section_0a"):
        print(f"FAIL {handoff_path}: no Section 0A Dashboard Index found")
        return 1
    report = complete_against(original, _doc_from_slices(slices))
    print(f"{'PASS' if report.passed else 'FAIL'} {handoff_path}")
    if not report.passed:
        _print_completeness_report(report)
    return 0 if report.passed else 1


def main(argv=None) -> int:
    # Windows consoles are frequently a legacy code page (e.g. cp1252) that
    # cannot encode emoji/glyphs real HANDOFFs contain -- sanitise instead of
    # crashing the diff printer.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", metavar="TASK_DIR", required=True,
                         help="recompile TASK_DIR/HANDOFF.md and report content-complete PASS/FAIL "
                              "(no lost lines, row IDs, decision IDs, or Section 0A fields)")
    args = parser.parse_args(argv)
    return _cli_check(pathlib.Path(args.check).resolve())


if __name__ == "__main__":
    sys.exit(main())
