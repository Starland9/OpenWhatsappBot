const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Pluie de caractères, façon écran cathodique.
 *   .matrix          → 12 lignes
 *   .matrix <n>      → 6 à 24 lignes
 */

const MIN_LINES = 6;
const MAX_LINES = 24;
const DEFAULT_LINES = 12;
const WIDTH = 22;
const RAIN = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789$#%&@";

function rain(seed, lines) {
  const random = glyphs.rng(seed);
  const out = [];
  for (let i = 0; i < lines; i++) {
    const width = random.int(8, WIDTH);
    let row = "";
    for (let c = 0; c < width; c++) row += random.pick(Array.from(RAIN));
    out.push(row);
  }
  return out;
}

module.exports = {
  command: {
    pattern: "matrix|rain",
    desc: getLang("plugins.matrix.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const asked = parseInt(String(argsString || "").trim(), 10);
    const lines = Number.isFinite(asked)
      ? Math.max(MIN_LINES, Math.min(MAX_LINES, asked))
      : DEFAULT_LINES;

    const body = rain(Date.now(), lines).join("\n");
    await message.reply(
      `${glyphs.frame(body.split("\n"), { style: "ascii", title: getLang("plugins.matrix.title") })}\n\n${getLang(
        "plugins.matrix.footer",
        lines,
      )}`,
    );
  },

  rain,
};
