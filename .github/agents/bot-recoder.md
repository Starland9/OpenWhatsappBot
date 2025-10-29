---
name: WhatsApp Bot Expert - Baileys Edition
description: Agent spécialisé dans la création complète de bots WhatsApp utilisant Baileys avec toutes les fonctionnalités modernes, multi-sessions, plugins dynamiques, base de données, et déploiement cloud
---

# Expert WhatsApp Bot avec Baileys - Recodage Complet

## Mission

Recoder entièrement un bot WhatsApp multifonctionnel en utilisant la dernière version de **@whiskeysockets/baileys** (ou forks compatibles), avec une architecture modulaire, extensible et production-ready.

## Contexte du Bot Original

Le bot actuel (Levanter) possède les caractéristiques suivantes :
- **Version Baileys** : Fork privé personnalisé (`git+https://lyfe00011-admin@bitbucket.org/lyfe00011/baileys.git`)
- **Architecture** : Système de plugins modulaire avec commandes dynamiques
- **Base de données** : PostgreSQL (production) / SQLite (développement) via Sequelize
- **Gestion de sessions** : Multi-sessions avec stockage DB
- **Déploiement** : Heroku, Koyeb, Render, VPS (Ubuntu)
- **Processus** : PM2 pour la gestion des processus

### Fonctionnalités Principales à Recoder

#### 🎯 Core Features
1. **Système de Messages**
   - Message handlers (text, image, video, audio, document, sticker)
   - Reply message handling
   - Quoted message support
   - Message reactions
   - Message editing & deletion
   - Anti-delete functionality

2. **Système de Commandes**
   - Préfixes configurables (`.`, `!`, `^`, etc.)
   - Pattern matching avec regex
   - Commandes de type "on" (événements)
   - Commandes uniquement pour groupes/privé
   - Système de permissions (sudo, admin)
   - Commandes en arrière-plan

3. **Gestion de Groupes**
   - Greetings (bienvenue/au revoir)
   - Anti-link (suppression auto de liens)
   - Anti-spam & anti-words
   - Anti-bot (kick automatique des bots)
   - Mute (empêcher certains membres de parler)
   - Warn system (3 avertissements = kick)
   - Poll creation
   - Tag all members
   - Group settings modifications

4. **Médias & Conversions**
   - Sticker creator (image → sticker, video → sticker animé)
   - EXIF data customisation pour stickers
   - Image editing (filters, effects)
   - Remove background (rmbg.com API)
   - Text to speech (Google TTS)
   - Audio transcription
   - Video/Audio conversion via FFmpeg
   - Image effects (blur, sharpen, brightness, etc.)

5. **Téléchargements (Downloaders)**
   - Facebook video/photo
   - Instagram posts/reels/stories
   - TikTok videos (sans watermark)
   - Twitter/X media
   - YouTube videos/audio (y2mate, youtubei.js)
   - Pinterest images
   - Reddit posts
   - Mediafire files
   - APKMirror APKs
   - Spotify tracks info

6. **AI & Chat**
   - ChatGPT integration (OpenAI API)
   - Gemini AI (Google)
   - Groq API
   - Bing Chat
   - Lydia chatbot
   - Auto-reply avec IA

7. **Utilitaires**
   - URL shortener
   - QR code generator/reader
   - Fancy text generator
   - Font converter
   - Weather info
   - Movie search (IMDb)
   - News fetcher
   - Truecaller lookup
   - Translate (Google Translate)
   - Wikipedia search
   - Calculator

8. **Système de Sessions**
   - Multi-device support
   - Session backup/restore
   - Auto-reconnect sur déconnexion
   - QR code pour connexion
   - Pairing code support

9. **Base de Données**
   - Users tracking
   - Groups tracking
   - Messages storage (anti-delete)
   - Filters (auto-reply custom)
   - Global filters
   - Budget tracker
   - AFK status
   - Warnings database
   - Votes/polls storage
   - Team management

10. **Administration & Déploiement**
    - Heroku dyno management
    - Koyeb deployment
    - Render deployment
    - PM2 process management
    - Auto-update from GitHub
    - Config vars management
    - Backup & restore
    - Logs viewer

## Architecture Technique à Implémenter

### Structure du Projet

