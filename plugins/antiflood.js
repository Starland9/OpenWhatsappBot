/**
 * Anti-Flood Plugin
 * Toggle flood detection in groups
 */

const { Group } = require("../lib/database");

module.exports = {
  command: {
    pattern: "antiflood",
    desc: "Activer/désactiver la protection anti-flood du groupe",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const isAdmin = await message.isSenderAdmin();
    if (!isAdmin && !message.isSudo()) {
      return await message.reply("❌ Réservé aux admins du groupe.");
    }

    const [group] = await Group.findOrCreate({
      where: { jid: message.jid },
      defaults: { jid: message.jid },
    });

    const sub = (args || "").toLowerCase().trim();

    if (sub === "on") {
      await group.update({ antiflood: true });
      return await message.reply(
        "✅ *Anti-Flood activé !*\n\nSeuils :\n• 5 messages / 5s → avertissement\n• 10 messages / 5s → expulsion\n\nLes admins sont exemptés.",
      );
    }

    if (sub === "off") {
      await group.update({ antiflood: false });
      return await message.reply("❌ *Anti-Flood désactivé.*");
    }

    const status = group.antiflood ? "✅ Activé" : "❌ Désactivé";
    return await message.reply(
      `*🌊 Anti-Flood*\n\nStatut : ${status}\n\n*Usage :*\n.antiflood on → activer\n.antiflood off → désactiver`,
    );
  },
};
