from __future__ import annotations

import asyncio
import json
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from inspect import getsourcelines
from typing import Any, Iterable

import pytest

from services import chat_stream_service, openai_backend_api
from services.chat_stream_service import ChatStreamSession
from services.chat_types import ChatAttachmentBlob, ChatMessage, ChatStreamCommand
from services.openai_backend_api import InvalidAccessTokenError


def _delta(text: str) -> str:
    return json.dumps({"p": "/message/content/parts/0", "o": "append", "v": text})


class TrackingIterator:
    def __init__(self, items: Iterable[object]) -> None:
        self._items = iter(items)
        self.closed = False
        self.close_calls = 0

    def __iter__(self) -> TrackingIterator:
        return self

    def __next__(self) -> str:
        if self.closed:
            raise StopIteration
        item = next(self._items)
        if isinstance(item, BaseException):
            raise item
        return str(item)

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True


class BlockingIterator(TrackingIterator):
    def __init__(self) -> None:
        super().__init__([])
        self.started = threading.Event()
        self.released = threading.Event()

    def __next__(self) -> str:
        self.started.set()
        self.released.wait(timeout=2)
        if self.closed:
            raise StopIteration
        return "[DONE]"

    def close(self) -> None:
        super().close()
        self.released.set()


class FakeBackend:
    def __init__(self, access_token: str, stream: TrackingIterator) -> None:
        self.access_token = access_token
        self.stream = stream
        self.stream_calls: list[dict[str, Any]] = []
        self.closed = False
        self.close_calls = 0
        self.cancel_active_response_calls = 0

    def stream_conversation(self, **kwargs: Any) -> TrackingIterator:
        self.stream_calls.append(kwargs)
        return self.stream

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True

    def cancel_active_response(self) -> None:
        self.cancel_active_response_calls += 1


class BackendFactory:
    def __init__(self, streams: dict[str, list[TrackingIterator]]) -> None:
        self.streams = {token: list(items) for token, items in streams.items()}
        self.backends: list[FakeBackend] = []

    def __call__(self, access_token: str) -> FakeBackend:
        backend = FakeBackend(access_token, self.streams[access_token].pop(0))
        self.backends.append(backend)
        return backend


class FakeAccountProvider:
    def __init__(self, tokens: Iterable[str], refreshed: dict[str, str] | None = None) -> None:
        self.tokens = list(tokens)
        self.refreshed = dict(refreshed or {})
        self.get_calls: list[set[str]] = []
        self.refresh_calls: list[tuple[str, bool, str]] = []
        self.remove_calls: list[tuple[str, str]] = []
        self.mark_calls: list[str] = []

    def get_text_access_token(self, excluded_tokens: set[str] | None = None) -> str:
        excluded = set(excluded_tokens or set())
        self.get_calls.append(excluded)
        return next((token for token in self.tokens if token not in excluded), "")

    def refresh_access_token(self, token: str, *, force: bool, event: str) -> str:
        self.refresh_calls.append((token, force, event))
        return self.refreshed.get(token, token)

    def remove_invalid_token(self, token: str, event: str) -> bool:
        self.remove_calls.append((token, event))
        return True

    def mark_text_used(self, token: str) -> None:
        self.mark_calls.append(token)


@dataclass(frozen=True)
class ResolvedAttachment:
    local_id: str
    attempt: int


class FakeAttachmentUploader:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[FakeBackend, tuple[ChatAttachmentBlob, ...]]] = []
        self.results: list[dict[str, ResolvedAttachment]] = []

    def resolve(
        self,
        backend: FakeBackend,
        attachments: tuple[ChatAttachmentBlob, ...],
    ) -> dict[str, ResolvedAttachment]:
        self.calls.append((backend, attachments))
        if self.error is not None:
            raise self.error
        attempt = len(self.calls)
        result = {
            attachment.id: ResolvedAttachment(attachment.id, attempt)
            for attachment in attachments
        }
        self.results.append(result)
        return result