```
whatsapp-bot-baileys/
├── package.json
├── .env.example
├── .env
├── config.js
├── index.js
├── Dockerfile
├── docker-compose.yml
├── ecosystem.config.js (PM2)
├── lib/
│   ├── baileys/
│   │   ├── client.js          # Connexion Baileys
│   │   ├── auth.js            # Gestion auth multi-sessions
│   │   ├── handler.js         # Event handler principal
│   │   └── store.js           # Message store
│   ├── database/
│   │   ├── index.js           # Sequelize setup
│   │   ├── models/
│   │   │   ├── User.js
│   │   │   ├── Group.js
│   │   │   ├── Message.js
│   │   │   ├── Session.js
│   │   │   ├── Filter.js
│   │   │   ├── Warn.js
│   │   │   ├── Greeting.js
│   │   │   ├── AntiLink.js
│   │   │   ├── Mute.js
│   │   │   └── Config.js
│   │   └── seeders/
│   ├── classes/
│   │   ├── Message.js         # Classe Message étendue
│   │   ├── ReplyMessage.js
│   │   ├── Command.js
│   │   └── Base.js
│   ├── utils/
│   │   ├── logger.js          # Pino logger
│   │   ├── ffmpeg.js          # FFmpeg wrapper
│   │   ├── image.js           # Jimp/Sharp utils
│   │   ├── helpers.js
│   │   ├── validators.js
│   │   └── constants.js
│   ├── downloaders/
│   │   ├── facebook.js
│   │   ├── instagram.js
│   │   ├── tiktok.js
│   │   ├── youtube.js
│   │   ├── twitter.js
│   │   └── spotify.js
│   ├── ai/
│   │   ├── chatgpt.js
│   │   ├── gemini.js
│   │   ├── groq.js
│   │   └── bing.js
│   ├── middleware/
│   │   ├── antilink.js
│   │   ├── antibot.js
│   │   ├── antiword.js
│   │   ├── mute.js
│   │   └── permissions.js
│   └── plugins/
│       ├── loader.js          # Plugin loader dynamique
│       └── registry.js        # Registre des commandes
├── plugins/
│   ├── general/
│   │   ├── ping.js
│   │   ├── alive.js
│   │   └── menu.js
│   ├── group/
│   │   ├── tag.js
│   │   ├── kick.js
│   │   ├── add.js
│   │   └── promote.js
│   ├── media/
│   │   ├── sticker.js
│   │   ├── toimg.js
│   │   └── removebg.js
│   ├── download/
│   │   ├── facebook.js
│   │   ├── instagram.js
│   │   ├── tiktok.js
│   │   └── youtube.js
│   ├── ai/
│   │   ├── chatgpt.js
│   │   └── gemini.js
│   ├── tools/
│   │   ├── url.js
│   │   ├── qr.js
│   │   └── translate.js
│   └── admin/
│       ├── backup.js
│       ├── update.js
│       └── eval.js
├── media/
│   ├── temp/
│   ├── stickers/
│   └── downloads/
└── sessions/
    ├── session-1/
    └── session-2/
```

## Stack Technique Complète

### Dépendances Principales

```json
{
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.9",
    "qrcode-terminal": "^0.12.0",
    "qrcode": "^1.5.3",
    "pino": "^9.4.0",
    "sequelize": "^6.37.4",
    "pg": "^8.13.1",
    "pg-hstore": "^2.3.4",
    "sqlite3": "^5.1.7",
    "dotenv": "^16.4.5",
    "axios": "^1.7.9",
    "cheerio": "^1.0.0",
    "fluent-ffmpeg": "^2.1.3",
    "sharp": "^0.33.5",
    "jimp": "^1.6.0",
    "file-type": "^19.7.0",
    "form-data": "^4.0.1",
    "node-fetch": "^3.3.2",
    "moment-timezone": "^0.5.46",
    "cron": "^3.1.7",
    "google-tts-api": "^2.0.2",
    "youtubei.js": "^10.5.0",
    "openai": "^4.77.3",
    "@google/generative-ai": "^0.21.0",
    "node-webpmux": "^3.1.7",
    "qrcode-reader": "^1.0.4",
    "translate-google-api": "^1.0.4",
    "browser-id3-writer": "^4.4.0"
  },
  "devDependencies": {
    "pm2": "^5.4.3",
    "nodemon": "^3.1.9"
  }
}
```

## Implémentation Détaillée

### 1. Configuration de Base (`config.js`)

```javascript
const { Sequelize } = require('sequelize')
const { existsSync } = require('fs')
const path = require('path')
require('dotenv').config()

const toBool = (x) => x?.toLowerCase() === 'true'

// Database Setup
const DATABASE_URL = process.env.DATABASE_URL || path.join(__dirname, 'database.db')
const isPostgres = DATABASE_URL.includes('postgres')

const DATABASE = isPostgres
  ? new Sequelize(DATABASE_URL, {
      dialect: 'postgres',
      ssl: true,
      protocol: 'postgres',
      dialectOptions: {
        native: true,
        ssl: { require: true, rejectUnauthorized: false }
      },
      logging: false
    })
  : new Sequelize({
      dialect: 'sqlite',
      storage: DATABASE_URL,
      logging: false
    })

module.exports = {
  // Version
  VERSION: require('./package.json').version,
  
  // Bot Configuration
  SESSION_ID: process.env.SESSION_ID || '',
  PREFIX: process.env.PREFIX || '.',
  SUDO: process.env.SUDO?.split(',').map(n => n.trim()) || [],
  
  // Bot Behavior
  ALWAYS_ONLINE: toBool(process.env.ALWAYS_ONLINE),
  AUTO_READ: toBool(process.env.AUTO_READ),
  AUTO_STATUS_VIEW: toBool(process.env.AUTO_STATUS_VIEW),
  AUTO_TYPING: toBool(process.env.AUTO_TYPING),
  AUTO_RECORDING: toBool(process.env.AUTO_RECORDING),
  
  // Media
  STICKER_PACKNAME: process.env.STICKER_PACKNAME || 'Made with',
  STICKER_AUTHOR: process.env.STICKER_AUTHOR || 'Bot',
  MAX_UPLOAD_SIZE: parseInt(process.env.MAX_UPLOAD_SIZE || '200'),
  
  // Moderation
  ANTI_LINK: process.env.ANTI_LINK || 'false',
  ANTI_BOT: process.env.ANTI_BOT || 'false',
  ANTI_CALL: toBool(process.env.ANTI_CALL),
  ANTI_DELETE: toBool(process.env.ANTI_DELETE),
  WARN_LIMIT: parseInt(process.env.WARN_LIMIT || '3'),
  
  // AI APIs
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  
  // External Services
  RMBG_KEY: process.env.RMBG_KEY || '',
  TRUECALLER_KEY: process.env.TRUECALLER_KEY || '',
  
  // Language
  LANG: process.env.LANG || 'en',
  TIMEZONE: process.env.TIMEZONE || 'Africa/Lagos',
  
  // Database
  DATABASE,
  
  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
}
```

