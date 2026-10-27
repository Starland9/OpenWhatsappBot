const pino = require("pino");
const { extractMessageContent } = require("baileys");
const { downloadMedia } = require("../baileys/mediaAdapter");
const statusListStore = require("./statusListStore");
const { getOwnerJids, jidUser, isPnJid } = require("./permissions");
const { getLang } = require("./language");
const config = require("../../config");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const MEDIA_KEYS = [
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "stickerMessage",
  "documentMessage",
];

function extFromMime(mime) {
  if (!mime) return "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mp3")) return "mp3";
  return mime.split("/").pop() || "bin";
}

/** Declared size of a media message, in bytes (Long, number or string) */
function declaredSize(media) {
  const raw = media?.fileLength;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "object" && typeof raw.toNumber === "function") return raw.toNumber();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Message payload for the detected media kind */
function buildPayload({ mediaKey, mime, buffer, caption, fileName }) {
  switch (mediaKey) {
    case "stickerMessage":
      return { sticker: buffer };
    case "imageMessage":
      return { image: buffer, caption };
    case "videoMessage":
      return { video: buffer, caption, mimetype: mime || undefined };
    case "audioMessage":
      return { audio: buffer, mimetype: mime || undefined };
    default:
      return {
        document: buffer,
        fileName,
        mimetype: mime || "application/octet-stream",
      };
  }
}

/**
 * Forward the media of a contact's status to the first owner when auto-save is
 * on and the author is in the watch list (an empty list means every contact).
 * @param {object} msg - raw Baileys message from status@broadcast
 * @param {object} client - WhatsAppClient
 * @returns {Promise<boolean>} true when the status was forwarded
 */
async function handleStatus(msg, client) {
  try {
    // Our own statuses are not worth saving
    if (msg?.key?.fromMe) return false;

    const cfg = await statusListStore.get();
    if (!cfg.active) return false;

    // Author: LID addressing puts the phone number in participantAlt, PN
    // addressing puts it in participant. Match the watch list against both.
    const participants = [msg?.key?.participant, msg?.key?.participantAlt].filter(Boolean);
    const numbers = [...new Set(participants.map(jidUser).filter(Boolean))];
    if (numbers.length === 0) return false;

    if (cfg.list.length > 0 && !numbers.some((n) => cfg.list.includes(n))) {
      return false; // not in the watch list
    }
    const pnJid = participants.find(isPnJid);
    const senderNumber = (pnJid && jidUser(pnJid)) || numbers[0];

    // Only downloadable media (text statuses, protocol messages... are ignored)
    const content = extractMessageContent(msg.message) || {};
    const mediaKey = MEDIA_KEYS.find((k) => Boolean(content[k]));
    if (!mediaKey) return false;
    const media = content[mediaKey];

    const maxBytes = (Number(config.MAX_UPLOAD) || 230) * 1024 * 1024;
    if (declaredSize(media) > maxBytes) {
      logger.info(`Status from ${senderNumber} is over the size limit, not saved`);
      return false;
    }

    const ownerJid = getOwnerJids()[0];
    if (!ownerJid) return false;

    const sock = client.getSocket();
    const buffer = await downloadMedia(sock, msg);
    if (!buffer || !buffer.length) return false;
    if (buffer.length > maxBytes) return false;

    let mime = media.mimetype || null;
    try {
      // file-type is ESM-only: load it lazily. Content sniffing beats the declared type.
      const { fileTypeFromBuffer } = await import("file-type");
      const detected = await fileTypeFromBuffer(buffer);
      if (detected?.mime) mime = detected.mime;
    } catch (_) {
      // keep the declared mimetype
    }

    const payload = buildPayload({
      mediaKey,
      mime,
      buffer,
      caption: getLang("plugins.statussave.caption", senderNumber),
      fileName: `${senderNumber}_${Date.now()}.${extFromMime(mime)}`,
    });

    await sock.sendMessage(ownerJid, payload);
    logger.debug(`Forwarded status from ${senderNumber} to the owner`);
    return true;
  } catch (error) {
    logger.error({ err: error }, "statusSaver.handleStatus error");
    return false;
  }
}

module.exports = { handleStatus };
