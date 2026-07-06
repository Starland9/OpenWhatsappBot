const { sendQuickReplies, sendList } = require("./buttons");
const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { getCommands } = require("../lib/plugins/registry");

/**
 * Interactive button-based menu.
 * Single-select list with all categories; user picks a category, gets a sub-list of commands.
 */
module.exports = {
  command: {
    pattern: "bmenu|buttonmenu|menu2",
    desc: getLang("plugins.buttonmenu.desc"),
    type: "general",
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const commands = getCommands();

    if (argsString && argsString.length > 0) {
      // Direct subcommand
      const sub = argsString.trim().toLowerCase();
      const cmd = commands.find((c) =>
        c.pattern.split("|").map((p) => p.toLowerCase()).includes(sub)
      );
      if (cmd) {
        return await message.reply(`*${config.PREFIX}${cmd.pattern.split("|")[0]}*\n${cmd.desc || ""}`);
      }
      return await message.reply(getLang("plugins.buttonmenu.not_found", sub));
    }

    // Group commands by type
    const grouped = commands.reduce((acc, cmd) => {
      const t = cmd.type || "misc";
      if (!acc[t]) acc[t] = [];
      acc[t].push(cmd);
      return acc;
    }, {});

    const sections = Object.keys(grouped)
      .sort()
      .map((type) => ({
        title: type.toUpperCase(),
        rows: grouped[type]
          .slice(0, 30)
          .map((c) => {
            const name = c.pattern.split("|")[0];
            return {
              id: `menu:${name}`,
              title: name.slice(0, 24),
              description: (c.desc || "").slice(0, 72),
            };
          }),
      }));

    const text = `╔══════════════════╗\n║  ⚡ SYSTEM: ONLINE ║\n╚══════════════════╝\n> Prefix: ${config.PREFIX}\n> CMDs: ${commands.length}\n\n_Pick a category to browse commands._`;

    await sendList(sock, message.jid, text, sections, {
      title: getLang("plugins.buttonmenu.title") || "📋 Command Menu",
      buttonLabel: getLang("plugins.buttons.open_menu") || "📋 Open Menu",
      footer: "OpenWhatsappBot",
      quoted: message.data,
    });
  },

  /**
   * Handle list reply (user picked a command from the menu).
   */
  async handleReply(message) {
    if (!message.body || !message.body.startsWith("menu:")) return false;
    const cmdName = message.body.slice("menu:".length).trim().toLowerCase();
    if (!cmdName) return false;

    const commands = getCommands();
    const cmd = commands.find((c) =>
      c.pattern.split("|").map((p) => p.toLowerCase()).includes(cmdName)
    );

    if (!cmd) {
      await message.reply(getLang("plugins.buttonmenu.not_found", cmdName));
      return true;
    }

    await message.reply(`*${config.PREFIX}${cmd.pattern.split("|")[0]}*\n${cmd.desc || ""}`);
    return true;
  },
};
