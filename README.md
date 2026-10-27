# Open Whatsapp Bot

A powerful and modern open-source community WhatsApp bot built with **Baileys v7** featuring clean architecture, modular plugins, and production-ready deployment options.

## ✨ Features

- 🔄 **Auto-Reconnection** - Intelligent reconnection with exponential backoff
- 🧩 **Modular Plugins** - Easy-to-add plugin system with auto-loading
- 🗄️ **Database Support** - SQLite for development, PostgreSQL for production
- 🤖 **AI Integration** - ChatGPT, Google Gemini support
- 🤖 **AI Auto-Responder** - Gemini-powered automatic responses with context awareness
- 👁️ **Auto Status Viewer** - Automatically view and react to WhatsApp statuses
- 📥 **Media Downloads** - YouTube, Instagram, TikTok, and more
- 👥 **Group Management** - Complete admin tools for groups
- 🎨 **Media Processing** - Stickers, image editing, and more
- 🔐 **Permission System** - Sudo users, admin-only commands, enforced before a command runs
- 📊 **Production Ready** - PM2, Docker, Heroku support
- ⚡ **CPU Optimized** - ~70-80% CPU reduction with caching and parallel processing

## 📦 Requirements

- **Node.js**: v24.0.0 or higher
- **FFmpeg**: For media processing
- **yt-dlp**: For `.ytdl`, `.insta` and `.dl` (keep it up to date; the Docker image installs the latest release)
- **PostgreSQL**: For production (optional, SQLite by default)

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/Starland9/OpenWhatsappBot
cd OpenWhatsappBot
```

### 2. Install Dependencies

```bash
yarn install
```

### 3. Configure Environment

Create a `config.env` file:

```bash
cp config.env.example config.env
```

Edit `config.env` with your settings:

```env
SESSION_ID=
PREFIX=.
SUDO=your_number_here
OPENAI_API_KEY=your_openai_key
GEMINI_API_KEY=your_gemini_key
```

### 4. Start the Bot

```bash
yarn start
```

Scan the QR code with WhatsApp to authenticate.

### 5. Run the Tests (optional)

```bash
yarn test
```

The automated checks load every command and simulate their calls without WhatsApp or network access (about 10 seconds, Node 24).

## 📱 Available Commands

### General

- `.ping` - Check bot latency
- `.menu` - Display all commands
- `.help <command>` - Show the aliases, access and usage of one command
- `.alive` - Show bot status

### AI

- `.gpt <query>` - Chat with ChatGPT
- `.gemini <query>` - Chat with Google Gemini

### Group Management

- `.tagall <text>` - Tag all members (admin only)
- `.kick @user` - Remove member(s) (admin only)
- `.promote @user` - Promote to admin (admin only)
- `.demote @user` - Demote from admin (admin only)
- `.warn @user [reason]` - Warn a member (admin only)

### Media

- `.sticker` - Create sticker from image/video (reply to media)
- `.qr <text>` - Generate QR code

### Utilities

- `.trt <lang> <text>` - Translate a text (aliases `.translate`, `.tr`; also works on a replied message)
- `.remind <when> <text>` - Persistent reminder, e.g. `.remind 2h Call` or `.remind 14:30 Meeting`

### Downloads

- `.ytdl <url>` - Download a YouTube video (15 min max; alias `.ytv`)
- `.yta <url>` - Download YouTube audio (60 min max)
- `.dl <url> [audio]` - Download from TikTok, Instagram, Facebook, X and more

Every command, its aliases, who can use it, the external service it needs and its audit status are listed in [docs/AUDIT_COMMANDES.md](docs/AUDIT_COMMANDES.md) (in French). Send `.menu` to the bot for the live list.

## 🏗️ Architecture

```
open-whatsapp-bot/
├── config.js                 # Configuration management
├── index.js                  # Entry point
├── ecosystem.config.js       # PM2 configuration
├── lib/
│   ├── baileys/
│   │   └── client.js        # WhatsApp client
│   ├── classes/
│   │   └── Message.js       # Message abstraction
│   ├── core/
│   │   └── pipeline.js      # Message pipeline, shared by index.js and panel.js
│   ├── plugins/
│   │   ├── loader.js        # Plugin loader
│   │   └── registry.js      # Command registry (exact aliases, permissions, hooks)
│   ├── utils/               # http, ffmpeg, yt-dlp downloader, caches, scheduler...
│   └── database/
│       ├── index.js         # Database initialization and additive schema sync
│       └── models/          # Sequelize models
│           ├── User.js
│           ├── Group.js
│           ├── Filter.js
│           └── Warn.js
├── plugins/                 # Plugin files
│   ├── ping.js
│   ├── help.js
│   ├── chatgpt.js
│   └── ...
├── test/                    # node:test suite (yarn test)
└── docs/AUDIT_COMMANDES.md  # Audit report of every command
```

## 🔌 Creating Plugins

Create a new file in `/plugins` directory:

```javascript
const { getLang } = require('../lib/utils/language')

