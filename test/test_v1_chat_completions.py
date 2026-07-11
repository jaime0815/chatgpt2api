from __future__ import annotations

import json
import time
import unittest

import pytest
import requests

from test.live_compat_api import SKIP_REASON, enabled, load_target
from utils.helper import save_images_from_text

pytestmark = pytest.mark.skipif(not enabled(), reason=SKIP_REASON)


class ChatCompletionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.target = load_target(require_text_model=True, require_image_model=True)

    def test_text_completion_http(self):
        """测试文本对话的非流式 HTTP 调用。"""
        response = requests.post(
            self.target.url("/v1/chat/completions"),
            headers=self.target.headers(),
            json={
                "model": self.target.text_model,
                "messages": [
                    {"role": "user", "content": "你好。"},
                    {"role": "assistant", "content": "你好，我可以帮助你处理文本和图片相关请求。"},
                    {"role": "user", "content": "那你再简单介绍一下你自己。"},
                ],
            },
            timeout=self.target.timeout_seconds,
        )
        print("text non-stream status:")
        print(response.status_code)
        print("text non-stream result:")
        print(json.dumps(response.json(), ensure_ascii=False, indent=2))

    def test_text_completion_stream_http(self):
        """测试文本对话的流式 HTTP 调用。"""
        response = requests.post(
            self.target.url("/v1/chat/completions"),
            headers=self.target.headers(),
            json={
                "model": self.target.text_model,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "你好。"},
                    {"role": "assistant", "content": "你好，我的名字是Claude。"},
                    {"role": "user", "content": "那你再简单介绍一下你自己，比如你的名字是什么。"},
                ],
            },
            stream=True,
            timeout=self.target.timeout_seconds,
        )
        print("text stream status:")
        print(response.status_code)
        print("text stream result:")
        for line in response.iter_lines():
            if line:
                print(line.decode("utf-8", errors="replace"))

    def test_image_completion_http(self):
        """测试图片对话的非流式 HTTP 调用。"""
        response = requests.post(
            self.target.url("/v1/chat/completions"),
            headers=self.target.headers(),
            json={
                "model": self.target.image_model,
                "messages": [
                    {"role": "user", "content": "我想做一张南京城市宣传海报图。"},
                ],
                "n": 1,
            },
            timeout=self.target.timeout_seconds,
        )
        payload = response.json()
        content = str((((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""))
        saved_paths = save_images_from_text(content, "chat_completions_image_non_stream")
        print("image non-stream status:")
        print(response.status_code)
        print("image non-stream saved files:")
        for path in saved_paths:
            print(path)

    def test_image_completion_stream_http(self):
        """测试图片对话的流式 HTTP 调用。"""
        response = requests.post(
            self.target.url("/v1/chat/completions"),
            headers=self.target.headers(),
            json={
                "model": self.target.image_model,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "我想做一张南京城市宣传海报图。"},
                ],
                "n": 1,
            },
            stream=True,
            timeout=self.target.timeout_seconds,
        )
        parts: list[str] = []
        started_at = time.time()
        print("image stream status:")
        print(response.status_code)
        print("image stream chunks:")
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
            delta = ((chunk.get("choices") or [{}])[0].get("delta") or {})
            content = str(delta.get("content") or "")
            if content:
                parts.append(content)
        saved_paths = save_images_from_text("".join(parts), "chat_completions_image_stream")
        print("image stream saved files:")
        for path in saved_paths:
            print(path)
