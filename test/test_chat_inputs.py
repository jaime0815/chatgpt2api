from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
from dataclasses import FrozenInstanceError
from io import BytesIO
from typing import Any

import pytest
from fastapi import HTTPException
from starlette.datastructures import FormData, Headers, UploadFile

from api.chat_inputs import parse_chat_stream_request
from services.chat_types import ChatAttachmentBlob, ChatMessage, ChatStreamCommand


MIB = 1024 * 1024


class StubRequest:
    def __init__(self, form: FormData) -> None:
        self._form = form

    async def form(self) -> FormData:
        return self._form


def _write_pattern(file: Any, size: int, marker: int) -> str:
    digest = hashlib.sha256()
    chunk = bytes([marker]) * MIB
    remaining = size
    while remaining:
        part = chunk[: min(remaining, len(chunk))]
        file.write(part)
        digest.update(part)
        remaining -= len(part)
    file.seek(0)
    return digest.hexdigest()


def _attachment(
    attachment_id: str,
    file_name: str,
    mime_type: str,
    *,
    data: bytes | None = None,
    size: int | None = None,
    marker: int = 1,
) -> tuple[dict[str, Any], UploadFile]:
    if data is not None:
        file = BytesIO(data)
        digest = hashlib.sha256(data).hexdigest()
        actual_size = len(data)
    else:
        assert size is not None
        file = tempfile.TemporaryFile()
        digest = _write_pattern(file, size, marker)
        actual_size = size
    upload = UploadFile(
        file,
        size=actual_size,
        filename=file_name,
        headers=Headers({"content-type": mime_type}),
    )
    manifest = {
        "id": attachment_id,
        "file_name": file_name,
        "mime_type": mime_type,
        "size": actual_size,
        "sha256": digest,
    }
    return manifest, upload


def _message(message_id: str, attachment_ids: list[str], *, text: str = "hello") -> dict[str, Any]:
    return {
        "id": message_id,
        "role": "user",
        "text": text,
        "attachment_ids": attachment_ids,
    }


def _payload(
    attachments: list[dict[str, Any]],
    *,
    messages: list[dict[str, Any]] | None = None,
    thinking_effort: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": "gpt-5.2",
        "messages": messages if messages is not None else [_message("message-1", [item["id"] for item in attachments])],
        "attachments": attachments,
    }
    if thinking_effort is not None:
        payload["thinking_effort"] = thinking_effort
    return payload


def _parse_form(entries: list[tuple[str, str | UploadFile]]) -> ChatStreamCommand:
    request = StubRequest(FormData(entries))
    return asyncio.run(parse_chat_stream_request(request))  # type: ignore[arg-type]


def _parse(payload: dict[str, Any], uploads: list[UploadFile]) -> ChatStreamCommand:
    entries: list[tuple[str, str | UploadFile]] = [("request", json.dumps(payload))]
    entries.extend(("files", upload) for upload in uploads)
    return _parse_form(entries)


def _assert_rejected(
    payload: dict[str, Any],
    uploads: list[UploadFile],
    expected_error: str,
) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        _parse(payload, uploads)
    assert caught.value.status_code == 400
    assert expected_error in caught.value.detail["error"]
    return caught.value


def _many_attachments(
    count: int,
    *,
    suffix: str,
    mime_type: str,
    prefix: str,
) -> tuple[list[dict[str, Any]], list[UploadFile]]:
    manifests: list[dict[str, Any]] = []
    uploads: list[UploadFile] = []
    for index in range(count):
        manifest, upload = _attachment(
            f"{prefix}-{index}",
            f"{prefix}-{index}.{suffix}",
            mime_type,
            data=f"{prefix}-{index}".encode(),
        )
        manifests.append(manifest)
        uploads.append(upload)
    return manifests, uploads


def test_parses_ordered_manifest_into_frozen_slotted_command_types() -> None:
    manifest, upload = _attachment("attachment-1", "diagram.png", "image/png", data=b"png-data")

    command = _parse(_payload([manifest], thinking_effort="high"), [upload])

    assert command == ChatStreamCommand(
        model="gpt-5.2",
        messages=(
            ChatMessage(
                id="message-1",
                role="user",
                text="hello",
                attachment_ids=("attachment-1",),
            ),
        ),
        attachments=(
            ChatAttachmentBlob(
                id="attachment-1",
                file_name="diagram.png",
                mime_type="image/png",
                size=8,
                sha256=hashlib.sha256(b"png-data").hexdigest(),
                kind="image",
                data=b"png-data",
            ),
        ),
        thinking_effort="high",
    )
    assert not hasattr(command, "__dict__")
    with pytest.raises(FrozenInstanceError):
        command.model = "other"  # type: ignore[misc]
    assert upload.file.closed