class SilentSSEServer:
    def __init__(self, first_payload: str) -> None:
        self.release = threading.Event()
        self.client_disconnected = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                content_length = int(self.headers.get("Content-Length") or 0)
                if content_length:
                    self.rfile.read(content_length)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                body = f"data: {first_payload}\n\n".encode()
                self.wfile.write(f"{len(body):x}\r\n".encode() + body + b"\r\n")
                self.wfile.flush()

                self.connection.settimeout(0.05)
                while not owner.release.is_set():
                    try:
                        if self.connection.recv(1, socket.MSG_PEEK) == b"":
                            owner.client_disconnected.set()
                            return
                    except TimeoutError:
                        continue
                    except OSError:
                        owner.client_disconnected.set()
                        return
                try:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except OSError:
                    pass

            def log_message(self, _format: str, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}"

    def close(self) -> None:
        self.release.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=1)


def _attachment(attachment_id: str = "attachment-1") -> ChatAttachmentBlob:
    return ChatAttachmentBlob(
        id=attachment_id,
        file_name="notes.pdf",
        mime_type="application/pdf",
        size=8,
        sha256="a" * 64,
        kind="document",
        data=b"%PDF-1.7",
    )


def _command(
    *,
    messages: tuple[ChatMessage, ...] | None = None,
    attachments: tuple[ChatAttachmentBlob, ...] | None = None,
) -> ChatStreamCommand:
    attachment = _attachment()
    return ChatStreamCommand(
        model="gpt-5.5",
        messages=messages or (
            ChatMessage(
                id="message-1",
                role="user",
                text="Read the attachment.",
                attachment_ids=(attachment.id,),
            ),
        ),
        attachments=attachments if attachments is not None else (attachment,),
        thinking_effort="high",
    )


def _content(chunks: Iterable[dict[str, Any]]) -> str:
    return "".join(
        str(chunk["choices"][0]["delta"].get("content") or "")
        for chunk in chunks
    )


def test_upload_and_stream_share_backend_and_use_internal_attachment_mapping() -> None:
    stream = TrackingIterator([_delta("answer"), "[DONE]"])
    factory = BackendFactory({"token-a": [stream]})
    accounts = FakeAccountProvider(["token-a"])
    uploader = FakeAttachmentUploader()

    chunks = list(ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=uploader,
    ))

    backend = factory.backends[0]
    assert uploader.calls[0][0] is backend
    assert backend.stream_calls[0]["model"] == "gpt-5.5"
    assert backend.stream_calls[0]["thinking_effort"] == "high"
    message = backend.stream_calls[0]["messages"][0]
    assert message == {
        "id": "message-1",
        "role": "user",
        "content": "Read the attachment.",
        "attachments": [uploader.results[0]["attachment-1"]],
    }
    assert _content(chunks) == "answer"
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert accounts.mark_calls == ["token-a"]
    assert stream.close_calls == 1
    assert backend.close_calls == 1


def test_duplicate_message_references_upload_attachment_once_per_attempt() -> None:
    attachment = _attachment()
    messages = (
        ChatMessage("message-1", "user", "First question", (attachment.id,)),
        ChatMessage("message-2", "assistant", "First answer", ()),
        ChatMessage("message-3", "user", "Follow up", (attachment.id,)),
    )
    stream = TrackingIterator([_delta("done"), "[DONE]"])
    factory = BackendFactory({"token-a": [stream]})
    uploader = FakeAttachmentUploader()

    list(ChatStreamSession(
        _command(messages=messages, attachments=(attachment, attachment)),
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=factory,
        attachment_uploader=uploader,
    ))

    assert [item.id for item in uploader.calls[0][1]] == [attachment.id]
    upstream_messages = factory.backends[0].stream_calls[0]["messages"]
    assert upstream_messages[0]["attachments"][0] is upstream_messages[2]["attachments"][0]


