const { getLang } = require("../lib/utils/language");
const {
  downloadMediaMessage,
  extractMessageContent,
  getContentType,
} = require("@whiskeysockets/baileys");
const config = require("../config");

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

  async execute(message, query) {
    try {
      // Check if this is a reply to a message
      if (!message.quoted) {
        return await message.reply(getLang("plugins.save.reply_required"));
      }

      await message.react("⏳");

      // Get the quoted message
      const quotedMsg = message.quoted.message;

      if (!quotedMsg) {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_message"));
      }

      // Extract message content (handles various message structures)
      const content = extractMessageContent(quotedMsg);
      const msgType = getContentType(content);

      if (!content || !msgType) {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_media"));
      }

      // Determine media type and get the message content
      let mediaMessage = null;
      let messageType = null;
      let caption = "";

      // Check for direct media messages
      if (msgType === "imageMessage" && content.imageMessage) {
        mediaMessage = content.imageMessage;
        messageType = "image";
        caption = content.imageMessage.caption || "";
      } else if (msgType === "videoMessage" && content.videoMessage) {
        mediaMessage = content.videoMessage;
        messageType = "video";
        caption = content.videoMessage.caption || "";
      } else if (msgType === "audioMessage" && content.audioMessage) {
        mediaMessage = content.audioMessage;
        messageType = "audio";
      } else if (
        msgType === "extendedTextMessage" &&
        content.extendedTextMessage
      ) {
        // Handle text-only status
        const text = content.extendedTextMessage.text || "";
        if (text) {
          // Get sudo's JID for inbox
          const sudoNumber = config.SUDO.split(",")[0].trim();
          if (!sudoNumber) {
            await message.react("❌");
            return await message.reply(getLang("plugins.save.no_sudo"));
          }

          const targetJid = sudoNumber.includes("@")
            ? sudoNumber
            : `${sudoNumber}@s.whatsapp.net`;

          // Send text status to inbox
          const sender = message.quoted.sender || "Unknown";
          const senderNumber = sender.split("@")[0];
          const statusText =
            `📱 *${getLang("plugins.save.status_from")}:* @${senderNumber}\n\n` +
            `${text}`;

          await message.client.getSocket().sendMessage(targetJid, {
            text: statusText,
            mentions: [sender],
          });

          await message.react("✅");
          return await message.reply(getLang("plugins.save.saved"));
        }
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_media"));
      } else {
        // Check for view-once in status (viewOnce property)
        if (content.imageMessage?.viewOnce) {
          mediaMessage = content.imageMessage;
          messageType = "image";
          caption = content.imageMessage.caption || "";
        } else if (content.videoMessage?.viewOnce) {
          mediaMessage = content.videoMessage;
          messageType = "video";
          caption = content.videoMessage.caption || "";
        } else if (content.audioMessage?.viewOnce) {
          mediaMessage = content.audioMessage;
          messageType = "audio";
        }
        // Check legacy viewOnceMessage structure
        else if (content.viewOnceMessage) {
          const viewOnceMsg = content.viewOnceMessage.message;
          if (viewOnceMsg?.imageMessage) {
            mediaMessage = viewOnceMsg.imageMessage;
            messageType = "image";
            caption = viewOnceMsg.imageMessage.caption || "";
          } else if (viewOnceMsg?.videoMessage) {
            mediaMessage = viewOnceMsg.videoMessage;
            messageType = "video";
            caption = viewOnceMsg.videoMessage.caption || "";
          } else if (viewOnceMsg?.audioMessage) {
            mediaMessage = viewOnceMsg.audioMessage;
            messageType = "audio";
          }
        }
        // Check viewOnceMessageV2 structure
        else if (content.viewOnceMessageV2) {
          const viewOnceMsg = content.viewOnceMessageV2.message;
          if (viewOnceMsg?.imageMessage) {
            mediaMessage = viewOnceMsg.imageMessage;
            messageType = "image";
            caption = viewOnceMsg.imageMessage.caption || "";
          } else if (viewOnceMsg?.videoMessage) {
            mediaMessage = viewOnceMsg.videoMessage;
            messageType = "video";
            caption = viewOnceMsg.videoMessage.caption || "";
          } else if (viewOnceMsg?.audioMessage) {
            mediaMessage = viewOnceMsg.audioMessage;
            messageType = "audio";
          }
        }
      }

      if (!mediaMessage || !messageType) {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_media"));
      }

      // Download the media using the correct message structure
      const buffer = await downloadMediaMessage(
        {
          key: message.quoted.key,
          message: { [messageType + "Message"]: mediaMessage },
        },
        "buffer",
        {},
        {
          logger: { info() {}, error() {}, warn() {} },
          reuploadRequest: message.client.getSocket().updateMediaMessage,
        }
      );

      if (!buffer) {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.download_failed"));
      }

      // Get sudo's JID for inbox
      const sudoNumber = config.SUDO.split(",")[0].trim();
      if (!sudoNumber) {
        await message.react("❌");
        return await message.reply(getLang("plugins.save.no_sudo"));
      }

      const targetJid = sudoNumber.includes("@")
        ? sudoNumber
        : `${sudoNumber}@s.whatsapp.net`;

      // Prepare caption with sender info
      const sender = message.quoted.sender || "Unknown";
      const senderNumber = sender.split("@")[0];
      const finalCaption =
        `📱 *${getLang("plugins.save.status_from")}:* @${senderNumber}\n` +
        (caption ? `\n${caption}` : "");

      const socket = message.client.getSocket();

      // Send media to inbox based on type
      if (messageType === "image") {
        await socket.sendMessage(targetJid, {
          image: buffer,
          caption: finalCaption,
          mentions: [sender],
        });
      } else if (messageType === "video") {
        await socket.sendMessage(targetJid, {
          video: buffer,
          caption: finalCaption,
          mentions: [sender],
        });
      } else if (messageType === "audio") {
        // Send audio with info message
        await socket.sendMessage(targetJid, {
          text: `📱 *${getLang("plugins.save.status_from")}:* @${senderNumber}`,
          mentions: [sender],
        });
        await socket.sendMessage(targetJid, {
          audio: buffer,
          mimetype: mediaMessage.mimetype || "audio/mp4",
          ptt: mediaMessage.ptt || false,
        });
      }

      await message.react("✅");
      await message.reply(getLang("plugins.save.saved"));
    } catch (error) {
      await message.react("❌");
      console.error("Save status error:", error);
      await message.reply(
        getLang("plugins.save.error").replace("{0}", error.message)
      );
    }
  },
};