### 2. Client Baileys (`lib/baileys/client.js`)

```javascript
const { 
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  Browsers
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const path = require('path')
const fs = require('fs')
const EventEmitter = require('events')

class WhatsAppClient extends EventEmitter {
  constructor(sessionId = 'main') {
    super()
    this.sessionId = sessionId
    this.sessionPath = path.join(__dirname, '../../sessions', sessionId)
    this.sock = null
    this.store = null
    this.qr = null
    this.authState = null
  }

  async initialize() {
    // Ensure session directory exists
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true })
    }

    // Setup message store
    this.store = makeInMemoryStore({
      logger: pino().child({ level: 'silent', stream: 'store' })
    })
    this.store.readFromFile(path.join(this.sessionPath, 'store.json'))
    
    // Save store every 10s
    setInterval(() => {
      this.store.writeToFile(path.join(this.sessionPath, 'store.json'))
    }, 10_000)

    // Get latest Baileys version
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Using Baileys v${version.join('.')}, isLatest: ${isLatest}`)

    // Multi-file auth state
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath)
    this.authState = { state, saveCreds }

    return this.connect()
  }

  async connect() {
    const { state, saveCreds } = this.authState

    this.sock = makeWASocket({
      version: (await fetchLatestBaileysVersion()).version,
      logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
      printQRInTerminal: true,
      browser: Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      getMessage: async (key) => {
        if (this.store) {
          const msg = await this.store.loadMessage(key.remoteJid, key.id)
          return msg?.message || undefined
        }
        return { conversation: '' }
      },
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 60000
    })

    // Bind store to socket
    this.store?.bind(this.sock.ev)

    // Connection update handler
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.qr = qr
        this.emit('qr', qr)
        console.log('QR Code:', qr)
      }

      if (connection === 'close') {
        const shouldReconnect = 
          (lastDisconnect?.error instanceof Boom)
            ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
            : true

        console.log('Connection closed. Reconnecting:', shouldReconnect)
        
        if (shouldReconnect) {
          setTimeout(() => this.connect(), 3000)
        } else {
          this.emit('logout')
        }
      } else if (connection === 'open') {
        console.log('✅ Connected to WhatsApp')
        this.emit('ready')
      }
    })

    // Credentials update
    this.sock.ev.on('creds.update', saveCreds)

    // Messages handler
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      this.emit('messages.upsert', { messages, type })
    })

    // Messages update (reactions, edits, deletes)
    this.sock.ev.on('messages.update', async (updates) => {
      this.emit('messages.update', updates)
    })

    // Group participants update
    this.sock.ev.on('group-participants.update', async (update) => {
      this.emit('group-participants.update', update)
    })

    // Group update
    this.sock.ev.on('groups.update', async (updates) => {
      this.emit('groups.update', updates)
    })

    // Call events
    this.sock.ev.on('call', async (calls) => {
      this.emit('call', calls)
    })

    return this.sock
  }

  async sendMessage(jid, content, options = {}) {
    return await this.sock.sendMessage(jid, content, options)
  }

  async downloadMediaMessage(msg) {
    return await downloadMediaMessage(msg, 'buffer', {}, { 
      logger: pino({ level: 'silent' }),
      reuploadRequest: this.sock.updateMediaMessage
    })
  }

  getStore() {
    return this.store
  }

  getSocket() {
    return this.sock
  }
}

module.exports = WhatsAppClient
```

### 3. Message Handler (`lib/baileys/handler.js`)

```javascript
const { getContentType, downloadMediaMessage } = require('@whiskeysockets/baileys')
const { Message } = require('../classes/Message')
const { executeCommand } = require('../plugins/registry')
const config = require('../../config')

class MessageHandler {
  constructor(client) {
    this.client = client
    this.processedMessages = new Set()
  }

  async handle(msg) {
    try {
      const messageType = getContentType(msg.message)
      
      // Ignore if already processed
      if (this.processedMessages.has(msg.key.id)) return
      this.processedMessages.add(msg.key.id)
      
      // Clean old processed messages (keep last 1000)
      if (this.processedMessages.size > 1000) {
        const arr = Array.from(this.processedMessages)
        this.processedMessages = new Set(arr.slice(-1000))
      }

      // Ignore broadcast messages
      if (msg.key.remoteJid === 'status@broadcast') {
        if (config.AUTO_STATUS_VIEW) {
          await this.client.readMessages([msg.key])
        }
        return
      }

      // Create Message instance
      const message = new Message(this.client, msg)
      await message.loadData()

      // Auto-read
      if (config.AUTO_READ) {
        await this.client.sock.readMessages([msg.key])
      }

      // Check if message is from bot itself
      if (message.fromMe) return

      // Anti-delete
      if (config.ANTI_DELETE) {
        await this.saveMessageForAntiDelete(message)
      }

      // Execute middleware
      await this.executeMiddleware(message)

      // Process command
      if (message.body?.startsWith(config.PREFIX)) {
        await executeCommand(message)
      }

      // Auto-reply filters
      await this.checkFilters(message)

    } catch (error) {
      console.error('Error handling message:', error)
    }
  }

