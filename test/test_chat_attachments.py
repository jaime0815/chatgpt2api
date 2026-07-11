from __future__ import annotations

import hashlib
import json
from io import BytesIO
from typing import Any

import pytest
from PIL import Image

from services.chat_attachments import ChatAttachmentUploader
from services.chat_types import ChatAttachmentBlob
from services.openai_backend_api import InvalidAccessTokenError, OpenAIBackendAPI
from utils.helper import UpstreamHTTPError


class _FakeResponse:
    def __init__(
        self,
        status_code: int = 200,
        *,
        payload: dict[str, Any] | None = None,
        lines: list[bytes] | None = None,
    ) -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self._lines = lines or []
        self.headers: dict[str, str] = {}
        self.text = json.dumps(self._payload)

    def json(self) -> dict[str, Any]:
        return self._payload

    def iter_lines(self) -> list[bytes]:
        return self._lines

    def close(self) -> None:
        return None


class _JsonFailureResponse(_FakeResponse):
    def json(self) -> dict[str, Any]:
        raise RuntimeError("response contains file-secret?sig=signed-secret")


class _FakeSession:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self.headers = {"Authorization": "Bearer test-token"}
        self._responses = iter(responses)
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append(("post", url, kwargs))
        return next(self._responses)

    def put(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append(("put", url, kwargs))
        return next(self._responses)


class _PutFailureSession(_FakeSession):
    def put(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append(("put", url, kwargs))
        raise RuntimeError(f"signed upload failed for {url}")


def _backend(responses: list[_FakeResponse]) -> tuple[OpenAIBackendAPI, _FakeSession]:
    backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
    session = _FakeSession(responses)
    backend.base_url = "https://chatgpt.test"
    backend.session = session
    backend.user_agent = "test-agent"
    backend.access_token = "test-token"
    return backend, session


def _attachment(
    *,
    attachment_id: str = "pdf-1",
    file_name: str = "sample.pdf",
    mime_type: str = "application/pdf",
    kind: str = "document",
    data: bytes = b"%PDF-1.7",
) -> ChatAttachmentBlob:
    return ChatAttachmentBlob(
        id=attachment_id,
        file_name=file_name,
        mime_type=mime_type,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        kind=kind,  # type: ignore[arg-type]
        data=data,
    )


def _png(width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height), color="white")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_document_upload_processes_before_conversation() -> None:
    backend, session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
            "library_file_id": "library-secret",
        }),
        _FakeResponse(status_code=201),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success"}',
            b"data: [DONE]",
        ]),
    ])

    uploaded = ChatAttachmentUploader().resolve(backend, (_attachment(),))

    assert uploaded == {
        "pdf-1": {
            "kind": "document",
            "metadata_attachment": {
                "id": "file-secret",
                "name": "sample.pdf",
                "mime_type": "application/pdf",
                "size": 8,
                "is_big_paste": False,
                "library_file_id": "library-secret",
            },
        }
    }
    assert [(method, url) for method, url, _kwargs in session.calls] == [
        ("post", "https://chatgpt.test/backend-api/files"),
        ("put", "https://upload.test/blob?sig=signed-secret"),
        ("post", "https://chatgpt.test/backend-api/files/file-secret/uploaded"),
        ("post", "https://chatgpt.test/backend-api/files/process_upload_stream"),
    ]
    assert session.calls[0][2]["json"] == {
        "file_name": "sample.pdf",
        "file_size": 8,
        "mime_type": "application/pdf",
        "use_case": "multimodal",
    }
    assert session.calls[1][2]["data"] == b"%PDF-1.7"
    assert session.calls[1][2]["headers"]["Content-Type"] == "application/pdf"
    assert session.calls[2][2]["data"] == "{}"
    assert session.calls[3][2]["json"] == {
        "file_id": "file-secret",
        "file_name": "sample.pdf",
        "use_case": "multimodal",
        "index_for_retrieval": True,
        "entry_surface": "composer",
    }


def test_image_upload_returns_asset_pointer_without_document_processing() -> None:
    png = _png(2, 3)
    backend, session = _backend([
        _FakeResponse(payload={
            "file_id": "image-file-secret",
            "upload_url": "https://upload.test/image?sig=image-signed-secret",
        }),
        _FakeResponse(status_code=201),
        _FakeResponse(payload={"status": "success"}),
    ])

    uploaded = backend.upload_chat_attachment_bytes(
        png,
        "reference.png",
        "image/png",
        "image",
    )

    assert uploaded == {
        "kind": "image",
        "content_part": {
            "content_type": "image_asset_pointer",
            "asset_pointer": "file-service://image-file-secret",
            "width": 2,
            "height": 3,
            "size_bytes": len(png),
        },
        "metadata_attachment": {
            "id": "image-file-secret",
            "mimeType": "image/png",
            "name": "reference.png",
            "size": len(png),
            "width": 2,
            "height": 3,
        },
    }
    assert [method for method, _url, _kwargs in session.calls] == ["post", "put", "post"]
    assert session.calls[0][2]["json"] == {
        "file_name": "reference.png",
        "file_size": len(png),
        "mime_type": "image/png",
        "use_case": "multimodal",
        "width": 2,
        "height": 3,
    }


