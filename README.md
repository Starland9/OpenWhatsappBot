# Open Whatsapp Bot

A powerful and modern open-source community WhatsApp bot built with **@whiskeysockets/baileys v6.7.9+** featuring clean architecture, modular plugins, and production-ready deployment options.

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
- 🔐 **Permission System** - Sudo users, admin-only commands
- 📊 **Production Ready** - PM2, Docker, Heroku support
- ⚡ **CPU Optimized** - ~70-80% CPU reduction with caching and parallel processing

## 📦 Requirements

- **Node.js**: v20.0.0 or higher
- **FFmpeg**: For media processing
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

## 📱 Available Commands

### General
- `.ping` - Check bot latency
- `.help` - Display all commands
- `.alive` - Show bot status

### AI
- `.gpt <query>` - Chat with ChatGPT
- `.gemini <query>` - Chat with Google Gemini

### Group Management
- `.tag <text>` - Tag all members
- `.kick @user` - Remove member (admin only)
- `.promote @user` - Promote to admin (admin only)
- `.demote @user` - Demote from admin (admin only)

### Media
- `.sticker` - Create sticker from image/video (reply to media)
- `.qr <text>` - Generate QR code

### Downloads
- `.ytdl <url>` - Download YouTube video
- `.yta <url>` - Download YouTube audio

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
│   ├── plugins/
│   │   ├── loader.js        # Plugin loader
│   │   └── registry.js      # Command registry
│   └── database/
│       ├── index.js         # Database initialization
│       └── models/          # Sequelize models
│           ├── User.js
│           ├── Group.js
│           ├── Filter.js
│           └── Warn.js
└── plugins/                 # Plugin files
    ├── ping.js
    ├── help.js
    ├── chatgpt.js
    └── ...
```

## 🔌 Creating Plugins

Create a new file in `/plugins` directory:

```javascript
module.exports = {
  command: {
    pattern: 'mycommand',           // Command pattern
    desc: 'My command description', // Description
    type: 'general',                // Category
    fromMe: false,                  // Sudo only
    onlyGroup: false,               // Group only
    onlyPm: false                   // PM only
  },
  
  async execute(message, args) {
    // Your command logic
    await message.reply('Hello!')
  }
}
```

### Message Class Methods

```javascript
// Reply to message
await message.reply('Text')

// Send media
await message.sendImage(buffer, 'caption')
await message.sendVideo(buffer, 'caption')
await message.sendSticker(buffer)
await message.sendAudio(buffer)

// React to message
await message.react('✅')

// Delete message
await message.delete()

// Download media
const buffer = await message.downloadMedia()

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
```

**Commands:**
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

See [AUTO_RESPONDER_GUIDE.md](AUTO_RESPONDER_GUIDE.md) for detailed documentation.

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
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs ffmpeg -y

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
| `GEMINI_API_KEY` | Google Gemini API key | - |
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

For detailed optimization information, see [CPU_OPTIMIZATION_GUIDE.md](CPU_OPTIMIZATION_GUIDE.md).

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
- `Group` - Group settings (antilink, mute, welcome)
- `Filter` - Auto-reply filters
- `Warn` - Warning system

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
4. Test thoroughly
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

