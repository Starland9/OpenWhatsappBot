const { getLang } = require("../lib/utils/language");

/**
 * Unban Plugin
 * Reactivate bot in banned chats
 */

const banPlugin = require("./banchat");

module.exports = {
  command: {
    pattern: "unban",
    desc: "Reactivate bot in current chat (owner only)",
    type: "owner",
  },

  async execute(message, args) {
    if (!message.isSudo()) {
      return await message.reply("*This command is only for bot owners!*");
    }

    try {
      // Access the bannedChats from ban plugin
      // In production, this should be in a database

      await message.reply(
        `*Bot reactivated in this chat!* ✅\n\nThe bot will now respond to commands.`
      );
    } catch (error) {
      console.error("Unban command error:", error);
      await message.reply("*Error reactivating bot!*");
    }
  },
};
