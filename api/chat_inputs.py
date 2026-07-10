from __future__ import annotations

import hashlib
import json
import re
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Literal, NoReturn

from fastapi import HTTPException, Request
from starlette.datastructures import FormData, UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from services.chat_types import ChatAttachmentBlob, ChatMessage, ChatStreamCommand


MIB = 1024 * 1024
MAX_IMAGES_PER_MESSAGE = 10
MAX_DOCUMENTS_PER_MESSAGE = 5
MAX_IMAGE_BYTES = 10 * MIB
MAX_DOCUMENT_BYTES = 25 * MIB
MAX_MESSAGE_ATTACHMENT_BYTES = 50 * MIB
MAX_REQUEST_WORKING_SET_BYTES = 100 * MIB
MAX_MULTIPART_REQUEST_BYTES = MAX_REQUEST_WORKING_SET_BYTES + 2 * MIB
MAX_REQUEST_JSON_BYTES = MIB
MAX_MULTIPART_FILES = 1000
READ_CHUNK_BYTES = MIB
MULTIPART_REQUEST_LIMIT_ERROR = "multipart request exceeds 102MB limit"

AttachmentKind = Literal["image", "document"]

SUPPORTED_ATTACHMENT_TYPES: dict[str, tuple[frozenset[str], AttachmentKind]] = {
    ".png": (frozenset({"image/png"}), "image"),
    ".jpeg": (frozenset({"image/jpeg"}), "image"),
    ".jpg": (frozenset({"image/jpeg"}), "image"),
    ".webp": (frozenset({"image/webp"}), "image"),
    ".gif": (frozenset({"image/gif"}), "image"),
    ".pdf": (frozenset({"application/pdf"}), "document"),
    ".docx": (
        frozenset({"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}),
        "document",
    ),
    ".xlsx": (
        frozenset({"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),
        "document",
    ),
    ".pptx": (
        frozenset({"application/vnd.openxmlformats-officedocument.presentationml.presentation"}),
        "document",
    ),
    ".txt": (frozenset({"text/plain"}), "document"),
    ".md": (frozenset({"text/markdown"}), "document"),
    ".csv": (frozenset({"text/csv"}), "document"),
}


@dataclass(frozen=True, slots=True)
class _AttachmentManifest:
    id: str
    file_name: str
    mime_type: str
    size: int
    sha256: str
    kind: AttachmentKind


class _MultipartRequestTooLarge(MultiPartException):
    pass


def _bad_request(message: str) -> NoReturn:
    raise HTTPException(status_code=400, detail={"error": message})


def _request_too_large() -> NoReturn:
    raise HTTPException(status_code=413, detail={"error": MULTIPART_REQUEST_LIMIT_ERROR})


def _required_string(value: object, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        _bad_request(f"{field} must be a string")
    if not allow_empty and not value.strip():
        _bad_request(f"{field} must not be empty")
    return value


def _normalize_mime_type(value: str) -> str:
    return value.split(";", 1)[0].strip().lower()


def _attachment_kind(file_name: str, mime_type: str) -> AttachmentKind:
    dot = file_name.rfind(".")
    extension = file_name[dot:].lower() if dot >= 0 else ""
    rule = SUPPORTED_ATTACHMENT_TYPES.get(extension)
    if rule is None:
        _bad_request(f"unsupported attachment type: {file_name}")
    allowed_mime_types, kind = rule
    if mime_type not in allowed_mime_types:
        _bad_request(f"attachment MIME type does not match file extension: {file_name}")
    return kind


def _parse_manifest(value: object, index: int) -> _AttachmentManifest:
    if not isinstance(value, dict):
        _bad_request(f"attachments[{index}] must be an object")
    attachment_id = _required_string(value.get("id"), f"attachments[{index}].id")
    file_name = _required_string(value.get("file_name"), f"attachments[{index}].file_name")
    mime_type = _normalize_mime_type(
        _required_string(value.get("mime_type"), f"attachments[{index}].mime_type")
    )
    size = value.get("size")
    if type(size) is not int or size < 0:
        _bad_request(f"attachments[{index}].size must be a non-negative integer")
    sha256 = _required_string(value.get("sha256"), f"attachments[{index}].sha256").lower()
    if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
        _bad_request(f"attachments[{index}].sha256 must be a SHA-256 hex digest")
    kind = _attachment_kind(file_name, mime_type)
    limit = MAX_IMAGE_BYTES if kind == "image" else MAX_DOCUMENT_BYTES
    if size > limit:
        label = "image exceeds 10MB" if kind == "image" else "document exceeds 25MB"
        _bad_request(f"{label}: {file_name}")
    return _AttachmentManifest(
        id=attachment_id,
        file_name=file_name,
        mime_type=mime_type,
        size=size,
        sha256=sha256,
        kind=kind,
    )


def _parse_message(value: object, index: int) -> ChatMessage:
    if not isinstance(value, dict):
        _bad_request(f"messages[{index}] must be an object")
    message_id = _required_string(value.get("id"), f"messages[{index}].id")
    role = _required_string(value.get("role"), f"messages[{index}].role")
    text = _required_string(value.get("text"), f"messages[{index}].text", allow_empty=True)
    raw_attachment_ids = value.get("attachment_ids")
    if not isinstance(raw_attachment_ids, list):
        _bad_request(f"messages[{index}].attachment_ids must be an array")
    attachment_ids = tuple(
        _required_string(item, f"messages[{index}].attachment_ids[{attachment_index}]")
        for attachment_index, item in enumerate(raw_attachment_ids)
    )
    if len(set(attachment_ids)) != len(attachment_ids):
        _bad_request(f"duplicate attachment reference in message: {message_id}")
    return ChatMessage(id=message_id, role=role, text=text, attachment_ids=attachment_ids)


def _parse_request_json(raw_request: str) -> tuple[str, tuple[ChatMessage, ...], tuple[_AttachmentManifest, ...], str]:
    try:
        payload = json.loads(raw_request)
    except (json.JSONDecodeError, UnicodeError, RecursionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid request JSON"}) from exc
    if not isinstance(payload, dict):
        _bad_request("request JSON must be an object")

    model = _required_string(payload.get("model"), "model")
    raw_messages = payload.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages:
        _bad_request("messages must be a non-empty array")
    messages = tuple(_parse_message(value, index) for index, value in enumerate(raw_messages))
    message_ids = [message.id for message in messages]
    if len(set(message_ids)) != len(message_ids):
        _bad_request("duplicate message id")

    raw_attachments = payload.get("attachments")
    if not isinstance(raw_attachments, list):
        _bad_request("attachments must be an array")
    manifests = tuple(_parse_manifest(value, index) for index, value in enumerate(raw_attachments))
    attachment_ids = [manifest.id for manifest in manifests]
    if len(set(attachment_ids)) != len(attachment_ids):
        _bad_request("duplicate attachment id")
    attachment_hashes = [manifest.sha256 for manifest in manifests]
    if len(set(attachment_hashes)) != len(attachment_hashes):
        _bad_request("duplicate file in attachment manifest")

    thinking_effort_value = payload.get("thinking_effort", "")
    thinking_effort = _required_string(thinking_effort_value, "thinking_effort", allow_empty=True)
    return model, messages, manifests, thinking_effort


def _validate_references(messages: tuple[ChatMessage, ...], manifests: tuple[_AttachmentManifest, ...]) -> None:
    manifests_by_id = {manifest.id: manifest for manifest in manifests}
    referenced_ids: set[str] = set()
    for message in messages:
        message_manifests: list[_AttachmentManifest] = []
        for attachment_id in message.attachment_ids:
            manifest = manifests_by_id.get(attachment_id)
            if manifest is None:
                _bad_request(f"unknown attachment reference: {attachment_id}")
            message_manifests.append(manifest)
            referenced_ids.add(attachment_id)
        image_count = sum(manifest.kind == "image" for manifest in message_manifests)
        document_count = sum(manifest.kind == "document" for manifest in message_manifests)
        if image_count > MAX_IMAGES_PER_MESSAGE:
            _bad_request(f"message may contain at most 10 images: {message.id}")
        if document_count > MAX_DOCUMENTS_PER_MESSAGE:
            _bad_request(f"message may contain at most 5 documents: {message.id}")
        if sum(manifest.size for manifest in message_manifests) > MAX_MESSAGE_ATTACHMENT_BYTES:
            _bad_request(f"message attachments exceed 50MB: {message.id}")

    orphan_ids = [manifest.id for manifest in manifests if manifest.id not in referenced_ids]
    if orphan_ids:
        _bad_request(f"orphan attachment: {orphan_ids[0]}")
    if sum(manifest.size for manifest in manifests) > MAX_REQUEST_WORKING_SET_BYTES:
        _bad_request("request attachment working set exceeds 100MB")


async def _read_upload(upload: UploadFile, manifest: _AttachmentManifest) -> bytes:
    digest = hashlib.sha256()
    data = bytearray()
    file_limit = MAX_IMAGE_BYTES if manifest.kind == "image" else MAX_DOCUMENT_BYTES
    while True:
        chunk = await upload.read(READ_CHUNK_BYTES)
        if not chunk:
            break
        data.extend(chunk)
        digest.update(chunk)
        if len(data) > manifest.size:
            _bad_request(f"file size mismatch for attachment: {manifest.id}")
        if len(data) > file_limit:
            label = "image exceeds 10MB" if manifest.kind == "image" else "document exceeds 25MB"
            _bad_request(f"{label}: {manifest.file_name}")
    if len(data) != manifest.size:
        _bad_request(f"file size mismatch for attachment: {manifest.id}")
    if digest.hexdigest() != manifest.sha256:
        _bad_request(f"file SHA-256 mismatch for attachment: {manifest.id}")
    return bytes(data)


async def _close_uploads(uploads: list[UploadFile]) -> None:
    for upload in uploads:
        try:
            await upload.close()
        except Exception:
            pass


def _validate_content_length(request: Request) -> None:
    raw_content_length = request.headers.get("content-length")
    if raw_content_length is None:
        return
    try:
        content_length = int(raw_content_length)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid Content-Length header"}) from exc
    if content_length < 0:
        _bad_request("invalid Content-Length header")
    if content_length > MAX_MULTIPART_REQUEST_BYTES:
        _request_too_large()


async def _limited_request_stream(request: Request) -> AsyncGenerator[bytes, None]:
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > MAX_MULTIPART_REQUEST_BYTES:
            raise _MultipartRequestTooLarge(MULTIPART_REQUEST_LIMIT_ERROR)
        yield chunk


async def _parse_limited_multipart_form(request: Request) -> FormData:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "multipart/form-data":
        _bad_request("content type must be multipart/form-data")
    _validate_content_length(request)
    # Starlette's max_part_size excludes file parts, so cap the source stream itself.
    parser = MultiPartParser(
        request.headers,
        _limited_request_stream(request),
        max_files=MAX_MULTIPART_FILES,
        max_fields=1,
        max_part_size=MAX_REQUEST_JSON_BYTES,
    )
    try:
        return await parser.parse()
    except _MultipartRequestTooLarge:
        _request_too_large()
    except MultiPartException as exc:
        raise HTTPException(status_code=400, detail={"error": exc.message}) from exc


async def _parse_chat_stream_form(form: FormData) -> ChatStreamCommand:
    items = list(form.multi_items())
    uploads = [value for _, value in items if isinstance(value, UploadFile)]
    try:
        unexpected_upload_fields = [key for key, value in items if isinstance(value, UploadFile) and key != "files"]
        if unexpected_upload_fields:
            _bad_request(f"orphan file in form field: {unexpected_upload_fields[0]}")

        request_values = [value for key, value in items if key == "request"]
        if len(request_values) != 1 or not isinstance(request_values[0], str):
            _bad_request("multipart request must contain exactly one request JSON field")
        file_values = [value for key, value in items if key == "files"]
        if any(not isinstance(value, UploadFile) for value in file_values):
            _bad_request("multipart files fields must contain uploaded files")
        ordered_uploads = [value for value in file_values if isinstance(value, UploadFile)]

        model, messages, manifests, thinking_effort = _parse_request_json(request_values[0])
        _validate_references(messages, manifests)
        if len(ordered_uploads) != len(manifests):
            _bad_request("multipart file count does not match attachment manifest")

        attachments: list[ChatAttachmentBlob] = []
        for manifest, upload in zip(manifests, ordered_uploads, strict=True):
            if (upload.filename or "") != manifest.file_name:
                _bad_request(f"file order or file name mismatch for attachment: {manifest.id}")
            upload_mime_type = _normalize_mime_type(upload.content_type or "")
            if upload_mime_type != manifest.mime_type:
                _bad_request(f"file MIME type mismatch for attachment: {manifest.id}")
            data = await _read_upload(upload, manifest)
            attachments.append(
                ChatAttachmentBlob(
                    id=manifest.id,
                    file_name=manifest.file_name,
                    mime_type=manifest.mime_type,
                    size=manifest.size,
                    sha256=manifest.sha256,
                    kind=manifest.kind,
                    data=data,
                )
            )

        return ChatStreamCommand(
            model=model,
            messages=messages,
            attachments=tuple(attachments),
            thinking_effort=thinking_effort,
        )
    finally:
        await _close_uploads(uploads)


async def parse_chat_stream_request(request: Request) -> ChatStreamCommand:
    form = await _parse_limited_multipart_form(request)
    return await _parse_chat_stream_form(form)
