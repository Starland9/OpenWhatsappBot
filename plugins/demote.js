const { getLang } = require("../lib/utils/language");

/**
 * Demote command - Demote admin to member
 */
module.exports = {
  command: {
    pattern: "demote",
    desc: getLang("plugins.demote.desc"),
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
      return await message.reply(getLang("plugins.demote.not_admin"));
    }

    // Get target user
    let target;

    if (message.mentions && message.mentions.length > 0) {
      target = message.mentions[0];
    } else if (message.quoted) {
      target = message.quoted.sender;
    } else {
      return await message.reply(getLang("plugins.demote.mention_user"));
    }

    try {
      await message.demote(target);
      await message.reply(`✅ Demoted @${target.split("@")[0]} to member`, {
        mentions: [target],
      });
    } catch (error) {
      console.error("Demote error:", error);
      await message.reply(`❌ Failed to demote: ${error.message}`);
    }
  },
};
