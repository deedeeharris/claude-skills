"""Unattended loop state and dispatch records.

The loop state lives in the ledger's `loop` object and renders as `### Loop`
at the end of Section 0B; there is no per-task loop file. The operator
approves a route:model list once, at `loop on`; inside it the PM dispatches
alone, anything else waits. Each tick records noop, productive or stopped;
the no-op cap turns the loop off. Dispatches are appended to
prompts/dispatches.jsonl with an exact copy of the prompt beside it.
"""

import datetime
import hashlib
import json
import os
import pathlib
import re

import mm_atomic
import mm_schema

NOOP_CAP = 5
DEFAULT_LAUNCH = "/babysitter:yolo {prompt}"
BACKGROUND_ROUTES = ("bg-it", "claude-bg")
ROUTE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:/-]*$")
REPORT_CAP = 4000


class LoopError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def _now():
    return datetime.datetime.now().astimezone().replace(microsecond=0)


def tick_prompt(task_dir: pathlib.Path) -> str:
    return f"mm tick {pathlib.Path(task_dir).absolute()}"


def parse_host_rule(text: str) -> dict:
    """'<source>: <conflict> => <answer>' -> dict."""
    left, arrow, answer = text.rpartition(" => ")
    source, sep, conflict = left.partition(": ")
    if not arrow or not sep or not source.strip() or not conflict.strip() or not answer.strip():
        raise LoopError(6, f"--host-rule takes '<source>: <conflict> => <answer>', got {text!r}")
    return {"source": source.strip(), "conflict": conflict.strip(), "answer": answer.strip()}


def loop_on(doc: dict, *, approved_by, routes, cadence, noop_cap, notifier, host_rules, cron_id,
            owner_session) -> str:
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else None
    rules = [parse_host_rule(rule) for rule in host_rules or []]
    if approved_by or routes:
        if not (approved_by or "").strip() or not routes:
            raise LoopError(9, "loop on needs the operator's approval: --approved-by <operator> and at least one "
                               "--route <route>:<model>")
        bad = [r for r in routes if not ROUTE_RE.match(r)]
        if bad:
            raise LoopError(6, "each --route is <route>:<model>, for example bg-it:sonnet; got " + ", ".join(bad))
        previous = loop or {}
        loop = {"mode": "unattended", "approved_by": approved_by.strip(), "approved_at": _now().isoformat(),
                "routes": list(dict.fromkeys(routes)), "cadence": cadence or previous.get("cadence") or "60m",
                "cron_id": cron_id or previous.get("cron_id", ""),
                "owner_session": owner_session or previous.get("owner_session", ""),
                "noop_count": 0, "noop_cap": noop_cap or NOOP_CAP, "last_tick": previous.get("last_tick", {}),
                "notifier": notifier if notifier is not None else previous.get("notifier", ""),
                "host_rules": previous.get("host_rules", []) + rules, "stopped_reason": ""}
        doc["loop"] = loop
        return f"unattended, routes {', '.join(loop['routes'])}"
    if not loop or loop.get("mode") != "unattended":
        raise LoopError(9, "the loop is off: switching it on needs --approved-by <operator> and --route "
                           "<route>:<model>")
    if cron_id:
        loop["cron_id"] = cron_id
    if owner_session:
        loop["owner_session"] = owner_session
    if notifier is not None:
        loop["notifier"] = notifier
    loop["host_rules"] = loop.get("host_rules", []) + rules
    changed = [name for name, value in (("cron id", cron_id), ("owner", owner_session), ("host rules", rules),
                                        ("notifier", notifier)) if value]
    return "updated " + ", ".join(changed) if changed else "unchanged"


def loop_off(doc: dict, reason: str) -> str:
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else None
    if loop is None:
        doc["loop"] = loop = {"mode": "off", "routes": [], "noop_count": 0, "noop_cap": NOOP_CAP, "last_tick": {}}
    loop["mode"] = "off"
    loop["stopped_reason"] = reason or "stopped by the operator"
    return f"off ({loop['stopped_reason']})"


def record_tick(doc: dict, result: str, report: str, reason: str) -> bool:
    """Record one tick; True when this tick turned the loop off."""
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else None
    if loop is None:
        raise LoopError(4, "this task has no loop; switch it on with mm.py loop on")
    was_on = loop.get("mode") == "unattended"
    if result == "noop":
        loop["noop_count"] = int(loop.get("noop_count", 0)) + 1
    elif result == "productive":
        loop["noop_count"] = 0
    loop["last_tick"] = {"at": _now().isoformat(), "result": result, "report": report[:REPORT_CAP]}
    cap = int(loop.get("noop_cap") or NOOP_CAP)
    if result == "stopped":
        loop["mode"], loop["stopped_reason"] = "off", reason
    elif was_on and loop["noop_count"] >= cap:
        loop["mode"], loop["stopped_reason"] = "off", f"no-op cap reached ({loop['noop_count']}/{cap})"
    return was_on and loop["mode"] == "off"


