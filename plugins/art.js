const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Dessins ASCII du thème.
 *   .art              → liste des dessins
 *   .art <nom>        → skull, ghost, eye, warning
 */

const NAMES = Object.keys(glyphs.ART);

module.exports = {
  command: {
    pattern: "art|dessin",
    desc: getLang("plugins.art.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const name = String(argsString || "").trim().toLowerCase();

    if (!name) {
      const list = NAMES.map((n) => `  ▸ ${n} — ${getLang(`plugins.art.name_${n}`)}`).join("\n");
      return await message.reply(getLang("plugins.art.list", list));
    }

    const drawing = glyphs.art(name);
    if (!drawing) return await message.reply(getLang("plugins.art.unknown", NAMES.join(", ")));

    await message.reply(`\`\`\`\n${drawing}\n\`\`\``);
  },

  NAMES,
};
