const { WhatsAppClient } = require("./lib/baileys/client");
const { Message } = require("./lib/classes/Message");
const PluginLoader = require("./lib/plugins/loader");
const { executeCommand, getPlugin } = require("./lib/plugins/registry");
const { DATABASE, sync, StickerCommand } = require("./lib/database");
const { VERSION } = require("./config");
const autoResponderHandler = require("./lib/utils/autoResponderHandler");
const viewOnceHandler = require("./lib/utils/viewOnceHandler");
const antiDeleteHandler = require("./lib/utils/antiDeleteHandler");
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

    // Initialize WhatsApp client
    const client = new WhatsAppClient();
    await client.initialize();

    // Handle incoming messages
    client.on("messages", async (messages) => {
      // Process messages in parallel (with concurrency limit)
      const concurrencyLimit = require("./config").MESSAGE_CONCURRENCY_LIMIT;
      for (let i = 0; i < messages.length; i += concurrencyLimit) {
        const batch = messages.slice(i, i + concurrencyLimit);
        await Promise.allSettled(
          batch.map((msg) => processMessage(msg, client))
        );
      }
    });

    // Ready event
    client.on("ready", () => {
      logger.info("✅ Bot is ready and listening for messages");
    });

    // Handle message updates (for anti-delete)
    client.on("messages.update", async (updates) => {
      for (const update of updates) {
        await antiDeleteHandler.handleMessageDelete(update, client);
      }
    });
  } catch (error) {
    logger.error("Failed to start bot:", error);
    process.exit(1);
  }
}

/**
 * Process a single message
 */
async function processMessage(msg, client) {
  try {
    // Skip broadcast messages
    if (msg.key.remoteJid === "status@broadcast") return;

    // Create Message instance
    const message = new Message(client, msg);

    // Cache message for anti-delete functionality (non-blocking)
    setImmediate(() => antiDeleteHandler.cacheMessage(message));

    // Handle view-once messages first (before any other processing)
    const viewOnceHandled = await viewOnceHandler.handleMessage(message);
    if (viewOnceHandled) {
      logger.debug("View-once message handled");
      // Continue processing for other handlers/commands
    }

    // Check if message is a reply to a quiz/game
    if (message.quoted) {
      const quizPlugin = getPlugin("quiz");
      if (quizPlugin && quizPlugin.handleReply) {
        const handled = await quizPlugin.handleReply(message);
        if (handled) {
          return; // Skip further processing
        }
      }
    }

    // Check if this is a sticker command (stealth mode)
    if (
      message.type === "stickerMessage" &&
      message.data.message?.stickerMessage
    ) {
      try {
        const fileSha256 = message.data.message.stickerMessage.fileSha256;
        if (fileSha256) {
          const stickerHash = Buffer.from(fileSha256).toString("hex");
          const stickerCmd = await StickerCommand.findOne({
            where: { stickerHash },
          });

          if (stickerCmd) {
            // Execute the bound command silently
            logger.debug(`Executing sticker command: ${stickerCmd.command}`);
            message.body = require("./config").PREFIX + stickerCmd.command;
            await executeCommand(message);
            return; // Skip other handlers
          }
        }
      } catch (error) {
        logger.error("Sticker command error:", error);
      }
    }

    // Try auto-responder first (only for non-command messages)
    const isCommand = message.body.startsWith(require("./config").PREFIX);

    if (!isCommand && !message.fromMe) {
      const autoResponded = await autoResponderHandler.handleMessage(message);
      if (autoResponded) {
        return; // Skip command execution if auto-responded
      }
    }

    // Execute commands ONLY for sudo users (global restriction)
    if (message.isSudo()) {
      await executeCommand(message);
    }
  } catch (error) {
    logger.error("Error processing message:", error);
  }
}

// Start the bot
start();
