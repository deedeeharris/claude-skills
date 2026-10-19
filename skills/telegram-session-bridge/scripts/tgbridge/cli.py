"""Guided pairing and local durable-queue commands for a session-owned relay."""

from __future__ import annotations

import argparse
import contextlib
import getpass
import json
import math
import os
import re
import secrets
import signal
import sqlite3
import sys
import threading
import time
import uuid
from dataclasses import replace
from pathlib import Path

from .config import Config, ConfigError, validate_token
from .harness import HarnessError, harness_report, validate_run_mode
from .host import CollectorLock, Host, HostError
from .messages import authorized_message
from .service import Service, ServiceError, prepare_request, publish, validate_binding
from .store import Store, StoreError
from .telegram import Telegram, TelegramError

__all__ = ["main"]

_VERIFICATION = {
    "automatic_continuation": "live-unverified",
    "canonical_output_capture": "live-unverified",
    "session_lifecycle": "live-unverified",
}


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's normal error includes raw argument values, potentially secrets.
        self.exit(2, "Invalid command arguments; use --help.\n")


def _parser():
    parser = _Parser(
        description="Telegram bridge for an existing coding session. No second model."
    )
    parser.add_argument(
        "--config", default=str(Path.home() / ".config/tg-bridge/config.json")
    )
    commands = parser.add_subparsers(dest="command", required=True)

    def command(name, **kw):
        child = commands.add_parser(name, **kw)
        child.add_argument("--config", default=argparse.SUPPRESS)
        return child

    setup = command(
        "init",
        aliases=["pair"],
        help="Authenticate and pair before saving configuration",
    )
    setup.add_argument("--session-id", required=True)
    tokens = setup.add_mutually_exclusive_group()
    tokens.add_argument("--token-env", default="TELEGRAM_BOT_TOKEN")
    tokens.add_argument("--token-stdin", action="store_true")
    tokens.add_argument("--token-hidden", action="store_true")
    setup.add_argument(
        "--host-command", default="[]", help="Trusted static JSON executable argv"
    )
    setup.add_argument("--owner-pid", type=int)
    setup.add_argument("--pair-timeout", type=float, default=180)
    setup.add_argument(
        "--recover-setup",
        action="store_true",
        help="Retire identified incomplete setup after verifying its old host work stopped",
    )
    bind = command("bind", help="Fresh pairing or explicit same-session resume")
    bind.add_argument("--session-id", required=True)
    bind.add_argument("--resume", action="store_true")
    bind.add_argument(
        "--owner-pid", type=int, help="Optional owner process for this fresh binding"
    )
    bind.add_argument("--pair-timeout", type=float, default=180)
    bind.add_argument(
        "--recover-setup",
        action="store_true",
        help="Retire identified incomplete binding after verifying old host work stopped",
    )
    run = command("run", help="Run foreground under the host session job supervisor")
    run.add_argument(
        "--mode",
        choices=["collector-only", "cooperative", "task-completion", "native"],
        help="Required operator assertion; does not detect native host capability",
    )
    run.add_argument(
        "--session-owned",
        action="store_true",
        help="Confirm host owns/terminates this job with the session",
    )
    wait = command("wait", help="Claim local queued work; timeout exits 3")
    wait.add_argument("--timeout", type=float, default=1800)
    output = command("publish", help="Queue canonical host output before complete")
    output.add_argument("--request-id", required=True, type=int)
    output.add_argument("--source", required=True, choices=["telegram"])
    output.add_argument("--kind", required=True, choices=["progress", "final"])
    output.add_argument("--text-file")
    output.add_argument("--file", action="append", default=[])
    output.add_argument("--photo", action="append", default=[])
    output.add_argument("--format", choices=["markdown", "plain"], default="markdown")
    complete = command(
        "complete", help="Acknowledge claimed work after publishing all output"
    )
    complete.add_argument("--request-id", type=int, required=True)
    recover = command(
        "recover", help="Explicitly recover abandoned work/control ownership"
    )
    target = recover.add_mutually_exclusive_group(required=True)
    target.add_argument("--request-id", type=int)
    target.add_argument("--control-id", type=int)
    recover.add_argument("--previous-work-stopped", action="store_true")
    command("unbind", help="End this binding; collector exits on its next short poll")
    command("status", help="Offline, redacted queue state")
    command("harness", help="Offline, read-only host capability observations")
    command(
        "doctor", help="Offline capability report, including unverified host behavior"
    )
    outbox = command("outbox", help="Inspect or explicitly resolve uncertain output")
    outbox.add_argument(
        "action",
        choices=["inspect", "retry", "mark-sent", "cancel"],
        nargs="?",
        default="inspect",
    )
    outbox.add_argument("--id", type=int)
    outbox.add_argument("--message-id", type=int)
    outbox.add_argument("--ack-duplicate-risk", action="store_true")
    return parser


