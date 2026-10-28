# 🖥️ Admin Panel

A web interface to run the bot without editing files or typing commands. **It is on by default** and is part of the bot process (`yarn start`, `yarn dev`, `yarn panel`, Docker): there is nothing else to install.

> New here? The [README](../README.md) has the 5-minute quick start. This page is the full reference of the panel. For the settings it edits, see [CONFIGURATION.md](CONFIGURATION.md); for hosting it, see [DEPLOYMENT.md](DEPLOYMENT.md) and the (French) [BOT_HOSTING_GUIDE.md](BOT_HOSTING_GUIDE.md).

## Contents

- [What it does](#what-it-does)
- [First start](#first-start)
- [Reaching the panel](#reaching-the-panel)
- [Reverse proxy settings](#reverse-proxy-settings)
- [Turning it off](#turning-it-off)
- [Panel hosts (bot-hosting.net and similar)](#panel-hosts-bot-hostingnet-and-similar)
- [Docker notes](#docker-notes)
- [Backups and the encryption key](#backups-and-the-encryption-key)
- [Monitoring routes](#monitoring-routes)
- [Security](#security)

## What it does

| Page | What you can do |
|------|-----------------|
| Dashboard | Live state, number, uptime, memory, last errors; restart the bot (the session is kept) |
| Settings | Every setting of `config.env`, applied on the next message; API keys stored encrypted, shown as "set" + last 4 characters, with a Test button |
| Pairing | Pair WhatsApp with a live QR code or a pairing code, disconnect |
| Commands | Turn a command off everywhere or in one group |
| Groups | Welcome and goodbye, filters, anti-link, anti-bot, mute (the bot must be admin of the group) |
| Data | Reminders, economy, keywords, stickers, AFK, tasks |
| Broadcasts | One-time and recurring messages to groups and chats, at most once per destination, spaced out |
| Backup | Encrypted export and verified restore |
| Maintenance | Update the bot (with automatic rollback), update yt-dlp, storage |
| Texts, Alerts, Logs, Statistics, History | Edit the bot's texts, WhatsApp alerts to the owner, live logs without secrets, usage charts, the administrator action log |

## First start

1. Start the bot. The panel starts with it.
2. The console prints a line such as `Admin panel: open this link to create the administrator password (single use, valid 30 minutes): http://localhost:3000/admin/setup?token=...`. It is printed again at every start while no account exists.
3. Open the link, choose a password of at least 12 characters: you are logged in. The link works once and expires after 30 minutes (the token leaves the address bar as soon as the page opens).
4. Open **Settings**: from now on you do not need to edit `config.env` again, except for the start-up settings the panel only displays (`ADMIN_PANEL`, `PANEL_HOST`, `PANEL_PORT`, `PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY`, `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK`, `DATABASE_URL`, `DATABASE_SSL`, `YTDLP_PATH`, `KEEP_ALIVE_INTERVAL`).

Five wrong passwords block the origin for 15 minutes.

**Forgot the password?** Run `node tools/admin-reset.js` (the bot can keep running) to print a new single-use link. On a host without a second shell, create an empty file `data/admin-reset` and restart the bot: the link appears in the console and the file is removed. Opening the link revokes every session.

## Reaching the panel

The bind address is chosen for safety (`PANEL_HOST` always wins when set):

| Where the bot runs | Panel listens on |
|--------------------|------------------|
| Your computer or a VPS | `127.0.0.1` (this machine only), port `PANEL_PORT`, then `PORT`, then `3000` |
| A container, or a hosting panel that sets `PORT` | `0.0.0.0` |

- **Same machine**: <http://localhost:3000/admin/>.
- **VPS**: keep the default and use an SSH tunnel, `ssh -L 3000:127.0.0.1:3000 user@server`, then open <http://localhost:3000/admin/>. Or put a reverse proxy with HTTPS in front (next section). The panel serves plain HTTP itself; opening it to the Internet without TLS shows a permanent warning.

## Reverse proxy settings

Behind a reverse proxy (Caddy, Nginx, Traefik, Dokploy) set two variables, in `config.env` or the environment (they are start-up settings: the panel only displays them):

| Variable | Value | Why |
|----------|-------|-----|
| `PANEL_PUBLIC_URL` | The public origin, no path: `https://bot.example.com` | Base of the one-time setup link, and an accepted `Origin`. Without it, a proxy that rewrites the `Host` header makes the panel answer `origin_mismatch` |
| `PANEL_TRUST_PROXY` | The proxy's address or network: an IP, a CIDR such as `172.18.0.0/16`, or the keywords `loopback`, `private`, `all` (comma separated) | Forwarded headers (`X-Forwarded-For`, `-Proto`, `-Host`) are honoured only from these peers, never automatically. Without it the panel sees the proxy as the visitor, shares one login throttle between all visitors and shows an "undeclared proxy" banner |

- **Caddy**: `bot.example.com { reverse_proxy 127.0.0.1:3000 }` plus `PANEL_TRUST_PROXY=loopback` is enough.
- **Nginx**: send the `X-Forwarded-*` headers and set `proxy_buffering off` for `/admin/api/events` (live updates; the panel falls back to polling otherwise).
- **Docker / Traefik / Dokploy**: use the network of the proxy container, for example `PANEL_TRUST_PROXY=private` or the CIDR of the Docker network.

## Turning it off

Set `ADMIN_PANEL=false`. Only that exact value turns the panel off, and the bot keeps running. If the port is busy the bot also keeps running, without the panel, and the console names `PANEL_PORT`, `PANEL_HOST` and `ADMIN_PANEL=false`.

**`PANEL_ENABLED` is gone.** It was never read by the old code. If it is still set, the console says once that it is ignored; the panel starts anyway, so write `ADMIN_PANEL=false` if you want it off.

## Panel hosts (bot-hosting.net and similar)

`node panel.js` and `node index.js` both serve the panel on the host's `PORT`. Read the console for the setup link and set `PANEL_PUBLIC_URL` to the public address of the service so the link is clickable. Without a terminal, create the empty `data/admin-reset` file and restart to get a fresh link. `panel.js` additionally keeps the monitoring routes alive when the panel is off (see [below](#monitoring-routes)). Step-by-step instructions (in French) are in [BOT_HOSTING_GUIDE.md](BOT_HOSTING_GUIDE.md).

## Docker notes

`docker-compose.yml` only **exposes** the panel port inside the container network: nothing outside can reach it until you choose how.

- To open it from the host only, uncomment `ports: ["127.0.0.1:3000:3000"]`.
- For a server, use a reverse proxy with HTTPS and set `PANEL_PUBLIC_URL` and `PANEL_TRUST_PROXY`.
- The setup link is in the container logs: `docker compose logs bot | grep admin/setup`.
- The image health check calls `/ping` (`/health` answers 503 until WhatsApp is paired, which would block the very first pairing).
- Keep the three volumes (`bot_sessions`, `bot_db`, `bot_data`); `data/` holds `panel.key` and the panel backups.
- An installation made from an image shows update instructions instead of an update button, and a yt-dlp update lives in the container's writable layer: it is lost when the container is recreated (rebuild the image to get the latest).

## Backups and the encryption key

The **Backup** page exports the settings (API keys included, inside the encrypted file), command states, edited texts and the bot data to one `.owb` file protected by a passphrase of at least 12 characters, chosen at export time and **not recoverable**. The administrator account, history, alert state, AI conversations and `data/panel.key` are never exported. The WhatsApp session is optional and the panel warns that it would let whoever holds the file take over the number. The file is built in `data/tmp` first, so the download shows its size.

A restore first checks the file without changing anything (wrong passphrase, altered file or a backup from a newer bot version are refused) and shows a summary with the number of rows per table and what this version ignores (`ignoredSettings`, `ignoredTexts`, unknown tables and columns). On confirmation the bot writes an automatic backup of the current state to `data/backups/pre-restore-<time>.owb`, replaces the data in one transaction and restarts in-process; if anything fails, the previous state is kept. A backup moves freely between SQLite and PostgreSQL.

API keys saved from the panel are encrypted at rest with a key in `data/panel.key` (created with mode 600 on the first save; keep `data/` on a volume). If that file is lost, the saved keys show "re-enter" in Settings and the values of `config.env` apply meanwhile: you only retype the keys.

## Monitoring routes

The monitoring routes (`/health`, `/healthz`, `/status`, `/ping`, `/metrics`, `/api/info`, `POST /api/restart`) are served by the same HTTP server, so existing uptime checks keep working. `/health`, `/status`, `/ping`, `/metrics` and `/api/info` are read-only and public. `POST /api/restart` answers `403` while `PANEL_TOKEN` is empty, `401` without the right token and `405` for any other method:

```bash
# config.env: PANEL_TOKEN=a-long-random-secret
curl -X POST -H "Authorization: Bearer a-long-random-secret" http://localhost:3000/api/restart
```

`panel.js` runs the same bot as `index.js`; with `ADMIN_PANEL=false` it still serves these routes alone, which is what hosting panels probe. Stopping the process (SIGTERM/SIGINT) closes the WhatsApp connection without logging the device out, so a restart does not need a new QR scan. The response formats are documented in [BOT_HOSTING_GUIDE.md](BOT_HOSTING_GUIDE.md).

## Security

Password hashed with scrypt, 24 h idle / 7 day sessions, per-origin login throttling, CSRF and `Origin` checks, strict CSP with no third-party request, API keys encrypted at rest, secrets masked in every response and log, and off the network by default (`127.0.0.1`).
