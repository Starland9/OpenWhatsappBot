const {
  getContentType,
  jidNormalizedUser,
  extractMessageContent,
} = require("baileys");
const config = require("../../config");
const { downloadMedia } = require("../baileys/mediaAdapter");
const {
  normalizeJid,
  isLidJid,
  isPnJid,
  isOwnerJid,
  getBotJids,
} = require("../utils/permissions");

const MEDIA_TYPES = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
};

// Group metadata cache shared by every Message (research R9).
// Invalidated by lib/baileys/client.js on groups.update / group-participants.update.
const GROUP_METADATA_TTL_MS = 60 * 1000;
const groupMetadataCache = new Map(); // groupJid -> { value, expiresAt }

/**
 * Drop cached group metadata.
 * @param {string} [jid] - group JID; omit to clear every group
 */
function invalidateGroupMetadata(jid) {
  if (jid) groupMetadataCache.delete(jid);
  else groupMetadataCache.clear();
}

function cacheGroupMetadata(jid, value) {
  const now = Date.now();
  if (groupMetadataCache.size > 1000) {
    for (const [key, entry] of groupMetadataCache) {
      if (entry.expiresAt <= now) groupMetadataCache.delete(key);
    }
  }
  groupMetadataCache.set(jid, { value, expiresAt: now + GROUP_METADATA_TTL_MS });
}

/**
 * Pick the phone-number (PN) form and the LID form out of a JID and its
 * Baileys 7 "alt" counterpart (key.participantAlt / key.remoteJidAlt).
 */
function pickIdentity(primary, alt) {
  const forms = [normalizeJid(primary), normalizeJid(alt)].filter(Boolean);
  const pn = forms.find(isPnJid);
  const lid = forms.find(isLidJid);
  return { sender: pn || forms[0] || "", senderLid: lid || null };
}

function resolveSender(key, sock) {
  if (key.fromMe) {
    const bot = getBotJids(sock);
    if (bot.pn || bot.lid) {
      return { sender: bot.pn || bot.lid, senderLid: bot.lid || null };
    }
    if (key.participant) return pickIdentity(key.participant, key.participantAlt);
    return { sender: "", senderLid: null };
  }
  if (key.participant) {
    // Group (or broadcast) message: participant is the author
    return pickIdentity(key.participant, key.participantAlt);
  }
  // Private chat: the chat JID is the author
  return pickIdentity(key.remoteJid, key.remoteJidAlt);
}

/**
 * Id of a button / list / native-flow reply, or null.
 * @returns {{ id: string, kind: "button"|"list" }|null}
 */
