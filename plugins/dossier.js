const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Carte d'identité occulte d'une personne.
 *   .dossier            → soi-même
 *   .dossier (citation) → la personne citée
 *
 * Tout est dérivé du JID : le dossier est stable d'une fois sur l'autre.
 */

const CLEARANCE = ["OMEGA", "SIGMA", "DELTA", "THETA", "ZETA"];
const ROLES = ["veilleur", "scribe", "éclaireur", "gardien", "ombre", "oracle"];
const STATUS = ["actif", "dormant", "sous surveillance", "compromis", "introuvable"];

function subjectOf(message) {
  const quoted = message.quoted;
  const jid = quoted?.sender || quoted?.key?.participant || message.sender;
  return { jid, user: String(jid || "inconnu").split("@")[0] };
}

module.exports = {
  command: {
    pattern: "dossier|dox|profil",
    desc: getLang("plugins.dossier.desc"),
    type: "dark",
  },

  async execute(message) {
    const { jid, user } = subjectOf(message);
    const random = glyphs.rng(jid || user);

    const lines = [
      getLang("plugins.dossier.id", glyphs.smallCaps(user)),
      getLang("plugins.dossier.clearance", random.pick(CLEARANCE)),
      getLang("plugins.dossier.role", random.pick(ROLES)),
      getLang("plugins.dossier.status", random.pick(STATUS)),
      getLang("plugins.dossier.threat", glyphs.bar(random.int(1, 10) / 10, 10)),
      getLang("plugins.dossier.since", random.int(2015, 2026)),
      "",
      getLang("plugins.dossier.fingerprint", glyphs.glitch(user, 0.35, user)),
    ];

    await message.react("🗂");
    await message.reply(
      `${glyphs.art("eye")}\n\n${glyphs.frame(lines, { style: "double", title: getLang("plugins.dossier.title") })}`,
      { mentions: jid ? [jid] : [] },
    );
  },
};
