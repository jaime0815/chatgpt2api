from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Iterator
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

import api.app as api_app
import api.chat as chat_module
from services.chat_types import ChatStreamCommand
from services.openai_backend_api import InvalidAccessTokenError
from utils.helper import UpstreamHTTPError


AUTH_HEADERS = {"Authorization": "Bearer ordinary-user-key"}


def _request_payload() -> dict[str, object]:
    return {
        "model": "gpt-5.5",
        "messages": [
            {
                "id": "message-1",
                "role": "user",
                "text": "Hello from the browser",
                "attachment_ids": [],
            }
        ],
        "attachments": [],
        "thinking_effort": "extended",
    }


def _multipart_request(payload: dict[str, object] | None = None):
    return [("request", (None, json.dumps(payload or _request_payload()), "application/json"))]


def _chunk(content: str) -> dict[str, object]:
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "gpt-5.5",
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
    }


def _sse_frames(body: str) -> list[tuple[str, str]]:
    frames: list[tuple[str, str]] = []
    for raw_frame in body.strip().split("\n\n"):
        event = "message"
        data_lines: list[str] = []
        for line in raw_frame.splitlines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].lstrip())
        frames.append((event, "\n".join(data_lines)))
    return frames


class TrackingSession:
    def __init__(self, items: list[dict[str, object] | BaseException]) -> None:
        self.items = items
        self.cancel_calls = 0
        self.close_calls = 0

    def __iter__(self) -> Iterator[dict[str, object]]:
        for item in self.items:
            if isinstance(item, BaseException):
                raise item
            yield item

    def cancel(self) -> None:
        self.cancel_calls += 1

    def close(self) -> None:
        self.close_calls += 1


class SessionFactory:
    def __init__(self, items: list[dict[str, object] | BaseException]) -> None:
        self.items = items
        self.commands: list[ChatStreamCommand] = []
        self.sessions: list[TrackingSession] = []

    def __call__(self, command: ChatStreamCommand) -> TrackingSession:
        self.commands.append(command)
        session = TrackingSession(self.items)
        self.sessions.append(session)
        return session


def _client(factory: SessionFactory) -> TestClient:
    app = FastAPI()
    app.include_router(chat_module.create_router(session_factory=factory))
    return TestClient(app)


def _authenticated_post(client: TestClient):
    identity = {"id": "user-1", "name": "普通用户", "role": "user"}
    with (
        mock.patch.object(chat_module, "require_identity", return_value=identity),
        mock.patch.object(chat_module, "check_request") as check_request,
    ):
        response = client.post(
            "/api/chat/stream",
            headers=AUTH_HEADERS,
            files=_multipart_request(),
        )
    return response, check_request


def test_chat_stream_requires_existing_web_identity_before_parsing() -> None:
    factory = SessionFactory([_chunk("unused")])
    client = _client(factory)

    response = client.post(
        "/api/chat/stream",
        headers={
            "Authorization": "Bearer invalid-key",
            "Content-Type": "application/json",
        },
        content=b"not multipart",
    )

    assert response.status_code == 401
    assert factory.commands == []


def test_chat_stream_validates_multipart_before_starting_session() -> None:
    factory = SessionFactory([_chunk("unused")])
    client = _client(factory)

    with mock.patch.object(
        chat_module,
        "require_identity",
        return_value={"id": "user-1", "name": "普通用户", "role": "user"},
    ):
        response = client.post(
            "/api/chat/stream",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            content=b"{}",
        )

    assert response.status_code == 400
    assert response.json() == {"detail": {"error": "content type must be multipart/form-data"}}
    assert factory.commands == []