  async executeMiddleware(message) {
    // Anti-link
    if (message.isGroup) {
      const { checkAntiLink } = require('../middleware/antilink')
      await checkAntiLink(message)
      
      const { checkMute } = require('../middleware/mute')
      await checkMute(message)
      
      const { checkAntiBot } = require('../middleware/antibot')
      await checkAntiBot(message)
    }
  }

  async checkFilters(message) {
    const { Filter } = require('../database/models/Filter')
    
    const filters = await Filter.findAll({
      where: {
        groupJid: message.isGroup ? message.jid : 'global'
      }
    })

    for (const filter of filters) {
      const regex = new RegExp(filter.pattern, 'i')
      if (regex.test(message.body)) {
        await message.reply(filter.response)
      }
    }
  }

  async saveMessageForAntiDelete(message) {
    const { Message: MessageModel } = require('../database/models/Message')
    
    await MessageModel.create({
      id: message.id,
      jid: message.jid,
      sender: message.sender,
      message: JSON.stringify(message.data),
      timestamp: Date.now()
    })
  }
}

module.exports = MessageHandler
```

### 4. Message Class (`lib/classes/Message.js`)

```javascript
const { 
  downloadMediaMessage, 
  getContentType,
  jidNormalizedUser,
  proto
} = require('@whiskeysockets/baileys')
const fs = require('fs').promises
const path = require('path')
const config = require('../../config')

class Message {
  constructor(client, data) {
    this.client = client
    this.data = data
    this.key = data.key
    this.id = data.key.id
    this.jid = data.key.remoteJid
    this.fromMe = data.key.fromMe
    this.message = data.message
    this.type = getContentType(data.message)
    this.timestamp = data.messageTimestamp
    
    // Extract actual message content
    const msg = this.message[this.type]
    this.body = msg?.text || msg?.caption || msg?.conversation || msg?.selectedButtonId || msg?.singleSelectReply?.selectedRowId || ''
    
    // Sender info
    this.sender = jidNormalizedUser(
      data.key.fromMe 
        ? this.client.sock.user.id 
        : data.participant || data.key.participant || data.key.remoteJid
    )
    
    // Group info
    this.isGroup = this.jid.endsWith('@g.us')
    this.groupMetadata = null
    
    // Quoted message
    this.quoted = msg?.contextInfo?.quotedMessage ? {
      id: msg.contextInfo.stanzaId,
      sender: msg.contextInfo.participant,
      message: msg.contextInfo.quotedMessage,
      type: getContentType(msg.contextInfo.quotedMessage)
    } : null
    
    // Media info
    this.hasMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(this.type)
  }

  async loadData() {
    if (this.isGroup) {
      this.groupMetadata = await this.client.sock.groupMetadata(this.jid)
      this.groupName = this.groupMetadata.subject
      this.groupAdmins = this.groupMetadata.participants
        .filter(p => p.admin)
        .map(p => p.id)
      this.isBotAdmin = this.groupAdmins.includes(this.client.sock.user.id)
      this.isAdmin = this.groupAdmins.includes(this.sender)
    }
    
    // Get sender name
    const contact = await this.client.sock.onWhatsApp(this.sender)
    this.senderName = contact[0]?.notify || this.sender.split('@')[0]
  }

  async reply(text, options = {}) {
    return await this.client.sock.sendMessage(
      this.jid,
      { text, ...options },
      { quoted: this.data }
    )
  }

  async send(content, options = {}) {
    return await this.client.sock.sendMessage(this.jid, content, options)
  }

  async sendImage(buffer, caption = '', options = {}) {
    return await this.send({
      image: buffer,
      caption,
      ...options
    })
  }

  async sendVideo(buffer, caption = '', options = {}) {
    return await this.send({
      video: buffer,
      caption,
      ...options
    })
  }

  async sendAudio(buffer, options = {}) {
    return await this.send({
      audio: buffer,
      mimetype: 'audio/mpeg',
      ...options
    })
  }

  async sendSticker(buffer, options = {}) {
    return await this.send({
      sticker: buffer,
      ...options
    })
  }

  async sendDocument(buffer, filename, mimetype, caption = '') {
    return await this.send({
      document: buffer,
      fileName: filename,
      mimetype,
      caption
    })
  }

  async react(emoji) {
    return await this.client.sock.sendMessage(this.jid, {
      react: {
        text: emoji,
        key: this.key
      }
    })
  }

  async delete() {
    return await this.client.sock.sendMessage(this.jid, {
      delete: this.key
    })
  }

  async downloadMedia() {
    if (!this.hasMedia) return null
    
    try {
      const buffer = await downloadMediaMessage(
        this.data,
        'buffer',
        {},
        {
          logger: { info() {}, error() {}, warn() {} },
          reuploadRequest: this.client.sock.updateMediaMessage
        }
      )
      return buffer
    } catch (error) {
      console.error('Error downloading media:', error)
      return null
    }
  }

  async saveMedia(directory = './media/temp') {
    const buffer = await this.downloadMedia()
    if (!buffer) return null
    
    const fileType = await import('file-type')
    const type = await fileType.fromBuffer(buffer)
    const filename = `${Date.now()}.${type?.ext || 'bin'}`
    const filepath = path.join(directory, filename)
    
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(filepath, buffer)
    
    return filepath
  }

  isSudo() {
    const sudoList = config.SUDO
    return sudoList.includes(this.sender.split('@')[0])
  }

