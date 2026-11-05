const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Texte corrompu (zalgo) et texte glitché.
 *   .zalgo <texte>   → texte corrompu
 *   .zalgo 3 <texte> → intensité 1 à 3
 *   .glitch <texte>  → caractères remplacés par du bruit
 */

const MAX_TEXT = 300;
const MAX_INTENSITY = 3;

function splitIntensity(raw) {
  const match = String(raw || "").trim().match(/^([1-3])\s+([\s\S]+)$/);
  if (!match) return { intensity: 1, text: String(raw || "").trim() };
  return { intensity: Number(match[1]), text: match[2].trim() };
}

module.exports = {
  command: {
    pattern: "zalgo|corrupt",
    desc: getLang("plugins.zalgo.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const { intensity, text } = splitIntensity(argsString);
    if (!text) return await message.reply(getLang("plugins.zalgo.usage"));

    const clipped = Array.from(text).slice(0, MAX_TEXT).join("");
    await message.reply(glyphs.zalgo(clipped, Math.min(MAX_INTENSITY, intensity), clipped));
  },

  splitIntensity,
};
