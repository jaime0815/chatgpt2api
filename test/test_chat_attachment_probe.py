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
FIXTURE_SHA256 = "0123456789abcdef" * 4


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
    assert conversation["response"]["done"] is True
    terminal_summaries = [
        summary
        for summary in conversation["response"]["event_summaries"]
        if summary.get("message_role") == "assistant"
        and summary.get("message_status") == "finished_successfully"
    ]
    assert terminal_summaries
    assert terminal_summaries[-1]["message_text"] == "sample.pdf"

    processing_status = fixture["processing_status"]
    assert processing_status
    assert all({"stage", "status"} <= item.keys() for item in processing_status)
    assert fixture["processing"]["response"]["done"] is True


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
                "done": True,
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
                "done": True,
                "event_summaries": [
                    {
                        "conversation_id": "<conversation-id-redacted>",
                        "message_id": "<message-id-redacted>",
                        "message_role": "assistant",
                        "message_status": "finished_successfully",
                        "message_end_turn": True,
                        "message_text": "sample.pdf",
                    }
                ],
            },
        },
    }


def _sse_lines(events: list[dict[str, Any]], *, done: bool) -> list[bytes]:
    lines = [f"data: {json.dumps(event)}".encode("utf-8") for event in events]
    if done:
        lines.append(b"data: [DONE]")
    return lines


class _FakeProbeResponse:
    headers: dict[str, str] = {}
    text = ""

    def __init__(
        self,
        status_code: int,
        *,
        body: dict[str, Any] | None = None,
        lines: list[bytes] | None = None,
    ) -> None:
        self.status_code = status_code
        self._body = body or {}
        self._lines = lines or []

    def json(self) -> dict[str, Any]:
        return self._body

    def iter_lines(self) -> list[bytes]:
        return self._lines

    def close(self) -> None:
        return None


class _FakeProbeSession:
    def __init__(
        self,
        *,
        create_body: dict[str, Any],
        confirmation_body: dict[str, Any],
        processing_lines: list[bytes],
        conversation_lines: list[bytes],
    ) -> None:
        self.create_body = create_body
        self.confirmation_body = confirmation_body
        self.processing_lines = processing_lines
        self.conversation_lines = conversation_lines

    def post(self, url: str, *args, **kwargs) -> _FakeProbeResponse:
        if url.endswith("/backend-api/files"):
            return _FakeProbeResponse(200, body=self.create_body)
        if url.endswith("/uploaded"):
            return _FakeProbeResponse(200, body=self.confirmation_body)
        if url.endswith("/process_upload_stream"):
            return _FakeProbeResponse(200, lines=self.processing_lines)
        if url.endswith("/backend-api/conversation"):
            return _FakeProbeResponse(200, lines=self.conversation_lines)
        raise AssertionError(f"unexpected POST {url}")

    @staticmethod
    def put(*args, **kwargs) -> _FakeProbeResponse:
        return _FakeProbeResponse(201)


class _FakeProbeClient:
    base_url = "https://chatgpt.com"
    user_agent = "fixture-test"

    def __init__(self, session: _FakeProbeSession) -> None:
        self.session = session

    @staticmethod
    def _headers(path: str, extra: dict[str, str]) -> dict[str, str]:
        return dict(extra)

    @staticmethod
    def _bootstrap() -> None:
        return None

    @staticmethod
    def _get_chat_requirements() -> dict[str, Any]:
        return {}

    @staticmethod
    def _conversation_payload(*args, **kwargs) -> dict[str, Any]:
        return {"parent_message_id": "parent-test"}

    @staticmethod
    def _conversation_headers(path: str, requirements: dict[str, Any]) -> dict[str, str]:
        return {"Accept": "text/event-stream", "Content-Type": "application/json"}

    @staticmethod
    def delete_conversation(conversation_id: str) -> None:
        return None

    @staticmethod
    def close() -> None:
        return None


def _successful_processing_events() -> list[dict[str, Any]]:
    return [
        {"event": "file.processing.started", "progress": 10},
        {
            "event": "file.processing.completed",
            "status": "success",
            "progress": 100,
            "extra": {"mime_type": "application/pdf", "total_tokens": 42},
        },
    ]