def test_chat_stream_filters_text_and_emits_openai_chunks_then_done() -> None:
    first = _chunk("Hello")
    second = _chunk(" world")
    factory = SessionFactory([first, second])

    response, check_request = _authenticated_post(_client(factory))

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache, no-transform"
    assert response.headers["x-accel-buffering"] == "no"
    assert _sse_frames(response.text) == [
        ("message", json.dumps(first, ensure_ascii=False, separators=(",", ":"))),
        ("message", json.dumps(second, ensure_ascii=False, separators=(",", ":"))),
        ("message", "[DONE]"),
    ]
    check_request.assert_called_once_with("Hello from the browser")
    assert factory.commands[0].model == "gpt-5.5"
    assert factory.commands[0].thinking_effort == "extended"
    assert factory.sessions[0].cancel_calls == 1
    assert factory.sessions[0].close_calls == 1


@pytest.mark.parametrize(
    ("error", "message", "error_type", "code"),
    [
        (
            RuntimeError("no available text account"),
            "暂无可用的聊天账号，请稍后重试",
            "rate_limit_error",
            "no_available_text_account",
        ),
        (
            InvalidAccessTokenError("token invalidated: bearer-secret"),
            "聊天账号认证失效，请重试",
            "server_error",
            "upstream_authentication_error",
        ),
        (
            UpstreamHTTPError(
                "https://chatgpt.com/backend-api/conversation?sig=signed-secret",
                429,
                {"file_id": "file-secret", "token": "bearer-secret"},
            ),
            "上游聊天服务繁忙，请稍后重试",
            "rate_limit_error",
            "rate_limit_exceeded",
        ),
        (
            RuntimeError("file-secret sig=signed-secret bearer-secret"),
            "聊天服务暂时不可用，请稍后重试",
            "server_error",
            "upstream_error",
        ),
    ],
)
def test_chat_stream_maps_errors_to_public_sse_then_done(
    error: BaseException,
    message: str,
    error_type: str,
    code: str,
) -> None:
    factory = SessionFactory([_chunk("partial"), error])
    response, _ = _authenticated_post(_client(factory))

    frames = _sse_frames(response.text)
    assert frames[0] == (
        "message",
        json.dumps(_chunk("partial"), ensure_ascii=False, separators=(",", ":")),
    )
    assert frames[-1] == ("message", "[DONE]")
    assert frames[-2][0] == "error"
    assert json.loads(frames[-2][1]) == {
        "error": {
            "message": message,
            "type": error_type,
            "param": None,
            "code": code,
        }
    }
    assert "file-secret" not in response.text
    assert "signed-secret" not in response.text
    assert "bearer-secret" not in response.text
    assert factory.sessions[0].cancel_calls == 1
    assert factory.sessions[0].close_calls == 1


def test_chat_stream_error_logs_only_safe_summary() -> None:
    factory = SessionFactory(
        [RuntimeError("file-secret sig=signed-secret Authorization: Bearer bearer-secret")]
    )
    recorded_logs: list[tuple[tuple[object, ...], dict[str, object]]] = []

    with mock.patch(
        "services.log_service.log_service.add",
        side_effect=lambda *args, **kwargs: recorded_logs.append((args, kwargs)),
    ):
        response, _ = _authenticated_post(_client(factory))

    assert response.status_code == 200
    serialized_logs = repr(recorded_logs)
    assert "RuntimeError" in serialized_logs
    assert "file-secret" not in serialized_logs
    assert "signed-secret" not in serialized_logs
    assert "bearer-secret" not in serialized_logs


def test_content_filter_rejection_happens_before_session_creation() -> None:
    factory = SessionFactory([_chunk("unused")])
    client = _client(factory)

    with (
        mock.patch.object(
            chat_module,
            "require_identity",
            return_value={"id": "user-1", "name": "普通用户", "role": "user"},
        ),
        mock.patch.object(
            chat_module,
            "check_request",
            side_effect=HTTPException(status_code=400, detail={"error": "blocked"}),
        ),
    ):
        response = client.post(
            "/api/chat/stream",
            headers=AUTH_HEADERS,
            files=_multipart_request(),
        )

    assert response.status_code == 400
    assert factory.commands == []


