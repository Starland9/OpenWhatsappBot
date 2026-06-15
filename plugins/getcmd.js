const { getLang } = require("../lib/utils/language");
const { StickerCommand } = require("../lib/database");

/**
 * Get command assigned to a sticker or list all sticker commands
 */
module.exports = {
  command: {
    pattern: "getcmd",
    desc: "Voir la commande d'un sticker ou lister toutes les commandes",
    type: "utility",
    fromMe: true,
  },

  async execute(message, query) {
    try {
      // Si réponse à un sticker, afficher sa commande
      if (message.quoted && message.quoted.message?.stickerMessage) {
        const stickerMsg = message.quoted.message.stickerMessage;
        const fileSha256 = stickerMsg.fileSha256;

        if (!fileSha256) {
          return await message.reply("❌ Impossible d'identifier ce sticker");
        }

        const stickerHash = Buffer.from(fileSha256).toString("hex");
        const stickerCmd = await StickerCommand.findOne({
          where: { stickerHash },
        });

        if (!stickerCmd) {
          return await message.reply(
            "❌ Aucune commande assignée à ce sticker\n\n_Utilisez `.setcmd <commande>` pour en assigner une_"
          );
        }

        return await message.reply(
          `✅ *Commande assignée:*\n\n\`${stickerCmd.command}\`\n\n_Envoyez ce sticker pour l'exécuter_`
        );
      }

      // Sinon, lister toutes les commandes de stickers
      const allCommands = await StickerCommand.findAll({
        order: [["createdAt", "DESC"]],
      });

      if (allCommands.length === 0) {
        return await message.reply(
          "❌ Aucune commande de sticker configurée\n\n_Utilisez `.setcmd <commande>` en répondant à un sticker_"
        );
      }

      let response = `📋 *Commandes de Stickers* (${allCommands.length})\n\n`;
      allCommands.forEach((cmd, index) => {
        response += `${index + 1}. \`${cmd.command}\`\n`;
        response += `   Hash: \`${cmd.stickerHash.substring(0, 16)}...\`\n\n`;
      });

      response +=
        "_Répondez à un sticker avec `.getcmd` pour voir sa commande_";

      await message.reply(response);
    } catch (error) {
      console.error("GetCmd error:", error);
      await message.reply(`❌ Erreur: ${error.message}`);
    }
  },
};
