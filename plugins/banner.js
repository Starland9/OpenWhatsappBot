const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Bannière en grosses lettres de blocs.
 *   .banner <texte>   → 5 lignes de blocs
 */

const MAX_TEXT = 24;

module.exports = {
  command: {
    pattern: "banner|ascii",
    desc: getLang("plugins.banner.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const text = String(argsString || "").trim();
    if (!text) return await message.reply(getLang("plugins.banner.usage"));

    const clipped = Array.from(text).slice(0, MAX_TEXT).join("");
    await message.reply(`\`\`\`\n${glyphs.banner(clipped)}\n\`\`\``);
  },
};
