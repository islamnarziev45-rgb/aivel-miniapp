#!/usr/bin/env bash
set -Eeuo pipefail

OLD_CONTAINER="aivel-staging-bridge-miniapp"
NEW_CONTAINER="aivel-vpn-api"
IMAGE="localhost/aivel-vpn-api:standalone"
ENV_FILE="/opt/aivel-closed-test/bridge.env"
DATA_DIR="/opt/aivel-closed-test/data"
DB_FILE="${DATA_DIR}/orders.sqlite"
PORT="8080"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in podman curl cp mkdir date grep sed; do command -v "$command" >/dev/null || fail "Missing command: $command"; done
[[ -f "$ENV_FILE" ]] || fail "Missing server env file: $ENV_FILE"
[[ -d "$DATA_DIR" && -f "$DB_FILE" ]] || fail "The existing database was not found at $DB_FILE; refusing cutover."
podman container exists "$OLD_CONTAINER" || fail "Existing API container $OLD_CONTAINER was not found."
! podman container exists "$NEW_CONTAINER" || fail "Container $NEW_CONTAINER already exists; inspect it before continuing."

for key in AIVEL_DB AIVEL_BOT_TOKEN AIVEL_MINIAPP_ORIGIN AIVEL_MARZBAN_API AIVEL_MARZBAN_USER AIVEL_MARZBAN_PASSWORD AIVEL_MARZBAN_INBOUND AIVEL_SUBSCRIPTION_ORIGIN AIVEL_PLATEGA_MERCHANT_ID AIVEL_PLATEGA_SECRET; do
  grep -q "^${key}=" "$ENV_FILE" || fail "Missing required environment variable: $key"
done
grep -q '^AIVEL_DB=/data/orders.sqlite$' "$ENV_FILE" || fail "AIVEL_DB must remain /data/orders.sqlite to preserve existing subscriptions."
mounts="$(podman inspect --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "$OLD_CONTAINER")"
[[ "$mounts" == *"${DATA_DIR}:/data"* ]] || fail "The existing container does not mount the expected database directory."
origin="$(sed -n 's/^AIVEL_MINIAPP_ORIGIN=//p' "$ENV_FILE" | head -n 1)"
[[ "$origin" == https://* ]] || fail "Mini App origin in the env file is not HTTPS."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
podman build --pull=never -t "$IMAGE" -f "${script_dir}/Containerfile" "$script_dir"

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="/opt/aivel-closed-test/backups/standalone-${timestamp}"
new_started=0
old_stopped=0
rollback() {
  status=$?
  if (( status != 0 )); then
    printf 'Cutover failed; restoring the previous API container. Backup: %s\n' "$backup_dir" >&2
    if (( new_started )); then podman rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true; fi
    if (( old_stopped )); then podman start "$OLD_CONTAINER" >/dev/null 2>&1 || true; fi
  fi
  exit "$status"
}
trap rollback EXIT

old_stopped=1
podman stop --time 20 "$OLD_CONTAINER" >/dev/null
mkdir -p "$backup_dir"
cp -a "$DB_FILE" "$backup_dir/"
for sidecar in "${DB_FILE}-wal" "${DB_FILE}-shm"; do
  [[ ! -e "$sidecar" ]] || cp -a "$sidecar" "$backup_dir/"
done

podman run -d --pull=never --name "$NEW_CONTAINER" --restart=always --network=host \
  --env-file "$ENV_FILE" -v "${DATA_DIR}:/data" "$IMAGE" >/dev/null
new_started=1

healthy=0
for attempt in $(seq 1 20); do
  if [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || true)" == "200" ]]; then
    healthy=1
    break
  fi
  sleep 1
done
(( healthy == 1 )) || { podman logs --tail 60 "$NEW_CONTAINER" >&2; fail "Standalone API health check failed."; }

headers="$(curl -sS -D - -o /dev/null -X OPTIONS "http://127.0.0.1:${PORT}/miniapp/subscription" \
  -H "Origin: ${origin}" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-telegram-init-data')"
grep -Fqi "Access-Control-Allow-Origin: ${origin}" <<<"$headers" || fail "Mini App CORS check failed."

podman update --restart=no "$OLD_CONTAINER" >/dev/null
trap - EXIT
printf 'Standalone API is healthy. Previous container is stopped. DB backup: %s\n' "$backup_dir"

