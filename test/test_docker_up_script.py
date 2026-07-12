from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY_ROOT / "scripts" / "docker-up.sh"


def test_legacy_compose_cleans_stale_declared_containers_before_starting() -> None:
    payload = SCRIPT.read_text(encoding="utf-8")

    assert "remove_legacy_compose_containers()" in payload
    assert 'container_name:' in payload
    assert 'docker ps -aq --filter "name=$container_name"' in payload
    assert 'docker rm -f "${container_ids[@]}"' in payload
    assert payload.index('"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" down --remove-orphans') < payload.rindex(
        "remove_legacy_compose_containers"
    ) < payload.index('CMD=("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d)')
