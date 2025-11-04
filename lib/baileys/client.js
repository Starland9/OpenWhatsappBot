const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  delay
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const EventEmitter = require('events')
const path = require('path')
const { getLang } = require('../utils/language')

/**
 * WhatsApp Client with auto-reconnection
 */
class WhatsAppClient extends EventEmitter {
  constructor(sessionId = 'main') {
    super()
    this.sessionPath = path.join(__dirname, '../../sessions', sessionId)
    this.sock = null
    this.store = null
    this.isReady = false
    // Track reacted status messages to prevent duplicate reactions
    this.reactedStatuses = new Set()
  }

  /**
   * Initialize the WhatsApp connection
   */
  async initialize() {
    try {
      // Setup auth state
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath)
      
      // Get latest Baileys version
      const { version } = await fetchLatestBaileysVersion()
      
      // Create in-memory store for chats/contacts
      this.store = makeInMemoryStore({
        logger: pino({ level: 'silent' })
      })
      
      // Create socket connection
      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: process.env.BAILEYS_LOG_LVL || 'silent' }),
        printQRInTerminal: true,
        browser: ['Open Whatsapp Bot', 'Chrome', '5.0.0'],
        markOnlineOnConnect: process.env.ALWAYS_ONLINE === 'true',
        getMessage: async (key) => {
          if (this.store) {
            const msg = await this.store.loadMessage(key.remoteJid, key.id)
            return msg?.message || undefined
          }
          return undefined
        }
      })

      // Bind store to socket
      this.store?.bind(this.sock.ev)

      // Handle connection updates
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          console.log('📱 QR Code generated, scan to connect')
        }

        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
            : true

          console.log(getLang('extra.instance_close', 'main'))

          if (shouldReconnect) {
            console.log(getLang('extra.reconnect', 'main', 3))
            await delay(3000)
            await this.initialize()
          } else {
            console.log('Logged out, please scan QR again')
          }
        } else if (connection === 'open') {
          this.isReady = true
          console.log(getLang('extra.connected', 'main', version))
          this.emit('ready')
        }
      })

      // Save credentials on update
      this.sock.ev.on('creds.update', saveCreds)

      // Handle messages (consolidated to avoid duplicate listeners)
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Emit for main message handler
        this.emit('messages', messages, type)
        
        // Handle status updates inline (auto view/react)
        const config = require('../../config')
        
        for (const msg of messages) {
          // Check if it's a status update
          if (msg.key.remoteJid === 'status@broadcast') {
            try {
              // Auto view status (if enabled)
              if (config.AUTO_STATUS_VIEW) {
                await this.sock.readMessages([msg.key])
                console.log('✅ Auto-viewed status')
              }
              
              // Auto react to status (if enabled and not already reacted)
              if (config.AUTO_STATUS_REACT) {
                // Validate STATUS_EMOJIS configuration
                if (!config.STATUS_EMOJIS || typeof config.STATUS_EMOJIS !== 'string') {
                  console.error('❌ STATUS_EMOJIS not configured properly')
                  continue
                }
                
                // Create unique ID for this status message
                // Use JSON to avoid ID collisions from underscores in participant/jid
                const statusId = JSON.stringify({
                  participant: msg.key.participant || msg.key.remoteJid,
                  id: msg.key.id
                })
                
                // Check if we've already reacted to this status
                if (!this.reactedStatuses.has(statusId)) {
                  // Get emoji list and validate
                  const emojis = config.STATUS_EMOJIS.split(',')
                    .map(e => e.trim())
                    .filter(e => e.length > 0)
                  
                  if (emojis.length === 0) {
                    console.error('❌ No valid emojis in STATUS_EMOJIS')
                    continue
                  }
                  
                  // Pick random emoji
                  const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)]
                  
                  // React to status
                  await this.sock.sendMessage(msg.key.remoteJid, {
                    react: { text: randomEmoji, key: msg.key }
                  })
                  
                  // Mark as reacted
                  this.reactedStatuses.add(statusId)
                  
                  console.log(`✅ Auto-reacted to status with ${randomEmoji}`)
                  
                  // Clean up old entries (keep only last 1000 to prevent memory leaks)
                  if (this.reactedStatuses.size > 1000) {
                    // Convert to array to ensure FIFO behavior
                    const statusArray = Array.from(this.reactedStatuses)
                    // Keep the most recent 800 entries (remove oldest 200+)
                    this.reactedStatuses = new Set(statusArray.slice(-800))
                  }
                }
              }
            } catch (error) {
              console.error('Error handling status:', error)
            }
          }
        }
      })

      // Handle group updates
      this.sock.ev.on('groups.update', (updates) => {
        this.emit('groups.update', updates)
      })

      // Handle participant updates
      this.sock.ev.on('group-participants.update', (update) => {
        this.emit('group-participants.update', update)
      })

      // Handle message updates (for anti-delete)
      this.sock.ev.on('messages.update', (updates) => {
        this.emit('messages.update', updates)
      })

      return this.sock
    } catch (error) {
      console.error('Failed to initialize WhatsApp client:', error)
      throw error
    }
  }

  /**
   * Get the socket instance
   */
  getSocket() {
    return this.sock
  }

  /**
   * Check if client is ready
   */
  ready() {
    return this.isReady
  }

  /**
   * Stop the client
   */
  async stop() {
    if (this.sock) {
      await this.sock.logout()
      this.sock = null
      this.isReady = false
      // Clear reacted statuses to prevent memory leaks
      this.reactedStatuses.clear()
    }
  }
}

module.exports = { WhatsAppClient, DisconnectReason }
