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
from typing import Any, Iterable
from urllib.parse import parse_qsl, urlsplit


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

FIXTURE_PATH = REPOSITORY_ROOT / "test" / "fixtures" / "chat_file_attachment" / "pdf-upload.json"
PDF_MIME_TYPE = "application/pdf"
PROBE_FILE_NAME = "sample.pdf"
PROBE_PROMPT = "A PDF protocol probe is attached. Reply with its filename only."
SIGNED_QUERY_KEYS = {"sig", "se", "sp", "spr", "sr", "st", "sv", "skt", "ske", "sks", "skv"}
SECRET_KEYS = {
    "authorization",
    "cookie",
    "set-cookie",
    "access_token",
    "refresh_token",
    "password",
}
UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?")
BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~-]+", re.IGNORECASE)
FILE_ID_RE = re.compile(r"(?<!<)\bfile[-_][A-Za-z0-9_-]{6,}\b(?!>)")
SENSITIVE_IDENTIFIER_KEY_PARTS = {
    "requestid",
    "traceid",
    "spanid",
    "correlationid",
    "versionid",
    "blobid",
    "operationid",
}
SENSITIVE_IDENTIFIER_KEYS = {"etag", "traceparent", "tracestate"}


class ProbeBlocked(RuntimeError):
    """The environment cannot perform the required live probe."""


class ProbeFailed(RuntimeError):
    """A live upstream stage failed without exposing its response body."""


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


def _require_success(response: Any, stage: str) -> None:
    status_code = int(getattr(response, "status_code", 0) or 0)
    if not 200 <= status_code < 300:
        raise ProbeFailed(f"{stage} returned HTTP {status_code}")


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
    if _looks_like_signed_url(redacted):
        return "<signed-upload-url-redacted>"
    redacted = BEARER_RE.sub("<credential-redacted>", redacted)
    redacted = JWT_RE.sub("<credential-redacted>", redacted)
    redacted = UUID_RE.sub("<uuid-redacted>", redacted)
    redacted = FILE_ID_RE.sub("<file-id-redacted>", redacted)
    return redacted


def _is_sensitive_identifier_key(key: object) -> bool:
    collapsed = re.sub(r"[^a-z0-9]", "", str(key).lower())
    return collapsed in SENSITIVE_IDENTIFIER_KEYS or any(
        identifier in collapsed
        for identifier in SENSITIVE_IDENTIFIER_KEY_PARTS
    )


def _redact_tree(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _redact_tree(nested, replacements)
            for key, nested in value.items()
            if str(key).lower() not in SECRET_KEYS and not _is_sensitive_identifier_key(key)
        }
    if isinstance(value, list):
        return [_redact_tree(nested, replacements) for nested in value]
    if isinstance(value, str):
        return _redact_string(value, replacements)
    return value


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
        item: dict[str, Any] = {"stage": "process_upload_stream", "status": status}
        progress = event.get("progress")
        if isinstance(progress, (int, float)) and not isinstance(progress, bool):
            item["progress"] = progress
        statuses.append(_redact_tree(item, replacements))
    return statuses


