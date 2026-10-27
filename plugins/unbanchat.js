const { getLang } = require("../lib/utils/language");
const { BannedChat } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const { BANNED_CHATS_KEY } = require("../lib/core/pipeline");

/**
 * Unban Plugin
 * Reactivate the bot in the current chat. The pipeline lets `unban` from an
 * owner through a disabled chat, so keep the alias `unban`.
 */
module.exports = {
  command: {
    pattern: "unban",
    desc: getLang("plugins.unbanchat.desc"),
    type: "owner",
    fromMe: true,
  },

  async execute(message) {
    const removed = await BannedChat.destroy({ where: { jid: message.jid } });

    // The pipeline gate reads the banned chats through the cache
    settingsCache.invalidate(BANNED_CHATS_KEY);

    if (removed === 0) {
      return await message.reply(getLang("plugins.unbanchat.not_banned"));
    }

    await message.reply(getLang("plugins.unbanchat.done"));
  },
};
