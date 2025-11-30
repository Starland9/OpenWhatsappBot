const { getLang } = require("../lib/utils/language");
const { AntiDelete } = require("../lib/database");

/**
 * Get current Anti-Delete settings
 */
module.exports = {
  command: {
    pattern: "getantidelete",
    desc: getLang("plugins.antidelete.getantidel_desc"),
    type: "whatsapp",
    fromMe: true,
  },

  async execute(message) {
    try {
      // Get settings
      const settings = await AntiDelete.findOne({ where: { id: 1 } });

      if (!settings || !settings.enabled || settings.antiDelMode === "null") {
        return await message.reply(getLang("plugins.antidelete.not_set"));
      }

      // Determine mode text
      let modeText;
      const mode = settings.antiDelMode;

      if (mode === "p") {
        modeText = getLang("plugins.antidelete.mode_private");
      } else if (mode === "g") {
        modeText = getLang("plugins.antidelete.mode_group");
      } else if (mode === "sudo") {
        modeText = getLang("plugins.antidelete.mode_sudo");
      } else if (mode === "jid") {
        modeText = getLang("plugins.antidelete.mode_jid").replace(
          "{0}",
          settings.antiDelJid
        );
      } else {
        modeText = getLang("plugins.antidelete.mode_disabled");
      }

      const statusText = settings.enabled
        ? getLang("plugins.antidelete.status_enabled")
        : getLang("plugins.antidelete.status_disabled");

      await message.react("ℹ️");
      return await message.reply(
        getLang("plugins.antidelete.status")
          .replace("{0}", statusText)
          .replace("{1}", modeText)
      );
    } catch (error) {
      await message.react("❌");
      console.error("Get AntiDelete error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
