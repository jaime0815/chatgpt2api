from __future__ import annotations

import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import pytest


OPT_IN_ENV = "RUN_LIVE_COMPAT_API"
BASE_URL_ENV = "LIVE_COMPAT_API_BASE_URL"
AUTHORIZATION_ENV = "LIVE_COMPAT_API_AUTHORIZATION"
TIMEOUT_ENV = "LIVE_COMPAT_API_TIMEOUT_SECONDS"
TEXT_MODEL_ENV = "LIVE_COMPAT_API_TEXT_MODEL"
IMAGE_MODEL_ENV = "LIVE_COMPAT_API_IMAGE_MODEL"
CODEX_IMAGE_MODEL_ENV = "LIVE_COMPAT_API_CODEX_IMAGE_MODEL"
IMAGE_FILES_ENV = "LIVE_COMPAT_API_IMAGE_FILES"
SKIP_REASON = f"set {OPT_IN_ENV}=1 to run live compatibility API tests"


@dataclass(frozen=True)
class LiveCompatTarget:
    base_url: str
    authorization: str
    timeout_seconds: float
    text_model: str | None
    image_model: str | None
    codex_image_model: str | None

    @property
    def api_key(self) -> str:
        return self.authorization.split(" ", 1)[1]

    def url(self, path: str) -> str:
        if self.base_url.endswith("/v1") and (path == "/v1" or path.startswith("/v1/")):
            path = path[3:]
        return f"{self.base_url}{path}"

    def headers(self) -> dict[str, str]:
        return {"Authorization": self.authorization}


@dataclass(frozen=True)
class ImageFixture:
    name: str
    data: bytes
    mime_type: str


def enabled() -> bool:
    return os.environ.get(OPT_IN_ENV, "").strip() == "1"


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        pytest.skip(f"requires explicit {name}")
    return value


def _optional_model(name: str, required: bool) -> str | None:
    if not required:
        return None
    return _require_env(name)


def _parse_timeout() -> float:
    raw = os.environ.get(TIMEOUT_ENV, "90").strip()
    try:
        timeout = float(raw)
    except ValueError:
        pytest.skip(f"{TIMEOUT_ENV} must be a positive number")
    if timeout <= 0:
        pytest.skip(f"{TIMEOUT_ENV} must be a positive number")
    return timeout


def load_target(
    *,
    require_text_model: bool = False,
    require_image_model: bool = False,
    require_codex_image_model: bool = False,
) -> LiveCompatTarget:
    base_url = _require_env(BASE_URL_ENV).rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        pytest.skip(f"{BASE_URL_ENV} must be an explicit http(s) service URL")

    authorization = _require_env(AUTHORIZATION_ENV)
    if not authorization.lower().startswith("bearer ") or not authorization[7:].strip():
        pytest.skip(f"{AUTHORIZATION_ENV} must include a non-empty Bearer value")

    return LiveCompatTarget(
        base_url=base_url,
        authorization=authorization,
        timeout_seconds=_parse_timeout(),
        text_model=_optional_model(TEXT_MODEL_ENV, require_text_model),
        image_model=_optional_model(IMAGE_MODEL_ENV, require_image_model),
        codex_image_model=_optional_model(CODEX_IMAGE_MODEL_ENV, require_codex_image_model),
    )


def load_image_fixtures(*, minimum: int) -> list[ImageFixture]:
    raw_paths = _require_env(IMAGE_FILES_ENV)
    paths = [Path(value.strip()).expanduser() for value in raw_paths.split(os.pathsep) if value.strip()]
    if len(paths) < minimum:
        pytest.skip(f"{IMAGE_FILES_ENV} requires at least {minimum} readable image files")

    fixtures: list[ImageFixture] = []
    for path in paths[:minimum]:
        if not path.is_file():
            pytest.skip(f"{IMAGE_FILES_ENV} must point to readable image files")
        try:
            data = path.read_bytes()
        except OSError as exc:
            pytest.skip(f"{IMAGE_FILES_ENV} could not be read: {type(exc).__name__}")
        if not data:
            pytest.skip(f"{IMAGE_FILES_ENV} must not include empty image files")
        mime_type, _ = mimetypes.guess_type(path.name)
        if not mime_type or not mime_type.startswith("image/"):
            pytest.skip(f"{IMAGE_FILES_ENV} must contain image files")
        fixtures.append(ImageFixture(name=path.name, data=data, mime_type=mime_type))
    return fixtures
