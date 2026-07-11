from __future__ import annotations

import hashlib
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from typing import Any

import pytest
from PIL import Image

from services.chat_attachments import ChatAttachmentUploader
from services.chat_stream_service import ChatStreamSession
from services.chat_types import ChatAttachmentBlob, ChatMessage, ChatStreamCommand
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
        self.sessions: list[_TransientUploadSession] = []
        self.error: Exception | None = None
        self.block = False

    def create_session(self, **kwargs: Any) -> _TransientUploadSession:
        session = _TransientUploadSession(self, kwargs)
        session.block = self.block
        self.sessions.append(session)
        return session

    @property
    def calls(self) -> list[tuple[str, dict[str, Any]]]:
        return [
            (url, kwargs)
            for session in self.sessions
            for method, url, kwargs in session.calls
            if method == "put"
        ]


class _TransientUploadSession:
    def __init__(self, transport: _SignedUploadTransport, session_kwargs: dict[str, Any]) -> None:
        self.transport = transport
        self.session_kwargs = session_kwargs
        self.headers = {
            "Authorization": "Bearer transient-credential",
            "Cookie": "transient-cookie=secret",
        }
        self.cookies = {"transient-cookie": "secret"}
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.closed = False
        self.close_calls = 0
        self.started = threading.Event()
        self.released = threading.Event()
        self.block = False

    def __enter__(self) -> _TransientUploadSession:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def request(self, method: str, url: str, **kwargs: Any) -> _FakeResponse:
        return self.put(url, method=method, **kwargs)

    def put(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append(("put", url, kwargs))
        self.started.set()
        if self.block:
            self.released.wait(timeout=5)
            if self.closed:
                raise RuntimeError("signed upload session closed")
        if self.transport.error is not None:
            raise self.transport.error
        return self.transport.responses.pop(0)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.close_calls += 1
        self.released.set()


@pytest.fixture
def signed_upload(monkeypatch: pytest.MonkeyPatch) -> _SignedUploadTransport:
    transport = _SignedUploadTransport()
    monkeypatch.setattr("services.openai_backend_api.requests.Session", transport.create_session)
    return transport


def _backend(responses: list[_FakeResponse]) -> tuple[OpenAIBackendAPI, _FakeSession]:
    backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
    session = _FakeSession(responses)
    backend.base_url = "https://chatgpt.test"
    backend.session = session
    backend.user_agent = "test-agent"
    backend.access_token = "test-token"
    backend._session_kwargs = {"impersonate": "chrome110", "verify": True}
    backend._active_response_lock = threading.Lock()
    backend._active_stream_response = None
    backend._active_attachment_upload_sessions = {}
    backend._closed = False
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


class _SingleAccountProvider:
    def get_text_access_token(self, _excluded_tokens: set[str] | None = None) -> str:
        return "test-token"

    def refresh_access_token(self, access_token: str, **_kwargs: Any) -> str:
        return access_token

    def remove_invalid_token(self, _access_token: str, _event: str, quiet: bool = False) -> bool:
        return True

    def mark_text_used(self, _access_token: str) -> None:
        return None


def test_document_upload_processes_before_conversation(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
            "library_file_id": "creation-library-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success",'
            b'"extra":{"metadata_object_id":"processing-library-secret",'
            b'"total_tokens":42,"mime_type":"application/processed-pdf"}}',
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
                "mime_type": "application/processed-pdf",
                "size": 8,
                "is_big_paste": False,
                "library_file_id": "processing-library-secret",
                "file_token_size": 42,
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
    assert [item.session_kwargs for item in signed_upload.sessions] == [{
        "impersonate": "chrome110",
        "verify": True,
    }]
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


def test_document_processing_metadata_does_not_fall_back_to_creation_id(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, _session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
            "library_file_id": "creation-library-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success"}',
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

    metadata = uploaded["metadata_attachment"]
    assert "library_file_id" not in metadata
    assert "file_token_size" not in metadata
    assert metadata["mime_type"] == "application/pdf"


def test_document_processing_merges_metadata_from_multiple_final_events(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, _session = _backend([
        _FakeResponse(payload={
            "file_id": "file-secret",
            "upload_url": "https://upload.test/blob?sig=signed-secret",
        }),
        _FakeResponse(payload={"status": "success"}),
        _FakeResponse(lines=[
            b'data: {"event":"file.processing.completed","status":"success",'
            b'"extra":{"metadata_object_id":"processing-library-secret","total_tokens":42}}',
            b'data: {"event":"file.processing.completed","status":"success",'
            b'"extra":{"mime_type":"application/processed-pdf"}}',
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

    assert uploaded["metadata_attachment"] == {
        "id": "file-secret",
        "name": "sample.pdf",
        "mime_type": "application/processed-pdf",
        "size": 8,
        "is_big_paste": False,
        "library_file_id": "processing-library-secret",
        "file_token_size": 42,
    }


def test_chat_session_cancel_closes_blocking_attachment_upload(
    signed_upload: _SignedUploadTransport,
) -> None:
    backend, _main_session = _backend([_FakeResponse(payload={
        "file_id": "file-secret",
        "upload_url": "https://upload.test/blob?sig=signed-secret",
    })])
    signed_upload.block = True
    signed_upload.responses.append(_FakeResponse(status_code=201))
    attachment = _attachment()
    command = ChatStreamCommand(
        model="gpt-5.5",
        messages=(ChatMessage("message-1", "user", "Read the file.", (attachment.id,)),),
        attachments=(attachment,),
        thinking_effort="",
    )
    chat_session = ChatStreamSession(
        command,
        account_provider=_SingleAccountProvider(),
        backend_factory=lambda _token: backend,
    )

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(lambda: list(chat_session))
        try:
            deadline = time.monotonic() + 1
            while not signed_upload.sessions and time.monotonic() < deadline:
                time.sleep(0.01)
            assert signed_upload.sessions
            upload_session = signed_upload.sessions[0]
            assert upload_session.started.wait(timeout=1)
            chat_session.cancel()
            assert upload_session.closed
            assert backend._closed
            assert pending.result(timeout=1) == []
        finally:
            for upload_session in signed_upload.sessions:
                upload_session.released.set()
            chat_session.close()

    assert signed_upload.sessions[0].close_calls == 1


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
    upload_session = signed_upload.sessions[0]
    assert "Authorization" not in upload_session.headers
    assert "Cookie" not in upload_session.headers
    assert upload_session.cookies == {}
    assert upload_session.session_kwargs == {"impersonate": "chrome110", "verify": True}


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


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "failed"},
        {"status": "pending"},
        {"status": "in_progress"},
        {"status": "unknown"},
        {"status": False},
        {"success": False},
        {"success": "false"},
    ],
)
def test_unsuccessful_creation_response_does_not_upload_or_return_pointer(
    signed_upload: _SignedUploadTransport,
    payload: dict[str, Any],
) -> None:
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
    assert signed_upload.sessions == []
    assert [method for method, _url, _kwargs in session.calls] == ["post"]
    assert "file-secret" not in str(captured.value)
    assert "signed-secret" not in str(captured.value)


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "failed"},
        {"status": "pending"},
        {"status": "in_progress"},
        {"status": "unknown"},
        {"status": False},
        {"success": False},
        {"success": "false"},
    ],
)
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
                    "library_file_id": "processing-library-secret",
                    "file_token_size": 42,
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
                    "library_file_id": "processing-library-secret",
                    "file_token_size": 42,
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
