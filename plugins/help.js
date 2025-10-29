const { getCommandByPattern } = require("../lib/plugins/registry");
const config = require("../config");

/**
 * Help command - Display detailed help for a specific command
 */
module.exports = {
  command: {
    pattern: "help",
    desc: "Display detailed help for a specific command",
    type: "general",
  },

  async execute(message, args) {
    // If no command specified, show usage
    if (!args || args.trim() === "") {
      await message.reply(
        `*Usage:* ${config.PREFIX}help <command>\n\n` +
          `*Example:* ${config.PREFIX}help ping\n\n` +
          `_Type ${config.PREFIX}menu to see all available commands_`
      );
      return;
    }

    // Get the command name from args
    const commandName = args.trim().toLowerCase();

    // Find the command
    const command = getCommandByPattern(commandName);

    if (!command) {
      await message.reply(
        `❌ Command *${commandName}* not found.\n\n` +
          `_Type ${config.PREFIX}menu to see all available commands_`
      );
      return;
    }

    // Build detailed help text
    let helpText = `╭━━━『 *COMMAND HELP* 』━━━
│
│ *Command:* ${config.PREFIX}${command.pattern}
│ *Type:* ${command.type}
│ *Description:* ${command.desc || "No description available"}
│`;

    if (command.fromMe) {
      helpText += `\n│ *Sudo Only:* Yes`;
    }

    if (command.onlyGroup) {
      helpText += `\n│ *Group Only:* Yes`;
    }

    if (command.onlyPm) {
      helpText += `\n│ *PM Only:* Yes`;
    }

    helpText += `\n│
╰━━━━━━━━━━━━━━━━━━━`;

    await message.reply(helpText);
  },
};
