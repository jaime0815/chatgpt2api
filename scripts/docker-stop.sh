#!/usr/bin/env bash

set -euo pipefail

MODE="local"

usage() {
  cat <<'EOF'
Usage: scripts/docker-stop.sh [--mode local|warp] [--warp] [--local]

Options:
  --mode       Deployment mode. Defaults to local.
  --warp       Shortcut for --mode warp.
  --local      Shortcut for --mode local.
  -h, --help   Show this help message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { echo "missing value for --mode" >&2; exit 1; }
      MODE="$2"
      shift 2
      ;;
    --warp)
      MODE="warp"
      shift
      ;;
    --local)
      MODE="local"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  local)
    COMPOSE_FILE="docker-compose.local.yml"
    ;;
  warp)
    COMPOSE_FILE="docker-compose.warp.yml"
    ;;
  *)
    echo "unsupported mode: $MODE" >&2
    exit 1
    ;;
esac

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "docker compose is not available" >&2
  exit 1
fi

printf 'Stopping %s deployment\n' "$MODE"
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" down --remove-orphans
