from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from typing import Any, Protocol

from services.account_service import account_service
from services.chat_types import ChatAttachmentBlob, ChatMessage, ChatStreamCommand
from services.openai_backend_api import InvalidAccessTokenError, OpenAIBackendAPI
from services.protocol.conversation import is_token_invalid_error, iter_conversation_payloads
from services.protocol.openai_v1_chat_complete import completion_chunk


_ACCOUNT_EVENT = "chat_stream"


class AttachmentUploaderProtocol(Protocol):
    def resolve(
        self,
        backend: Any,
        attachments: tuple[ChatAttachmentBlob, ...],
    ) -> Mapping[str, Any]: ...


class _AccountProviderProtocol(Protocol):
    def get_text_access_token(self, excluded_tokens: set[str] | None = None) -> str: ...

    def refresh_access_token(
        self,
        access_token: str,
        *,
        force: bool = False,
        event: str = "refresh_access_token",
    ) -> str: ...

    def remove_invalid_token(self, access_token: str, event: str, quiet: bool = False) -> bool: ...

    def mark_text_used(self, access_token: str) -> None: ...


def _unique_attachments(attachments: tuple[ChatAttachmentBlob, ...]) -> tuple[ChatAttachmentBlob, ...]:
    unique: list[ChatAttachmentBlob] = []
    seen: set[str] = set()
    for attachment in attachments:
        if attachment.id in seen:
            continue
        seen.add(attachment.id)
        unique.append(attachment)
    return tuple(unique)


def _upstream_messages(
    messages: tuple[ChatMessage, ...],
    resolved_attachments: Mapping[str, Any],
) -> list[dict[str, Any]]:
    upstream: list[dict[str, Any]] = []
    for message in messages:
        attachments: list[Any] = []
        seen: set[str] = set()
        for attachment_id in message.attachment_ids:
            if attachment_id in seen:
                continue
            seen.add(attachment_id)
            if attachment_id not in resolved_attachments:
                raise RuntimeError(f"attachment was not resolved: {attachment_id}")
            attachments.append(resolved_attachments[attachment_id])
        upstream.append({
            "id": message.id,
            "role": message.role,
            "content": message.text,
            "attachments": attachments,
        })
    return upstream


def _is_invalid_token_exception(exc: Exception, *, allow_message_match: bool) -> bool:
    if isinstance(exc, InvalidAccessTokenError):
        return True
    return allow_message_match and is_token_invalid_error(str(exc or ""))


