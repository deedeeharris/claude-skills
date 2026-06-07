#!/usr/bin/env python3
"""Build repo-level MM PM dashboards from active HANDOFF.md Section 0A blocks."""

from __future__ import annotations

import argparse
import html
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


FIELDS = [
    "Project",
    "Task",
    "Status",
    "Last updated",
    "Target finish date",
    "Target week",
    "Deadline type",
    "Schedule confidence",
    "At risk",
    "Owner",
    "Waiting on",
    "Priority",
    "Category",
    "Strategic value",
    "Money value",
    "Energy cost",
    "Review cadence",
    "Next human decision",
    "Next agent action",
    "Blockers summary",
    "Executive note",
]

KEYS = {
    "Project": "project",
    "Task": "task",
    "Status": "status",
    "Last updated": "last_updated",
    "Target finish date": "target_finish_date",
    "Target week": "target_week",
    "Deadline type": "deadline_type",
    "Schedule confidence": "schedule_confidence",
    "At risk": "at_risk",
    "Owner": "owner",
    "Waiting on": "waiting_on",
    "Priority": "priority",
    "Category": "category",
    "Strategic value": "strategic_value",
    "Money value": "money_value",
    "Energy cost": "energy_cost",
    "Review cadence": "review_cadence",
    "Next human decision": "next_human_decision",
    "Next agent action": "next_agent_action",
    "Blockers summary": "blockers_summary",
    "Executive note": "executive_note",
}

ALLOWED = {
    "Status": {"active", "blocked", "waiting", "paused", "done", "needs-triage"},
    "Deadline type": {"hard", "target", "none"},
    "Schedule confidence": {"high", "medium", "low", "unknown"},
    "At risk": {"yes", "no", "unknown"},
    "Priority": {"1", "2", "3", "4", "5", "unknown", "not set"},
    "Strategic value": {"1", "2", "3", "4", "5", "unknown", "not set"},
    "Money value": {"1", "2", "3", "4", "5", "none", "unknown"},
    "Energy cost": {"low", "medium", "high", "unknown"},
    "Review cadence": {"daily", "weekly", "monthly", "on-demand", "unknown", "not set"},
}

MISSING_VALUES = {"", "none", "unknown", "not set"}
INBOX_ENTRY_RE = re.compile(r"^\d{8}-\d{6}-.*\.md$")


@dataclass
class Task:
    values: dict[str, str]
    handoff_path: Path
    project_root: Path
    inbox_count: int
    malformed_reason: str = ""
    warnings: list[str] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        data = {KEYS[field_name]: self.values.get(field_name, "unknown") for field_name in FIELDS}
        data.update(
            {
                "inbox_count": self.inbox_count,
                "handoff_path": rel(self.handoff_path, self.project_root),
                "roadmap_path": rel(self.handoff_path.with_name("ROADMAP.html"), self.project_root),
                "malformed_reason": self.malformed_reason,
                "warnings": self.warnings,
            }
        )
        return data

    @property
    def task_name(self) -> str:
        value = self.values.get("Task", "").strip()
        return value if value else self.handoff_path.parent.name

    @property
    def task_id(self) -> str:
        return rel(self.handoff_path, self.project_root)