def _successful_conversation_events(answer: str = "sample.pdf") -> list[dict[str, Any]]:
    return [
        {
            "conversation_id": "conversation-real-secret",
            "message": {
                "id": "reply-real-secret",
                "author": {"role": "assistant"},
                "status": "finished_successfully",
                "end_turn": True,
                "content": {"content_type": "text", "parts": [answer]},
            },
        }
    ]


def _successful_conversation_summary(answer: str = "sample.pdf") -> dict[str, Any]:
    return {
        "conversation_id": "<conversation-id-redacted>",
        "message_id": "<message-id-redacted>",
        "message_role": "assistant",
        "message_status": "finished_successfully",
        "message_end_turn": True,
        "message_text": answer,
    }


def _run_fake_probe(
    monkeypatch,
    capsys,
    tmp_path: Path,
    *,
    create_body: dict[str, Any] | None = None,
    confirmation_body: dict[str, Any] | None = None,
    processing_events: list[dict[str, Any]] | None = None,
    processing_done: bool = True,
    conversation_events: list[dict[str, Any]] | None = None,
    conversation_done: bool = True,
) -> tuple[int, str, dict[str, Any], Path]:
    from scripts import probe_chat_file_attachment as probe

    fixture_path = tmp_path / "pdf-upload.json"
    monkeypatch.setattr(probe, "FIXTURE_PATH", fixture_path)
    session = _FakeProbeSession(
        create_body=create_body
        or {
            "status": "success",
            "file_id": "file-real-secret",
            "upload_url": "https://storage.invalid/upload?sig=secret",
        },
        confirmation_body=confirmation_body
        or {"status": "success", "success": True, "file_id": "file-real-secret"},
        processing_lines=_sse_lines(
            processing_events if processing_events is not None else _successful_processing_events(),
            done=processing_done,
        ),
        conversation_lines=_sse_lines(
            conversation_events if conversation_events is not None else _successful_conversation_events(),
            done=conversation_done,
        ),
    )
    with tempfile.NamedTemporaryFile(prefix="chat-attachment-probe-", suffix=".pdf", dir="/tmp") as pdf:
        pdf.write(b"%PDF-1.4\n%%EOF\n")
        pdf.flush()
        monkeypatch.setenv("CHAT_ATTACHMENT_PROBE_PDF", pdf.name)
        result = probe.main(
            token_selector=lambda: "isolated-test-token",
            client_factory=lambda token: _FakeProbeClient(session),
        )

    captured = capsys.readouterr()
    output = captured.err + captured.out
    raw_match = re.search(r"(?:raw_capture=|raw capture: )(/tmp/[^\s]+\.json)", output)
    assert raw_match is not None
    raw_path = Path(raw_match.group(1))
    try:
        raw_capture = json.loads(raw_path.read_text(encoding="utf-8"))
    finally:
        raw_path.unlink(missing_ok=True)
    return result, captured.err, raw_capture, fixture_path


def test_iter_json_stream_reports_done_marker() -> None:
    from scripts.probe_chat_file_attachment import _iter_json_stream

    event = {"event": "file.processing.completed", "status": "success"}
    response = _FakeProbeResponse(200, lines=_sse_lines([event], done=True))

    assert _iter_json_stream(response) == ([event], True)


@pytest.mark.parametrize("processing_done", [False, True])
def test_processing_requires_success_terminal_and_complete_marker(
    monkeypatch,
    capsys,
    tmp_path: Path,
    processing_done: bool,
) -> None:
    result, stderr, raw_capture, fixture_path = _run_fake_probe(
        monkeypatch,
        capsys,
        tmp_path,
        processing_events=[{"event": "file.processing.started", "progress": 10}],
        processing_done=processing_done,
    )

    assert result == 1
    assert "FAILED: stage=process_upload_stream" in stderr
    assert raw_capture["failure"]["stage"] == "process_upload_stream"
    assert raw_capture["processing"]["response"]["done"] is processing_done
    assert not fixture_path.exists()


@pytest.mark.parametrize(
    ("processing_done", "expected_error"),
    [
        (False, "complete marker"),
        (True, "successful terminal"),
    ],
)
def test_validator_requires_processing_semantic_completion(
    processing_done: bool,
    expected_error: str,
) -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["processing"]["response"]["events"] = [
        {"event": "file.processing.started", "progress": 10}
    ]
    fixture["processing"]["response"]["done"] = processing_done

    with pytest.raises(ProbeFailed, match=expected_error):
        _validate_fixture(fixture)