function parseInteractive(type, msg) {
  if (!msg || typeof msg !== "object") return null;

  if (type === "interactiveResponseMessage") {
    const flow = msg.nativeFlowResponseMessage;
    if (!flow?.paramsJson) return null;
    try {
      const params = JSON.parse(flow.paramsJson);
      const id = params?.id ?? params?.selectedId ?? params?.selectedRowId;
      if (id === undefined || id === null || id === "") return null;
      return {
        id: String(id),
        kind: flow.name === "single_select" ? "list" : "button",
      };
    } catch (_) {
      return null;
    }
  }
  if (type === "buttonsResponseMessage" && msg.selectedButtonId) {
    return { id: msg.selectedButtonId, kind: "button" };
  }
  if (type === "templateButtonReplyMessage" && msg.selectedId) {
    return { id: msg.selectedId, kind: "button" };
  }
  if (type === "listResponseMessage" && msg.singleSelectReply?.selectedRowId) {
    return { id: msg.singleSelectReply.selectedRowId, kind: "list" };
  }
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mediaTooLargeError(size, maxBytes) {
  const error = new Error("MEDIA_TOO_LARGE");
  error.code = "MEDIA_TOO_LARGE";
  error.fileLength = size;
  error.maxBytes = maxBytes;
  error.maxMB = Math.max(1, Math.round(maxBytes / (1024 * 1024)));
  return error;
}

/**
 * Lightweight audio mimetype detection from magic bytes.
 * @param {Buffer} buffer
 * @returns {string|null}
 */
function sniffAudioMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const ascii = (start, end) => buffer.toString("latin1", start, end);

  if (ascii(0, 4) === "OggS") {
    const head = buffer.toString("latin1", 0, Math.min(buffer.length, 64));
    return head.includes("OpusHead") ? "audio/ogg; codecs=opus" : "audio/ogg";
  }
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return "audio/webm";
  }
  if (buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return "audio/aac";
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

function findParticipant(metadata, jids) {
  const wanted = new Set(jids.map(normalizeJid).filter(Boolean));
  if (wanted.size === 0) return null;
  return (
    (metadata?.participants || []).find((p) =>
      [p.id, p.phoneNumber, p.lid].some(
        (x) => x && wanted.has(normalizeJid(x)),
      ),
    ) || null
  );
}

function isAdminParticipant(participant) {
  if (!participant) return false;
  const role = participant.admin;
  return (
    role === "admin" ||
    role === "superadmin" ||
    participant.isAdmin === true ||
    participant.isSuperAdmin === true
  );
}

/**
 * Message abstraction class
 */
class Message {
  constructor(client, data) {
    this.client = client;
    this.data = data;
    this.key = data.key;
    this.jid = data.key.remoteJid;
    this.fromMe = data.key.fromMe;
    this.id = data.key.id;

    const sock =
      client && typeof client.getSocket === "function"
        ? client.getSocket()
        : null;

    // Sender (research R9): `sender` is the phone-number JID when Baileys
    // provides one (key.participantAlt / key.remoteJidAlt with LID addressing),
    // `senderLid` the LID form when known.
    const { sender, senderLid } = resolveSender(data.key, sock);
    this.sender = sender;
    this.senderLid = senderLid;

    this.isGroup = (this.jid || "").endsWith("@g.us");

    // Extract message content (unwraps ephemeral / view-once wrappers)
    const content = extractMessageContent(data.message);
    this.content = content || null;
    this.type = getContentType(content);

    this.isButtonReply = false;
    this.isListReply = false;
    this.isInteractiveReply = false;

    // Handle undefined type (e.g., protocol messages, reactions, etc.)
    if (!this.type || !content) {
      this.body = "";
      this.quoted = null;
      this.hasMedia = false;
      this.mentions = [];
      this.isCommand = false;
      return;
    }

    const msg = content[this.type];
    const interactive = parseInteractive(this.type, msg);

    // Extract text (button / list / native-flow replies: the selected id)
    const body =
      interactive?.id ||
      msg?.text ||
      msg?.caption ||
      msg?.conversation ||
      msg?.selectedButtonId ||
      msg?.singleSelectReply?.selectedRowId ||
      msg?.listResponseMessage?.singleSelectReply?.selectedRowId ||
      msg?.buttonsResponseMessage?.selectedButtonId ||
      (typeof msg === "string" ? msg : "") ||
      "";
    this.body = typeof body === "string" ? body : String(body);

    // Detect interactive button / list replies (separate from quoted messages)
    this.isButtonReply =
      interactive?.kind === "button" ||
      !!(msg?.selectedButtonId || msg?.buttonsResponseMessage?.selectedButtonId);
    this.isListReply =
      interactive?.kind === "list" ||
      !!(
        msg?.singleSelectReply?.selectedRowId ||
        msg?.listResponseMessage?.singleSelectReply?.selectedRowId
      );
    this.isInteractiveReply = this.isButtonReply || this.isListReply;

    // Check if quoted/replied message
    const ctx = msg?.contextInfo;
    if (ctx?.quotedMessage) {
      const remoteJid = ctx.remoteJid || this.jid;
      const participant = ctx.participant || undefined;
      const bot = getBotJids(sock);
      const quotedAuthor = normalizeJid(participant);
      const keyParticipant =
        (remoteJid || "").endsWith("@g.us") ||
        (remoteJid || "").endsWith("@broadcast")
          ? participant
          : undefined;
      this.quoted = {
        message: ctx.quotedMessage,
        sender: jidNormalizedUser(participant || ""),
        id: ctx.stanzaId,
        key: {
          remoteJid,
          id: ctx.stanzaId,
          participant: keyParticipant,
          fromMe:
            !!quotedAuthor &&
            (quotedAuthor === bot.pn || quotedAuthor === bot.lid),
        },
      };
    } else {
      this.quoted = null;
    }

    // Media detection
    this.hasMedia = [
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "stickerMessage",
      "documentMessage",
    ].includes(this.type);

    // Mentions
    this.mentions = ctx?.mentionedJid || [];

    // Set again by the pipeline (a sticker command rewrites the body)
    this.isCommand = this.body.startsWith(config.PREFIX);
  }

  /**
   * Reply to the message
   */
  async reply(text, options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { text, ...options }, { quoted: this.data });
  }

  /**
   * Send an image
   */
  async sendImage(buffer, caption = "", options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { image: buffer, caption, ...options });
  }

  /**
   * Send a video
   */
  async sendVideo(buffer, caption = "", options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { video: buffer, caption, ...options });
  }

  /**
   * Send a sticker
   */
  async sendSticker(buffer, options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { sticker: buffer, ...options });
  }

  /**
   * Send an audio
   */
  async sendAudio(buffer, options = {}) {
    return await this.client.getSocket().sendMessage(this.jid, {
      audio: buffer,
      mimetype: "audio/mp4",
      ...options,
    });
  }

  /**
   * Send an audio file with a mimetype detected from its content
   * (mp3, ogg, m4a, wav, webm, flac, aac). `options.mimetype` overrides it.
   */
  async sendAudioFile(buffer, options = {}) {
    const mimetype = sniffAudioMime(buffer) || "audio/mpeg";
    return await this.client.getSocket().sendMessage(this.jid, {
      audio: buffer,
      mimetype,
      ptt: false,
      ...options,
    });
  }

  /**
   * React to the message
   */
  async react(emoji) {
    if (!config.ENABLE_MESSAGE_REACTIONS) return null;
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { react: { text: emoji, key: this.key } });
  }

  /**
   * Delete the message
   */
  async delete() {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { delete: this.key });
  }

  /**
   * Download media from the message
   */
  async downloadMedia() {
    if (!this.hasMedia) return null;

    try {
      const buffer = await downloadMedia(
        this.client.getSocket(),
        this.data,
        "buffer",
      );
      return buffer;
    } catch (error) {
      console.error("Failed to download media:", error?.message);
      return null;
    }
  }

  /**
   * Download the media of the quoted message (view-once / ephemeral unwrapped).
   * Rejects before downloading when the declared size is over the cap.
   * @param {{ maxBytes?: number }} [opts] - default: config.MAX_UPLOAD MB
   * @returns {Promise<{buffer: Buffer, type: string, mimetype: string|null, fileLength: number}|null>}
   *   `type` is "image" | "video" | "audio" | "document" | "sticker"; null when
   *   there is no quoted media or the download failed.
   * @throws {Error} with `code = "MEDIA_TOO_LARGE"` (and `maxMB`) when too big
   */
  async getQuotedMedia({ maxBytes } = {}) {
    if (!this.quoted?.message) return null;

    const content = extractMessageContent(this.quoted.message);
    const mediaKey = getContentType(content);
    const type = MEDIA_TYPES[mediaKey];
    if (!type) return null;

    const media = content[mediaKey];
    const limit =
      maxBytes ?? (Number(config.MAX_UPLOAD) || 230) * 1024 * 1024;
    const declared = toNumber(media?.fileLength);
    if (limit && declared > limit) throw mediaTooLargeError(declared, limit);

    const buffer = await downloadMedia(
      this.client.getSocket(),
      { key: this.quoted.key, message: { [mediaKey]: media } },
      "buffer",
    );
    if (!buffer || !buffer.length) return null;
    if (limit && buffer.length > limit) {
      throw mediaTooLargeError(buffer.length, limit);
    }

    return {
      buffer,
      type,
      mimetype: media?.mimetype || null,
      fileLength: declared || buffer.length,
    };
  }

  /**
   * Text of the quoted message (conversation, extended text, caption), or "".
   */
  getQuotedText() {
    if (!this.quoted?.message) return "";
    const content = extractMessageContent(this.quoted.message);
    const type = getContentType(content);
    if (!type) return "";
    const msg = content[type];
    if (typeof msg === "string") return msg;
    const text = msg?.text || msg?.caption || msg?.conversation || "";
    return typeof text === "string" ? text : "";
  }

  /**
   * Check if sender is an owner (SUDO). Accepts the PN or the LID form.
   */
  isSudo() {
    return [this.sender, this.senderLid].some(
      (jid) => !!jid && isOwnerJid(jid),
    );
  }

  /**
   * Get group metadata (memoized per message, cached 60 s per group)
   */
  async getGroupMetadata() {
    if (!this.isGroup) return null;
    if (this._groupMetadataPromise) return this._groupMetadataPromise;

    this._groupMetadataPromise = (async () => {
      const cached = groupMetadataCache.get(this.jid);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      try {
        const metadata = await this.client.getSocket().groupMetadata(this.jid);
        if (metadata) cacheGroupMetadata(this.jid, metadata);
        return metadata || null;
      } catch (error) {
        console.error("Failed to get group metadata:", error?.message);
        return null;
      }
    })();

    const metadata = await this._groupMetadataPromise;
    if (!metadata) this._groupMetadataPromise = null; // retry next time
    return metadata;
  }

  /**
   * Check if bot is admin in group
   */
  async isBotAdmin() {
    if (!this.isGroup) return false;

    const metadata = await this.getGroupMetadata();
    if (!metadata) return false;

    const bot = getBotJids(this.client.getSocket());
    return isAdminParticipant(findParticipant(metadata, [bot.pn, bot.lid]));
  }

  /**
   * Check if sender is group admin
   */
  async isSenderAdmin() {
    if (!this.isGroup) return false;

    const metadata = await this.getGroupMetadata();
    if (!metadata) return false;

    return isAdminParticipant(
      findParticipant(metadata, [this.sender, this.senderLid]),
    );
  }

  _forgetGroupMetadata() {
    this._groupMetadataPromise = null;
    invalidateGroupMetadata(this.jid);
  }

  /**
   * Kick a participant from group
   */
  async kick(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    const res = await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "remove");
    this._forgetGroupMetadata();
    return res;
  }

  /**
   * Add participants to group
   */
  async add(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    const res = await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "add");
    this._forgetGroupMetadata();
    return res;
  }

  /**
   * Promote participant to admin
   */
  async promote(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    const res = await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "promote");
    this._forgetGroupMetadata();
    return res;
  }

  /**
   * Demote admin to participant
   */
  async demote(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    const res = await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "demote");
    this._forgetGroupMetadata();
    return res;
  }

  /**
   * Send a document/file
   */
  async sendDocument(buffer, options = {}) {
    const {
      fileName = "document",
      mimetype = "application/octet-stream",
      caption = "",
    } = options;
    return await this.client.getSocket().sendMessage(this.jid, {
      document: buffer,
      fileName,
      mimetype,
      caption,
    });
  }

  /**
   * Send a voice note. Audio that is not already ogg/opus is transcoded with
   * lib/utils/ffmpeg.js `toOpusVoice` (throws if ffmpeg fails).
   */
  async sendVoice(buffer, options = {}) {
    let audio = buffer;
    if (sniffAudioMime(buffer) !== "audio/ogg; codecs=opus") {
      const { toOpusVoice } = require("../utils/ffmpeg");
      audio = await toOpusVoice(buffer);
    }
    return await this.client.getSocket().sendMessage(this.jid, {
      audio,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
      ...options,
    });
  }

  /**
   * Get media type from message
   */
  getMediaType() {
    const msg = this.data.message;
    if (!msg) return null;

    const content = extractMessageContent(msg);
    const type = getContentType(content);

    return MEDIA_TYPES[type] || null;
  }

  /**
   * Check if message contains specific media type
   */
  hasMediaType(type) {
    return this.getMediaType() === type;
  }

  /**
   * Get file extension from media message
   */
  getMediaExtension() {
    const msg = this.data.message;
    if (!msg) return null;

    const content = extractMessageContent(msg);
    const mediaContent = content?.[this.type];

    if (mediaContent?.mimetype) {
      const mimeToExt = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/3gpp": "3gp",
        "audio/mpeg": "mp3",
        "audio/ogg": "ogg",
        "audio/mp4": "m4a",
        "application/pdf": "pdf",
        "application/zip": "zip",
      };
      return mimeToExt[mediaContent.mimetype] || null;
    }

    return null;
  }

  /**
   * Send a poll (for newer WhatsApp versions)
   */
  async sendPoll(name, values, options = {}) {
    return await this.client.getSocket().sendMessage(this.jid, {
      poll: {
        name,
        values,
        selectableCount: options.selectableCount || 1,
      },
    });
  }

  /**
   * Send a location message
   */
  async sendLocation(latitude, longitude, caption = "") {
    return await this.client.getSocket().sendMessage(this.jid, {
      location: { degreesLatitude: latitude, degreesLongitude: longitude },
      caption,
    });
  }

  /**
   * Send a contact card
   */
  async sendContact(contacts) {
    return await this.client.getSocket().sendMessage(this.jid, {
      contacts: { displayName: contacts[0].displayName, contacts },
    });
  }
}

module.exports = { Message, invalidateGroupMetadata, sniffAudioMime };
