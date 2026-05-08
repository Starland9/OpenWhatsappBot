const { getLang } = require("../lib/utils/language");

/**
 * Promote command - Promote member to admin
 */
module.exports = {
  command: {
    pattern: "promote",
    desc: getLang("plugins.promote.desc"),
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
      return await message.reply(getLang("plugins.promote.not_admin"));
    }

    // Get target user
    let target;

    if (message.mentions && message.mentions.length > 0) {
      target = message.mentions[0];
    } else if (message.quoted) {
      target = message.quoted.sender;
    } else {
      return await message.reply(getLang("plugins.promote.mention_user"));
    }

    try {
      await message.promote(target);
      await message.reply(`✅ Promoted @${target.split("@")[0]} to admin`, {
        mentions: [target],
      });
    } catch (error) {
      console.error("Promote error:", error);
      await message.reply(`❌ Failed to promote: ${error.message}`);
    }
  },
};
