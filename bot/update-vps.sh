#!/usr/bin/env bash
set -Eeuo pipefail

REPO="islamnarziev45-rgb/aivel-miniapp"
REPO_DIR="/opt/aivel-vpn-miniapp"
BOT_DIR="/opt/aivel-vpn-bot"
BOT_ENV="${BOT_DIR}/bot.env"
CONTAINER="aivel-vpn-bot-standalone"
SERVICE="aivel-vpn-bot-standalone.service"
IMAGE="localhost/aivel-vpn-bot:standalone"
NEXT_CONTAINER="${CONTAINER}-next"
ROLLBACK_IMAGE="localhost/aivel-vpn-bot:rollback-$(date +%Y%m%d-%H%M%S)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in curl tar podman systemctl mkdir rm sleep; do
  command -v "$command" >/dev/null || fail "Missing command: $command"
done

[[ -f "$BOT_ENV" ]] || fail "Missing protected bot env file: $BOT_ENV"
systemctl is-active --quiet "$SERVICE" || fail "Bot service is not active."
podman container exists "$CONTAINER" || fail "Bot container is missing."
podman image inspect "$IMAGE" >/dev/null 2>&1 || fail "Current bot image is missing."

tmpdir="$(mktemp -d /tmp/aivel-vpn-bot-update-XXXXXX)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

curl -fL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" -o "$tmpdir/source.tar.gz"
mkdir -p "$tmpdir/source" "$REPO_DIR"
tar -xzf "$tmpdir/source.tar.gz" --strip-components=1 -C "$tmpdir/source"
[[ -f "$tmpdir/source/bot/bot.py" && -f "$tmpdir/source/bot/Containerfile" ]] || fail "Bot source is incomplete."

podman tag "$IMAGE" "$ROLLBACK_IMAGE"
podman build -t "$IMAGE" -f "$tmpdir/source/bot/Containerfile" "$tmpdir/source/bot"
podman rm -f "$NEXT_CONTAINER" >/dev/null 2>&1 || true
podman create --pull=never --name "$NEXT_CONTAINER" --network=host --env-file "$BOT_ENV" "$IMAGE" >/dev/null

systemctl stop "$SERVICE"
podman rm -f "$CONTAINER" >/dev/null

rollback() {
  printf 'New bot failed to start; restoring the previous image.\n' >&2
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  podman rm -f "$CONTAINER" "$NEXT_CONTAINER" >/dev/null 2>&1 || true
  podman tag "$ROLLBACK_IMAGE" "$IMAGE"
  podman create --pull=never --name "$CONTAINER" --network=host --env-file "$BOT_ENV" "$IMAGE" >/dev/null
  systemctl start "$SERVICE"
}

if ! podman rename "$NEXT_CONTAINER" "$CONTAINER"; then
  rollback
  fail "Could not switch to the new bot container."
fi
if ! systemctl start "$SERVICE"; then
  rollback
  fail "Could not start the updated bot service."
fi
sleep 5
if ! systemctl is-active --quiet "$SERVICE"; then
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  rollback
  fail "Updated bot did not stay active."
fi
cp -a "$tmpdir/source/bot/." "$REPO_DIR/bot/"
printf 'Telegram bot updated and active. Rollback image retained: %s\n' "$ROLLBACK_IMAGE"
printf 'Check logs: journalctl -u %s -n 40 --no-pager\n' "$SERVICE"
