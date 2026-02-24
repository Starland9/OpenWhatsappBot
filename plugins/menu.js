const { getCommands } = require("../lib/plugins/registry");
const config = require("../config");
const axios = require("axios");

/**
 * Menu command - improved UI/UX with preview image
 */
module.exports = {
  command: {
    pattern: "menu",
    desc: "Afficher les commandes disponibles (UI améliorée)",
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

    // Small icons per category (fallback to •)
    const icons = {
      general: "🎯",
      ai: "🤖",
      downloads: "📥",
      music: "🎵",
      media: "🎨",
      info: "📰",
      search: "🔍",
      group: "👥",
      games: "🎮",
      productivity: "⏰",
    };

    // Build caption (short and readable)
    const header = `*OpenWhatsappBot* — v${config.VERSION}\nPrefix: ${config.PREFIX} — ${commands.length} commandes`;

    let body = "";
    for (const [type, cmds] of Object.entries(grouped)) {
      const icon = icons[type] || "•";
      body += `\n${icon} *${type.toUpperCase()}* — ${cmds.length}\n`;
      // show up to 6 commands per category as examples
      const exampleCmds = cmds.slice(0, 6).map((c) => {
        // show only first alias (pattern may contain |)
        const name = c.pattern.split("|")[0];
        return `\n  ${config.PREFIX}${name}`;
      });
      body += exampleCmds.join(" ") + "\n";
    }

    const footer = `\n_Tapez ${config.PREFIX}help <commande> pour plus de détails_`;

    const caption = `${header}\n${body}${footer}`;

    // Attempt to fetch a preview image (Unsplash random tech). If it fails, fallback to text-only.
    const imageUrl = "https://source.unsplash.com/800x600/?technology,geek";

    try {
      const resp = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        timeout: 10000,
      });
      const buffer = Buffer.from(resp.data);
      // Use message.sendImage if available, otherwise fallback to reply text
      if (typeof message.sendImage === "function") {
        await message.sendImage(buffer, caption);
        return;
      }
    } catch (e) {
      // ignore image errors and fallback to text
    }

    // Fallback: send text menu
    await message.reply(caption);
  },
};
