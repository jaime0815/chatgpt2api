from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any, Protocol

from services.chat_types import ChatAttachmentBlob


class _ChatAttachmentBackend(Protocol):
    def upload_chat_attachment_bytes(
        self,
        data: bytes,
        file_name: str,
        mime_type: str,
        kind: str,
    ) -> dict[str, Any]: ...


class ChatAttachmentUploader:
    """Upload multipart chat attachments through the selected Web backend."""

    def resolve(
        self,
        backend: _ChatAttachmentBackend,
        attachments: tuple[ChatAttachmentBlob, ...],
    ) -> Mapping[str, dict[str, Any]]:
        resolved: dict[str, dict[str, Any]] = {}
        for attachment in attachments:
            digest = hashlib.sha256(attachment.data).hexdigest()
            if digest != attachment.sha256:
                raise RuntimeError("chat attachment integrity check failed")
            resolved[attachment.id] = backend.upload_chat_attachment_bytes(
                attachment.data,
                attachment.file_name,
                attachment.mime_type,
                attachment.kind,
            )
        return resolved