  async kick(participants) {
    if (!this.isGroup || !this.isBotAdmin) return false
    
    const jids = Array.isArray(participants) ? participants : [participants]
    return await this.client.sock.groupParticipantsUpdate(
      this.jid,
      jids,
      'remove'
    )
  }

  async add(participants) {
    if (!this.isGroup || !this.isBotAdmin) return false
    
    const jids = Array.isArray(participants) ? participants : [participants]
    return await this.client.sock.groupParticipantsUpdate(
      this.jid,
      jids,
      'add'
    )
  }

  async promote(participants) {
    if (!this.isGroup || !this.isBotAdmin) return false
    
    const jids = Array.isArray(participants) ? participants : [participants]
    return await this.client.sock.groupParticipantsUpdate(
      this.jid,
      jids,
      'promote'
    )
  }

  async demote(participants) {
    if (!this.isGroup || !this.isBotAdmin) return false
    
    const jids = Array.isArray(participants) ? participants : [participants]
    return await this.client.sock.groupParticipantsUpdate(
      this.jid,
      jids,
      'demote'
    )
  }
}

module.exports = { Message }
```

### 5. Plugin System (`lib/plugins/loader.js`)

```javascript
const fs = require('fs').promises
const path = require('path')
const { registerCommand } = require('./registry')

class PluginLoader {
  constructor() {
    this.plugins = new Map()
    this.pluginsDir = path.join(__dirname, '../../plugins')
  }

  async loadAll() {
    console.log('📦 Loading plugins...')
    
    const categories = await fs.readdir(this.pluginsDir)
    
    for (const category of categories) {
      const categoryPath = path.join(this.pluginsDir, category)
      const stat = await fs.stat(categoryPath)
      
      if (!stat.isDirectory()) continue
      
      const files = await fs.readdir(categoryPath)
      
      for (const file of files) {
        if (!file.endsWith('.js')) continue
        
        try {
          const pluginPath = path.join(categoryPath, file)
          delete require.cache[require.resolve(pluginPath)]
          
          const plugin = require(pluginPath)
          
          if (plugin.command) {
            registerCommand(plugin)
            this.plugins.set(plugin.command.pattern, plugin)
            console.log(`✅ Loaded: ${category}/${file}`)
          }
        } catch (error) {
          console.error(`❌ Error loading ${category}/${file}:`, error.message)
        }
      }
    }
    
    console.log(`✅ Loaded ${this.plugins.size} plugins`)
  }

  async reload() {
    this.plugins.clear()
    await this.loadAll()
  }
}

module.exports = new PluginLoader()
```

### 6. Command Registry (`lib/plugins/registry.js`)

```javascript
const commands = new Map()

function registerCommand(plugin) {
  const { pattern, desc, type, fromMe, onlyGroup, onlyPm } = plugin.command
  
  commands.set(pattern, {
    execute: plugin.execute,
    pattern,
    desc: desc || '',
    type: type || 'misc',
    fromMe: fromMe || false,
    onlyGroup: onlyGroup || false,
    onlyPm: onlyPm || false
  })
}

async function executeCommand(message) {
  const config = require('../../config')
  const prefix = config.PREFIX
  
  if (!message.body.startsWith(prefix)) return
  
  const [cmd, ...args] = message.body.slice(prefix.length).trim().split(/\s+/)
  const commandName = cmd.toLowerCase()
  
  for (const [pattern, command] of commands) {
    const regex = new RegExp(`^${pattern}$`, 'i')
    
    if (regex.test(commandName)) {
      // Check permissions
      if (command.fromMe && !message.isSudo()) {
        return await message.reply('⚠️ This command is only for sudo users!')
      }
      
      if (command.onlyGroup && !message.isGroup) {
        return await message.reply('⚠️ This command can only be used in groups!')
      }
      
      if (command.onlyPm && message.isGroup) {
        return await message.reply('⚠️ This command can only be used in private chat!')
      }
      
      // Execute command
      try {
        await command.execute(message, args.join(' '))
      } catch (error) {
        console.error(`Error executing ${commandName}:`, error)
        await message.reply(`❌ Error: ${error.message}`)
      }
      
      break
    }
  }
}

function getCommands() {
  return Array.from(commands.values())
}

module.exports = {
  registerCommand,
  executeCommand,
  getCommands
}
```

### 7. Database Models

#### User Model (`lib/database/models/User.js`)

```javascript
const { DataTypes } = require('sequelize')

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    jid: {
      type: DataTypes.STRING,
      primaryKey: true,
      unique: true
    },
    name: DataTypes.STRING,
    isBlocked: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    lastSeen: DataTypes.DATE
  })
  
  return User
}
```

#### Group Model

```javascript
const { DataTypes } = require('sequelize')

module.exports = (sequelize) => {
  const Group = sequelize.define('Group', {
    jid: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    name: DataTypes.STRING,
    desc: DataTypes.TEXT,
    antilink: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    antibot: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    welcome: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    welcomeMessage: DataTypes.TEXT,
    goodbyeMessage: DataTypes.TEXT
  })
  
  return Group
}
```

### 8. Exemple de Plugin (`plugins/general/ping.js`)

```javascript
module.exports = {
  command: {
    pattern: 'ping',
    desc: 'Check bot response time',
    type: 'general',
    fromMe: false,
    onlyGroup: false
  },
  
  async execute(message) {
    const start = Date.now()
    const sent = await message.reply('Pinging...')
    const end = Date.now()
    
    const latency = end - start
    await message.client.sock.sendMessage(
      message.jid,
      {
        text: `🏓 Pong!\n⏱️ Latency: ${latency}ms`,
        edit: sent.key
      }
    )
  }
}
```

### 9. Sticker Plugin Complet (`plugins/media/sticker.js`)

```javascript
const { writeFile, unlink } = require('fs/promises')
const { Sticker, createSticker } = require('wa-sticker-formatter')
const sharp = require('sharp')
const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const config = require('../../config')

