from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY_ROOT / "scripts" / "deploy-production.sh"


def _run_script(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    command_env = os.environ.copy()
    if env:
        command_env.update(env)
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        cwd=REPOSITORY_ROOT,
        env=command_env,
        capture_output=True,
        text=True,
        check=False,
    )


def _write_fake_ssh(tmp_path: Path) -> tuple[Path, Path, Path]:
    capture_dir = tmp_path / "ssh-captures"
    capture_dir.mkdir()
    call_count_path = tmp_path / "ssh-call-count.txt"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_ssh = fake_bin / "ssh"
    fake_ssh.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "call_count=0\n"
        'if [[ -f "$SSH_CALL_COUNT_PATH" ]]; then\n'
        '  call_count="$(<"$SSH_CALL_COUNT_PATH")"\n'
        "fi\n"
        "call_count=$((call_count + 1))\n"
        'printf \'%s\' "$call_count" > "$SSH_CALL_COUNT_PATH"\n'
        'printf \'%s\\n\' "$@" > "$SSH_CAPTURE_DIR/arguments-$call_count.txt"\n'
        'cat > "$SSH_CAPTURE_DIR/input-$call_count.bin"\n',
        encoding="utf-8",
    )
    fake_ssh.chmod(fake_ssh.stat().st_mode | stat.S_IXUSR)
    return fake_bin, capture_dir, call_count_path


def test_dry_run_prints_default_plan_without_opening_ssh(tmp_path: Path) -> None:
    fake_bin, capture_dir, call_count_path = _write_fake_ssh(tmp_path)

    result = _run_script(
        "--dry-run",
        env={
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "SSH_CAPTURE_DIR": str(capture_dir),
            "SSH_CALL_COUNT_PATH": str(call_count_path),
        },
    )

    assert result.returncode == 0, result.stderr
    assert "Deployment plan (dry run)" in result.stdout
    assert "root@relay-us3.virvm.com:32559" in result.stdout
    assert "/root/chatgpt2api" in result.stdout
    assert "docker-compose.local.yml" in result.stdout
    assert "jaime/main" in result.stdout
    assert "git bundle" in result.stdout
    assert "scripts/docker-up.sh --local --build" in result.stdout
    assert "http://127.0.0.1:3000/health?format=json" in result.stdout
    assert not call_count_path.exists()


def test_remote_execution_transmits_safe_update_and_cleanup_steps(tmp_path: Path) -> None:
    fake_bin, capture_dir, call_count_path = _write_fake_ssh(tmp_path)

    result = _run_script(
        env={
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "SSH_CAPTURE_DIR": str(capture_dir),
            "SSH_CALL_COUNT_PATH": str(call_count_path),
            "DEPLOY_HOST": "deploy@example.test",
            "DEPLOY_PORT": "2222",
            "DEPLOY_PATH": "/srv/chatcanvas",
            "COMPOSE_FILE": "compose.production.yml",
            "DEPLOY_HEALTH_URL": "http://127.0.0.1:9999/health",
            "DEPLOY_REF": "jaime/main",
        },
    )

    assert result.returncode == 0, result.stderr
    assert call_count_path.read_text(encoding="utf-8") == "2"
    transfer_arguments = (capture_dir / "arguments-1.txt").read_text(encoding="utf-8")
    deployment_arguments = (capture_dir / "arguments-2.txt").read_text(encoding="utf-8")
    payload = (capture_dir / "input-2.bin").read_text(encoding="utf-8")
    assert (capture_dir / "input-1.bin").stat().st_size > 0
    assert "-p\n2222\n" in transfer_arguments
    assert "deploy@example.test" in transfer_arguments
    assert "umask 077 && cat > /tmp/chatcanvas-deploy-" in transfer_arguments
    assert "bash -s --" in deployment_arguments
    assert 'git branch --show-current' in payload
    assert 'git status --porcelain' in payload
    assert 'git fetch --no-tags "$bundle_path" "$bundle_source_ref:$bundle_ref"' in payload
    assert 'git merge --ff-only "$bundle_ref"' in payload
    assert payload.index("docker compose version") < payload.index("command -v docker-compose")
    assert '"$deploy_path/scripts/docker-up.sh" --local --build' in payload
    assert "seed_host_mounts()" in payload
    assert 'compose -f "$compose_file" build --pull' in payload
    assert 'compose -f "$compose_file" up -d --force-recreate --remove-orphans --no-build' in payload
    assert 'docker image inspect --format' in payload
    assert 'docker ps -aq --filter "ancestor=$old_image_id"' in payload
    assert 'health_response="$(curl --fail --show-error --silent' in payload
    assert "grep -Eq '\"healthy\"[[:space:]]*:[[:space:]]*true'" in payload
    assert "git stash" not in payload
    assert "git pull" not in payload
    assert "git fetch origin" not in payload
