import unittest

try:
    from tgbridge.formatting import MAX_TEXT_UNITS, Chunk, render
except ImportError:
    render = None


def units(text):
    return len(text.encode("utf-16-le")) // 2


class FormattingTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(render, "formatting implementation is missing")

    def test_markdown_text_entities_and_links(self):
        chunks = render(
            "Hello **bold** *soft* ~~gone~~ `code` [site](https://example.com)."
        )
        self.assertEqual(len(chunks), 1)
        self.assertIsInstance(chunks[0], Chunk)
        self.assertEqual(chunks[0].text, "Hello bold soft gone code site.")
        entities = chunks[0].entities
        self.assertEqual(
            [e["type"] for e in entities],
            ["bold", "italic", "strikethrough", "code", "text_link"],
        )
        self.assertEqual(entities[-1]["url"], "https://example.com")
        self.assertEqual(entities[0], {"type": "bold", "offset": 6, "length": 4})

    def test_code_lists_heading_and_quote(self):
        text = "# Title\n\n- one\n- two\n\n> quote\n\n```python\nx = 1\n```\n"
        chunk = render(text)[0]
        self.assertIn("Title", chunk.text)
        self.assertIn("• one\n• two", chunk.text)
        self.assertIn("quote", chunk.text)
        self.assertIn("x = 1\n", chunk.text)
        self.assertIn("pre", [e["type"] for e in chunk.entities])
        self.assertIn("bold", [e["type"] for e in chunk.entities])

    def test_plain_preserves_all_content_including_html(self):
        text = "<b>literal</b> & **not bold**\n\n\n"
        chunks = render(text, mode="plain")
        self.assertEqual("".join(c.text for c in chunks), text)
        self.assertEqual(chunks[0].entities, [])
        self.assertEqual(
            render("<script>x & y</script>")[0].text, "<script>x & y</script>"
        )

    def test_plain_boundary_whitespace_is_preserved_in_sendable_chunks(self):
        cases = [
            "x" * 4096 + "\n",
            " " * 4095 + "xy",
            " " * 4095 + "X" + "Y" + " " * 4095,
            "\n" * 4095 + "xy",
            "x" * 4095 + "\n\n" + "y" * 4095,
            "x" + " " * 8190 + "y",
            "😀" * 2048 + "\n",
            " " * 4094 + "😀y",
            "x" * 4096 + "\n" * 4095,
        ]
        for text in cases:
            with self.subTest(length=len(text), prefix=repr(text[:3])):
                chunks = render(text, mode="plain")
                self.assertEqual("".join(chunk.text for chunk in chunks), text)
                self.assertTrue(all(chunk.text.strip() for chunk in chunks))
                self.assertTrue(
                    all(0 < units(chunk.text) <= MAX_TEXT_UNITS for chunk in chunks)
                )
                self.assertTrue(all(chunk.entities == [] for chunk in chunks))

    def test_fenced_boundary_whitespace_retains_exact_text_and_entity_spans(self):
        for content in (
            "x" * 4096 + "\n",
            "😀" * 2048 + "\n",
            " " * 4095 + "xy\n",
            "x" + "\n" * 8189 + "y\n",
        ):
            with self.subTest(length=len(content)):
                chunks = render("```python\n" + content + "```")
                self.assertEqual("".join(chunk.text for chunk in chunks), content)
                self.assertTrue(all(chunk.text.strip() for chunk in chunks))
                for chunk in chunks:
                    self.assertLessEqual(units(chunk.text), MAX_TEXT_UNITS)
                    self.assertEqual(
                        chunk.entities,
                        [
                            {
                                "type": "pre",
                                "offset": 0,
                                "length": units(chunk.text),
                                "language": "python",
                            }
                        ],
                    )

    def test_rebalanced_entities_keep_utf16_offsets_and_exact_coverage(self):
        content = " " * 4094 + "😀y\n"
        chunks = render("```\n" + content + "```\n\n**end😀**")
        expected = content + "\nend😀"
        self.assertEqual("".join(chunk.text for chunk in chunks), expected)
        offset = 0
        coverage = {"pre": [], "bold": []}
        for chunk in chunks:
            self.assertTrue(chunk.text.strip())
            length = units(chunk.text)
            self.assertLessEqual(length, MAX_TEXT_UNITS)
            for entity in chunk.entities:
                self.assertGreaterEqual(entity["offset"], 0)
                self.assertGreater(entity["length"], 0)
                self.assertLessEqual(entity["offset"] + entity["length"], length)
                start = offset + entity["offset"]
                coverage[entity["type"]].extend(range(start, start + entity["length"]))
            offset += length
        self.assertEqual(coverage["pre"], list(range(units(content))))
        self.assertEqual(
            coverage["bold"], list(range(units(content) + 1, units(expected)))
        )

    def test_unrepresentable_whitespace_requires_an_exact_byte_document(self):
        for text in (
            " ",
            "\t\r\n" * 2000,
            "x" + " " * 4096,
            " " * 4096 + "x",
            "x" + " " * 8191 + "y",
            "😀" + " " * 4095,
            "x" * 4096 + " " * 4097,
        ):
            with (
                self.subTest(length=len(text)),
                self.assertRaisesRegex(ValueError, "exact bytes.*document"),
            ):
                render(text, mode="plain")
        for text in (" \t\n", "```\n\n```", "```\nx" + " " * 4096 + "\n```"):
            with (
                self.subTest(markdown_length=len(text)),
                self.assertRaisesRegex(ValueError, "exact bytes.*document"),
            ):
                render(text)

    def test_images_and_unsupported_content_remain_visible(self):
        text = (
            "![chart](https://example.com/image.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |"
        )
        rendered = "".join(c.text for c in render(text))
        for expected in [
            "chart",
            "https://example.com/image.png",
            "| a | b |",
            "| 1 | 2 |",
        ]:
            self.assertIn(expected, rendered)

    def test_utf16_entity_offsets_and_chunk_clipping(self):
        chunk = render("😀 **bold😀**")[0]
        self.assertEqual(chunk.entities, [{"type": "bold", "offset": 3, "length": 6}])
        content = "😀" * 5000 + "tail"
        chunks = render("**" + content + "**")
        self.assertEqual("".join(c.text for c in chunks), content)
        self.assertTrue(all(0 < units(c.text) <= MAX_TEXT_UNITS for c in chunks))
        for chunk in chunks:
            self.assertEqual(
                chunk.entities,
                [{"type": "bold", "offset": 0, "length": units(chunk.text)}],
            )
        self.assertEqual(
            "".join(c.text for c in render(content, mode="plain")), content
        )

    def test_code_entities_do_not_overlap_outer_styles_or_links(self):
        chunk = render("**bold `code` tail** and [a `b`](https://example.com)")[0]
        self.assertEqual(chunk.text, "bold code tail and a b")
        for code in [e for e in chunk.entities if e["type"] in ("code", "pre")]:
            for other in chunk.entities:
                if other is code:
                    continue
                self.assertFalse(
                    max(code["offset"], other["offset"])
                    < min(
                        code["offset"] + code["length"],
                        other["offset"] + other["length"],
                    )
                )
        self.assertEqual(
            [
                chunk.text[e["offset"] : e["offset"] + e["length"]]
                for e in chunk.entities
                if e["type"] == "bold"
            ],
            ["bold ", " tail"],
        )

    def test_all_code_link_labels_preserve_destination_across_chunks(self):
        url = "https://example.com/path"
        for label in ("reference", "😀" * 3000):
            with self.subTest(label_length=len(label)):
                chunks = render("[`" + label + "`](" + url + ")")
                self.assertEqual("".join(chunk.text for chunk in chunks), label)
                for chunk in chunks:
                    self.assertLessEqual(units(chunk.text), MAX_TEXT_UNITS)
                    self.assertEqual(
                        chunk.entities,
                        [
                            {
                                "type": "text_link",
                                "offset": 0,
                                "length": units(chunk.text),
                                "url": url,
                            }
                        ],
                    )

    def test_nested_loose_lists_keep_marker_and_content_together(self):
        chunk = render("- parent\n  - child\n\n    more\n- next")[0]
        self.assertIn("• parent\n  • child", chunk.text)
        self.assertIn("more", chunk.text)
        self.assertIn("• next", chunk.text)

    def test_nested_blockquotes_do_not_create_nested_quote_entities(self):
        chunk = render("> outer\n>\n> > inner")[0]
        quotes = [e for e in chunk.entities if e["type"] == "blockquote"]
        self.assertEqual(len(quotes), 1)
        self.assertIn("outer", chunk.text)
        self.assertIn("inner", chunk.text)

    def test_empty_and_invalid_mode(self):
        self.assertEqual(render(""), [])
        with self.assertRaises(ValueError):
            render("x", mode="html")


if __name__ == "__main__":
    unittest.main()
