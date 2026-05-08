const { getLang } = require("../lib/utils/language");
const { AntiDelete } = require("../lib/database");

/**
 * Set Anti-Delete message forwarding settings
 */
module.exports = {
  command: {
    pattern: "antidelete",
    desc: getLang("plugins.antidelete.desc"),
    type: "whatsapp",
    fromMe: true,
  },

  async execute(message, query) {
    try {
      if (!query) {
        return await message.reply(getLang("plugins.antidelete.usage"));
      }

      const mode = query.trim().toLowerCase();

      // Helper function to validate JID format
      const isValidJid = (jid) => {
        // WhatsApp JID format: identifier@s.whatsapp.net or identifier@g.us
        const jidRegex = /^[^@]+@(s\.whatsapp\.net|g\.us)$/;
        return jidRegex.test(jid);
      };

      // Validate mode
      if (!["g", "p", "sudo", "null", "false"].includes(mode)) {
        // Check if it's a JID
        if (!isValidJid(mode)) {
          return await message.reply(getLang("plugins.antidelete.usage"));
        }
      }

      // Get or create settings
      let settings = await AntiDelete.findOne({ where: { id: 1 } });
      if (!settings) {
        settings = await AntiDelete.create({ id: 1 });
      }

      // Handle disable
      if (mode === "null" || mode === "false") {
        await settings.update({
          antiDelMode: "null",
          antiDelJid: null,
          enabled: false,
        });
        await message.react("✅");
        return await message.reply(getLang("plugins.antidelete.disabled"));
      }

      // Handle JID mode
      if (isValidJid(mode)) {
        await settings.update({
          antiDelMode: "jid",
          antiDelJid: mode,
          enabled: true,
        });
      } else {
        await settings.update({
          antiDelMode: mode,
          antiDelJid: null,
          enabled: true,
        });
      }

      await message.react("✅");
      const modeText =
        mode === "p"
          ? getLang("plugins.antidelete.mode_private")
          : mode === "g"
          ? getLang("plugins.antidelete.mode_group")
          : mode === "sudo"
          ? getLang("plugins.antidelete.mode_sudo")
          : getLang("plugins.antidelete.mode_jid").replace("{0}", mode);

      return await message.reply(
        getLang("plugins.antidelete.updated").replace("{0}", modeText)
      );
    } catch (error) {
      await message.react("❌");
      console.error("Set AntiDelete error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