def _normal(prompt: str) -> str:
    text = " ".join(str(prompt).split()).replace("\\", "/").rstrip("/")
    return text.casefold() if os.name == "nt" else text


def cron_plan(loop: dict, crons: list, prompt: str) -> list:
    """What to do with the host's crons so exactly one owns `prompt`."""
    same = [str(c.get("id")) for c in crons if isinstance(c, dict)
            and _normal(c.get("prompt") or c.get("cron_prompt") or "") == _normal(prompt)]
    if not loop or loop.get("mode") != "unattended":
        return [f"CRON-DELETE {cid}" for cid in same]
    recorded = loop.get("cron_id") or ""
    if recorded in same:
        return [f"CRON-KEEP {recorded}"] + [f"CRON-DELETE {cid}" for cid in same if cid != recorded]
    if same:
        return [f"CRON-ADOPT {same[0]} (record it: mm.py loop on --task-dir <dir> --cron-id {same[0]})"] + \
            [f"CRON-DELETE {cid}" for cid in same[1:]]
    return [f"CRON-CREATE {prompt}", "then record its id: mm.py loop on --task-dir <dir> --cron-id <id>"]


def read_crons(path) -> list:
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise LoopError(2, f"cannot read the cron list {path}: {exc}")
    if isinstance(data, dict):
        data = data.get("crons") or data.get("jobs") or []
    if not isinstance(data, list):
        raise LoopError(2, "the cron list is a JSON array of {id, prompt} objects")
    return data


# ---------------------------------------------------------------- dispatch records

