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

    // Build geek / terminal style menu text
    let menuText = `╔════════════════════╗\n`;
    menuText += `║  ⚡ SYSTEM: ONLINE   ║\n`;
    menuText += `╚════════════════════╝\n`;
    menuText += `> Version: ${config.VERSION}\n`;
    menuText += `> Prefix:  ${config.PREFIX}\n`;
    menuText += `> CMDs:    ${commands.length}\n\n`;

    for (const [type, cmds] of Object.entries(grouped)) {
      const typeLabel = `[ ${type.toUpperCase()} ]`;
      menuText += `${typeLabel}\n`;

      // Tri et affichage compact sans espaces excessifs
      const names = cmds.map((c) => c.pattern.split("|")[0]);
      menuText += `└─ ${names.join(", ")}\n\n`;
    }

    menuText += `_Utilisez ${config.PREFIX}help <cmd> pour le manuel._`;

    await message.reply(menuText);
  },
};