class _RecordingCall:
    def __init__(self) -> None:
        self.records: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def log(self, *args: object, **kwargs: object) -> None:
        self.records.append((args, kwargs))


class _BlockingSession:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.released = threading.Event()
        self.finished = threading.Event()
        self.cancel_calls = 0
        self.close_calls = 0

    def __iter__(self) -> _BlockingSession:
        return self

    def __next__(self) -> dict[str, object]:
        self.started.set()
        self.released.wait(timeout=5)
        self.finished.set()
        raise StopIteration

    def cancel(self) -> None:
        self.cancel_calls += 1
        self.released.set()

    def close(self) -> None:
        self.close_calls += 1


def test_stream_bridge_does_not_compete_for_asgi_disconnect_messages() -> None:
    session = TrackingSession([_chunk("ok")])
    call = _RecordingCall()

    async def collect() -> list[str]:
        return [
            item
            async for item in chat_module.chat_event_stream(
                session,
                call,
            )
        ]

    body = "".join(asyncio.run(collect()))
    assert _sse_frames(body) == [
        (
            "message",
            json.dumps(_chunk("ok"), ensure_ascii=False, separators=(",", ":")),
        ),
        ("message", "[DONE]"),
    ]


def test_response_send_disconnect_closes_session_for_asgi_http_24() -> None:
    session = TrackingSession([_chunk("unused")])
    call = _RecordingCall()
    response = chat_module.chat_stream_response(
        session,
        call,
    )

    async def scenario() -> None:
        disconnected = asyncio.Event()

        async def receive() -> dict[str, str]:
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, object]) -> None:
            if message["type"] == "http.response.body":
                raise OSError("client disconnected")

        with pytest.raises(ClientDisconnect):
            await response(
                {"type": "http", "asgi": {"spec_version": "2.4"}},
                receive,
                send,
            )

    asyncio.run(scenario())

    assert session.cancel_calls == 1
    assert session.close_calls == 1


def test_response_receive_disconnect_interrupts_silent_stream_for_asgi_http_24() -> None:
    session = _BlockingSession()
    call = _RecordingCall()
    response = chat_module.chat_stream_response(session, call)

    async def scenario() -> None:
        async def receive() -> dict[str, str]:
            started = await asyncio.to_thread(session.started.wait, 1)
            assert started
            return {"type": "http.disconnect"}

        async def send(_message: dict[str, object]) -> None:
            return None

        await asyncio.wait_for(
            response(
                {"type": "http", "asgi": {"spec_version": "2.4"}},
                receive,
                send,
            ),
            timeout=1,
        )

    asyncio.run(scenario())

    assert session.finished.wait(timeout=1)
    assert session.cancel_calls == 1
    assert session.close_calls == 1


def test_task_cancellation_interrupts_blocking_upstream_and_closes_session() -> None:
    session = _BlockingSession()
    call = _RecordingCall()

    async def scenario() -> None:
        async def consume() -> None:
            async for _ in chat_module.chat_event_stream(
                session,
                call,
            ):
                pass

        task = asyncio.create_task(consume())
        started = await asyncio.to_thread(session.started.wait, 1)
        assert started
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        finished = await asyncio.to_thread(session.finished.wait, 1)
        assert finished

    asyncio.run(scenario())

    assert session.cancel_calls == 1
    assert session.close_calls == 1
    assert call.records[-1][1]["status"] == "cancelled"


def test_app_registers_chat_stream_under_web_base_path() -> None:
    fake_config = SimpleNamespace(app_version="9.9.9-test", web_base_path="/chatgpt2api")

    with mock.patch.object(api_app, "config", fake_config):
        app = api_app.create_app()

    client = TestClient(app)
    responses = [
        client.post(path, content=b"")
        for path in ("/api/chat/stream", "/chatgpt2api/api/chat/stream")
    ]

    assert [response.status_code for response in responses] == [401, 401]
    assert all(response.headers["content-type"].startswith("application/json") for response in responses)
