#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="/opt/aivel-vpn-miniapp"
ENV_SOURCE="/opt/aivel-closed-test/bridge.env"
BOT_DIR="/opt/aivel-vpn-bot"
BOT_ENV="${BOT_DIR}/bot.env"
CONTAINER="aivel-vpn-bot-standalone"
IMAGE="localhost/aivel-vpn-bot:standalone"
UNIT="/etc/systemd/system/aivel-vpn-bot-standalone.service"
MINI_APP_URL="https://islamnarziev45-rgb.github.io/aivel-miniapp/"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in curl tar awk podman systemctl mkdir chmod rm sleep grep journalctl; do
  command -v "$command" >/dev/null || fail "Missing command: $command"
done
[[ -f "$ENV_SOURCE" ]] || fail "Missing protected environment file: $ENV_SOURCE"
systemctl is-active --quiet aivel-vpn-api.service || fail "Standalone API service must be active first."
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18080/health)" == "200" ]] || fail "Standalone API health check failed."
podman container exists "$CONTAINER" && fail "Container $CONTAINER already exists; inspect it before retrying."
[[ ! -e "$UNIT" ]] || fail "Systemd unit already exists: $UNIT"

archive="$(mktemp /tmp/aivel-vpn-miniapp-XXXXXX.tar.gz)"
curl -fL https://codeload.github.com/islamnarziev45-rgb/aivel-miniapp/tar.gz/refs/heads/main -o "$archive"
mkdir -p "$REPO_DIR"
tar -xzf "$archive" --strip-components=1 -C "$REPO_DIR"
rm -f "$archive"
[[ -f "$REPO_DIR/bot/bot.py" && -f "$REPO_DIR/bot/Containerfile" ]] || fail "Standalone bot source is incomplete."

mkdir -p -m 700 "$BOT_DIR"
umask 077
tmp_env="${BOT_ENV}.tmp"
awk -F= '$1 == "AIVEL_BOT_TOKEN" { sub(/\r$/, ""); print; found++ } END { if (found != 1) exit 1 }' "$ENV_SOURCE" > "$tmp_env" || fail "Expected exactly one AIVEL_BOT_TOKEN in the server env file."
printf 'MINI_APP_URL=%s\n' "$MINI_APP_URL" >> "$tmp_env"
chmod 600 "$tmp_env"
mv -f "$tmp_env" "$BOT_ENV"

podman build -t "$IMAGE" -f "$REPO_DIR/bot/Containerfile" "$REPO_DIR/bot"
podman create --pull=never --name "$CONTAINER" --network=host --env-file "$BOT_ENV" "$IMAGE" >/dev/null
podman_bin="$(command -v podman)"
cat > "$UNIT" <<EOF
[Unit]
Description=AIVEL VPN Telegram bot
After=network-online.target aivel-vpn-api.service
Wants=network-online.target
Requires=aivel-vpn-api.service

[Service]
Type=simple
ExecStart=${podman_bin} start --attach ${CONTAINER}
ExecStop=${podman_bin} stop --time 20 ${CONTAINER}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now aivel-vpn-bot-standalone.service
sleep 5
if ! systemctl is-active --quiet aivel-vpn-bot-standalone.service; then
  journalctl -u aivel-vpn-bot-standalone.service -n 40 --no-pager >&2 || true
  fail "Standalone Telegram bot did not stay active."
fi
if podman logs --tail 40 "$CONTAINER" 2>&1 | grep -qi 'terminated by other getUpdates request'; then
  systemctl disable --now aivel-vpn-bot-standalone.service >/dev/null 2>&1 || true
  podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$UNIT" "$BOT_ENV"
  systemctl daemon-reload
  fail "Another polling process is still active; standalone bot stopped to avoid competing consumers."
fi
printf 'Standalone Telegram bot is active. Env file: %s (mode 600).\n' "$BOT_ENV"
printf 'Bot logs: journalctl -u aivel-vpn-bot-standalone.service -n 40 --no-pager\n'

