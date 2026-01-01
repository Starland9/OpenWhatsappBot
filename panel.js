/**
 * Panel.js - HTTP Server for Bot-Hosting.net and similar platforms
 * 
 * This file provides a lightweight HTTP server that enables the WhatsApp bot
 * to work on bot-hosting.net and similar panel-based hosting platforms.
 * 
 * Features:
 * - Health check endpoint for uptime monitoring
 * - Keep-alive ping mechanism
 * - Panel status API endpoints
 * - Graceful shutdown handling
 * - Configurable port via environment variables
 */

const http = require('http');
const { WhatsAppClient } = require('./lib/baileys/client');
const { Message } = require('./lib/classes/Message');
const PluginLoader = require('./lib/plugins/loader');
const { executeCommand, getPlugin } = require('./lib/plugins/registry');
const { DATABASE, sync, StickerCommand } = require('./lib/database');
const { VERSION, PREFIX } = require('./config');
const autoResponderHandler = require('./lib/utils/autoResponderHandler');
const viewOnceHandler = require('./lib/utils/viewOnceHandler');
const antiDeleteHandler = require('./lib/utils/antiDeleteHandler');
const memoryManager = require('./lib/utils/memoryManager');
const pino = require('pino');

// Initialize logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

// Configuration
const PORT = parseInt(process.env.PORT) || parseInt(process.env.PANEL_PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL) || 60000; // 60 seconds

// Bot state tracking
let botState = {
  status: 'starting',
  startTime: null,
  isConnected: false,
  messagesProcessed: 0,
  lastActivity: null,
  version: VERSION,
  uptime: 0,
  errors: [],
  client: null,
};

/**
 * Create HTTP server for panel compatibility
 */
function createServer() {
  const server = http.createServer((req, res) => {
    const url = req.url;
    const method = req.method;

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    // Handle OPTIONS preflight
    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Route handling
    switch (url) {
      case '/':
      case '/health':
      case '/healthz':
        handleHealthCheck(res);
        break;

      case '/status':
        handleStatus(res);
        break;

      case '/ping':
        handlePing(res);
        break;

      case '/metrics':
        handleMetrics(res);
        break;

      case '/api/info':
        handleBotInfo(res);
        break;

      case '/api/restart':
        if (method === 'POST') {
          handleRestart(res);
        } else {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
        break;

      default:
        // Serve a simple status page for unknown routes
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getStatusHTML());
    }
  });

  return server;
}

/**
 * Health check endpoint handler
 */