def _emit(stream, data):
    print(json.dumps(data, ensure_ascii=False), file=stream, flush=True)


def _api(token):
    # Short socket timeout plus one-second long polling keeps local queues serviced.
    # Origin remains fixed inside Telegram; no production endpoint override exists.
    return Telegram(token, timeout=5)


def _session(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", value):
        raise ServiceError("Supply the actual host session identifier")


def _duration(value, *, maximum=None):
    if not math.isfinite(value) or value < 0 or maximum is not None and value > maximum:
        raise ServiceError("Invalid timeout")
    return value


def _safe_read(api, method, params, deadline=None):
    for attempt in range(5):
        try:
            return api.call(method, params)
        except TelegramError as exc:
            if (
                exc.code in {401, 409}
                or attempt == 4
                or exc.code not in {"network", "response", 429, 500, 502, 503, 504}
            ):
                raise
            delay = (
                max(1, exc.retry_after or 1) if exc.code == 429 else min(2**attempt, 16)
            )
            if deadline is not None and time.monotonic() + delay >= deadline:
                raise ServiceError(
                    "Pairing expired; start a new one-time pairing"
                ) from None
            time.sleep(delay)
    raise ServiceError("Telegram read failed")


def _pair(api, bot, timeout, stderr, owner=None):
    webhook = _safe_read(api, "getWebhookInfo", {})
    if not isinstance(webhook, dict) or not isinstance(webhook.get("url"), str):
        raise TelegramError("response")
    if webhook["url"]:
        raise ServiceError("Existing webhook refused; no webhook was deleted")
    code = "/start pair_" + secrets.token_urlsafe(24)
    deadline = time.monotonic() + _duration(timeout, maximum=300)
    _emit(
        stderr,
        {
            "bot_username": bot["username"],
            "pairing_text": code,
            "expires_in_seconds": timeout,
            "instruction": "Send pairing_text exactly in the private bot chat.",
        },
    )
    offset = 0
    while time.monotonic() < deadline:
        batch = _safe_read(
            api,
            "getUpdates",
            {"offset": offset, "timeout": 1, "allowed_updates": ["message"]},
            deadline,
        )
        if not isinstance(batch, list):
            raise TelegramError("response")
        valid = sorted(
            (
                u
                for u in batch
                if isinstance(u, dict)
                and type(u.get("update_id")) is int
                and 0 <= u["update_id"] < 2**63 - 1
            ),
            key=lambda u: u["update_id"],
        )
        for update in valid:
            uid = update["update_id"]
            if uid < offset:
                continue
            message = update.get("message", {})
            chat = message.get("chat", {}) if isinstance(message, dict) else {}
            user = message.get("from", {}) if isinstance(message, dict) else {}
            chat_id = chat.get("id") if isinstance(chat, dict) else None
            user_id = user.get("id") if isinstance(user, dict) else None
            authorized = (
                type(chat_id) is int
                and 0 < chat_id < 2**63
                and type(user_id) is int
                and 0 < user_id < 2**63
                and authorized_message(update, chat_id, user_id) is not None
            )
            if (
                authorized
                and message.get("text") == code
                and (owner is None or owner == (chat_id, user_id))
                and time.monotonic() < deadline
            ):
                api.call(
                    "setMyCommands",
                    {
                        "scope": {"type": "chat", "chat_id": chat_id},
                        "commands": [
                            {
                                "command": "interrupt",
                                "description": "Priority request: /interrupt <text>",
                            },
                            {
                                "command": "stop",
                                "description": "Clear queued work and request task cancellation",
                            },
                        ],
                    },
                )
                # Never advance beyond the pairing update: later batch messages remain eligible.
                return chat_id, user_id, uid + 1
            offset = uid + 1
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    raise ServiceError("Pairing expired; start a new one-time pairing")


def _bot(api):
    bot = _safe_read(api, "getMe", {})
    if (
        not isinstance(bot, dict)
        or bot.get("is_bot") is not True
        or type(bot.get("id")) is not int
        or not 0 < bot["id"] < 2**63
        or not isinstance(bot.get("username"), str)
        or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", bot["username"])
    ):
        raise TelegramError("response")
    return bot


def _bind_store(store, cfg, offset=0):
    return store.bind(
        cfg.binding_id,
        cfg.session_id,
        cfg.bot_id,
        cfg.owner_chat_id,
        cfg.owner_user_id,
        initial_offset=offset,
        bot_username=cfg.bot_username,
    )


def _cleanup_staged(path, store, bot_id, *, current_binding=None, recover=False):
    """Retire only an identified incomplete binding while holding the bot lock."""
    if not path.exists() and not path.is_symlink():
        return
    staged = Config.load(path)
    if staged.bot_id != bot_id:
        raise ServiceError(
            "Incomplete setup belongs to another bot; use a separate private directory"
        )
    binding = store.binding(staged.binding_id)
    if binding and binding["active"] and staged.binding_id != current_binding:
        if not recover:
            raise ServiceError(
                "Incomplete setup found. Verify its host work stopped, then retry with --recover-setup"
            )
        # Validate every identity field before retiring staged work.
        _bind_store(store, staged)
        store.unbind(staged.binding_id)
    path.unlink()


def _setup(args, factory, stdin, stdout, stderr):
    _session(args.session_id)
    _duration(args.pair_timeout, maximum=300)
    path = Path(args.config)
    if path.exists() or path.is_symlink():
        raise ServiceError(
            "Configuration already exists; use bind for a fresh session or explicit resume"
        )
    if args.token_stdin:
        token = validate_token(stdin.read(1024).strip())
        source = {"token": token}
    elif args.token_hidden:
        if not stdin.isatty():
            raise ServiceError(
                "Hidden token entry requires a terminal; use --token-stdin"
            )
        token = validate_token(
            getpass.getpass("Bot token (hidden): ", stream=stderr).strip()
        )
        source = {"token": token}
    else:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.token_env):
            raise ConfigError("Invalid token environment variable name")
        token = validate_token(os.environ.get(args.token_env, ""))
        source = {"token_env": args.token_env}
    api = factory(token)
    bot = _bot(api)
    with CollectorLock(bot["id"]):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        staged_path = path.parent / ".pending-pairing.json"
        with Store(path.parent / "state.sqlite3") as store:
            _cleanup_staged(staged_path, store, bot["id"], recover=args.recover_setup)
        chat, user, offset = _pair(api, bot, args.pair_timeout, stderr)
        cfg = Config(
            1,
            uuid.uuid4().hex,
            args.session_id,
            bot["id"],
            bot["username"],
            chat,
            user,
            host_command=json.loads(args.host_command),
            owner_pid=args.owner_pid,
            **source,
        )
        # Save valid configuration only after durable binding admission succeeds.
        # A failed setup never overwrites an existing configuration.
        cfg.save(staged_path)
        with Store(path.parent / "state.sqlite3") as store:
            _bind_store(store, cfg, offset)
            cfg.save(path)
        staged_path.unlink()
    _emit(
        stdout,
        {
            "paired": True,
            "binding_id": cfg.binding_id,
            "session_id": cfg.session_id,
            "bot_username": cfg.bot_username,
            "verification": _VERIFICATION,
        },
    )
    return 0