def rel(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def rel_from_pm(path: str) -> str:
    prefix = ".private/pm/"
    return path[len(prefix) :] if path.startswith(prefix) else path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build .private/pm repo dashboards from MM handoffs.")
    parser.add_argument("--root", default=".", help="Project root. Defaults to current directory.")
    return parser.parse_args()


def heading_level(line: str) -> int | None:
    match = re.match(r"^(#{1,6})\s+", line)
    return len(match.group(1)) if match else None


def extract_section_0a(text: str) -> tuple[list[str], str]:
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^##\s+Section\s+0A\s+Dashboard\s+Index\s*$", line.strip(), re.I):
            start = i + 1
            break
    if start is None:
        return [], "Missing Section 0A Dashboard Index"

    body: list[str] = []
    for line in lines[start:]:
        level = heading_level(line)
        if level is not None and level <= 2:
            break
        body.append(line)
    return body, ""


def parse_section_0a(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    body, reason = extract_section_0a(text)
    values = {field_name: "unknown" for field_name in FIELDS}
    if reason:
        return values, reason

    parsed: list[tuple[str, str]] = []
    field_by_lower = {field_name.lower(): field_name for field_name in FIELDS}
    for line in body:
        match = re.match(r"^\s*-\s+([^:]+):\s*(.*)\s*$", line)
        if match:
            raw_label = match.group(1).strip()
            canonical_label = field_by_lower.get(raw_label.lower(), raw_label)
            parsed.append((canonical_label, match.group(2).strip()))

    reasons: list[str] = []
    parsed_labels = [label for label, _ in parsed]
    if parsed_labels[: len(FIELDS)] != FIELDS:
        reasons.append("Section 0A fields missing or out of order")

    for label, value in parsed:
        if label in values:
            values[label] = value if value else "not set"

    for field_name in FIELDS:
        if field_name not in parsed_labels:
            reasons.append(f"Missing field: {field_name}")

    for field_name, allowed in ALLOWED.items():
        value = values.get(field_name, "").strip().lower()
        if value not in allowed:
            reasons.append(f"Invalid {field_name}: {values.get(field_name, '')}")

    return values, "; ".join(reasons)


def parse_date(value: str) -> date | None:
    if not value or value.strip().lower() in MISSING_VALUES:
        return None

    iso = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", value)
    if iso:
        try:
            return datetime.strptime(iso.group(1), "%Y-%m-%d").date()
        except ValueError:
            return None

    for pattern in ("%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(value.strip(), pattern).date()
        except ValueError:
            continue
    return None


def parse_datetime(value: str) -> datetime | None:
    if not value or value.strip().lower() in MISSING_VALUES:
        return None

    iso_dt = re.search(r"\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?", value)
    if iso_dt:
        date_part = iso_dt.group(1)
        time_part = iso_dt.group(2) or "00:00"
        for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(f"{date_part} {time_part}", pattern)
            except ValueError:
                continue
    return None


def count_inbox(task_dir: Path) -> int:
    inbox = task_dir / "inbox"
    if not inbox.is_dir():
        return 0
    count = 0
    for path in inbox.rglob("*"):
        if not path.is_file():
            continue
        if "processed" in path.relative_to(inbox).parts:
            continue
        if INBOX_ENTRY_RE.match(path.name):
            count += 1
    return count


def is_stale(task: Task, today: date) -> bool:
    status = task.values.get("Status", "").strip().lower()
    if status in {"done", "paused"}:
        return False

    cadence = task.values.get("Review cadence", "").strip().lower()
    if cadence == "on-demand":
        return False
    if cadence in MISSING_VALUES:
        return False

    last_updated = parse_datetime(task.values.get("Last updated", ""))
    if last_updated is None:
        return True

    thresholds = {
        "daily": 1,
        "weekly": 7,
        "monthly": 31,
    }
    days = thresholds.get(cadence)
    return days is None or last_updated.date() < today - timedelta(days=days)


def in_current_week(target: date | None, today: date) -> bool:
    if target is None:
        return False
    days_since_sunday = (today.weekday() + 1) % 7
    start = today - timedelta(days=days_since_sunday)
    end = start + timedelta(days=6)
    return start <= target <= end


def load_tasks(root: Path) -> list[Task]:
    active = root / ".private" / "pm" / "active"
    if not active.is_dir():
        return []

    tasks = []
    for handoff in sorted(active.glob("*/HANDOFF.md")):
        values, malformed_reason = parse_section_0a(handoff)
        warnings: list[str] = []
        if values.get("Task", "").strip().lower() in MISSING_VALUES:
            values["Task"] = handoff.parent.name
            warnings.append("Task field is missing or blank; using handoff folder name")
        tasks.append(
            Task(
                values=values,
                handoff_path=handoff,
                project_root=root,
                inbox_count=count_inbox(handoff.parent),
                malformed_reason=malformed_reason,
                warnings=warnings,
            )
        )
    return tasks


def compute(root: Path, tasks: list[Task]) -> dict[str, Any]:
    today = date.today()
    overdue: list[Task] = []
    stale: list[Task] = []
    missing_target: list[Task] = []
    blocked: list[Task] = []
    waiting: list[Task] = []
    this_week: list[Task] = []

    for task in tasks:
        target = parse_date(task.values.get("Target finish date", ""))
        status = task.values.get("Status", "").strip().lower()
        deadline_type = task.values.get("Deadline type", "").strip().lower()
        waiting_on = task.values.get("Waiting on", "").strip().lower()

        if status == "blocked":
            blocked.append(task)
        if status == "waiting" or waiting_on not in MISSING_VALUES:
            waiting.append(task)
        if target is None:
            if deadline_type != "none" and status not in {"done", "paused"}:
                missing_target.append(task)
        elif target < today and status not in {"done", "paused"}:
            overdue.append(task)
            task.warnings.append("overdue")
        if is_stale(task, today):
            stale.append(task)
            task.warnings.append("stale")
        if in_current_week(target, today):
            this_week.append(task)

    risks = {
        "blocked": [t.task_id for t in blocked],
        "waiting": [t.task_id for t in waiting],
        "overdue": [t.task_id for t in overdue],
        "stale": [t.task_id for t in stale],
        "missing_target_date": [t.task_id for t in missing_target],
        "malformed_section_0a": [t.task_id for t in tasks if t.malformed_reason],
    }

    counts = {
        "active_handoffs": len(tasks),
        "blocked": len(blocked),
        "waiting": len(waiting),
        "overdue": len(overdue),
        "stale": len(stale),
        "total_unprocessed_inbox": sum(t.inbox_count for t in tasks),
        "malformed": sum(1 for t in tasks if t.malformed_reason),
        "missing_target_date": len(missing_target),
    }

    generated_at = datetime.now().astimezone().replace(microsecond=0).isoformat()
    return {
        "generated_at": generated_at,
        "project_name": root.name,
        "project_root": str(root),
        "counts": counts,
        "tasks": [task.as_json() for task in tasks],
        "risks": risks,
        "malformed": [
            {
                "task": task.task_name,
                "handoff_path": rel(task.handoff_path, root),
                "reason": task.malformed_reason,
            }
            for task in tasks
            if task.malformed_reason
        ],
        "_warning": "Generated file. Do not edit manually. Edit the relevant HANDOFF.md Section 0A and rebuild.",
        "_this_week": [task.task_id for task in this_week],
    }


def md_escape(value: Any) -> str:
    text = str(value if value is not None else "")
    return text.replace("|", "\\|").replace("\n", " ")


def md_link(label: str, href: str) -> str:
    escaped_label = md_escape(label)
    escaped_href = href.replace(" ", "%20")
    return f"[{escaped_label}]({escaped_href})"


def task_lookup(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {task["handoff_path"]: task for task in data["tasks"]}


def render_list(task_ids: list[str], tasks: dict[str, dict[str, Any]], empty: str = "none") -> str:
    if not task_ids:
        return f"- {empty}\n"
    lines = []
    for task_id in task_ids:
        task = tasks[task_id]
        lines.append(f"- {md_escape(task['task'])} - {md_escape(task['status'])} - {md_link(task['handoff_path'], rel_from_pm(task['handoff_path']))}")
    return "\n".join(lines) + "\n"


def render_markdown(data: dict[str, Any]) -> str:
    counts = data["counts"]
    tasks_by_name = task_lookup(data)
    this_week = data["_this_week"]

    lines = [
        f"# PM Dashboard - {data['project_name']}",
        "",
        "> Generated file. Do not edit manually. Edit the relevant HANDOFF.md Section 0A and rebuild.",
        "",
        f"- Generated timestamp: {data['generated_at']}",
        f"- Active handoff count: {counts['active_handoffs']}",
        f"- Blocked count: {counts['blocked']}",
        f"- Waiting count: {counts['waiting']}",
        f"- Overdue count: {counts['overdue']}",
        f"- Stale count: {counts['stale']}",
        f"- Total unprocessed inbox count: {counts['total_unprocessed_inbox']}",
        "",
        "## This week",
        "",
    ]

    if this_week:
        lines += [
            "| Task | Target finish date | Status | Waiting on | At risk | Next human decision | Next agent action |",
            "|---|---|---|---|---|---|---|",
        ]
        for task_id in this_week:
            task = tasks_by_name[task_id]
            lines.append(
                "| "
                + " | ".join(
                    md_escape(task[key])
                    for key in [
                        "task",
                        "target_finish_date",
                        "status",
                        "waiting_on",
                        "at_risk",
                        "next_human_decision",
                        "next_agent_action",
                    ]
                )
                + " |"
            )
    else:
        lines.append("- none")

    lines += [
        "",
        "## Active handoffs",
        "",
        "| Task | Status | Priority | Target finish date | Deadline type | Schedule confidence | At risk | Waiting on | Next human decision | Next agent action | Inbox count | Last updated | Handoff path |",
        "|---|---|---:|---|---|---|---|---|---|---|---:|---|---|",
    ]

    for task in data["tasks"]:
        lines.append(
            "| "
            + " | ".join(
                md_escape(task[key])
                for key in [
                    "task",
                    "status",
                    "priority",
                    "target_finish_date",
                    "deadline_type",
                    "schedule_confidence",
                    "at_risk",
                    "waiting_on",
                    "next_human_decision",
                    "next_agent_action",
                    "inbox_count",
                    "last_updated",
                ]
            )
            + f" | {md_link(task['handoff_path'], rel_from_pm(task['handoff_path']))} |"
        )

    lines += ["", "## Risks", ""]
    labels = [
        ("Blocked", "blocked"),
        ("Waiting", "waiting"),
        ("Overdue", "overdue"),
        ("Stale", "stale"),
        ("Missing target date", "missing_target_date"),
        ("Malformed Section 0A", "malformed_section_0a"),
    ]
    for title, key in labels:
        lines += [f"### {title}", "", render_list(data["risks"][key], tasks_by_name).rstrip(), ""]

    lines += [
        "---",
        "",
        "Generated file. Do not edit manually. Edit the relevant HANDOFF.md Section 0A and rebuild.",
        "",
    ]
    return "\n".join(lines)


def badge(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def render_html(data: dict[str, Any]) -> str:
    counts = data["counts"]
    tasks_by_name = task_lookup(data)
    this_week_rows = []
    for task_id in data["_this_week"]:
        task = tasks_by_name[task_id]
        this_week_rows.append(
            "<tr>"
            f"<td>{badge(task['task'])}</td><td>{badge(task['target_finish_date'])}</td>"
            f"<td>{badge(task['status'])}</td><td>{badge(task['waiting_on'])}</td>"
            f"<td>{badge(task['at_risk'])}</td><td>{badge(task['next_human_decision'])}</td>"
            f"<td>{badge(task['next_agent_action'])}</td>"
            "</tr>"
        )
    if not this_week_rows:
        this_week_rows.append('<tr><td colspan="7">none</td></tr>')

    risk_sections = []
    for title, key in [
        ("Blocked", "blocked"),
        ("Waiting", "waiting"),
        ("Overdue", "overdue"),
        ("Stale", "stale"),
        ("Missing target date", "missing_target_date"),
        ("Malformed Section 0A", "malformed_section_0a"),
    ]:
        names = data["risks"][key]
        items = "".join(f"<li>{badge(name)}</li>" for name in names) or "<li>none</li>"
        risk_sections.append(f"<section><h3>{title}</h3><ul>{items}</ul></section>")

    table_rows = []
    overdue_ids = set(data["risks"]["overdue"])
    stale_ids = set(data["risks"]["stale"])
    malformed_ids = set(data["risks"]["malformed_section_0a"])
    for task in data["tasks"]:
        classes = []
        task_id = task["handoff_path"]
        if task_id in overdue_ids:
            classes.append("overdue")
        if task_id in stale_ids:
            classes.append("stale")
        if task_id in malformed_ids:
            classes.append("malformed")
        class_attr = f' class="{" ".join(classes)}"' if classes else ""
        roadmap = task["roadmap_path"]
        handoff = task["handoff_path"]
        roadmap_href = rel_from_pm(roadmap)
        handoff_href = rel_from_pm(handoff)
        table_rows.append(
            f"<tr{class_attr}>"
            f"<td>{badge(task['task'])}</td><td>{badge(task['status'])}</td>"
            f"<td>{badge(task['priority'])}</td><td>{badge(task['target_finish_date'])}</td>"
            f"<td>{badge(task['deadline_type'])}</td><td>{badge(task['schedule_confidence'])}</td>"
            f"<td>{badge(task['at_risk'])}</td><td>{badge(task['waiting_on'])}</td>"
            f"<td>{badge(task['next_human_decision'])}</td><td>{badge(task['next_agent_action'])}</td>"
            f"<td>{badge(task['inbox_count'])}</td><td>{badge(task['last_updated'])}</td>"
            f'<td><a href="{badge(handoff_href)}">{badge(handoff)}</a><br><a href="{badge(roadmap_href)}">{badge(roadmap)}</a></td>'
            "</tr>"
        )

    cards = "".join(
        f'<div class="card"><span>{label}</span><strong>{counts[key]}</strong></div>'
        for label, key in [
            ("Active", "active_handoffs"),
            ("Blocked", "blocked"),
            ("Waiting", "waiting"),
            ("Overdue", "overdue"),
            ("Stale", "stale"),
            ("Inbox", "total_unprocessed_inbox"),
            ("Malformed", "malformed"),
        ]
    )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PM Dashboard - {badge(data['project_name'])}</title>
  <style>
    :root {{ --bg:#f7f8fa; --text:#18212f; --muted:#5c6778; --line:#d9dee7; --card:#fff; --red:#b42318; --amber:#a15c00; --blue:#2251a4; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }}
    header, main, footer {{ max-width:1400px; margin:0 auto; padding:20px; }}
    header {{ padding-top:28px; }}
    h1 {{ margin:0 0 6px; font-size:28px; }}
    .meta {{ color:var(--muted); font-size:13px; }}
    .generated {{ margin-top:10px; padding:10px 12px; border:1px solid var(--line); background:#fff; border-radius:6px; font-weight:600; }}
    .cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:18px 0; }}
    .card {{ background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px; }}
    .card span {{ display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
    .card strong {{ display:block; font-size:30px; margin-top:4px; }}
    section {{ background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin:16px 0; }}
    h2 {{ margin:0 0 12px; font-size:18px; }}
    h3 {{ margin:0 0 8px; font-size:14px; }}
    .risk-grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }}
    .risk-grid section {{ margin:0; background:#fbfcfe; }}
    .table-wrap {{ overflow-x:auto; }}
    table {{ width:100%; border-collapse:collapse; font-size:13px; }}
    th, td {{ border-bottom:1px solid var(--line); padding:9px 10px; text-align:left; vertical-align:top; }}
    th {{ background:#eef2f7; white-space:nowrap; }}
    tr.overdue td {{ background:#fff1f0; }}
    tr.stale td {{ box-shadow: inset 4px 0 0 var(--amber); }}
    tr.malformed td {{ color:var(--red); font-weight:600; }}
    a {{ color:var(--blue); text-decoration:none; }}
    a:hover {{ text-decoration:underline; }}
    footer {{ color:var(--muted); font-size:13px; padding-bottom:32px; }}
    @media (max-width: 700px) {{
      header, main, footer {{ padding-left:12px; padding-right:12px; }}
      h1 {{ font-size:23px; }}
      .card strong {{ font-size:24px; }}
      th, td {{ padding:8px; }}
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{ --bg:#111318; --text:#e8edf4; --muted:#a8b3c2; --line:#303846; --card:#191d25; --red:#ff9b90; --amber:#f8c16b; --blue:#8ab4ff; }}
      th {{ background:#222936; }}
      tr.overdue td {{ background:#3a1d1b; }}
      .risk-grid section {{ background:#151922; }}
      .generated {{ background:#191d25; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>PM Dashboard - {badge(data['project_name'])}</h1>
    <div class="meta">Generated {badge(data['generated_at'])} from {badge(data['project_root'])}</div>
    <div class="generated">Generated file. Do not edit manually.</div>
  </header>
  <main>
    <div class="cards">{cards}</div>
    <section>
      <h2>This week</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Task</th><th>Target finish date</th><th>Status</th><th>Waiting on</th><th>At risk</th><th>Next human decision</th><th>Next agent action</th></tr></thead>
          <tbody>{''.join(this_week_rows)}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>Risks</h2>
      <div class="risk-grid">{''.join(risk_sections)}</div>
    </section>
    <section>
      <h2>Active handoffs</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Target finish date</th><th>Deadline type</th><th>Confidence</th><th>At risk</th><th>Waiting on</th><th>Next human decision</th><th>Next agent action</th><th>Inbox</th><th>Last updated</th><th>Paths</th></tr></thead>
          <tbody>{''.join(table_rows) or '<tr><td colspan="13">No active handoffs.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  </main>
  <footer>Generated file. Do not edit manually. Edit the relevant HANDOFF.md Section 0A and rebuild.</footer>
</body>
</html>
"""


def write_outputs(root: Path, data: dict[str, Any]) -> None:
    pm_root = root / ".private" / "pm"
    pm_root.mkdir(parents=True, exist_ok=True)

    (pm_root / "DASHBOARD.md").write_text(render_markdown(data), encoding="utf-8")
    json_data = {key: value for key, value in data.items() if key != "_this_week"}
    (pm_root / "dashboard.json").write_text(json.dumps(json_data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (pm_root / "DASHBOARD.html").write_text(render_html(data), encoding="utf-8")


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    tasks = load_tasks(root)
    data = compute(root, tasks)
    write_outputs(root, data)
    counts = data["counts"]
    print(
        "PM dashboard rebuilt: "
        f"{counts['active_handoffs']} active, "
        f"{counts['blocked']} blocked, "
        f"{counts['overdue']} overdue, "
        f"{counts['stale']} stale, "
        f"{counts['waiting']} waiting, "
        f"{counts['malformed']} malformed"
    )
    print(".private/pm/DASHBOARD.md")
    print(".private/pm/dashboard.json")
    print(".private/pm/DASHBOARD.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
