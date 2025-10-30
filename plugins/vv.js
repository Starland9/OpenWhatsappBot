const { getLang } = require("../lib/utils/language");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");

/**
 * View Once Viewer - Download and forward view once messages
 */
module.exports = {
  command: {
    pattern: "vv|viewonce",
    desc: getLang("plugins.viewonce.desc"),
    type: "media",
  },

  async execute(message, query) {
    try {
      // Vérifier si c'est une réponse à un message
      if (!message.quoted) {
        return await message.reply(getLang("plugins.viewonce.reply_required"));
      }

      await message.react("⏳");

      // Récupérer le message cité - structure réelle
      const quotedMsg = message.quoted.message;

      if (!quotedMsg) {
        await message.react("❌");
        return await message.reply(getLang("plugins.viewonce.no_message"));
      }

      // Détecter le type de média directement (la structure montre que viewOnce est une propriété du média)
      let mediaMessage = null;
      let messageType = null;

      // Vérifier imageMessage avec viewOnce: true
      if (quotedMsg.imageMessage?.viewOnce) {
        mediaMessage = quotedMsg.imageMessage;
        messageType = "image";
      }
      // Vérifier videoMessage avec viewOnce: true
      else if (quotedMsg.videoMessage?.viewOnce) {
        mediaMessage = quotedMsg.videoMessage;
        messageType = "video";
      }
      // Vérifier audioMessage avec viewOnce: true
      else if (quotedMsg.audioMessage?.viewOnce) {
        mediaMessage = quotedMsg.audioMessage;
        messageType = "audio";
      }
      // Support ancienne structure viewOnceMessage (rétrocompatibilité)
      else if (quotedMsg.viewOnceMessage) {
        const viewOnceMsg = quotedMsg.viewOnceMessage.message;
        if (viewOnceMsg.imageMessage) {
          mediaMessage = viewOnceMsg.imageMessage;
          messageType = "image";
        } else if (viewOnceMsg.videoMessage) {
          mediaMessage = viewOnceMsg.videoMessage;
          messageType = "video";
        } else if (viewOnceMsg.audioMessage) {
          mediaMessage = viewOnceMsg.audioMessage;
          messageType = "audio";
        }
      }
      // Support viewOnceMessageV2
      else if (quotedMsg.viewOnceMessageV2) {
        const viewOnceMsg = quotedMsg.viewOnceMessageV2.message;
        if (viewOnceMsg.imageMessage) {
          mediaMessage = viewOnceMsg.imageMessage;
          messageType = "image";
        } else if (viewOnceMsg.videoMessage) {
          mediaMessage = viewOnceMsg.videoMessage;
          messageType = "video";
        } else if (viewOnceMsg.audioMessage) {
          mediaMessage = viewOnceMsg.audioMessage;
          messageType = "audio";
        }
      }

      if (!mediaMessage || !messageType) {
        await message.react("❌");
        return await message.reply(getLang("plugins.viewonce.not_viewonce"));
      }

      // Télécharger le média en utilisant la structure correcte
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
        return await message.reply(getLang("plugins.viewonce.download_failed"));
      }

      // Extraire la caption si présente
      const caption =
        mediaMessage.caption || getLang("plugins.viewonce.forwarded");

      // Envoyer le média selon son type
      if (messageType === "image") {
        await message.sendImage(buffer, caption);
      } else if (messageType === "video") {
        await message.sendVideo(buffer, caption);
      } else if (messageType === "audio") {
        await message.sendAudio(buffer, {
          mimetype: mediaMessage.mimetype || "audio/mp4",
          ptt: mediaMessage.ptt || false,
        });
      }

      await message.react("✅");
    } catch (error) {
      await message.react("❌");
      console.error("ViewOnce error:", error);
      await message.reply(
        getLang("plugins.viewonce.error") + `: ${error.message}`
      );
    }
  },
};
