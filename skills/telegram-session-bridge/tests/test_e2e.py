"""Release paths through the real CLI, SQLite and HTTP Bot API transport.

The trusted opener redirects test traffic to loopback only; production has no
endpoint override. Removing owner checks, snapshots, chunking, or binding scope
must break the end-to-end assertions.
"""

import io
import json
import threading
import unittest
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from tgbridge.cli import main
from tgbridge.config import Config
from tgbridge.host import CollectorLock
from tgbridge.service import Service
from tgbridge.store import Store
from tgbridge.telegram import Telegram

TOKEN = "123456:" + "X" * 30


class FakeBot:
    def __init__(self):
        self.stderr = io.StringIO()
        self.updates = []
        self.sent = []
        self.commands = []
        self.paired = set()
        self.files = {
            "image": b"\x89PNG\r\n\x1a\noriginal-image",
            "file": bytes(range(256)),
        }

    def update(self, text="", *, chat=7, user=8, **media):
        uid = max([u["update_id"] for u in self.updates], default=0) + 1
        self.updates.append(
            {
                "update_id": uid,
                "message": {
                    "chat": {"id": chat, "type": "private"},
                    "from": {"id": user},
                    "text": text,
                    **media,
                },
            }
        )
        return uid

    def result(self, method, params):
        if method == "getMe":
            return {"id": 991188, "username": "owner_bot", "is_bot": True}
        if method == "getWebhookInfo":
            return {"url": ""}
        if method == "setMyCommands":
            self.commands.append(params)
            return True
        if method == "getUpdates":
            for line in self.stderr.getvalue().splitlines():
                if not line.startswith("{"):
                    continue
                pairing = json.loads(line).get("pairing_text")
                if pairing and pairing not in self.paired:
                    self.update(pairing)
                    self.paired.add(pairing)
            return [
                u for u in self.updates if u["update_id"] >= params.get("offset", 0)
            ]
        if method == "getFile":
            data = self.files[params["file_id"]]
            return {"file_path": "files/" + params["file_id"], "file_size": len(data)}
        if method in {"sendMessage", "sendDocument", "sendPhoto"}:
            self.sent.append((method, params))
            return {"message_id": len(self.sent)}
        raise AssertionError(method)


