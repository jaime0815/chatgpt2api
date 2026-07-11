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


class _SignedUploadTransport:
    def __init__(self) -> None:
        self.responses: list[_FakeResponse] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.error: Exception | None = None

    def put(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append((url, kwargs))
        if self.error is not None:
            raise self.error
        return self.responses.pop(0)


@pytest.fixture
def signed_upload(monkeypatch: pytest.MonkeyPatch) -> _SignedUploadTransport:
    transport = _SignedUploadTransport()
    monkeypatch.setattr("services.openai_backend_api.requests.put", transport.put)
    return transport


def _backend(responses: list[_FakeResponse]) -> tuple[OpenAIBackendAPI, _FakeSession]:
    backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
    session = _FakeSession(responses)
    backend.base_url = "https://chatgpt.test"
    backend.session = session
    backend.user_agent = "test-agent"
    backend.access_token = "test-token"
    backend._session_kwargs = {"impersonate": "chrome110", "verify": True}
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


def test_document_upload_processes_before_conversation(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
            "library_file_id": "library-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success"}',
            b"data: [DONE]",
        ]),
    ])
    signed_upload.responses.append(_FakeResponse(status_code=201))

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
        ("post", "https://chatgpt.test/backend-api/files/file-secret/uploaded"),
        ("post", "https://chatgpt.test/backend-api/files/process_upload_stream"),
    ]
    assert session.calls[0][2]["json"] == {
        "file_name": "sample.pdf",
        "file_size": 8,
        "mime_type": "application/pdf",
        "use_case": "multimodal",
    }
    assert signed_upload.calls == [
        ("https://upload.test/blob?sig=signed-secret", {
            "headers": {
                "Content-Type": "application/pdf",
                "Content-Length": "8",
                "x-ms-blob-type": "BlockBlob",
                "x-ms-version": "2020-04-08",
                "Origin": "https://chatgpt.test",
                "Referer": "https://chatgpt.test/",
                "User-Agent": "test-agent",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.8",
            },
            "data": b"%PDF-1.7",
            "timeout": 120,
            "discard_cookies": True,
            "impersonate": "chrome110",
            "verify": True,
        }),
    ]
    assert session.calls[1][2]["data"] == "{}"
    assert session.calls[2][2]["json"] == {
        "file_id": "file-secret",
        "file_name": "sample.pdf",
        "use_case": "multimodal",
        "index_for_retrieval": True,
        "entry_surface": "composer",
    }


def test_image_upload_returns_asset_pointer_without_document_processing(
    signed_upload: _SignedUploadTransport,
) -> None:
    png = _png(2, 3)
    backend, session = _backend([
        _FakeResponse(payload={
            "file_id": "image-file-secret",
            "upload_url": "https://upload.test/image?sig=image-signed-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
    ])
    signed_upload.responses.append(_FakeResponse(status_code=201))

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
    assert [method for method, _url, _kwargs in session.calls] == ["post", "post"]
    assert session.calls[0][2]["json"] == {
        "file_name": "reference.png",
        "file_size": len(png),
        "mime_type": "image/png",
        "use_case": "multimodal",
        "width": 2,
        "height": 3,
    }


def test_document_processing_requires_a_complete_success_stream(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, _session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success"}',
        ]),
    ])
    signed_upload.responses.append(_FakeResponse(status_code=201))

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


