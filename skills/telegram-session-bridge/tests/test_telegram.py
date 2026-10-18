import io
import json
import tempfile
import threading
import unittest
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from tgbridge.telegram import (
        MAX_DOWNLOAD_BYTES,
        MAX_PHOTO_BYTES,
        MAX_UPLOAD_BYTES,
        Telegram,
        TelegramError,
    )
except ImportError:
    Telegram = None
    TelegramError = Exception

TOKEN = "123456789:" + "abcdefghijklmnopqrstuvwxyzABCDE123456"


class Response(io.BytesIO):
    def __init__(self, data, url=None, headers=None):
        super().__init__(data)
        self.url = url
        self.headers = headers or {}

    def geturl(self):
        return self.url


class Opener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, req, timeout):
        self.requests.append((req, timeout))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        if isinstance(result, dict):
            return Response(json.dumps(result).encode(), req.full_url)
        if result.url is None:
            result.url = req.full_url
        return result


class TelegramTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Telegram, "Telegram implementation is missing")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_real_local_http_result_and_bounded_timeout(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                body = handler.rfile.read(int(handler.headers["Content-Length"]))
                self.assertEqual(json.loads(body), {"offset": 10})
                handler.send_response(200)
                handler.end_headers()
                handler.wfile.write(b'{"ok":true,"result":[]}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        class LocalOpener:
            def open(_, req, timeout):
                self.assertEqual(timeout, 12)
                return urlopen(
                    Request(
                        f"http://127.0.0.1:{server.server_port}/",
                        data=req.data,
                        headers=dict(req.header_items()),
                    ),
                    timeout=timeout,
                )

        self.assertEqual(
            Telegram(TOKEN, timeout=12, opener=LocalOpener()).call(
                "getUpdates", {"offset": 10}
            ),
            [],
        )
        for timeout in (0, -1, 121, float("inf")):
            with self.assertRaises(ValueError):
                Telegram(TOKEN, timeout=timeout)

    def test_api_errors_sanitize_credentials_and_retry_after(self):
        for code in (401, 409, 429):
            opener = Opener(
                [
                    {
                        "ok": False,
                        "error_code": code,
                        "description": TOKEN,
                        "parameters": {"retry_after": 7},
                    }
                ]
            )
            with self.subTest(code=code), self.assertRaises(TelegramError) as caught:
                Telegram(TOKEN, opener=opener).call("getUpdates", {})
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(caught.exception.retry_after, 7)
            self.assertFalse(caught.exception.ambiguous)
            self.assertNotIn(TOKEN, repr(caught.exception))
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_malformed_api_failure_preserves_request_ambiguity(self):
        envelopes = [{"ok": False}] + [
            {"ok": False, "error_code": code}
            for code in (None, True, "401", 399, 600, {}, [])
        ]
        for method in ("sendMessage", "getMe"):
            for envelope in envelopes:
                with self.subTest(method=method, envelope=envelope):
                    with self.assertRaises(TelegramError) as caught:
                        Telegram(TOKEN, opener=Opener([envelope])).call(method, {})
                    self.assertEqual(caught.exception.code, "response")
                    self.assertEqual(
                        caught.exception.ambiguous, method == "sendMessage"
                    )

    def test_valid_api_rejections_remain_definite_for_sends(self):
        for code in (401, 409, 429):
            with self.subTest(code=code), self.assertRaises(TelegramError) as caught:
                Telegram(
                    TOKEN, opener=Opener([{"ok": False, "error_code": code}])
                ).call("sendMessage", {})
            self.assertEqual(caught.exception.code, code)
            self.assertFalse(caught.exception.ambiguous)

    def test_http_and_network_failures_are_safe_and_sends_ambiguous(self):
        for error in (
            URLError("https://api.telegram.org/bot" + TOKEN),
            TimeoutError(TOKEN),
            HTTPError(
                "https://api.telegram.org/bot" + TOKEN,
                503,
                TOKEN,
                {},
                io.BytesIO(b"bad"),
            ),
        ):
            with (
                self.subTest(error=type(error).__name__),
                self.assertRaises(TelegramError) as caught,
            ):
                Telegram(TOKEN, opener=Opener([error])).call(
                    "sendMessage", {"text": "x"}
                )
            self.assertTrue(caught.exception.ambiguous)
            self.assertNotIn(TOKEN, str(caught.exception))
            self.assertIsNone(caught.exception.__cause__)
        error = HTTPError("secret", 401, TOKEN, {}, io.BytesIO(b"bad"))
        with self.assertRaises(TelegramError) as caught:
            Telegram(TOKEN, opener=Opener([error])).call("getMe", {})
        self.assertEqual(caught.exception.code, 401)
        self.assertFalse(caught.exception.ambiguous)

    def test_refused_redirects_are_durable_and_preserve_request_ambiguity(self):
        path = self.root / "fixture.bin"
        path.write_bytes(b"synthetic document")
        for code in (301, 302, 303, 307, 308):
            for body in (b"", b"not JSON"):
                for multipart in (False, True):
                    for read in (False, True):
                        with self.subTest(
                            code=code, body=body, multipart=multipart, read=read
                        ):
                            error = HTTPError(
                                "https://example.invalid/original",
                                code,
                                "refused",
                                {"Location": "https://example.invalid/redirected"},
                                io.BytesIO(body),
                            )
                            opener = Opener([error])
                            method = (
                                "getMe"
                                if read
                                else ("sendDocument" if multipart else "sendMessage")
                            )
                            with self.assertRaises(TelegramError) as caught:
                                Telegram(TOKEN, opener=opener).call(
                                    method,
                                    {"chat_id": 7, "text": "fixture"},
                                    files={"document": path} if multipart else None,
                                )
                            self.assertEqual(caught.exception.code, "redirect")
                            self.assertEqual(caught.exception.ambiguous, not read)
                            self.assertIsNone(caught.exception.retry_after)
                            self.assertNotIn("example.invalid", str(caught.exception))
                            self.assertEqual(len(opener.requests), 1)

    def test_redirect_envelopes_cannot_override_refused_redirects(self):
        for payload in (
            {"ok": True, "result": {"message_id": 1}},
            {"ok": False, "error_code": 429},
        ):
            error = HTTPError(
                "https://example.invalid/",
                302,
                "refused",
                {},
                io.BytesIO(json.dumps(payload).encode()),
            )
            with self.subTest(payload=payload):
                with self.assertRaises(TelegramError) as caught:
                    Telegram(TOKEN, opener=Opener([error])).call("sendMessage", {})
                self.assertEqual(caught.exception.code, "redirect")
                self.assertTrue(caught.exception.ambiguous)

    def test_unexpected_http_statuses_have_durable_response_codes(self):
        for code in (100, 199, 200, 204, 299, 600, 999):
            for method in ("getMe", "sendMessage"):
                with self.subTest(code=code, method=method):
                    error = HTTPError(
                        "https://example.invalid/",
                        code,
                        "unexpected",
                        {},
                        io.BytesIO(b"not JSON"),
                    )
                    opener = Opener([error])
                    with self.assertRaises(TelegramError) as caught:
                        Telegram(TOKEN, opener=opener).call(method, {})
                    self.assertEqual(caught.exception.code, "response")
                    self.assertEqual(
                        caught.exception.ambiguous, method == "sendMessage"
                    )
                    self.assertEqual(len(opener.requests), 1)

    def test_redirect_handler_never_forwards_get_or_post(self):
        from tgbridge.telegram import _NoRedirects

        for code in (301, 302, 303, 307, 308):
            for data in (None, b"synthetic request"):
                with self.subTest(code=code, post=data is not None):
                    request = Request("https://example.invalid/", data=data)
                    self.assertIsNone(
                        _NoRedirects().redirect_request(
                            request,
                            None,
                            code,
                            "refused",
                            {},
                            "https://example.invalid/redirected",
                        )
                    )

    def test_multipart_preserves_original_bytes(self):
        path = self.root / "file.bin"
        original = b"\x00\xff\r\noriginal\x80"
        path.write_bytes(original)
        opener = Opener([{"ok": True, "result": {"message_id": 1}}])
        result = Telegram(TOKEN, opener=opener).call(
            "sendDocument", {"chat_id": 7}, files={"document": path}
        )
        self.assertEqual(result["message_id"], 1)
        req, _timeout = opener.requests[0]
        self.assertIn(original, req.data)
        self.assertIn(b'name="document"; filename="file.bin"', req.data)
        self.assertIn("multipart/form-data", req.get_header("Content-type"))
        self.assertEqual(path.read_bytes(), original)

    def test_upload_limits_before_network(self):
        for method, field, limit in [
            ("sendDocument", "document", MAX_UPLOAD_BYTES),
            ("sendPhoto", "photo", MAX_PHOTO_BYTES),
        ]:
            path = self.root / "large"
            with path.open("wb") as f:
                f.truncate(limit + 1)
            opener = Opener([])
            with self.subTest(method=method), self.assertRaises(TelegramError):
                Telegram(TOKEN, opener=opener).call(method, {}, {field: path})
            self.assertEqual(opener.requests, [])
        link = self.root / "link"
        link.symlink_to(path)
        with self.assertRaises(TelegramError):
            Telegram(TOKEN, opener=Opener([])).call(
                "sendDocument", {}, {"document": link}
            )

    def test_photo_limit_applies_to_named_multipart_attachment(self):
        path = self.root / "large-photo"
        with path.open("wb") as handle:
            handle.truncate(MAX_PHOTO_BYTES + 1)
        opener = Opener([{"ok": True, "result": {"message_id": 1}}])
        with self.assertRaises(TelegramError):
            Telegram(TOKEN, opener=opener).call(
                "sendPhoto", {"photo": "attach://upload"}, {"upload": path}
            )
        self.assertEqual(opener.requests, [])

    def test_media_descriptor_photos_use_photo_limit_before_network(self):
        path = self.root / "photo.jpg"
        with path.open("wb") as handle:
            handle.truncate(MAX_PHOTO_BYTES + 1)
        descriptor = {"type": "photo", "media": "attach://upload"}
        for method in ("sendMediaGroup", "editMessageMedia"):
            media = [descriptor] if method == "sendMediaGroup" else descriptor
            for serialize in (False, True):
                opener = Opener([{"ok": True, "result": {"message_id": 1}}])
                params = {"media": json.dumps(media) if serialize else media}
                with self.subTest(method=method, serialize=serialize):
                    with self.assertRaises(TelegramError) as caught:
                        Telegram(TOKEN, opener=opener).call(
                            method, params, {"upload": path}
                        )
                    self.assertEqual(caught.exception.code, "size")
                    self.assertFalse(caught.exception.ambiguous)
                    self.assertEqual(opener.requests, [])

    def test_document_media_descriptor_retains_generic_upload_limit(self):
        path = self.root / "document.bin"
        with path.open("wb") as handle:
            handle.truncate(MAX_PHOTO_BYTES + 1)
        opener = Opener([{"ok": True, "result": {"message_id": 1}}])
        result = Telegram(TOKEN, opener=opener).call(
            "sendMediaGroup",
            {
                "media": [{"type": "document", "media": "attach://upload"}],
            },
            {"upload": path},
        )
        self.assertEqual(result, {"message_id": 1})
        self.assertEqual(len(opener.requests), 1)

    def test_invalid_serialized_media_is_rejected_before_network(self):
        path = self.root / "photo.jpg"
        path.write_bytes(b"original")
        opener = Opener([{"ok": True, "result": {"message_id": 1}}])
        with self.assertRaises(TelegramError) as caught:
            Telegram(TOKEN, opener=opener).call(
                "sendMediaGroup", {"media": "[invalid"}, {"upload": path}
            )
        self.assertEqual(caught.exception.code, "parameters")
        self.assertEqual(opener.requests, [])

    def test_download_original_bytes_and_metadata_limit(self):
        data = b"\x00\xfforiginal"
        path = self.root / "incoming.bin"
        opener = Opener(
            [
                {
                    "ok": True,
                    "result": {
                        "file_path": "documents/file.bin",
                        "file_size": len(data),
                    },
                },
                Response(data),
            ]
        )
        self.assertEqual(Telegram(TOKEN, opener=opener).download("file-id", path), path)
        self.assertEqual(path.read_bytes(), data)
        opener = Opener(
            [
                {
                    "ok": True,
                    "result": {
                        "file_path": "documents/large.bin",
                        "file_size": MAX_DOWNLOAD_BYTES + 1,
                    },
                }
            ]
        )
        with self.assertRaises(TelegramError):
            Telegram(TOKEN, opener=opener).download("file-id", path)
        self.assertEqual(path.read_bytes(), data)
        self.assertEqual(len(opener.requests), 1)

    def test_download_rejects_paths_and_redirects(self):
        for file_path in (
            "../secret",
            "/etc/passwd",
            "https://evil.example/x",
            "documents/%2e%2e/x",
            "documents/x?token=x",
            "documents\\x",
        ):
            opener = Opener([{"ok": True, "result": {"file_path": file_path}}])
            with self.subTest(file_path=file_path), self.assertRaises(TelegramError):
                Telegram(TOKEN, opener=opener).download("id", self.root / "incoming")
            self.assertEqual(len(opener.requests), 1)
        opener = Opener(
            [
                {"ok": True, "result": {"file_path": "docs/a"}},
                Response(b"x", "https://evil.example/file"),
            ]
        )
        with self.assertRaises(TelegramError):
            Telegram(TOKEN, opener=opener).download("id", self.root / "incoming")
        self.assertFalse((self.root / "incoming").exists())
        target = self.root / "original"
        target.write_text("safe")
        link = self.root / "link"
        link.symlink_to(target)
        with self.assertRaises(TelegramError):
            Telegram(TOKEN, opener=Opener([])).download("id", link)
        self.assertEqual(target.read_text(), "safe")

    def test_streaming_limit_and_failure_preserve_existing_file(self):
        target = self.root / "original"
        target.write_bytes(b"keep")
        for response in (
            Response(b"x" * (MAX_DOWNLOAD_BYTES + 1)),
            Response(b"x", headers={"Content-Length": str(MAX_DOWNLOAD_BYTES + 1)}),
        ):
            opener = Opener([{"ok": True, "result": {"file_path": "docs/a"}}, response])
            with self.assertRaises(TelegramError):
                Telegram(TOKEN, opener=opener).download("id", target)
            self.assertEqual(target.read_bytes(), b"keep")
            self.assertEqual(list(self.root.iterdir()), [target])

    def test_partial_http_read_is_safe_and_ambiguous_for_send(self):
        class Broken(Response):
            def read(self, size=-1):
                raise IncompleteRead(TOKEN.encode(), 10)

        try:
            Telegram(TOKEN, opener=Opener([Broken(b"")])).call("sendMessage", {})
        except TelegramError as error:
            self.assertTrue(error.ambiguous)
            self.assertNotIn(TOKEN, str(error))
        except IncompleteRead as error:
            self.fail(f"Unsanitized exception type: {type(error).__name__}")
        else:
            self.fail("Expected a safe transport failure")

    def test_invalid_response_is_ambiguous_for_send(self):
        for response in (Response(b"garbage"), {"ok": True}, Response(b"[]")):
            with (
                self.subTest(response=type(response).__name__),
                self.assertRaises(TelegramError) as caught,
            ):
                Telegram(TOKEN, opener=Opener([response])).call("sendMessage", {})
            self.assertTrue(caught.exception.ambiguous)
        with self.assertRaises(ValueError):
            Telegram("invalid")
        with self.assertRaises(TelegramError):
            Telegram(TOKEN, opener=Opener([])).call("../bad", {})


if __name__ == "__main__":
    unittest.main()