module.exports = {
  command: {
    pattern: 'mycommand|mc',                // Exact names, separated by "|" (not a regex)
    desc: getLang('plugins.mycommand.desc'), // Description (translated)
    type: 'general',                        // Category in the menu
    fromMe: false,                          // Sudo (owner) only (ownerOnly is a synonym)
    onlyGroup: false,                       // Group only
    onlyPm: false,                          // PM only
    adminOnly: false                        // Group admins or owner only (implies group)
  },

  // args: words after the command, single-spaced
  // ctx.command: the alias that matched; ctx.rawArgs: text after it, newlines kept
  async execute(message, args, ctx) {
    if (!args) return message.reply(getLang('plugins.mycommand.usage', '.'))
    await message.reply(getLang('plugins.mycommand.hello'))
  }
}
```

Rules to know:

- A command only runs when the word after the prefix **equals** its name or one of its aliases (case-insensitive). Permissions (`fromMe`, `onlyGroup`, `onlyPm`, `adminOnly`) are checked before `execute`, so do not repeat them; only check `await message.isBotAdmin()` before an admin action.
- Every text sent to users goes through `getLang('plugins.<name>.<key>', ...args)` with the same key in `lang/en.json` and `lang/fr.json`. Never put `error.message` in a reply; a thrown error already gives the user a generic message and the stack goes to the owner.
- Optional hooks in the same file: `onMessage(message)`, `onGroupParticipants(update, client)`, `onReady(client)` and `handleButtonReply(message)` (button ids look like `mycommand:action:arg`).
- Check your work with `yarn test`; see `CLAUDE.md` and `docs/PLUGIN_CREATION_DOC.md` for the full contract.

### Message Class Methods

```javascript
// Reply to message
await message.reply('Text')

// Send media
await message.sendImage(buffer, 'caption')
await message.sendVideo(buffer, 'caption')
await message.sendSticker(buffer)
await message.sendAudio(buffer)
await message.sendVoice(buffer)   // voice note (converted to ogg/opus)

// React to message
await message.react('✅')

// Delete message
await message.delete()

// Download the media of the message
const buffer = await message.downloadMedia()

// Media and text of the message it replies to
const quoted = await message.getQuotedMedia({ maxBytes: 20 * 1024 * 1024 }) // { buffer, type, mimetype } or null
const quotedText = message.getQuotedText()

// Group operations
await message.kick(['jid1', 'jid2'])
await message.promote(['jid1'])
await message.demote(['jid1'])

// Check permissions
message.isSudo()
await message.isBotAdmin()
await message.isSenderAdmin()

// Get group info
const metadata = await message.getGroupMetadata()
```

## 🆕 New Features

### Auto Status Viewer

Automatically view and/or react to WhatsApp statuses with random emojis.

**Configuration:**

```env
AUTO_STATUS_VIEW=true      # Auto-view statuses
AUTO_STATUS_REACT=false    # Auto-react to statuses
STATUS_EMOJIS=😀,👍,❤️,🔥,💯,✨,🎉,👏,💪,🙌
```

**Features:**

- `AUTO_STATUS_VIEW`: Automatically mark statuses as viewed
- `AUTO_STATUS_REACT`: Automatically react to statuses with random emojis from the configured list
- Both features can be enabled independently
- Prevents duplicate reactions with smart tracking

### AI Auto-Responder (Gemini)

Intelligent auto-responder that uses Google Gemini AI with conversation context management.

**Configuration:**

```env
AUTO_RESPONDER_ENABLED=true
AUTO_RESPONDER_IGNORE_NUMBERS=1234567890,0987654321
AUTO_RESPONDER_PERSONALITY=You are a helpful and friendly assistant.
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
```

**Commands (owner only):**

- `.ar status` - View current settings
- `.ar on/off` - Enable/disable auto-responder
- `.ar ignore add <number>` - Add number to ignore list
- `.ar ignore remove <number>` - Remove number from ignore list
- `.ar ignore list` - Show ignored numbers
- `.ar ignore clear` - Clear ignore list
- `.ar personality <text>` - Set AI personality

**Features:**

- Context-aware conversations (remembers last 10 messages)
- 30-minute context timeout
- Customizable AI personality
- Ignore list management
- Private messages only
- Typing indicator

See [AUTO_RESPONDER_GUIDE.md](docs/AUTO_RESPONDER_GUIDE.md) for detailed documentation.

## ☁️ Deployment

### Bot-Hosting.net / Panel Hosting (NEW!)

For panel-based hosting platforms like bot-hosting.net:

```bash
# Clone and install
git clone https://github.com/Starland9/OpenWhatsappBot .
yarn install

# Configure
cp config.env.example config.env
# Edit config.env with PANEL_ENABLED=true

