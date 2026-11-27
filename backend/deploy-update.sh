#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE="aivel-vpn-api.service"
CONTAINER="aivel-vpn-api"
IMAGE="localhost/aivel-vpn-api:update-$(date +%Y%m%d-%H%M%S)"
ENV_FILE="/opt/aivel-closed-test/bridge.env"
DATA_DIR="/opt/aivel-closed-test/data"
DB_FILE="${DATA_DIR}/orders.sqlite"
PORT="18080"
UNIT_FILE="/etc/systemd/system/${SERVICE}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

for command in podman curl cp mkdir date grep sed head seq sleep systemctl; do
  command -v "$command" >/dev/null || fail "Missing command: $command"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "${SCRIPT_DIR}/Containerfile" && -f "${SCRIPT_DIR}/server.mjs" ]] || fail "Run this script from the backend source directory."
[[ -f "$ENV_FILE" ]] || fail "Missing server env file: $ENV_FILE"
[[ -d "$DATA_DIR" && -f "$DB_FILE" ]] || fail "Existing database not found at $DB_FILE; refusing update."
[[ -f "$UNIT_FILE" ]] || fail "Systemd unit not found: $UNIT_FILE"
systemctl is-active --quiet "$SERVICE" || fail "$SERVICE is not active; inspect the service before updating."
podman container exists "$CONTAINER" || fail "Running API container $CONTAINER was not found."
podman inspect --format '{{.State.Running}}' "$CONTAINER" | grep -qx true || fail "API container is not running."

for key in AIVEL_DB AIVEL_BOT_TOKEN AIVEL_MINIAPP_ORIGIN AIVEL_MARZBAN_API AIVEL_MARZBAN_USER AIVEL_MARZBAN_PASSWORD AIVEL_MARZBAN_INBOUND AIVEL_SUBSCRIPTION_ORIGIN AIVEL_PLATEGA_MERCHANT_ID AIVEL_PLATEGA_SECRET; do
  grep -q "^$key=" "$ENV_FILE" || fail "Missing required environment variable: $key"
done
grep -q '^AIVEL_DB=/data/orders.sqlite$' "$ENV_FILE" || fail "AIVEL_DB must remain /data/orders.sqlite."
mounts="$(podman inspect --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "$CONTAINER")"
[[ "$mounts" == *"${DATA_DIR}:/data"* ]] || fail "The API container does not use the expected database mount."
origin="$(sed -n 's/^AIVEL_MINIAPP_ORIGIN=//p' "$ENV_FILE" | head -n 1)"
[[ "$origin" == https://* ]] || fail "Mini App origin must use HTTPS."

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="/opt/aivel-closed-test/backups/update-${timestamp}"
rollback_container="${CONTAINER}-rollback-${timestamp}"
old_renamed=0
new_created=0

podman build --pull=never -t "$IMAGE" -f "${SCRIPT_DIR}/Containerfile" "$SCRIPT_DIR"

rollback() {
  status=$?
  if (( status != 0 )); then
    printf 'Update failed; restoring the previous API container. Database backup: %s\n' "$backup_dir" >&2
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    if (( new_created )); then podman rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
    if (( old_renamed )); then
      podman rename "$rollback_container" "$CONTAINER" >/dev/null 2>&1 || true
      systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
      systemctl start "$SERVICE" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap rollback EXIT

systemctl stop "$SERVICE"
mkdir -p "$backup_dir"
cp -a "$DB_FILE" "$backup_dir/"
for sidecar in "${DB_FILE}-wal" "${DB_FILE}-shm"; do
  [[ ! -e "$sidecar" ]] || cp -a "$sidecar" "$backup_dir/"
done

podman rename "$CONTAINER" "$rollback_container"
old_renamed=1
podman create --pull=never --name "$CONTAINER" --network=host \
  --env-file "$ENV_FILE" --env "AIVEL_API_PORT=${PORT}" \
  -v "${DATA_DIR}:/data" "$IMAGE" >/dev/null
new_created=1

systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
systemctl start "$SERVICE"
healthy=0
for attempt in $(seq 1 20); do
  if [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || true)" == "200" ]]; then
    healthy=1
    break
  fi
  sleep 1
done
(( healthy == 1 )) || { podman logs --tail 60 "$CONTAINER" >&2; fail "Updated API health check failed."; }

headers="$(curl -sS -D - -o /dev/null -X OPTIONS "http://127.0.0.1:${PORT}/miniapp/subscription" \
  -H "Origin: ${origin}" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-telegram-init-data')"
grep -Fqi "Access-Control-Allow-Origin: ${origin}" <<<"$headers" || fail "Mini App CORS check failed."
systemctl is-active --quiet "$SERVICE" || fail "Updated API service is not active."

trap - EXIT
printf 'Updated API is healthy. Previous container retained as %s. Database backup: %s\n' "$rollback_container" "$backup_dir"
