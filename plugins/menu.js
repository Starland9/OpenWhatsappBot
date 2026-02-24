const { getCommands } = require("../lib/plugins/registry");
const config = require("../config");
const axios = require("axios");

/**
 * Menu command - affiche toutes les commandes catégorisées
 * Utilise Picsum (avec fallbacks) pour un aperçu visuel fiable
 */
module.exports = {
  command: {
    pattern: "menu",
    desc: "Afficher les commandes disponibles (toutes, catégorisées)",
    type: "general",
  },

  async execute(message) {
    const commands = getCommands();

    // Group commands by type and sort
    const grouped = commands.reduce((acc, cmd) => {
      const t = cmd.type || "misc";
      if (!acc[t]) acc[t] = [];
      acc[t].push(cmd);
      return acc;
    }, {});

    Object.keys(grouped).forEach((k) => {
      grouped[k].sort((a, b) => {
        const aName = a.pattern.split("|")[0];
        const bName = b.pattern.split("|")[0];
        return aName.localeCompare(bName);
      });
    });

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
      misc: "•",
    };

    const header = `*OpenWhatsappBot* — v${config.VERSION}\nPrefix: ${config.PREFIX} — ${commands.length} commandes`;

    let body = "";

    for (const [type, cmds] of Object.entries(grouped)) {
      const icon = icons[type] || icons.misc;
      const title = `${icon} ${type.toUpperCase()} (${cmds.length})`;

      // Build compact command list (only names), arranged in rows
      const cmdNames = cmds.map(
        (c) => `${config.PREFIX}${c.pattern.split("|")[0]}`,
      );
      const rows = [];
      const PER_ROW = 6;
      for (let i = 0; i < cmdNames.length; i += PER_ROW) {
        rows.push(cmdNames.slice(i, i + PER_ROW).join("  "));
      }

      body += `\n${title}\n`;
      body += "```\n" + (rows.join("\n") || "-") + "\n```\n";
    }

    const footer = `\n_Tapez ${config.PREFIX}help <commande> pour plus de détails_`;
    const caption = `${header}\n${body}${footer}`;

    // Try multiple reliable image providers as preview (Picsum primary)
    const imageCandidates = [
      "https://picsum.photos/800/600",
      "https://loremflickr.com/800/600/technology",
      "https://placeimg.com/800/600/tech",
    ];

    const tryFetchImage = async () => {
      for (const url of imageCandidates) {
        try {
          const resp = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 8000,
          });
          const buf = Buffer.from(resp.data);
          if (buf && buf.length > 1000) return buf;
        } catch (e) {
          // continue to next provider
        }
      }
      return null;
    };

    try {
      const buffer = await tryFetchImage();
      if (buffer && typeof message.sendImage === "function") {
        await message.sendImage(buffer, caption);
        return;
      }
    } catch (e) {
      // ignore and fallback to text
    }

    // Fallback: send text-only menu
    await message.reply(caption);
  },
};
