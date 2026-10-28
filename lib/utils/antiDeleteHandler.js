const { extractMessageContent } = require("baileys");
const { AntiDelete } = require("../database");
const config = require("../../config");
const settingsCache = require("./settingsCache");
const { getOwnerJids, isOwnerJid, jidUser } = require("./permissions");
const { getLang } = require("./language");

const logger = require("./logger").createLogger("antiDeleteHandler");

// WAMessageStubType.REVOKE (1): what Baileys 7 puts in `messages.update` when a
// message is deleted for everyone. Falls back to the known value.
let REVOKE_STUB = 1;
try {
  const stubs = require("baileys").WAMessageStubType;
  if (stubs && stubs.REVOKE !== undefined) REVOKE_STUB = stubs.REVOKE;
} catch (_) {
  // keep the fallback
}

// Message types that carry nothing worth recovering
const SKIPPED_TYPES = new Set([
  "protocolMessage",
  "senderKeyDistributionMessage",
  "reactionMessage",
  "pollUpdateMessage",
]);

/** Declared size of a media message, in bytes (Long, number or string) */
function declaredSize(media) {
  const raw = media?.fileLength;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "object" && typeof raw.toNumber === "function") return raw.toNumber();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Local time of the original message, in the configured timezone */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  try {
    return date.toLocaleString(config.LANG || "en", { timeZone: config.TIMEZONE || "UTC" });
  } catch (_) {
    return date.toLocaleString();
  }
}

/**
 * Anti-Delete Message Handler
 * Automatically forwards deleted messages based on settings
 */
class AntiDeleteHandler {
  constructor() {
    // Store messages temporarily for anti-delete (cache last 100 messages per chat)
    this.messageCache = new Map();
    this.maxCacheSize = 100;

    // Start periodic cache cleanup
    this.startCacheCleanup();
  }

  /** Sweep period (ms): read from config when the timer is armed, see reconfigure() */
  get cacheCleanupInterval() {
    return config.CACHE_CLEANUP_INTERVAL;
  }

  /** Age (ms) after which a cached message is dropped: live, follows config */
  get maxCacheAge() {
    return config.CACHE_MAX_AGE;
  }

