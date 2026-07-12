#!/usr/bin/env bash
# Deploy an already-pushed main commit without requiring GitHub credentials on the server.
set -Eeuo pipefail

readonly DEFAULT_DEPLOY_HOST="root@relay-us3.virvm.com"
readonly DEFAULT_DEPLOY_PORT="32559"
readonly DEFAULT_DEPLOY_PATH="/root/chatgpt2api"
readonly DEFAULT_COMPOSE_FILE="docker-compose.local.yml"
readonly DEFAULT_DEPLOY_HEALTH_URL="http://127.0.0.1:3000/health?format=json"
readonly DEFAULT_DEPLOY_SOURCE_REMOTE="jaime"

DEPLOY_HOST="${DEPLOY_HOST:-$DEFAULT_DEPLOY_HOST}"
DEPLOY_PORT="${DEPLOY_PORT:-$DEFAULT_DEPLOY_PORT}"
DEPLOY_PATH="${DEPLOY_PATH:-$DEFAULT_DEPLOY_PATH}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEFAULT_COMPOSE_FILE}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-$DEFAULT_DEPLOY_HEALTH_URL}"
DEPLOY_SOURCE_REMOTE="${DEPLOY_SOURCE_REMOTE:-$DEFAULT_DEPLOY_SOURCE_REMOTE}"
DEPLOY_REF="${DEPLOY_REF:-main}"
DRY_RUN=false
BUNDLE_FILE=""

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[deploy-production] %s\n' "$*"
}

