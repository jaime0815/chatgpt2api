from __future__ import annotations

import json
import time
import unittest

import pytest
import requests

from test.live_compat_api import SKIP_REASON, enabled, load_target


pytestmark = pytest.mark.skipif(not enabled(), reason=SKIP_REASON)


class AnthropicMessagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.target = load_target(require_text_model=True)

    @staticmethod
    def _headers(api_key: str) -> dict[str, str]:
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }

    def test_message_http(self):
        """测试 Anthropic Messages 的非流式 HTTP 调用。"""
        response = requests.post(
            self.target.url("/v1/messages"),
            headers=self._headers(self.target.api_key),
            json={
                "model": self.target.text_model,
                "messages": [
                    {"role": "user", "content": "你好，请简单介绍一下你自己。"},
                ],
            },
            timeout=self.target.timeout_seconds,
        )
        print("messages non-stream status:")
        print(response.status_code)
        print("messages non-stream result:")
        try:
            print(json.dumps(response.json(), ensure_ascii=False, indent=2))
        except Exception:
            print(response.text)

    def test_message_stream_http(self):
        """测试 Anthropic Messages 的流式 HTTP 调用。"""
        started_at = time.time()
        response = requests.post(
            self.target.url("/v1/messages"),
            headers=self._headers(self.target.api_key),
            json={
                "model": self.target.text_model,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "你好，请简单介绍一下你自己。"},
                ],
            },
            stream=True,
            timeout=self.target.timeout_seconds,
        )
        headers_at = time.time()
        print("messages stream status:")
        print(response.status_code)
        print("messages stream content-type:")
        print(response.headers.get("content-type", ""))
        print("messages stream response headers:")
        print(f"{headers_at - started_at:6.2f}s")
        if response.status_code != 200:
            print(response.text)
            return
        print("messages stream chunks:")
        for line in response.iter_lines(chunk_size=1):
            if not line:
                continue
            text = line.decode("utf-8", errors="replace")
            print(f"{time.time() - started_at:6.2f}s {text}")
            if not text.startswith("data:"):
                continue
            try:
                payload = json.loads(text[5:].strip())
            except Exception:
                continue
            if payload.get("type") == "message_stop":
                break


if __name__ == "__main__":
    unittest.main()
