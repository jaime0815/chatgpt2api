#!/usr/bin/env bash

set -euo pipefail

MODE="local"
BUILD_IMAGE="true"

usage() {
  cat <<'EOF'
Usage: scripts/docker-up.sh [--mode local|warp] [--warp] [--local] [--build|--no-build]

Options:
  --mode       Deployment mode. Defaults to local.
  --warp       Shortcut for --mode warp.
  --local      Shortcut for --mode local.
  --build      Rebuild image before start. Defaults to enabled.
  --no-build   Start without rebuilding image.
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
    --build)
      BUILD_IMAGE="true"
      shift
      ;;
    --no-build)
      BUILD_IMAGE="false"
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

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)
    TARGETARCH="amd64"
    ;;
  aarch64|arm64)
    TARGETARCH="arm64"
    ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

export BUILDPLATFORM="linux/$TARGETARCH"
export TARGETPLATFORM="linux/$TARGETARCH"
export TARGETARCH

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
  COMPOSE_IMPL="v2"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
  COMPOSE_IMPL="v1"
else
  echo "docker compose is not available" >&2
  exit 1
fi

if [[ "$COMPOSE_IMPL" == "v1" ]]; then
  "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" down --remove-orphans
fi

CMD=("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d)
if [[ "$BUILD_IMAGE" == "true" ]]; then
  CMD+=(--build)
fi

printf 'Starting %s deployment with build=%s\n' "$MODE" "$BUILD_IMAGE"
"${CMD[@]}"
