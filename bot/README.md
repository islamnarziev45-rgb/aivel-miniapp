# AIVEL VPN Telegram bot

Standalone aiogram bot that serves as an entry point to the AIVEL VPN Mini App. Subscription and trial state must be managed by the authenticated Mini App backend; the bot intentionally stores no local subscription records.

## Configuration

- `AIVEL_BOT_TOKEN`: read from a protected VPS environment file; never commit it.
- `MINI_APP_URL`: defaults to `https://islamnarziev45-rgb.github.io/aivel-miniapp/`.

Inline buttons pass `startapp` values: `home`, `trial`, `tariffs`, `profile`, `install`, `support`, `agreement`. The Mini App must route those values to the matching screen and perform trial/payment actions through the backend.

## VPS deployment

Run `bot.py` as a separate `systemd` service on the VPS, for example from `/opt/aivel-vpn-bot`. Keep the bot token in a root-readable environment file. Update the source in GitHub, pull it on the VPS, then restart `aivel-vpn-bot.service`.

Do not start polling with the production token while ChatPlace is still consuming updates for that same Telegram bot. Switch the update source only after the Mini App flows are ready.
