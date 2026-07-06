/**
 * Anti-Link Plugin
 * Toggle link detection/removal in groups
 */

const { Group } = require("../lib/database");

module.exports = {
  command: {
    pattern: "antilink",
    desc: "Activer/désactiver la détection de liens dans le groupe",
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
      await group.update({ antilink: true });
      return await message.reply(
        "✅ *Anti-Link activé !*\n\nTous les liens seront supprimés automatiquement.\nLes admins sont exemptés.\nAprès 3 avertissements → expulsion."
      );
    }

    if (sub === "off") {
      await group.update({ antilink: false });
      return await message.reply("❌ *Anti-Link désactivé.*");
    }

    // Show status
    const status = group.antilink ? "✅ Activé" : "❌ Désactivé";
    return await message.reply(
      `*🔗 Anti-Link*\n\nStatut : ${status}\n\n*Usage :*\n.antilink on → activer\n.antilink off → désactiver`
    );
  },
};