function handleHealthCheck(res) {
  const isHealthy = botState.status === 'running' && botState.isConnected;
  res.writeHead(isHealthy ? 200 : 503);
  res.end(JSON.stringify({
    status: isHealthy ? 'healthy' : 'unhealthy',
    botStatus: botState.status,
    connected: botState.isConnected,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Status endpoint handler
 */
function handleStatus(res) {
  const uptime = botState.startTime 
    ? Math.floor((Date.now() - botState.startTime) / 1000) 
    : 0;
  
  res.writeHead(200);
  res.end(JSON.stringify({
    status: botState.status,
    connected: botState.isConnected,
    uptime: uptime,
    uptimeFormatted: formatUptime(uptime),
    version: botState.version,
    messagesProcessed: botState.messagesProcessed,
    lastActivity: botState.lastActivity,
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Simple ping endpoint
 */
function handlePing(res) {
  res.writeHead(200);
  res.end(JSON.stringify({
    pong: true,
    timestamp: Date.now(),
    latency: 0,
  }));
}

/**
 * Metrics endpoint for monitoring
 */
function handleMetrics(res) {
  const mem = process.memoryUsage();
  const uptime = botState.startTime 
    ? Math.floor((Date.now() - botState.startTime) / 1000) 
    : 0;

  res.writeHead(200);
  res.end(JSON.stringify({
    bot: {
      status: botState.status,
      connected: botState.isConnected,
      uptime: uptime,
      version: botState.version,
      messagesProcessed: botState.messagesProcessed,
    },
    system: {
      memory: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
      },
      memoryUnit: 'MB',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Bot info endpoint
 */
function handleBotInfo(res) {
  res.writeHead(200);
  res.end(JSON.stringify({
    name: 'OpenWhatsappBot',
    version: VERSION,
    prefix: PREFIX,
    repository: 'https://github.com/Starland9/OpenWhatsappBot',
    documentation: 'https://starland9.github.io/OpenWhatsappBot',
    features: [
      'AI Chat (Gemini, GPT)',
      'Media Downloads',
      'Sticker Creation',
      'Group Management',
      'Auto Responder',
      'Multi-language Support',
    ],
  }));
}

/**
 * Restart endpoint handler
 */
function handleRestart(res) {
  res.writeHead(200);
  res.end(JSON.stringify({
    message: 'Bot restart initiated',
    timestamp: new Date().toISOString(),
  }));

  // Schedule restart after response is sent
  setTimeout(() => {
    logger.info('Restart requested via panel API');
    process.exit(0); // PM2/panel will restart the process
  }, 1000);
}

/**
 * Generate HTML status page
 */
function getStatusHTML() {
  const uptime = botState.startTime 
    ? Math.floor((Date.now() - botState.startTime) / 1000) 
    : 0;
  const statusColor = botState.isConnected ? '#25D366' : '#FF6B6B';
  const statusText = botState.isConnected ? 'Connected' : 'Disconnected';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenWhatsappBot - Panel</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 500px;
      width: 100%;
      background: #1e1e1e;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 24px;
      color: #25D366;
      margin-bottom: 4px;
    }
    .version {
      color: #666;
      font-size: 14px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: ${statusColor}22;
      border: 1px solid ${statusColor};
      color: ${statusColor};
      padding: 8px 16px;
      border-radius: 20px;
      font-weight: 600;
      margin: 16px 0;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${statusColor};
      animation: ${botState.isConnected ? 'pulse 2s infinite' : 'none'};
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-top: 24px;
    }
    .stat {
      background: #2a2a2a;
      padding: 16px;
      border-radius: 12px;
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #25D366;
    }
    .stat-label {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
    .endpoints {
      margin-top: 24px;
      padding: 16px;
      background: #2a2a2a;
      border-radius: 12px;
    }
    .endpoints h3 {
      font-size: 14px;
      color: #888;
      margin-bottom: 12px;
    }
    .endpoint {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #333;
      font-size: 14px;
    }
    .endpoint:last-child { border: none; }
    .endpoint code {
      background: #333;
      padding: 2px 8px;
      border-radius: 4px;
      color: #25D366;
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      color: #666;
      font-size: 12px;
    }
    .footer a { color: #25D366; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">📱</div>
      <h1>OpenWhatsappBot</h1>
      <span class="version">v${VERSION}</span>
      <div class="status-badge">
        <span class="status-dot"></span>
        ${statusText}
      </div>
    </div>
    
    <div class="stats">
      <div class="stat">
        <div class="stat-value">${formatUptime(uptime)}</div>
        <div class="stat-label">Uptime</div>
      </div>
      <div class="stat">
        <div class="stat-value">${botState.messagesProcessed}</div>
        <div class="stat-label">Messages</div>
      </div>
      <div class="stat">
        <div class="stat-value">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</div>
        <div class="stat-label">Memory</div>
      </div>
      <div class="stat">
        <div class="stat-value">${botState.status}</div>
        <div class="stat-label">Status</div>
      </div>
    </div>

    <div class="endpoints">
      <h3>API Endpoints</h3>
      <div class="endpoint">
        <span>Health Check</span>
        <code>GET /health</code>
      </div>
      <div class="endpoint">
        <span>Status</span>
        <code>GET /status</code>
      </div>
      <div class="endpoint">
        <span>Ping</span>
        <code>GET /ping</code>
      </div>
      <div class="endpoint">
        <span>Metrics</span>
        <code>GET /metrics</code>
      </div>
    </div>

    <div class="footer">
      <p>Powered by <a href="https://github.com/Starland9/OpenWhatsappBot" target="_blank">OpenWhatsappBot</a></p>
      <p>Compatible with bot-hosting.net</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Start keep-alive ping mechanism
 */
function startKeepAlive() {
  setInterval(() => {
    if (botState.isConnected) {
      botState.lastActivity = new Date().toISOString();
      logger.debug('Keep-alive ping');
    }
  }, KEEP_ALIVE_INTERVAL);
}

/**
 * Process a single message
 */
async function processMessage(msg, client) {
  try {
    // Update activity
    botState.messagesProcessed++;
    botState.lastActivity = new Date().toISOString();

    // Skip broadcast messages
    if (msg.key.remoteJid === 'status@broadcast') return;

    // Create Message instance
    const message = new Message(client, msg);

    // Cache message for anti-delete functionality (non-blocking)
    setImmediate(() => antiDeleteHandler.cacheMessage(message));

    // Handle view-once messages first
    const viewOnceHandled = await viewOnceHandler.handleMessage(message);
    if (viewOnceHandled) {
      logger.debug('View-once message handled');
    }

    // Check if message is a reply to a quiz/game
    if (message.quoted) {
      const quizPlugin = getPlugin('quiz');
      if (quizPlugin && quizPlugin.handleReply) {
        const handled = await quizPlugin.handleReply(message);
        if (handled) return;
      }
    }

    // Check if this is a sticker command (stealth mode)
    if (message.type === 'stickerMessage' && message.data.message?.stickerMessage) {
      try {
        const fileSha256 = message.data.message.stickerMessage.fileSha256;
        if (fileSha256) {
          const stickerHash = Buffer.from(fileSha256).toString('hex');
          const stickerCmd = await StickerCommand.findOne({ where: { stickerHash } });

          if (stickerCmd) {
            logger.debug(`Executing sticker command: ${stickerCmd.command}`);
            message.body = require('./config').PREFIX + stickerCmd.command;
            await executeCommand(message);
            return;
          }
        }
      } catch (error) {
        logger.error('Sticker command error:', error);
      }
    }

    // Try auto-responder first (only for non-command messages)
    const isCommand = message.body.startsWith(require('./config').PREFIX);

    if (!isCommand && !message.fromMe) {
      const autoResponded = await autoResponderHandler.handleMessage(message);
      if (autoResponded) return;
    }

    // Execute commands
    await executeCommand(message);
  } catch (error) {
    logger.error('Error processing message:', error);
    botState.errors.push({
      type: 'message_processing',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    // Keep only last 100 errors
    if (botState.errors.length > 100) {
      botState.errors = botState.errors.slice(-100);
    }
  }
}

/**
 * Start the WhatsApp bot
 */
async function startBot() {
  logger.info(`🤖 Open Whatsapp Bot v${VERSION} (Panel Mode)`);
  botState.status = 'initializing';

  try {
    // Initialize memory manager
    memoryManager.performCleanup();
    logger.info('✅ Memory manager initialized');

    // Test database connection
    await DATABASE.authenticate({ retry: { max: 3 } });
    logger.info('✅ Database connected');

    // Sync database models
    await sync();
    logger.info('✅ Database synced');

    // Load all plugins
    await PluginLoader.loadAll();
    logger.info('✅ Plugins loaded');

    // Initialize WhatsApp client
    const client = new WhatsAppClient();
    await client.initialize();
    botState.client = client;

    // Handle incoming messages
    client.on('messages', async (messages) => {
      const concurrencyLimit = require('./config').MESSAGE_CONCURRENCY_LIMIT;
      for (let i = 0; i < messages.length; i += concurrencyLimit) {
        const batch = messages.slice(i, i + concurrencyLimit);
        await Promise.allSettled(batch.map((msg) => processMessage(msg, client)));
      }
    });

    // Ready event
    client.on('ready', () => {
      botState.status = 'running';
      botState.isConnected = true;
      botState.startTime = Date.now();
      logger.info('✅ Bot is ready and listening for messages');
    });

    // Handle message updates (for anti-delete)
    client.on('messages.update', async (updates) => {
      for (const update of updates) {
        await antiDeleteHandler.handleMessageDelete(update, client);
      }
    });

    // Handle disconnection
    client.on('close', () => {
      botState.isConnected = false;
      botState.status = 'disconnected';
    });

    return client;
  } catch (error) {
    logger.error('Failed to start bot:', error);
    botState.status = 'error';
    botState.errors.push({
      type: 'startup',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    throw error;
  }
}

/**
 * Graceful shutdown handler
 */
function setupGracefulShutdown(server) {
  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully...`);
    botState.status = 'shutting_down';

    // Close HTTP server
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Stop WhatsApp client
    if (botState.client) {
      try {
        await botState.client.stop();
        logger.info('WhatsApp client stopped');
      } catch (error) {
        logger.error('Error stopping client:', error);
      }
    }

    // Close database connection
    try {
      await DATABASE.close();
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Error closing database:', error);
    }

    // Give time for cleanup
    setTimeout(() => {
      logger.info('Goodbye!');
      process.exit(0);
    }, 2000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    botState.errors.push({
      type: 'uncaught_exception',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle unhandled rejections
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
    botState.errors.push({
      type: 'unhandled_rejection',
      error: String(reason),
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Create and start HTTP server
    const server = createServer();
    
    server.listen(PORT, HOST, () => {
      logger.info(`🌐 Panel server running on http://${HOST}:${PORT}`);
      logger.info('📊 Health check: /health');
      logger.info('📈 Status: /status');
      logger.info('🔄 Metrics: /metrics');
    });

    // Setup graceful shutdown
    setupGracefulShutdown(server);

    // Start keep-alive
    startKeepAlive();

    // Start WhatsApp bot
    await startBot();

  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

// Export for testing
module.exports = { createServer, botState };

// Run if this is the main module
if (require.main === module) {
  main();
}
