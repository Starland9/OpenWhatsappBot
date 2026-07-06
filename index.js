const { WhatsAppClient } = require("./lib/baileys/client");
const { Message } = require("./lib/classes/Message");
const PluginLoader = require("./lib/plugins/loader");
const { executeCommand, getPlugin } = require("./lib/plugins/registry");
const { DATABASE, sync, StickerCommand } = require("./lib/database");
const { VERSION } = require("./config");
const autoResponderHandler = require("./lib/utils/autoResponderHandler");
const viewOnceHandler = require("./lib/utils/viewOnceHandler");
const antiDeleteHandler = require("./lib/utils/antiDeleteHandler");
const antilinkHandler = require("./lib/utils/antilinkHandler");
const antifloodHandler = require("./lib/utils/antifloodHandler");
const antiwordHandler = require("./lib/utils/antiwordHandler");
const captchaHandler = require("./lib/utils/captchaHandler");
const statusSaver = require("./lib/utils/statusSaver");
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
          batch.map((msg) => processMessage(msg, client)),
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

    // Handle group participant updates (captcha, antibot)
    client.on("group-participants.update", async (update) => {
      await captchaHandler.handleParticipantsUpdate(update, client);
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
    // Handle status broadcasts separately (save status if enabled)
    if (msg.key.remoteJid === "status@broadcast") {
      try {
        await statusSaver.handleStatus(msg, client);
      } catch (e) {
        logger.error("Status save error:", e);
      }
      return;
    }

    // Create Message instance
    const message = new Message(client, msg);

    // Cache message for anti-delete functionality (non-blocking)
    setImmediate(() => antiDeleteHandler.cacheMessage(message));

    // Track user activity for group messages (non-blocking)
    if (message.isGroup && !message.fromMe && message.sender) {
      setImmediate(async () => {
        try {
          const { UserActivity } = require("./lib/database");
          const fields = { messageCount: 1 };
          if (message.type === "audioMessage") fields.voiceCount = 1;
          else if (message.type === "stickerMessage") fields.stickerCount = 1;
          else if (
            ["imageMessage", "videoMessage", "documentMessage"].includes(
              message.type,
            )
          )
            fields.mediaCount = 1;

          const [record] = await UserActivity.findOrCreate({
            where: { jid: message.sender, groupJid: message.jid },
            defaults: { jid: message.sender, groupJid: message.jid },
          });
          await record.increment(fields);
          await record.update({ lastActive: new Date() });
        } catch (_) {}
      });
    }

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
      // Run protection handlers in sequence (group only)
      if (message.isGroup) {
        const captchaHandled = await captchaHandler.handleMessage(message);
        if (captchaHandled) return;

        const linkHandled = await antilinkHandler.handleMessage(message);
        if (linkHandled) return;

        const floodHandled = await antifloodHandler.handleMessage(message);
        if (floodHandled) return;

        const wordHandled = await antiwordHandler.handleMessage(message);
        if (wordHandled) return;

        // Route to game message handlers
        const gameHandler = require("./lib/utils/gameHandler");
        const gameHandled = await gameHandler.handleMessage(message);
        if (gameHandled) return;
      }

      const autoResponded = await autoResponderHandler.handleMessage(message);
      if (autoResponded) {
        return; // Skip command execution if auto-responded
      }
    }

    // Execute commands (open to everyone, per-command restrictions in registry)
    await executeCommand(message);
  } catch (error) {
    logger.error("Error processing message:", error);
  }
}

// Start the bot
start();
