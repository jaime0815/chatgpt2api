from __future__ import annotations

import pytest

from test import live_compat_api


def test_live_compat_api_is_disabled_without_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(live_compat_api.OPT_IN_ENV, raising=False)

    assert live_compat_api.enabled() is False


def test_live_compat_target_requires_explicit_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(live_compat_api.BASE_URL_ENV, raising=False)

    with pytest.raises(pytest.skip.Exception, match=live_compat_api.BASE_URL_ENV):
        live_compat_api.load_target()


def test_live_compat_target_reads_only_explicit_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(live_compat_api.BASE_URL_ENV, "https://example.test/service/")
    monkeypatch.setenv(live_compat_api.AUTHORIZATION_ENV, "Bearer test-auth")
    monkeypatch.setenv(live_compat_api.TEXT_MODEL_ENV, "test-text-model")
    monkeypatch.setenv(live_compat_api.IMAGE_MODEL_ENV, "test-image-model")
    monkeypatch.setenv(live_compat_api.CODEX_IMAGE_MODEL_ENV, "test-codex-image-model")

    target = live_compat_api.load_target(
        require_text_model=True,
        require_image_model=True,
        require_codex_image_model=True,
    )

    assert target.url("/v1/models") == "https://example.test/service/v1/models"
    assert target.headers() == {"Authorization": "Bearer test-auth"}
    assert target.text_model == "test-text-model"
    assert target.image_model == "test-image-model"
    assert target.codex_image_model == "test-codex-image-model"
