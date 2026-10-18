import unittest

try:
    from tgbridge.messages import authorized_message, parse_message
except ImportError:
    authorized_message = parse_message = None


class MessageTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(authorized_message, "message implementation is missing")

    def update(self, **kwargs):
        msg = {"chat": {"id": 7, "type": "private"}, "from": {"id": 7}, "text": "hello"}
        msg.update(kwargs)
        return {"update_id": 1, "message": msg}

    def test_owner_filter(self):
        update = self.update()
        self.assertIs(authorized_message(update, 7, 7), update["message"])
        for kwargs in (
            {"chat": {"id": 7, "type": "group"}},
            {"chat": {"id": 8, "type": "private"}},
            {"from": {"id": 8}},
            {"from": {"id": True}},
            {"sender_chat": {"id": 7}},
        ):
            self.assertIsNone(authorized_message(self.update(**kwargs), 7, 7))
        for update in (
            {"edited_message": self.update()["message"]},
            {},
            {"message": None},
            {"channel_post": self.update()["message"]},
        ):
            self.assertIsNone(authorized_message(update, 7, 7))

    def test_owner_filter_rejects_malformed_configured_ids(self):
        self.assertIsNone(
            authorized_message(
                self.update(
                    **{"chat": {"id": 1, "type": "private"}, "from": {"id": 1}}
                ),
                True,
                True,
            )
        )

    def test_control_commands_and_bot_mentions(self):
        cases = [
            ("hi", "task", "hi"),
            ("/interrupt do it", "interrupt", "do it"),
            ("/interrupt", "help", ""),
            ("/stop", "stop", ""),
            ("/stop now", "help", ""),
            ("/help", "help", ""),
            ("/status", "status", ""),
            ("/interrupt@Example_bot work", "interrupt", "work"),
        ]
        for text, kind, result_text in cases:
            with self.subTest(text=text):
                result = parse_message({"text": text}, "example_bot")
                self.assertEqual(
                    result, {"kind": kind, "text": result_text, "attachments": []}
                )
        self.assertIsNone(parse_message({"text": "/stop@other_bot"}, "example_bot"))
        self.assertEqual(
            parse_message({"text": "/unknown hi"}, "example_bot")["text"], "/unknown hi"
        )

    def test_media_caption_and_original_file_metadata(self):
        result = parse_message(
            {
                "caption": "look",
                "document": {
                    "file_id": "abc",
                    "file_name": "data.bin",
                    "mime_type": "application/octet-stream",
                    "file_size": 5,
                },
            },
            "bot",
        )
        self.assertEqual(
            result,
            {
                "kind": "task",
                "text": "look",
                "attachments": [
                    {
                        "file_id": "abc",
                        "name": "data.bin",
                        "mime_type": "application/octet-stream",
                        "size": 5,
                    }
                ],
            },
        )
        for kind, mime in [
            ("voice", "audio/ogg"),
            ("audio", "application/octet-stream"),
            ("video", "video/mp4"),
            ("animation", "application/octet-stream"),
            ("sticker", "application/octet-stream"),
        ]:
            with self.subTest(kind=kind):
                record = parse_message({kind: {"file_id": "abc"}}, "bot")[
                    "attachments"
                ][0]
                self.assertEqual(record["size"], None)
                self.assertEqual(record["file_id"], "abc")
                self.assertEqual(record["mime_type"], mime)
        result = parse_message(
            {
                "photo": [
                    {"file_id": "small", "width": 1, "height": 1},
                    {"file_id": "large", "width": 100, "height": 100},
                ]
            },
            "bot",
        )
        self.assertEqual(result["attachments"][0]["file_id"], "large")
        self.assertEqual(result["attachments"][0]["mime_type"], "image/jpeg")

    def test_unsupported_messages_and_pathlike_names(self):
        self.assertIsNone(parse_message({"location": {"latitude": 1}}, "bot"))
        self.assertIsNone(parse_message({}, "bot"))
        result = parse_message(
            {"document": {"file_id": "f", "file_name": "../../bad.bin"}}, "bot"
        )
        self.assertEqual(result["attachments"][0]["name"], "bad.bin")


if __name__ == "__main__":
    unittest.main()
