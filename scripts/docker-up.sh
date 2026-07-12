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

DEFAULT_HOST_ROOT="/etc/chatgpt2api"
REPO_CONFIG_FILE="./config.json"
REPO_DATA_DIR="./data"

HOST_DATA_DIR="${CHATGPT2API_HOST_DATA_DIR:-$DEFAULT_HOST_ROOT/data}"
HOST_CONFIG_FILE="${CHATGPT2API_HOST_CONFIG_FILE:-$DEFAULT_HOST_ROOT/config.json}"

mkdir -p "$HOST_DATA_DIR"
mkdir -p "$(dirname "$HOST_CONFIG_FILE")"

if [[ ! -e "$HOST_CONFIG_FILE" && -f "$REPO_CONFIG_FILE" ]]; then
  cp "$REPO_CONFIG_FILE" "$HOST_CONFIG_FILE"
fi

if [[ -d "$REPO_DATA_DIR" && -z "$(find "$HOST_DATA_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
  cp -a "$REPO_DATA_DIR"/. "$HOST_DATA_DIR"/
fi

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

remove_legacy_compose_containers() {
  local container_name
  local -a container_ids

  while IFS= read -r container_name; do
    [[ -n "$container_name" ]] || continue
    container_ids=()
    mapfile -t container_ids < <(docker ps -aq --filter "name=$container_name")
    if (( ${#container_ids[@]} == 0 )); then
      continue
    fi
    printf 'Removing stale legacy Compose container(s) for %s\n' "$container_name"
    docker rm -f "${container_ids[@]}"
  done < <(
    "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" config |
      sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' |
      tr -d "\"'"
  )
}

if [[ "$COMPOSE_IMPL" == "v1" ]]; then
  if ! "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" down --remove-orphans; then
    echo "legacy docker-compose down failed; removing stale declared containers" >&2
  fi
  remove_legacy_compose_containers
fi

CMD=("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d)
if [[ "$BUILD_IMAGE" == "true" ]]; then
  CMD+=(--build)
fi

printf 'Starting %s deployment with build=%s\n' "$MODE" "$BUILD_IMAGE"
"${CMD[@]}"