def test_invalid_token_before_first_delta_reuploads_on_replacement_account() -> None:
    invalid_stream = TrackingIterator([InvalidAccessTokenError("token invalidated")])
    replacement_stream = TrackingIterator([_delta("replacement answer"), "[DONE]"])
    factory = BackendFactory({"token-a": [invalid_stream], "token-b": [replacement_stream]})
    accounts = FakeAccountProvider(["token-a", "token-b"], refreshed={"token-a": "token-a"})
    uploader = FakeAttachmentUploader()

    chunks = list(ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=uploader,
    ))

    assert [backend.access_token for backend in factory.backends] == ["token-a", "token-b"]
    assert [call[0].access_token for call in uploader.calls] == ["token-a", "token-b"]
    assert uploader.results[0]["attachment-1"] is not uploader.results[1]["attachment-1"]
    assert accounts.refresh_calls == [("token-a", True, "chat_stream")]
    assert accounts.remove_calls == [("token-a", "chat_stream")]
    assert accounts.get_calls == [set(), {"token-a"}]
    assert accounts.mark_calls == ["token-b"]
    assert _content(chunks) == "replacement answer"
    assert invalid_stream.close_calls == replacement_stream.close_calls == 1
    assert all(backend.close_calls == 1 for backend in factory.backends)


def test_invalid_token_before_first_delta_reuploads_after_token_refresh() -> None:
    invalid_stream = TrackingIterator([InvalidAccessTokenError("token invalidated")])
    refreshed_stream = TrackingIterator([_delta("refreshed answer"), "[DONE]"])
    factory = BackendFactory({"token-a": [invalid_stream], "token-refreshed": [refreshed_stream]})
    accounts = FakeAccountProvider(["token-a"], refreshed={"token-a": "token-refreshed"})
    uploader = FakeAttachmentUploader()

    chunks = list(ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=uploader,
    ))

    assert [backend.access_token for backend in factory.backends] == ["token-a", "token-refreshed"]
    assert [call[0].access_token for call in uploader.calls] == ["token-a", "token-refreshed"]
    assert accounts.remove_calls == []
    assert accounts.get_calls == [set()]
    assert accounts.mark_calls == ["token-refreshed"]
    assert _content(chunks) == "refreshed answer"


def test_invalid_token_after_first_delta_is_not_replayed() -> None:
    stream = TrackingIterator([_delta("partial"), InvalidAccessTokenError("token invalidated")])
    factory = BackendFactory({"token-a": [stream]})
    accounts = FakeAccountProvider(["token-a", "token-b"])
    iterator = iter(ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=FakeAttachmentUploader(),
    ))

    first = next(iterator)
    assert _content([first]) == "partial"
    with pytest.raises(InvalidAccessTokenError, match="invalidated"):
        next(iterator)

    assert len(factory.backends) == 1
    assert accounts.refresh_calls == []
    assert accounts.remove_calls == []
    assert accounts.mark_calls == []
    assert stream.close_calls == 1
    assert factory.backends[0].close_calls == 1


def test_local_uploader_token_text_does_not_retry_healthy_account() -> None:
    local_error = RuntimeError("local uploader rejected token_invalidated metadata text")
    factory = BackendFactory({
        "token-a": [TrackingIterator([])],
        "token-b": [TrackingIterator([])],
    })
    accounts = FakeAccountProvider(["token-a", "token-b"])

    with pytest.raises(RuntimeError, match="local uploader rejected"):
        list(ChatStreamSession(
            _command(),
            account_provider=accounts,
            backend_factory=factory,
            attachment_uploader=FakeAttachmentUploader(error=local_error),
        ))

    assert len(factory.backends) == 1
    assert accounts.refresh_calls == []
    assert accounts.remove_calls == []
    assert accounts.get_calls == [set()]
    assert factory.backends[0].close_calls == 1


def test_empty_stream_eof_is_truncated_without_marking_success() -> None:
    stream = TrackingIterator([])
    factory = BackendFactory({"token-a": [stream]})
    accounts = FakeAccountProvider(["token-a"])

    with pytest.raises(RuntimeError, match="truncated"):
        list(ChatStreamSession(
            _command(),
            account_provider=accounts,
            backend_factory=factory,
            attachment_uploader=FakeAttachmentUploader(),
        ))

    assert accounts.mark_calls == []
    assert stream.close_calls == 1
    assert factory.backends[0].close_calls == 1


