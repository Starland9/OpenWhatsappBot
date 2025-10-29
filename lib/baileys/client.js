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

          console.log('Connection closed. Reconnecting:', shouldReconnect)

          if (shouldReconnect) {
            await delay(3000)
            await this.initialize()
          } else {
            console.log('Logged out, please scan QR again')
          }
        } else if (connection === 'open') {
          this.isReady = true
          console.log('✅ Connected to WhatsApp')
          this.emit('ready')
        }
      })

      // Save credentials on update
      this.sock.ev.on('creds.update', saveCreds)

      // Handle messages
      this.sock.ev.on('messages.upsert', ({ messages, type }) => {
        this.emit('messages', messages, type)
      })

      // Handle group updates
      this.sock.ev.on('groups.update', (updates) => {
        this.emit('groups.update', updates)
      })

      // Handle participant updates
      this.sock.ev.on('group-participants.update', (update) => {
        this.emit('group-participants.update', update)
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
    }
  }
}

module.exports = { WhatsAppClient, DisconnectReason }
