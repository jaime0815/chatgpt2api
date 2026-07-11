from __future__ import annotations

import json
import unittest
from unittest import mock

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ai as ai_module
from services.protocol import openai_v1_models
from test.live_compat_api import SKIP_REASON, enabled, load_target


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}


class ModelListTests(unittest.TestCase):
    def test_list_models_only_returns_image_models_backed_by_account_types(self):
        with (
            mock.patch.object(
                openai_v1_models.OpenAIBackendAPI,
                "list_models",
                return_value={"object": "list", "data": []},
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {"access_token": "token-free", "type": "free"},
                    {"access_token": "token-web-team", "type": "Team", "source_type": "web"},
                    {"access_token": "token-codex-team", "type": "Team", "source_type": "codex"},
                ],
            ),
        ):
            result = openai_v1_models.list_models()

        ids = {item["id"] for item in result["data"]}
        self.assertIn("gpt-image-2", ids)
        self.assertIn("codex-gpt-image-2", ids)
        self.assertIn("team-codex-gpt-image-2", ids)
        self.assertNotIn("plus-codex-gpt-image-2", ids)
        self.assertNotIn("pro-codex-gpt-image-2", ids)

    def test_list_models_does_not_return_codex_models_for_web_plus_accounts(self):
        with (
            mock.patch.object(
                openai_v1_models.OpenAIBackendAPI,
                "list_models",
                return_value={"object": "list", "data": []},
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {"access_token": "token-web-plus", "type": "Plus", "source_type": "web"},
                ],
            ),
        ):
            result = openai_v1_models.list_models()

        ids = {item["id"] for item in result["data"]}
        self.assertIn("gpt-image-2", ids)
        self.assertNotIn("codex-gpt-image-2", ids)
        self.assertNotIn("plus-codex-gpt-image-2", ids)

    def test_models_refresh_sets_no_store_header(self):
        app = FastAPI()
        app.include_router(ai_module.create_router())
        client = TestClient(app)
        payload = {"object": "list", "data": [{"id": "gpt-test", "object": "model"}]}

        with mock.patch.object(ai_module.openai_v1_models, "list_models", return_value=payload):
            response = client.get("/v1/models?refresh=1", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_models_refresh_forwards_explicit_refresh_intent(self):
        app = FastAPI()
        app.include_router(ai_module.create_router())
        client = TestClient(app)
        payload = {"object": "list", "data": []}

        with mock.patch.object(ai_module.openai_v1_models, "list_models", return_value=payload) as list_models:
            response = client.get("/v1/models?refresh=1", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        list_models.assert_called_once_with(refresh=True)

    @pytest.mark.skipif(not enabled(), reason=SKIP_REASON)
    def test_list_models_http(self):
        """测试通过 HTTP 接口获取模型列表。"""
        target = load_target()
        response = requests.get(
            target.url("/v1/models"),
            headers=target.headers(),
            timeout=target.timeout_seconds,
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload.get("object"), "list")
        self.assertIsInstance(payload.get("data"), list)
        print("http status:")
        print(response.status_code)
        print("http result:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
