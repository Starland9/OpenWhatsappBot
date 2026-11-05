const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Malédiction pour la personne citée (ou pour soi).
 *   .curse            → sur soi-même
 *   .curse (citation) → sur la personne citée
 */

const MAX_NAME = 32;

function targetOf(message) {
  const quoted = message.quoted;
  const jid = quoted?.sender || quoted?.key?.participant;
  if (!jid) return { jid: message.sender, name: getLang("plugins.curse.you") };
  const user = String(jid).split("@")[0];
  return { jid, name: `@${user}`.slice(0, MAX_NAME) };
}

module.exports = {
  command: {
    pattern: "curse|malediction|malédiction",
    desc: getLang("plugins.curse.desc"),
    type: "dark",
  },

  async execute(message) {
    const target = targetOf(message);
    const text = glyphs.curse(`${target.jid}:${Date.now()}`);

    const body = [
      glyphs.art("ghost"),
      "",
      getLang("plugins.curse.line", target.name, text),
      "",
      getLang("plugins.curse.seal", glyphs.sigil(target.jid).split("\n")[2].trim()),
    ].join("\n");

    await message.react("🕯");
    await message.reply(body, { mentions: target.jid ? [target.jid] : [] });
  },
};
