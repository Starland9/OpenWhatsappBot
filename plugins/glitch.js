const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Texte glitché : des caractères sont remplacés par du bruit.
 *   .glitch <texte>
 *   .glitch 0.6 <texte>   → proportion de corruption (0 à 1)
 */

const MAX_TEXT = 300;
const DEFAULT_RATIO = 0.25;

function splitRatio(raw) {
  const match = String(raw || "").trim().match(/^(0?\.\d+|1(?:\.0+)?)\s+([\s\S]+)$/);
  if (!match) return { ratio: DEFAULT_RATIO, text: String(raw || "").trim() };
  return { ratio: Number(match[1]), text: match[2].trim() };
}

module.exports = {
  command: {
    pattern: "glitch|corrupt2",
    desc: getLang("plugins.glitch.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const { ratio, text } = splitRatio(argsString);
    if (!text) return await message.reply(getLang("plugins.glitch.usage"));

    const clipped = Array.from(text).slice(0, MAX_TEXT).join("");
    await message.reply(glyphs.glitch(clipped, ratio, `${clipped}:${Date.now()}`));
  },

  splitRatio,
};
