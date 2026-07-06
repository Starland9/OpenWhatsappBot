/**
 * Random Member Plugin
 * Pick a random group member
 */

const { sendGroupButtons } = require("../lib/utils/buttonHelper");
const { jidNormalizedUser } = require("baileys");

module.exports = {
  command: {
    pattern: "random",
    desc: "Choisir un membre aléatoire du groupe",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const metadata = await message.getGroupMetadata();
    if (!metadata) {
      return await message.reply("❌ Impossible de récupérer les infos du groupe.");
    }

    const sub = (args || "").toLowerCase().trim();
    const excludeAdmins = sub === "member" || sub === "members";

    let participants = metadata.participants.map((p) => jidNormalizedUser(p.id));

    if (excludeAdmins) {
      const adminJids = metadata.participants
        .filter((p) => p.admin)
        .map((p) => jidNormalizedUser(p.id));
      participants = participants.filter((p) => !adminJids.includes(p));
    }

    // Exclude the bot itself
    const botJid = jidNormalizedUser(message.client.getSocket().user.id);
    participants = participants.filter((p) => p !== botJid);

    if (participants.length === 0) {
      return await message.reply("❌ Aucun membre disponible pour la sélection.");
    }

    const chosen = participants[Math.floor(Math.random() * participants.length)];
    const num = chosen.split("@")[0];

    const sock = message.client.getSocket();
    try {
      await sendGroupButtons(sock, message.jid, {
        title: "🎲 Membre Aléatoire",
        text: `🎯 Le sort a désigné... @${num} !`,
        footer: `Parmi ${participants.length} membre(s)`,
        buttons: [
          { id: "random_again", text: "🎲 Relancer" },
        ],
      });
    } catch (_) {
      await message.reply(
        `🎲 *Membre Aléatoire*\n\nLe sort a désigné : @${num} 🎯\n\n_Parmi ${participants.length} membre(s)_`,
        { mentions: [chosen] }
      );
    }
  },
};
