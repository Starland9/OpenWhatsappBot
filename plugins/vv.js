const { extractMessageContent, getContentType } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { ViewOnce } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const viewOnceHandler = require("../lib/utils/viewOnceHandler");
const { getOwnerJids } = require("../lib/utils/permissions");
const { safeLog } = require("../lib/utils/http");
const config = require("../config");

const logger = require("../lib/utils/logger").createLogger("vv");

const KINDS = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
};

/** Where the revealed media goes: the .setvv destination, else the current chat */
async function resolveDestination(message) {
  const settings = await settingsCache.get("view_once", async () => {
    return await ViewOnce.findOne({ where: { id: 1 } });
  });

  if (settings && settings.enabled) {
    if (settings.vvMode === "p") return getOwnerJids()[0] || message.jid;
    if (settings.vvMode === "jid" && settings.vvJid) return settings.vvJid;
  }
  return message.jid;
}

/**
 * View Once Viewer - Download and forward view once messages (owner only)
 *
 * Discreet on purpose: no reaction, and no reply when the quoted message is
 * not a view-once media or cannot be downloaded.
 */
module.exports = {
  command: {
    pattern: "vv",
    desc: getLang("plugins.viewonce.desc"),
    type: "media",
    fromMe: true,
  },

  async execute(message) {
    // Nothing quoted: tell the owner how to use it
    if (!message.quoted) {
      return await message.reply(getLang("plugins.vv.usage", config.PREFIX));
    }

    const quotedMsg = message.quoted.message;
    if (!quotedMsg || !viewOnceHandler.isViewOnce(quotedMsg)) return;

    // Unwrapped content (viewOnceMessage, V2, V2Extension, ephemeral...)
    const content = extractMessageContent(quotedMsg);
    const messageType = getContentType(content);
    const kind = KINDS[messageType];
    if (!kind) return;
    const mediaMessage = content[messageType];

    let media;
    try {
      // Size cap (MAX_UPLOAD) is checked before the download
      media = await message.getQuotedMedia();
    } catch (error) {
      if (error?.code === "MEDIA_TOO_LARGE") throw error;
      logger.error(safeLog(error), "ViewOnce download error");
      return;
    }
    if (!media) return;

    const targetJid = await resolveDestination(message);
    const socket = message.client.getSocket();

    if (kind === "audio") {
      await socket.sendMessage(targetJid, {
        audio: media.buffer,
        mimetype: media.mimetype || "audio/mp4",
        ptt: !!mediaMessage.ptt,
      });
    } else {
      const caption = mediaMessage.caption || getLang("plugins.viewonce.forwarded");
      await socket.sendMessage(targetJid, { [kind]: media.buffer, caption });
    }
  },
};
