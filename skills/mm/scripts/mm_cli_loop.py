"""mm.py unattended loop, dispatch approvals and records, and launch-check.
"""

import hashlib
import json
import pathlib

import mm_compile
import mm_launch
import mm_ledger
import mm_liveness
import mm_loop
import mm_runtime
import mm_transcripts
from mm_cli import CliError, _commit, _load, _task_dir, _where_check, _write


def _loop_op(fn):
    def apply(doc):
        try:
            return fn(doc)
        except mm_loop.LoopError as exc:
            raise CliError(exc.code, str(exc))
    return apply


def _crons(args) -> list:
    if not getattr(args, "crons_file", None):
        return None
    try:
        return mm_loop.read_crons(args.crons_file)
    except mm_loop.LoopError as exc:
        raise CliError(exc.code, str(exc))


def cmd_loop(args) -> int:
    task_dir = _task_dir(args)
    action = args.loop_action
    if action == "status":
        return _loop_status(task_dir)
    if action == "tick" and args.begin:
        return _loop_begin(task_dir, _crons(args))
    if action == "on":
        return _loop_on(args, task_dir)
    if action == "off":
        code = _write(args, "loop off", _loop_op(lambda doc: mm_loop.loop_off(doc, args.reason)), [])
        cron = (mm_ledger.load_ledger(task_dir).get("loop") or {}).get("cron_id") or "<id>"
        print(f"MM-LOOP-OFF run CronDelete {cron} for the prompt: {mm_loop.tick_prompt(task_dir)}")
        return code
    return _loop_tick(args, task_dir)


def _loop_on(args, task_dir) -> int:
    crons = _crons(args)

    def apply(doc):
        return mm_loop.loop_on(doc, approved_by=args.approved_by, routes=args.route, cadence=args.cadence,
                               noop_cap=args.noop_cap, notifier=args.notifier, host_rules=args.host_rule,
                               cron_id=args.cron_id, owner_session=args.owner_session)

    code = _write(args, "loop on", _loop_op(apply), [])
    doc = mm_ledger.load_ledger(task_dir)
    print(mm_compile.loop_line(doc["loop"]))
    print(f"cron prompt (one line): {mm_loop.tick_prompt(task_dir)}")
    if crons is not None:
        print("\n".join(mm_loop.cron_plan(doc["loop"], crons, mm_loop.tick_prompt(task_dir))))
    elif not doc["loop"].get("cron_id"):
        print("next: CronList; adopt a cron with this prompt or CronCreate it; then record its id with "
              f"mm.py loop on --task-dir {task_dir} --cron-id <id>")
    return code


def _loop_status(task_dir) -> int:
    doc = _load(task_dir)
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else None
    if loop is None:
        print("Loop: off (never switched on); attended mode")
        return 0
    print(mm_compile.loop_line(loop))
    for key in ("approved_by", "approved_at", "cadence", "cron_id", "owner_session", "notifier", "stopped_reason"):
        print(f"{key}: {loop.get(key) or '-'}")
    for rule in loop.get("host_rules", []):
        print(f"host rule: {rule.get('source')}: {rule.get('conflict')} => {rule.get('answer')}")
    print("in-flight dispatches: " + ("; ".join(mm_loop.in_flight(mm_loop.read_records(task_dir))) or "none"))
    report = (loop.get("last_tick") or {}).get("report")
    if report:
        print("last tick report:\n" + report)
    return 0


def _loop_begin(task_dir, crons) -> int:
    doc = _load(task_dir)
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else {}
    prompt = mm_loop.tick_prompt(task_dir)
    plan = mm_loop.cron_plan(loop, crons, prompt) if crons is not None else []
    if loop.get("mode") != "unattended":
        print(f"MM-LOOP-OFF the loop is off ({loop.get('stopped_reason') or 'never switched on'}); run CronDelete "
              f"for every cron whose prompt is: {prompt}")
        print("\n".join(plan))
        return 0
    print(mm_compile.loop_line(loop))
    print("approved routes: " + ", ".join(loop.get("routes", [])))
    print("in-flight dispatches: " + ("; ".join(mm_loop.in_flight(mm_loop.read_records(task_dir))) or "none"))
    print("\n".join(plan) if plan else "cron check: run CronList and pass it as --crons-file <json> to deduplicate")
    return 0