def _event_summary(event: dict[str, Any], replacements: dict[str, str]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key in ("type", "event", "status", "conversation_id", "message_id"):
        value = event.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            summary[key] = value
    message = event.get("message")
    if isinstance(message, dict):
        for key in ("id", "status", "recipient"):
            value = message.get(key)
            if isinstance(value, (str, int, float, bool)) or value is None:
                summary[f"message_{key}"] = value
    return _redact_tree(summary, replacements)


def build_sanitized_fixture(raw_capture: dict[str, Any]) -> dict[str, Any]:
    replacements = _replacement_map(raw_capture)
    create_file = raw_capture.get("create_file") or {}
    blob_upload = raw_capture.get("blob_upload") or {}
    confirmation = raw_capture.get("uploaded_confirmation") or {}
    processing = raw_capture.get("processing") or {}
    conversation = raw_capture.get("conversation") or {}
    message = _first_message(raw_capture)
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    attachments = metadata.get("attachments") if isinstance(metadata, dict) else None
    if not isinstance(attachments, list) or not attachments or not isinstance(attachments[0], dict):
        raise ProbeFailed("conversation capture has no metadata attachment")
    processing_response = processing.get("response") if isinstance(processing, dict) else {}
    processing_events = processing_response.get("events") if isinstance(processing_response, dict) else []
    conversation_response = conversation.get("response") if isinstance(conversation, dict) else {}
    conversation_events = conversation_response.get("events") if isinstance(conversation_response, dict) else []

    fixture = {
        "schema_version": 1,
        "capture_kind": "real_upstream",
        "captured_at": raw_capture.get("captured_at"),
        "create_file": _redact_tree(create_file, replacements),
        "blob_upload": _redact_tree(blob_upload, replacements),
        "uploaded_confirmation": _redact_tree(confirmation, replacements),
        "processing": _redact_tree(processing, replacements),
        "processing_status": _processing_status(
            processing_events if isinstance(processing_events, list) else [],
            replacements,
        ),
        "conversation": {
            "request": {
                "method": ((conversation.get("request") or {}).get("method")),
                "path": ((conversation.get("request") or {}).get("path")),
            },
            "content_part": _redact_tree(message.get("content"), replacements),
            "metadata_attachment": _redact_tree(attachments[0], replacements),
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


def _validate_fixture(fixture: dict[str, Any]) -> None:
    try:
        assert fixture["capture_kind"] == "real_upstream"
        assert fixture["create_file"]["request"]["method"] == "POST"
        assert fixture["create_file"]["request"]["path"] == "/backend-api/files"
        assert fixture["create_file"]["request"]["body"]["file_name"] == PROBE_FILE_NAME
        assert fixture["create_file"]["response"]["status_code"] in {200, 201}
        assert fixture["create_file"]["response"]["body"]["file_id"] == "<file-id-redacted>"
        assert fixture["blob_upload"]["request"]["method"] == "PUT"
        assert fixture["blob_upload"]["request"]["url"] == "<signed-upload-url-redacted>"
        upload_headers = {
            str(key).lower(): value
            for key, value in fixture["blob_upload"]["request"]["headers"].items()
        }
        assert upload_headers["content-type"] == PDF_MIME_TYPE
        assert upload_headers["x-ms-blob-type"] == "BlockBlob"
        assert upload_headers["x-ms-version"]
        assert fixture["blob_upload"]["response"]["status_code"] in {200, 201}
        assert fixture["uploaded_confirmation"]["response"]["status_code"] in {200, 201}
        assert fixture["processing_status"]
        assert fixture["conversation"]["content_part"]["content_type"] != "image_asset_pointer"
        assert fixture["conversation"]["metadata_attachment"]["mime_type"] == PDF_MIME_TYPE
        assert fixture["conversation"]["response"]["status_code"] in {200, 201}
        assert fixture["conversation"]["response"]["event_count"] > 0
    except (AssertionError, KeyError, TypeError) as exc:
        raise ProbeFailed("sanitized fixture does not satisfy the PDF attachment contract") from exc

    serialized = json.dumps(fixture, ensure_ascii=False)
    lower_keys = {key.lower() for key in _all_keys(fixture)}
    if lower_keys & SECRET_KEYS:
        raise ProbeFailed("sanitized fixture still contains credential keys")
    if any(_is_sensitive_identifier_key(key) for key in _all_keys(fixture)):
        raise ProbeFailed("sanitized fixture still contains sensitive response identifiers")
    if BEARER_RE.search(serialized) or JWT_RE.search(serialized):
        raise ProbeFailed("sanitized fixture still contains credentials")
    if any(_looks_like_signed_url(value) for value in _all_strings(fixture)):
        raise ProbeFailed("sanitized fixture still contains a signed URL")


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


def run_live_probe(pdf_path: Path) -> tuple[Path, Path]:
    if not pdf_path.is_file():
        raise ProbeBlocked("set CHAT_ATTACHMENT_PROBE_PDF to a readable PDF under /tmp")
    if pdf_path.resolve().parent != Path("/tmp").resolve():
        raise ProbeBlocked("CHAT_ATTACHMENT_PROBE_PDF must point to a file directly under /tmp")
    data = pdf_path.read_bytes()
    if not data.startswith(b"%PDF-"):
        raise ProbeBlocked("CHAT_ATTACHMENT_PROBE_PDF is not a PDF file")
    token = _select_access_token()
    if not token:
        raise ProbeBlocked("configure a text account or CHAT_ATTACHMENT_PROBE_ACCESS_TOKEN")

    from services.openai_backend_api import OpenAIBackendAPI

    raw_path = _private_json_path()
    raw_capture: dict[str, Any] = {
        "captured_at": datetime.now(UTC).isoformat(),
        "probe_source": "live_chatgpt_web",
    }
    client = OpenAIBackendAPI(token)
    file_id = ""
    upload_url = ""
    conversation_id = ""
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
        _require_success(create_response, "create_file")
        create_payload = raw_capture["create_file"]["response"]["body"]
        file_id = str(create_payload.get("file_id") or "") if isinstance(create_payload, dict) else ""
        upload_url = str(create_payload.get("upload_url") or "") if isinstance(create_payload, dict) else ""
        if not file_id or not upload_url or not _looks_like_signed_url(upload_url):
            raise ProbeFailed("create_file did not return a signed PUT URL and file ID")

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
        raw_capture["blob_upload"] = {
            "request": {
                "method": "PUT",
                "url": upload_url,
                "headers": _header_subset(
                    upload_headers,
                    {"Content-Type", "x-ms-blob-type", "x-ms-version"},
                ),
            },
            "response": {
                "status_code": upload_response.status_code,
                "headers": _header_subset(upload_response.headers, {"Content-Type", "ETag", "x-ms-request-id"}),
            },
        }
        _write_private_json(raw_path, raw_capture)
        _require_success(upload_response, "blob_upload")

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
        _require_success(confirmation_response, "uploaded_confirmation")

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
        _require_success(processing_response, "process_upload_stream")
        try:
            processing_events = _iter_json_stream(processing_response)
        finally:
            processing_response.close()
        raw_capture["processing"] = {
            "request": {
                "method": "POST",
                "path": processing_path,
                "headers": _header_subset(processing_headers, {"Accept", "Content-Type"}),
                "body": processing_body,
            },
            "response": {
                "status_code": processing_response.status_code,
                "headers": _header_subset(processing_response.headers, {"Content-Type", "X-Request-Id"}),
                "events": processing_events,
            },
        }
        _write_private_json(raw_path, raw_capture)
        if not processing_events:
            raise ProbeFailed("process_upload_stream returned no processing events")
        error_events = {
            str(event.get("event") or "")
            for event in processing_events
            if str(event.get("event") or "").rsplit(".", 1)[-1] in {"error", "cancelled", "failed", "unknown"}
        }
        if error_events:
            raise ProbeFailed("process_upload_stream reported a terminal failure")

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
        client._bootstrap()
        requirements = client._get_chat_requirements()
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
        _require_success(conversation_response, "conversation")
        try:
            conversation_events = _iter_json_stream(conversation_response)
        finally:
            conversation_response.close()
        raw_capture["conversation"] = {
            "request": {
                "method": "POST",
                "path": conversation_path,
                "headers": _header_subset(conversation_headers, {"Accept", "Content-Type"}),
                "body": conversation_body,
            },
            "response": {
                "status_code": conversation_response.status_code,
                "headers": _header_subset(conversation_response.headers, {"Content-Type", "X-Request-Id"}),
                "events": conversation_events,
            },
        }
        conversation_id = _find_first_string(conversation_events, {"conversation_id"})
        _write_private_json(raw_path, raw_capture)
        if not conversation_events:
            raise ProbeFailed("conversation returned no JSON SSE events")

        fixture = build_sanitized_fixture(raw_capture)
        _write_fixture_atomically(fixture)
        return raw_path, FIXTURE_PATH
    finally:
        if conversation_id:
            try:
                client.delete_conversation(conversation_id)
            except Exception:
                pass
        if raw_capture:
            _write_private_json(raw_path, raw_capture)
        client.close()


def main() -> int:
    configured_path = os.environ.get("CHAT_ATTACHMENT_PROBE_PDF", "").strip()
    if not configured_path:
        print("BLOCKED: set CHAT_ATTACHMENT_PROBE_PDF and configure a text account", file=sys.stderr)
        return 2
    try:
        raw_path, fixture_path = run_live_probe(Path(configured_path).expanduser())
    except ProbeBlocked as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"FAILED: {exc.__class__.__name__}; inspect the private /tmp capture", file=sys.stderr)
        return 1
    print(f"raw capture: {raw_path}")
    print(f"sanitized fixture: {fixture_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
