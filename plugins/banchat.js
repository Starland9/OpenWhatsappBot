const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Ban/Unban Plugin
 * Deactivate/activate bot in specific chats
 */

// Store banned chats in memory (in production, use database)
const bannedChats = new Set();

module.exports = {
  command: {
    pattern: "ban",
    desc: "Deactivate bot in current chat (owner only)",
    type: "owner",
  },

  async execute(message, args) {
    if (!message.isSudo()) {
      return await message.reply("*This command is only for bot owners!*");
    }

    try {
      if (bannedChats.has(message.jid)) {
        return await message.reply(
          "*Bot is already deactivated in this chat!* ⚫"
        );
      }

      bannedChats.add(message.jid);

      await message.reply(
        `*Bot deactivated in this chat!* ⚫\n\nThe bot will not respond to any commands here.\n\nUse .unban to reactivate.`
      );
    } catch (error) {
      console.error("Ban command error:", error);
      await message.reply("*Error deactivating bot!*");
    }
  },

  // Export helper function to check if chat is banned
  isBanned: (jid) => bannedChats.has(jid),
};
