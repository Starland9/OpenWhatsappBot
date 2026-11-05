const { getLang } = require("../lib/utils/language");
const config = require("../config");
const glyphs = require("../lib/utils/glyphs");

/**
 * Fausse intrusion, jouée en direct.
 *   .hack            → cible aléatoire
 *   .hack <cible>    → cible nommée (le rendu est stable pour une même cible)
 *
 * Rien n'est contacté : tout est généré, mais les étapes, les latences et les
 * ports sont tirés d'une graine dérivée de la cible.
 */

const MAX_TARGET = 40;
const STEPS = 7;

const FALLBACK_TARGETS = [
  "mainframe.local",
  "10.13.37.1",
  "nsa.gov",
  "orbital-relay",
  "sector-7",
];

function cleanTarget(raw) {
  const text = String(raw || "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, MAX_TARGET) : "";
}

function buildRun(target) {
  const random = glyphs.rng(target);
  const lines = [getLang("plugins.hack.banner", glyphs.smallCaps(target))];

  for (let step = 1; step <= STEPS; step++) {
    const ratio = step / STEPS;
    const latency = random.int(3, 480);
    lines.push(
      getLang(
        "plugins.hack.step",
        glyphs.bar(ratio, 10),
        Math.round(ratio * 100),
        getLang(`plugins.hack.step_${step}`),
        latency,
      ),
    );
  }

  const port = random.pick([22, 80, 443, 3306, 5432, 8080, 9000]);
  lines.push(
    "",
    getLang("plugins.hack.port", port),
    getLang("plugins.hack.hash", glyphs.glitch(random.pick(["a3f9", "7c1e", "d40b", "9e2a"]), 0.2, target)),
    "",
    getLang("plugins.hack.granted"),
  );

  return glyphs.frame(lines, { style: "heavy", title: getLang("plugins.hack.title") });
}

module.exports = {
  command: {
    pattern: "hack|intrusion|pentest",
    desc: getLang("plugins.hack.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const target = cleanTarget(argsString) || glyphs.rng(Date.now()).pick(FALLBACK_TARGETS);
    await message.react("☠");
    await message.reply(`${glyphs.art("skull")}\n\n${buildRun(target)}`);
  },

  buildRun,
};
