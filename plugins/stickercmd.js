const { getLang } = require("../lib/utils/language");
const { StickerCommand } = require("../lib/database");

/**
 * Set command for a sticker
 */
module.exports = {
  command: {
    pattern: "setcmd",
    desc: "Assigner une commande à un sticker",
    type: "utility",
    fromMe: true,
  },

  async execute(message, query) {
    try {
      // Vérifier que c'est une réponse à un sticker
      if (!message.quoted || !message.quoted.message?.stickerMessage) {
        return await message.reply(
          "❌ Répondez à un sticker avec `setcmd <commande>`\n\n*Exemples:*\n• `.setcmd vv` - Exécuter view once\n• `.setcmd ping` - Exécuter ping\n• `.setcmd menu` - Afficher le menu"
        );
      }

      if (!query) {
        return await message.reply(
          "❌ Spécifiez une commande\n\n*Usage:* `.setcmd <commande>`"
        );
      }

      // Extraire le hash du sticker (fileSha256 converti en hex)
      const stickerMsg = message.quoted.message.stickerMessage;
      const fileSha256 = stickerMsg.fileSha256;

      if (!fileSha256) {
        return await message.reply("❌ Impossible d'identifier ce sticker");
      }

      // Convertir le buffer/Uint8Array en string hexadécimal
      const stickerHash = Buffer.from(fileSha256).toString("hex");

      // Nettoyer le nom de commande (retirer le préfixe si présent)
      const commandName = query.trim().replace(/^[.!/]/, "");

      // Sauvegarder dans la base de données
      const [stickerCmd, created] = await StickerCommand.findOrCreate({
        where: { stickerHash },
        defaults: {
          stickerHash,
          command: commandName,
          createdBy: message.sender,
        },
      });

      if (!created) {
        // Mettre à jour si existe déjà
        await stickerCmd.update({ command: commandName });
        return await message.reply(
          `✅ Commande mise à jour pour ce sticker\n\n*Commande:* \`${commandName}\`\n\n_Envoyez ce sticker pour l'exécuter silencieusement_`
        );
      }

      await message.reply(
        `✅ Commande assignée au sticker\n\n*Commande:* \`${commandName}\`\n\n_Envoyez ce sticker pour l'exécuter silencieusement_`
      );
    } catch (error) {
      console.error("SetCmd error:", error);
      await message.reply(`❌ Erreur: ${error.message}`);
    }
  },
};
