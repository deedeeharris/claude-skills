"""The section registry: every part of HANDOFF.md the compiler renders, its heading, its kind and the mm.py
command that writes it (mm.py sections prints it; a test checks every text section is writable).
"""

TEXT_SECTIONS = {
    "0b": "section_0b_md", "1-preamble": "section_1_preamble_md", "1-postamble": "section_1_postamble_md",
    "3": "section_3_md", "4": "section_4_md", "trailing": "trailing_md",
}
SECTION_HEADINGS = {
    "0a": "## Section 0A Dashboard Index", "0b": "## Section 0B Session Opener", "1": "## Section 1 Status",
    "2": "## Section 2 Decisions log", "3": "## Section 3 Open questions", "4": "## Section 4 Archive",
}


def section_registry(doc: dict) -> list:
    """Every part compile_handoff renders, with the command that writes it."""
    h = SECTION_HEADINGS
    registry = [
        {"id": "title", "heading": doc.get("passthrough", {}).get("title_line", ""), "kind": "derived",
         "command": "set-field --field Task"},
        {"id": "0a", "heading": h["0a"], "kind": "fields", "command": "set-field"},
        {"id": "0b", "heading": h["0b"], "kind": "text",
         "command": "set-section --id 0b; set-field --section 0b"},
        {"id": "1-preamble", "heading": h["1"], "kind": "text", "command": "set-section --id 1-preamble"},
        {"id": "1", "heading": h["1"], "kind": "rows",
         "command": "add-row, edit-row, move-row, split-row, retire-row, set-row, mark-row"},
        {"id": "1-postamble", "heading": h["1"], "kind": "text", "command": "set-section --id 1-postamble"},
        {"id": "2", "heading": h["2"], "kind": "decisions", "command": "add-decision, supersede-decision"},
        {"id": "3", "heading": h["3"], "kind": "text", "command": "set-section --id 3"},
        {"id": "4", "heading": h["4"], "kind": "text", "command": "set-section --id 4; archive"},
        {"id": "trailing", "heading": h["4"], "kind": "text", "command": "set-section --id trailing"},
    ]
    if isinstance(doc.get("loop"), dict):
        registry.insert(3, {"id": "loop", "heading": "### Loop", "kind": "derived", "command": "loop on/off/tick"})
    passthrough = doc.get("passthrough", {})
    for sid, key in TEXT_SECTIONS.items():
        for line in (passthrough.get(key) or "").splitlines():
            if line.startswith("## "):
                registry.append({"id": sid, "heading": line, "kind": "heading-in-text",
                                 "command": f"set-section --id {sid}"})
    return registry
