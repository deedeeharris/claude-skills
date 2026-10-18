"""Filter private-owner updates and normalize ordinary message content."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any, Literal, TypedDict

__all__ = ["Attachment", "NormalizedMessage", "authorized_message", "parse_message"]


class Attachment(TypedDict):
    file_id: str
    name: str
    mime_type: str
    size: int | None


class NormalizedMessage(TypedDict):
    kind: Literal["task", "interrupt", "stop", "help", "status"]
    text: str
    attachments: list[Attachment]


def authorized_message(
    update: dict[str, Any], chat_id: int, user_id: int
) -> dict[str, Any] | None:
    if (
        type(chat_id) is not int
        or type(user_id) is not int
        or chat_id <= 0
        or user_id <= 0
    ):
        return None
    if not isinstance(update, dict):
        return None
    message = update.get("message")
    if not isinstance(message, dict) or message.get("sender_chat") is not None:
        return None
    chat, sender = message.get("chat"), message.get("from")
    if not isinstance(chat, dict) or not isinstance(sender, dict):
        return None
    if (
        chat.get("type") == "private"
        and type(chat.get("id")) is int
        and type(sender.get("id")) is int
        and chat["id"] == chat_id
        and sender["id"] == user_id
    ):
        return message
    return None


def _attachment(
    data: dict[str, Any], default_name: str, default_mime: str
) -> Attachment | None:
    file_id = data.get("file_id")
    if not isinstance(file_id, str) or not file_id:
        return None
    filename = data.get("file_name")
    if not isinstance(filename, str):
        filename = default_name
    filename = PurePosixPath(filename.replace("\\", "/")).name
    filename = "".join(c for c in filename if ord(c) >= 32 and c != "\x7f")
    if filename in ("", ".", ".."):
        filename = default_name
    size = data.get("file_size")
    if type(size) is not int or size < 0:
        size = None
    mime = data.get("mime_type")
    return {
        "file_id": file_id,
        "name": filename,
        "mime_type": mime if isinstance(mime, str) else default_mime,
        "size": size,
    }


def parse_message(
    message: dict[str, Any], bot_username: str
) -> NormalizedMessage | None:
    if not isinstance(message, dict):
        return None
    text = message.get("text", message.get("caption", ""))
    if not isinstance(text, str):
        text = ""
    attachments: list[Attachment] = []
    media = [
        ("document", "attachment.bin", "application/octet-stream"),
        ("voice", "voice.ogg", "audio/ogg"),
        ("audio", "audio.bin", "application/octet-stream"),
        ("video", "video.mp4", "video/mp4"),
        ("animation", "animation.bin", "application/octet-stream"),
        ("sticker", "sticker.bin", "application/octet-stream"),
        ("video_note", "video-note.mp4", "video/mp4"),
    ]
    for key, name, mime in media:
        if isinstance(message.get(key), dict):
            item = _attachment(message[key], name, mime)
            if item is not None:
                attachments.append(item)
    photos = message.get("photo")
    if isinstance(photos, list):
        valid = [
            p
            for p in photos
            if isinstance(p, dict) and isinstance(p.get("file_id"), str)
        ]
        if valid:
            item = _attachment(valid[-1], "photo.jpg", "image/jpeg")
            if item is not None:
                attachments.append(item)
    if not text and not attachments:
        return None
    kind = "task"
    command = re.match(
        r"^/([A-Za-z_]+)(?:@([A-Za-z0-9_]+))?(?=\s|$)(?:\s+(.*))?$", text, re.DOTALL
    )
    if command:
        name, addressed_bot, args = command.groups()
        if addressed_bot and addressed_bot.casefold() != bot_username.casefold().lstrip(
            "@"
        ):
            return None
        args = (args or "").strip()
        if name == "interrupt":
            kind, text = ("interrupt", args) if args else ("help", "")
        elif name == "stop":
            kind, text = ("help", "") if args else ("stop", "")
        elif name in ("help", "start", "status"):
            kind, text = ("status" if name == "status" else "help"), ""
    return {"kind": kind, "text": text, "attachments": attachments}
