const { ViewOnce } = require("../database");
const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * View-Once Message Handler
 * Automatically forwards view-once messages based on settings
 */
class ViewOnceHandler {
  /**
   * Handle incoming message and check for view-once
   * @param {Message} message - The message instance
   * @returns {Promise<boolean>} - Returns true if message was handled
   */
  async handleMessage(message) {
    try {
      // Only handle messages from others
      if (message.fromMe) return false;

      // Check if message has view-once
      const messageContent = message.data?.message;
      if (!messageContent) return false;

      // Get the actual message type
      const messageType = message.type;
      const messageData = messageContent[messageType];

      // Check if this is a view-once message
      if (!messageData?.viewOnce) return false;

      // Get settings
      const settings = await ViewOnce.findOne({ where: { id: 1 } });
      if (!settings || !settings.enabled || settings.vvMode === "null") {
        return false;
      }

      logger.info("View-once message detected, forwarding...");

      // Determine destination JID
      let destinationJid;
      if (settings.vvMode === "p") {
        // Send to bot owner (sudo)
        destinationJid = message.client.getSocket().user.id;
      } else if (settings.vvMode === "g") {
        // Send to same group/chat
        destinationJid = message.jid;
      } else if (settings.vvMode === "jid") {
        // Send to specific JID
        destinationJid = settings.vvJid;
      } else {
        return false;
      }

      // Download the media
      const mediaBuffer = await message.downloadMedia();
      if (!mediaBuffer) {
        logger.error("Failed to download view-once media");
        return false;
      }

      // Prepare message to forward (without viewOnce)
      const forwardOptions = {
        caption: messageData.caption || `📸 *View-Once Message*\nFrom: @${message.sender.split("@")[0]}`,
        mentions: [message.sender],
      };

      // Send based on message type
      if (messageType === "imageMessage") {
        await message.client.getSocket().sendMessage(destinationJid, {
          image: mediaBuffer,
          ...forwardOptions,
        });
      } else if (messageType === "videoMessage") {
        await message.client.getSocket().sendMessage(destinationJid, {
          video: mediaBuffer,
          ...forwardOptions,
        });
      } else {
        logger.warn(`Unsupported view-once type: ${messageType}`);
        return false;
      }

      logger.info(`View-once message forwarded to ${destinationJid}`);
      return true;
    } catch (error) {
      logger.error("Error handling view-once message:", error);
      return false;
    }
  }
}

module.exports = new ViewOnceHandler();
