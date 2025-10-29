const { getCommands } = require("../lib/plugins/registry");
const config = require("../config");

/**
 * Menu command - Display simple list of available commands
 */
module.exports = {
  command: {
    pattern: "menu",
    desc: "Display list of available commands",
    type: "general",
  },

  async execute(message) {
    const commands = getCommands();

    // Group commands by type
    const grouped = commands.reduce((acc, cmd) => {
      if (!acc[cmd.type]) acc[cmd.type] = [];
      acc[cmd.type].push(cmd);
      return acc;
    }, {});

    let menuText = `╭━━━『 *OPEN WHATSAPP BOT* 』━━━
│
│ *Version:* ${config.VERSION}
│ *Prefix:* ${config.PREFIX}
│ *Commands:* ${commands.length}
│
╰━━━━━━━━━━━━━━━━━━━

`;

    // Display commands by category (only command names, no descriptions)
    for (const [type, cmds] of Object.entries(grouped)) {
      menuText += `╭━━━『 *${type.toUpperCase()}* 』━━━\n`;

      for (const cmd of cmds) {
        const prefix = config.PREFIX;
        menuText += `│ *${prefix}${cmd.pattern}*\n`;
      }

      menuText += `╰━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    menuText += `_Type ${config.PREFIX}help <command> for detailed help_`;

    await message.reply(menuText);
  },
};
