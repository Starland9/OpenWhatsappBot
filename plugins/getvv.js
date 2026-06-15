const { getLang } = require("../lib/utils/language");
const { ViewOnce } = require("../lib/database");

/**
 * Get View-Once forwarding settings
 */
module.exports = {
  command: {
    pattern: "getvv",
    desc: getLang("plugins.viewonce.getvv_desc"),
    type: "whatsapp",
    fromMe: true,
  },

  async execute(message) {
    try {
      const settings = await ViewOnce.findOne({ where: { id: 1 } });

      if (!settings || !settings.enabled || settings.vvMode === "null") {
        return await message.reply(getLang("plugins.viewonce.not_set"));
      }

      const statusText = settings.enabled
        ? getLang("plugins.viewonce.status_enabled")
        : getLang("plugins.viewonce.status_disabled");
      const modeText =
        settings.vvMode === "p"
          ? getLang("plugins.viewonce.mode_private")
          : settings.vvMode === "g"
          ? getLang("plugins.viewonce.mode_group")
          : settings.vvMode === "jid"
          ? getLang("plugins.viewonce.mode_jid").replace("{0}", settings.vvJid)
          : getLang("plugins.viewonce.mode_disabled");

      const statusMsg = getLang("plugins.viewonce.status")
        .replace("{0}", statusText)
        .replace("{1}", modeText);

      return await message.reply(statusMsg);
    } catch (error) {
      await message.react("❌");
      console.error("Get VV error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