def _loop_tick(args, task_dir) -> int:
    if not args.result:
        raise CliError(2, "loop tick takes --begin, or --result noop|productive|stopped")
    if args.result == "stopped" and not (args.reason or "").strip():
        raise CliError(2, "--result stopped needs --reason (for example: check failed)")
    state = {}

    def apply(doc):
        state["off"] = mm_loop.record_tick(doc, args.result, "", args.reason or "")
        report = mm_loop.tick_report(doc, mm_loop.read_records(task_dir), result=args.result, row=args.row,
                                     action=args.action, next_action=args.next, dedup=args.dedup, notes=args.report)
        doc["loop"]["last_tick"]["report"] = report[:mm_loop.REPORT_CAP]
        state["report"] = report
        return f"{args.result} {doc['loop'].get('noop_count', 0)}/{doc['loop'].get('noop_cap', mm_loop.NOOP_CAP)}"

    code = _write(args, "loop tick", _loop_op(apply), [])
    print(state["report"])
    if state["off"]:
        loop = mm_ledger.load_ledger(task_dir)["loop"]
        print(f"MM-LOOP-OFF {loop.get('stopped_reason')}: run CronDelete {loop.get('cron_id') or '<id>'} for "
              f"{mm_loop.tick_prompt(task_dir)} and notify the operator")
    return code


# ---------------------------------------------------------------- approvals

def _approvals(task_dir) -> list:
    try:
        return mm_runtime.read_approvals(task_dir)
    except mm_runtime.ApprovalStoreError as exc:
        raise CliError(22, f"{exc}: the approval store prompts/approvals.jsonl is unreadable or malformed; nothing "
                           "written. Move it aside and approve again")


def _attended(doc: dict, flag: str) -> None:
    loop = doc.get("loop") if isinstance(doc.get("loop"), dict) else {}
    if loop.get("mode") == "unattended":
        raise CliError(2, f"{flag} is for attended mode only; in unattended mode the loop's approved route:model "
                          "list approves dispatches (mm.py loop status shows it)")


def cmd_approve_dispatch(args) -> int:
    task_dir = _task_dir(args)
    operator = (args.operator or "").strip() or mm_runtime.operator_name()
    if not operator:
        raise CliError(2, "approve-dispatch needs the operator: pass --operator <name>, or set operator_name in "
                          "mm.local.md")
    if not 1 <= args.ttl_minutes <= mm_runtime.TTL_MAX:
        raise CliError(2, f"--ttl-minutes is 1 to {mm_runtime.TTL_MAX}, got {args.ttl_minutes}")
    _where_check(task_dir)
    prompt_path = pathlib.Path(args.prompt_file).absolute()
    try:
        prompt = prompt_path.read_bytes()
    except OSError as exc:
        raise CliError(4, f"cannot read the prompt file: {exc}")
    launch = mm_loop.launch_template(args.route, args.launch)

    def approve(doc, records) -> dict:
        _attended(doc, "approve-dispatch")
        if args.row not in [r.get("id") for r in doc.get("rows", []) if isinstance(r, dict)]:
            raise CliError(2, f"row {args.row} is not in the ledger of {task_dir.name}; approve a row it holds")
        record = mm_runtime.new_approval(
            records, task=doc.get("task"), task_dir=task_dir, row=args.row, route=args.route, model=args.model,
            worker=args.worker, launch=launch, prompt_path=prompt_path, prompt_bytes=prompt, operator=operator,
            channel=args.channel, session=args.session, ttl_minutes=args.ttl_minutes)
        expected = (args.expect_sha256 or "").strip().lower()
        if expected and expected != record["prompt_sha256"]:
            raise CliError(9, f"MM-APPROVAL-REFUSED PROMPT-CHANGED {prompt_path} has sha256 "
                              f"{record['prompt_sha256'][:12]} now, not the {expected[:12]} shown for approval; "
                              "nothing written. Show the prompt again and ask for a fresh approval")
        return record

    if args.dry_run:
        record = approve(_load(task_dir), _approvals(task_dir))
    else:
        try:
            with mm_ledger.hold_lock(task_dir):
                doc = _load(task_dir)
                records = _approvals(task_dir)
                record = approve(doc, records)
                mm_runtime.write_approvals(task_dir, records + [record])
        except mm_ledger.LockTimeout:
            raise CliError(10, f"{task_dir / 'ledger.lock'} is held by another writer; retry shortly")
    summary = f"{record['id']} sha256={record['prompt_sha256'][:12]} expires {record['expires_at']}"
    if args.json:
        print(json.dumps({"schema": mm_runtime.APPROVAL_SCHEMA, "dry_run": bool(args.dry_run), "record": record},
                         ensure_ascii=False, indent=2))
    elif args.dry_run:
        print(f"dry run: approval {summary}; nothing written")
    else:
        print(f"MM-APPROVAL-OK {summary}")
    if args.dry_run:
        return 0
    return _commit(args, task_dir, f"approve-dispatch {record['id']} {args.route}:{args.model}",
                   [mm_runtime.approvals_path(task_dir)])


