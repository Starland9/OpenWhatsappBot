const { WhatsAppClient } = require("./lib/baileys/client");
const PluginLoader = require("./lib/plugins/loader");
const { attachHandlers } = require("./lib/core/pipeline");
const { DATABASE, sync } = require("./lib/database");
const { VERSION } = require("./config");
const memoryManager = require("./lib/utils/memoryManager");
const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  },
});

// Global safety: catch uncaught errors/rejections to avoid process crash
process.on("uncaughtException", (err) => {
  try {
    logger.error({ err }, "Uncaught exception");
  } catch (e) {
    console.error("Uncaught exception:", err);
  }
});

process.on("unhandledRejection", (reason, p) => {
  try {
    logger.error({ reason, p }, "Unhandled rejection");
  } catch (e) {
    console.error("Unhandled rejection:", reason);
  }
});

// Set a sane global timeout for axios (used by many plugins)
try {
  const axios = require("axios");
  if (axios && axios.defaults) axios.defaults.timeout = 30000; // 30s
} catch (e) {
  logger.debug("axios not available to set global timeout");
}

/**
 * Start the WhatsApp bot
 */
async function start() {
  logger.info(`🤖 Open Whatsapp Bot v${VERSION}`);

  try {
    // Initialize memory manager
    memoryManager.performCleanup();
    logger.info("✅ Memory manager initialized");

    // Test database connection
    await DATABASE.authenticate({ retry: { max: 3 } });
    logger.info("✅ Database connected");

    // Sync database models
    await sync();
    logger.info("✅ Database synced");

    // Load all plugins
    await PluginLoader.loadAll();
    logger.info("✅ Plugins loaded");

    // Initialize WhatsApp client. The shared pipeline (lib/core/pipeline.js)
    // handles messages, anti-delete, group participants and ready hooks; it is
    // attached first so that no event is missed.
    const client = new WhatsAppClient();
    attachHandlers(client);
    await client.initialize();
  } catch (error) {
    logger.error({ err: error }, "Failed to start bot");
    process.exit(1);
  }
}

// Start the bot
start();