def test_stream_eof_after_delta_raises_without_replay_or_stop() -> None:
    stream = TrackingIterator([_delta("partial")])
    factory = BackendFactory({"token-a": [stream]})
    accounts = FakeAccountProvider(["token-a", "token-b"])
    iterator = iter(ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=FakeAttachmentUploader(),
    ))

    first = next(iterator)
    assert _content([first]) == "partial"
    with pytest.raises(RuntimeError, match="truncated"):
        next(iterator)

    assert len(factory.backends) == 1
    assert accounts.refresh_calls == []
    assert accounts.remove_calls == []
    assert accounts.mark_calls == []
    assert stream.close_calls == 1
    assert factory.backends[0].close_calls == 1


def test_explicit_done_marks_success_and_emits_stop() -> None:
    stream = TrackingIterator(["[DONE]"])
    factory = BackendFactory({"token-a": [stream]})
    accounts = FakeAccountProvider(["token-a"])

    chunks = list(ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=FakeAttachmentUploader(),
    ))

    assert accounts.mark_calls == ["token-a"]
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant", "content": ""}
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert stream.close_calls == 1
    assert factory.backends[0].close_calls == 1


def test_non_token_stream_error_closes_iterator_and_backend_without_stop() -> None:
    stream = TrackingIterator([RuntimeError("upstream failed")])
    factory = BackendFactory({"token-a": [stream]})
    accounts = FakeAccountProvider(["token-a"])
    session = ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=FakeAttachmentUploader(),
    )

    with pytest.raises(RuntimeError, match="upstream failed"):
        list(session)

    assert accounts.mark_calls == []
    assert stream.close_calls == 1
    assert factory.backends[0].close_calls == 1


def test_upload_error_closes_backend() -> None:
    stream = TrackingIterator([])
    factory = BackendFactory({"token-a": [stream]})
    uploader = FakeAttachmentUploader(error=RuntimeError("upload failed"))

    with pytest.raises(RuntimeError, match="upload failed"):
        list(ChatStreamSession(
            _command(),
            account_provider=FakeAccountProvider(["token-a"]),
            backend_factory=factory,
            attachment_uploader=uploader,
        ))

    assert factory.backends[0].stream_calls == []
    assert stream.close_calls == 0
    assert factory.backends[0].close_calls == 1


def test_cancel_is_thread_safe_idempotent_and_never_emits_stop() -> None:
    stream = TrackingIterator([_delta("partial"), _delta("ignored"), "[DONE]"])
    factory = BackendFactory({"token-a": [stream]})
    accounts = FakeAccountProvider(["token-a"])
    session = ChatStreamSession(
        _command(),
        account_provider=accounts,
        backend_factory=factory,
        attachment_uploader=FakeAttachmentUploader(),
    )
    iterator = iter(session)

    first = next(iterator)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _index: session.cancel(), range(32)))
    session.close()

    assert _content([first]) == "partial"
    assert list(iterator) == []
    assert accounts.mark_calls == []
    assert stream.close_calls == 1
    assert factory.backends[0].close_calls == 1
    assert factory.backends[0].cancel_active_response_calls == 1


def test_cancel_closes_resources_while_stream_iterator_is_blocked() -> None:
    stream = BlockingIterator()
    factory = BackendFactory({"token-a": [stream]})
    session = ChatStreamSession(
        _command(),
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=factory,
        attachment_uploader=FakeAttachmentUploader(),
    )

    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(lambda: list(session))
        assert stream.started.wait(timeout=2)
        session.cancel()
        assert result.result(timeout=2) == []

    assert stream.close_calls == 1
    assert factory.backends[0].close_calls == 1


