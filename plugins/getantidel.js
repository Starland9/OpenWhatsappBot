const { getLang } = require("../lib/utils/language");
const { AntiDelete } = require("../lib/database");
const config = require("../config");

/**
 * Get current Anti-Delete settings
 */
module.exports = {
  command: {
    pattern: "getantidelete|getantidel",
    desc: getLang("plugins.antidelete.getantidel_desc"),
    type: "whatsapp",
    fromMe: true,
  },

  async execute(message) {
    const settings = await AntiDelete.findOne({ where: { id: 1 } });

    if (!settings || !settings.enabled || settings.antiDelMode === "null") {
      return await message.reply(getLang("plugins.antidelete.not_set", config.PREFIX));
    }

    // Determine mode text
    const mode = settings.antiDelMode;
    let modeText;
    if (mode === "p") {
      modeText = getLang("plugins.antidelete.mode_private");
    } else if (mode === "g") {
      modeText = getLang("plugins.antidelete.mode_group");
    } else if (mode === "sudo") {
      modeText = getLang("plugins.antidelete.mode_sudo");
    } else if (mode === "jid") {
      modeText = getLang("plugins.antidelete.mode_jid", settings.antiDelJid);
    } else {
      modeText = getLang("plugins.antidelete.mode_disabled");
    }

    await message.react("ℹ️");
    return await message.reply(
      getLang("plugins.antidelete.status", getLang("plugins.antidelete.status_enabled"), modeText),
    );
  },
};
