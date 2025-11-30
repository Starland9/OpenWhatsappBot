const { getLang } = require("../lib/utils/language");
const { Filter } = require("../lib/database");

/**
 * Delete Filter Plugin
 * Remove auto-reply filters
 */

module.exports = {
  command: {
    pattern: "delfilter",
    desc: "Delete auto-reply filter",
    type: "admin",
  },

  async execute(message, args) {
    if (!message.isGroup) {
      return await message.reply("*This command is only for groups!*");
    }

    // Check if sender is admin
    const isAdmin = await message.isSenderAdmin();
    if (!isAdmin && !message.isSudo()) {
      return await message.reply("*This command is only for admins!*");
    }

    if (!args) {
      return await message.reply(
        "*Please provide filter pattern to delete!*\n\nExample: .delfilter hi\n\nUse .filter list to see all filters"
      );
    }

    try {
      const deleted = await Filter.destroy({
        where: {
          pattern: args.trim(),
          groupJid: message.jid,
        },
      });

      if (deleted > 0) {
        return await message.reply(`*Filter "${args}" deleted!* ✅`);
      } else {
        return await message.reply(
          `*Filter "${args}" not found!*\n\nUse .filter list to see active filters`
        );
      }
    } catch (error) {
      console.error("Delete filter error:", error);
      await message.reply("*Error deleting filter!*");
    }
  },
};