def _summary(cfg, store):
    report = harness_report(cfg)
    return {
        **store.status(cfg.binding_id),
        "verification": {
            **_VERIFICATION,
            "automatic_continuation": report["automatic_continuation"],
        },
        "harness": report,
        "host_hook_configured": bool(cfg.host_command),
        "lifecycle_requirement": "Host-owned session job; browser closure is not session end.",
        "local_lock_scope": "This UID on this VM only; Telegram 409 conflicts fail fast.",
        "idle_behavior": (
            "Script polling; generic native-hook continuation is "
            + report["automatic_continuation"]
            + "."
        ),
    }


def _inspect(row):
    return {k: v for k, v in row.items() if k not in {"payload"}}


def _execute(args, factory, stdin, stdout, stderr):
    if args.command in {"init", "pair"}:
        return _setup(args, factory, stdin, stdout, stderr)
    cfg = Config.load(args.config)
    # Harness does not even open the durable store; reports cannot claim work.
    if args.command == "harness":
        _emit(stdout, harness_report(cfg))
        return 0
    report = validate_run_mode(cfg, args.mode) if args.command == "run" else None
    with Store(cfg.private_state_dir / "state.sqlite3") as store:
        command = args.command
        if command in {"status", "doctor"}:
            _emit(stdout, _summary(cfg, store))
        elif command == "bind":
            _session(args.session_id)
            if args.resume:
                if cfg.session_id != args.session_id:
                    raise ServiceError("Resume must name the existing bound session")
                _bind_store(store, cfg)
            else:
                api = factory(cfg.resolve_token())
                bot = _bot(api)
                if bot["id"] != cfg.bot_id:
                    raise ServiceError("Configured token belongs to another bot")
                with CollectorLock(cfg.bot_id):
                    staged_path = cfg.private_state_dir / ".pending-binding.json"
                    _cleanup_staged(
                        staged_path,
                        store,
                        cfg.bot_id,
                        current_binding=cfg.binding_id,
                        recover=args.recover_setup,
                    )
                    _chat, _user, offset = _pair(
                        api,
                        bot,
                        args.pair_timeout,
                        stderr,
                        (cfg.owner_chat_id, cfg.owner_user_id),
                    )
                    new_cfg = replace(
                        cfg,
                        binding_id=uuid.uuid4().hex,
                        session_id=args.session_id,
                        bot_username=bot["username"],
                        owner_pid=args.owner_pid,
                    )
                    new_cfg.save(staged_path)
                    current = store.binding(cfg.binding_id)
                    if current and current["active"]:
                        store.unbind(cfg.binding_id)
                    _bind_store(store, new_cfg, offset)
                    new_cfg.save(args.config)
                    staged_path.unlink()
                    cfg = new_cfg
            _emit(
                stdout,
                {
                    "binding_id": cfg.binding_id,
                    "session_id": cfg.session_id,
                    "resumed": args.resume,
                },
            )
        elif command == "unbind":
            store.unbind(cfg.binding_id)
            _emit(stdout, {"unbound": True, "binding_id": cfg.binding_id})
        elif command == "run":
            if not args.session_owned:
                raise ServiceError(
                    "Run requires --session-owned: the host must own and terminate this job with its session"
                )
            validate_binding(cfg, store)
            _emit(
                stdout,
                {
                    "mode": args.mode,
                    "automatic_continuation": (
                        "blocked"
                        if args.mode in {"collector-only", "task-completion"}
                        else report["automatic_continuation"]
                    ),
                    "execution": {
                        "collector-only": "Saves work without agent execution.",
                        "cooperative": "Requires an open existing-agent blocking-tool loop.",
                        "task-completion": (
                            "Operator assertion: requires live verification of host "
                            "task-completion notifications into the same existing session; "
                            "generic native hooks are disabled."
                        ),
                        "native": "Configured host hook remains live-unverified.",
                    }[args.mode],
                },
            )
            stop = threading.Event()
            previous = {}
            if threading.current_thread() is threading.main_thread():
                for sig in (signal.SIGTERM, signal.SIGINT):
                    previous[sig] = signal.signal(sig, lambda *_: stop.set())
            try:
                host = (
                    Host([], cfg.binding_id, cfg.session_id)
                    if args.mode in {"collector-only", "task-completion"}
                    else None
                )
                Service(cfg, store, factory(cfg.resolve_token()), host=host).run(stop)
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        elif command == "wait":
            deadline = time.monotonic() + _duration(args.timeout)
            while True:
                binding = store.binding(cfg.binding_id)
                if not binding or not binding["active"]:
                    raise ServiceError("Binding is unavailable")
                validate_binding(cfg, store)
                request = store.claim(cfg.binding_id)
                if request:
                    try:
                        api = (
                            factory(cfg.resolve_token())
                            if request["attachments"]
                            else None
                        )
                        prepared = prepare_request(cfg, store, request, api)
                    except (ConfigError, ServiceError, StoreError, TelegramError):
                        # The claim is retained, never implicitly requeued after
                        # preparation failure. Keep its identity visible for recovery.
                        raise ServiceError(
                            f"Preparation failed for request {request['request_id']}; "
                            "claim retained (running unless canceled). Inspect status, "
                            "correct credentials if needed, then explicitly recover "
                            "only after verifying prior work has stopped"
                        ) from None
                    _emit(stdout, prepared)
                    return 0
                if time.monotonic() >= deadline:
                    return 3
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        elif command == "publish":
            rows = publish(
                cfg,
                store,
                args.request_id,
                source=args.source,
                kind=args.kind,
                text_path=args.text_file,
                attachments=args.file,
                photos=args.photo,
                mode=args.format,
            )
            _emit(
                stdout,
                {
                    "output_ids": [r["id"] for r in rows],
                    "request_id": args.request_id,
                    "completion_required": True,
                },
            )
        elif command == "complete":
            row = store.complete(cfg.binding_id, args.request_id)
            _emit(stdout, {"request_id": row["request_id"], "state": row["state"]})
        elif command == "recover":
            if not args.previous_work_stopped:
                raise ServiceError(
                    "Verify old host work cannot execute, then use --previous-work-stopped"
                )
            if args.request_id is not None:
                row = store.recover(cfg.binding_id, args.request_id)
                _emit(stdout, {"request_id": row["request_id"], "state": row["state"]})
            else:
                # Control IDs are global; require membership in this binding before mutation.
                state = store.status(cfg.binding_id)
                if args.control_id not in state["running_controls"]:
                    raise ServiceError("Control is not running in this binding")
                row = store.recover_control(args.control_id)
                _emit(stdout, {"control_id": row["id"], "state": row["state"]})
        elif command == "outbox":
            rows = store.outputs(cfg.binding_id)
            if args.action == "inspect":
                _emit(stdout, [_inspect(row) for row in rows])
            else:
                row = next((r for r in rows if r["id"] == args.id), None)
                if row is None:
                    raise ServiceError("Output is not in this binding")
                if args.action == "retry":
                    row = store.retry_output(
                        row["id"], ack_duplicate_risk=args.ack_duplicate_risk
                    )
                elif args.action == "mark-sent":
                    if args.message_id is None:
                        raise ServiceError(
                            "Confirmed Telegram --message-id is required"
                        )
                    row = store.finish_output(
                        row["id"], "sent", message_id=args.message_id
                    )
                else:
                    row = store.finish_output(row["id"], "canceled")
                _emit(stdout, _inspect(row))
    return 0


def main(argv=None, *, api_factory=None, stdin=None, stdout=None, stderr=None):
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    stderr = stderr if stderr is not None else sys.stderr
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            args = _parser().parse_args(argv)
        return _execute(args, api_factory or _api, stdin, stdout, stderr)
    except SystemExit as exc:
        return int(exc.code)
    except KeyboardInterrupt:
        return 130
    except TelegramError as exc:
        _emit(
            stderr,
            {
                "error": "Telegram operation failed",
                "code": exc.code,
                "ambiguous": exc.ambiguous,
            },
        )
    except (ConfigError, StoreError, HostError, ServiceError, HarnessError) as exc:
        _emit(stderr, {"error": str(exc)})
    except (OSError, ValueError, TypeError, sqlite3.Error):
        _emit(
            stderr,
            {
                "error": "Local operation failed; check private configuration and artifacts"
            },
        )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