@pytest.mark.parametrize(
    ("conversation_events", "conversation_done"),
    [
        ([{"conversation_id": "conversation-real-secret", "type": "error"}], True),
        ([{"conversation_id": "conversation-real-secret", "status": "failed"}], True),
        (_successful_conversation_events(), False),
        (
            [
                {
                    "conversation_id": "conversation-real-secret",
                    "message": {
                        "id": "reply-real-secret",
                        "author": {"role": "assistant"},
                        "status": "in_progress",
                        "end_turn": False,
                        "content": {"content_type": "text", "parts": ["sample.pdf"]},
                    },
                }
            ],
            True,
        ),
        (_successful_conversation_events("wrong.pdf"), True),
    ],
)
def test_conversation_requires_successful_expected_answer_and_complete_marker(
    monkeypatch,
    capsys,
    tmp_path: Path,
    conversation_events: list[dict[str, Any]],
    conversation_done: bool,
) -> None:
    result, stderr, raw_capture, fixture_path = _run_fake_probe(
        monkeypatch,
        capsys,
        tmp_path,
        conversation_events=conversation_events,
        conversation_done=conversation_done,
    )

    assert result == 1
    assert "FAILED: stage=conversation" in stderr
    assert raw_capture["failure"]["stage"] == "conversation"
    assert raw_capture["conversation"]["response"]["done"] is conversation_done
    assert not fixture_path.exists()


@pytest.mark.parametrize(
    ("event_summaries", "conversation_done", "expected_error"),
    [
        ([{"type": "error"}], True, "terminal failure"),
        ([{"status": "failed"}], True, "terminal failure"),
        ([_successful_conversation_summary()], False, "complete marker"),
        (
            [
                {
                    **_successful_conversation_summary(),
                    "message_status": "in_progress",
                    "message_end_turn": False,
                }
            ],
            True,
            "successful assistant terminal",
        ),
        ([_successful_conversation_summary("wrong.pdf")], True, "probe answer"),
    ],
)
def test_validator_requires_conversation_semantic_completion(
    event_summaries: list[dict[str, Any]],
    conversation_done: bool,
    expected_error: str,
) -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["conversation"]["response"]["done"] = conversation_done
    fixture["conversation"]["response"]["event_summaries"] = event_summaries

    with pytest.raises(ProbeFailed, match=expected_error):
        _validate_fixture(fixture)


def test_conversation_finish_details_success_writes_fixture(
    monkeypatch,
    capsys,
    tmp_path: Path,
) -> None:
    events = _successful_conversation_events()
    message = events[0]["message"]
    message.pop("status")
    message["metadata"] = {"finish_details": {"type": "finished_successfully"}}

    result, stderr, raw_capture, fixture_path = _run_fake_probe(
        monkeypatch,
        capsys,
        tmp_path,
        conversation_events=events,
    )

    assert result == 0
    assert stderr == ""
    assert "failure" not in raw_capture
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    assert fixture["conversation"]["response"]["done"] is True
    assert fixture["conversation"]["response"]["event_summaries"][-1]["message_status"] == (
        "finished_successfully"
    )


@pytest.mark.parametrize(
    ("expected_stage", "response_overrides"),
    [
        (
            "create_file",
            {
                "create_body": {
                    "status": "failed",
                    "file_id": "file-real-secret",
                    "upload_url": "https://storage.invalid/upload?sig=secret",
                }
            },
        ),
        (
            "uploaded_confirmation",
            {"confirmation_body": {"status": "failed", "success": True}},
        ),
        (
            "uploaded_confirmation",
            {"confirmation_body": {"status": "success", "success": False}},
        ),
        (
            "create_file",
            {
                "create_body": {
                    "status": "pending",
                    "file_id": "file-real-secret",
                    "upload_url": "https://storage.invalid/upload?sig=secret",
                }
            },
        ),
        (
            "uploaded_confirmation",
            {"confirmation_body": {"status": "pending", "success": True}},
        ),
        (
            "uploaded_confirmation",
            {"confirmation_body": {"status": "success", "success": "true"}},
        ),
    ],
)
def test_two_xx_response_body_failure_stops_probe(
    monkeypatch,
    capsys,
    tmp_path: Path,
    expected_stage: str,
    response_overrides: dict[str, Any],
) -> None:
    result, stderr, raw_capture, fixture_path = _run_fake_probe(
        monkeypatch,
        capsys,
        tmp_path,
        **response_overrides,
    )

    assert result == 1
    assert f"FAILED: stage={expected_stage}" in stderr
    assert raw_capture["failure"]["stage"] == expected_stage
    assert not fixture_path.exists()


