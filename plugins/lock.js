/**
 * Lock/Unlock Plugin
 * Toggle group messaging to admins-only or everyone
 */

module.exports = {
  command: {
    pattern: "lock|unlock",
    desc: "Verrouiller/déverrouiller les messages du groupe (admins seulement)",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const isAdmin = await message.isSenderAdmin();
    if (!isAdmin && !message.isSudo()) {
      return await message.reply("❌ Réservé aux admins du groupe.");
    }

    const isBotAdmin = await message.isBotAdmin();
    if (!isBotAdmin) {
      return await message.reply(
        "❌ Le bot doit être admin pour modifier ce paramètre.",
      );
    }

    const cmd = message.body
      .split(/\s+/)[0]
      .replace(/^[^a-z]*/i, "")
      .toLowerCase();

    try {
      if (cmd === "lock") {
        await message.groupSettingUpdate("announcement");
        return await message.reply(
          "🔒 *Groupe verrouillé !*\n\nSeuls les admins peuvent maintenant envoyer des messages.",
        );
      } else {
        await message.groupSettingUpdate("not_announcement");
        return await message.reply(
          "🔓 *Groupe déverrouillé !*\n\nTous les membres peuvent maintenant envoyer des messages.",
        );
      }
    } catch (err) {
      return await message.reply(`❌ Erreur : ${err.message}`);
    }
  },
};
