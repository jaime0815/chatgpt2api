from __future__ import annotations

import os


# Keep in-process API tests independent from a developer's ignored config.json.
os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"
