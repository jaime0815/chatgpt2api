from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest


FIXTURE = Path(__file__).parent / "fixtures" / "chat_file_attachment" / "pdf-upload.json"


def _load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _walk_strings(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [item for nested in value.values() for item in _walk_strings(nested)]
    if isinstance(value, list):
        return [item for nested in value for item in _walk_strings(nested)]
    return [value] if isinstance(value, str) else []


def test_pdf_fixture_contains_complete_native_attachment_contract() -> None:
    fixture = _load_fixture()

    create_file = fixture["create_file"]
    assert create_file["request"]["method"] == "POST"
    assert create_file["request"]["path"] == "/backend-api/files"
    assert create_file["request"]["body"]["file_name"] == "sample.pdf"
    assert create_file["request"]["body"]["file_size"] > 0
    assert create_file["response"]["status_code"] in {200, 201}
    assert create_file["response"]["body"]["file_id"] == "<file-id-redacted>"

    blob_upload = fixture["blob_upload"]
    assert blob_upload["request"]["method"] == "PUT"
    assert blob_upload["request"]["url"] == "<signed-upload-url-redacted>"
    upload_headers = {key.lower(): value for key, value in blob_upload["request"]["headers"].items()}
    assert upload_headers["content-type"] == "application/pdf"
    assert upload_headers["x-ms-blob-type"] == "BlockBlob"
    assert upload_headers["x-ms-version"]
    assert blob_upload["response"]["status_code"] in {200, 201}

    confirmation = fixture["uploaded_confirmation"]
    assert confirmation["request"]["method"] == "POST"
    assert confirmation["request"]["path"] == "/backend-api/files/<file-id-redacted>/uploaded"
    assert confirmation["response"]["status_code"] in {200, 201}

    conversation = fixture["conversation"]
    assert conversation["request"]["method"] == "POST"
    assert conversation["request"]["path"] in {
        "/backend-api/conversation",
        "/backend-api/f/conversation",
    }
    content_part = conversation["content_part"]
    assert content_part["content_type"] != "image_asset_pointer"
    metadata_attachment = conversation["metadata_attachment"]
    assert metadata_attachment["mime_type"] == "application/pdf"
    assert metadata_attachment["name"] == "sample.pdf"
    assert metadata_attachment["id"] == "<file-id-redacted>"

    processing_status = fixture["processing_status"]
    assert processing_status
    assert all({"stage", "status"} <= item.keys() for item in processing_status)


def test_pdf_fixture_contains_no_credentials_or_live_signed_urls() -> None:
    strings = _walk_strings(_load_fixture())
    joined = "\n".join(strings)

    assert not re.search(r"\bBearer\s+[A-Za-z0-9._~-]+", joined, re.IGNORECASE)
    assert not re.search(r"(?:^|[?&])(?:sig|se|sp|sv|skt|ske|sks|skv)=", joined, re.IGNORECASE)
    assert not re.search(r"https://[^\s]+(?:blob\.core\.windows\.net|files\.oaiusercontent\.com)", joined)
    assert not re.search(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}", joined)
    assert "authorization" not in {key.lower() for key in _all_keys(_load_fixture())}


def _all_keys(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [
            *[str(key) for key in value],
            *[item for nested in value.values() for item in _all_keys(nested)],
        ]
    if isinstance(value, list):
        return [item for nested in value for item in _all_keys(nested)]
    return []


def _valid_sanitized_fixture() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "capture_kind": "real_upstream",
        "captured_at": "2026-07-10T00:00:00+00:00",
        "create_file": {
            "request": {
                "method": "POST",
                "path": "/backend-api/files",
                "headers": {"Content-Type": "application/json"},
                "body": {
                    "file_name": "sample.pdf",
                    "file_size": 321,
                    "mime_type": "application/pdf",
                    "use_case": "multimodal",
                },
            },
            "response": {
                "status_code": 200,
                "body": {
                    "status": "success",
                    "file_id": "<file-id-redacted>",
                    "upload_url": "<signed-upload-url-redacted>",
                    "library_file_id": "<library-file-id-redacted>",
                },
            },
        },
        "blob_upload": {
            "request": {
                "method": "PUT",
                "url": "<signed-upload-url-redacted>",
                "headers": {
                    "Content-Type": "application/pdf",
                    "x-ms-blob-type": "BlockBlob",
                    "x-ms-version": "2020-04-08",
                },
            },
            "response": {"status_code": 201},
        },
        "uploaded_confirmation": {
            "request": {
                "method": "POST",
                "path": "/backend-api/files/<file-id-redacted>/uploaded",
                "headers": {"Content-Type": "application/json"},
                "body": {},
            },
            "response": {
                "status_code": 200,
                "body": {"status": "success", "file_id": "<file-id-redacted>"},
            },
        },
        "processing": {
            "request": {
                "method": "POST",
                "path": "/backend-api/files/process_upload_stream",
                "headers": {"Content-Type": "application/json"},
                "body": {
                    "file_id": "<file-id-redacted>",
                    "file_name": "sample.pdf",
                    "use_case": "multimodal",
                    "index_for_retrieval": True,
                    "entry_surface": "composer",
                },
            },
            "response": {
                "status_code": 200,
                "events": [
                    {
                        "event": "file.processing.metadata",
                        "progress": 100,
                        "extra": {
                            "mime_type": "application/pdf",
                            "total_tokens": 42,
                            "metadata_object_id": "<library-file-id-redacted>",
                        },
                    }
                ],
            },
        },
        "processing_status": [
            {"stage": "process_upload_stream", "status": "file.processing.metadata", "progress": 100}
        ],
        "conversation": {
            "request": {"method": "POST", "path": "/backend-api/conversation"},
            "content_part": {"content_type": "text", "parts": ["Inspect the PDF."]},
            "metadata_attachment": {
                "id": "<file-id-redacted>",
                "name": "sample.pdf",
                "mime_type": "application/pdf",
                "size": 321,
                "is_big_paste": False,
                "library_file_id": "<library-file-id-redacted>",
            },
            "response": {
                "status_code": 200,
                "event_count": 1,
                "event_summaries": [
                    {
                        "conversation_id": "<conversation-id-redacted>",
                        "message_id": "<message-id-redacted>",
                    }
                ],
            },
        },
    }


def test_sanitizer_replaces_live_identifiers_and_signed_upload_url() -> None:
    from scripts.probe_chat_file_attachment import build_sanitized_fixture

    raw_capture = {
        "captured_at": "2026-07-10T00:00:00+00:00",
        "create_file": {
            "request": {
                "method": "POST",
                "path": "/backend-api/files",
                "headers": {"Content-Type": "application/json"},
                "body": {
                    "file_name": "sample.pdf",
                    "file_size": 321,
                    "mime_type": "application/pdf",
                    "use_case": "multimodal",
                },
            },
            "response": {
                "status_code": 200,
                "headers": {
                    "X-Request-Id": "req_01JZ/opaque+value==.7f",
                    "Traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                },
                "body": {
                    "status": (
                        "success; diagnostic=https://storage.invalid/upload"
                        "?x-amz-credential=embedded-credential"
                        "&x-amz-signature=embedded-secret-value "
                        "gcs=https://storage.googleapis.com/bucket/object"
                        "?X-Goog-Algorithm=GOOG4-RSA-SHA256"
                        "&X-Goog-Credential=service-account%40example.invalid"
                        "&X-Goog-Signature=gcs-secret-value end"
                    ),
                    "file_id": "file-real-secret",
                    "upload_url": "https://example.blob.core.windows.net/a?sv=1&sig=secret",
                    "sessionToken": "session-token-must-not-survive",
                    "auth_token": "auth-token-must-not-survive",
                },
            },
        },
        "blob_upload": {
            "request": {
                "method": "PUT",
                "url": "https://example.blob.core.windows.net/a?sv=1&sig=secret",
                "headers": {
                    "Content-Type": "application/pdf",
                    "x-ms-blob-type": "BlockBlob",
                    "x-ms-version": "2020-04-08",
                    "Authorization": "Bearer must-not-survive",
                },
            },
            "response": {
                "status_code": 201,
                "headers": {
                    "ETag": "W/\"0x8DBopaque:+/==\"",
                    "x-ms-request-id": "7c1ef2d1-701e-0047-5f29-f0c057000000",
                    "x-ms-version-id": "3LgOpa/que+Version==",
                    "x-ms-blob-id": "blob::opaque/+/identifier==",
                },
            },
        },
        "uploaded_confirmation": {
            "request": {
                "method": "POST",
                "path": "/backend-api/files/file-real-secret/uploaded",
                "body": {},
            },
            "response": {
                "status_code": 200,
                "headers": {"Operation-Id": "op_opaque/+/identifier=="},
                "body": {"status": "success"},
            },
        },
        "processing": {
            "request": {
                "method": "POST",
                "path": "/backend-api/files/process_upload_stream",
                "body": {"file_id": "file-real-secret", "file_name": "sample.pdf"},
            },
            "response": {
                "status_code": 200,
                "events": [
                    {
                        "event": "file.processing.started",
                        "progress": 10,
                        "trace_id": "trace_opaque/+/identifier==",
                    },
                    {
                        "event": "file.processing.metadata",
                        "progress": 100,
                        "extra": {
                            "mime_type": "application/pdf",
                            "total_tokens": 42,
                            "version_id": "version_opaque/+/identifier==",
                            "sessionToken": "processing-session-secret",
                        },
                    },
                ],
            },
        },
        "conversation": {
            "request": {
                "method": "POST",
                "path": "/backend-api/conversation",
                "body": {
                    "messages": [
                        {
                            "id": "message-real-secret",
                            "content": {"content_type": "text", "parts": ["Inspect the PDF."]},
                            "metadata": {
                                "attachments": [
                                    {
                                        "id": "file-real-secret",
                                        "name": "sample.pdf",
                                        "mime_type": "application/pdf",
                                        "size": 321,
                                        "auth_token": "attachment-auth-secret",
                                    }
                                ]
                            },
                        }
                    ],
                    "parent_message_id": "parent-real-secret",
                },
            },
            "response": {
                "status_code": 200,
                "events": [
                    {
                        "conversation_id": "conversation-real-secret",
                        "request_id": "req_conversation/+/opaque==",
                        "message": {"id": "reply-real-secret"},
                    }
                ],
            },
        },
    }

    fixture = build_sanitized_fixture(raw_capture)
    serialized = json.dumps(fixture, sort_keys=True)

    assert fixture["create_file"]["response"]["body"]["file_id"] == "<file-id-redacted>"
    assert fixture["blob_upload"]["request"]["url"] == "<signed-upload-url-redacted>"
    assert fixture["conversation"]["content_part"]["content_type"] == "text"
    assert fixture["conversation"]["metadata_attachment"]["mime_type"] == "application/pdf"
    assert [item["status"] for item in fixture["processing_status"]] == [
        "file.processing.started",
        "file.processing.metadata",
    ]
    assert "file-real-secret" not in serialized
    assert "conversation-real-secret" not in serialized
    assert "message-real-secret" not in serialized
    assert "parent-real-secret" not in serialized
    assert "must-not-survive" not in serialized
    assert "sig=secret" not in serialized
    assert "embedded-secret-value" not in serialized
    assert "gcs-secret-value" not in serialized
    assert "processing-session-secret" not in serialized
    assert "attachment-auth-secret" not in serialized
    assert "sessionToken" not in _all_keys(fixture)
    assert "auth_token" not in _all_keys(fixture)
    assert "<signed-upload-url-redacted>" in fixture["create_file"]["response"]["body"]["status"]
    for opaque_identifier in (
        "req_01JZ/opaque+value==.7f",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "W/\"0x8DBopaque:+/==\"",
        "7c1ef2d1-701e-0047-5f29-f0c057000000",
        "3LgOpa/que+Version==",
        "blob::opaque/+/identifier==",
        "op_opaque/+/identifier==",
        "trace_opaque/+/identifier==",
        "version_opaque/+/identifier==",
        "req_conversation/+/opaque==",
    ):
        assert opaque_identifier not in serialized


def test_sanitizer_redacts_complete_url_safe_bearer_token() -> None:
    from scripts.probe_chat_file_attachment import _redact_string

    assert (
        _redact_string("Bearer abc+VERYSECRETPART/==", {})
        == "<credential-redacted>"
    )


def test_sanitizer_redacts_uuidv7() -> None:
    from scripts.probe_chat_file_attachment import _redact_string

    assert (
        _redact_string("request_01890f4e-7b2a-7cc0-98c4-dc0c0c07398f_trace", {})
        == "request_<uuid-redacted>_trace"
    )


def test_validator_rejects_leftover_sensitive_response_identifier() -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["blob_upload"]["response"]["headers"] = {
        "x-operation-id": "opaque.operation/id:+=="
    }

    with pytest.raises(ProbeFailed, match="sensitive response identifiers"):
        _validate_fixture(fixture)


def test_validator_rejects_unknown_credential_key() -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["create_file"]["response"]["body"]["sessionToken"] = "opaque-session-secret"

    with pytest.raises(ProbeFailed, match="credential"):
        _validate_fixture(fixture)


def test_validator_rejects_credential_placeholder_suffix() -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["create_file"]["response"]["body"]["status"] = (
        "<credential-redacted>+VERYSECRETPART/=="
    )

    with pytest.raises(ProbeFailed, match="credential"):
        _validate_fixture(fixture)


def test_validator_rejects_uuidv7_in_allowed_string() -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["create_file"]["response"]["body"]["status"] = (
        "success request_01890f4e-7b2a-7cc0-98c4-dc0c0c07398f_trace"
    )

    with pytest.raises(ProbeFailed, match="identifier"):
        _validate_fixture(fixture)


@pytest.mark.parametrize(
    ("path", "failure_status"),
    [
        (("processing", "response", "events", 0, "status"), "failed"),
        (("processing", "response", "events", 0, "status"), "file.processing.error"),
        (("processing_status", 0, "status"), "cancelled"),
    ],
)
def test_validator_rejects_processing_terminal_statuses(
    path: tuple[str | int, ...],
    failure_status: str,
) -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    target: Any = fixture
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = failure_status

    with pytest.raises(ProbeFailed, match="terminal failure"):
        _validate_fixture(fixture)


@pytest.mark.parametrize(
    ("path", "raw_value"),
    [
        (("create_file", "response", "body", "library_file_id"), "library-live-secret"),
        (("uploaded_confirmation", "response", "body", "file_id"), "file-live-secret"),
        (("processing", "request", "body", "file_id"), "file-live-secret"),
        (
            ("processing", "response", "events", 0, "extra", "metadata_object_id"),
            "metadata-live-secret",
        ),
        (("conversation", "metadata_attachment", "library_file_id"), "library-live-secret"),
        (
            ("conversation", "response", "event_summaries", 0, "conversation_id"),
            "conversation-live-secret",
        ),
        (
            ("conversation", "response", "event_summaries", 0, "message_id"),
            "message-live-secret",
        ),
        (
            ("create_file", "response", "body", "status"),
            "success 550e8400-e29b-41d4-a716-446655440000",
        ),
        (
            ("create_file", "response", "body", "library_file_id"),
            {"unexpected": "object"},
        ),
    ],
)
def test_validator_rejects_raw_identifiers_in_allowed_fields(
    path: tuple[str | int, ...],
    raw_value: Any,
) -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    target: Any = fixture
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = raw_value

    with pytest.raises(ProbeFailed, match="identifier|redacted"):
        _validate_fixture(fixture)


def test_validator_rejects_embedded_signed_url_independently() -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["create_file"]["response"]["body"]["status"] = (
        "failed: https://storage.invalid/a?x-amz-credential=opaque&x-amz-signature=secret"
    )

    with pytest.raises(ProbeFailed, match="credential or signed URL"):
        _validate_fixture(fixture)


def test_validator_rejects_invalid_fixture_under_python_optimized_mode() -> None:
    fixture = _valid_sanitized_fixture()
    fixture["capture_kind"] = "forged"
    script = """
import json
import sys
from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

fixture = json.loads(sys.stdin.read())
try:
    _validate_fixture(fixture)
except ProbeFailed:
    raise SystemExit(0)
raise SystemExit(9)
"""
    result = subprocess.run(
        [sys.executable, "-O", "-c", script],
        cwd=Path(__file__).parents[1],
        input=json.dumps(fixture),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_cli_reports_missing_account_without_reading_real_pool(monkeypatch, capsys) -> None:
    from scripts import probe_chat_file_attachment as probe

    monkeypatch.setattr(
        probe,
        "_select_access_token",
        lambda: pytest.fail("real account pool must not be read by this test"),
    )
    with tempfile.NamedTemporaryFile(prefix="chat-attachment-probe-", suffix=".pdf", dir="/tmp") as pdf:
        pdf.write(b"%PDF-1.4\n%%EOF\n")
        pdf.flush()
        monkeypatch.setenv("CHAT_ATTACHMENT_PROBE_PDF", pdf.name)
        result = probe.main(token_selector=lambda: "")

    captured = capsys.readouterr()
    assert result == 2
    assert "BLOCKED: configure a text account" in captured.err
    assert "ModuleNotFoundError" not in captured.err


def test_non_2xx_records_raw_stage_and_cli_prints_safe_diagnostics(monkeypatch, capsys) -> None:
    from scripts import probe_chat_file_attachment as probe

    class FakeResponse:
        status_code = 503
        headers = {"X-Request-Id": "request-secret"}
        text = ""

        @staticmethod
        def json() -> dict[str, Any]:
            return {
                "error": "upstream unavailable",
                "sessionToken": "raw-session-secret",
                "debug": "https://storage.invalid/a?sig=raw-signed-secret",
            }

    class FakeSession:
        @staticmethod
        def post(*args, **kwargs) -> FakeResponse:
            return FakeResponse()

    class FakeClient:
        base_url = "https://chatgpt.com"
        session = FakeSession()

        @staticmethod
        def _headers(path: str, extra: dict[str, str]) -> dict[str, str]:
            return dict(extra)

        @staticmethod
        def close() -> None:
            return None

    with tempfile.NamedTemporaryFile(prefix="chat-attachment-probe-", suffix=".pdf", dir="/tmp") as pdf:
        pdf.write(b"%PDF-1.4\n%%EOF\n")
        pdf.flush()
        monkeypatch.setenv("CHAT_ATTACHMENT_PROBE_PDF", pdf.name)
        result = probe.main(
            token_selector=lambda: "isolated-test-token",
            client_factory=lambda token: FakeClient(),
        )

    captured = capsys.readouterr()
    assert result == 1
    assert "FAILED: stage=create_file status=503 raw_capture=/tmp/" in captured.err
    assert "raw-session-secret" not in captured.err
    assert "raw-signed-secret" not in captured.err
    raw_match = re.search(r"raw_capture=(/tmp/[^\s]+\.json)", captured.err)
    assert raw_match is not None
    raw_path = Path(raw_match.group(1))
    try:
        raw_capture = json.loads(raw_path.read_text(encoding="utf-8"))
        assert raw_capture["failure"]["stage"] == "create_file"
        assert raw_capture["failure"]["status_code"] == 503
        assert raw_capture["create_file"]["response"]["status_code"] == 503
    finally:
        raw_path.unlink(missing_ok=True)


def test_malformed_create_response_reports_create_stage(monkeypatch, capsys) -> None:
    from scripts import probe_chat_file_attachment as probe

    class FakeResponse:
        status_code = 200
        headers: dict[str, str] = {}

        @staticmethod
        def json() -> dict[str, Any]:
            return {"file_id": "file-real-secret"}

    class FakeSession:
        @staticmethod
        def post(*args, **kwargs) -> FakeResponse:
            return FakeResponse()

    class FakeClient:
        base_url = "https://chatgpt.com"
        session = FakeSession()

        @staticmethod
        def _headers(path: str, extra: dict[str, str]) -> dict[str, str]:
            return dict(extra)

        @staticmethod
        def close() -> None:
            return None

    with tempfile.NamedTemporaryFile(prefix="chat-attachment-probe-", suffix=".pdf", dir="/tmp") as pdf:
        pdf.write(b"%PDF-1.4\n%%EOF\n")
        pdf.flush()
        monkeypatch.setenv("CHAT_ATTACHMENT_PROBE_PDF", pdf.name)
        result = probe.main(
            token_selector=lambda: "isolated-test-token",
            client_factory=lambda token: FakeClient(),
        )

    captured = capsys.readouterr()
    assert result == 1
    assert "FAILED: stage=create_file status=unknown raw_capture=/tmp/" in captured.err
    raw_match = re.search(r"raw_capture=(/tmp/[^\s]+\.json)", captured.err)
    assert raw_match is not None
    raw_path = Path(raw_match.group(1))
    try:
        raw_capture = json.loads(raw_path.read_text(encoding="utf-8"))
        assert raw_capture["failure"] == {"stage": "create_file", "status_code": None}
    finally:
        raw_path.unlink(missing_ok=True)


def test_processing_failure_status_stops_live_probe(monkeypatch, capsys) -> None:
    from scripts import probe_chat_file_attachment as probe

    class FakeResponse:
        headers: dict[str, str] = {}
        text = ""

        def __init__(
            self,
            status_code: int,
            *,
            body: dict[str, Any] | None = None,
            events: list[dict[str, Any]] | None = None,
        ) -> None:
            self.status_code = status_code
            self._body = body or {}
            self._events = events or []

        def json(self) -> dict[str, Any]:
            return self._body

        def iter_lines(self) -> list[bytes]:
            return [
                f"data: {json.dumps(event)}".encode("utf-8")
                for event in self._events
            ]

        def close(self) -> None:
            return None

    class FakeSession:
        @staticmethod
        def post(url: str, *args, **kwargs) -> FakeResponse:
            if url.endswith("/backend-api/files"):
                return FakeResponse(
                    200,
                    body={
                        "file_id": "file-real-secret",
                        "upload_url": "https://storage.invalid/upload?sig=secret",
                    },
                )
            if url.endswith("/uploaded"):
                return FakeResponse(200, body={"status": "success"})
            if url.endswith("/process_upload_stream"):
                return FakeResponse(
                    200,
                    events=[
                        {
                            "event": "file.processing.update",
                            "status": "failed",
                            "progress": 50,
                        }
                    ],
                )
            raise AssertionError(f"unexpected POST {url}")

        @staticmethod
        def put(*args, **kwargs) -> FakeResponse:
            return FakeResponse(201)

    class FakeClient:
        base_url = "https://chatgpt.com"
        user_agent = "fixture-test"
        session = FakeSession()

        @staticmethod
        def _headers(path: str, extra: dict[str, str]) -> dict[str, str]:
            return dict(extra)

        @staticmethod
        def close() -> None:
            return None

    with tempfile.NamedTemporaryFile(prefix="chat-attachment-probe-", suffix=".pdf", dir="/tmp") as pdf:
        pdf.write(b"%PDF-1.4\n%%EOF\n")
        pdf.flush()
        monkeypatch.setenv("CHAT_ATTACHMENT_PROBE_PDF", pdf.name)
        result = probe.main(
            token_selector=lambda: "isolated-test-token",
            client_factory=lambda token: FakeClient(),
        )

    captured = capsys.readouterr()
    assert result == 1
    raw_match = re.search(r"raw_capture=(/tmp/[^\s]+\.json)", captured.err)
    assert raw_match is not None
    raw_path = Path(raw_match.group(1))
    try:
        assert "FAILED: stage=process_upload_stream status=unknown raw_capture=/tmp/" in captured.err
        raw_capture = json.loads(raw_path.read_text(encoding="utf-8"))
        assert raw_capture["failure"] == {
            "stage": "process_upload_stream",
            "status_code": None,
        }
    finally:
        raw_path.unlink(missing_ok=True)
