const { getLang } = require("../lib/utils/language");

/**
 * Tag command - Tag all group members
 */
module.exports = {
  command: {
    pattern: "tagall",
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

      // WhatsApp may limit mentions per message or UI may truncate very long messages.
      // Split into chunks to ensure all members are included.
      const CHUNK_SIZE = 50;
      const socket = message.client.getSocket();

      let sentChunks = 0;
      for (let i = 0; i < participants.length; i += CHUNK_SIZE) {
        const chunk = participants.slice(i, i + CHUNK_SIZE);

        // Build a mention string using bare numbers so WhatsApp resolves them.
        const mentionText = chunk
          .map((jid) => `@${jid.split("@")[0]}`)
          .join(" ");

        try {
          if (!socket || typeof socket.sendMessage !== "function") {
            console.error("Tag: socket unavailable");
            await message.reply(
              "❌ Socket indisponible pour envoyer les mentions",
            );
            return;
          }
          await socket.sendMessage(message.jid, {
            text: `${messageText}\n\n${mentionText}`,
            mentions: chunk,
          });
          sentChunks++;
        } catch (err) {
          console.error("Failed to send tag chunk:", err);
        }
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
