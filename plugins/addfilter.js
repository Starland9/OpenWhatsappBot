const { getLang } = require("../lib/utils/language");
const { Filter } = require("../lib/database");

/**
 * Filter Plugin
 * Create custom auto-reply filters for groups
 */

module.exports = {
  command: {
    pattern: "filter",
    desc: "Add auto-reply filter",
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
      if (!args) {
        return await message.reply(
          `*Filter System*

*Usage:*
• .filter <pattern>=<response>
• .filter list - Show all filters
• .delfilter <pattern> - Delete filter

*Example:*
.filter hi=Hello! How are you?
.filter bot=I'm a WhatsApp bot! 🤖

When someone says "hi", bot will reply with your message.`
        );
      }

      const action = args.toLowerCase();

      if (action === "list" || action === "get") {
        // List all filters
        const filters = await Filter.findAll({
          where: { groupJid: message.jid },
        });

        if (filters.length === 0) {
          return await message.reply(
            "*No filters found!*\n\nAdd one with: .filter pattern=response"
          );
        }

        let msg = `*📝 Active Filters*\n\n`;
        filters.forEach((filter, index) => {
          msg += `*${index + 1}. Pattern:* ${filter.pattern}\n`;
          msg += `*Response:* ${filter.response}\n\n`;
        });

        return await message.reply(msg);
      }

      // Add new filter
      if (!args.includes("=")) {
        return await message.reply(
          "*Invalid format!*\n\nUse: .filter pattern=response\n\nExample: .filter hello=Hi there! 👋"
        );
      }

      const [pattern, ...responseParts] = args.split("=");
      const response = responseParts.join("=").trim();

      if (!pattern || !response) {
        return await message.reply(
          "*Pattern and response are required!*\n\nExample: .filter hi=Hello!"
        );
      }

      // Check if filter already exists
      const existing = await Filter.findOne({
        where: {
          pattern: pattern.trim(),
          groupJid: message.jid,
        },
      });

      if (existing) {
        // Update existing filter
        existing.response = response;
        await existing.save();
        return await message.reply(
          `*Filter updated!* ✅\n\n*Pattern:* ${pattern}\n*Response:* ${response}`
        );
      } else {
        // Create new filter
        await Filter.create({
          pattern: pattern.trim(),
          response: response,
          groupJid: message.jid,
          isGlobal: false,
        });

        return await message.reply(
          `*Filter added!* ✅\n\n*Pattern:* ${pattern}\n*Response:* ${response}`
        );
      }
    } catch (error) {
      console.error("Filter command error:", error);
      await message.reply("*Error managing filter!*");
    }
  },
};
