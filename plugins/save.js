const { extractMessageContent, getContentType } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { getOwnerJids, jidUser } = require("../lib/utils/permissions");

const MEDIA_KINDS = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
};

/**
 * Save Status - Download and save status media to inbox
 * Command: .save
 * Reply to a status update to save the media to your inbox
 */
module.exports = {
  command: {
    pattern: "save",
    desc: getLang("plugins.save.desc"),
    type: "media",
    fromMe: true,
  },

  async execute(message) {
    try {
      // Check if this is a reply to a message
      if (!message.quoted) {
        return await message.reply(getLang("plugins.save.reply_required"));
      }

      await message.react("⏳");

      // Get the quoted message
      if (!message.quoted.message) {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_message"));
      }

      // The inbox is the chat of the owner who ran the command
      const inbox = message.sender || message.senderLid || getOwnerJids()[0];
      if (!inbox) {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_sudo"));
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
          await message.react("❌");
          return await message.reply(getLang("plugins.save.download_failed"));
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
          await message.react("❌");
          return await message.reply(getLang("plugins.save.no_media"));
        }
        await sock.sendMessage(inbox, { text: `${header}\n\n${text}`, mentions });
      } else {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_media"));
      }

      await message.react("✅");
    } catch (error) {
      await message.react("❌");
      throw error;
    }
  },
};
