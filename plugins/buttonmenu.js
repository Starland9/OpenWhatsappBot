const { sendList } = require("./buttons");
const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { getCommandByPattern } = require("../lib/plugins/registry");
const { safeLog } = require("../lib/utils/http");
const { formatCommandInfo, getVisibleCommands, typeLabel } = require("./help");
const { TYPE_ICONS, DEFAULT_ICON, typeRank } = require("./menu");

/**
 * Interactive button-based menu.
 * Single-select list of the categories; picking a category shows its commands as a
 * list; picking a command shows its help card.
 *
 * Button ids: `menu:cat:<type>`, `menu:cmd:<name>`, `menu:home`.
 */

const ID_PREFIX = "menu:";
const MAX_ROWS = 30;

function groupByType(commands) {
  const grouped = new Map();
  for (const cmd of commands) {
    const type = cmd.type || "misc";
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(cmd);
  }
  return grouped;
}

function listOptions(message) {
  return {
    title: getLang("plugins.buttonmenu.title"),
    buttonLabel: getLang("plugins.buttons.open_menu"),
    footer: "OpenWhatsappBot",
    quoted: message.data,
  };
}

/** The list of categories */
async function sendCategories(message) {
  const commands = getVisibleCommands(message);
  const grouped = groupByType(commands);
  const types = [...grouped.keys()].sort(
    (a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b),
  );

  const rows = types.map((type) => ({
    id: `${ID_PREFIX}cat:${type}`,
    title: `${TYPE_ICONS[type] || DEFAULT_ICON} ${typeLabel(type)}`,
    description: getLang("plugins.buttonmenu.cat_count", grouped.get(type).length),
  }));

  const text = getLang(
    "plugins.buttonmenu.intro",
    config.PREFIX,
    commands.length,
  );
  return await sendList(
    message.client.getSocket(),
    message.jid,
    text,
    [{ title: getLang("plugins.buttonmenu.categories"), rows }],
    listOptions(message),
  );
}

/** The commands of a category */
async function sendCategory(message, type) {
  const commands = getVisibleCommands(message)
    .filter((cmd) => (cmd.type || "misc") === type)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (commands.length === 0) {
    return await message.reply(getLang("plugins.buttonmenu.not_found", type));
  }

  const rows = commands.slice(0, MAX_ROWS).map((cmd) => ({
    id: `${ID_PREFIX}cmd:${cmd.name}`,
    title: cmd.name,
    description: cmd.desc || "",
  }));
  const sections = [
    {
      title: `${TYPE_ICONS[type] || DEFAULT_ICON} ${typeLabel(type)}`,
      rows,
    },
    {
      title: getLang("plugins.buttonmenu.navigation"),
      rows: [
        {
          id: `${ID_PREFIX}home`,
          title: getLang("plugins.buttonmenu.back"),
          description: getLang("plugins.buttonmenu.back_desc"),
        },
      ],
    },
  ];

  const text = getLang(
    "plugins.buttonmenu.category_intro",
    `${TYPE_ICONS[type] || DEFAULT_ICON} ${typeLabel(type)}`,
    commands.length,
  );
  return await sendList(
    message.client.getSocket(),
    message.jid,
    text,
    sections,
    listOptions(message),
  );
}

/** The help card of a command */
async function sendCommand(message, name) {
  const cmd = getCommandByPattern(name);
  if (!cmd) {
    return await message.reply(getLang("plugins.buttonmenu.not_found", name));
  }
  return await message.reply(formatCommandInfo(cmd));
}

module.exports = {
  command: {
    pattern: "bmenu|buttonmenu|menu2",
    desc: getLang("plugins.buttonmenu.desc"),
    type: "general",
  },

  async execute(message, argsString) {
    const sub = (argsString || "").trim().split(/\s+/)[0].toLowerCase();

    // Direct lookup: .bmenu <command>
    if (sub) {
      const name = sub.startsWith(config.PREFIX) ? sub.slice(config.PREFIX.length) : sub;
      return await sendCommand(message, name);
    }

    await sendCategories(message);
  },

  /**
   * Handle a list reply (category, command or home).
   */
  async handleButtonReply(message) {
    const body = message.body;
    if (typeof body !== "string" || !body.startsWith(ID_PREFIX)) return false;

    const [kind, ...rest] = body.slice(ID_PREFIX.length).split(":");
    const arg = rest.join(":").trim().toLowerCase();

    let action = null;
    if (kind === "home") action = () => sendCategories(message);
    else if (kind === "cat" && arg) action = () => sendCategory(message, arg);
    else if (kind === "cmd" && arg) action = () => sendCommand(message, arg);
    if (!action) return false;

    try {
      await action();
    } catch (err) {
      console.error("buttonmenu reply:", safeLog(err));
    }
    return true;
  },
};
