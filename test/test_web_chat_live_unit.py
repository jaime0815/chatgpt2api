from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


_SPEC = importlib.util.spec_from_file_location(
    "web_chat_live",
    Path(__file__).with_name("test_web_chat_live.py"),
)
assert _SPEC and _SPEC.loader
live = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = live
_SPEC.loader.exec_module(live)


class _Response:
    status_code = 200
    headers = {"content-type": "text/event-stream"}

    def __init__(self, text: str) -> None:
        self.text = text


def _stream(*frames: str) -> _Response:
    return _Response("\n\n".join(frames) + "\n\n")


def _stop_chunk() -> str:
    return 'data: {"choices":[{"finish_reason":"stop"}]}'


def _error(code: str) -> str:
    return f'event: error\ndata: {{"error":{{"code":"{code}"}}}}'


def test_text_success_rejects_malformed_error_event() -> None:
    response = _stream(
        _stop_chunk(),
        "event: error\ndata: not-json",
        "data: [DONE]",
    )

    with pytest.raises(AssertionError, match="error"):
        live._assert_completed_text_stream(response)


def test_text_success_rejects_mixed_unusable_and_unexpected_errors() -> None:
    response = _stream(
        _stop_chunk(),
        _error("no_available_text_account"),
        _error("upstream_error"),
        "data: [DONE]",
    )

    with pytest.raises(AssertionError, match="unexpected"):
        live._assert_completed_text_stream(response)


def test_attachment_guard_only_xfails_the_exact_known_unavailable_code() -> None:
    response = _stream(
        _error("attachment_unavailable"),
        _error("upstream_error"),
        "data: [DONE]",
    )

    with pytest.raises(AssertionError, match="unexpected"):
        live._assert_native_attachment_stream_or_xfail(response, "mixed")


def test_follow_up_payload_replays_the_attachment_message_in_full_history() -> None:
    target = live._LiveChatTarget(
        stream_url="https://example.invalid/api/chat/stream",
        authorization="Bearer test",
        model="auto",
        timeout_seconds=10,
    )
    attachment = live._Attachment(
        file_name="sample.pdf",
        mime_type="application/pdf",
        data=b"%PDF",
        sha256="a" * 64,
    )

    payload = live._request_payload(
        target,
        "What was attached?",
        [attachment],
        prior_messages=[
            {
                "id": "live-message-1",
                "role": "user",
                "text": "Please inspect the PDF.",
                "attachment_ids": ["live-attachment-1"],
            },
            {
                "id": "live-assistant-1",
                "role": "assistant",
                "text": "I am ready for a follow-up.",
                "attachment_ids": [],
            },
        ],
        attach_to_current_message=False,
    )

    assert payload["messages"] == [
        {
            "id": "live-message-1",
            "role": "user",
            "text": "Please inspect the PDF.",
            "attachment_ids": ["live-attachment-1"],
        },
        {
            "id": "live-assistant-1",
            "role": "assistant",
            "text": "I am ready for a follow-up.",
            "attachment_ids": [],
        },
        {
            "id": "live-message-3",
            "role": "user",
            "text": "What was attached?",
            "attachment_ids": [],
        },
    ]
