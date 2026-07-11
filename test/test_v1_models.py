from __future__ import annotations

import json
import unittest
from unittest import mock

import pytest
import requests

from services.protocol import openai_v1_models
from test.live_compat_api import SKIP_REASON, enabled, load_target


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