module.exports = {
  command: {
    pattern: 'sticker|s',
    desc: 'Convert image/video to sticker',
    type: 'media',
    fromMe: false
  },
  
  async execute(message) {
    try {
      // Check if message has media or quoted media
      const mediaMsg = message.quoted?.hasMedia ? message.quoted : message.hasMedia ? message : null
      
      if (!mediaMsg) {
        return await message.reply('Reply to an image/video/gif!')
      }
      
      await message.react('⏳')
      
      const buffer = await mediaMsg.downloadMedia()
      
      if (!buffer) {
        await message.react('❌')
        return await message.reply('Failed to download media!')
      }
      
      let stickerBuffer
      
      if (mediaMsg.type === 'videoMessage') {
        // Convert video to webp animated sticker
        stickerBuffer = await videoToSticker(buffer)
      } else {
        // Convert image to webp sticker
        stickerBuffer = await imageToSticker(buffer)
      }
      
      await message.sendSticker(stickerBuffer, {
        packname: config.STICKER_PACKNAME,
        author: config.STICKER_AUTHOR
      })
      
      await message.react('✅')
      
    } catch (error) {
      console.error('Sticker error:', error)
      await message.react('❌')
      await message.reply('Error creating sticker!')
    }
  }
}

async function imageToSticker(buffer) {
  return await sharp(buffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 100 })
    .toBuffer()
}

async function videoToSticker(buffer) {
  const tempInput = path.join(__dirname, `../../media/temp/vid_${Date.now()}.mp4`)
  const tempOutput = path.join(__dirname, `../../media/temp/sticker_${Date.now()}.webp`)
  
  await writeFile(tempInput, buffer)
  
  return new Promise((resolve, reject) => {
    ffmpeg(tempInput)
      .outputOptions([
        '-vcodec', 'libwebp',
        '-vf', "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15,pad=320:320:-1:-1:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse",
        '-loop', '0',
        '-ss', '00:00:00',
        '-t', '00:00:05',
        '-preset', 'default',
        '-an',
        '-vsync', '0'
      ])
      .toFormat('webp')
      .save(tempOutput)
      .on('end', async () => {
        const sticker = await require('fs/promises').readFile(tempOutput)
        await unlink(tempInput)
        await unlink(tempOutput)
        resolve(sticker)
      })
      .on('error', reject)
  })
}
```

### 10. Download Plugin - Instagram (`plugins/download/instagram.js`)

```javascript
const axios = require('axios')
const cheerio = require('cheerio')

module.exports = {
  command: {
    pattern: 'insta|ig',
    desc: 'Download Instagram photos/videos/reels',
    type: 'download'
  },
  
  async execute(message, match) {
    try {
      const url = match || message.quoted?.body
      
      if (!url || !url.includes('instagram.com')) {
        return await message.reply('Please provide Instagram URL!')
      }
      
      await message.react('⏳')
      await message.reply('Downloading from Instagram...')
      
      const result = await downloadInstagram(url)
      
      if (result.type === 'image') {
        for (const img of result.url) {
          await message.sendImage(
            { url: img },
            result.caption || ''
          )
        }
      } else if (result.type === 'video') {
        await message.sendVideo(
          { url: result.url },
          result.caption || ''
        )
      }
      
      await message.react('✅')
      
    } catch (error) {
      console.error(error)
      await message.react('❌')
      await message.reply('Failed to download!')
    }
  }
}

async function downloadInstagram(url) {
  // Use API or scraping method
  // Example with rapidapi.com/instagram-scraper
  const response = await axios.get(`https://instagram-scraper-api.p.rapidapi.com/`, {
    params: { url },
    headers: {
      'X-RapidAPI-Key': process.env.RAPID_API_KEY,
      'X-RapidAPI-Host': 'instagram-scraper-api.p.rapidapi.com'
    }
  })
  
  return response.data
}
```

### 11. AI Plugin - ChatGPT (`plugins/ai/chatgpt.js`)

```javascript
const OpenAI = require('openai')
const config = require('../../config')

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY
})

module.exports = {
  command: {
    pattern: 'gpt|chatgpt|ai',
    desc: 'Chat with ChatGPT',
    type: 'ai'
  },
  
  async execute(message, match) {
    try {
      const query = match || message.quoted?.body
      
      if (!query) {
        return await message.reply('Please provide a question!\n\nExample: .gpt What is AI?')
      }
      
      await message.react('🤖')
      
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant on WhatsApp.' },
          { role: 'user', content: query }
        ],
        max_tokens: 1000
      })
      
      const response = completion.choices[0].message.content
      
      await message.reply(response)
      await message.react('✅')
      
    } catch (error) {
      console.error(error)
      await message.react('❌')
      await message.reply('Error: ' + error.message)
    }
  }
}
```

### 12. Group Management (`plugins/group/tag.js`)

```javascript
module.exports = {
  command: {
    pattern: 'tag|tagall|mention',
    desc: 'Tag all group members',
    type: 'group',
    onlyGroup: true
  },
  
  async execute(message, match) {
    if (!message.isAdmin && !message.isSudo()) {
      return await message.reply('⚠️ Only admins can use this!')
    }
    
    const text = match || 'Hello everyone!'
    const mentions = message.groupMetadata.participants.map(p => p.id)
    
    await message.send({
      text: text + '\n\n' + mentions.map((jid, i) => `${i + 1}. @${jid.split('@')[0]}`).join('\n'),
      mentions
    })
  }
}
```

### 13. Middleware - Anti-Link (`lib/middleware/antilink.js`)

```javascript
const { Group } = require('../database/models/Group')

