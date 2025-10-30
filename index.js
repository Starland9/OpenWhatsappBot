const { WhatsAppClient } = require("./lib/baileys/client");
const { Message } = require("./lib/classes/Message");
const PluginLoader = require("./lib/plugins/loader");
const { executeCommand, getPlugin } = require("./lib/plugins/registry");
const { DATABASE, sync, StickerCommand } = require("./lib/database");
const { VERSION } = require("./config");
const autoResponderHandler = require("./lib/utils/autoResponderHandler");
const viewOnceHandler = require("./lib/utils/viewOnceHandler");
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
      for (const msg of messages) {
        // Skip broadcast messages
        if (msg.key.remoteJid === "status@broadcast") continue;

        // Create Message instance
        const message = new Message(client, msg);

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
              continue; // Skip further processing
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
                logger.debug(
                  `Executing sticker command: ${stickerCmd.command}`
                );
                message.body = require("./config").PREFIX + stickerCmd.command;
                await executeCommand(message);
                continue; // Skip other handlers
              }
            }
          } catch (error) {
            logger.error("Sticker command error:", error);
          }
        }

        // Try auto-responder first (only for non-command messages)
        const isCommand = message.body.startsWith(require("./config").PREFIX);

        if (!isCommand && !message.fromMe) {
          const autoResponded = await autoResponderHandler.handleMessage(
            message
          );
          if (autoResponded) {
            continue; // Skip command execution if auto-responded
          }
        }

        // Skip messages from self (unless sudo)
        if (message.fromMe || !message.isSudo()) {
          // Execute commands
          await executeCommand(message);
        }
      }
    });

    // Ready event
    client.on("ready", () => {
      logger.info("✅ Bot is ready and listening for messages");
    });
  } catch (error) {
    logger.error("Failed to start bot:", error);
    process.exit(1);
  }
}

// Start the bot
start();