def test_document_processing_requires_a_complete_success_stream() -> None:
    backend, _session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
        }),
        _FakeResponse(status_code=201),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success"}',
        ]),
    ])

    with pytest.raises(UpstreamHTTPError) as captured:
        backend.upload_chat_attachment_bytes(
            b"%PDF-1.7",
            "sample.pdf",
            "application/pdf",
            "document",
        )

    assert captured.value.status_code == 502
    assert "file-secret" not in str(captured.value)
    assert "signed-secret" not in str(captured.value)


def test_stream_attachment_payload_keeps_documents_in_metadata_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
    generated_ids = iter(["upstream-message-id"])
    monkeypatch.setattr("services.openai_backend_api.new_uuid", lambda: next(generated_ids))

    converted = backend._api_messages_to_conversation_messages([{
        "id": "browser-message-id",
        "role": "user",
        "content": "Compare these files.",
        "attachments": [
            {
                "kind": "document",
                "metadata_attachment": {
                    "id": "document-file-secret",
                    "name": "notes.pdf",
                    "mime_type": "application/pdf",
                    "size": 8,
                    "is_big_paste": False,
                },
            },
            {
                "kind": "image",
                "content_part": {
                    "content_type": "image_asset_pointer",
                    "asset_pointer": "file-service://image-file-secret",
                    "width": 2,
                    "height": 3,
                    "size_bytes": 4,
                },
                "metadata_attachment": {
                    "id": "image-file-secret",
                    "mimeType": "image/png",
                    "name": "reference.png",
                    "size": 4,
                    "width": 2,
                    "height": 3,
                },
            },
        ],
    }])

    assert converted == [{
        "id": "upstream-message-id",
        "author": {"role": "user"},
        "content": {
            "content_type": "multimodal_text",
            "parts": [
                {
                    "content_type": "image_asset_pointer",
                    "asset_pointer": "file-service://image-file-secret",
                    "width": 2,
                    "height": 3,
                    "size_bytes": 4,
                },
                "Compare these files.",
            ],
        },
        "metadata": {
            "attachments": [
                {
                    "id": "document-file-secret",
                    "name": "notes.pdf",
                    "mime_type": "application/pdf",
                    "size": 8,
                    "is_big_paste": False,
                },
                {
                    "id": "image-file-secret",
                    "mimeType": "image/png",
                    "name": "reference.png",
                    "size": 4,
                    "width": 2,
                    "height": 3,
                },
            ],
        },
    }]


def test_confirmed_attachment_auth_failure_maps_to_invalid_token_without_secrets() -> None:
    backend, _session = _backend([_FakeResponse(status_code=401)])

    with pytest.raises(InvalidAccessTokenError) as captured:
        backend.upload_chat_attachment_bytes(
            b"%PDF-1.7",
            "sample.pdf",
            "application/pdf",
            "document",
        )

    message = str(captured.value)
    assert "file-secret" not in message
    assert "signed-secret" not in message
    assert "test-token" not in message


def test_signed_upload_network_error_is_sanitized() -> None:
    backend, _session = _backend([])
    backend.session = _PutFailureSession([_FakeResponse(payload={
        "file_id": "file-secret",
        "upload_url": "https://upload.test/blob?sig=signed-secret",
    })])

    with pytest.raises(RuntimeError) as captured:
        backend.upload_chat_attachment_bytes(
            b"%PDF-1.7",
            "sample.pdf",
            "application/pdf",
            "document",
        )

    assert str(captured.value) == "chat attachment upload request failed"
    assert "file-secret" not in str(captured.value)
    assert "signed-secret" not in str(captured.value)
    assert "test-token" not in str(captured.value)


def test_creation_response_parse_error_has_no_sensitive_exception_chain() -> None:
    backend, _session = _backend([_JsonFailureResponse()])

    with pytest.raises(RuntimeError) as captured:
        backend.upload_chat_attachment_bytes(
            b"%PDF-1.7",
            "sample.pdf",
            "application/pdf",
            "document",
        )

    assert str(captured.value) == "invalid chat attachment creation response"
    assert captured.value.__cause__ is None
    assert "file-secret" not in str(captured.value)
    assert "signed-secret" not in str(captured.value)
