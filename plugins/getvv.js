const { getLang } = require("../lib/utils/language");
const { ViewOnce } = require("../lib/database");
const config = require("../config");

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
    const settings = await ViewOnce.findOne({ where: { id: 1 } });

    if (!settings || !settings.enabled || settings.vvMode === "null") {
      return await message.reply(getLang("plugins.viewonce.not_set", config.PREFIX));
    }

    const modeText =
      settings.vvMode === "p"
        ? getLang("plugins.viewonce.mode_private")
        : settings.vvMode === "g"
          ? getLang("plugins.viewonce.mode_group")
          : settings.vvMode === "jid"
            ? getLang("plugins.viewonce.mode_jid", settings.vvJid)
            : getLang("plugins.viewonce.mode_disabled");

    return await message.reply(
      getLang("plugins.viewonce.status", getLang("plugins.viewonce.status_enabled"), modeText),
    );
  },
};