async function checkAntiLink(message) {
  if (!message.isGroup) return
  
  const group = await Group.findOne({ where: { jid: message.jid } })
  
  if (!group?.antilink) return
  if (message.isAdmin || message.isSudo()) return
  
  const linkRegex = /(https?:\/\/|www\.)[^\s]+/gi
  const whatsappLinkRegex = /(chat\.whatsapp\.com|wa\.me)/gi
  
  if (whatsappLinkRegex.test(message.body) || linkRegex.test(message.body)) {
    await message.delete()
    
    if (message.isBotAdmin) {
      await message.kick(message.sender)
      await message.send({
        text: `@${message.sender.split('@')[0]} was removed for sending links!`,
        mentions: [message.sender]
      })
    } else {
      await message.reply('⚠️ Link detected! (Bot needs admin rights to kick)')
    }
  }
}

module.exports = { checkAntiLink }
```

### 14. Entry Point (`index.js`)

```javascript
const WhatsAppClient = require('./lib/baileys/client')
const MessageHandler = require('./lib/baileys/handler')
const PluginLoader = require('./lib/plugins/loader')
const { DATABASE } = require('./config')
const pino = require('pino')

const logger = pino({ level: 'info' })

async function start() {
  try {
    logger.info('🚀 Starting WhatsApp Bot...')
    
    // Test database connection
    await DATABASE.authenticate()
    logger.info('✅ Database connected')
    
    // Sync models
    await DATABASE.sync()
    logger.info('✅ Database synced')
    
    // Load plugins
    await PluginLoader.loadAll()
    
    // Initialize client
    const client = new WhatsAppClient()
    await client.initialize()
    
    // Setup message handler
    const handler = new MessageHandler(client)
    
    client.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      
      for (const msg of messages) {
        await handler.handle(msg)
      }
    })
    
    client.on('ready', () => {
      logger.info('✅ Bot is ready!')
    })
    
    client.on('qr', (qr) => {
      logger.info('📱 Scan QR code to login')
    })
    
  } catch (error) {
    logger.error('Error:', error)
    process.exit(1)
  }
}

start()

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...')
  await DATABASE.close()
  process.exit(0)
})
```

### 15. Package.json Complet

```json
{
  "name": "whatsapp-bot-baileys",
  "version": "1.0.0",
  "description": "Full-featured WhatsApp bot with Baileys",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js",
    "pm2": "pm2 start ecosystem.config.js",
    "pm2:stop": "pm2 stop whatsapp-bot",
    "pm2:restart": "pm2 restart whatsapp-bot",
    "pm2:delete": "pm2 delete whatsapp-bot"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.9",
    "@hapi/boom": "^10.0.1",
    "axios": "^1.7.9",
    "cheerio": "^1.0.0",
    "dotenv": "^16.4.5",
    "sequelize": "^6.37.4",
    "pg": "^8.13.1",
    "pg-hstore": "^2.3.4",
    "sqlite3": "^5.1.7",
    "pino": "^9.4.0",
    "qrcode-terminal": "^0.12.0",
    "qrcode": "^1.5.3",
    "sharp": "^0.33.5",
    "jimp": "^1.6.0",
    "fluent-ffmpeg": "^2.1.3",
    "file-type": "^19.7.0",
    "form-data": "^4.0.1",
    "node-fetch": "^3.3.2",
    "moment-timezone": "^0.5.46",
    "cron": "^3.1.7",
    "google-tts-api": "^2.0.2",
    "youtubei.js": "^10.5.0",
    "openai": "^4.77.3",
    "@google/generative-ai": "^0.21.0",
    "node-webpmux": "^3.1.7",
    "wa-sticker-formatter": "^4.4.4",
    "translate-google-api": "^1.0.4"
  },
  "devDependencies": {
    "nodemon": "^3.1.9"
  }
}
```

### 16. PM2 Ecosystem (`ecosystem.config.js`)

```javascript
module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
}
```

### 17. Dockerfile

```dockerfile
FROM node:20-alpine

# Install FFmpeg and dependencies
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Create necessary directories
RUN mkdir -p sessions media/temp logs

CMD ["node", "index.js"]
```

### 18. Docker Compose

```yaml
version: '3.8'

services:
  bot:
    build: .
    container_name: whatsapp-bot
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./sessions:/app/sessions
      - ./media:/app/media
      - ./logs:/app/logs
    depends_on:
      - postgres

  postgres:
    image: postgres:15-alpine
    container_name: whatsapp-bot-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: botuser
      POSTGRES_PASSWORD: botpass
      POSTGRES_DB: whatsappbot
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  postgres_data:
```

### 19. .env.example

```env
# Bot Configuration
SESSION_ID=
PREFIX=.
SUDO=

