"""Opt-in live web-chat smoke tests.

Run only with RUN_LIVE_CHAT_ATTACHMENTS=1 plus LIVE_CHAT_BASE_URL,
LIVE_CHAT_AUTHORIZATION, and real fixture paths (LIVE_CHAT_PDF,
LIVE_CHAT_CSV, LIVE_CHAT_DOCX, LIVE_CHAT_IMAGE_FILES).
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pytest


httpx = pytest.importorskip("httpx")


_OPT_IN_ENV = "RUN_LIVE_CHAT_ATTACHMENTS"
_BASE_URL_ENV = "LIVE_CHAT_BASE_URL"
_AUTHORIZATION_ENV = "LIVE_CHAT_AUTHORIZATION"
_MODEL_ENV = "LIVE_CHAT_MODEL"
_TIMEOUT_ENV = "LIVE_CHAT_TIMEOUT_SECONDS"
_PDF_ENV = "LIVE_CHAT_PDF"
_CSV_ENV = "LIVE_CHAT_CSV"
_DOCX_ENV = "LIVE_CHAT_DOCX"
_IMAGE_FILES_ENV = "LIVE_CHAT_IMAGE_FILES"

_UNUSABLE_ACCOUNT_CODES = {
    "no_available_text_account",
    "upstream_authentication_error",
}
_ATTACHMENT_UNAVAILABLE_CODE = "attachment_unavailable"
_IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
_DOCUMENT_MIME_TYPES = {
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
_MAX_IMAGE_BYTES = 10 * 1024 * 1024
_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
_MAX_MESSAGE_ATTACHMENT_BYTES = 50 * 1024 * 1024


def _live_chat_attachments_enabled() -> bool:
    return os.environ.get(_OPT_IN_ENV, "").strip() == "1"


pytestmark = pytest.mark.skipif(
    not _live_chat_attachments_enabled(),
    reason="set RUN_LIVE_CHAT_ATTACHMENTS=1 to run live web-chat attachment smoke tests",
)


@dataclass(frozen=True)
class _LiveChatTarget:
    stream_url: str
    authorization: str
    model: str
    timeout_seconds: float


@dataclass(frozen=True)
class _Attachment:
    file_name: str
    mime_type: str
    data: bytes
    sha256: str


@dataclass(frozen=True)
class _SseEvent:
    event: str
    data: str


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        pytest.skip(f"requires explicit {name}")
    return value


def _parse_timeout(value: str) -> float:
    try:
        timeout = float(value)
    except ValueError:
        pytest.skip(f"{_TIMEOUT_ENV} must be a positive number")
    if timeout <= 0:
        pytest.skip(f"{_TIMEOUT_ENV} must be a positive number")
    return timeout


@pytest.fixture(scope="module")
def live_target() -> _LiveChatTarget:
    base_url = _require_env(_BASE_URL_ENV).rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        pytest.skip(f"{_BASE_URL_ENV} must be an explicit http(s) service URL")

    authorization = _require_env(_AUTHORIZATION_ENV)
    if not authorization.lower().startswith("bearer "):
        pytest.skip(f"{_AUTHORIZATION_ENV} must include the Bearer scheme")

    return _LiveChatTarget(
        stream_url=f"{base_url}/api/chat/stream",
        authorization=authorization,
        model=os.environ.get(_MODEL_ENV, "auto").strip() or "auto",
        timeout_seconds=_parse_timeout(os.environ.get(_TIMEOUT_ENV, "90").strip()),
    )


def _attachment_from_path(
    path: Path,
    *,
    allowed_mime_types: dict[str, str],
    env_name: str,
    size_limit: int,
) -> _Attachment:
    if not path.is_file():
        pytest.skip(f"{env_name} must point to a readable real fixture file")
    try:
        data = path.read_bytes()
    except OSError as exc:
        pytest.skip(f"{env_name} could not be read: {type(exc).__name__}")
    if not data:
        pytest.skip(f"{env_name} must not point to an empty fixture")

    extension = path.suffix.lower()
    mime_type = allowed_mime_types.get(extension)
    if mime_type is None:
        allowed = ", ".join(sorted(allowed_mime_types))
        pytest.skip(f"{env_name} must use one of: {allowed}")
    if len(data) > size_limit:
        pytest.skip(f"{env_name} exceeds the supported fixture size limit")

    return _Attachment(
        file_name=path.name,
        mime_type=mime_type,
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
    )


def _document_fixture(name: str, extension: str) -> _Attachment:
    path = Path(_require_env(name)).expanduser()
    if path.suffix.lower() != extension:
        pytest.skip(f"{name} must point to a {extension} fixture")
    attachment = _attachment_from_path(
        path,
        allowed_mime_types=_DOCUMENT_MIME_TYPES,
        env_name=name,
        size_limit=_MAX_DOCUMENT_BYTES,
    )
    return attachment


def _image_fixtures(*, minimum: int) -> list[_Attachment]:
    raw_paths = _require_env(_IMAGE_FILES_ENV)
    paths = [Path(value.strip()).expanduser() for value in raw_paths.split(os.pathsep) if value.strip()]
    if len(paths) < minimum:
        pytest.skip(f"{_IMAGE_FILES_ENV} requires at least {minimum} real image fixture paths")
    attachments = [
        _attachment_from_path(
            path,
            allowed_mime_types=_IMAGE_MIME_TYPES,
            env_name=_IMAGE_FILES_ENV,
            size_limit=_MAX_IMAGE_BYTES,
        )
        for path in paths[:minimum]
    ]
    if len({attachment.sha256 for attachment in attachments}) != len(attachments):
        pytest.skip(f"{_IMAGE_FILES_ENV} must contain distinct image file contents")
    return attachments


def _request_payload(
    target: _LiveChatTarget,
    prompt: str,
    attachments: list[_Attachment],
    *,
    prior_messages: list[dict[str, object]] | None = None,
    attach_to_current_message: bool = True,
) -> dict[str, object]:
    attachment_ids = [f"live-attachment-{index}" for index in range(1, len(attachments) + 1)]
    current_attachment_ids = attachment_ids if attach_to_current_message else []
    messages = [*(prior_messages or [])]
    messages.append(
        {
            "id": f"live-message-{len(messages) + 1}",
            "role": "user",
            "text": prompt,
            "attachment_ids": current_attachment_ids,
        }
    )
    return {
        "model": target.model,
        "messages": messages,
        "attachments": [
            {
                "id": attachment_id,
                "file_name": attachment.file_name,
                "mime_type": attachment.mime_type,
                "size": len(attachment.data),
                "sha256": attachment.sha256,
            }
            for attachment_id, attachment in zip(attachment_ids, attachments, strict=True)
        ],
        "thinking_effort": "",
    }


def _post_stream(
    target: _LiveChatTarget,
    *,
    prompt: str,
    attachments: list[_Attachment] | None = None,
    prior_messages: list[dict[str, object]] | None = None,
    attach_to_current_message: bool = True,
) -> httpx.Response:
    attachment_list = attachments or []
    if sum(len(attachment.data) for attachment in attachment_list) > _MAX_MESSAGE_ATTACHMENT_BYTES:
        pytest.skip("selected live attachment fixtures exceed the 50MB per-message service limit")
    multipart: list[tuple[str, tuple[str | None, bytes | str, str]]] = [
        (
            "request",
            (
                None,
                json.dumps(
                    _request_payload(
                        target,
                        prompt,
                        attachment_list,
                        prior_messages=prior_messages,
                        attach_to_current_message=attach_to_current_message,
                    ),
                    ensure_ascii=False,
                ),
                "application/json",
            ),
        )
    ]
    multipart.extend(
        ("files", (attachment.file_name, attachment.data, attachment.mime_type))
        for attachment in attachment_list
    )
    try:
        with httpx.Client(timeout=target.timeout_seconds, follow_redirects=False) as client:
            return client.post(
                target.stream_url,
                headers={"Authorization": target.authorization},
                files=multipart,
            )
    except httpx.RequestError as exc:
        pytest.fail(f"could not reach the configured live chat service: {type(exc).__name__}")


def _sse_events(body: str) -> list[_SseEvent]:
    events: list[_SseEvent] = []
    for raw_frame in body.replace("\r\n", "\n").split("\n\n"):
        if not raw_frame.strip():
            continue
        event = "message"
        data_lines: list[str] = []
        for line in raw_frame.splitlines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].lstrip())
        if data_lines or event == "error":
            events.append(_SseEvent(event=event, data="\n".join(data_lines)))
    return events


def _error_codes(events: list[_SseEvent]) -> set[str]:
    codes: set[str] = set()
    for event in events:
        if event.event != "error":
            continue
        try:
            payload = json.loads(event.data)
        except json.JSONDecodeError:
            codes.add("<malformed_error_event>")
            continue
        error = payload.get("error") if isinstance(payload, dict) else None
        code = error.get("code") if isinstance(error, dict) else None
        if isinstance(code, str) and code:
            codes.add(code)
        else:
            codes.add("<unstructured_error_event>")
    return codes


def _assert_completed_text_stream(response: httpx.Response) -> list[_SseEvent]:
    assert response.status_code == 200, f"text stream returned HTTP {response.status_code}"
    assert response.headers.get("content-type", "").startswith("text/event-stream")
    events = _sse_events(response.text)
    codes = _error_codes(events)
    if codes and codes <= _UNUSABLE_ACCOUNT_CODES:
        pytest.skip("configured service has no usable local text account for this live smoke run")
    assert not codes, f"text stream emitted unexpected public errors: {sorted(codes)}"
    assert events and events[-1].data == "[DONE]", "text stream did not finish with [DONE]"

    chunks: list[dict[str, Any]] = []
    for event in events:
        if event.data == "[DONE]":
            continue
        try:
            payload = json.loads(event.data)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            chunks.append(payload)
    assert any(isinstance(chunk.get("choices"), list) for chunk in chunks)
    assert any(
        choice.get("finish_reason") == "stop"
        for chunk in chunks
        for choice in chunk.get("choices", [])
        if isinstance(choice, dict)
    )
    return events


@pytest.fixture(scope="module")
def live_text_stream(live_target: _LiveChatTarget) -> list[_SseEvent]:
    response = _post_stream(
        live_target,
        prompt="Reply with a brief live smoke acknowledgement.",
    )
    return _assert_completed_text_stream(response)


def _assert_native_attachment_stream_or_xfail(response: httpx.Response, label: str) -> None:
    assert response.status_code == 200, f"{label} request returned HTTP {response.status_code}"
    assert response.headers.get("content-type", "").startswith("text/event-stream")
    events = _sse_events(response.text)
    codes = _error_codes(events)
    if codes and codes <= _UNUSABLE_ACCOUNT_CODES:
        pytest.skip("configured service lost its usable local text account during this live smoke run")
    if codes == {_ATTACHMENT_UNAVAILABLE_CODE}:
        pytest.xfail(
            "native attachment uploader is not wired into the default ChatStreamSession yet"
        )
    assert not codes, f"{label} stream emitted unexpected public errors: {sorted(codes)}"
    assert events and events[-1].data == "[DONE]", f"{label} stream did not finish with [DONE]"


def test_live_authenticated_text_stream_completes(live_text_stream: list[_SseEvent]) -> None:
    assert live_text_stream[-1].data == "[DONE]"


@pytest.mark.parametrize(
    ("fixture_env", "extension", "label"),
    [
        (_PDF_ENV, ".pdf", "PDF attachment"),
        (_CSV_ENV, ".csv", "CSV attachment"),
        (_DOCX_ENV, ".docx", "DOCX attachment"),
    ],
)
def test_live_document_attachment_streams_when_uploader_is_available(
    live_text_stream: list[_SseEvent],
    live_target: _LiveChatTarget,
    fixture_env: str,
    extension: str,
    label: str,
) -> None:
    assert live_text_stream[-1].data == "[DONE]"
    attachment = _document_fixture(fixture_env, extension)
    response = _post_stream(
        live_target,
        prompt=f"Briefly acknowledge the attached {label}.",
        attachments=[attachment],
    )
    _assert_native_attachment_stream_or_xfail(response, label)


def test_live_pdf_follow_up_streams_when_uploader_is_available(
    live_text_stream: list[_SseEvent],
    live_target: _LiveChatTarget,
) -> None:
    assert live_text_stream[-1].data == "[DONE]"
    pdf = _document_fixture(_PDF_ENV, ".pdf")
    initial_prompt = "Briefly acknowledge the attached PDF before a follow-up question."
    initial_response = _post_stream(
        live_target,
        prompt=initial_prompt,
        attachments=[pdf],
    )
    _assert_native_attachment_stream_or_xfail(initial_response, "PDF attachment")

    # The web endpoint is stateless: a follow-up replays the persisted history and attachment manifest.
    follow_up = _post_stream(
        live_target,
        prompt="What file did I attach in the previous message?",
        attachments=[pdf],
        prior_messages=[
            {
                "id": "live-message-1",
                "role": "user",
                "text": initial_prompt,
                "attachment_ids": ["live-attachment-1"],
            },
            {
                "id": "live-assistant-1",
                "role": "assistant",
                "text": "Acknowledge the attached PDF.",
                "attachment_ids": [],
            },
        ],
        attach_to_current_message=False,
    )
    _assert_native_attachment_stream_or_xfail(follow_up, "PDF follow-up")


def test_live_mixed_image_document_streams_when_uploader_is_available(
    live_text_stream: list[_SseEvent],
    live_target: _LiveChatTarget,
) -> None:
    assert live_text_stream[-1].data == "[DONE]"
    image = _image_fixtures(minimum=1)[0]
    pdf = _document_fixture(_PDF_ENV, ".pdf")
    response = _post_stream(
        live_target,
        prompt="Briefly acknowledge the attached image and PDF.",
        attachments=[image, pdf],
    )
    _assert_native_attachment_stream_or_xfail(response, "mixed image and PDF attachment")


def test_live_exactly_ten_images_stream_when_uploader_is_available(
    live_text_stream: list[_SseEvent],
    live_target: _LiveChatTarget,
) -> None:
    assert live_text_stream[-1].data == "[DONE]"
    images = _image_fixtures(minimum=10)
    assert len(images) == 10
    response = _post_stream(
        live_target,
        prompt="Briefly acknowledge the ten attached images.",
        attachments=images,
    )
    _assert_native_attachment_stream_or_xfail(response, "exactly ten image attachments")
