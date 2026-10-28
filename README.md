# Open Whatsapp Bot

A powerful and modern open-source community WhatsApp bot built with **Baileys v7** featuring clean architecture, modular plugins, a web admin panel and production-ready deployment options.

## ✨ Features

- 🧩 **Modular Plugins** - Drop a file in `plugins/` and it is loaded; exact command matching and enforced permissions
- 🤖 **AI Integration** - ChatGPT, Google Gemini, and a Gemini-powered auto-responder with context awareness
- 📥 **Media Downloads** - YouTube, Instagram, TikTok, and more (yt-dlp)
- 🎨 **Media Processing** - Stickers, image editing, voice notes, and more
- 👥 **Group Management** - Admin tools, welcome/goodbye, filters, anti-link, warnings
- 👁️ **Auto Status Viewer** - Automatically view and react to WhatsApp statuses
- 🖥️ **Admin Panel** - Web interface (on by default): live dashboard, hot-applied settings, WhatsApp pairing from the browser, per-group moderation, broadcasts, encrypted backups, safe self-update
- 🗄️ **Database** - SQLite by default, PostgreSQL for production
- 🔄 **Auto-Reconnection** - Reconnects on its own and keeps the session
- 📊 **Production Ready** - PM2, Docker, Heroku and panel-host support, CPU optimized

## 📦 Requirements

- **Node.js** 24 or higher
- **FFmpeg** for media processing
- **yt-dlp** for the download commands (keep it up to date; the Docker image installs the latest release)
- A **WhatsApp account** for the bot

## 🚀 Quick Start

```bash
git clone https://github.com/Starland9/OpenWhatsappBot
cd OpenWhatsappBot
yarn install                      # no global Yarn? use: node .yarn/releases/yarn-4.17.0.cjs install
cp config.env.example config.env
```

Edit `config.env`. Only `SUDO` (your own number, digits with the country code) is really needed; everything else can be changed later from the admin panel:

```env
SUDO=33612345678      # owner number(s), comma separated
PREFIX=.              # command prefix
BOT_LANG=fr           # bot language: fr or en
```

Start the bot (`yarn dev` for a first run, see Deployment below for production):

```bash
yarn dev
```

1. Scan the QR code printed in the terminal with WhatsApp (Linked devices), or pair from the admin panel.
2. The console also prints a one-time link to set the administrator password of the admin panel: open it and choose a password.
3. Send `.menu` to the bot to see the commands.

## 🖥️ Admin Panel

A web interface to run the bot without editing files or typing commands. It is **on by default**, part of the bot process (nothing else to install) and listens on `http://localhost:3000/admin/`.

- First start: open the single-use setup link printed in the console (valid 30 minutes) and choose a password.
- Forgot the password: run `node tools/admin-reset.js` (the bot can keep running) to print a new link.
- On a VPS it only listens on `127.0.0.1`: use an SSH tunnel, or a reverse proxy with HTTPS and set `PANEL_PUBLIC_URL` and `PANEL_TRUST_PROXY`.
- `ADMIN_PANEL=false` turns it off; the bot keeps running.

Full reference (pages, hosting, Docker, backups, encryption key): [docs/ADMIN_PANEL.md](docs/ADMIN_PANEL.md).

## ☁️ Deployment

- **PM2** (recommended for a VPS): `pm2 start ecosystem.config.js`, or `yarn start` / `yarn stop`
- **Docker**: `docker compose up -d --build` (volumes for `sessions/`, `db/` and `data/`)
- **Panel hosts** (bot-hosting.net and similar): start command `node panel.js`, see the [Bot-Hosting Guide](docs/BOT_HOSTING_GUIDE.md) (French)
- **VPS / Ubuntu**, **Heroku** and **Koyeb**: step by step in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), which also covers the database (SQLite, PostgreSQL) and performance tips

## 📚 Documentation

| Document | What it covers |
|----------|----------------|
| [docs/ADMIN_PANEL.md](docs/ADMIN_PANEL.md) | Admin panel: pages, first start, reverse proxy, Docker, backups, security |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables, auto status viewer, AI auto-responder, security notes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | PM2, Docker, VPS, Heroku, Koyeb, database, performance and monitoring |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Everyday commands and the 15 multimodal plugins |
| [docs/PLUGIN_CREATION_DOC.md](docs/PLUGIN_CREATION_DOC.md) | Architecture, writing a plugin, `Message` class methods, examples |
| [docs/AUTO_RESPONDER_GUIDE.md](docs/AUTO_RESPONDER_GUIDE.md) | AI auto-responder and status viewer in depth |
| [docs/LANGUAGE_SYSTEM.md](docs/LANGUAGE_SYSTEM.md) | Translations (`getLang`, `lang/*.json`) |
| [docs/AUDIT_COMMANDES.md](docs/AUDIT_COMMANDES.md) | Every command: aliases, access, services, status, manual checklist (French) |
| [docs/BOT_HOSTING_GUIDE.md](docs/BOT_HOSTING_GUIDE.md) | Hosting on bot-hosting.net and panel hosts, endpoints, FAQ (French) |
| [docs/GUIDE_UTILISATEUR_COMPLET.md](docs/GUIDE_UTILISATEUR_COMPLET.md) | End-user guide with use cases (French) |
| [docs/CPU_OPTIMIZATION_GUIDE.md](docs/CPU_OPTIMIZATION_GUIDE.md), [OPTIMIZATION_SUMMARY](docs/OPTIMIZATION_SUMMARY.md), [RAPPORT_OPTIMISATION](docs/RAPPORT_OPTIMISATION.md) | CPU and memory optimization (French) |
| [docs/NEW_PLUGINS.md](docs/NEW_PLUGINS.md), [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md), [IMPLEMENTATION_SUMMARY](docs/IMPLEMENTATION_SUMMARY.md) | Implementation notes of past feature batches |
| [CLAUDE.md](CLAUDE.md) | Architecture and contributor contract (pipeline, plugins, database, i18n, tests) |

## 🛠️ Development

```bash
yarn test     # node:test suite: loads every command, no network, no WhatsApp (about 20 s, Node 24)
```

Plugins live in `plugins/*.js` and are picked up automatically; new commands are covered by the tests without extra work. Read [docs/PLUGIN_CREATION_DOC.md](docs/PLUGIN_CREATION_DOC.md) and [CLAUDE.md](CLAUDE.md) before writing one.

## 🤝 Contributing

Contributions are welcome! Fork the repository, create a feature branch, write clean code, run `yarn test`, and submit a pull request.

## 📄 License

MIT License (see `package.json`).

## 🙏 Credits

- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) - WhatsApp Web API
- [lyfe00011](https://github.com/lyfe00011) - Original inspiration

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/Starland9/OpenWhatsappBot/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Starland9/OpenWhatsappBot/discussions)

---

**Note**: This is an unofficial WhatsApp bot. Use responsibly and in accordance with WhatsApp's Terms of Service.