def test_cancel_during_delta_chunk_construction_does_not_yield_chunk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    released = threading.Event()
    original_completion_chunk = chat_stream_service.completion_chunk

    def blocking_completion_chunk(*args: Any, **kwargs: Any) -> dict[str, Any]:
        delta = args[1]
        if isinstance(delta, dict) and delta.get("content") == "partial":
            entered.set()
            released.wait(timeout=2)
        return original_completion_chunk(*args, **kwargs)

    monkeypatch.setattr(chat_stream_service, "completion_chunk", blocking_completion_chunk)
    stream = TrackingIterator([_delta("partial"), "[DONE]"])
    factory = BackendFactory({"token-a": [stream]})
    session = ChatStreamSession(
        _command(),
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=factory,
        attachment_uploader=FakeAttachmentUploader(),
    )
    iterator = iter(session)

    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(next, iterator)
        assert entered.wait(timeout=2)
        session.cancel()
        released.set()
        with pytest.raises(StopIteration):
            result.result(timeout=2)


def test_cancel_return_is_linearized_before_candidate_delta_delivery() -> None:
    entered = threading.Event()
    released = threading.Event()
    stream = TrackingIterator([_delta("partial"), "[DONE]"])
    session = ChatStreamSession(
        _command(),
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=BackendFactory({"token-a": [stream]}),
        attachment_uploader=FakeAttachmentUploader(),
    )
    iterator = iter(session)
    candidate_method = getattr(
        ChatStreamSession,
        "_iter_candidate_chunks",
        ChatStreamSession.iter_chunks,
    )
    source_lines, start_line = getsourcelines(candidate_method)
    yield_lines = {
        start_line + offset
        for offset, source_line in enumerate(source_lines)
        if source_line.strip() == "yield chunk"
    }

    def traced_next() -> dict[str, Any]:
        def trace(frame: Any, event: str, _arg: Any) -> Any:
            if (
                event == "line"
                and frame.f_code is candidate_method.__code__
                and frame.f_lineno in yield_lines
            ):
                chunk = frame.f_locals.get("chunk")
                choices = chunk.get("choices") if isinstance(chunk, dict) else None
                delta = choices[0].get("delta") if choices else None
                if isinstance(delta, dict) and delta.get("content") == "partial":
                    entered.set()
                    released.wait(timeout=2)
            return trace

        sys.settrace(trace)
        try:
            return next(iterator)
        finally:
            sys.settrace(None)

    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(traced_next)
        assert entered.wait(timeout=2)
        session.cancel()
        released.set()
        with pytest.raises(StopIteration):
            result.result(timeout=2)


def test_cancel_during_stop_chunk_construction_does_not_yield_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    released = threading.Event()
    original_completion_chunk = chat_stream_service.completion_chunk

    def blocking_completion_chunk(*args: Any, **kwargs: Any) -> dict[str, Any]:
        if args[2] == "stop":
            entered.set()
            released.wait(timeout=2)
        return original_completion_chunk(*args, **kwargs)

    monkeypatch.setattr(chat_stream_service, "completion_chunk", blocking_completion_chunk)
    stream = TrackingIterator(["[DONE]"])
    session = ChatStreamSession(
        _command(),
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=BackendFactory({"token-a": [stream]}),
        attachment_uploader=FakeAttachmentUploader(),
    )
    iterator = iter(session)

    first = next(iterator)
    assert first["choices"][0]["finish_reason"] is None
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(next, iterator)
        assert entered.wait(timeout=2)
        session.cancel()
        released.set()
        with pytest.raises(StopIteration):
            result.result(timeout=2)


class BlockingStreamResponse:
    status_code = 200
    text = ""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.released = threading.Event()
        self._lock = threading.Lock()
        self.closed = False
        self.close_calls = 0

    def iter_lines(self) -> Iterable[bytes]:
        self.started.set()
        self.released.wait()
        return
        yield b""  # pragma: no cover

    async def aiter_lines(self) -> Any:
        self.started.set()
        while not self.released.is_set():
            await asyncio.sleep(0.01)
        return
        yield b""  # pragma: no cover

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            self.close_calls += 1
            self.released.set()


class FakeCurlSession:
    def __init__(self, response: BlockingStreamResponse) -> None:
        self.response = response
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {}
        self.close_calls = 0

    def post(self, *_args: Any, **_kwargs: Any) -> BlockingStreamResponse:
        return self.response

    def close(self) -> None:
        self.close_calls += 1


