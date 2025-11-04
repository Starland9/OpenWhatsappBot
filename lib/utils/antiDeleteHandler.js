const { AntiDelete } = require("../database");
const config = require("../../config");
const settingsCache = require("./settingsCache");
const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Anti-Delete Message Handler
 * Automatically forwards deleted messages based on settings
 */
class AntiDeleteHandler {
  constructor() {
    // Store messages temporarily for anti-delete (cache last 100 messages per chat)
    this.messageCache = new Map();
    this.maxCacheSize = 100;
    this.cacheCleanupInterval = 10 * 60 * 1000; // 10 minutes
    this.maxCacheAge = 60 * 60 * 1000; // 1 hour
    
    // Start periodic cache cleanup
    this.startCacheCleanup();
  }

  /**
   * Start periodic cleanup of old messages from cache
   */
  startCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      let totalRemoved = 0;
      
      for (const [chatId, chatCache] of this.messageCache.entries()) {
        for (const [messageId, msg] of chatCache.entries()) {
          // Remove messages older than maxCacheAge
          if (now - msg.timestamp > this.maxCacheAge) {
            chatCache.delete(messageId);
            totalRemoved++;
          }
        }
        
        // Remove empty chat caches
        if (chatCache.size === 0) {
          this.messageCache.delete(chatId);
        }
      }
      
