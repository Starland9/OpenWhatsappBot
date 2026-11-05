const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Faux verdict de sécurité sur une cible.
 *   .audit            → cible aléatoire
 *   .audit <cible>    → verdict stable pour cette cible
 */

const MAX_TARGET = 40;
const CHECKS = ["tls", "headers", "dns", "ports", "auth", "backup"];

function verdictOf(score) {
  if (score >= 85) return getLang("plugins.audit.verdict_hardened");
  if (score >= 60) return getLang("plugins.audit.verdict_fair");
  if (score >= 35) return getLang("plugins.audit.verdict_weak");
  return getLang("plugins.audit.verdict_critical");
}

module.exports = {
  command: {
    pattern: "audit|pentest2|secaudit",
    desc: getLang("plugins.audit.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const target = String(argsString || "").trim().slice(0, MAX_TARGET) || "localhost";
    const random = glyphs.rng(target);

    const lines = [getLang("plugins.audit.target", glyphs.smallCaps(target)), ""];
    let total = 0;
    for (const check of CHECKS) {
      const score = random.int(10, 100);
      total += score;
      lines.push(
        getLang(
          "plugins.audit.check",
          getLang(`plugins.audit.check_${check}`),
          glyphs.bar(score / 100, 8),
          score,
        ),
      );
    }

    const average = Math.round(total / CHECKS.length);
    lines.push("", getLang("plugins.audit.score", average), getLang("plugins.audit.verdict", verdictOf(average)));

    await message.react("🛡");
    await message.reply(glyphs.frame(lines, { style: "double", title: getLang("plugins.audit.title") }));
  },
};