cleanup_local_bundle() {
  if [[ -n "$BUNDLE_FILE" ]]; then
    rm -f -- "$BUNDLE_FILE" || true
  fi
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-production.sh [--dry-run]

Environment overrides:
  DEPLOY_HOST        SSH destination (default: root@relay-us3.virvm.com)
  DEPLOY_PORT        SSH port (default: 32559)
  DEPLOY_PATH        Remote repository path (default: /root/chatgpt2api)
  COMPOSE_FILE       Compose file inside the repository (default: docker-compose.local.yml)
  DEPLOY_HEALTH_URL  Remote health endpoint (default: http://127.0.0.1:3000/health?format=json)
  DEPLOY_SOURCE_REMOTE  Local Git remote that verifies the published main commit (default: jaime)
  DEPLOY_REF         Local committed ref to deploy (default: main; must equal DEPLOY_SOURCE_REMOTE/main)
EOF
}

validate_configuration() {
  [[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._:@-]*$ ]] || die "DEPLOY_HOST contains unsupported characters."
  [[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]] || die "DEPLOY_PORT must be numeric."
  (( 10#$DEPLOY_PORT >= 1 && 10#$DEPLOY_PORT <= 65535 )) || die "DEPLOY_PORT must be between 1 and 65535."
  [[ "$DEPLOY_PATH" == /* && "$DEPLOY_PATH" != *$'\n'* && "$DEPLOY_PATH" != *$'\r'* ]] || die "DEPLOY_PATH must be an absolute single-line path."
  [[ -n "$COMPOSE_FILE" && "$COMPOSE_FILE" != *$'\n'* && "$COMPOSE_FILE" != *$'\r'* ]] || die "COMPOSE_FILE must be a single-line path."
  [[ "$DEPLOY_HEALTH_URL" =~ ^https?:// && "$DEPLOY_HEALTH_URL" != *"@"* ]] || die "DEPLOY_HEALTH_URL must be an http(s) URL without credentials."
  [[ "$DEPLOY_SOURCE_REMOTE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "DEPLOY_SOURCE_REMOTE contains unsupported characters."
}

print_plan() {
  cat <<EOF
Deployment plan (dry run)
  source ref: $DEPLOY_REF (must match local $DEPLOY_SOURCE_REMOTE/main)
  target: $DEPLOY_HOST:$DEPLOY_PORT
  remote path: $DEPLOY_PATH
  compose file: $COMPOSE_FILE
  health URL: $DEPLOY_HEALTH_URL

  1. Verify the local committed source ref is already represented by $DEPLOY_SOURCE_REMOTE/main.
  2. Create a local git bundle and transfer it over SSH; the server never contacts GitHub.
  3. Refuse deployment if the remote main worktree has uncommitted files.
  4. Fast-forward remote main to the bundled commit without reset or checkout.
  5. Run scripts/docker-up.sh --local --build to migrate host mounts and rebuild the local image.
  6. Confirm the app service is recreated by the managed startup script.
  7. Confirm the app container, check health, then remove only replaced unused image IDs.
EOF
}

require_local_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required local command is unavailable: $1"
}

encode_argument() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

prepare_bundle() {
  local current_branch target_commit published_commit bundle_heads

  current_branch="$(git branch --show-current)"
  [[ "$current_branch" == "main" ]] || die "Local checkout must be on main; found ${current_branch:-detached HEAD}."

  target_commit="$(git rev-parse --verify "${DEPLOY_REF}^{commit}")" || die "DEPLOY_REF does not resolve to a commit: $DEPLOY_REF"
  published_commit="$(git rev-parse --verify "${DEPLOY_SOURCE_REMOTE}/main^{commit}")" || die "Local ${DEPLOY_SOURCE_REMOTE}/main is unavailable; fetch and push main before deploying."
  [[ "$target_commit" == "$published_commit" ]] || die "DEPLOY_REF is not verified as the pushed ${DEPLOY_SOURCE_REMOTE}/main commit. Push and verify main before deploying."

  BUNDLE_FILE="$(mktemp "${TMPDIR:-/tmp}/chatcanvas-deploy.XXXXXX")"
  git bundle create "$BUNDLE_FILE" "$DEPLOY_REF"
  bundle_heads="$(git bundle list-heads "$BUNDLE_FILE")"
  read -r BUNDLE_COMMIT BUNDLE_SOURCE_REF <<<"$bundle_heads"
  [[ "$BUNDLE_COMMIT" == "$target_commit" && -n "$BUNDLE_SOURCE_REF" ]] || die "The deployment bundle did not contain the requested commit."

  TARGET_COMMIT="$target_commit"
  REMOTE_BUNDLE_PATH="/tmp/chatcanvas-deploy-${TARGET_COMMIT}.bundle"
  BUNDLE_REF="refs/deploy/chatcanvas/${TARGET_COMMIT}"
}

transfer_bundle() {
  log "Transferring committed source bundle to $DEPLOY_HOST."
  ssh -p "$DEPLOY_PORT" -o BatchMode=yes "$DEPLOY_HOST" "umask 077 && cat > $REMOTE_BUNDLE_PATH" <"$BUNDLE_FILE"
}

run_remote_deploy() {
  local remote_command

  remote_command="bash -s -- '$(encode_argument "$DEPLOY_PATH")' '$(encode_argument "$COMPOSE_FILE")' '$(encode_argument "$DEPLOY_HEALTH_URL")' '$(encode_argument "$REMOTE_BUNDLE_PATH")' '$(encode_argument "$BUNDLE_SOURCE_REF")' '$(encode_argument "$BUNDLE_REF")' '$(encode_argument "$TARGET_COMMIT")'"

  ssh -p "$DEPLOY_PORT" -o BatchMode=yes "$DEPLOY_HOST" "$remote_command" <<'REMOTE_SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[deploy-production] %s\n' "$*"
}

decode_argument() {
  printf '%s' "$1" | base64 --decode
}

require_remote_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required remote command is unavailable: $1"
}

deploy_path="$(decode_argument "$1")"
compose_input="$(decode_argument "$2")"
health_url="$(decode_argument "$3")"
bundle_path="$(decode_argument "$4")"
bundle_source_ref="$(decode_argument "$5")"
bundle_ref="$(decode_argument "$6")"
target_commit="$(decode_argument "$7")"

cleanup_bundle() {
  rm -f -- "$bundle_path" || true
}
trap cleanup_bundle EXIT

check_health() {
  local health_response="" health_attempt

  for ((health_attempt = 1; health_attempt <= 15; health_attempt++)); do
    log "Checking health at $health_url (attempt $health_attempt/15)."
    if health_response="$(curl --fail --show-error --silent --connect-timeout 5 --max-time 15 "$health_url")"; then
      if printf '%s' "$health_response" | grep -Eq '"healthy"[[:space:]]*:[[:space:]]*true'; then
        return 0
      fi
      log "Health endpoint did not report healthy=true on attempt $health_attempt/15."
    else
      log "Health request failed on attempt $health_attempt/15; retrying."
    fi

    if (( health_attempt < 15 )); then
      sleep 2
    fi
  done

  fail "Health endpoint did not report healthy=true after 15 attempts."
}

require_remote_command git
require_remote_command docker
require_remote_command curl
require_remote_command realpath
require_remote_command base64
require_remote_command grep

if docker compose version >/dev/null 2>&1; then
  compose_impl="v2"
  compose() {
    docker compose "$@"
  }
elif command -v docker-compose >/dev/null 2>&1; then
  compose_impl="v1"
  compose() {
    docker-compose "$@"
  }
else
  fail "docker compose v2 and docker-compose v1 are both unavailable."
fi

seed_host_mounts() {
  local host_data_dir host_config_file

  host_data_dir="${CHATGPT2API_HOST_DATA_DIR:-/etc/chatgpt2api/data}"
  host_config_file="${CHATGPT2API_HOST_CONFIG_FILE:-/etc/chatgpt2api/config.json}"
  mkdir -p "$host_data_dir" "$(dirname "$host_config_file")"
  if [[ ! -e "$host_config_file" && -f "$deploy_path/config.json" ]]; then
    cp "$deploy_path/config.json" "$host_config_file"
  fi
  if [[ -d "$deploy_path/data" && -z "$(find "$host_data_dir" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
    cp -a "$deploy_path/data"/. "$host_data_dir"/
  fi
}

declare -a image_refs=()
declare -A image_refs_seen=()
declare -A old_image_ids=()
declare -A current_image_ids=()

add_image_ref() {
  local image_ref="$1"

  [[ -n "$image_ref" ]] || return 0
  if [[ -n "${image_refs_seen[$image_ref]:-}" ]]; then
    return 0
  fi
  image_refs_seen["$image_ref"]=1
  image_refs+=("$image_ref")
}

discover_image_refs() {
  local compose_images image_id image_ref

  case "$compose_impl" in
    v2)
      compose_images="$(compose -f "$compose_file" config --images)"
      while IFS= read -r image_ref; do
        add_image_ref "$image_ref"
      done <<<"$compose_images"
      ;;
    v1)
      compose_images="$(
        compose -f "$compose_file" config |
          awk '
            /^[[:space:]]*image:[[:space:]]*/ {
              image = $0
              sub(/^[[:space:]]*image:[[:space:]]*/, "", image)
              sub(/[[:space:]]+#.*$/, "", image)
              first = substr(image, 1, 1)
              last = substr(image, length(image), 1)
              quote = sprintf("%c", 34)
              squote = sprintf("%c", 39)
              if ((first == quote || first == squote) && last == first) {
                image = substr(image, 2, length(image) - 2)
              }
              if (image ~ /^[^[:space:]]+$/) print image
            }
          '
      )"
      while IFS= read -r image_ref; do
        add_image_ref "$image_ref"
      done <<<"$compose_images"
      if [[ "$compose_file" == "$deploy_path/docker-compose.local.yml" ]]; then
        add_image_ref "chatgpt2api:local"
      fi
      while IFS= read -r image_id; do
        [[ -n "$image_id" ]] || continue
        old_image_ids["$image_id"]=1
        while IFS= read -r image_ref; do
          add_image_ref "$image_ref"
        done < <(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$image_id" 2>/dev/null || true)
      done < <(compose -f "$compose_file" images -q 2>/dev/null | sort -u)
      ;;
    *)
      fail "Unknown compose implementation: $compose_impl"
      ;;
  esac
}

[[ "$target_commit" =~ ^[0-9a-f]{40,64}$ ]] || fail "Invalid bundled commit identifier."
[[ "$bundle_path" == "/tmp/chatcanvas-deploy-${target_commit}.bundle" ]] || fail "Invalid remote bundle path."
[[ -f "$bundle_path" ]] || fail "The transferred deployment bundle is missing."

cd "$deploy_path" || fail "Remote repository path does not exist: $deploy_path"
deploy_path="$(pwd -P)"

branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || fail "Remote checkout must be on main; found ${branch:-detached HEAD}."
if [[ -n "$(git status --porcelain)" ]]; then
  fail "Remote worktree is dirty. Commit and push remote changes before deployment; no stash was created."
fi

case "$compose_input" in
  /*) compose_candidate="$compose_input" ;;
  *) compose_candidate="$deploy_path/$compose_input" ;;
esac
compose_file="$(realpath -e -- "$compose_candidate")" || fail "Compose file does not exist: $compose_candidate"
case "$compose_file" in
  "$deploy_path"/*) ;;
  *) fail "COMPOSE_FILE must stay inside the remote repository." ;;
esac

git fetch --no-tags "$bundle_path" "$bundle_source_ref:$bundle_ref"
git merge-base --is-ancestor HEAD "$bundle_ref" || fail "Bundled commit is not a fast-forward from remote main."
git merge --ff-only "$bundle_ref"
[[ "$(git rev-parse HEAD)" == "$target_commit" ]] || fail "Remote main did not reach the requested bundled commit."

discover_image_refs
(( ${#image_refs[@]} > 0 )) || fail "No service image was found in $compose_file."

for image_ref in "${image_refs[@]}"; do
  if old_image_id="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null)"; then
    old_image_ids["$old_image_id"]=1
  fi
done

if ! compose -f "$compose_file" config --services | grep -Fxq app; then
  fail "The compose file must define the app service."
fi
if [[ ! -x "$deploy_path/scripts/docker-up.sh" ]]; then
  fail "Managed deployment helper is missing or not executable: scripts/docker-up.sh"
fi

case "$compose_file" in
  "$deploy_path/docker-compose.local.yml")
    log "Building replacement image(s) with managed local startup."
    "$deploy_path/scripts/docker-up.sh" --local --build
    ;;
  "$deploy_path/docker-compose.warp.yml")
    log "Building replacement image(s) with managed WARP startup."
    "$deploy_path/scripts/docker-up.sh" --warp --build
    ;;
  *)
    log "Building replacement image(s) with custom compose startup."
    seed_host_mounts
    compose -f "$compose_file" build --pull
    compose -f "$compose_file" up -d --force-recreate --remove-orphans --no-build
    ;;
esac

app_container_id="$(compose -f "$compose_file" ps -q app)"
[[ -n "$app_container_id" ]] || fail "The app service did not create a container."
[[ "$(docker inspect --format '{{.State.Running}}' "$app_container_id")" == "true" ]] || fail "The app container is not running."

check_health

for image_ref in "${image_refs[@]}"; do
  if current_image_id="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null)"; then
    current_image_ids["$current_image_id"]=1
  fi
done

for old_image_id in "${!old_image_ids[@]}"; do
  if [[ -n "${current_image_ids[$old_image_id]:-}" ]]; then
    log "Keeping unchanged image $old_image_id."
    continue
  fi
  if ! docker image inspect "$old_image_id" >/dev/null 2>&1; then
    continue
  fi
  if [[ -n "$(docker ps -aq --filter "ancestor=$old_image_id")" ]]; then
    log "Keeping old image $old_image_id because a container still uses it."
    continue
  fi
  log "Removing replaced, unused image $old_image_id."
  docker image rm "$old_image_id" || log "Could not remove old image $old_image_id; it was left intact."
done

log "Deployment completed at $target_commit."
REMOTE_SCRIPT
}

main() {
  while (( $# > 0 )); do
    case "$1" in
      --dry-run)
        DRY_RUN=true
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown argument: $1"
        ;;
    esac
    shift
  done

  validate_configuration
  if [[ "$DRY_RUN" == true ]]; then
    print_plan
    exit 0
  fi

  require_local_command git
  require_local_command ssh
  require_local_command base64
  require_local_command mktemp
  trap cleanup_local_bundle EXIT

  prepare_bundle
  transfer_bundle
  run_remote_deploy
}

main "$@"
