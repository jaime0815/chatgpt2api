from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from functools import partial
from typing import Any, Protocol

import anyio
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from starlette._utils import collapse_excgroups
from starlette.requests import ClientDisconnect

from api.chat_inputs import parse_chat_stream_request
from api.support import require_identity
from services.chat_stream_service import ChatStreamSession
from services.chat_types import ChatStreamCommand
from services.content_filter import check_request
from services.log_service import LoggedCall
from services.openai_backend_api import InvalidAccessTokenError
from services.protocol.error_response import openai_error_payload
from utils.helper import UpstreamHTTPError
from utils.log import logger


class ChatStreamSessionProtocol(Protocol):
    def __iter__(self) -> Iterator[dict[str, Any]]: ...

    def cancel(self) -> None: ...

    def close(self) -> None: ...


ChatStreamSessionFactory = Callable[[ChatStreamCommand], ChatStreamSessionProtocol]


def _next_chunk(iterator: Iterator[dict[str, Any]]) -> tuple[bool, dict[str, Any] | None]:
    try:
        return True, next(iterator)
    except StopIteration:
        return False, None


def _sse_data(payload: object) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"data: {encoded}\n\n"


def _stream_error_payload(exc: Exception) -> dict[str, Any]:
    message = str(exc or "").strip().lower()
    status_code = getattr(exc, "status_code", None)

    if message == "no available text account":
        return openai_error_payload(
            "暂无可用的聊天账号，请稍后重试",
            429,
            code="no_available_text_account",
        )
    if isinstance(exc, InvalidAccessTokenError) or status_code == 401:
        return openai_error_payload(
            "聊天账号认证失效，请重试",
            502,
            code="upstream_authentication_error",
        )
    if isinstance(exc, UpstreamHTTPError) and status_code == 429:
        return openai_error_payload("上游聊天服务繁忙，请稍后重试", 429)
    if message == "attachment_uploader is required for attachment chat":
        return openai_error_payload(
            "聊天附件服务暂时不可用，请稍后重试",
            503,
            code="attachment_unavailable",
        )
    return openai_error_payload("聊天服务暂时不可用，请稍后重试", 502)


def _safe_error_summary(exc: BaseException) -> str:
    error_type = type(exc).__name__
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        return f"{error_type}(status={status_code})"
    if isinstance(exc, RuntimeError) and str(exc or "").strip().lower() == "no available text account":
        return f"{error_type}(no_available_text_account)"
    return error_type


def _safe_log(call: LoggedCall, suffix: str, **kwargs: object) -> None:
    try:
        call.log(suffix, **kwargs)
    except Exception as exc:
        logger.warning({
            "event": "chat_stream_log_failed",
            "error_type": type(exc).__name__,
        })


def _close_session(session: ChatStreamSessionProtocol) -> None:
    for method_name in ("cancel", "close"):
        method = getattr(session, method_name, None)
        if not callable(method):
            continue
        try:
            method()
        except Exception as exc:
            logger.warning({
                "event": "chat_stream_cleanup_failed",
                "method": method_name,
                "error_type": type(exc).__name__,
            })


class _SessionCleanup:
    def __init__(self, session: ChatStreamSessionProtocol) -> None:
        self._session = session
        self._lock = threading.Lock()
        self._closed = False

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        _close_session(self._session)


class _CancellationSafeStreamingResponse(StreamingResponse):
    def __init__(self, content: AsyncIterator[str], cleanup: _SessionCleanup) -> None:
        self._cleanup = cleanup
        super().__init__(
            content,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            try:
                with collapse_excgroups():
                    async with anyio.create_task_group() as task_group:
                        async def wrap(operation: Callable[[], Awaitable[None]]) -> None:
                            try:
                                await operation()
                            finally:
                                task_group.cancel_scope.cancel()

                        task_group.start_soon(wrap, partial(self.stream_response, send))
                        await wrap(partial(self.listen_for_disconnect, receive))
            except OSError as exc:
                raise ClientDisconnect() from exc
        finally:
            try:
                close_iterator = getattr(self.body_iterator, "aclose", None)
                if callable(close_iterator):
                    await close_iterator()
            finally:
                self._cleanup.close()

        if self.background is not None:
            await self.background()


async def chat_event_stream(
    session: ChatStreamSessionProtocol,
    call: LoggedCall,
    *,
    cleanup: _SessionCleanup | None = None,
) -> AsyncIterator[str]:
    cleanup = cleanup or _SessionCleanup(session)
    iterator = iter(session)
    outcome = "success"
    try:
        while True:
            has_chunk, chunk = await anyio.to_thread.run_sync(
                _next_chunk,
                iterator,
                abandon_on_cancel=True,
            )
            if not has_chunk:
                break
            yield _sse_data(chunk)

        yield "data: [DONE]\n\n"
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except GeneratorExit:
        outcome = "cancelled"
        raise
    except Exception as exc:
        outcome = "failed"
        _safe_log(
            call,
            "流式调用失败",
            status="failed",
            error=_safe_error_summary(exc),
        )
        yield f"event: error\n{_sse_data(_stream_error_payload(exc))}"
        yield "data: [DONE]\n\n"
    finally:
        cleanup.close()
        if outcome == "success":
            _safe_log(call, "流式调用结束")
        elif outcome == "cancelled":
            _safe_log(call, "流式调用取消", status="cancelled")


def chat_stream_response(
    session: ChatStreamSessionProtocol,
    call: LoggedCall,
) -> StreamingResponse:
    cleanup = _SessionCleanup(session)
    return _CancellationSafeStreamingResponse(
        chat_event_stream(session, call, cleanup=cleanup),
        cleanup,
    )


def _request_preview(command: ChatStreamCommand) -> str:
    return "\n".join(message.text for message in command.messages if message.text.strip())


def _request_shape(command: ChatStreamCommand) -> dict[str, int]:
    return {
        "messages": len(command.messages),
        "attachments": len(command.attachments),
        "image_attachments": sum(item.kind == "image" for item in command.attachments),
        "document_attachments": sum(item.kind == "document" for item in command.attachments),
        "attachment_bytes": sum(item.size for item in command.attachments),
    }


def create_router(
    *,
    session_factory: ChatStreamSessionFactory = ChatStreamSession,
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/chat/stream")
    async def stream_chat(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> StreamingResponse:
        identity = require_identity(authorization)
        command = await parse_chat_stream_request(request)
        preview = _request_preview(command)
        call = LoggedCall(
            identity,
            "/api/chat/stream",
            command.model,
            "普通用户聊天",
            request_text=preview,
            request_shape=_request_shape(command),
        )
        try:
            await run_in_threadpool(check_request, preview)
        except HTTPException as exc:
            _safe_log(
                call,
                "调用失败",
                status="failed",
                error=_safe_error_summary(exc),
            )
            raise

        session = session_factory(command)
        return chat_stream_response(session, call)

    return router
