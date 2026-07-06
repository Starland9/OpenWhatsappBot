/**
 * Captcha Plugin
 * Toggle captcha verification for new group members
 */

const { Group } = require("../lib/database");

module.exports = {
  command: {
    pattern: "captcha",
    desc: "Activer/désactiver le captcha pour les nouveaux membres",
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
      await group.update({ captchaEnabled: true });
      return await message.reply(
        "✅ *Captcha activé !*\n\nLes nouveaux membres devront résoudre un calcul simple.\nS'ils ne répondent pas en 60s → expulsion automatique."
      );
    }

    if (sub === "off") {
      await group.update({ captchaEnabled: false });
      return await message.reply("❌ *Captcha désactivé.*");
    }

    const status = group.captchaEnabled ? "✅ Activé" : "❌ Désactivé";
    return await message.reply(
      `*🔐 Captcha*\n\nStatut : ${status}\n\n*Usage :*\n.captcha on → activer\n.captcha off → désactiver`
    );
  },
};
