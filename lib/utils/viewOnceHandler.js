const { extractMessageContent, getContentType } = require("baileys");
const { ViewOnce } = require("../database");
const config = require("../../config");
const settingsCache = require("./settingsCache");
const { getOwnerJids, jidUser } = require("./permissions");
const { getLang } = require("./language");

const logger = require("./logger").createLogger("viewOnceHandler");

const VIEW_ONCE_WRAPPERS = ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"];
// Wrappers that Baileys' extractMessageContent looks through
const OTHER_WRAPPERS = [
  "ephemeralMessage",
  "documentWithCaptionMessage",
  "editedMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
];

/**
 * Is this raw Baileys message (`message.data.message`, or a quoted message) a
 * view-once message? Covers the three wrappers (also inside an ephemeral
 * wrapper) and the `viewOnce` flag set on the media itself.
 * @param {object} rawMessage
 * @returns {boolean}
 */
function isViewOnce(rawMessage) {
  if (!rawMessage || typeof rawMessage !== "object") return false;

  // Walk the wrappers one level at a time to spot a view-once one
  let current = rawMessage;
  for (let i = 0; i < 5 && current; i++) {
    if (VIEW_ONCE_WRAPPERS.some((key) => current[key])) return true;
    const wrapper = OTHER_WRAPPERS.find((key) => current[key]);
    current = wrapper ? current[wrapper].message : null;
  }

  const content = extractMessageContent(rawMessage);
  const type = getContentType(content);
  return !!(type && content[type] && content[type].viewOnce);
}

/** Declared size of a media message, in bytes (Long, number or string) */
function declaredSize(media) {
  const raw = media?.fileLength;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "object" && typeof raw.toNumber === "function") return raw.toNumber();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * View-Once Message Handler
 * Automatically forwards view-once messages based on settings
 */
class ViewOnceHandler {
  /**
   * Is this raw message a view-once message?
   * @param {object} rawMessage
   * @returns {boolean}
   */
  isViewOnce(rawMessage) {
    return isViewOnce(rawMessage);
  }

  /**
   * Handle incoming message and check for view-once
   * @param {Message} message - The message instance
   * @returns {Promise<boolean>} - Returns true if message was handled
   */
  async handleMessage(message) {
    try {
      // Only handle messages from others
      if (message.fromMe) return false;

      // `message.content` / `message.type` are already unwrapped
      const messageType = message.type;
      const messageData = message.content?.[messageType];
      if (!messageData || typeof messageData !== "object") return false;
      if (!["imageMessage", "videoMessage", "audioMessage"].includes(messageType)) {
        return false;
      }
      if (!isViewOnce(message.data?.message)) return false;

      // Get settings from cache
      const settings = await settingsCache.get("view_once", async () => {
        return await ViewOnce.findOne({ where: { id: 1 } });
      });
      if (!settings || !settings.enabled || settings.vvMode === "null") {
        return false;
      }

      logger.info("View-once message detected, forwarding...");

      // Determine destination JID
      const socket = message.client.getSocket();
      let destinationJid;
      if (settings.vvMode === "p") {
        // Send to the first bot owner; fall back to the bot's own chat
        destinationJid = getOwnerJids()[0];
        if (!destinationJid) {
          destinationJid = socket.user?.id;
          logger.warn("No SUDO configured, falling back to bot JID");
        }
      } else if (settings.vvMode === "g") {
        // Send to same group/chat
        destinationJid = message.jid;
      } else if (settings.vvMode === "jid") {
        // Send to specific JID
        destinationJid = settings.vvJid;
      }
      if (!destinationJid) return false;

      // Size cap before downloading
      const maxBytes = (Number(config.MAX_UPLOAD) || 230) * 1024 * 1024;
      if (declaredSize(messageData) > maxBytes) {
        logger.warn("View-once media is over the size limit, not forwarded");
        return false;
      }

      // Download the media
      const mediaBuffer = await message.downloadMedia();
      if (!mediaBuffer) {
        logger.error("Failed to download view-once media");
        return false;
      }

      // Header with the author, then the original caption if any
      const author = jidUser(message.sender) || jidUser(message.senderLid);
      const header = getLang("plugins.viewonce.forward_caption", author);
      const caption = messageData.caption ? `${header}\n\n${messageData.caption}` : header;
      const mentions = [message.sender].filter(Boolean);

      if (messageType === "imageMessage") {
        await socket.sendMessage(destinationJid, { image: mediaBuffer, caption, mentions });
      } else if (messageType === "videoMessage") {
        await socket.sendMessage(destinationJid, { video: mediaBuffer, caption, mentions });
      } else {
        await socket.sendMessage(destinationJid, { text: header, mentions });
        await socket.sendMessage(destinationJid, {
          audio: mediaBuffer,
          mimetype: messageData.mimetype || "audio/mp4",
          ptt: !!messageData.ptt,
        });
      }

      logger.info(`View-once message forwarded to ${destinationJid}`);
      return true;
    } catch (error) {
      logger.error({ err: error }, "Error handling view-once message");
      return false;
    }
  }
}

module.exports = new ViewOnceHandler();
