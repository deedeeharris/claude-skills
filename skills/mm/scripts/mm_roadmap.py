"""ROADMAP.html, generated from the ledger: the status cell every table shows, and the roadmap page filled from
templates/ROADMAP.html (KPIs, current and next row, a Mermaid flow of the rows, the rows and decisions tables).
"""

import html
import pathlib
import re

import mm_ledger
import mm_schema

TEMPLATES_DIR = pathlib.Path(__file__).resolve().parent.parent / "templates"


def status_cell(row: dict) -> str:
    if row.get("status_glyph_present", True):
        glyph = mm_ledger.state_to_glyph(row.get("state", "BACKLOG"), row.get("blocked", False))
        label = row.get("status_label", "")
        return f"{glyph} {label}" if label else glyph
    return row.get("status_label", "")


def _html(value) -> str:
    return html.escape(str(value), quote=True)


def _mermaid_label(value: str) -> str:
    return re.sub(r"[\[\](){}<>|\"#;`]", " ", value)[:60].strip() or "row"


_FLOW_CLASS = {"DONE": "done", "HUMAN_VERIFIED": "done", "ABANDONED": "blocked", "BACKLOG": "research",
               "NEEDS_DECISION": "awaiting"}


_TEMPLATE_CACHE = {}


def _template(name: str) -> str:
    if name not in _TEMPLATE_CACHE:
        _TEMPLATE_CACHE[name] = (TEMPLATES_DIR / name).read_text(encoding="utf-8")
    return _TEMPLATE_CACHE[name]


def render_roadmap(doc: dict) -> str:
    template = _template("ROADMAP.html")
    rows = [r for r in doc.get("rows", []) if isinstance(r, dict)]
    done = [r for r in rows if r.get("state") in ("DONE", "HUMAN_VERIFIED")]
    waiting = [r for r in rows if r.get("state") == "NEEDS_DECISION"
               or (r.get("user_facing") and r.get("state") not in ("HUMAN_VERIFIED",) + mm_schema.TERMINAL)]
    open_rows = [r for r in rows if r.get("state") not in mm_schema.TERMINAL]
    active = [r for r in open_rows if r.get("state") not in ("BACKLOG", "NEEDS_DECISION")]
    decisions = [d for d in doc.get("decisions", []) if isinstance(d, dict)]
    index = doc.get("dashboard_index", {})

    def describe(row):
        return f"{row.get('id', '')} {row.get('item', '')}" if row else "none"

    flow = ["  Start([Kickoff]):::done"]
    previous = "Start"
    for n, row in enumerate(rows, 1):
        node = f"R{n}"
        css = _FLOW_CLASS.get(row.get("state"), "hot")
        flow.append(f"  {node}[\"{_mermaid_label(describe(row))}\"]:::{css}")
        flow.append(f"  {previous} --> {node}")
        previous = node
    row_html = "\n".join(
        f"          <tr><td><strong>{_html(r.get('id', ''))}</strong></td><td>{_html(r.get('item', ''))}</td>"
        f"<td>{_html(status_cell(r))}</td><td>{_html(r.get('test_level', 'none'))}</td></tr>" for r in rows)
    decision_html = "\n".join(
        f"          <tr><td><strong>{_html(d.get('qid', ''))}</strong></td>"
        f"<td><div class=\"question-text\">{_html(d.get('decision') or d.get('question', ''))}</div></td>"
        f"<td>{_html(d.get('date', ''))}</td><td>{_html(d.get('status', ''))}</td></tr>" for d in decisions)
    values = {
        "TASK_NAME": doc.get("task", ""), "LAST_UPDATED": index.get("Last updated", "unknown"),
        "PROJECT": doc.get("project", ""), "HEADLINE_STATUS": index.get("Status", "unknown"),
        "KPI_SHIPPED": str(len(done)), "KPI_SHIPPED_DETAIL": f"of {len(rows)} rows",
        "KPI_ACTIVE": str(len(active)), "KPI_ACTIVE_DETAIL": f"{len(open_rows)} rows open",
        "KPI_AWAITING": str(len(waiting)), "KPI_AWAITING_DETAIL": "decisions or human checks",
        "KPI_QUESTIONS": str(len(decisions)), "KPI_QUESTIONS_DETAIL": "in the decisions log",
        "CURRENT_TASK": describe(open_rows[0] if open_rows else None),
        "CURRENT_TASK_WHY": index.get("Next agent action", ""),
        "NEXT_TASK": describe(open_rows[1] if len(open_rows) > 1 else None),
        "NEXT_TASK_WHY": index.get("Next human decision", ""),
    }
    out = template
    for key, value in values.items():
        out = out.replace("{{" + key + "}}", _html(value))
    out = out.replace("{{FLOW}}", "\n".join(flow)).replace("{{ROWS}}", row_html)
    out = out.replace("{{DECISIONS}}", decision_html)
    return out
