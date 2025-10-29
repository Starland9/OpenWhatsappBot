const { getCommands } = require("../lib/plugins/registry");
const config = require("../config");

/**
 * Help command - Display available commands
 */
module.exports = {
  command: {
    pattern: "help|menu",
    desc: "Display available commands",
    type: "general",
  },

  async execute(message, args) {
    const commands = getCommands();

    // Group commands by type
    const grouped = commands.reduce((acc, cmd) => {
      if (!acc[cmd.type]) acc[cmd.type] = []
      acc[cmd.type].push(cmd)
      return acc
    }, {})
    
    let helpText = `╭━━━『 *OPEN WHATSAPP BOT* 』━━━
│
│ *Version:* ${config.VERSION}
│ *Prefix:* ${config.PREFIX}
│ *Commands:* ${commands.length}
│
╰━━━━━━━━━━━━━━━━━━━

`;

    // Display commands by category
    for (const [type, cmds] of Object.entries(grouped)) {
      helpText += `╭━━━『 *${type.toUpperCase()}* 』━━━\n`;

      for (const cmd of cmds) {
        const prefix = config.PREFIX;
        helpText += `│ *${prefix}${cmd.pattern}*\n`;
        if (cmd.desc) {
          helpText += `│   └ ${cmd.desc}\n`;
        }
      }

      helpText += `╰━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    helpText += `_Type ${config.PREFIX}<command> to use a command_`;

    await message.reply(helpText);
  },
};