      if (totalRemoved > 0) {
        logger.debug(`Cleaned up ${totalRemoved} old messages from cache`);
      }
    }, this.cacheCleanupInterval);
  }

  /**
   * Cache incoming message
   * @param {Message} message - The message instance
   */
  cacheMessage(message) {
    try {
      // Don't cache our own messages or if no message content
      if (message.fromMe || !message.data?.message) return;

      const chatId = message.jid;
      const messageId = message.id;

      // Get or create cache for this chat
      if (!this.messageCache.has(chatId)) {
        this.messageCache.set(chatId, new Map());
      }

      const chatCache = this.messageCache.get(chatId);

      // Store message data
      chatCache.set(messageId, {
        key: message.key,
        message: message.data.message,
        sender: message.sender,
        timestamp: Date.now(),
        type: message.type,
        body: message.body,
        hasMedia: message.hasMedia,
      });

      // Limit cache size (remove oldest if exceeded)
      if (chatCache.size > this.maxCacheSize) {
        const firstKey = chatCache.keys().next().value;
        chatCache.delete(firstKey);
      }
    } catch (error) {
      logger.error("Error caching message:", error);
    }
  }

  /**
   * Handle message deletion event
   * @param {Object} update - The message update from Baileys
   * @param {Object} client - WhatsApp client instance
   */
  async handleMessageDelete(update, client) {
    try {
      // Check if settings are enabled (use cache)
      const settings = await settingsCache.get("anti_delete", async () => {
        return await AntiDelete.findOne({ where: { id: 1 } });
      });
      if (!settings || !settings.enabled || settings.antiDelMode === "null") {
        return false;
      }

      // Extract update details
      const { key, update: messageUpdate } = update;
      
      // Check if this is a delete operation
      if (messageUpdate?.message?.protocolMessage?.type !== 0) {
        return false; // Not a delete operation (0 = REVOKE)
      }

      const deletedMessageKey = messageUpdate.message.protocolMessage.key;
      const chatId = key.remoteJid;
      const messageId = deletedMessageKey.id;

      logger.info(`Message deleted detected in ${chatId}: ${messageId}`);

      // Get cached message
      const chatCache = this.messageCache.get(chatId);
      if (!chatCache || !chatCache.has(messageId)) {
        logger.warn(`Deleted message not in cache: ${messageId}`);
        return false;
      }

      const cachedMsg = chatCache.get(messageId);

      // Determine destination JID based on mode
      let destinationJid;
      const mode = settings.antiDelMode;

      if (mode === "p") {
        // Send to bot owner (sudo) - get first sudo number
        const sudoConfig = config.SUDO || "";
        const sudoNumbers = sudoConfig.split(",").map((s) => s.trim()).filter(Boolean);
        if (sudoNumbers.length > 0) {
          destinationJid = sudoNumbers[0].includes("@")
            ? sudoNumbers[0]
            : `${sudoNumbers[0]}@s.whatsapp.net`;
        } else {
          logger.warn("No SUDO configured for anti-delete mode 'p'");
          return false;
        }
      } else if (mode === "g") {
        // Send to same group/chat
        destinationJid = chatId;
      } else if (mode === "sudo") {
        // Only forward if deleter is sudo
        const deleter = key.participant || key.remoteJid;
        const sudoConfig = config.SUDO || "";
        const sudoNumbers = sudoConfig.split(",").map((s) => s.trim()).filter(Boolean);
        const isSudo = sudoNumbers.some((num) => {
          const normalizedNum = num.includes("@") ? num : `${num}@s.whatsapp.net`;
          return deleter === normalizedNum;
        });

        if (!isSudo) {
          return false; // Not a sudo user, skip
        }

        // Send to first sudo
        if (sudoNumbers.length > 0) {
          destinationJid = sudoNumbers[0].includes("@")
            ? sudoNumbers[0]
            : `${sudoNumbers[0]}@s.whatsapp.net`;
        } else {
          return false;
        }
      } else if (mode === "jid") {
        // Send to specific JID
        destinationJid = settings.antiDelJid;
        if (!destinationJid) {
          logger.warn("No JID configured for anti-delete mode 'jid'");
          return false;
        }
      } else {
        return false;
      }

      // Prepare the forwarded message
      const socket = client.getSocket();
      const senderNumber = cachedMsg.sender.split("@")[0];
      const chatName = chatId.endsWith("@g.us") ? "Group" : "Private";
      
      let headerText = `🗑️ *Deleted Message Detected*\n\n`;
      headerText += `*From:* @${senderNumber}\n`;
      headerText += `*Chat:* ${chatName}\n`;
      headerText += `*Time:* ${new Date(cachedMsg.timestamp).toLocaleString()}\n`;
      
      if (cachedMsg.body) {
        headerText += `\n*Message:*\n${cachedMsg.body}`;
      }

      // Send message based on type
      if (cachedMsg.hasMedia) {
        try {
          // Download media from cached message
          const buffer = await client.getSocket().downloadMediaMessage(
            {
              key: cachedMsg.key,
              message: cachedMsg.message,
            },
            "buffer",
            {},
            {
              logger: { info() {}, error() {}, warn() {} },
              reuploadRequest: socket.updateMediaMessage,
            }
          );

          if (buffer) {
            // Send media with caption
            const mediaType = cachedMsg.type;
            if (mediaType === "imageMessage") {
              await socket.sendMessage(destinationJid, {
                image: buffer,
                caption: headerText,
                mentions: [cachedMsg.sender],
              });
            } else if (mediaType === "videoMessage") {
              await socket.sendMessage(destinationJid, {
                video: buffer,
                caption: headerText,
                mentions: [cachedMsg.sender],
              });
            } else if (mediaType === "audioMessage") {
              // Send header first, then audio
              await socket.sendMessage(destinationJid, {
                text: headerText,
                mentions: [cachedMsg.sender],
              });
              await socket.sendMessage(destinationJid, {
                audio: buffer,
                mimetype: cachedMsg.message.audioMessage?.mimetype || "audio/mp4",
                ptt: cachedMsg.message.audioMessage?.ptt || false,
              });
            } else if (mediaType === "stickerMessage") {
              // Send header first, then sticker
              await socket.sendMessage(destinationJid, {
                text: headerText,
                mentions: [cachedMsg.sender],
              });
              await socket.sendMessage(destinationJid, {
                sticker: buffer,
              });
            } else if (mediaType === "documentMessage") {
              await socket.sendMessage(destinationJid, {
                document: buffer,
                fileName: cachedMsg.message.documentMessage?.fileName || "document",
                mimetype: cachedMsg.message.documentMessage?.mimetype || "application/octet-stream",
                caption: headerText,
                mentions: [cachedMsg.sender],
              });
            }
          } else {
            // If media download fails, send text notification
            await socket.sendMessage(destinationJid, {
              text: headerText + "\n\n_Media could not be recovered_",
              mentions: [cachedMsg.sender],
            });
          }
        } catch (error) {
          logger.error("Error downloading deleted media:", error);
          // Send text notification
          await socket.sendMessage(destinationJid, {
            text: headerText + "\n\n_Media download failed_",
            mentions: [cachedMsg.sender],
          });
        }
      } else {
        // Text message only
        await socket.sendMessage(destinationJid, {
          text: headerText,
          mentions: [cachedMsg.sender],
        });
      }

      logger.info(`Deleted message forwarded to ${destinationJid}`);
      return true;
    } catch (error) {
      logger.error("Error handling deleted message:", error);
      return false;
    }
  }
}

module.exports = new AntiDeleteHandler();
