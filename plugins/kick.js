const { getLang } = require("../lib/utils/language");

/**
 * Kick command - Remove member from group
 */
module.exports = {
  command: {
    pattern: "kick",
    desc: getLang("plugins.kick.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message) {
    if (!message.isGroup) {
      return await message.reply(getLang("extra.group_cmd"));
    }

    // Check if sender is admin
    const isSenderAdmin = await message.isSenderAdmin();
    if (!isSenderAdmin && !message.isSudo()) {
      return await message.reply(getLang("plugins.common.not_admin"));
    }

    // Check if bot is admin
    const isBotAdmin = await message.isBotAdmin();
    if (!isBotAdmin) {
      return await message.reply(getLang("plugins.kick.not_admin"));
    }

    // Get target user from mentions or quoted message
    let target;

    if (message.mentions && message.mentions.length > 0) {
      target = message.mentions[0];
    } else if (message.quoted) {
      target = message.quoted.sender;
    } else {
      return await message.reply(getLang("plugins.kick.mention_user"));
    }

    try {
      await message.kick(target);
      await message.reply(`✅ Kicked @${target.split("@")[0]}`, {
        mentions: [target],
      });
    } catch (error) {
      console.error("Kick error:", error);
      await message.reply(`❌ Failed to kick: ${error.message}`);
    }
  },
};
