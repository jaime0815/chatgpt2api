from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi.testclient import TestClient

import api.app as api_app


class WebBasePathTests(unittest.TestCase):
    def test_app_registers_api_routes_under_web_base_path(self) -> None:
        fake_config = SimpleNamespace(app_version="9.9.9-test", web_base_path="/chatgpt2api")

        with mock.patch.object(api_app, "config", fake_config):
            app = api_app.create_app()

        client = TestClient(app)

        self.assertEqual(client.get("/version").json(), {"version": "9.9.9-test"})
        self.assertEqual(client.get("/chatgpt2api/version").json(), {"version": "9.9.9-test"})


if __name__ == "__main__":
    unittest.main()
