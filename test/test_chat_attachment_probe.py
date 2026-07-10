from __future__ import annotations

import json
import os
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
                    "file_id": "file-real-secret",
                    "upload_url": "https://example.blob.core.windows.net/a?sv=1&sig=secret",
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


def test_validator_rejects_leftover_sensitive_response_identifier() -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = {
        "capture_kind": "real_upstream",
        "create_file": {
            "request": {
                "method": "POST",
                "path": "/backend-api/files",
                "body": {"file_name": "sample.pdf"},
            },
            "response": {
                "status_code": 200,
                "body": {"file_id": "<file-id-redacted>"},
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
            "response": {
                "status_code": 201,
                "headers": {"x-operation-id": "opaque.operation/id:+=="},
            },
        },
        "uploaded_confirmation": {"response": {"status_code": 200}},
        "processing_status": [{"stage": "process_upload_stream", "status": "file.processing.metadata"}],
        "conversation": {
            "content_part": {"content_type": "text", "parts": ["Inspect the PDF."]},
            "metadata_attachment": {"mime_type": "application/pdf"},
            "response": {"status_code": 200, "event_count": 1},
        },
    }

    with pytest.raises(ProbeFailed, match="sensitive response identifiers"):
        _validate_fixture(fixture)


def test_direct_cli_reports_missing_account_as_blocked() -> None:
    script = Path(__file__).parents[1] / "scripts" / "probe_chat_file_attachment.py"
    with tempfile.NamedTemporaryFile(prefix="chat-attachment-probe-", suffix=".pdf", dir="/tmp") as pdf:
        pdf.write(b"%PDF-1.4\n%%EOF\n")
        pdf.flush()
        env = os.environ.copy()
        env["CHAT_ATTACHMENT_PROBE_PDF"] = pdf.name
        env.pop("CHAT_ATTACHMENT_PROBE_ACCESS_TOKEN", None)
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=script.parents[1],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    assert result.returncode == 2
    assert "BLOCKED: configure a text account" in result.stderr
    assert "ModuleNotFoundError" not in result.stderr
