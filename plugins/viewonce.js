const { getLang } = require("../lib/utils/language");
const { ViewOnce } = require("../lib/database");

/**
 * Set View-Once forwarding settings
 */
module.exports = {
  command: {
    pattern: "setvv",
    desc: getLang("plugins.viewonce.setvv_desc"),
    type: "whatsapp",
    fromMe: true,
  },

  async execute(message, query) {
    try {
      if (!query) {
        return await message.reply(getLang("plugins.viewonce.usage"));
      }

      const mode = query.trim().toLowerCase();
      
      // Validate mode
      if (!["g", "p", "null", "false"].includes(mode) && !mode.includes("@")) {
        return await message.reply(getLang("plugins.viewonce.usage"));
      }

      // Get or create settings
      let settings = await ViewOnce.findOne({ where: { id: 1 } });
      if (!settings) {
        settings = await ViewOnce.create({ id: 1 });
      }

      // Handle disable
      if (mode === "null" || mode === "false") {
        await settings.update({ 
          vvMode: "null", 
          vvJid: null,
          enabled: false 
        });
        await message.react("✅");
        return await message.reply(getLang("plugins.viewonce.disabled"));
      }

      // Handle JID mode
      if (mode.includes("@")) {
        await settings.update({ 
          vvMode: "jid", 
          vvJid: mode,
          enabled: true 
        });
      } else {
        await settings.update({ 
          vvMode: mode, 
          vvJid: null,
          enabled: true 
        });
      }

      await message.react("✅");
      const modeText = mode === "p" ? getLang("plugins.viewonce.mode_private")
        : mode === "g" ? getLang("plugins.viewonce.mode_group")
        : getLang("plugins.viewonce.mode_jid").replace("{0}", mode);
      
      return await message.reply(
        getLang("plugins.viewonce.updated").replace("{0}", modeText)
      );
    } catch (error) {
      await message.react("❌");
      console.error("Set VV error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
