const { getLang } = require("../lib/utils/language");
const { BannedChat } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const { BANNED_CHATS_KEY } = require("../lib/core/pipeline");
const config = require("../config");

/**
 * Ban Plugin
 * Deactivate the bot in the current chat (group or private). The chat is stored
 * in BannedChat; the pipeline drops its messages, except `unban` from an owner.
 */
module.exports = {
  command: {
    pattern: "ban",
    desc: getLang("plugins.banchat.desc"),
    type: "owner",
    fromMe: true,
  },

  async execute(message) {
    const [, created] = await BannedChat.findOrCreate({
      where: { jid: message.jid },
      defaults: { jid: message.jid, bannedBy: message.sender || message.senderLid || null },
    });

    // The pipeline gate reads the banned chats through the cache
    settingsCache.invalidate(BANNED_CHATS_KEY);

    if (!created) {
      return await message.reply(getLang("plugins.banchat.already", config.PREFIX));
    }

    await message.reply(getLang("plugins.banchat.done", config.PREFIX));
  },
};
