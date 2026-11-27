#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/opt/aivel-closed-test/bridge.env"
RAW_BASE="https://raw.githubusercontent.com/islamnarziev45-rgb/aivel-miniapp/main/backend"

fail() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }
for command in curl sed mv cp python3 podman; do
  command -v "$command" >/dev/null || fail "Не найдена команда: $command"
done
[[ -f "$ENV_FILE" ]] || fail "Не найден серверный env-файл: $ENV_FILE"
[[ -f "${SCRIPT_DIR}/Containerfile" ]] || fail "Запусти скрипт из каталога backend проекта."

curl -fsSL "${RAW_BASE}/deploy-update.sh" -o "${SCRIPT_DIR}/deploy-update.sh.new"
sed -i 's/\r$//' "${SCRIPT_DIR}/deploy-update.sh.new"
mv "${SCRIPT_DIR}/deploy-update.sh.new" "${SCRIPT_DIR}/deploy-update.sh"

read -r -p "Введи Merchant ID Platega: " NEW_MERCHANT
read -r -s -p "Введи новый API-ключ Platega (ввод скрыт): " NEW_SECRET
printf '\n'

[[ "$NEW_MERCHANT" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || fail "Merchant ID должен быть UUID без пробелов и обратного слеша."
[[ -n "$NEW_SECRET" ]] || fail "API-ключ пустой."

BACKUP_FILE="${ENV_FILE}.before-platega-$(date +%Y%m%d-%H%M%S)"
cp -a "$ENV_FILE" "$BACKUP_FILE"
chmod 600 "$ENV_FILE"

restore_env_on_failure() {
  status=$?
  if (( status != 0 )); then
    cp -a "$BACKUP_FILE" "$ENV_FILE"
    printf 'Обновление не завершено; восстановлен прежний env-файл. Резервная копия: %s\n' "$BACKUP_FILE" >&2
  fi
  exit "$status"
}
trap restore_env_on_failure EXIT

AIVEL_PLATEGA_MERCHANT_ID="$NEW_MERCHANT" AIVEL_PLATEGA_SECRET="$NEW_SECRET" python3 - "$ENV_FILE" <<'PY'
import os
import sys
import tempfile
from pathlib import Path

path = Path(sys.argv[1])
values = {
    "AIVEL_PLATEGA_MERCHANT_ID": os.environ["AIVEL_PLATEGA_MERCHANT_ID"],
    "AIVEL_PLATEGA_SECRET": os.environ["AIVEL_PLATEGA_SECRET"],
}
lines = path.read_text().splitlines()
out = []
written = set()
for line in lines:
    key = line.split("=", 1)[0]
    if key in values:
        if key not in written:
            out.append(f"{key}={values[key]}")
            written.add(key)
        continue
    out.append(line)
for key, value in values.items():
    if key not in written:
        out.append(f"{key}={value}")

fd, temp_name = tempfile.mkstemp(prefix=".bridge.env.", dir=str(path.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as temp:
        temp.write("\n".join(out) + "\n")
    os.chmod(temp_name, 0o600)
    os.replace(temp_name, path)
except Exception:
    try:
        os.unlink(temp_name)
    except FileNotFoundError:
        pass
    raise
PY

unset NEW_MERCHANT NEW_SECRET

podman run --rm --pull=never --network=host --env-file "$ENV_FILE" \
  docker.io/library/node:24-bookworm-slim node -e 'fetch("https://app.platega.io/balance/all",{headers:{"X-MerchantId":process.env.AIVEL_PLATEGA_MERCHANT_ID,"X-Secret":process.env.AIVEL_PLATEGA_SECRET}}).then(r=>{console.log("Platega credentials HTTP",r.status);process.exitCode=r.status===200?0:1}).catch(e=>{console.error("Platega connection check failed",e.name);process.exitCode=1})'

bash "${SCRIPT_DIR}/deploy-update.sh"
trap - EXIT
printf 'Новые данные Platega записаны, API обновлён. Env backup: %s\n' "$BACKUP_FILE"
