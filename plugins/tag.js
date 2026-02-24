const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { extractMessageContent, getContentType } = require("baileys");
const { downloadMedia } = require("../lib/baileys/mediaAdapter");
const FileType = require("file-type");

/**
 * Tag command - Tag all group members
 */
module.exports = {
  command: {
    pattern: "tag|tagall",
    desc: getLang("plugins.tag.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, text) {
    if (!message.isGroup) {
      return await message.reply(getLang("extra.group_cmd"));
    }

    // Check if sender is admin
    const isSenderAdmin = await message.isSenderAdmin();
    if (!isSenderAdmin && !message.isSudo()) {
      return await message.reply(getLang("plugins.common.not_admin"));
    }

    try {
      const metadata = await message.getGroupMetadata();

      if (!metadata) {
        return await message.reply("❌ Failed to get group information");
      }

      const participants = (metadata.participants || []).map((p) => p.id);
      const messageText = text || "📢 *Group Tagall*";

      console.log(`Tag: group=${message.jid} members=${participants.length}`);

      if (participants.length === 0) {
        await message.reply("❌ Aucun participant trouvé dans le groupe");
        return;
      }

      // WhatsApp may limit mentions per message. Use chunking for mentions.
      const CHUNK_SIZE = 50;
      const socket = message.client.getSocket();

      let sentChunks = 0;

      // Determine invoked command to support special-case `tag` behavior
      const prefix = config.PREFIX || ".";
      const invoked = message.body
        .slice(prefix.length)
        .trim()
        .split(/\s+/)[0]
        .toLowerCase();

      // If user invoked `tag` (not tagall) and replied to a message, resend the quoted
      // message content (text or media) and alert everyone via mentions without listing names.
      if (invoked === "tag" && message.quoted) {
        // Build quoted message object for reference (not strictly required when resending)
        const quotedObj = {
          key: {
            remoteJid: message.jid,
            id: message.quoted.id,
            participant: message.quoted.sender,
          },
          message: message.quoted.message,
        };

        // Send the quoted content in chunks so all participants are notified.
        for (let i = 0; i < participants.length; i += CHUNK_SIZE) {
          const chunk = participants.slice(i, i + CHUNK_SIZE);

          try {
            if (!socket || typeof socket.sendMessage !== "function") {
              console.error("Tag: socket unavailable");
              await message.reply(
                "❌ Socket indisponible pour envoyer les mentions",
              );
              return;
            }

            // Inspect quoted content type
            const quotedContent = message.quoted.message;
            const content = extractMessageContent(quotedContent);
            const qType = getContentType(content);

            if (qType === "conversation" || qType === "extendedTextMessage") {
              // Extract text from quoted
              const qMsg = content[qType];
              const qText =
                qMsg?.text ||
                qMsg?.contextInfo?.text ||
                qMsg?.conversation ||
                "";
              await socket.sendMessage(message.jid, {
                text: qText,
                mentions: chunk,
              });
            } else {
              // Assume media message (image/video/audio/sticker/document)
              // Attempt to download the quoted media
              const buffer = await downloadMedia(socket, {
                message: quotedContent,
              });
              if (!buffer) {
                // Fallback: send a small alert quoting the original
                await socket.sendMessage(
                  message.jid,
                  { text: messageText, mentions: chunk },
                  { quoted: quotedObj },
                );
              } else {
                const ft = await FileType.fromBuffer(buffer).catch(() => null);
                const mime =
                  ft?.mime ||
                  quotedContent[qType]?.mimetype ||
                  "application/octet-stream";

                // Map to proper send field
                if (qType === "imageMessage") {
                  await socket.sendMessage(message.jid, {
                    image: buffer,
                    mimetype: mime,
                    caption: "",
                    mentions: chunk,
                  });
                } else if (qType === "videoMessage") {
                  await socket.sendMessage(message.jid, {
                    video: buffer,
                    mimetype: mime,
                    caption: "",
                    mentions: chunk,
                  });
                } else if (qType === "audioMessage") {
                  await socket.sendMessage(message.jid, {
                    audio: buffer,
                    mimetype: mime,
                    ptt: false,
                    mentions: chunk,
                  });
                } else if (qType === "stickerMessage") {
                  await socket.sendMessage(message.jid, {
                    sticker: buffer,
                    mentions: chunk,
                  });
                } else {
                  await socket.sendMessage(message.jid, {
                    document: buffer,
                    fileName: `file.${ft?.ext || "bin"}`,
                    mimetype: mime,
                    caption: "",
                    mentions: chunk,
                  });
                }
              }
            }

            sentChunks++;
          } catch (err) {
            console.error("Failed to send tag chunk:", err);
          }
        }

        await message.reply(
          `✅ Alerted ${participants.length} membres en ${sentChunks} messages (mode silencieux)`,
        );
        return;
      }
      // // Provide feedback
      // await message.reply(
      //   `✅ Mentionné ${participants.length} membres en ${sentChunks} messages`,
      // );
    } catch (error) {
      console.error("Tag error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
