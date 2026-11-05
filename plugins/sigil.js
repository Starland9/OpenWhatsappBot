const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Sceau occulte tiré au sort.
 *   .sigil          → sceau du moment
 *   .sigil <texte>  → sceau stable pour ce texte
 */

const MAX_SEED_TEXT = 60;

module.exports = {
  command: {
    pattern: "sigil|sceau|rune",
    desc: getLang("plugins.sigil.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const seed = String(argsString || "").trim().slice(0, MAX_SEED_TEXT) || String(Date.now());
    const lines = [
      glyphs.sigil(seed),
      "",
      getLang("plugins.sigil.caption", glyphs.smallCaps(seed.slice(0, 24))),
    ];
    await message.react("⛧");
    await message.reply(glyphs.frame(lines, { style: "double", title: getLang("plugins.sigil.title") }));
  },
};
