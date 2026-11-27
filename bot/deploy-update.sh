#!/usr/bin/env bash
set -Eeuo pipefail

BOT_DIR="/opt/aivel-vpn-bot"
BOT_ENV="${BOT_DIR}/bot.env"
CONTAINER="aivel-vpn-bot-standalone"
SERVICE="aivel-vpn-bot-standalone.service"
UNIT="/etc/systemd/system/aivel-vpn-bot-standalone.service"
SCRIPT_DIR="/opt/aivel-vpn-miniapp/bot"
IMAGE="localhost/aivel-vpn-bot:update-$(date +%Y%m%d-%H%M%S)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in curl podman systemctl date mv grep sleep seq journalctl; do
  command -v "$command" >/dev/null || fail "Missing command: $command"
done
[[ -f "$BOT_ENV" ]] || fail "Missing protected bot env file: $BOT_ENV"
[[ -f "$SCRIPT_DIR/Containerfile" ]] || fail "Bot source directory not found: $SCRIPT_DIR"
[[ -f "$UNIT" ]] || fail "Systemd unit not found: $UNIT"
systemctl is-active --quiet aivel-vpn-api.service || fail "Standalone API must be active first."
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18080/health)" == "200" ]] || fail "Standalone API health check failed."
podman container exists "$CONTAINER" || fail "Bot container $CONTAINER was not found."

RAW_BASE="https://raw.githubusercontent.com/islamnarziev45-rgb/aivel-miniapp/main/bot"
for file in bot.py Containerfile requirements.txt; do
  curl -fsSL "${RAW_BASE}/${file}" -o "${SCRIPT_DIR}/${file}.new"
  mv "${SCRIPT_DIR}/${file}.new" "${SCRIPT_DIR}/${file}"
done
podman build --pull=never -t "$IMAGE" -f "$SCRIPT_DIR/Containerfile" "$SCRIPT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
rollback_container="${CONTAINER}-rollback-${timestamp}"
old_renamed=0
new_created=0
rollback() {
  status=$?
  if (( status != 0 )); then
    printf 'Bot update failed; restoring the previous bot container.\n' >&2
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
podman rename "$CONTAINER" "$rollback_container"
old_renamed=1
podman create --pull=never --name "$CONTAINER" --network=host --env-file "$BOT_ENV" "$IMAGE" >/dev/null
new_created=1
systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
systemctl start "$SERVICE"
healthy=0
for attempt in $(seq 1 15); do
  if systemctl is-active --quiet "$SERVICE" && podman inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
    healthy=1
    break
  fi
  sleep 1
done
(( healthy == 1 )) || { journalctl -u "$SERVICE" -n 40 --no-pager >&2; fail "Updated bot did not stay active."; }
if podman logs --tail 40 "$CONTAINER" 2>&1 | grep -qi 'terminated by other getUpdates request'; then
  fail "Another Telegram polling process is active; update rolled back."
fi

trap - EXIT
printf 'Updated Telegram bot is active. Previous container retained as %s.\n' "$rollback_container"
printf 'Bot logs: journalctl -u %s -n 40 --no-pager\n' "$SERVICE"