  /**
   * Re-arm the sweeper from the current config (CACHE_CLEANUP_INTERVAL changed and the bot restarted
   * in process). Exactly one timer exists afterwards.
   */
  reconfigure() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.startCacheCleanup();
  }

  /**
   * Start periodic cleanup of old messages from cache
   */
  startCacheCleanup() {
    // unref: the sweeper must not keep the process (or a test run) alive
    this.cleanupTimer = setInterval(() => {
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
    this.cleanupTimer.unref();
  }

  /**
   * Cache incoming message
   * @param {Message} message - The message instance
   */
  cacheMessage(message) {
    try {
      // Don't cache our own messages or if no message content
      if (message.fromMe || !message.data?.message) return;
      if (!message.type || SKIPPED_TYPES.has(message.type)) return;

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
      logger.error({ err: error }, "Error caching message");
    }
  }

  /**
   * Size of the in-memory cache, for the panel's storage page: entry count, chat count and a rough
   * size of the cached text. Never any content.
   * @returns {{ entries: number, chats: number, bytes: number }}
   */
  getCacheStats() {
    let entries = 0;
    let bytes = 0;
    for (const chatCache of this.messageCache.values()) {
      for (const msg of chatCache.values()) {
        entries++;
        if (typeof msg.body === "string") bytes += Buffer.byteLength(msg.body);
      }
    }
    return { entries, chats: this.messageCache.size, bytes };
  }

  /**
   * Forget every cached message (storage page "empty"): deleted messages of the last hour can no
   * longer be recovered. Returns what was dropped.
   * @returns {{ entries: number, chats: number, bytes: number }}
   */
  clearCache() {
    const dropped = this.getCacheStats();
    this.messageCache.clear();
    return dropped;
  }

  /**
   * Id of the message deleted for everyone, or null when this update is not a deletion.
   * Baileys 7 emits `{ key: { ...revokeKey, id: <deleted id> }, update: { message: null,
   * messageStubType: REVOKE } }`; a protocolMessage of type REVOKE (0) is still accepted.
   */
  getRevokedId(update) {
    const key = update?.key;
    const messageUpdate = update?.update;
    if (!key) return null;
    if (messageUpdate?.messageStubType === REVOKE_STUB) return key.id || null;

    const protocol = messageUpdate?.message?.protocolMessage;
    if (protocol && (protocol.type === 0 || protocol.type === "REVOKE")) {
      return protocol.key?.id || null;
    }
    return null;
  }

  /**
   * Handle message deletion event
   * @param {Object} update - The message update from Baileys
   * @param {Object} client - WhatsApp client instance
   */
  async handleMessageDelete(update, client) {
    try {
      // Cheap shape check first: most `messages.update` events are receipts
      const messageId = this.getRevokedId(update);
      if (!messageId) return false;

      // Check if settings are enabled (use cache)
      const settings = await settingsCache.get("anti_delete", async () => {
        return await AntiDelete.findOne({ where: { id: 1 } });
      });
      if (!settings || !settings.enabled || settings.antiDelMode === "null") {
        return false;
      }

      const { key } = update;
      const chatId = key.remoteJid;

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
        // Send to the first bot owner
        destinationJid = getOwnerJids()[0];
        if (!destinationJid) {
          logger.warn("No SUDO configured for anti-delete mode 'p'");
          return false;
        }
      } else if (mode === "g") {
        // Send to same group/chat
        destinationJid = chatId;
      } else if (mode === "sudo") {
        // Only forward if the deleter is an owner. `key` is the revoke message's
        // key: participant = who deleted (group), remoteJid = the chat otherwise.
        const deleters = [key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt];
        if (!deleters.some((jid) => jid && isOwnerJid(jid))) {
          return false; // Not an owner, skip
        }
        destinationJid = getOwnerJids()[0];
        if (!destinationJid) return false;
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
      const sender = cachedMsg.sender;
      const mentions = [sender].filter(Boolean);

      let headerText = getLang(
        "plugins.antidelete.report",
        jidUser(sender),
        getLang(
          chatId.endsWith("@g.us")
            ? "plugins.antidelete.chat_group"
            : "plugins.antidelete.chat_private",
        ),
        formatTime(cachedMsg.timestamp),
      );

      if (cachedMsg.body) {
        headerText += getLang("plugins.antidelete.report_body", cachedMsg.body);
      }

      // Send message based on type
      if (cachedMsg.hasMedia) {
        const content = extractMessageContent(cachedMsg.message) || {};
        const media = content[cachedMsg.type];
        const maxBytes = (Number(config.MAX_UPLOAD) || 230) * 1024 * 1024;

        if (declaredSize(media) > maxBytes) {
          await socket.sendMessage(destinationJid, {
            text: headerText + getLang("plugins.antidelete.media_too_large"),
            mentions,
          });
          logger.info(`Deleted message (media over the limit) reported to ${destinationJid}`);
          return true;
        }

        try {
          // Download media from cached message
          const { downloadMedia } = require("../baileys/mediaAdapter");
          const buffer = await downloadMedia(
            socket,
            { key: cachedMsg.key, message: cachedMsg.message },
            "buffer",
          );

          if (buffer) {
            // Send media with caption
            const mediaType = cachedMsg.type;
            if (mediaType === "imageMessage") {
              await socket.sendMessage(destinationJid, {
                image: buffer,
                caption: headerText,
                mentions,
              });
            } else if (mediaType === "videoMessage") {
              await socket.sendMessage(destinationJid, {
                video: buffer,
                caption: headerText,
                mentions,
              });
            } else if (mediaType === "audioMessage") {
              // Send header first, then audio
              await socket.sendMessage(destinationJid, {
                text: headerText,
                mentions,
              });
              await socket.sendMessage(destinationJid, {
                audio: buffer,
                mimetype: media?.mimetype || "audio/mp4",
                ptt: media?.ptt || false,
              });
            } else if (mediaType === "stickerMessage") {
              // Send header first, then sticker
              await socket.sendMessage(destinationJid, {
                text: headerText,
                mentions,
              });
              await socket.sendMessage(destinationJid, {
                sticker: buffer,
              });
            } else if (mediaType === "documentMessage") {
              await socket.sendMessage(destinationJid, {
                document: buffer,
                fileName: media?.fileName || "document",
                mimetype: media?.mimetype || "application/octet-stream",
                caption: headerText,
                mentions,
              });
            }
          } else {
            // If media download fails, send text notification
            await socket.sendMessage(destinationJid, {
              text: headerText + getLang("plugins.antidelete.media_unrecovered"),
              mentions,
            });
          }
        } catch (error) {
          logger.error({ err: error }, "Error downloading deleted media");
          // Send text notification
          await socket.sendMessage(destinationJid, {
            text: headerText + getLang("plugins.antidelete.media_failed"),
            mentions,
          });
        }
      } else {
        // Text message only
        await socket.sendMessage(destinationJid, {
          text: headerText,
          mentions,
        });
      }

      logger.info(`Deleted message forwarded to ${destinationJid}`);
      return true;
    } catch (error) {
      logger.error({ err: error }, "Error handling deleted message");
      return false;
    }
  }
}

module.exports = new AntiDeleteHandler();
