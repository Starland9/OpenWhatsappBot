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

/**
 * The requester's own address: his phone-number JID (else his LID) in a group, the chat itself in a
 * private chat (whatever its addressing). Never read from the message body.
 */
function requesterJid(message) {
  if (message.isGroup) return message.sender || message.senderLid || "";
  return message.jid || "";
}

/**
 * Where the revealed media goes. The owner keeps the .setvv destination, else the current chat; a
 * delegated requester always gets it himself and never reads the `view_once` setting (FR-015).
 */
async function resolveDestination(message, delegated) {
  if (delegated) return requesterJid(message);

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
 * Tell a delegated requester something in his own DM (best effort): never in the group, and never an
 * error. WhatsApp may refuse a person who never wrote to the bot; he then gets nothing.
 */
async function notifyRequester(message, text) {
  const jid = requesterJid(message);
  if (!jid) return;
  try {
    await message.client.getSocket().sendMessage(jid, { text });
  } catch (error) {
    logger.debug(safeLog(error), "ViewOnce: notice to the requester not delivered");
  }
}

/**
 * View Once Viewer - Download and forward view once messages (owner; delegable from the panel)
 *
 * Discreet on purpose: no reaction, and no reply when the quoted message is
 * not a view-once media or cannot be downloaded. For a delegated requester
 * (a person the panel allowed to run it) nothing is ever posted in the group:
 * the media, the usage text and the too-large notice all go to his own DM.
 */
module.exports = {
  command: {
    pattern: "vv",
    desc: getLang("plugins.viewonce.desc"),
    type: "media",
    fromMe: true,
    delegable: true,
  },

  async execute(message) {
    const delegated = !message.isSudo();
    if (delegated && !requesterJid(message)) return;

    // Nothing quoted: tell the requester how to use it
    if (!message.quoted) {
      const usage = getLang("plugins.vv.usage", config.PREFIX);
      if (delegated) return await notifyRequester(message, usage);
      return await message.reply(usage);
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
      if (error?.code === "MEDIA_TOO_LARGE") {
        // The owner gets the registry's reply in the chat; a delegated requester gets it in his DM
        if (!delegated) throw error;
        const maxMB = error.maxMB || Math.round(Number(config.MAX_UPLOAD) || 230);
        return await notifyRequester(message, getLang("common.media_too_large", maxMB));
      }
      logger.error(safeLog(error), "ViewOnce download error");
      return;
    }
    if (!media) return;

    const targetJid = await resolveDestination(message, delegated);
    const socket = message.client.getSocket();

    try {
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
    } catch (error) {
      // The owner gets common.error (and the stack); a delegated requester never causes a post in the group
      if (!delegated) throw error;
      logger.warn(safeLog(error), "ViewOnce: delegated send failed");
    }
  },
};