def test_accepts_text_only_request_and_defaults_thinking_effort() -> None:
    payload = _payload([], messages=[_message("message-1", [], text="text only")])

    command = _parse(payload, [])

    assert command.attachments == ()
    assert command.thinking_effort == ""


@pytest.mark.parametrize(
    ("file_name", "mime_type", "kind"),
    [
        ("image.png", "image/png", "image"),
        ("image.jpeg", "image/jpeg", "image"),
        ("image.jpg", "image/jpeg", "image"),
        ("image.webp", "image/webp", "image"),
        ("image.gif", "image/gif", "image"),
        ("document.pdf", "application/pdf", "document"),
        ("document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"),
        ("document.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"),
        ("document.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "document"),
        ("document.txt", "text/plain", "document"),
        ("document.md", "text/markdown", "document"),
        ("document.csv", "text/csv", "document"),
    ],
)
def test_accepts_supported_extension_and_mime_pairs(file_name: str, mime_type: str, kind: str) -> None:
    manifest, upload = _attachment("attachment-1", file_name, mime_type, data=b"content")

    command = _parse(_payload([manifest]), [upload])

    assert command.attachments[0].kind == kind
    assert upload.file.closed


@pytest.mark.parametrize(
    ("file_name", "mime_type"),
    [
        ("legacy.doc", "application/msword"),
        ("legacy.xls", "application/vnd.ms-excel"),
        ("legacy.ppt", "application/vnd.ms-powerpoint"),
    ],
)
def test_rejects_legacy_office_formats(file_name: str, mime_type: str) -> None:
    manifest, upload = _attachment("attachment-1", file_name, mime_type, data=b"content")

    _assert_rejected(_payload([manifest]), [upload], "unsupported attachment type")

    assert upload.file.closed


def test_rejects_mime_extension_mismatch() -> None:
    manifest, upload = _attachment("attachment-1", "image.png", "image/jpeg", data=b"content")

    _assert_rejected(_payload([manifest]), [upload], "MIME type does not match")

    assert upload.file.closed


def test_rejects_upload_mime_that_differs_from_manifest() -> None:
    manifest, upload = _attachment("attachment-1", "image.png", "image/png", data=b"content")
    upload.headers = Headers({"content-type": "image/jpeg"})

    _assert_rejected(_payload([manifest]), [upload], "file MIME type mismatch")

    assert upload.file.closed


def test_accepts_exactly_10_images_per_message() -> None:
    manifests, uploads = _many_attachments(10, suffix="png", mime_type="image/png", prefix="image")

    command = _parse(_payload(manifests), uploads)

    assert len(command.attachments) == 10
    assert all(upload.file.closed for upload in uploads)


def test_rejects_11_images_per_message() -> None:
    manifests, uploads = _many_attachments(11, suffix="png", mime_type="image/png", prefix="image")

    _assert_rejected(_payload(manifests), uploads, "at most 10 images")

    assert all(upload.file.closed for upload in uploads)


def test_accepts_exactly_5_documents_per_message() -> None:
    manifests, uploads = _many_attachments(5, suffix="pdf", mime_type="application/pdf", prefix="document")

    command = _parse(_payload(manifests), uploads)

    assert len(command.attachments) == 5
    assert all(upload.file.closed for upload in uploads)


def test_rejects_6_documents_per_message() -> None:
    manifests, uploads = _many_attachments(6, suffix="pdf", mime_type="application/pdf", prefix="document")

    _assert_rejected(_payload(manifests), uploads, "at most 5 documents")

    assert all(upload.file.closed for upload in uploads)


def test_accepts_image_at_exactly_10mb() -> None:
    manifest, upload = _attachment("image-1", "image.png", "image/png", size=10 * MIB, marker=11)

    command = _parse(_payload([manifest]), [upload])

    assert command.attachments[0].size == 10 * MIB
    assert upload.file.closed


def test_rejects_image_over_10mb() -> None:
    manifest, upload = _attachment("image-1", "image.png", "image/png", size=10 * MIB + 1, marker=12)

    _assert_rejected(_payload([manifest]), [upload], "image exceeds 10MB")

    assert upload.file.closed


def test_accepts_document_at_exactly_25mb() -> None:
    manifest, upload = _attachment("document-1", "document.pdf", "application/pdf", size=25 * MIB, marker=21)

    command = _parse(_payload([manifest]), [upload])

    assert command.attachments[0].size == 25 * MIB
    assert upload.file.closed


def test_rejects_document_over_25mb() -> None:
    manifest, upload = _attachment("document-1", "document.pdf", "application/pdf", size=25 * MIB + 1, marker=22)

    _assert_rejected(_payload([manifest]), [upload], "document exceeds 25MB")

    assert upload.file.closed


def test_accepts_exactly_50mb_of_attachments_on_one_message() -> None:
    first, first_upload = _attachment("document-1", "first.pdf", "application/pdf", size=25 * MIB, marker=31)
    second, second_upload = _attachment("document-2", "second.pdf", "application/pdf", size=25 * MIB, marker=32)

    command = _parse(_payload([first, second]), [first_upload, second_upload])

    assert sum(item.size for item in command.attachments) == 50 * MIB
    assert first_upload.file.closed and second_upload.file.closed


def test_rejects_more_than_50mb_of_attachments_on_one_message() -> None:
    first, first_upload = _attachment("document-1", "first.pdf", "application/pdf", size=25 * MIB, marker=33)
    second, second_upload = _attachment("document-2", "second.pdf", "application/pdf", size=25 * MIB, marker=34)
    third, third_upload = _attachment("document-3", "third.pdf", "application/pdf", data=b"x")
    uploads = [first_upload, second_upload, third_upload]

    _assert_rejected(_payload([first, second, third]), uploads, "message attachments exceed 50MB")

    assert all(upload.file.closed for upload in uploads)


def _working_set_payload(*, extra_byte: bool) -> tuple[dict[str, Any], list[UploadFile]]:
    manifests: list[dict[str, Any]] = []
    uploads: list[UploadFile] = []
    for index in range(4):
        manifest, upload = _attachment(
            f"document-{index}",
            f"document-{index}.pdf",
            "application/pdf",
            size=25 * MIB,
            marker=40 + index,
        )
        manifests.append(manifest)
        uploads.append(upload)
    messages = [
        _message("message-1", ["document-0", "document-1"]),
        _message("message-2", ["document-2", "document-3"]),
    ]
    if extra_byte:
        manifest, upload = _attachment("document-4", "document-4.pdf", "application/pdf", data=b"x")
        manifests.append(manifest)
        uploads.append(upload)
        messages.append(_message("message-3", ["document-4"]))
    return _payload(manifests, messages=messages), uploads


def test_accepts_exactly_100mb_unique_request_working_set() -> None:
    payload, uploads = _working_set_payload(extra_byte=False)

    command = _parse(payload, uploads)

    assert sum(item.size for item in command.attachments) == 100 * MIB
    assert all(upload.file.closed for upload in uploads)


def test_rejects_request_working_set_over_100mb() -> None:
    payload, uploads = _working_set_payload(extra_byte=True)

    _assert_rejected(payload, uploads, "request attachment working set exceeds 100MB")

    assert all(upload.file.closed for upload in uploads)


def test_shared_attachment_references_count_once_in_request_working_set() -> None:
    manifest, upload = _attachment("document-1", "document.pdf", "application/pdf", size=25 * MIB, marker=51)
    messages = [
        _message("message-1", ["document-1"]),
        _message("message-2", ["document-1"]),
    ]

    command = _parse(_payload([manifest], messages=messages), [upload])

    assert len(command.attachments) == 1
    assert upload.file.closed


def test_rejects_reordered_files_and_closes_every_upload() -> None:
    first, first_upload = _attachment("first", "first.png", "image/png", data=b"first")
    second, second_upload = _attachment("second", "second.pdf", "application/pdf", data=b"second")

    _assert_rejected(_payload([first, second]), [second_upload, first_upload], "file order")

    assert first_upload.file.closed and second_upload.file.closed


def test_rejects_missing_file_and_closes_supplied_uploads() -> None:
    first, first_upload = _attachment("first", "first.png", "image/png", data=b"first")
    second, _ = _attachment("second", "second.pdf", "application/pdf", data=b"second")

    _assert_rejected(_payload([first, second]), [first_upload], "file count")

    assert first_upload.file.closed


def test_rejects_extra_file_and_closes_every_upload() -> None:
    first, first_upload = _attachment("first", "first.png", "image/png", data=b"first")
    _, extra_upload = _attachment("extra", "extra.png", "image/png", data=b"extra")

    _assert_rejected(_payload([first]), [first_upload, extra_upload], "file count")

    assert first_upload.file.closed and extra_upload.file.closed


def test_rejects_repeated_file_part_and_closes_it() -> None:
    manifest, upload = _attachment("first", "first.png", "image/png", data=b"first")

    _assert_rejected(_payload([manifest]), [upload, upload], "file count")

    assert upload.file.closed


def test_rejects_duplicate_file_content_under_different_attachment_ids() -> None:
    first, first_upload = _attachment("first", "first.png", "image/png", data=b"same")
    second, second_upload = _attachment("second", "second.png", "image/png", data=b"same")

    _assert_rejected(_payload([first, second]), [first_upload, second_upload], "duplicate file")

    assert first_upload.file.closed and second_upload.file.closed


def test_rejects_duplicate_attachment_ids() -> None:
    first, first_upload = _attachment("same-id", "first.png", "image/png", data=b"first")
    second, second_upload = _attachment("same-id", "second.png", "image/png", data=b"second")
    messages = [_message("message-1", ["same-id"])]

    _assert_rejected(
        _payload([first, second], messages=messages),
        [first_upload, second_upload],
        "duplicate attachment id",
    )

    assert first_upload.file.closed and second_upload.file.closed


def test_rejects_duplicate_message_ids() -> None:
    payload = _payload(
        [],
        messages=[
            _message("same-id", []),
            _message("same-id", []),
        ],
    )

    _assert_rejected(payload, [], "duplicate message id")


def test_rejects_duplicate_attachment_reference_within_message() -> None:
    manifest, upload = _attachment("attachment-1", "image.png", "image/png", data=b"image")
    messages = [_message("message-1", ["attachment-1", "attachment-1"])]

    _assert_rejected(_payload([manifest], messages=messages), [upload], "duplicate attachment reference")

    assert upload.file.closed


def test_rejects_unknown_attachment_reference() -> None:
    payload = _payload([], messages=[_message("message-1", ["missing-id"])])

    _assert_rejected(payload, [], "unknown attachment reference")


def test_rejects_orphan_manifest_attachment() -> None:
    manifest, upload = _attachment("attachment-1", "image.png", "image/png", data=b"image")
    payload = _payload([manifest], messages=[_message("message-1", [])])

    _assert_rejected(payload, [upload], "orphan attachment")

    assert upload.file.closed


def test_rejects_upload_under_unexpected_form_field_as_orphan_file() -> None:
    _, upload = _attachment("attachment-1", "image.png", "image/png", data=b"image")
    payload = _payload([], messages=[_message("message-1", [])])

    with pytest.raises(HTTPException) as caught:
        _parse_form([("request", json.dumps(payload)), ("unexpected", upload)])

    assert caught.value.status_code == 400
    assert "orphan file" in caught.value.detail["error"]
    assert upload.file.closed


@pytest.mark.parametrize(
    ("field", "declared_value", "expected_error"),
    [
        ("file_name", "different.png", "file name"),
        ("mime_type", "image/webp", "MIME type"),
        ("size", 999, "file size"),
        ("sha256", "0" * 64, "SHA-256"),
    ],
)
def test_rejects_manifest_field_mismatch(field: str, declared_value: Any, expected_error: str) -> None:
    manifest, upload = _attachment("attachment-1", "image.png", "image/png", data=b"image")
    manifest[field] = declared_value

    _assert_rejected(_payload([manifest]), [upload], expected_error)

    assert upload.file.closed


def test_closes_upload_when_request_json_is_invalid() -> None:
    _, upload = _attachment("attachment-1", "image.png", "image/png", data=b"image")

    with pytest.raises(HTTPException) as caught:
        _parse_form([("request", "{"), ("files", upload)])

    assert caught.value.status_code == 400
    assert "invalid request JSON" in caught.value.detail["error"]
    assert upload.file.closed