def records_path(task_dir: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(task_dir) / "prompts" / "dispatches.jsonl"


def read_records(task_dir: pathlib.Path) -> list:
    path = records_path(task_dir)
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_records(task_dir: pathlib.Path, records: list) -> None:
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    mm_atomic.atomic_write_text(records_path(task_dir), text, encoding="utf-8", newline="\n")


def approval(doc: dict, route: str, model: str, approved_by, exception_by=None, exception_reason=None) -> tuple:
    """(mode, approval text, exception record or None); raises LoopError(9)
    when nobody approved, LoopError(2) for a misused exception. Unattended,
    only the approved list or a recorded operator exception approves: a
    bare --approved-by never adds to the list."""
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else {}
    mode = "unattended" if loop.get("mode") == "unattended" else "attended"
    by, reason = (exception_by or "").strip(), (exception_reason or "").strip()
    if (by or reason) and mode == "attended":
        raise LoopError(2, "--operator-exception is only for unattended mode; in attended mode the operator's yes "
                           "is --approved-by <operator>")
    if by and not reason:
        raise LoopError(2, "--operator-exception needs --exception-reason: the operator's own words approving this "
                           "off-list route and model")
    if mode == "attended":
        if (approved_by or "").strip():
            return mode, f"operator: {approved_by.strip()}", None
        raise LoopError(9, "attended mode: every dispatch needs the operator's yes to this prompt, route and "
                           "model; pass --approved-by <operator> after they say yes")
    pair = f"{route}:{model}"
    if pair in loop.get("routes", []):
        return mode, f"approved list ({loop.get('approved_by', '?')} at {loop.get('approved_at', '?')})", None
    if by:
        record = {"by": by, "reason": reason, "route": pair, "at": _now().isoformat()}
        return mode, f"operator exception: {by} ({reason})", record
    raise LoopError(9, f"{pair} is not on the approved list ({', '.join(loop.get('routes', [])) or 'empty'}); in "
                       "unattended mode --approved-by does not add to it. It waits for the operator: record their "
                       "yes with --operator-exception <operator> --exception-reason <their words>, or they change "
                       "the list with loop on")


def launch_template(route: str, launch) -> str:
    """The launch template a dispatch uses: absent gives DEFAULT_LAUNCH for a
    background route, else ""; a given value, "" included, is kept."""
    if launch is None:
        return DEFAULT_LAUNCH if route in BACKGROUND_ROUTES else ""
    return launch


def next_dispatch_id(records: list) -> str:
    numbers = [int(r["id"][1:]) for r in records if re.fullmatch(r"d[0-9]+", str(r.get("id")))]
    return "d%d" % (max(numbers, default=0) + 1)


def add_dispatch(task_dir: pathlib.Path, *, mode, approval_text, route, model, prompt_bytes, prompt_name, row,
                 launch, exception=None, launch_cwd="", dispatch_id=None, approval_id=None, worker=None) -> dict:
    task_dir = pathlib.Path(task_dir)
    records = read_records(task_dir)
    rid = next_dispatch_id(records)
    if dispatch_id is not None and dispatch_id != rid:
        raise LoopError(1, f"dispatch id {dispatch_id} was promised but the next id is {rid}; nothing recorded")
    now = _now()
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", pathlib.Path(prompt_name).stem).strip("-") or "prompt"
    copy = task_dir / "prompts" / f"{now.strftime('%Y%m%d-%H%M%S')}-{rid}-{stem}.md"
    copy.parent.mkdir(parents=True, exist_ok=True)
    with open(copy, "xb") as fh:
        fh.write(prompt_bytes)
    if copy.read_bytes() != prompt_bytes:
        raise LoopError(1, f"the prompt copy {copy} did not verify")
    launch = launch_template(route, launch)
    record = {"id": rid, "at": now.isoformat(), "route": route, "model": model, "mode": mode,
              "approval": approval_text, "prompt": copy.relative_to(task_dir).as_posix(), "prompt_path": str(copy),
              "prompt_sha256": hashlib.sha256(prompt_bytes).hexdigest(), "row": row or "",
              "launch": _render(launch, str(copy)), "launch_cwd": launch_cwd, "liveness": [], "closed": None}
    if exception:
        record["exception"] = exception
    if approval_id is not None:
        record["approval_id"] = approval_id
    if worker is not None:
        record["worker"] = worker
    write_records(task_dir, records + [record])
    return record


def _render(launch: str, prompt: str) -> str:
    """The launch as dispatched: {prompt} becomes the prompt copy's path; a
    template without {prompt} is a prefix the path follows."""
    if not launch:
        return ""
    return launch.replace("{prompt}", prompt) if "{prompt}" in launch else f"{launch} {prompt}"


def find_record(records: list, dispatch_id: str) -> dict:
    record = next((r for r in records if r.get("id") == dispatch_id), None)
    if record is None:
        raise LoopError(4, f"no dispatch {dispatch_id!r} in prompts/dispatches.jsonl")
    return record


def in_flight_records(records: list) -> list:
    """The dispatches not closed whose last liveness verdict is not DEAD."""
    return [r for r in records if not r.get("closed") and (r.get("liveness") or [{}])[-1].get("verdict") != "DEAD"]


def in_flight(records: list) -> list:
    out = []
    for r in in_flight_records(records):
        last = (r.get("liveness") or [{}])[-1]
        out.append(f"{r['id']} {r['route']}:{r['model']} (last check: {last.get('verdict', 'none')})")
    return out


def waiting_on_operator(doc: dict) -> list:
    out = []
    for row in doc.get("rows", []):
        if row.get("state") == "NEEDS_DECISION":
            out.append(f"{row.get('id')} needs a decision: {row.get('blocked_reason') or row.get('item', '')[:70]}")
        elif row.get("user_facing") and row.get("state") not in ("HUMAN_VERIFIED",) + mm_schema.TERMINAL:
            out.append(f"{row.get('id')} is user-facing and waits for a human check (HUMAN_VERIFIED)")
    return out


def tick_report(doc: dict, records: list, *, result, row, action, next_action, dedup, notes) -> str:
    loop = doc.get("loop") or {}
    open_rows = [r for r in doc.get("rows", []) if r.get("state") not in mm_schema.TERMINAL
                 and not r.get("is_wrapup")]
    if not row and open_rows:
        row = f"{open_rows[0].get('id')} {open_rows[0].get('item', '')[:60]}"
    lines = [f"Tick report - {doc.get('task', '')} - {_now().strftime('%Y-%m-%d %H:%M')}",
             f"Row: {row or 'none open'}",
             f"Action: {action or ('no-op' if result == 'noop' else result)}",
             "In-flight dispatches: " + ("; ".join(in_flight(records)) or "none"),
             f"No-ops: {loop.get('noop_count', 0)}/{loop.get('noop_cap', NOOP_CAP)}",
             "Waiting on the operator: " + ("; ".join(waiting_on_operator(doc)) or "nothing"),
             f"Cron deduplication: {dedup or 'none'}",
             f"Next: {next_action or 'next tick'}"]
    if loop.get("mode") != "unattended":
        lines.append(f"Loop: off ({loop.get('stopped_reason', '')})")
    if notes:
        lines.append("Notes: " + notes)
    return "\n".join(lines)