class E2ETests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "config.json"
        self.bot = FakeBot()
        bot = self.bot

        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                body = handler.rfile.read(int(handler.headers["Content-Length"]))
                if handler.headers["Content-Type"].startswith("multipart/"):
                    message = BytesParser(policy=policy.default).parsebytes(
                        (
                            "Content-Type: "
                            + handler.headers["Content-Type"]
                            + "\r\nMIME-Version: 1.0\r\n\r\n"
                        ).encode()
                        + body
                    )
                    params = {}
                    for part in message.iter_parts():
                        name = part.get_param("name", header="content-disposition")
                        data = part.get_payload(decode=True)
                        params[name] = (
                            {"name": part.get_filename(), "bytes": data}
                            if part.get_filename()
                            else data.decode()
                        )
                else:
                    params = json.loads(body)
                result = bot.result(handler.path.rsplit("/", 1)[-1], params)
                handler.send_response(200)
                handler.end_headers()
                handler.wfile.write(json.dumps({"ok": True, "result": result}).encode())

            def do_GET(handler):
                data = bot.files[handler.path.rsplit("/", 1)[-1]]
                handler.send_response(200)
                handler.send_header("Content-Length", str(len(data)))
                handler.end_headers()
                handler.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        port = self.server.server_port

        class Opener:
            def open(self, req, timeout):
                local = Request(
                    f"http://127.0.0.1:{port}" + urlsplit(req.full_url).path,
                    data=req.data,
                    headers=dict(req.header_items()),
                )
                response = urlopen(local, timeout=timeout)
                # Preserve the upstream URL as a trusted TLS-forwarding fixture
                # would, so the production URL/redirect checks remain enabled.
                response.geturl = lambda: req.full_url
                return response

        self.factory = lambda token: Telegram(token, opener=Opener())

    def cli(self, *args, expected=0):
        stdout = io.StringIO()
        code = main(
            ["--config", str(self.path), *map(str, args)],
            api_factory=self.factory,
            stdin=io.StringIO(TOKEN),
            stdout=stdout,
            stderr=self.bot.stderr,
        )
        self.assertEqual(code, expected, self.bot.stderr.getvalue())
        self.assertNotIn(TOKEN, stdout.getvalue() + self.bot.stderr.getvalue())
        return json.loads(stdout.getvalue()) if stdout.getvalue() else None

    def test_pair_transport_restart_stop_and_fresh_session_isolation(self):
        self.cli("init", "--session-id", "actual-session", "--token-stdin")
        cfg = Config.load(self.path)
        self.assertEqual(
            [c["command"] for c in self.bot.commands[0]["commands"]],
            ["interrupt", "stop"],
        )
        self.assertEqual(self.bot.commands[0]["scope"], {"type": "chat", "chat_id": 7})
        self.bot.update("/stop", user=99)
        self.bot.update("intruder", chat=99)
        first = self.bot.update(
            "canonical request",
            photo=[
                {
                    "file_id": "image",
                    "width": 1,
                    "height": 1,
                    "file_size": len(self.bot.files["image"]),
                }
            ],
        )
        second = self.bot.update(
            "file request",
            document={"file_id": "file", "file_name": "original.bin", "file_size": 256},
        )
        with CollectorLock(cfg.bot_id), Store(self.root / "state.sqlite3") as store:
            relay = Service(cfg, store, self.factory(TOKEN))
            relay.step()
            self.assertEqual(store.status(cfg.binding_id)["requests"], {"pending": 2})
            request = self.cli("wait", "--timeout", "0")
            self.assertEqual(
                (request["request_id"], request["source"], request["session_id"]),
                (first, "telegram", "actual-session"),
            )
            self.assertEqual(
                Path(request["attachments"][0]["path"]).read_bytes(),
                self.bot.files["image"],
            )
            progress = self.root / "progress.txt"
            final = self.root / "final.txt"
            artifact = self.root / "report.bin"
            progress.write_text("**Working**\n", encoding="utf-8")
            final.write_text(
                "**Canonical**\n" + "all content \U0001f600\n" * 700 + "host footer\n",
                encoding="utf-8",
            )
            artifact.write_bytes(self.bot.files["file"])
            self.cli(
                "publish",
                "--request-id",
                first,
                "--source",
                "ui",
                "--kind",
                "final",
                "--text-file",
                final,
                expected=2,
            )
            self.assertEqual(store.outputs(cfg.binding_id), [])
            self.cli(
                "publish",
                "--request-id",
                first,
                "--source",
                "telegram",
                "--kind",
                "progress",
                "--text-file",
                progress,
            )
            self.cli(
                "publish",
                "--request-id",
                first,
                "--source",
                "telegram",
                "--kind",
                "final",
                "--text-file",
                final,
                "--file",
                artifact,
            )
            artifact.write_bytes(b"changed after durable snapshot")
            self.cli("complete", "--request-id", first)
            while any(
                row["state"] == "queued" for row in store.outputs(cfg.binding_id)
            ):
                relay.drain_one()
            text = [p for method, p in self.bot.sent if method == "sendMessage"]
            self.assertGreater(len(text), 2)
            self.assertEqual(
                "".join(p["text"] for p in text),
                "WorkingCanonical\n" + "all content \U0001f600\n" * 700 + "host footer",
            )
            self.assertTrue(any(p["entities"] for p in text))
            self.assertTrue(
                all(len(p["text"].encode("utf-16-le")) // 2 <= 4096 for p in text)
            )
            sent_file = self.bot.sent[-1][1]["document"]
            self.assertEqual(
                sent_file, {"name": "report.bin", "bytes": self.bot.files["file"]}
            )
            self.assertTrue(all(int(p["chat_id"]) == 7 for _, p in self.bot.sent))
        self.cli("bind", "--session-id", "actual-session", "--resume")
        self.assertEqual(Config.load(self.path).binding_id, cfg.binding_id)
        resumed = self.cli("wait", "--timeout", "0")
        self.assertEqual(resumed["request_id"], second)
        self.assertEqual(
            Path(resumed["attachments"][0]["path"]).read_bytes(), self.bot.files["file"]
        )
        with CollectorLock(cfg.bot_id), Store(self.root / "state.sqlite3") as store:
            relay = Service(cfg, store, self.factory(TOKEN))
            self.bot.update("pending work")
            relay.step()
            self.bot.update("/stop")
            relay.step()
            self.assertEqual(store.request(cfg.binding_id, second)["state"], "canceled")
            self.assertEqual(
                store.status(cfg.binding_id)["requests"],
                {"completed": 1, "canceled": 2},
            )
            self.assertTrue(store.binding(cfg.binding_id)["active"])
            self.assertIn("not confirmed", self.bot.sent[-1][1]["text"])
            old = self.bot.update("left on old binding")
            relay.step()
        self.cli("unbind")
        self.bot.update("between bindings")
        self.cli("bind", "--session-id", "new-actual-session")
        fresh = Config.load(self.path)
        self.assertNotEqual(fresh.binding_id, cfg.binding_id)
        self.cli("wait", "--timeout", "0", expected=3)
        with Store(self.root / "state.sqlite3") as store:
            self.assertFalse(store.binding(cfg.binding_id)["active"])
            self.assertEqual(store.request(cfg.binding_id, old)["state"], "canceled")
            self.assertIsNone(store.request(fresh.binding_id, old))
        self.cli("unbind")
