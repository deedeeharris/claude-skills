"""Deterministic Markdown-to-Telegram text/entities, measured in UTF-16."""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from markdown_it import MarkdownIt

__all__ = ["MAX_TEXT_UNITS", "Chunk", "render"]
MAX_TEXT_UNITS = 4096
_UNREPRESENTABLE_TEXT = (
    "Text cannot fit nonblank Telegram messages; send the exact bytes as a document."
)


@dataclass
class Chunk:
    text: str
    entities: list[dict[str, Any]] = field(default_factory=list)


def _units(text: str) -> int:
    return sum(2 if ord(c) > 0xFFFF else 1 for c in text)


class _Renderer:
    def __init__(self) -> None:
        self.parts: list[str] = []
        self.length = 0
        self.entities: list[dict[str, Any]] = []

    def add(self, text: str) -> None:
        self.parts.append(text)
        self.length += _units(text)

    def separator(self, count: int = 2) -> None:
        if self.parts:
            text = "".join(self.parts)
            trailing = len(text) - len(text.rstrip("\n"))
            self.add("\n" * max(0, count - trailing))

    def entity(self, kind: str, start: int, **extra: Any) -> None:
        if self.length > start:
            if kind == "blockquote":
                # Telegram does not permit nested quote entities. An enclosing
                # quote keeps the same visible content with a single span.
                self.entities = [
                    entity
                    for entity in self.entities
                    if not (
                        entity["type"] == "blockquote"
                        and start <= entity["offset"]
                        and entity["offset"] + entity["length"] <= self.length
                    )
                ]
            self.entities.append(
                dict(type=kind, offset=start, length=self.length - start, **extra)
            )

    def inline(self, tokens: list[Any]) -> None:
        stack: list[tuple[str, int, dict[str, Any]]] = []
        pairs = {
            "strong_open": "bold",
            "em_open": "italic",
            "s_open": "strikethrough",
            "link_open": "text_link",
        }
        for token in tokens:
            kind = token.type
            if kind in pairs:
                extra: dict[str, Any] = {}
                entity_kind = pairs[kind]
                if kind == "link_open":
                    url = token.attrGet("href") or ""
                    if urlsplit(url).scheme.lower() not in (
                        "http",
                        "https",
                        "mailto",
                        "tg",
                    ):
                        entity_kind = ""
                    extra["url"] = url
                stack.append((entity_kind, self.length, extra))
            elif kind in ("strong_close", "em_close", "s_close", "link_close"):
                if stack:
                    entity_kind, start, extra = stack.pop()
                    if entity_kind:
                        self.entity(entity_kind, start, **extra)
                    elif extra.get("url"):
                        self.add(" (" + extra["url"] + ")")
            elif kind == "code_inline":
                start = self.length
                self.add(token.content)
                self.entity("code", start)
            elif kind in ("softbreak", "hardbreak"):
                self.add("\n")
            elif kind == "image":
                self.add(
                    (token.content or "image")
                    + " ("
                    + (token.attrGet("src") or "")
                    + ")"
                )
            elif token.children:
                self.inline(token.children)
            else:
                self.add(token.content)

    def blocks(self, tokens: list[Any]) -> None:
        lists: list[dict[str, Any]] = []
        starts: list[tuple[str, int]] = []
        for token in tokens:
            kind = token.type
            if kind == "paragraph_open":
                marker_pending = (
                    lists
                    and self.parts
                    and re.fullmatch(r" *(?:• |[0-9]+\. )", self.parts[-1])
                )
                if not token.hidden and not marker_pending:
                    self.separator()
            elif kind == "inline":
                self.inline(token.children or [])
            elif kind == "heading_open":
                self.separator()
                starts.append(("bold", self.length))
            elif kind == "heading_close":
                entity_kind, start = starts.pop()
                self.entity(entity_kind, start)
            elif kind in ("fence", "code_block"):
                self.separator()
                start = self.length
                self.add(token.content)
                extra = (
                    {"language": token.info.strip().split()[0]}
                    if token.info.strip()
                    else {}
                )
                self.entity("pre", start, **extra)
            elif kind in ("bullet_list_open", "ordered_list_open"):
                if not lists:
                    self.separator()
                lists.append(
                    {
                        "ordered": kind == "ordered_list_open",
                        "number": int(token.attrGet("start") or 1),
                    }
                )
            elif kind in ("bullet_list_close", "ordered_list_close"):
                lists.pop()
            elif kind == "list_item_open":
                self.separator(1)
                current = lists[-1]
                prefix = str(current["number"]) + ". " if current["ordered"] else "• "
                current["number"] += 1
                self.add("  " * (len(lists) - 1) + prefix)
            elif kind == "blockquote_open":
                self.separator()
                starts.append(("blockquote", self.length))
            elif kind == "blockquote_close":
                entity_kind, start = starts.pop()
                self.entity(entity_kind, start)
            elif kind == "hr":
                self.separator()
                self.add("---")
            elif token.content:
                self.separator()
                self.add(token.content)