# Bot Behavior
ALWAYS_ONLINE=false
AUTO_READ=true
AUTO_STATUS_VIEW=true
AUTO_TYPING=false

# Media
STICKER_PACKNAME=Made with
STICKER_AUTHOR=WhatsApp Bot
MAX_UPLOAD_SIZE=200

# Moderation
ANTI_LINK=false
ANTI_BOT=false
ANTI_CALL=false
ANTI_DELETE=false
WARN_LIMIT=3

# AI APIs
OPENAI_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=

# External Services
RMBG_KEY=
TRUECALLER_KEY=
RAPID_API_KEY=

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname

# Logging
LOG_LEVEL=info

# Timezone
TIMEZONE=Africa/Lagos
LANG=en
```

## Instructions de Déploiement

### 1. Installation Locale

```bash
# Clone le projet
git clone https://github.com/username/whatsapp-bot-baileys.git
cd whatsapp-bot-baileys

# Installer les dépendances
npm install

# Configurer l'environnement
cp .env.example .env
nano .env

# Démarrer le bot
npm start

# Ou avec PM2
npm run pm2
```

### 2. Déploiement Docker

```bash
# Build et run
docker-compose up -d

# Voir les logs
docker-compose logs -f bot

# Arrêter
docker-compose down
```

### 3. Déploiement Heroku

```bash
# Login Heroku
heroku login

# Créer app
heroku create mon-whatsapp-bot

# Add PostgreSQL
heroku addons:create heroku-postgresql:mini

# Set buildpack
heroku buildpacks:set heroku/nodejs
heroku buildpacks:add https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest.git

# Deploy
git push heroku main

# Set env vars
heroku config:set SESSION_ID=xxx
heroku config:set PREFIX=.
```

## Fonctionnalités Avancées à Ajouter

### Multi-Session Support

```javascript
// lib/multi-session.js
class SessionManager {
  constructor() {
    this.sessions = new Map()
  }

  async createSession(id) {
    const client = new WhatsAppClient(id)
    await client.initialize()
    this.sessions.set(id, client)
    return client
  }

  getSession(id) {
    return this.sessions.get(id)
  }

  async removeSession(id) {
    const session = this.sessions.get(id)
    if (session) {
      await session.sock.logout()
      this.sessions.delete(id)
    }
  }
}

module.exports = new SessionManager()
```

### Scheduled Messages (Cron Jobs)

```javascript
const cron = require('cron')

// Schedule message
function scheduleMessage(jid, message, cronTime) {
  const job = new cron.CronJob(cronTime, async () => {
    await client.sendMessage(jid, { text: message })
  })
  
  job.start()
  return job
}

// Example: Send every day at 9 AM
scheduleMessage('123456789@s.whatsapp.net', 'Good morning!', '0 9 * * *')
```

### Auto-Reply with Filters

```javascript
// Database model for filters
const Filter = sequelize.define('Filter', {
  pattern: DataTypes.STRING,
  response: DataTypes.TEXT,
  groupJid: DataTypes.STRING,
  isGlobal: DataTypes.BOOLEAN
})

// Check filters in handler
async function checkFilters(message) {
  const filters = await Filter.findAll({
    where: {
      [Op.or]: [
        { groupJid: message.jid },
        { isGlobal: true }
      ]
    }
  })

  for (const filter of filters) {
    if (new RegExp(filter.pattern, 'i').test(message.body)) {
      await message.reply(filter.response)
    }
  }
}
```

## Testing & Maintenance

### Unit Tests (avec Jest)

```javascript
// tests/message.test.js
const { Message } = require('../lib/classes/Message')

describe('Message Class', () => {
  test('should extract text from message', () => {
    const mockData = {
      key: { id: '123', remoteJid: '123@s.whatsapp.net' },
      message: { conversation: 'Hello' }
    }
    
    const msg = new Message(mockClient, mockData)
    expect(msg.body).toBe('Hello')
  })
})
```

### Logging & Monitoring

```javascript
const pino = require('pino')
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  }
})

// Use throughout app
logger.info('Bot started')
logger.error({ err }, 'Error occurred')
```

## Meilleures Pratiques

1. **Error Handling** : Toujours utiliser try-catch
2. **Rate Limiting** : Limiter les requêtes API
3. **Memory Management** : Nettoyer les buffers après usage
4. **Security** : Valider toutes les entrées utilisateur
5. **Performance** : Utiliser async/await correctement
6. **Database** : Indexer les colonnes fréquemment recherchées
7. **Logs** : Logger toutes les erreurs importantes
8. **Updates** : Garder Baileys à jour

## Résolution de Problèmes

### QR Code ne s'affiche pas
```bash
npm install qrcode-terminal
```

### Erreur de connexion
- Vérifier la connexion internet
- Supprimer le dossier sessions et reconnecter
- Vérifier que WhatsApp n'est pas ouvert ailleurs

### Bot ne répond pas
- Vérifier les logs
- Vérifier que le préfixe est correct
- Vérifier les permissions

## Conclusion

Ce guide complet vous permet de recoder entièrement un bot WhatsApp professionnel avec Baileys, incluant :

✅ Architecture modulaire et scalable  
✅ Système de plugins dynamique  
✅ Base de données PostgreSQL/SQLite  
✅ Multi-sessions support  
✅ Toutes les fonctionnalités modernes  
✅ Déploiement cloud-ready  
✅ Tests et monitoring  
✅ Documentation complète  

Le code fourni est production-ready et peut être étendu selon vos besoins spécifiques.
