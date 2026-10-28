# ☁️ Deployment

Pick the target that matches where the bot runs. Every target needs Node.js 24, `ffmpeg` and `yt-dlp` (the Docker image includes them), a `config.env` (see [CONFIGURATION.md](CONFIGURATION.md)) and a place to keep `sessions/` (the WhatsApp login), `data/` and the database across restarts.

On every target the [admin panel](ADMIN_PANEL.md) starts with the bot and prints a one-time link in the console to set the administrator password.

## Contents

- [PM2 (recommended for a VPS)](#pm2-recommended-for-a-vps)
- [VPS / Ubuntu](#vps--ubuntu)
- [Docker](#docker)
- [Panel hosts (bot-hosting.net and similar)](#panel-hosts-bot-hostingnet-and-similar)
- [Heroku](#heroku)
- [Koyeb](#koyeb)
- [Database](#database)
- [Performance and monitoring](#performance-and-monitoring)

## PM2 (recommended for a VPS)

`ecosystem.config.js` runs `index.js` as `open-whatsapp-bot` with a 500 MB memory restart and `--expose-gc`.

```bash
pm2 start ecosystem.config.js
pm2 logs open-whatsapp-bot
pm2 stop open-whatsapp-bot
```

`yarn start` and `yarn stop` do the same through PM2.

## VPS / Ubuntu

```bash
# Install Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install nodejs ffmpeg -y

# Install yt-dlp (latest release)
sudo wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Install Yarn and PM2
npm install -g yarn pm2

# Clone and setup
git clone https://github.com/Starland9/OpenWhatsappBot
cd OpenWhatsappBot
yarn install

# Configure
cp config.env.example config.env
nano config.env

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Keep yt-dlp recent (`yt-dlp -U`, or the **Maintenance** page of the panel): download sites change often. The panel listens on `127.0.0.1` on a VPS; reach it with an SSH tunnel or a reverse proxy, see [ADMIN_PANEL.md](ADMIN_PANEL.md#reaching-the-panel).

## Docker

```bash
docker compose up -d --build        # recommended: volumes for sessions/, db/ and data/
docker compose logs bot | grep admin/setup   # the admin panel setup link
```

or without compose:

```bash
docker build -t open-whatsapp-bot .
docker run -d --env-file config.env open-whatsapp-bot
```

The image (`node:24-alpine`) includes ffmpeg and the latest yt-dlp, and runs `node --expose-gc index.js`. Mount `/app/sessions`, `/app/db` and `/app/data` as volumes (`data/` holds `panel.key` and the panel backups); `docker-compose.yml` already declares them as named volumes. For the panel port, the health check and updates inside a container, see [Docker notes](ADMIN_PANEL.md#docker-notes) of the admin panel doc.

## Panel hosts (bot-hosting.net and similar)

For panel-based hosting platforms the start command is `node panel.js` (or `yarn panel`, `yarn panel:pm2`):

```bash
# Clone and install
git clone https://github.com/Starland9/OpenWhatsappBot .
yarn install

# Configure
cp config.env.example config.env
# Edit config.env (SUDO at least). The admin panel is on by default and uses the host's PORT

# Start with panel server
node panel.js
```

`panel.js` runs the same bot as `index.js` and keeps serving the monitoring routes even with `ADMIN_PANEL=false`, which is what hosting panels probe:

- 🏥 Health check endpoint (`/health`)
- 📊 Metrics endpoint (`/metrics`)
- 🔄 Keep-alive ping mechanism
- 🌐 Status page accessible via browser
- 🔒 Remote restart (`POST /api/restart`), disabled unless `PANEL_TOKEN` is set

See [ADMIN_PANEL.md](ADMIN_PANEL.md#monitoring-routes) for the access rules of these routes and the [Bot-Hosting Guide](BOT_HOSTING_GUIDE.md) (French) for the step-by-step instructions, endpoint responses and troubleshooting.

## Heroku

```bash
heroku create your-app-name
heroku addons:create heroku-postgresql:mini
git push heroku main
```

`heroku.yml` builds the `Dockerfile`. The Heroku filesystem is ephemeral: use the PostgreSQL add-on (`DATABASE_URL`) for data, and expect to pair WhatsApp again after a dyno restart unless the session is kept elsewhere.

## Koyeb

Deploy using the web UI or CLI with the provided `app.json`.

## Database

The bot uses the Sequelize ORM with two backends:

- **SQLite** (default): a file at `DATABASE_URL` or `./database.db` (`/app/db/database.db` in the compose file). For development and small deployments.
- **PostgreSQL**: set `DATABASE_URL` to a `postgres://...` URL (SSL is on unless `DATABASE_SSL=false`, for example for an internal database without SSL). For production deployments. This path is untested in the automated suite.

Models (one file each in `lib/database/models/`, auto-loaded):

- `User` - User data and AFK status
- `Group` - Group settings (welcome, goodbye)
- `Filter` - Auto-reply filters
- `Warn` - Warning system
- `BannedChat` - Chats where the bot is disabled (`.ban` / `.unban`)
- `Reminder`, `Task`, `NotifyKeyword` - Reminders, to-do lists and keyword alerts
- `UserStats`, `GroupEconomy`, `GroupRole` - Levels and rankings, coins, member roles
- `AntiDelete`, `ViewOnce`, `AutoResponder`, `Conversation`, `StickerCommand`, `Quote`, `Idea` - Anti-delete and view-once settings, auto-responder settings and history, sticker-bound commands, quotes, ideas
- Admin panel (14 tables): `AdminAccount`, `AdminSession`, `AdminToken`, `AuditLog` (access and history), `SettingOverride`, `TextOverride`, `CommandState` (values edited in the panel), `KnownChat`, `DailyStat` (chats seen, statistics), `Broadcast`, `BroadcastRun`, `BroadcastTarget` (broadcasts), `AlertState`, `AlertOutbox` (owner alerts)

The schema is synchronized at every start **without altering existing columns**: it creates missing tables and indexes and adds missing nullable or defaulted columns, nothing more. A column change needs a hand-written migration. Back up with the panel's **Backup** page, which moves freely between SQLite and PostgreSQL.

## Performance and monitoring

The bot has been optimized for low CPU and memory usage:

- **Smart caching**: database settings cached with a 5-minute TTL
- **Parallel processing**: messages and plugins processed in parallel (`MESSAGE_CONCURRENCY_LIMIT`)
- **Memory management**: automatic cleanup of old cached data
- **Database optimization**: connection pooling and indexed queries
- **Batch operations**: conversation updates batched every 2 seconds

| Metric | Improvement |
|--------|-------------|
| CPU Usage | ~70-80% reduction |
| Memory Usage | ~40-50% reduction |
| Startup Time | 40% faster |
| Message Latency | 70% faster |
| DB Queries | 90% reduction |

For the details and the recommended settings, see [CPU_OPTIMIZATION_GUIDE.md](CPU_OPTIMIZATION_GUIDE.md) (French).

Monitor the bot with PM2:

```bash
# Real-time monitoring
pm2 monit

# View detailed stats
pm2 show open-whatsapp-bot

# Check logs
pm2 logs --lines 100
```

Without PM2, use the **Dashboard** and **Logs** pages of the admin panel, or the `/health`, `/ping` and `/metrics` routes.