def test_signed_upload_does_not_send_account_credentials(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success"}',
            b"data: [DONE]",
        ]),
    ])
    session.headers["Cookie"] = "account-cookie=secret"
    backend._session_kwargs = {
        "impersonate": "chrome110",
        "verify": True,
        "headers": {"Authorization": "Bearer session-credential", "Cookie": "cookie=secret"},
        "cookies": {"cookie": "secret"},
        "auth": ("account", "secret"),
    }
    signed_upload.responses.append(_FakeResponse(status_code=201))

    backend.upload_chat_attachment_bytes(
        b"%PDF-1.7",
        "sample.pdf",
        "application/pdf",
        "document",
    )

    assert all(method != "put" for method, _url, _kwargs in session.calls)
    assert len(signed_upload.calls) == 1
    headers = signed_upload.calls[0][1]["headers"]
    assert "Authorization" not in headers
    assert "Cookie" not in headers
    assert headers["Content-Type"] == "application/pdf"
    assert headers["Content-Length"] == "8"
    assert "auth" not in signed_upload.calls[0][1]
    assert "cookies" not in signed_upload.calls[0][1]
    assert signed_upload.calls[0][1]["discard_cookies"] is True


@pytest.mark.parametrize("status", ["complete", "finished", "finished_successfully"])
def test_document_processing_accepts_native_success_variants(
    signed_upload: _SignedUploadTransport,
    status: str,
) -> None:
    backend, _session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            f'data: {{"event":"file.processing.completed","status":"{status}"}}'.encode(),
            b"data: [DONE]",
        ]),
    ])
    signed_upload.responses.append(_FakeResponse(status_code=201))

    uploaded = backend.upload_chat_attachment_bytes(
        b"%PDF-1.7",
        "sample.pdf",
        "application/pdf",
        "document",
    )

    assert uploaded["kind"] == "document"


@pytest.mark.parametrize(
    "failure_event",
    [
        {"payload": {"error": {"code": "processing_failed"}}},
        {"payload": {"state": "canceled"}},
        {"payload": {"success": False}},
    ],
)
def test_document_processing_rejects_nested_failure_after_success(
    signed_upload: _SignedUploadTransport,
    failure_event: dict[str, Any],
) -> None:
    backend, _session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success"}',
            f"data: {json.dumps(failure_event)}".encode(),
            b"data: [DONE]",
        ]),
    ])
    signed_upload.responses.append(_FakeResponse(status_code=201))

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


@pytest.mark.parametrize("payload", [{"status": "failed"}, {"success": False}])
def test_unsuccessful_creation_response_does_not_upload_or_return_pointer(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, Any],
) -> None:
    signed_calls: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        "services.openai_backend_api.requests.put",
        lambda url, **kwargs: signed_calls.append((url, kwargs)),
    )
    backend, session = _backend([_FakeResponse(payload={
        "file_id": "file-secret",
        "upload_url": "https://upload.test/blob?sig=signed-secret",
        **payload,
    })])

    with pytest.raises(UpstreamHTTPError) as captured:
        backend.upload_chat_attachment_bytes(
            b"%PDF-1.7",
            "sample.pdf",
            "application/pdf",
            "document",
        )

    assert captured.value.status_code == 502
    assert signed_calls == []
    assert [method for method, _url, _kwargs in session.calls] == ["post"]
    assert "file-secret" not in str(captured.value)
    assert "signed-secret" not in str(captured.value)


@pytest.mark.parametrize("payload", [{"status": "failed"}, {"success": False}])
def test_unsuccessful_confirmation_response_does_not_return_pointer(
    signed_upload: _SignedUploadTransport,
    payload: dict[str, Any],
) -> None:
    backend, session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
        }),
        _FakeResponse(payload=payload),
    ])
    signed_upload.responses.append(_FakeResponse(status_code=201))

    with pytest.raises(UpstreamHTTPError) as captured:
        backend.upload_chat_attachment_bytes(
            b"%PDF-1.7",
            "sample.pdf",
            "application/pdf",
            "document",
        )

    assert captured.value.status_code == 502
    assert [method for method, _url, _kwargs in session.calls] == ["post", "post"]
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


def test_signed_upload_network_error_is_sanitized(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, _session = _backend([_FakeResponse(payload={
        "file_id": "file-secret",
        "upload_url": "https://upload.test/blob?sig=signed-secret",
    })])
    signed_upload.error = RuntimeError(
        "signed upload failed for https://upload.test/blob?sig=signed-secret"
    )

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
