const { getLang } = require("../lib/utils/language");
const { StickerCommand } = require("../lib/database");

/**
 * Delete command from a sticker
 */
module.exports = {
  command: {
    pattern: "delcmd",
    desc: "Supprimer la commande d'un sticker",
    type: "utility",
    fromMe: true,
  },

  async execute(message, query) {
    try {
      // Vérifier que c'est une réponse à un sticker
      if (!message.quoted || !message.quoted.message?.stickerMessage) {
        return await message.reply(
          "❌ Répondez à un sticker avec `.delcmd` pour supprimer sa commande"
        );
      }

      // Extraire le hash du sticker
      const stickerMsg = message.quoted.message.stickerMessage;
      const fileSha256 = stickerMsg.fileSha256;

      if (!fileSha256) {
        return await message.reply("❌ Impossible d'identifier ce sticker");
      }

      const stickerHash = Buffer.from(fileSha256).toString("hex");

      // Supprimer de la base de données
      const deleted = await StickerCommand.destroy({
        where: { stickerHash },
      });

      if (deleted === 0) {
        return await message.reply("❌ Aucune commande assignée à ce sticker");
      }

      await message.reply(
        "✅ Commande supprimée\n\n_Ce sticker n'exécutera plus de commande_"
      );
    } catch (error) {
      console.error("DelCmd error:", error);
      await message.reply(`❌ Erreur: ${error.message}`);
    }
  },
};
