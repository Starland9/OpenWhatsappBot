const { getLang } = require("../lib/utils/language");
const { Group } = require("../lib/database");

/**
 * Welcome/Goodbye Plugin
 * Set custom welcome and goodbye messages for groups
 */

module.exports = {
  command: {
    pattern: "welcome",
    desc: "Set welcome message for group",
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
        const status = group.welcome ? "ON ✅" : "OFF ❌";
        const msg = `*Welcome Message Settings*

*Status:* ${status}
*Current Message:*
${group.welcomeMsg || "Default message"}

*Commands:*
• .welcome on - Enable welcome
• .welcome off - Disable welcome
• .welcome <message> - Set custom message

*Variables:*
• @user - Mention user
• @group - Group name
• @desc - Group description

*Example:*
.welcome Welcome @user to @group! 👋`;

        return await message.reply(msg);
      }

      const action = args.toLowerCase();

      if (action === "on") {
        group.welcome = true;
        await group.save();
        return await message.reply("*Welcome messages enabled!* ✅");
      } else if (action === "off") {
        group.welcome = false;
        await group.save();
        return await message.reply("*Welcome messages disabled!* ❌");
      } else if (action === "get") {
        return await message.reply(
          `*Current Welcome Message:*\n\n${
            group.welcomeMsg || "Default message"
          }`
        );
      } else {
        // Set custom message
        group.welcomeMsg = args;
        group.welcome = true;
        await group.save();
        return await message.reply(
          `*Welcome message updated!* ✅\n\n*Preview:*\n${args}`
        );
      }
    } catch (error) {
      console.error("Welcome command error:", error);
      await message.reply("*Error updating welcome settings!*");
    }
  },
};
