const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Mot de passe généré, avec entropie affichée.
 *   .pass              → 20 caractères
 *   .pass <n>          → 8 à 64 caractères
 */

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;
const DEFAULT_LENGTH = 20;

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%&*?+-=~^";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

/** Entropie en bits : longueur × log2(taille de l'alphabet) */
function entropy(length) {
  return Math.round(length * Math.log2(ALL.length));
}

function generate(length, seed = Date.now()) {
  const random = glyphs.rng(seed);
  const chars = [
    random.pick(Array.from(LOWER)),
    random.pick(Array.from(UPPER)),
    random.pick(Array.from(DIGITS)),
    random.pick(Array.from(SYMBOLS)),
  ];
  while (chars.length < length) chars.push(random.pick(Array.from(ALL)));
  // Mélange de Fisher-Yates
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random.int(0, i);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

module.exports = {
  command: {
    pattern: "pass|password|motdepasse",
    desc: getLang("plugins.pass.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const asked = parseInt(String(argsString || "").trim(), 10);
    const length = Number.isFinite(asked)
      ? Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, asked))
      : DEFAULT_LENGTH;

    const password = generate(length);
    const bits = entropy(length);
    const strength = Math.min(1, bits / 128);

    const lines = [
      getLang("plugins.pass.value", password),
      "",
      getLang("plugins.pass.entropy", bits),
      getLang("plugins.pass.strength", glyphs.bar(strength, 12)),
    ];

    await message.react("🔑");
    await message.reply(glyphs.frame(lines, { style: "heavy", title: getLang("plugins.pass.title") }));
  },

  generate,
  entropy,
};