# ---------------------------------------------------------------- dispatch and liveness

def cmd_dispatch(args) -> int:
    task_dir = _task_dir(args)
    if args.close:
        return _dispatch_close(args, task_dir)
    missing = [f"--{name.replace('_', '-')}" for name in ("route", "model", "prompt_file") if not getattr(args, name)]
    if missing:
        raise CliError(2, "dispatch needs " + ", ".join(missing))
    if args.approval_id is not None:
        if args.approved_by is not None:
            raise CliError(2, "--approval-id and --approved-by are two ways to approve one dispatch; give one")
        if not args.worker:
            raise CliError(2, "--approval-id needs --worker, the worker kind the operator approved")
        if args.operator_exception or args.exception_reason:
            raise CliError(2, "--approval-id is for attended mode; --operator-exception is for unattended mode")
    _where_check(task_dir)
    try:
        prompt = pathlib.Path(args.prompt_file).read_bytes()
    except OSError as exc:
        raise CliError(4, f"cannot read the prompt file: {exc}")
    dispatch_id = None
    try:
        with mm_ledger.hold_lock(task_dir):
            doc = _load(task_dir)
            if args.approval_id is not None:
                approval, dispatch_id = _consume_approval(args, task_dir, doc, prompt)
                mode, exception = "attended", None
            else:
                mode, approval, exception = mm_loop.approval(doc, args.route, args.model, args.approved_by,
                                                             args.operator_exception, args.exception_reason)
            record = mm_loop.add_dispatch(task_dir, mode=mode, approval_text=approval, route=args.route,
                                          model=args.model, prompt_bytes=prompt, prompt_name=args.prompt_file,
                                          row=args.row, launch=args.launch, exception=exception,
                                          launch_cwd=str(mm_transcripts.repo_of(task_dir)), dispatch_id=dispatch_id,
                                          approval_id=args.approval_id, worker=args.worker)
    except mm_ledger.LockTimeout:
        raise CliError(10, f"{task_dir / 'ledger.lock'} is held by another writer; retry shortly")
    except mm_loop.LoopError as exc:
        raise CliError(exc.code, str(exc))
    print(f"MM-DISPATCH-OK {record['id']} {args.route}:{args.model} ({mode}; {approval})")
    if exception:
        print(f"EXCEPTION {record['id']}: {exception['route']} is off the approved list; approved by "
              f"{exception['by']} at {exception['at']}, recorded in prompts/dispatches.jsonl")
    print(f"prompt copy: {task_dir / record['prompt']}")
    if record["launch"]:
        print(f"launch: {record['launch']}")
    print(f"then: mm.py launch-check --task-dir {task_dir} --dispatch-id {record['id']} --launch-log <the launch "
          "command's captured output> at +20 s after the launch, and again at +6 min")
    paths = [mm_loop.records_path(task_dir), task_dir / record["prompt"]]
    if args.approval_id is not None:
        paths.insert(0, mm_runtime.approvals_path(task_dir))
    return _commit(args, task_dir, f"dispatch {record['id']} {args.route}:{args.model}", paths)


