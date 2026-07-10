"""Capture and sanitize the current ChatGPT Web PDF attachment protocol.

The live probe is intentionally opt-in. Raw upstream data is written only to a
mode-0600 file under /tmp. The repository fixture is replaced only after every
required upstream stage succeeds and the sanitized contract passes validation.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import parse_qsl, urlsplit


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

FIXTURE_PATH = REPOSITORY_ROOT / "test" / "fixtures" / "chat_file_attachment" / "pdf-upload.json"
PDF_MIME_TYPE = "application/pdf"
PROBE_FILE_NAME = "sample.pdf"
PROBE_PROMPT = "A PDF protocol probe is attached. Reply with its filename only."
SIGNED_QUERY_KEYS = {
    "sig",
    "signature",
    "se",
    "sp",
    "spr",
    "sr",
    "st",
    "sv",
    "skt",
    "ske",
    "sks",
    "skv",
    "x-amz-signature",
    "x-amz-credential",
    "x-goog-signature",
    "googleaccessid",
    "sessiontoken",
    "session_token",
    "auth_token",
    "access_token",
}
UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?")
BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~-]+", re.IGNORECASE)
FILE_ID_RE = re.compile(r"(?<!<)\bfile[-_][A-Za-z0-9_-]{6,}\b(?!>)")
URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)

VALIDATION_BEARER_RE = re.compile(r"\bBearer\s+[^\s,;]+", re.IGNORECASE)
VALIDATION_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?"
)
VALIDATION_UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
VALIDATION_FILE_ID_RE = re.compile(
    r"(?<!<)\bfile[-_][A-Za-z0-9_-]{6,}\b(?!>)",
    re.IGNORECASE,
)
VALIDATION_CREDENTIAL_ASSIGNMENT_RE = re.compile(
    r"(?i)(?:[?&;]|\b)(?:session[_-]?token|auth[_-]?token|access[_-]?token|refresh[_-]?token|"
    r"api[_-]?key|client[_-]?secret|x-amz-signature|x-amz-credential|x-goog-signature|"
    r"googleaccessid|signature|sig)\s*="
)
VALIDATION_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
VALIDATION_CREDENTIAL_QUERY_KEYS = {
    "sig",
    "signature",
    "sessiontoken",
    "session_token",
    "authtoken",
    "auth_token",
    "access_token",
    "refresh_token",
    "api_key",
    "client_secret",
    "x-amz-signature",
    "x-amz-credential",
    "x-goog-signature",
    "googleaccessid",
}
VALIDATION_SENSITIVE_IDENTIFIER_PARTS = {
    "requestid",
    "traceid",
    "spanid",
    "correlationid",
    "versionid",
    "blobid",
    "operationid",
}
VALIDATION_SENSITIVE_IDENTIFIER_KEYS = {"etag", "traceparent", "tracestate"}

CREATE_REQUEST_BODY_FIELDS = {
    "file_name",
    "file_size",
    "use_case",
    "timezone_offset_min",
    "reset_rate_limits",
    "supports_direct_azure_multipart",
    "mime_type",
    "entry_surface",
    "selection_method",
    "client_resolved_mime_type",
    "mime_resolution_source",
    "store_in_library",
    "library_persistence_mode",
}
CREATE_RESPONSE_BODY_FIELDS = {"status", "file_id", "upload_url", "library_file_id"}
CONFIRMATION_RESPONSE_BODY_FIELDS = {"status", "success", "file_id"}
PROCESSING_REQUEST_BODY_FIELDS = {
    "file_id",
    "use_case",
    "index_for_retrieval",
    "file_name",
    "entry_surface",
    "library_persistence_mode",
}
PROCESSING_EVENT_FIELDS = {"event", "status", "progress"}
PROCESSING_EXTRA_FIELDS = {
    "total_tokens",
    "mime_type",
    "metadata_object_id",
    "library_file_name",
    "library_persistence_result",
    "library_persistence_reason",
    "non_library_my_files_injest_upload",
    "error_code",
    "file_parse_error_code",
}
ATTACHMENT_FIELDS = {
    "id",
    "size",
    "name",
    "mime_type",
    "width",
    "height",
    "file_token_size",
    "source",
    "library_file_id",
    "library_artifact_type",
    "library_persistence_result",
    "library_persistence_reason",
    "non_library_my_files_injest_upload",
    "is_big_paste",
}


class ProbeBlocked(RuntimeError):
    """The environment cannot perform the required live probe."""


class ProbeFailed(RuntimeError):
    """A live upstream stage failed without exposing its response body."""

    def __init__(
        self,
        message: str,
        *,
        stage: str = "fixture_validation",
        status_code: int | None = None,
        raw_path: Path | None = None,
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.status_code = status_code
        self.raw_path = raw_path

    def attach_raw_path(self, raw_path: Path) -> None:
        if self.raw_path is None:
            self.raw_path = raw_path


def _private_json_path() -> Path:
    handle = tempfile.NamedTemporaryFile(
        prefix="chatgpt2api-chat-attachment-",
        suffix=".json",
        dir="/tmp",
        delete=False,
    )
    handle.close()
    path = Path(handle.name)
    path.chmod(0o600)
    return path


def _write_private_json(path: Path, payload: dict[str, Any]) -> None:
    if path.parent.resolve() != Path("/tmp").resolve():
        raise ProbeFailed("raw capture path must stay under /tmp")
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _write_fixture_atomically(payload: dict[str, Any]) -> None:
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = FIXTURE_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(FIXTURE_PATH)


def _json_body(response: Any) -> Any:
    try:
        return response.json()
    except Exception:
        text = str(getattr(response, "text", "") or "")
        return {"text": text[:1_000_000]}


def _require_success(
    response: Any,
    stage: str,
    *,
    raw_capture: dict[str, Any],
    raw_path: Path,
) -> None:
    status_code = int(getattr(response, "status_code", 0) or 0)
    if not 200 <= status_code < 300:
        raw_capture["failure"] = {"stage": stage, "status_code": status_code}
        _write_private_json(raw_path, raw_capture)
        raise ProbeFailed(
            "upstream request failed",
            stage=stage,
            status_code=status_code,
            raw_path=raw_path,
        )


def _header_subset(headers: Any, names: Iterable[str]) -> dict[str, str]:
    allowed = {name.lower() for name in names}
    if not hasattr(headers, "items"):
        return {}
    return {
        str(key): str(value)
        for key, value in headers.items()
        if str(key).lower() in allowed
    }


def _iter_json_stream(response: Any, *, max_captured_events: int = 200) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for raw_line in response.iter_lines():
        line = raw_line.decode("utf-8", "replace") if isinstance(raw_line, bytes) else str(raw_line)
        line = line.strip()
        if not line:
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and len(events) < max_captured_events:
            events.append(payload)
    return events


def _walk_key_values(value: Any, parent_key: str = "") -> Iterable[tuple[str, str, str]]:
    if isinstance(value, dict):
        for key, nested in value.items():
            key_text = str(key)
            if isinstance(nested, str):
                yield parent_key, key_text, nested
            yield from _walk_key_values(nested, key_text)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_key_values(nested, parent_key)


def _replacement_map(raw_capture: dict[str, Any]) -> dict[str, str]:
    replacements: dict[str, str] = {}
    create_body = (((raw_capture.get("create_file") or {}).get("response") or {}).get("body") or {})
    if isinstance(create_body, dict):
        file_id = str(create_body.get("file_id") or "")
        upload_url = str(create_body.get("upload_url") or "")
        if file_id:
            replacements[file_id] = "<file-id-redacted>"
        if upload_url:
            replacements[upload_url] = "<signed-upload-url-redacted>"

    conversation_body = (((raw_capture.get("conversation") or {}).get("request") or {}).get("body") or {})
    if isinstance(conversation_body, dict):
        parent_id = str(conversation_body.get("parent_message_id") or "")
        if parent_id:
            replacements[parent_id] = "<parent-message-id-redacted>"
        messages = conversation_body.get("messages")
        if isinstance(messages, list):
            for message in messages:
                if isinstance(message, dict) and message.get("id"):
                    replacements[str(message["id"])] = "<message-id-redacted>"

    for parent_key, key, value in _walk_key_values(raw_capture):
        normalized = key.lower()
        if normalized in {"conversation_id", "conversationid"}:
            replacements[value] = "<conversation-id-redacted>"
        elif normalized in {"message_id", "messageid"} or (normalized == "id" and parent_key == "message"):
            replacements[value] = "<message-id-redacted>"
        elif normalized in {"library_file_id", "metadata_object_id"}:
            replacements[value] = "<library-file-id-redacted>"
        elif normalized in {"account_id", "user_id"}:
            replacements[value] = "<account-id-redacted>"
    return replacements


def _looks_like_signed_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    query_keys = {key.lower() for key, _ in parse_qsl(parsed.query, keep_blank_values=True)}
    return bool(query_keys & SIGNED_QUERY_KEYS)


def _redact_string(value: str, replacements: dict[str, str]) -> str:
    redacted = value
    for secret, placeholder in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        if secret:
            redacted = redacted.replace(secret, placeholder)
    redacted = URL_RE.sub(
        lambda match: (
            "<signed-upload-url-redacted>"
            if _looks_like_signed_url(match.group(0))
            else match.group(0)
        ),
        redacted,
    )
    redacted = BEARER_RE.sub("<credential-redacted>", redacted)
    redacted = JWT_RE.sub("<credential-redacted>", redacted)
    redacted = UUID_RE.sub("<uuid-redacted>", redacted)
    redacted = FILE_ID_RE.sub("<file-id-redacted>", redacted)
    return redacted


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _sanitize_scalar(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        return _redact_string(value, replacements)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return None


def _project_fields(
    value: Any,
    allowed_fields: set[str],
    replacements: dict[str, str],
) -> dict[str, Any]:
    source = _as_dict(value)
    projected: dict[str, Any] = {}
    for key in sorted(allowed_fields):
        if key not in source:
            continue
        sanitized = _sanitize_scalar(source[key], replacements)
        if sanitized is not None or source[key] is None:
            projected[key] = sanitized
    return projected


def _project_headers(
    value: Any,
    allowed_headers: set[str],
    replacements: dict[str, str],
) -> dict[str, str]:
    source = _as_dict(value)
    allowed = {header.lower() for header in allowed_headers}
    return {
        str(key): _redact_string(str(nested), replacements)
        for key, nested in sorted(source.items(), key=lambda item: str(item[0]).lower())
        if str(key).lower() in allowed
    }


def _project_content(value: Any, replacements: dict[str, str]) -> dict[str, Any]:
    source = _as_dict(value)
    content_type = source.get("content_type")
    parts = source.get("parts")
    projected_parts: list[Any] = []
    if isinstance(parts, list):
        for part in parts:
            if isinstance(part, str):
                projected_parts.append(_redact_string(part, replacements))
            elif isinstance(part, dict):
                projected_parts.append(
                    _project_fields(
                        part,
                        {"content_type", "asset_pointer", "size_bytes", "width", "height"},
                        replacements,
                    )
                )
    return {
        "content_type": _redact_string(str(content_type or ""), replacements),
        "parts": projected_parts,
    }


def _project_processing_events(value: Any, replacements: dict[str, str]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    projected: list[dict[str, Any]] = []
    for event in value:
        if not isinstance(event, dict):
            continue
        item = _project_fields(event, PROCESSING_EVENT_FIELDS, replacements)
        extra = _project_fields(event.get("extra"), PROCESSING_EXTRA_FIELDS, replacements)
        if extra:
            item["extra"] = extra
        if item:
            projected.append(item)
    return projected


def _first_message(raw_capture: dict[str, Any]) -> dict[str, Any]:
    body = (((raw_capture.get("conversation") or {}).get("request") or {}).get("body") or {})
    messages = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(messages, list) or not messages or not isinstance(messages[0], dict):
        raise ProbeFailed("conversation capture has no request message")
    return messages[0]


def _processing_status(events: list[Any], replacements: dict[str, str]) -> list[dict[str, Any]]:
    statuses: list[dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        status = str(event.get("event") or event.get("status") or "").strip()
        if not status:
            continue
        item: dict[str, Any] = {
            "stage": "process_upload_stream",
            "status": _redact_string(status, replacements),
        }
        progress = event.get("progress")
        if isinstance(progress, (int, float)) and not isinstance(progress, bool):
            item["progress"] = progress
        statuses.append(item)
    return statuses


def _event_summary(event: dict[str, Any], replacements: dict[str, str]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key in ("type", "event", "status", "conversation_id", "message_id"):
        value = event.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            summary[key] = _sanitize_scalar(value, replacements)
    message = event.get("message")
    if isinstance(message, dict):
        for key in ("id", "status", "recipient"):
            value = message.get(key)
            if isinstance(value, (str, int, float, bool)) or value is None:
                summary[f"message_{key}"] = _sanitize_scalar(value, replacements)
    return summary


def build_sanitized_fixture(raw_capture: dict[str, Any]) -> dict[str, Any]:
    replacements = _replacement_map(raw_capture)
    create_file = _as_dict(raw_capture.get("create_file"))
    blob_upload = _as_dict(raw_capture.get("blob_upload"))
    confirmation = _as_dict(raw_capture.get("uploaded_confirmation"))
    processing = _as_dict(raw_capture.get("processing"))
    conversation = _as_dict(raw_capture.get("conversation"))
    message = _first_message(raw_capture)
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    attachments = metadata.get("attachments") if isinstance(metadata, dict) else None
    if not isinstance(attachments, list) or not attachments or not isinstance(attachments[0], dict):
        raise ProbeFailed("conversation capture has no metadata attachment")
    create_request = _as_dict(create_file.get("request"))
    create_response = _as_dict(create_file.get("response"))
    blob_request = _as_dict(blob_upload.get("request"))
    blob_response = _as_dict(blob_upload.get("response"))
    confirmation_request = _as_dict(confirmation.get("request"))
    confirmation_response = _as_dict(confirmation.get("response"))
    processing_request = _as_dict(processing.get("request"))
    processing_response = _as_dict(processing.get("response"))
    processing_events = processing_response.get("events")
    conversation_request = _as_dict(conversation.get("request"))
    conversation_response = _as_dict(conversation.get("response"))
    conversation_events = conversation_response.get("events")
    projected_processing_events = _project_processing_events(processing_events, replacements)

    fixture = {
        "schema_version": 1,
        "capture_kind": "real_upstream",
        "captured_at": _redact_string(str(raw_capture.get("captured_at") or ""), replacements),
        "create_file": {
            "request": {
                "method": _redact_string(str(create_request.get("method") or ""), replacements),
                "path": _redact_string(str(create_request.get("path") or ""), replacements),
                "headers": _project_headers(
                    create_request.get("headers"),
                    {"Accept", "Content-Type"},
                    replacements,
                ),
                "body": _project_fields(
                    create_request.get("body"),
                    CREATE_REQUEST_BODY_FIELDS,
                    replacements,
                ),
            },
            "response": {
                "status_code": create_response.get("status_code"),
                "body": _project_fields(
                    create_response.get("body"),
                    CREATE_RESPONSE_BODY_FIELDS,
                    replacements,
                ),
            },
        },
        "blob_upload": {
            "request": {
                "method": _redact_string(str(blob_request.get("method") or ""), replacements),
                "url": _redact_string(str(blob_request.get("url") or ""), replacements),
                "headers": _project_headers(
                    blob_request.get("headers"),
                    {"Content-Type", "x-ms-blob-type", "x-ms-version"},
                    replacements,
                ),
            },
            "response": {"status_code": blob_response.get("status_code")},
        },
        "uploaded_confirmation": {
            "request": {
                "method": _redact_string(str(confirmation_request.get("method") or ""), replacements),
                "path": _redact_string(str(confirmation_request.get("path") or ""), replacements),
                "headers": _project_headers(
                    confirmation_request.get("headers"),
                    {"Accept", "Content-Type"},
                    replacements,
                ),
                "body": {},
            },
            "response": {
                "status_code": confirmation_response.get("status_code"),
                "body": _project_fields(
                    confirmation_response.get("body"),
                    CONFIRMATION_RESPONSE_BODY_FIELDS,
                    replacements,
                ),
            },
        },
        "processing": {
            "request": {
                "method": _redact_string(str(processing_request.get("method") or ""), replacements),
                "path": _redact_string(str(processing_request.get("path") or ""), replacements),
                "headers": _project_headers(
                    processing_request.get("headers"),
                    {"Accept", "Content-Type"},
                    replacements,
                ),
                "body": _project_fields(
                    processing_request.get("body"),
                    PROCESSING_REQUEST_BODY_FIELDS,
                    replacements,
                ),
            },
            "response": {
                "status_code": processing_response.get("status_code"),
                "events": projected_processing_events,
            },
        },
        "processing_status": _processing_status(
            processing_events if isinstance(processing_events, list) else [],
            replacements,
        ),
        "conversation": {
            "request": {
                "method": _redact_string(str(conversation_request.get("method") or ""), replacements),
                "path": _redact_string(str(conversation_request.get("path") or ""), replacements),
            },
            "content_part": _project_content(message.get("content"), replacements),
            "metadata_attachment": _project_fields(
                attachments[0],
                ATTACHMENT_FIELDS,
                replacements,
            ),
            "response": {
                "status_code": conversation_response.get("status_code")
                if isinstance(conversation_response, dict)
                else None,
                "event_count": len(conversation_events) if isinstance(conversation_events, list) else 0,
                "event_summaries": [
                    _event_summary(event, replacements)
                    for event in (conversation_events if isinstance(conversation_events, list) else [])[:20]
                    if isinstance(event, dict)
                ],
            },
        },
    }
    _validate_fixture(fixture)
    return fixture


def _all_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, nested in value.items():
            yield str(key)
            yield from _all_keys(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _all_keys(nested)


def _all_strings(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for nested in value.values():
            yield from _all_strings(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _all_strings(nested)
    elif isinstance(value, str):
        yield value


def _validation_collapsed_key(key: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _validation_is_credential_key(key: object) -> bool:
    collapsed = _validation_collapsed_key(key)
    if collapsed == "filetokensize":
        return False
    explicit_markers = {
        "authorization",
        "cookie",
        "password",
        "credential",
        "clientsecret",
        "apikey",
        "sessiontoken",
        "authtoken",
        "accesstoken",
        "refreshtoken",
    }
    return any(marker in collapsed for marker in explicit_markers) or collapsed.endswith("token")


def _validation_is_sensitive_identifier_key(key: object) -> bool:
    collapsed = _validation_collapsed_key(key)
    return collapsed in VALIDATION_SENSITIVE_IDENTIFIER_KEYS or any(
        identifier in collapsed
        for identifier in VALIDATION_SENSITIVE_IDENTIFIER_PARTS
    )


def _validation_contains_credential_text(value: str) -> bool:
    if VALIDATION_BEARER_RE.search(value) or VALIDATION_JWT_RE.search(value):
        return True
    if VALIDATION_CREDENTIAL_ASSIGNMENT_RE.search(value):
        return True
    for match in VALIDATION_URL_RE.finditer(value):
        try:
            query_keys = {
                key.lower()
                for key, _ in parse_qsl(urlsplit(match.group(0)).query, keep_blank_values=True)
            }
        except ValueError:
            return True
        if query_keys & VALIDATION_CREDENTIAL_QUERY_KEYS:
            return True
    return False


def _validation_contains_opaque_identifier(value: str) -> bool:
    return bool(VALIDATION_UUID_RE.search(value) or VALIDATION_FILE_ID_RE.search(value))


def _require_fixture(condition: bool, path: str) -> None:
    if not condition:
        raise ProbeFailed(f"sanitized fixture contract violation: {path}")


def _require_mapping(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProbeFailed(f"sanitized fixture contract violation: {path} must be an object")
    return value


def _require_keys(
    value: Any,
    *,
    allowed: set[str],
    required: set[str],
    path: str,
) -> dict[str, Any]:
    mapping = _require_mapping(value, path)
    keys = {str(key) for key in mapping}
    unexpected = keys - allowed
    missing = required - keys
    if unexpected:
        raise ProbeFailed(
            f"sanitized fixture contract violation: {path} has unexpected fields"
        )
    if missing:
        raise ProbeFailed(
            f"sanitized fixture contract violation: {path} is missing required fields"
        )
    return mapping


def _require_header_keys(value: Any, allowed: set[str], path: str) -> dict[str, Any]:
    mapping = _require_mapping(value, path)
    if any(str(key).lower() not in allowed for key in mapping):
        raise ProbeFailed(f"sanitized fixture contract violation: {path} has unexpected fields")
    return mapping


def _require_optional_redacted_identifier(
    mapping: dict[str, Any],
    key: str,
    placeholder: str,
    path: str,
) -> None:
    value = mapping.get(key)
    if value is not None and value != "":
        _require_fixture(value == placeholder, f"{path}.{key} must be redacted")


def _validate_fixture(fixture: dict[str, Any]) -> None:
    if not isinstance(fixture, dict):
        raise ProbeFailed("sanitized fixture contract violation: root must be an object")
    if any(_validation_is_credential_key(key) for key in _all_keys(fixture)):
        raise ProbeFailed("sanitized fixture contains credential-like key")
    if any(_validation_is_sensitive_identifier_key(key) for key in _all_keys(fixture)):
        raise ProbeFailed("sanitized fixture still contains sensitive response identifiers")
    if any(_validation_contains_credential_text(value) for value in _all_strings(fixture)):
        raise ProbeFailed("sanitized fixture contains credential or signed URL")
    if any(_validation_contains_opaque_identifier(value) for value in _all_strings(fixture)):
        raise ProbeFailed("sanitized fixture still contains an opaque identifier")

    root = _require_keys(
        fixture,
        allowed={
            "schema_version",
            "capture_kind",
            "captured_at",
            "create_file",
            "blob_upload",
            "uploaded_confirmation",
            "processing",
            "processing_status",
            "conversation",
        },
        required={
            "schema_version",
            "capture_kind",
            "captured_at",
            "create_file",
            "blob_upload",
            "uploaded_confirmation",
            "processing",
            "processing_status",
            "conversation",
        },
        path="root",
    )
    _require_fixture(root["schema_version"] == 1, "schema_version")
    _require_fixture(root["capture_kind"] == "real_upstream", "capture_kind")
    _require_fixture(isinstance(root["captured_at"], str) and bool(root["captured_at"]), "captured_at")

    create = _require_keys(
        root["create_file"],
        allowed={"request", "response"},
        required={"request", "response"},
        path="create_file",
    )
    create_request = _require_keys(
        create["request"],
        allowed={"method", "path", "headers", "body"},
        required={"method", "path", "headers", "body"},
        path="create_file.request",
    )
    _require_fixture(create_request["method"] == "POST", "create_file.request.method")
    _require_fixture(create_request["path"] == "/backend-api/files", "create_file.request.path")
    _require_header_keys(create_request["headers"], {"accept", "content-type"}, "create_file.request.headers")
    create_request_body = _require_keys(
        create_request["body"],
        allowed=CREATE_REQUEST_BODY_FIELDS,
        required={"file_name", "file_size", "use_case", "mime_type"},
        path="create_file.request.body",
    )
    _require_fixture(create_request_body["file_name"] == PROBE_FILE_NAME, "create_file.request.body.file_name")
    _require_fixture(
        isinstance(create_request_body["file_size"], int) and create_request_body["file_size"] > 0,
        "create_file.request.body.file_size",
    )
    _require_fixture(create_request_body["mime_type"] == PDF_MIME_TYPE, "create_file.request.body.mime_type")
    create_response = _require_keys(
        create["response"],
        allowed={"status_code", "body"},
        required={"status_code", "body"},
        path="create_file.response",
    )
    _require_fixture(create_response["status_code"] in {200, 201}, "create_file.response.status_code")
    create_response_body = _require_keys(
        create_response["body"],
        allowed=CREATE_RESPONSE_BODY_FIELDS,
        required={"file_id", "upload_url"},
        path="create_file.response.body",
    )
    _require_fixture(create_response_body["file_id"] == "<file-id-redacted>", "create_file.response.body.file_id")
    _require_fixture(
        create_response_body["upload_url"] == "<signed-upload-url-redacted>",
        "create_file.response.body.upload_url",
    )
    _require_optional_redacted_identifier(
        create_response_body,
        "library_file_id",
        "<library-file-id-redacted>",
        "create_file.response.body",
    )

    blob = _require_keys(
        root["blob_upload"],
        allowed={"request", "response"},
        required={"request", "response"},
        path="blob_upload",
    )
    blob_request = _require_keys(
        blob["request"],
        allowed={"method", "url", "headers"},
        required={"method", "url", "headers"},
        path="blob_upload.request",
    )
    _require_fixture(blob_request["method"] == "PUT", "blob_upload.request.method")
    _require_fixture(blob_request["url"] == "<signed-upload-url-redacted>", "blob_upload.request.url")
    upload_headers = _require_header_keys(
        blob_request["headers"],
        {"content-type", "x-ms-blob-type", "x-ms-version"},
        "blob_upload.request.headers",
    )
    normalized_upload_headers = {str(key).lower(): value for key, value in upload_headers.items()}
    _require_fixture(normalized_upload_headers.get("content-type") == PDF_MIME_TYPE, "blob_upload.request.headers.content-type")
    _require_fixture(normalized_upload_headers.get("x-ms-blob-type") == "BlockBlob", "blob_upload.request.headers.x-ms-blob-type")
    _require_fixture(bool(normalized_upload_headers.get("x-ms-version")), "blob_upload.request.headers.x-ms-version")
    blob_response = _require_keys(
        blob["response"],
        allowed={"status_code"},
        required={"status_code"},
        path="blob_upload.response",
    )
    _require_fixture(blob_response["status_code"] in {200, 201}, "blob_upload.response.status_code")

    confirmation = _require_keys(
        root["uploaded_confirmation"],
        allowed={"request", "response"},
        required={"request", "response"},
        path="uploaded_confirmation",
    )
    confirmation_request = _require_keys(
        confirmation["request"],
        allowed={"method", "path", "headers", "body"},
        required={"method", "path", "headers", "body"},
        path="uploaded_confirmation.request",
    )
    _require_fixture(confirmation_request["method"] == "POST", "uploaded_confirmation.request.method")
    _require_fixture(
        confirmation_request["path"] == "/backend-api/files/<file-id-redacted>/uploaded",
        "uploaded_confirmation.request.path",
    )
    _require_header_keys(
        confirmation_request["headers"],
        {"accept", "content-type"},
        "uploaded_confirmation.request.headers",
    )
    _require_keys(
        confirmation_request["body"],
        allowed=set(),
        required=set(),
        path="uploaded_confirmation.request.body",
    )
    confirmation_response = _require_keys(
        confirmation["response"],
        allowed={"status_code", "body"},
        required={"status_code", "body"},
        path="uploaded_confirmation.response",
    )
    _require_fixture(
        confirmation_response["status_code"] in {200, 201},
        "uploaded_confirmation.response.status_code",
    )
    confirmation_response_body = _require_keys(
        confirmation_response["body"],
        allowed=CONFIRMATION_RESPONSE_BODY_FIELDS,
        required=set(),
        path="uploaded_confirmation.response.body",
    )
    _require_optional_redacted_identifier(
        confirmation_response_body,
        "file_id",
        "<file-id-redacted>",
        "uploaded_confirmation.response.body",
    )

    processing = _require_keys(
        root["processing"],
        allowed={"request", "response"},
        required={"request", "response"},
        path="processing",
    )
    processing_request = _require_keys(
        processing["request"],
        allowed={"method", "path", "headers", "body"},
        required={"method", "path", "headers", "body"},
        path="processing.request",
    )
    _require_fixture(processing_request["method"] == "POST", "processing.request.method")
    _require_fixture(
        processing_request["path"] == "/backend-api/files/process_upload_stream",
        "processing.request.path",
    )
    _require_header_keys(
        processing_request["headers"],
        {"accept", "content-type"},
        "processing.request.headers",
    )
    processing_request_body = _require_keys(
        processing_request["body"],
        allowed=PROCESSING_REQUEST_BODY_FIELDS,
        required={"file_id", "file_name"},
        path="processing.request.body",
    )
    _require_fixture(
        processing_request_body["file_id"] == "<file-id-redacted>",
        "processing.request.body.file_id must be redacted",
    )
    processing_response = _require_keys(
        processing["response"],
        allowed={"status_code", "events"},
        required={"status_code", "events"},
        path="processing.response",
    )
    _require_fixture(processing_response["status_code"] in {200, 201}, "processing.response.status_code")
    _require_fixture(isinstance(processing_response["events"], list), "processing.response.events")
    for index, event in enumerate(processing_response["events"]):
        event_mapping = _require_keys(
            event,
            allowed=PROCESSING_EVENT_FIELDS | {"extra"},
            required=set(),
            path=f"processing.response.events[{index}]",
        )
        if "extra" in event_mapping:
            event_extra = _require_keys(
                event_mapping["extra"],
                allowed=PROCESSING_EXTRA_FIELDS,
                required=set(),
                path=f"processing.response.events[{index}].extra",
            )
            _require_optional_redacted_identifier(
                event_extra,
                "metadata_object_id",
                "<library-file-id-redacted>",
                f"processing.response.events[{index}].extra",
            )

    processing_status = root["processing_status"]
    _require_fixture(isinstance(processing_status, list) and bool(processing_status), "processing_status")
    for index, status in enumerate(processing_status):
        _require_keys(
            status,
            allowed={"stage", "status", "progress"},
            required={"stage", "status"},
            path=f"processing_status[{index}]",
        )

    conversation = _require_keys(
        root["conversation"],
        allowed={"request", "content_part", "metadata_attachment", "response"},
        required={"request", "content_part", "metadata_attachment", "response"},
        path="conversation",
    )
    conversation_request = _require_keys(
        conversation["request"],
        allowed={"method", "path"},
        required={"method", "path"},
        path="conversation.request",
    )
    _require_fixture(conversation_request["method"] == "POST", "conversation.request.method")
    _require_fixture(
        conversation_request["path"] in {"/backend-api/conversation", "/backend-api/f/conversation"},
        "conversation.request.path",
    )
    content = _require_keys(
        conversation["content_part"],
        allowed={"content_type", "parts"},
        required={"content_type", "parts"},
        path="conversation.content_part",
    )
    _require_fixture(content["content_type"] != "image_asset_pointer", "conversation.content_part.content_type")
    _require_fixture(isinstance(content["parts"], list), "conversation.content_part.parts")
    for index, part in enumerate(content["parts"]):
        if isinstance(part, dict):
            _require_keys(
                part,
                allowed={"content_type", "asset_pointer", "size_bytes", "width", "height"},
                required=set(),
                path=f"conversation.content_part.parts[{index}]",
            )
        else:
            _require_fixture(isinstance(part, str), f"conversation.content_part.parts[{index}]")
    attachment = _require_keys(
        conversation["metadata_attachment"],
        allowed=ATTACHMENT_FIELDS,
        required={"id", "name", "mime_type", "size"},
        path="conversation.metadata_attachment",
    )
    _require_fixture(attachment["id"] == "<file-id-redacted>", "conversation.metadata_attachment.id")
    _require_fixture(attachment["name"] == PROBE_FILE_NAME, "conversation.metadata_attachment.name")
    _require_fixture(attachment["mime_type"] == PDF_MIME_TYPE, "conversation.metadata_attachment.mime_type")
    _require_optional_redacted_identifier(
        attachment,
        "library_file_id",
        "<library-file-id-redacted>",
        "conversation.metadata_attachment",
    )
    conversation_response = _require_keys(
        conversation["response"],
        allowed={"status_code", "event_count", "event_summaries"},
        required={"status_code", "event_count", "event_summaries"},
        path="conversation.response",
    )
    _require_fixture(conversation_response["status_code"] in {200, 201}, "conversation.response.status_code")
    _require_fixture(
        isinstance(conversation_response["event_count"], int) and conversation_response["event_count"] > 0,
        "conversation.response.event_count",
    )
    _require_fixture(isinstance(conversation_response["event_summaries"], list), "conversation.response.event_summaries")
    for index, summary in enumerate(conversation_response["event_summaries"]):
        summary_mapping = _require_keys(
            summary,
            allowed={
                "type",
                "event",
                "status",
                "conversation_id",
                "message_id",
                "message_status",
                "message_recipient",
            },
            required=set(),
            path=f"conversation.response.event_summaries[{index}]",
        )
        _require_optional_redacted_identifier(
            summary_mapping,
            "conversation_id",
            "<conversation-id-redacted>",
            f"conversation.response.event_summaries[{index}]",
        )
        _require_optional_redacted_identifier(
            summary_mapping,
            "message_id",
            "<message-id-redacted>",
            f"conversation.response.event_summaries[{index}]",
        )


def _processing_metadata(events: list[dict[str, Any]]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for event in events:
        extra = event.get("extra")
        if not isinstance(extra, dict):
            continue
        mappings = {
            "total_tokens": "file_token_size",
            "mime_type": "mime_type",
            "metadata_object_id": "library_file_id",
            "library_persistence_result": "library_persistence_result",
            "library_persistence_reason": "library_persistence_reason",
            "non_library_my_files_injest_upload": "non_library_my_files_injest_upload",
        }
        for source, target in mappings.items():
            if extra.get(source) is not None:
                metadata[target] = extra[source]
    return metadata


def _find_first_string(value: Any, keys: set[str]) -> str:
    if isinstance(value, dict):
        for key, nested in value.items():
            if str(key).lower() in keys and isinstance(nested, str) and nested:
                return nested
            found = _find_first_string(nested, keys)
            if found:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _find_first_string(nested, keys)
            if found:
                return found
    return ""


def _select_access_token() -> str:
    explicit = os.environ.get("CHAT_ATTACHMENT_PROBE_ACCESS_TOKEN", "").strip()
    if explicit:
        return explicit
    from services.account_service import account_service

    return account_service.get_text_access_token()


def run_live_probe(
    pdf_path: Path,
    *,
    token_selector: Callable[[], str] | None = None,
    client_factory: Callable[[str], Any] | None = None,
) -> tuple[Path, Path]:
    if not pdf_path.is_file():
        raise ProbeBlocked("set CHAT_ATTACHMENT_PROBE_PDF to a readable PDF under /tmp")
    if pdf_path.resolve().parent != Path("/tmp").resolve():
        raise ProbeBlocked("CHAT_ATTACHMENT_PROBE_PDF must point to a file directly under /tmp")
    data = pdf_path.read_bytes()
    if not data.startswith(b"%PDF-"):
        raise ProbeBlocked("CHAT_ATTACHMENT_PROBE_PDF is not a PDF file")
    token = (token_selector or _select_access_token)()
    if not token:
        raise ProbeBlocked("configure a text account or CHAT_ATTACHMENT_PROBE_ACCESS_TOKEN")

    if client_factory is None:
        from services.openai_backend_api import OpenAIBackendAPI

        client_factory = OpenAIBackendAPI

    raw_path = _private_json_path()
    raw_capture: dict[str, Any] = {
        "captured_at": datetime.now(UTC).isoformat(),
        "probe_source": "live_chatgpt_web",
    }
    client = client_factory(token)
    file_id = ""
    upload_url = ""
    conversation_id = ""
    current_stage = "create_file"
    try:
        create_path = "/backend-api/files"
        create_body = {
            "file_name": PROBE_FILE_NAME,
            "file_size": len(data),
            "use_case": "multimodal",
            "timezone_offset_min": -480,
            "reset_rate_limits": False,
            "supports_direct_azure_multipart": True,
            "mime_type": PDF_MIME_TYPE,
            "entry_surface": "composer",
            "selection_method": "file_picker",
            "client_resolved_mime_type": PDF_MIME_TYPE,
            "mime_resolution_source": "declared_mime",
            "store_in_library": False,
        }
        create_headers = client._headers(
            create_path,
            {"Accept": "application/json", "Content-Type": "application/json"},
        )
        create_response = client.session.post(
            client.base_url + create_path,
            headers=create_headers,
            json=create_body,
            timeout=60,
        )
        raw_capture["create_file"] = {
            "request": {
                "method": "POST",
                "path": create_path,
                "headers": _header_subset(create_headers, {"Accept", "Content-Type"}),
                "body": create_body,
            },
            "response": {
                "status_code": create_response.status_code,
                "headers": _header_subset(create_response.headers, {"Content-Type", "X-Request-Id"}),
                "body": _json_body(create_response),
            },
        }
        _write_private_json(raw_path, raw_capture)
        _require_success(
            create_response,
            current_stage,
            raw_capture=raw_capture,
            raw_path=raw_path,
        )
        create_payload = raw_capture["create_file"]["response"]["body"]
        file_id = str(create_payload.get("file_id") or "") if isinstance(create_payload, dict) else ""
        upload_url = str(create_payload.get("upload_url") or "") if isinstance(create_payload, dict) else ""
        if not file_id or not upload_url or not _looks_like_signed_url(upload_url):
            raise ProbeFailed(
                "create_file did not return a signed PUT URL and file ID",
                stage=current_stage,
            )

        current_stage = "blob_upload"
        upload_headers = {
            "Content-Type": PDF_MIME_TYPE,
            "x-ms-blob-type": "BlockBlob",
            "x-ms-version": "2020-04-08",
            "Origin": client.base_url,
            "Referer": client.base_url + "/",
            "User-Agent": client.user_agent,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.8",
        }
        upload_response = client.session.put(upload_url, headers=upload_headers, data=data, timeout=120)
        blob_response_capture: dict[str, Any] = {
            "status_code": upload_response.status_code,
            "headers": _header_subset(upload_response.headers, {"Content-Type", "ETag", "x-ms-request-id"}),
        }
        if not 200 <= int(upload_response.status_code or 0) < 300:
            blob_response_capture["body"] = _json_body(upload_response)
        raw_capture["blob_upload"] = {
            "request": {
                "method": "PUT",
                "url": upload_url,
                "headers": _header_subset(
                    upload_headers,
                    {"Content-Type", "x-ms-blob-type", "x-ms-version"},
                ),
            },
            "response": blob_response_capture,
        }
        _write_private_json(raw_path, raw_capture)
        _require_success(
            upload_response,
            current_stage,
            raw_capture=raw_capture,
            raw_path=raw_path,
        )

        current_stage = "uploaded_confirmation"
        confirmation_path = f"/backend-api/files/{file_id}/uploaded"
        confirmation_headers = client._headers(
            confirmation_path,
            {"Accept": "application/json", "Content-Type": "application/json"},
        )
        confirmation_response = client.session.post(
            client.base_url + confirmation_path,
            headers=confirmation_headers,
            data="{}",
            timeout=60,
        )
        raw_capture["uploaded_confirmation"] = {
            "request": {
                "method": "POST",
                "path": confirmation_path,
                "headers": _header_subset(confirmation_headers, {"Accept", "Content-Type"}),
                "body": {},
            },
            "response": {
                "status_code": confirmation_response.status_code,
                "headers": _header_subset(confirmation_response.headers, {"Content-Type", "X-Request-Id"}),
                "body": _json_body(confirmation_response),
            },
        }
        _write_private_json(raw_path, raw_capture)
        _require_success(
            confirmation_response,
            current_stage,
            raw_capture=raw_capture,
            raw_path=raw_path,
        )

        current_stage = "process_upload_stream"
        processing_path = "/backend-api/files/process_upload_stream"
        processing_body = {
            "file_id": file_id,
            "use_case": "multimodal",
            "index_for_retrieval": True,
            "file_name": PROBE_FILE_NAME,
            "entry_surface": "composer",
        }
        processing_headers = client._headers(
            processing_path,
            {"Accept": "*/*", "Content-Type": "application/json"},
        )
        processing_response = client.session.post(
            client.base_url + processing_path,
            headers=processing_headers,
            json=processing_body,
            timeout=180,
            stream=True,
        )
        processing_response_capture: dict[str, Any] = {
            "status_code": processing_response.status_code,
            "headers": _header_subset(processing_response.headers, {"Content-Type", "X-Request-Id"}),
            "events": [],
        }
        if not 200 <= int(processing_response.status_code or 0) < 300:
            processing_response_capture["body"] = _json_body(processing_response)
        raw_capture["processing"] = {
            "request": {
                "method": "POST",
                "path": processing_path,
                "headers": _header_subset(processing_headers, {"Accept", "Content-Type"}),
                "body": processing_body,
            },
            "response": processing_response_capture,
        }
        _write_private_json(raw_path, raw_capture)
        _require_success(
            processing_response,
            current_stage,
            raw_capture=raw_capture,
            raw_path=raw_path,
        )
        try:
            processing_events = _iter_json_stream(processing_response)
        finally:
            processing_response.close()
        processing_response_capture["events"] = processing_events
        _write_private_json(raw_path, raw_capture)
        if not processing_events:
            raise ProbeFailed(
                "process_upload_stream returned no processing events",
                stage=current_stage,
                raw_path=raw_path,
            )
        error_events = {
            str(event.get("event") or "")
            for event in processing_events
            if str(event.get("event") or "").rsplit(".", 1)[-1] in {"error", "cancelled", "failed", "unknown"}
        }
        if error_events:
            raise ProbeFailed(
                "process_upload_stream reported a terminal failure",
                stage=current_stage,
                raw_path=raw_path,
            )

        processed = _processing_metadata(processing_events)
        attachment: dict[str, Any] = {
            "id": file_id,
            "size": len(data),
            "name": PROBE_FILE_NAME,
            "mime_type": str(processed.get("mime_type") or PDF_MIME_TYPE),
            "is_big_paste": False,
        }
        for key in (
            "file_token_size",
            "library_file_id",
            "library_persistence_result",
            "library_persistence_reason",
            "non_library_my_files_injest_upload",
        ):
            if processed.get(key) is not None:
                attachment[key] = processed[key]

        message = {
            "id": str(uuid.uuid4()),
            "author": {"role": "user"},
            "create_time": time.time(),
            "content": {"content_type": "text", "parts": [PROBE_PROMPT]},
            "metadata": {
                "attachments": [attachment],
                "developer_mode_connector_ids": [],
                "selected_sources": [],
                "selected_github_repos": [],
                "selected_all_github_repos": False,
                "serialization_metadata": {"custom_symbol_offsets": []},
            },
        }
        current_stage = "conversation_bootstrap"
        client._bootstrap()
        requirements = client._get_chat_requirements()
        current_stage = "conversation"
        conversation_path = "/backend-api/conversation"
        conversation_body = client._conversation_payload(
            [],
            os.environ.get("CHAT_ATTACHMENT_PROBE_MODEL", "auto").strip() or "auto",
            "Asia/Taipei",
        )
        conversation_body["messages"] = [message]
        conversation_headers = client._conversation_headers(conversation_path, requirements)
        conversation_response = client.session.post(
            client.base_url + conversation_path,
            headers=conversation_headers,
            json=conversation_body,
            timeout=300,
            stream=True,
        )
        conversation_response_capture: dict[str, Any] = {
            "status_code": conversation_response.status_code,
            "headers": _header_subset(conversation_response.headers, {"Content-Type", "X-Request-Id"}),
            "events": [],
        }
        if not 200 <= int(conversation_response.status_code or 0) < 300:
            conversation_response_capture["body"] = _json_body(conversation_response)
        raw_capture["conversation"] = {
            "request": {
                "method": "POST",
                "path": conversation_path,
                "headers": _header_subset(conversation_headers, {"Accept", "Content-Type"}),
                "body": conversation_body,
            },
            "response": conversation_response_capture,
        }
        _write_private_json(raw_path, raw_capture)
        _require_success(
            conversation_response,
            current_stage,
            raw_capture=raw_capture,
            raw_path=raw_path,
        )
        try:
            conversation_events = _iter_json_stream(conversation_response)
        finally:
            conversation_response.close()
        conversation_response_capture["events"] = conversation_events
        conversation_id = _find_first_string(conversation_events, {"conversation_id"})
        _write_private_json(raw_path, raw_capture)
        if not conversation_events:
            raise ProbeFailed(
                "conversation returned no JSON SSE events",
                stage=current_stage,
                raw_path=raw_path,
            )

        current_stage = "fixture_validation"
        fixture = build_sanitized_fixture(raw_capture)
        _write_fixture_atomically(fixture)
        return raw_path, FIXTURE_PATH
    except ProbeFailed as exc:
        exc.attach_raw_path(raw_path)
        raw_capture.setdefault(
            "failure",
            {"stage": exc.stage, "status_code": exc.status_code},
        )
        _write_private_json(raw_path, raw_capture)
        raise
    except Exception as exc:
        raw_capture["failure"] = {
            "stage": current_stage,
            "status_code": None,
            "error_type": exc.__class__.__name__,
        }
        _write_private_json(raw_path, raw_capture)
        raise ProbeFailed(
            "unexpected probe failure",
            stage=current_stage,
            raw_path=raw_path,
        ) from exc
    finally:
        if conversation_id:
            try:
                client.delete_conversation(conversation_id)
            except Exception:
                pass
        if raw_capture:
            _write_private_json(raw_path, raw_capture)
        client.close()


def main(
    *,
    token_selector: Callable[[], str] | None = None,
    client_factory: Callable[[str], Any] | None = None,
) -> int:
    configured_path = os.environ.get("CHAT_ATTACHMENT_PROBE_PDF", "").strip()
    if not configured_path:
        print("BLOCKED: set CHAT_ATTACHMENT_PROBE_PDF and configure a text account", file=sys.stderr)
        return 2
    try:
        raw_path, fixture_path = run_live_probe(
            Path(configured_path).expanduser(),
            token_selector=token_selector,
            client_factory=client_factory,
        )
    except ProbeBlocked as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    except ProbeFailed as exc:
        status = str(exc.status_code) if exc.status_code is not None else "unknown"
        raw_capture = str(exc.raw_path) if exc.raw_path is not None else "unavailable"
        print(
            f"FAILED: stage={exc.stage} status={status} raw_capture={raw_capture}",
            file=sys.stderr,
        )
        return 1
    except Exception:
        print("FAILED: stage=bootstrap status=unknown raw_capture=unavailable", file=sys.stderr)
        return 1
    print(f"raw capture: {raw_path}")
    print(f"sanitized fixture: {fixture_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
