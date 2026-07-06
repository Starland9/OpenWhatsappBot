/**
 * Invite Plugin
 * Get or reset group invite link
 */

module.exports = {
  command: {
    pattern: "invite",
    desc: "Obtenir ou révoquer le lien d'invitation du groupe",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const isAdmin = await message.isSenderAdmin();
    const isBotAdmin = await message.isBotAdmin();

    if (!isBotAdmin) {
      return await message.reply("❌ Le bot doit être admin pour gérer les liens d'invitation.");
    }

    const sub = (args || "").toLowerCase().trim();

    if (sub === "reset" || sub === "revoke") {
      if (!isAdmin && !message.isSudo()) {
        return await message.reply("❌ Réservé aux admins du groupe.");
      }
      try {
        await message.groupRevokeInvite();
        const newCode = await message.groupInviteCode();
        return await message.reply(
          `🔄 *Lien révoqué et nouveau lien généré :*\n\nhttps://chat.whatsapp.com/${newCode}`
        );
      } catch (err) {
        return await message.reply(`❌ Erreur : ${err.message}`);
      }
    }

    // Get invite link
    try {
      const code = await message.groupInviteCode();
      return await message.reply(
        `🔗 *Lien d'invitation du groupe :*\n\nhttps://chat.whatsapp.com/${code}\n\n_Utilisez .invite reset pour révoquer et générer un nouveau lien._`
      );
    } catch (err) {
      return await message.reply(`❌ Impossible d'obtenir le lien : ${err.message}`);
    }
  },
};