def _consume_approval(args, task_dir, doc, prompt) -> tuple:
    """Under the dispatch's lock: check approval --approval-id against this
    exact call and mark it consumed by the next dispatch id, before the
    dispatch is recorded (a crash in between leaves a consumed approval and no
    dispatch, never a reusable approval). Returns (approval text, dispatch id);
    a refusal exits 9 and writes nothing."""
    _attended(doc, "--approval-id")
    approvals = _approvals(task_dir)
    record = next((a for a in approvals if a.get("id") == args.approval_id), None)
    if record is None:
        refused = ("UNKNOWN", f"no approval {args.approval_id!r} in prompts/approvals.jsonl")
    else:
        refused = mm_runtime.approval_refusal(
            record, now=mm_runtime._clock(), task=doc.get("task"), task_dir=str(task_dir), row=args.row or "",
            route=args.route, model=args.model, worker=args.worker,
            launch=mm_loop.launch_template(args.route, args.launch),
            prompt_sha256=hashlib.sha256(prompt).hexdigest())
    if refused:
        raise CliError(9, f"MM-APPROVAL-REFUSED {refused[0]} {refused[1]}; nothing written. An approval covers one "
                          "exact dispatch once: show the prompt again and run approve-dispatch for a fresh one")
    dispatch_id = mm_loop.next_dispatch_id(mm_loop.read_records(task_dir))
    record["consumed_at"], record["consumed_by"] = mm_runtime._clock().isoformat(), dispatch_id
    mm_runtime.write_approvals(task_dir, approvals)
    return f"approval {record['id']}: {record.get('operator')} via {record.get('channel')} at " \
           f"{record.get('approved_at')}", dispatch_id


def _update_record(task_dir, dispatch_id, change) -> dict:
    try:
        with mm_ledger.hold_lock(task_dir):
            records = mm_loop.read_records(task_dir)
            record = mm_loop.find_record(records, dispatch_id)
            change(record)
            mm_loop.write_records(task_dir, records)
            return record
    except mm_ledger.LockTimeout:
        raise CliError(10, f"{task_dir / 'ledger.lock'} is held by another writer; retry shortly")
    except mm_loop.LoopError as exc:
        raise CliError(exc.code, str(exc))


def _dispatch_close(args, task_dir) -> int:
    _where_check(task_dir)
    closed = {"at": mm_loop._now().isoformat(), "outcome": args.outcome or "closed"}
    _update_record(task_dir, args.close, lambda record: record.update(closed=closed))
    print(f"MM-DISPATCH-CLOSED {args.close}: {closed['outcome']}")
    return _commit(args, task_dir, f"dispatch close {args.close}", [mm_loop.records_path(task_dir)])


def _builder_transcript(args, task_dir, record, facts, elapsed) -> tuple:
    """(transcript, None), or (None, (verdict, reason)) when no transcript or
    several hold this dispatch's launch record. Discovery looks in the folder
    --cwd names, else the one the record stored at dispatch (`launch_cwd`),
    else, for an older record, the repo holding the task. --transcript wins,
    but a file that cannot be read, or does not hold the launch record or a
    failure record tied to it, is refused, never judged. A file not written yet is
    judged as a missing transcript: PENDING, then DEAD (at the stall limit
    when the record stores neither a command nor a launch text)."""
    if args.transcript:
        path = pathlib.Path(args.transcript)
        if not path.exists():
            if facts["command"] or facts["launch_text"]:
                return path, None
            verdict, reason = mm_launch.plain_verdict(elapsed, args.stall_minutes * 60, "")
            return None, (verdict, f"--transcript {path} is not written yet; {reason}")
        try:
            found = mm_liveness.transcript_facts(path, **facts)
        except OSError as exc:
            raise CliError(2, f"--transcript {path}: cannot read it ({exc.strerror or exc}); pass the builder's "
                              "session transcript file, or leave --transcript out and launch-check finds it itself")
        if not (found["command_record"] or found["unknown_command"]):
            start = mm_launch.describe(command=facts["command"], marker=facts["marker"],
                                       launch_text=facts["launch_text"])
            raise CliError(2, f"--transcript {path} does not hold dispatch {record['id']}'s launch record ({start}, "
                              f"stamped at or after {facts['launched_at'].isoformat()}); leave --transcript out and "
                              "launch-check finds the builder's transcript itself")
        return path, None
    cwd = args.cwd or record.get("launch_cwd") or mm_transcripts.repo_of(task_dir)
    matches, folder = mm_transcripts.find(cwd, **facts)
    if len(matches) == 1:
        return matches[0], None
    stall_s = None if facts["command"] or facts["launch_text"] else args.stall_minutes * 60
    return None, mm_transcripts.unmatched(matches, folder, elapsed, stall_s)