def render(text: str, mode: str = "markdown") -> list[Chunk]:
    """Preserve content in sendable chunks, or require an exact-byte document."""
    if mode not in ("markdown", "plain"):
        raise ValueError("Unknown rendering mode")
    if text and not text.strip():
        raise ValueError(_UNREPRESENTABLE_TEXT)
    entities: list[dict[str, Any]] = []
    if mode == "markdown":
        parser = MarkdownIt("commonmark", {"html": False}).enable("strikethrough")
        renderer = _Renderer()
        renderer.blocks(parser.parse(text))
        text = "".join(renderer.parts)
        # Telegram forbids code/pre inside other entities. Links take priority:
        # dropping incompatible code styling preserves their destination even
        # when code covers the entire label. Other styles split around code.
        links = [
            entity for entity in renderer.entities if entity["type"] == "text_link"
        ]
        renderer.entities = [
            entity
            for entity in renderer.entities
            if entity["type"] not in ("code", "pre")
            or not any(
                max(entity["offset"], link["offset"])
                < min(
                    entity["offset"] + entity["length"], link["offset"] + link["length"]
                )
                for link in links
            )
        ]
        code_spans = [e for e in renderer.entities if e["type"] in ("code", "pre")]
        compatible = []
        for entity in renderer.entities:
            spans = [(entity["offset"], entity["offset"] + entity["length"])]
            if entity["type"] not in ("code", "pre"):
                for code in code_spans:
                    left, right = code["offset"], code["offset"] + code["length"]
                    remainder = []
                    for start, end in spans:
                        if end <= left or start >= right:
                            remainder.append((start, end))
                        else:
                            if start < left:
                                remainder.append((start, left))
                            if end > right:
                                remainder.append((right, end))
                    spans = remainder
            compatible.extend(
                dict(entity, offset=start, length=end - start) for start, end in spans
            )
        entities = sorted(
            compatible, key=lambda e: (e["offset"], -e["length"], e["type"])
        )
    # Work backwards to find the furthest cut with a representable suffix.
    # A greedy cut can strand whitespace even when a valid partition exists.
    # The deque contains feasible suffix starts in descending character order,
    # with their UTF-16 distance from the end, so the scan stays linear.
    ends = [0] * (len(text) + 1)
    viable = deque([(len(text), 0)])
    suffix_units = 0
    next_visible = len(text)
    for index in range(len(text) - 1, -1, -1):
        suffix_units += 2 if ord(text[index]) > 0xFFFF else 1
        if not text[index].isspace():
            next_visible = index
        while viable and suffix_units - viable[0][1] > MAX_TEXT_UNITS:
            viable.popleft()
        if viable and viable[0][0] > next_visible:
            ends[index] = viable[0][0]
            viable.append((index, suffix_units))
    if text and not ends[0]:
        raise ValueError(_UNREPRESENTABLE_TEXT)
    chunks: list[Chunk] = []
    cursor = start_units = 0
    while cursor < len(text):
        end = ends[cursor]
        # Prefer a readable break without losing whitespace or making tiny parts.
        if end < len(text):
            break_at = text.rfind("\n", cursor, end)
            if break_at < cursor + (end - cursor) // 2:
                break_at = text.rfind(" ", cursor, end)
            if (
                break_at >= cursor + (end - cursor) // 2
                and ends[break_at + 1]
                and text[cursor : break_at + 1].strip()
            ):
                end = break_at + 1
        length = _units(text[cursor:end])
        clipped = []
        for entity in entities:
            left = max(entity["offset"], start_units)
            right = min(entity["offset"] + entity["length"], start_units + length)
            if right > left:
                clipped.append(
                    dict(entity, offset=left - start_units, length=right - left)
                )
        chunks.append(Chunk(text[cursor:end], clipped))
        cursor, start_units = end, start_units + length
    return chunks
