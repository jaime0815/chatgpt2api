import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import api.support as api_support


class ImageBaseUrlApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fake_config = SimpleNamespace(base_url="https://public.example.com", web_base_path="")
        patcher = mock.patch.object(api_support, "config", self.fake_config)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_prefers_configured_base_url(self) -> None:
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="http", netloc="127.0.0.1:8000"),
            headers={"host": "127.0.0.1:8000"},
        )

        self.assertEqual(api_support.resolve_image_base_url(request), "https://public.example.com")

    def test_appends_web_base_path_to_request_host_fallback(self) -> None:
        self.fake_config.base_url = ""
        self.fake_config.web_base_path = "/chatgpt2api"
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="https", netloc="public.example.com"),
            headers={"host": "public.example.com"},
        )

        self.assertEqual(api_support.resolve_image_base_url(request), "https://public.example.com/chatgpt2api")

    def test_falls_back_to_request_host(self) -> None:
        self.fake_config.base_url = ""
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="http", netloc="127.0.0.1:8000"),
            headers={"host": "internal.example:9000"},
        )

        self.assertEqual(api_support.resolve_image_base_url(request), "http://internal.example:9000")

    def test_falls_back_to_request_netloc_when_host_missing(self) -> None:
        self.fake_config.base_url = ""
        request = SimpleNamespace(
            url=SimpleNamespace(scheme="https", netloc="public.example.com"),
            headers={},
        )

        self.assertEqual(api_support.resolve_image_base_url(request), "https://public.example.com")

    def test_normalize_web_asset_path_strips_configured_base_path(self) -> None:
        self.fake_config.web_base_path = "/chatgpt2api"

        self.assertEqual(api_support.normalize_web_asset_path("chatgpt2api/_next/app.js"), "_next/app.js")
        self.assertEqual(api_support.normalize_web_asset_path("chatgpt2api"), "")
        self.assertEqual(api_support.normalize_web_asset_path("image"), "image")

    def test_resolve_web_asset_supports_configured_base_path(self) -> None:
        self.fake_config.web_base_path = "/chatgpt2api"
        with tempfile.TemporaryDirectory() as tmp_dir:
            web_dist = Path(tmp_dir)
            (web_dist / "_next").mkdir()
            index = web_dist / "index.html"
            chunk = web_dist / "_next" / "app.js"
            index.write_text("<html></html>", encoding="utf-8")
            chunk.write_text("console.log('ok')", encoding="utf-8")

            with mock.patch.object(api_support, "WEB_DIST_DIR", web_dist):
                self.assertEqual(api_support.resolve_web_asset("chatgpt2api"), index)
                self.assertEqual(api_support.resolve_web_asset("chatgpt2api/_next/app.js"), chunk)


if __name__ == "__main__":
    unittest.main()
