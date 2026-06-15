const { getLang } = require("../lib/utils/language");
const { Group } = require("../lib/database");

/**
 * Goodbye Plugin
 * Set custom goodbye messages for groups
 */

module.exports = {
  command: {
    pattern: "goodbye",
    desc: "Set goodbye message for group",
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

    try {
      // Get or create group settings
      let group = await Group.findOne({ where: { jid: message.jid } });

      if (!group) {
        group = await Group.create({
          jid: message.jid,
          name: (await message.getGroupMetadata())?.subject || "Unknown",
        });
      }

      if (!args) {
        // Show current settings
        const msg = `*Goodbye Message Settings*

*Current Message:*
${group.goodbyeMsg || "Default message"}

*Commands:*
• .goodbye <message> - Set custom message

*Variables:*
• @user - Mention user
• @group - Group name

*Example:*
.goodbye Goodbye @user! 👋 See you soon!`;

        return await message.reply(msg);
      }

      const action = args.toLowerCase();

      if (action === "get") {
        return await message.reply(
          `*Current Goodbye Message:*\n\n${
            group.goodbyeMsg || "Default message"
          }`
        );
      } else {
        // Set custom message
        group.goodbyeMsg = args;
        await group.save();
        return await message.reply(
          `*Goodbye message updated!* ✅\n\n*Preview:*\n${args}`
        );
      }
    } catch (error) {
      console.error("Goodbye command error:", error);
      await message.reply("*Error updating goodbye settings!*");
    }
  },
};
