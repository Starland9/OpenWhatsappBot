---
name: WhatsApp Bot Expert - Baileys Edition
description: Agent spécialisé dans la création complète de bots WhatsApp utilisant Baileys avec architecture modulaire, multi-sessions, plugins dynamiques et base de données
---

# Expert WhatsApp Bot avec Baileys

## Mission

Recoder un bot WhatsApp multifonctionnel avec **@whiskeysockets/baileys** (v6.7+), architecture modulaire et production-ready.

## Features Essentielles

**Messages**: Text/Media handlers, Reply/Quote, Reactions, Edit/Delete, Anti-delete
**Commandes**: Prefix configurable, Regex patterns, Permissions (sudo/admin), Group/PM specific
**Groupes**: Greetings, Anti-link/spam/words/bot, Mute, Warn system, Polls, Tag all
**Médias**: Stickers (img/video), EXIF, Image editing, Remove BG, TTS, FFmpeg conversion
**Downloads**: FB, IG, TikTok, Twitter, YouTube, Pinterest, Reddit, Mediafire, Spotify
**AI**: ChatGPT, Gemini, Groq, Bing, Auto-reply
**Utils**: URL shortener, QR, Fancy text, Weather, Movies, Translate
**Sessions**: Multi-device, Backup/restore, Auto-reconnect, QR/Pairing
**Database**: Users/Groups tracking, Messages, Filters, AFK, Warns, Votes
**Deploy**: Heroku, Koyeb, Render, VPS, PM2, Auto-update


## Architecture

### Structure Projet

```text
whatsapp-bot-baileys/
├── package.json
├── .env
├── config.js
├── index.js
├── lib/
│   ├── baileys/
│   │   ├── client.js
│   │   └── handler.js
│   ├── database/models/
│   │   ├── User.js
│   │   ├── Group.js
│   │   └── Filter.js
│   ├── classes/Message.js
│   ├── plugins/
│   │   ├── loader.js
│   │   └── registry.js
│   └── middleware/
├── plugins/
│   ├── general/
│   ├── group/
│   ├── media/
│   └── ai/
└── sessions/
```

### Stack

```json
{
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.9",
    "@hapi/boom": "^10.0.1",
    "sequelize": "^6.37.4",
    "pg": "^8.13.1",
    "sqlite3": "^5.1.7",
    "pino": "^9.4.0",
    "sharp": "^0.33.5",
    "fluent-ffmpeg": "^2.1.3",
    "axios": "^1.7.9",
    "openai": "^4.77.3",
    "@google/generative-ai": "^0.21.0"
  }
}
```



## Code Complet

### 1. Config (`config.js`)

```javascript
const { Sequelize } = require('sequelize')
require('dotenv').config()

const DATABASE_URL = process.env.DATABASE_URL || './database.db'
const DATABASE = DATABASE_URL.includes('postgres')
  ? new Sequelize(DATABASE_URL, {
      dialect: 'postgres',
      dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
      logging: false
    })
  : new Sequelize({ dialect: 'sqlite', storage: DATABASE_URL, logging: false })

module.exports = {
  VERSION: require('./package.json').version,
  SESSION_ID: process.env.SESSION_ID || '',
  PREFIX: process.env.PREFIX || '.',
  SUDO: process.env.SUDO?.split(',') || [],
  ALWAYS_ONLINE: process.env.ALWAYS_ONLINE === 'true',
  AUTO_READ: process.env.AUTO_READ === 'true',
  ANTI_DELETE: process.env.ANTI_DELETE === 'true',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  DATABASE
}
```

### 2. Client (`lib/baileys/client.js`)

```javascript
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, 
        fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys')
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const EventEmitter = require('events')

class WhatsAppClient extends EventEmitter {
  constructor(sessionId = 'main') {
    super()
    this.sessionPath = `./sessions/${sessionId}`
    this.sock = null
  }

  async initialize() {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath)
    this.sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true
    })

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true
        if (shouldReconnect) setTimeout(() => this.initialize(), 3000)
      } else if (connection === 'open') {
        console.log('✅ Connected')
        this.emit('ready')
      }
    })

    this.sock.ev.on('creds.update', saveCreds)
    this.sock.ev.on('messages.upsert', ({ messages }) => this.emit('messages', messages))
    
    return this.sock
  }
}

module.exports = WhatsAppClient
```

### 3. Message Class (`lib/classes/Message.js`)

```javascript
const { getContentType, downloadMediaMessage } = require('@whiskeysockets/baileys')
const config = require('../../config')

class Message {
  constructor(client, data) {
    this.client = client
    this.data = data
    this.key = data.key
    this.jid = data.key.remoteJid
    this.fromMe = data.key.fromMe
    this.type = getContentType(data.message)
    const msg = data.message[this.type]
    this.body = msg?.text || msg?.caption || msg?.conversation || ''
    this.sender = data.key.participant || data.key.remoteJid
    this.isGroup = this.jid.endsWith('@g.us')
    this.hasMedia = ['imageMessage', 'videoMessage', 'stickerMessage'].includes(this.type)
  }

  async reply(text) {
    return await this.client.sock.sendMessage(this.jid, { text }, { quoted: this.data })
  }

  async sendImage(buffer, caption = '') {
    return await this.client.sock.sendMessage(this.jid, { image: buffer, caption })
  }

  async sendSticker(buffer) {
    return await this.client.sock.sendMessage(this.jid, { sticker: buffer })
  }

  async react(emoji) {
    return await this.client.sock.sendMessage(this.jid, {
      react: { text: emoji, key: this.key }
    })
  }

  async downloadMedia() {
    if (!this.hasMedia) return null
    return await downloadMediaMessage(this.data, 'buffer', {}, {
      logger: { info() {}, error() {}, warn() {} }
    })
  }

  isSudo() {
    return config.SUDO.includes(this.sender.split('@')[0])
  }
}

module.exports = { Message }
```