class FakeAsyncCurlSession:
    def __init__(self, response: BlockingStreamResponse) -> None:
        self.response = response
        self.close_calls = 0
        self._closed = False

    async def post(self, *_args: Any, **_kwargs: Any) -> BlockingStreamResponse:
        return self.response

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.close_calls += 1
        self.response.close()


def test_session_cancel_closes_active_backend_response_and_releases_blocked_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = BlockingStreamResponse()
    fake_session = FakeCurlSession(response)
    fake_async_session = FakeAsyncCurlSession(response)
    monkeypatch.setattr(openai_backend_api.requests, "Session", lambda **_kwargs: fake_session)
    monkeypatch.setattr(
        openai_backend_api.requests,
        "AsyncSession",
        lambda **_kwargs: fake_async_session,
    )
    backend = openai_backend_api.OpenAIBackendAPI()
    monkeypatch.setattr(backend, "_bootstrap", lambda: None)
    monkeypatch.setattr(backend, "_get_chat_requirements", lambda: object())
    monkeypatch.setattr(backend, "_chat_target", lambda: ("/stream", "UTC"))
    monkeypatch.setattr(backend, "_conversation_payload", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(backend, "_conversation_headers", lambda *_args, **_kwargs: {})
    command = _command(
        messages=(ChatMessage("message-1", "user", "Hello", ()),),
        attachments=(),
    )
    session = ChatStreamSession(
        command,
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=lambda _token: backend,
    )

    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(lambda: list(session))
        assert response.started.wait(timeout=2)
        session.cancel()
        try:
            assert result.result(timeout=1) == []
        finally:
            response.close()

    assert response.close_calls == 1
    assert fake_session.close_calls == 1
    assert fake_async_session.close_calls == 1


def test_session_cancel_interrupts_real_silent_sse_without_server_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SilentSSEServer(_delta("partial"))

    def direct_session_kwargs(**kwargs: Any) -> dict[str, Any]:
        kwargs.pop("account", None)
        return kwargs

    monkeypatch.setattr(
        openai_backend_api.proxy_settings,
        "build_session_kwargs",
        direct_session_kwargs,
    )
    backend = openai_backend_api.OpenAIBackendAPI()
    backend.base_url = server.base_url
    monkeypatch.setattr(backend, "_bootstrap", lambda: None)
    monkeypatch.setattr(backend, "_get_chat_requirements", lambda: object())
    monkeypatch.setattr(backend, "_chat_target", lambda: ("/stream", "UTC"))
    monkeypatch.setattr(backend, "_conversation_payload", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(backend, "_conversation_headers", lambda *_args, **_kwargs: {})
    session = ChatStreamSession(
        _command(
            messages=(ChatMessage("message-1", "user", "Hello", ()),),
            attachments=(),
        ),
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=lambda _token: backend,
    )
    iterator = iter(session)

    try:
        assert _content([next(iterator)]) == "partial"
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(next, iterator)
            time.sleep(0.05)
            assert not pending.done()
            cancelled = pool.submit(session.cancel)
            try:
                cancelled.result(timeout=0.5)
                with pytest.raises(StopIteration):
                    pending.result(timeout=0.5)
                assert server.client_disconnected.wait(timeout=0.5)
                assert not server.release.is_set()
            finally:
                server.release.set()
                cancelled.result(timeout=2)
                try:
                    pending.result(timeout=2)
                except StopIteration:
                    pass
    finally:
        session.close()
        server.close()


def test_text_only_success_does_not_require_attachment_uploader() -> None:
    command = _command(
        messages=(ChatMessage("message-1", "user", "Hello", ()),),
        attachments=(),
    )
    stream = TrackingIterator([_delta("Hi"), "[DONE]"])
    factory = BackendFactory({"token-a": [stream]})

    chunks = list(ChatStreamSession(
        command,
        account_provider=FakeAccountProvider(["token-a"]),
        backend_factory=factory,
    ))

    assert _content(chunks) == "Hi"
    assert factory.backends[0].stream_calls[0]["messages"] == [{
        "id": "message-1",
        "role": "user",
        "content": "Hello",
        "attachments": [],
    }]