# Start with panel server
node panel.js
```

The `panel.js` file provides:

- 🏥 Health check endpoint (`/health`)
- 📊 Metrics endpoint (`/metrics`)
- 🔄 Keep-alive ping mechanism
- 🌐 Status page accessible via browser
- 🔒 Remote restart (`POST /api/restart`), disabled unless `PANEL_TOKEN` is set

`/health`, `/status`, `/ping`, `/metrics` and `/api/info` are read-only and public. `POST /api/restart` answers `403` while `PANEL_TOKEN` is empty, `401` without the right token and `405` for any other method:

```bash
# config.env: PANEL_TOKEN=a-long-random-secret
curl -X POST -H "Authorization: Bearer a-long-random-secret" http://localhost:3000/api/restart
```

Stopping the panel (SIGTERM/SIGINT) closes the WhatsApp connection without logging the device out, so a restart does not need a new QR scan.

See [Bot-Hosting Guide](docs/BOT_HOSTING_GUIDE.md) for detailed instructions.

### PM2 (Recommended for VPS)

```bash
pm2 start ecosystem.config.js
pm2 logs open-whatsapp-bot
pm2 stop open-whatsapp-bot
```

### Docker

```bash
docker build -t open-whatsapp-bot .
docker run -d --env-file config.env open-whatsapp-bot
```

The image includes ffmpeg and the latest yt-dlp.

### Heroku

```bash
heroku create your-app-name
heroku addons:create heroku-postgresql:mini
git push heroku main
```

### Koyeb

Deploy using the web UI or CLI with the provided `app.json`.

### VPS/Ubuntu

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

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_ID` | Session authentication data | - |
| `PREFIX` | Command prefix | `.` |
| `SUDO` | Sudo user numbers (comma-separated) | - |
| `ALWAYS_ONLINE` | Keep bot always online | `false` |
| `AUTO_READ` | Auto-read messages | `true` |
| `AUTO_STATUS_VIEW` | Auto-view statuses | `true` |
| `AUTO_STATUS_REACT` | Auto-react to statuses | `false` |
| `OPENAI_API_KEY` | OpenAI API key for ChatGPT | - |
| `OPENAI_MODEL` | Model used by `.gpt` | `gpt-4o-mini` |
| `GEMINI_API_KEY` | Google Gemini API key | - |
| `GEMINI_MODEL` | Model used by `.gemini` and the auto-responder | `gemini-2.5-flash` |
| `BOT_LANG` | Bot language (`fr` or `en` are complete) | `fr` |
| `TIMEZONE` | Time zone of reminders | `UTC` |
| `DATABASE_URL` | PostgreSQL URL (optional) | SQLite |
| `LOG_LEVEL` | Logging level | `info` |

See `config.env.example` for all available options.

## ⚡ Performance & Optimization

The bot has been extensively optimized for low CPU and memory usage:

- **Smart Caching**: Database settings cached with 5-minute TTL
- **Parallel Processing**: Messages and plugins processed in parallel
- **Memory Management**: Automatic cleanup of old cached data
- **Database Optimization**: Connection pooling and indexed queries
- **Batch Operations**: Conversation updates batched every 2 seconds

### Performance Metrics

| Metric | Improvement |
|--------|-------------|
| CPU Usage | ~70-80% reduction |
| Memory Usage | ~40-50% reduction |
| Startup Time | 40% faster |
| Message Latency | 70% faster |
| DB Queries | 90% reduction |

For detailed optimization information, see [CPU_OPTIMIZATION_GUIDE.md](docs/CPU_OPTIMIZATION_GUIDE.md).

### Monitoring

Monitor bot performance with PM2:

```bash
# Real-time monitoring
pm2 monit

# View detailed stats
pm2 show open-whatsapp-bot

# Check logs
pm2 logs --lines 100
```

## 📝 Database

The bot uses Sequelize ORM with support for:

- **SQLite** (default) - For development and small deployments
- **PostgreSQL** - For production deployments

Models:

- `User` - User data and AFK status
- `Group` - Group settings (welcome, goodbye)
- `Filter` - Auto-reply filters
- `Warn` - Warning system
- `BannedChat` - Chats where the bot is disabled (`.ban` / `.unban`)
- `Reminder`, `Task`, `NotifyKeyword` - Reminders, to-do lists and keyword alerts
- `UserStats`, `GroupEconomy`, `GroupRole` - Levels and rankings, coins, member roles

The schema is synchronized at every start without altering existing columns (new tables, columns and indexes only).

## 🛡️ Security

- No obfuscated code - fully transparent and auditable
- Official Baileys library - no custom forks
- Environment-based configuration - no hardcoded secrets
- Permission system - sudo and admin controls
- Input validation - sanitized user inputs

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Write clean, documented code
4. Test thoroughly (`yarn test`)
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file

## 🙏 Credits

- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) - WhatsApp Web API
- [lyfe00011](https://github.com/lyfe00011) - Original inspiration

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/Starland9/OpenWhatsappBot/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Starland9/OpenWhatsappBot/discussions)

---

**Note**: This is an unofficial WhatsApp bot. Use responsibly and in accordance with WhatsApp's Terms of Service.
