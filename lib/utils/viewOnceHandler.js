const { extractMessageContent, getContentType } = require("baileys");
const config = require("../../config");
const { getOwnerJids, jidUser, normalizeJid } = require("./permissions");
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
 * Where autovv sends a received view-once: the first owner (`p`, else the bot's own chat), the chosen chat
 * (`jid`), or nowhere (`off`). Never the chat it came from.
 * @returns {string|null}
 */
function autovvDestination(socket) {
  const mode = config.AUTOVV_MODE;
  if (mode === "p") {
    const owner = getOwnerJids()[0];
    if (owner) return owner;
    logger.warn("autovv: no SUDO configured, falling back to the bot's own chat");
    return normalizeJid(socket?.user?.id) || null;
  }
  if (mode === "jid") return normalizeJid(config.AUTOVV_JID) || null;
  return null;
}

// The view-once messages the bot received, for a later .vv on a quote that lost its link (opened on the phone)
const RECEIVED_TTL_MS = 24 * 60 * 60 * 1000;
const RECEIVED_MAX = 200;
const MEDIA_KINDS = ["imageMessage", "videoMessage", "audioMessage"];
// What a download needs, and what .vv shows: never the thumbnail (the store stays a few hundred bytes per entry)
const KEPT_FIELDS = [
  "url",
  "directPath",
  "mediaKey",
  "mediaKeyTimestamp",
  "fileSha256",
  "fileEncSha256",
  "fileLength",
  "mimetype",
  "caption",
  "ptt",
  "seconds",
  "width",
  "height",
];

/**
 * View-Once Message Handler
 * autovv: forwards the view-once messages the bot receives (WhatsApp sends them to Android devices only,
 * see BAILEYS_DEVICE), and keeps them a day for .vv
 */
class ViewOnceHandler {
  constructor() {
    this.RECEIVED_TTL_MS = RECEIVED_TTL_MS;
    this.RECEIVED_MAX = RECEIVED_MAX;
    /** message id -> { chats, type, media, at }, oldest first */
    this.received = new Map();
  }

  /**
   * Keep a received view-once (someone else's, with its link and key) for .vv. In memory only, a day at
   * most, the newest RECEIVED_MAX.
   * @returns {boolean} kept
   */
  remember(message, now = Date.now()) {
    try {
      if (!message || message.fromMe) return false;
      const type = message.type;
      if (!MEDIA_KINDS.includes(type) || !isViewOnce(message.data?.message)) return false;
      const media = message.content?.[type];
      if (!media || (!media.directPath && !media.url) || !media.mediaKey) return false;
      const id = message.key?.id;
      if (!id) return false;

      const copy = {};
      for (const field of KEPT_FIELDS) {
        if (media[field] !== undefined && media[field] !== null) copy[field] = media[field];
      }
      const chats = [message.jid, message.key?.remoteJidAlt].filter(Boolean);
      this.received.delete(id);
      this.received.set(id, { chats, type, media: copy, at: now });

      for (const [key, entry] of this.received) {
        if (now - entry.at <= RECEIVED_TTL_MS && this.received.size <= RECEIVED_MAX) break;
        this.received.delete(key);
      }
      return true;
    } catch (error) {
      logger.debug(`View-once not kept: ${error?.message}`);
      return false;
    }
  }

  /**
   * The received copy of view-once `id`, as a raw message (`{ imageMessage: {...} }`), only when it came
   * from one of `chats` (the chat .vv is used in, PN or LID form): a quote can name any id.
   * @returns {object|null}
   */
  recall(chats, id, now = Date.now()) {
    const entry = id ? this.received.get(id) : null;
    if (!entry) return null;
    if (now - entry.at > RECEIVED_TTL_MS) {
      this.received.delete(id);
      return null;
    }
    const wanted = (chats || []).filter(Boolean);
    if (!entry.chats.some((chat) => wanted.includes(chat))) return null;
    return { [entry.type]: { ...entry.media } };
  }

  /** Drop every kept view-once (tests) */
  forgetReceived() {
    this.received.clear();
  }

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

      // Kept for .vv whatever autovv says (a quote of a view-once opened on the phone has no link)
      this.remember(message);

      // autovv (AUTOVV_MODE / AUTOVV_JID, read at call time). The `.setvv` row is only the destination of .vv
      const socket = message.client.getSocket();
      const destinationJid = autovvDestination(socket);
      if (!destinationJid) return false;

      logger.info("View-once message detected, forwarding (autovv)");

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
