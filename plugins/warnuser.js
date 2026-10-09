const { getLang } = require("../lib/utils/language");
const { Warn } = require("../lib/database");
const config = require("../config");

/**
 * Warn System Plugin
 * Warning system for group management
 */

module.exports = {
  command: {
    pattern: "warn",
    desc: "Warn a user in group",
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
      // Check for subcommands
      if (args && args.toLowerCase() === "list") {
        // List all warnings in this group
        const warnings = await Warn.findAll({
          where: { groupJid: message.jid },
        });

        if (warnings.length === 0) {
          return await message.reply("*No warnings in this group!*");
        }

        let msg = `*⚠️ Group Warnings*\n\n`;
        warnings.forEach((warn) => {
          const user = warn.jid.split("@")[0];
          msg += `*User:* @${user}\n`;
          msg += `*Count:* ${warn.count}/${config.WARN_LIMIT}\n`;
          msg += `*Remaining:* ${config.WARN_LIMIT - warn.count}\n`;
          msg += `*Reason:* ${warn.reason}\n\n`;
        });

        return await message.reply(msg, {
          mentions: warnings.map((w) => w.jid),
        });
      }

      if (args && args.toLowerCase() === "reset") {
        // Reset warnings for replied user
        if (!message.quoted || !message.quoted.sender) {
          return await message.reply(
            "*Reply to a user's message to reset their warnings!*"
          );
        }

        const deleted = await Warn.destroy({
          where: {
            jid: message.quoted.sender,
            groupJid: message.jid,
          },
        });

        if (deleted > 0) {
          return await message.reply(
            `*Warnings reset for @${message.quoted.sender.split("@")[0]}!* ✅`,
            { mentions: [message.quoted.sender] }
          );
        } else {
          return await message.reply("*User has no warnings!*");
        }
      }

      // Warn user
      if (!message.quoted || !message.quoted.sender) {
        return await message.reply(
          `*Warn System*

*Usage:*
• .warn - Reply to warn user
• .warn <reason> - Warn with reason
• .warn list - Show all warnings
• .warn reset - Reset user warnings (reply)

*Example:*
Reply to a message and type: .warn Spamming`
        );
      }

      const targetJid = message.quoted.sender;

      // Check if bot is admin
      const isBotAdmin = await message.isBotAdmin();
      if (!isBotAdmin) {
        return await message.reply(
          "*Bot must be admin to kick users after warn limit!*"
        );
      }

      // Get or create warning
      let warn = await Warn.findOne({
        where: {
          jid: targetJid,
          groupJid: message.jid,
        },
      });

      const reason = args || "No reason provided";

      if (warn) {
        warn.count += 1;
        warn.reason = reason;
        await warn.save();
      } else {
        warn = await Warn.create({
          jid: targetJid,
          groupJid: message.jid,
          reason: reason,
          count: 1,
        });
      }

      const remaining = config.WARN_LIMIT - warn.count;

      const warnMsg = config.WARN_MESSAGE.replace(
        "&mention",
        `@${targetJid.split("@")[0]}`
      )
        .replace("&warn", warn.count.toString())
        .replace("&remaining", remaining.toString());

      await message.reply(warnMsg, { mentions: [targetJid] });

      // Kick if limit reached
      if (warn.count >= config.WARN_LIMIT) {
        await message.kick(targetJid);
        await Warn.destroy({
          where: {
            jid: targetJid,
            groupJid: message.jid,
          },
        });

        const kickMsg = config.WARN_KICK_MESSAGE.replace(
          "&mention",
          `@${targetJid.split("@")[0]}`
        );

        await message.reply(kickMsg, { mentions: [targetJid] });
      }
    } catch (error) {
      console.error("Warn command error:", error);
      await message.reply("*Error processing warn command!*");
    }
  },
};