def _refuse_predates_transcript(args, record) -> None:
    """An explicit --transcript for a record that predates prompt_path: no
    transcript can prove that launch, so a file that exists is refused with
    exit 2 and nothing is recorded; a file not written yet is no transcript."""
    path = pathlib.Path(args.transcript) if args.transcript else None
    if path is None or not path.exists():
        return
    try:
        path.open("rb").close()
    except OSError as exc:
        raise CliError(2, f"--transcript {path}: cannot read it ({exc.strerror or exc}); leave --transcript out")
    raise CliError(2, f"--transcript {path}: dispatch {record['id']}'s record predates prompt_path, so no transcript "
                      "can prove its launch; leave --transcript out, check the builder by hand, then close it with "
                      f"mm.py dispatch --close {record['id']} --outcome <what they found>")


def cmd_launch_check(args) -> int:
    task_dir = _task_dir(args)
    now = mm_loop._now()
    result = {}
    try:
        failed = mm_liveness.launch_log_failure(args.launch_log) if args.launch_log else ""
    except OSError as exc:
        raise CliError(4, f"--launch-log {args.launch_log}: cannot read it ({exc.strerror or exc}); pass the file "
                          "the launch command's output was captured to, or leave --launch-log out")

    def change(record):
        launched = mm_liveness._parse_time(args.launched_at or record.get("at", ""))
        if launched is None:
            raise CliError(2, f"--launched-at {args.launched_at!r} is not an ISO time")
        if failed:
            verdict, reason, journal = "DEAD", f"the launch output says: {failed}", None
        elif args.events or record.get("route", "").startswith("codex"):
            verdict, reason, journal = mm_liveness.codex_verdict(events=args.events, launched_at=launched, now=now)
        elif mm_launch.predates_prompt_path(record):
            _refuse_predates_transcript(args, record)
            verdict, reason, journal = "PENDING", mm_launch.PREDATES.format(id=record["id"]), None
        else:
            marker = pathlib.PurePosixPath(record.get("prompt", "")).name or record["id"]
            facts = {**mm_launch.launch_facts(record), "launched_at": launched, "marker": marker,
                     "session_id": args.session_id or record.get("session_id")}
            transcript, unmatched = _builder_transcript(args, task_dir, record, facts,
                                                        (now - launched).total_seconds())
            if unmatched:
                (verdict, reason), journal, session = unmatched, None, None
            else:
                verdict, reason, journal, session = mm_liveness.claude_verdict(
                    transcript=transcript, runs_dir=args.run_dir, now=now, previous=record.get("liveness") or [],
                    stall_s=args.stall_minutes * 60, **facts)
                reason += "" if args.transcript else f" (transcript {transcript})"
            if session and verdict == "ALIVE" and not record.get("session_id"):
                record["session_id"] = session
        reason += mm_liveness.late_note((now - launched).total_seconds(), record.get("liveness"))
        record.setdefault("liveness", []).append({"at": now.isoformat(), "verdict": verdict, "reason": reason,
                                                  "journal": journal})
        result.update(verdict=verdict, reason=reason)

    _update_record(task_dir, args.dispatch_id, change)
    print(f"LAUNCH {result['verdict']} {args.dispatch_id}: {result['reason']}")
    code = _commit(args, task_dir, f"launch-check {args.dispatch_id} {result['verdict']}",
                   [mm_loop.records_path(task_dir)])
    return 1 if result["verdict"] == "DEAD" else code
