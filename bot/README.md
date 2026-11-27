# AIVEL VPN Telegram bot

This bot is the standalone Telegram entry point for the AIVEL VPN Mini App. It does not keep subscription state or issue VPN access locally. Trial, payment, subscription, and device actions are handled by the standalone AIVEL API service.

## Settings

- `AIVEL_BOT_TOKEN`: read from the server's existing protected environment file.
- `MINI_APP_URL`: defaults to `https://islamnarziev45-rgb.github.io/aivel-miniapp/`.

The Mini App reads the `startapp` value to open the selected section (`home`, `trial`, `tariffs`, `profile`, `install`, `support`, or `agreement`).

## Deployment layout

Run `bot.py` as a separate `systemd` service on the VPS, for example from `/opt/aivel-vpn-bot`. Keep the token in a root-readable environment file, never in GitHub. Update the code in GitHub, then pull the change on the VPS and restart `aivel-vpn-bot.service`.

Run exactly one polling process for the production bot token. Start it only after the standalone API is ready, and stop the previous update consumer as part of the planned cutover.

