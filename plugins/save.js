const { extractMessageContent, getContentType } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { jidUser } = require("../lib/utils/permissions");
const { safeLog } = require("../lib/utils/http");
const config = require("../config");

const logger = require("../lib/utils/logger").createLogger("save");

const MEDIA_KINDS = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
};

/**
 * The requester's own address: his phone-number JID (else his LID) in a group, the chat itself in a
 * private chat (whatever its addressing). Same rule as `.vv`. Never read from the message body.
 */
function requesterJid(message) {
  if (message.isGroup) return message.sender || message.senderLid || "";
  return message.jid || "";
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
    logger.debug(safeLog(error), "Save: notice to the requester not delivered");
  }
}

/**
 * Save Status - Download and save status media to inbox
 * Command: .save
 * Reply to a status update to save the media to your inbox
 *
 * The owner gets reactions and replies in the chat. A delegated requester (a person the panel allowed
 * to run it) is treated as discreetly as `.vv`: nothing is ever posted in the chat where he typed the
 * command, no reaction and no text. The media and every text (usage, errors, too-large notice) go to
 * his own DM, best effort, and a failure is swallowed.
 */
module.exports = {
  command: {
    pattern: "save",
    desc: getLang("plugins.save.desc"),
    type: "media",
    fromMe: true,
    delegable: true,
  },

  async execute(message) {
    const delegated = !message.isSudo();
    // Nobody to tell, and nowhere to post: end in silence
    if (delegated && !requesterJid(message)) return;

    // The owner reacts and replies in the chat; a delegated requester gets no reaction and his texts in his DM
    const react = async (emoji) => {
      if (!delegated) await message.react(emoji);
    };
    const say = async (text) =>
      delegated ? await notifyRequester(message, text) : await message.reply(text);

    try {
      // Check if this is a reply to a message
      if (!message.quoted) {
        return await say(getLang("plugins.save.reply_required"));
      }

      await react("⏳");

      // Get the quoted message
      if (!message.quoted.message) {
        await react("❌");
        return await say(getLang("plugins.save.no_message"));
      }

      // The inbox is the chat of whoever ran the command (the owner, or a person the panel delegated
      // `.save` to). No fallback to an owner: a delegated person's media must never reach somebody else
      const inbox = message.sender || message.senderLid;
      if (!inbox) {
        await react("❌");
        return await say(getLang("plugins.save.no_sudo"));
      }

      // Extract message content (handles view-once and ephemeral wrappers)
      const content = extractMessageContent(message.quoted.message);
      const type = getContentType(content);
      const sock = message.client.getSocket();

      const author = message.quoted.sender || "";
      const header = getLang("plugins.save.header", jidUser(author) || "?");
      const mentions = author ? [author] : [];

      if (MEDIA_KINDS[type]) {
        const kind = MEDIA_KINDS[type];
        const info = content[type] || {};

        // Size guard and download of the quoted media (throws MEDIA_TOO_LARGE)
        const media = await message.getQuotedMedia();
        if (!media) {
          await react("❌");
          return await say(getLang("plugins.save.download_failed"));
        }

        if (kind === "audio") {
          // Audio has no caption: send the header first
          await sock.sendMessage(inbox, { text: header, mentions });
          await sock.sendMessage(inbox, {
            audio: media.buffer,
            mimetype: media.mimetype || "audio/mp4",
            ptt: !!info.ptt,
          });
        } else {
          const caption = info.caption ? `${header}\n\n${info.caption}` : header;
          await sock.sendMessage(inbox, { [kind]: media.buffer, caption, mentions });
        }
      } else if (type === "extendedTextMessage" || type === "conversation") {
        // Text-only status
        const text = message.getQuotedText();
        if (!text) {
          await react("❌");
          return await say(getLang("plugins.save.no_media"));
        }
        await sock.sendMessage(inbox, { text: `${header}\n\n${text}`, mentions });
      } else {
        await react("❌");
        return await say(getLang("plugins.save.no_media"));
      }

      await react("✅");
    } catch (error) {
      // The owner gets the cross, then common.error (and the stack) from the registry
      if (!delegated) {
        await message.react("❌");
        throw error;
      }
      // A delegated requester never causes a post in the group: the too-large notice goes to his DM,
      // anything else is only logged
      if (error?.code === "MEDIA_TOO_LARGE") {
        const maxMB = error.maxMB || Math.round(Number(config.MAX_UPLOAD) || 230);
        return await notifyRequester(message, getLang("common.media_too_large", maxMB));
      }
      logger.warn(safeLog(error), "Save: delegated run failed");
    }
  },
};