### 4. Plugin Loader (`lib/plugins/loader.js`)

```javascript
const fs = require('fs').promises
const path = require('path')
const { registerCommand } = require('./registry')

class PluginLoader {
  async loadAll() {
    const categories = await fs.readdir('./plugins')
    for (const cat of categories) {
      const files = await fs.readdir(`./plugins/${cat}`)
      for (const file of files.filter(f => f.endsWith('.js'))) {
        const plugin = require(`../../plugins/${cat}/${file}`)
        if (plugin.command) registerCommand(plugin)
      }
    }
  }
}

module.exports = new PluginLoader()
```

### 5. Registry (`lib/plugins/registry.js`)

```javascript
const commands = new Map()

function registerCommand(plugin) {
  commands.set(plugin.command.pattern, plugin)
}

async function executeCommand(message) {
  const prefix = require('../../config').PREFIX
  if (!message.body.startsWith(prefix)) return
  
  const [cmd, ...args] = message.body.slice(prefix.length).trim().split(/\s+/)
  
  for (const [pattern, plugin] of commands) {
    if (new RegExp(`^${pattern}$`, 'i').test(cmd)) {
      try {
        await plugin.execute(message, args.join(' '))
      } catch (error) {
        await message.reply(`❌ Error: ${error.message}`)
      }
      break
    }
  }
}

module.exports = { registerCommand, executeCommand }
```

### 6. Exemples Plugins

**Ping** (`plugins/general/ping.js`):

```javascript
module.exports = {
  command: { pattern: 'ping', desc: 'Check latency', type: 'general' },
  async execute(message) {
    const start = Date.now()
    await message.reply('Pinging...')
    await message.reply(`🏓 Pong! ${Date.now() - start}ms`)
  }
}
```

**Sticker** (`plugins/media/sticker.js`):

```javascript
const sharp = require('sharp')

module.exports = {
  command: { pattern: 'sticker|s', desc: 'Create sticker', type: 'media' },
  async execute(message) {
    const buffer = await message.downloadMedia()
    if (!buffer) return await message.reply('Reply to image/video!')
    
    const sticker = await sharp(buffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp()
      .toBuffer()
    
    await message.sendSticker(sticker)
  }
}
```

**ChatGPT** (`plugins/ai/chatgpt.js`):

```javascript
const OpenAI = require('openai')
const config = require('../../config')
const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY })

module.exports = {
  command: { pattern: 'gpt|ai', desc: 'Ask ChatGPT', type: 'ai' },
  async execute(message, query) {
    if (!query) return await message.reply('Provide a question!')
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: query }]
    })
    
    await message.reply(completion.choices[0].message.content)
  }
}
```

### 7. Entry Point (`index.js`)

```javascript
const WhatsAppClient = require('./lib/baileys/client')
const { Message } = require('./lib/classes/Message')
const PluginLoader = require('./lib/plugins/loader')
const { executeCommand } = require('./lib/plugins/registry')
const { DATABASE } = require('./config')

async function start() {
  await DATABASE.authenticate()
  await DATABASE.sync()
  await PluginLoader.loadAll()
  
  const client = new WhatsAppClient()
  await client.initialize()
  
  client.on('messages', async (messages) => {
    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue
      const message = new Message(client, msg)
      if (message.fromMe) continue
      await executeCommand(message)
    }
  })
}

start()
```


```javascript

## Déploiement

### Local

```bash
npm install
cp .env.example .env
npm start  # ou pm2 start index.js
```

### Docker

```dockerfile
FROM node:20-alpine
RUN apk add ffmpeg python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "index.js"]
```

### Heroku

```bash
heroku create mon-bot
heroku addons:create heroku-postgresql:mini
heroku buildpacks:add heroku/nodejs
git push heroku main
```

## Features Avancées

**Multi-Session**:

```javascript
class SessionManager {
  sessions = new Map()
  async create(id) {
    const client = new WhatsAppClient(id)
    await client.initialize()
    this.sessions.set(id, client)
  }
}
```

**Scheduled Messages**:

```javascript
const cron = require('cron')
new cron.CronJob('0 9 * * *', () => {
  client.sendMessage(jid, { text: 'Good morning!' })
}).start()
```

**Auto-Reply Filters**:

```javascript
const filters = await Filter.findAll()
for (const filter of filters) {
  if (new RegExp(filter.pattern, 'i').test(message.body)) {
    await message.reply(filter.response)
  }
}
```

## Troubleshooting

**QR Code**: `npm install qrcode-terminal`

**Connexion**: Supprimer `sessions/` et reconnecter

**Permissions**: Vérifier SUDO dans .env

## Best Practices

1. **Error handling**: Try-catch partout
2. **Rate limiting**: Délais entre requêtes
3. **Memory**: Nettoyer buffers
4. **Security**: Valider inputs
5. **Logs**: Pino pour debug

## Conclusion

✅ Architecture modulaire
✅ Plugins dynamiques  
✅ Multi-sessions
✅ Production-ready
✅ Cloud deployable

Code complet, extensible et maintenant optimisé en taille !

