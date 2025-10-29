# Open Whatsapp Bot

A powerful and modern open-source community WhatsApp bot built with **@whiskeysockets/baileys v6.7.9+** featuring clean architecture, modular plugins, and production-ready deployment options.

## ✨ Features

- 🔄 **Auto-Reconnection** - Intelligent reconnection with exponential backoff
- 🧩 **Modular Plugins** - Easy-to-add plugin system with auto-loading
- 🗄️ **Database Support** - SQLite for development, PostgreSQL for production
- 🤖 **AI Integration** - ChatGPT, Google Gemini support
- 📥 **Media Downloads** - YouTube, Instagram, TikTok, and more
- 👥 **Group Management** - Complete admin tools for groups
- 🎨 **Media Processing** - Stickers, image editing, and more
- 🔐 **Permission System** - Sudo users, admin-only commands
- 📊 **Production Ready** - PM2, Docker, Heroku support

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

## ☁️ Deployment

### PM2 (Recommended)

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
| `OPENAI_API_KEY` | OpenAI API key for ChatGPT | - |
| `GEMINI_API_KEY` | Google Gemini API key | - |
| `DATABASE_URL` | PostgreSQL URL (optional) | SQLite |
| `LOG_LEVEL` | Logging level | `info` |

See `config.env.example` for all available options.

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