class ChatStreamSession:
    def __init__(
        self,
        command: ChatStreamCommand,
        *,
        account_provider: _AccountProviderProtocol = account_service,
        backend_factory: Callable[[str], Any] = OpenAIBackendAPI,
        attachment_uploader: AttachmentUploaderProtocol | None = None,
    ) -> None:
        self.command = command
        self._account_provider = account_provider
        self._backend_factory = backend_factory
        self._attachment_uploader = attachment_uploader

        self._lock = threading.RLock()
        self._cancelled = threading.Event()
        self._started = False
        self._closed = False
        self._active_backend: Any | None = None
        self._active_upstream_iterator: Any | None = None
        self._active_event_iterator: Any | None = None
        self._closed_resources: dict[int, Any] = {}

    def __iter__(self) -> Iterator[dict[str, Any]]:
        return self.iter_chunks()

    def iter_chunks(self) -> Iterator[dict[str, Any]]:
        if not self._begin():
            return

        attempted_tokens: set[str] = set()
        token = self._account_provider.get_text_access_token(attempted_tokens)
        if not token:
            raise RuntimeError("no available text account")

        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())
        emitted = False
        unique_attachments = _unique_attachments(self.command.attachments)

        while not self._is_closed():
            if token in attempted_tokens:
                raise RuntimeError("no available text account")
            attempted_tokens.add(token)

            backend: Any | None = None
            upstream_iterator: Any | None = None
            event_iterator: Any | None = None
            retry = False
            succeeded = False
            completed = False
            conversation_started = False
            try:
                backend = self._backend_factory(token)
                if not self._activate_backend(backend):
                    return

                resolved = self._resolve_attachments(backend, unique_attachments)
                messages = _upstream_messages(self.command.messages, resolved)
                if self._is_closed():
                    return

                conversation_started = True
                upstream_iterator = backend.stream_conversation(
                    messages=messages,
                    model=self.command.model,
                    thinking_effort=self.command.thinking_effort,
                )
                history = [
                    message.text
                    for message in self.command.messages
                    if message.role == "assistant" and message.text
                ]
                event_iterator = iter_conversation_payloads(
                    iter(upstream_iterator),
                    "".join(history),
                    history,
                )
                if not self._activate_iterators(upstream_iterator, event_iterator):
                    return

                for event in event_iterator:
                    if self._is_closed():
                        return
                    if event.get("type") == "conversation.done":
                        completed = True
                        break
                    if event.get("type") != "conversation.delta":
                        continue
                    delta = str(event.get("delta") or "")
                    if not delta:
                        continue
                    chunk_delta: dict[str, Any] = {"content": delta}
                    if not emitted:
                        chunk_delta["role"] = "assistant"
                    emitted = True
                    chunk = completion_chunk(
                        self.command.model,
                        chunk_delta,
                        None,
                        completion_id,
                        created,
                    )
                    if self._is_closed():
                        return
                    yield chunk

                if self._is_closed():
                    return
                if not completed:
                    raise RuntimeError("upstream chat stream was truncated before completion")
                self._account_provider.mark_text_used(token)
                succeeded = True
            except Exception as exc:
                if self._is_closed():
                    return
                if not emitted and token and _is_invalid_token_exception(
                    exc,
                    allow_message_match=conversation_started,
                ):
                    replacement = self._replacement_token(token, attempted_tokens)
                    if replacement:
                        token = replacement
                        retry = True
                    else:
                        raise
                else:
                    raise
            finally:
                self._release_attempt(backend, upstream_iterator, event_iterator)

            if retry:
                continue
            if succeeded:
                if self._is_closed():
                    return
                if not emitted:
                    chunk = completion_chunk(
                        self.command.model,
                        {"role": "assistant", "content": ""},
                        None,
                        completion_id,
                        created,
                    )
                    if self._is_closed():
                        return
                    yield chunk
                if self._is_closed():
                    return
                chunk = completion_chunk(
                    self.command.model,
                    {},
                    "stop",
                    completion_id,
                    created,
                )
                if self._is_closed():
                    return
                yield chunk
                return

    def cancel(self) -> None:
        self.close()

    def close(self) -> None:
        self._cancelled.set()
        with self._lock:
            if self._closed:
                return
            self._closed = True
            backend = self._active_backend
            resources = (
                backend,
                self._active_upstream_iterator,
                self._active_event_iterator,
            )
            self._active_event_iterator = None
            self._active_upstream_iterator = None
            self._active_backend = None
        self._cancel_active_response(backend)
        for resource in resources:
            self._close_resource(resource)

    def _begin(self) -> bool:
        with self._lock:
            if self._started or self._closed:
                return False
            self._started = True
            return True

    def _is_closed(self) -> bool:
        return self._cancelled.is_set()

    @staticmethod
    def _cancel_active_response(backend: Any | None) -> None:
        cancel = getattr(backend, "cancel_active_response", None)
        if callable(cancel):
            try:
                cancel()
            except Exception:
                pass

    def _activate_backend(self, backend: Any) -> bool:
        with self._lock:
            if self._closed:
                active = False
            else:
                self._active_backend = backend
                active = True
        if not active:
            self._close_resource(backend)
        return active

    def _activate_iterators(self, upstream_iterator: Any, event_iterator: Any) -> bool:
        with self._lock:
            if self._closed:
                active = False
            else:
                self._active_upstream_iterator = upstream_iterator
                self._active_event_iterator = event_iterator
                active = True
        if not active:
            self._close_resource(event_iterator)
            self._close_resource(upstream_iterator)
        return active

    def _resolve_attachments(
        self,
        backend: Any,
        attachments: tuple[ChatAttachmentBlob, ...],
    ) -> Mapping[str, Any]:
        if not attachments:
            return {}
        if self._attachment_uploader is None:
            raise RuntimeError("attachment_uploader is required for attachment chat")
        resolved = self._attachment_uploader.resolve(backend, attachments)
        if not isinstance(resolved, Mapping):
            raise RuntimeError("attachment uploader returned an invalid mapping")
        return resolved

    def _replacement_token(self, token: str, attempted_tokens: set[str]) -> str:
        refreshed = self._account_provider.refresh_access_token(
            token,
            force=True,
            event=_ACCOUNT_EVENT,
        )
        if refreshed and refreshed != token and refreshed not in attempted_tokens:
            return refreshed
        self._account_provider.remove_invalid_token(token, _ACCOUNT_EVENT)
        replacement = self._account_provider.get_text_access_token(attempted_tokens)
        return replacement if replacement and replacement not in attempted_tokens else ""

    def _release_attempt(
        self,
        backend: Any | None,
        upstream_iterator: Any | None,
        event_iterator: Any | None,
    ) -> None:
        with self._lock:
            if self._active_event_iterator is event_iterator:
                self._active_event_iterator = None
            if self._active_upstream_iterator is upstream_iterator:
                self._active_upstream_iterator = None
            if self._active_backend is backend:
                self._active_backend = None
        self._close_resource(event_iterator)
        self._close_resource(upstream_iterator)
        self._close_resource(backend)

    def _close_resource(self, resource: Any | None) -> None:
        if resource is None:
            return
        resource_id = id(resource)
        with self._lock:
            if resource_id in self._closed_resources:
                return
            self._closed_resources[resource_id] = resource
        close = getattr(resource, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                with self._lock:
                    self._closed_resources.pop(resource_id, None)
