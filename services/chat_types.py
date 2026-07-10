from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class ChatAttachmentBlob:
    id: str
    file_name: str
    mime_type: str
    size: int
    sha256: str
    kind: Literal["image", "document"]
    data: bytes


@dataclass(frozen=True, slots=True)
class ChatMessage:
    id: str
    role: str
    text: str
    attachment_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ChatStreamCommand:
    model: str
    messages: tuple[ChatMessage, ...]
    attachments: tuple[ChatAttachmentBlob, ...]
    thinking_effort: str
