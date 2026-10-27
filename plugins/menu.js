const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { getVisibleCommands, typeLabel } = require("./help");

/**
 * Menu command - lists the commands by category, with their aliases.
 * Owner-only commands are only listed for the owners.
 */

// Display order and icon of every command type in use; unknown types come last
const TYPE_ICONS = {
  general: "🎯",
  ai: "🤖",
  downloader: "📥",
  downloads: "📥",
  media: "🎨",
  music: "🎵",
  search: "🔍",
  info: "📰",
  fun: "😄",
  games: "🎮",
  economy: "💰",
  stats: "📊",
  utility: "🛠️",
  productivity: "⏰",
  group: "👥",
  admin: "🛡️",
  whatsapp: "💬",
  owner: "👑",
  misc: "📦",
};
const TYPE_ORDER = Object.keys(TYPE_ICONS);
const DEFAULT_ICON = "📦";

// WhatsApp text messages are fine up to much more, but a menu must stay readable
const MAX_MENU_CHARS = 4000;

function typeRank(type) {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

/** "name" or "name (alias1, alias2)" */
function commandLabel(cmd, withAliases) {
  const aliases = (cmd.aliases || []).slice(1);
  return withAliases && aliases.length
    ? `${cmd.name} (${aliases.join(", ")})`
    : cmd.name;
}

/** Join the labels, cut at maxChars with a "+N" marker */
function fitList(labels, maxChars) {
  const full = labels.join(", ");
  if (!Number.isFinite(maxChars) || full.length <= maxChars) return full;
  const kept = [];
  let length = 0;
  for (let i = 0; i < labels.length; i++) {
    const marker = ` … +${labels.length - i}`;
    const next = length + (kept.length ? 2 : 0) + labels[i].length;
    if (next + marker.length > maxChars) break;
    kept.push(labels[i]);
    length = next;
  }
  return `${kept.join(", ")} … +${labels.length - kept.length}`;
}

function buildHeader(count) {
  return (
    `╭━━『 ⚡ *${getLang("plugins.menu.title")}* 』━━\n` +
    `│ ${getLang("plugins.menu.version")}: ${config.VERSION}\n` +
    `│ ${getLang("plugins.menu.prefix")}: ${config.PREFIX}\n` +
    `│ ${getLang("plugins.menu.commands")}: ${count}\n` +
    `╰━━━━━━━━━━━━━━━━━━━\n\n`
  );
}

/**
 * Build the menu text for a list of registry entries.
 * First with aliases; if too long, without; if still too long, each category is cut.
 */
function buildMenu(commands) {
  const grouped = new Map();
  for (const cmd of commands) {
    const type = cmd.type || "misc";
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(cmd);
  }
  const types = [...grouped.keys()].sort(
    (a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b),
  );
  for (const list of grouped.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const header = buildHeader(commands.length);
  const footer = `_${getLang("plugins.menu.footer", config.PREFIX)}_`;

  const render = (withAliases, perCategoryMax) =>
    header +
    types
      .map((type) => {
        const labels = grouped.get(type).map((c) => commandLabel(c, withAliases));
        return (
          `${TYPE_ICONS[type] || DEFAULT_ICON} *${typeLabel(type)}*\n` +
          fitList(labels, perCategoryMax)
        );
      })
      .join("\n\n") +
    `\n\n${footer}`;

  let text = render(true, Infinity);
  if (text.length <= MAX_MENU_CHARS) return text;
  text = render(false, Infinity);
  if (text.length <= MAX_MENU_CHARS) return text;

  // Share what is left of the budget between the categories
  const titlesLength = types.reduce((n, t) => n + typeLabel(t).length + 8, 0);
  const budget = MAX_MENU_CHARS - header.length - footer.length - titlesLength;
  return render(false, Math.max(40, Math.floor(budget / types.length)));
}

module.exports = {
  command: {
    pattern: "menu",
    desc: getLang("plugins.menu.desc"),
    type: "general",
  },

  async execute(message) {
    await message.reply(buildMenu(getVisibleCommands(message)));
  },

  // Shared with buttonmenu.js
  TYPE_ICONS,
  DEFAULT_ICON,
  typeRank,
};