@pytest.mark.parametrize(
    ("case", "value"),
    [
        ("create_status", "failed"),
        ("create_status", "pending"),
        ("confirmation_status", "failed"),
        ("confirmation_status", "pending"),
        ("confirmation_success", False),
        ("confirmation_success", "true"),
    ],
)
def test_validator_rejects_two_xx_response_body_failure(case: str, value: Any) -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    if case == "create_status":
        fixture["create_file"]["response"]["body"]["status"] = value
    elif case == "confirmation_status":
        fixture["uploaded_confirmation"]["response"]["body"]["status"] = value
    else:
        fixture["uploaded_confirmation"]["response"]["body"]["success"] = value

    with pytest.raises(ProbeFailed, match="semantic failure"):
        _validate_fixture(fixture)


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
                    "sha256": FIXTURE_SHA256,
                },
            },
            "response": {
                "status_code": 200,
                "headers": {
                    "X-Request-Id": "req_01JZ/opaque+value==.7f",
                    "Traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                },
                "body": {
                    "status": "success",
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
                "done": True,
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
                            "library_persistence_reason": (
                                "diagnostic=https://storage.invalid/upload"
                                "?x-amz-credential=embedded-credential"
                                "&x-amz-signature=embedded-secret-value "
                                "gcs=https://storage.googleapis.com/bucket/object"
                                "?X-Goog-Algorithm=GOOG4-RSA-SHA256"
                                "&X-Goog-Credential=service-account%40example.invalid"
                                "&X-Goog-Signature=gcs-secret-value end"
                            ),
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
                                        "sha256": FIXTURE_SHA256,
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
                "done": True,
                "events": [
                    {
                        "conversation_id": "conversation-real-secret",
                        "request_id": "req_conversation/+/opaque==",
                        "message": {
                            "id": "reply-real-secret",
                            "author": {"role": "assistant"},
                            "status": "finished_successfully",
                            "end_turn": True,
                            "content": {"content_type": "text", "parts": ["sample.pdf"]},
                        },
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
    assert fixture["create_file"]["request"]["body"]["sha256"] == FIXTURE_SHA256
    assert fixture["conversation"]["metadata_attachment"]["sha256"] == FIXTURE_SHA256
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
    persistence_reason = fixture["processing"]["response"]["events"][1]["extra"][
        "library_persistence_reason"
    ]
    assert "<signed-upload-url-redacted>" in persistence_reason
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


@pytest.mark.parametrize(
    "opaque_identifier",
    ["ab" * 16, "cd" * 20, "ef" * 32],
)
def test_sanitizer_redacts_contiguous_hex_identifiers(opaque_identifier: str) -> None:
    from scripts.probe_chat_file_attachment import _redact_string

    assert (
        _redact_string(f"trace_{opaque_identifier}_end", {})
        == "trace_<opaque-hex-id-redacted>_end"
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
    "opaque_identifier",
    ["ab" * 16, "cd" * 20, "ef" * 32],
)
def test_validator_rejects_contiguous_hex_identifiers(opaque_identifier: str) -> None:
    from scripts.probe_chat_file_attachment import ProbeFailed, _validate_fixture

    fixture = _valid_sanitized_fixture()
    fixture["create_file"]["response"]["body"]["status"] = (
        f"success trace_{opaque_identifier}_end"
    )

    with pytest.raises(ProbeFailed, match="identifier"):
        _validate_fixture(fixture)


@pytest.mark.parametrize(
    "path",
    [
        ("create_file", "request", "body", "sha256"),
        ("conversation", "metadata_attachment", "sha256"),
    ],
)
def test_validator_allows_explicit_sha256_fields(path: tuple[str, ...]) -> None:
    from scripts.probe_chat_file_attachment import _validate_fixture

    fixture = _valid_sanitized_fixture()
    target: Any = fixture
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = FIXTURE_SHA256

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
