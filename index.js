const { WhatsAppClient } = require('./lib/baileys/client')
const { Message } = require('./lib/classes/Message')
const PluginLoader = require('./lib/plugins/loader')
const { executeCommand } = require('./lib/plugins/registry')
const { DATABASE, VERSION } = require('./config')
const pino = require('pino')

const logger = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
})

/**
 * Start the WhatsApp bot
 */
async function start() {
  logger.info(`🤖 Levanter v${VERSION}`)
  
  try {
    // Test database connection
    await DATABASE.authenticate({ retry: { max: 3 } })
    logger.info('✅ Database connected')
    
    // Sync database models
    await DATABASE.sync()
    logger.info('✅ Database synced')
    
    // Load all plugins
    await PluginLoader.loadAll()
    logger.info('✅ Plugins loaded')
    
    // Initialize WhatsApp client
    const client = new WhatsAppClient()
    await client.initialize()
    
    // Handle incoming messages
    client.on('messages', async (messages) => {
      for (const msg of messages) {
        // Skip broadcast messages
        if (msg.key.remoteJid === 'status@broadcast') continue
        
        // Create Message instance
        const message = new Message(client, msg)
        
        // Skip messages from self (unless sudo)
        if (message.fromMe && !message.isSudo()) continue
        
        // Execute commands
        await executeCommand(message)
      }
    })
    
    // Ready event
    client.on('ready', () => {
      logger.info('✅ Bot is ready and listening for messages')
    })
    
  } catch (error) {
    logger.error('Failed to start bot:', error)
    process.exit(1)
  }
}

// Start the bot
start()

