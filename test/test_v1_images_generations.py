from __future__ import annotations

import json
import time
import unittest

import pytest
import requests

from test.live_compat_api import SKIP_REASON, enabled, load_target
from test.utils import save_image

pytestmark = pytest.mark.skipif(not enabled(), reason=SKIP_REASON)


class ImageGenerationsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.target = load_target(require_image_model=True)

    def test_image_generation_http(self):
        """测试图片生成的非流式 HTTP 调用。"""
        response = requests.post(
            self.target.url("/v1/images/generations"),
            headers=self.target.headers(),
            json={
                "model": self.target.image_model,
                "prompt": "我想做一张南京城市宣传海报图。",
                "n": 1,
                "response_format": "b64_json",
            },
            timeout=self.target.timeout_seconds,
        )
        payload = response.json()
        saved_paths = []
        for index, item in enumerate(payload.get("data") or [], start=1):
            b64_json = str((item or {}).get("b64_json") or "")
            if b64_json:
                saved_paths.append(save_image(b64_json, f"images_generations_non_stream_{index}"))
        print("images generations non-stream status:")
        print(response.status_code)
        print("images generations non-stream created:")
        print(payload.get("created"))
        print("images generations non-stream saved files:")
        for path in saved_paths:
            print(path)

    def test_image_generation_stream_http(self):
        """测试图片生成的流式 HTTP 调用。"""
        response = requests.post(
            self.target.url("/v1/images/generations"),
            headers=self.target.headers(),
            json={
                "model": self.target.image_model,
                "prompt": "我想做一张南京城市宣传海报图。",
                "n": 1,
                "response_format": "b64_json",
                "stream": True,
            },
            stream=True,
            timeout=self.target.timeout_seconds,
        )
        image_items: list[dict[str, object]] = []
        started_at = time.time()
        print("images generations stream status:")
        print(response.status_code)
        print("images generations stream chunks:")
        for line in response.iter_lines():
            if not line:
                continue
            text = line.decode("utf-8", errors="replace")
            print(f"{time.time() - started_at:6.2f}s {text}")
            if not text.startswith("data:"):
                continue
            payload = text[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except Exception:
                continue
            data = chunk.get("data")
            if isinstance(data, list):
                image_items.extend(item for item in data if isinstance(item, dict))

        saved_paths = []
        for index, item in enumerate(image_items, start=1):
            b64_json = str(item.get("b64_json") or "")
            if b64_json:
                saved_paths.append(save_image(b64_json, f"images_generations_stream_{index}"))
        print("images generations stream saved files:")
        for path in saved_paths:
            print(path)


if __name__ == "__main__":
    unittest.main()
