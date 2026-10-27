const { Op } = require("sequelize");
const { UserStats } = require("../lib/database");
const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");
const { sendList, sendQuickReplies } = require("./buttons");

const PAGE_SIZE = 5;

const CATEGORIES = {
  chat: {
    field: "messageCount",
    label: "plugins.leaderboard.cat_chat",
    desc: "plugins.leaderboard.cat_chat_desc",
    unit: "plugins.leaderboard.unit_chat",
  },
  media: {
    field: "mediaCount",
    label: "plugins.leaderboard.cat_media",
    desc: "plugins.leaderboard.cat_media_desc",
    unit: "plugins.leaderboard.unit_media",
  },
  cmds: {
    field: "commandCount",
    label: "plugins.leaderboard.cat_cmds",
    desc: "plugins.leaderboard.cat_cmds_desc",
    unit: "plugins.leaderboard.unit_cmds",
  },
  xp: {
    field: "xp",
    label: "plugins.leaderboard.cat_xp",
    desc: "plugins.leaderboard.cat_xp_desc",
    unit: "plugins.leaderboard.unit_xp",
  },
};

// Words accepted in the command for each category
const CATEGORY_ALIASES = {
  messages: "chat",
  msg: "chat",
  medias: "media",
  commands: "cmds",
  cmd: "cmds",
  level: "xp",
  lvl: "xp",
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Category key for a word, or null */
function resolveCategory(word) {
  const w = String(word || "").toLowerCase();
  if (has(CATEGORIES, w)) return w;
  if (has(CATEGORY_ALIASES, w)) return CATEGORY_ALIASES[w];
  return null;
}

const tag = (jid) => `@${String(jid).split("@")[0]}`;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

async function showCategoryMenu(message) {
  const sections = [
    {
      title: getLang("plugins.leaderboard.categories"),
      rows: Object.entries(CATEGORIES).map(([key, cat]) => ({
        id: `top:cat:${key}`,
        title: getLang(cat.label),
        description: getLang(cat.desc),
      })),
    },
  ];
  return await sendList(
    message.client.getSocket(),
    message.jid,
    getLang("plugins.leaderboard.pick"),
    sections,
    {
      title: getLang("plugins.leaderboard.title"),
      buttonLabel: getLang("plugins.leaderboard.pick_button"),
      footer: "OpenWhatsappBot",
      quoted: message.data,
    },
  );
}

/**
 * One page of a ranking. The page is clamped to the existing pages, so a
 * stale button or a typo can never produce a negative offset.
 * Members with a zero score are not ranked.
 */
async function showCategory(message, category, page) {
  const cat = CATEGORIES[category];
  const label = getLang(cat.label);
  const where = { groupJid: message.jid, [cat.field]: { [Op.gt]: 0 } };

  const total = await UserStats.count({ where });
  if (total === 0) {
    return await message.reply(getLang("plugins.leaderboard.empty", label));
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const current = clamp(Number.isFinite(page) ? Math.trunc(page) : 0, 0, totalPages - 1);
  const offset = current * PAGE_SIZE;
  const rows = await UserStats.findAll({
    where,
    order: [
      [cat.field, "DESC"],
      ["jid", "ASC"],
    ],
    limit: PAGE_SIZE,
    offset,
  });

  const text = getLang(
    "plugins.leaderboard.page_text",
    label,
    current + 1,
    totalPages,
    rows
      .map((r, i) =>
        getLang(
          "plugins.leaderboard.entry",
          offset + i + 1,
          tag(r.jid),
          getLang(cat.unit, r[cat.field] || 0),
        ),
      )
      .join("\n"),
  );
  const mentions = rows.map((r) => r.jid);

  const navButtons = [];
  if (current > 0) {
    navButtons.push({
      id: `top:nav:${category}:${current - 1}`,
      text: getLang("plugins.leaderboard.btn_prev"),
    });
  }
  if (current < totalPages - 1) {
    navButtons.push({
      id: `top:nav:${category}:${current + 1}`,
      text: getLang("plugins.leaderboard.btn_next"),
    });
  }
  navButtons.push({
    id: "top:catmenu",
    text: getLang("plugins.leaderboard.btn_categories"),
  });

  try {
    return await sendQuickReplies(
      message.client.getSocket(),
      message.jid,
      text,
      navButtons,
      {
        title: label,
        footer: getLang("plugins.leaderboard.footer", current + 1, totalPages),
        quoted: message.data,
        mentions,
      },
    );
  } catch (err) {
    console.error("leaderboard: buttons failed", safeLog(err));
    return await message.reply(text, { mentions });
  }
}

/**
 * Group leaderboard with category picker, pagination and quick-reply navigation.
 */
module.exports = {
  command: {
    pattern: "top|active|leaderboard|lb",
    desc: getLang("plugins.leaderboard.desc"),
    type: "stats",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const [word, pageWord] = String(argsString || "")
      .trim()
      .toLowerCase()
      .split(/\s+/);
    const category = resolveCategory(word);
    if (!category) return await showCategoryMenu(message);

    // Typed pages start at 1
    const typed = parseInt(pageWord, 10);
    return await showCategory(message, category, (Number.isFinite(typed) ? typed : 1) - 1);
  },

  async handleButtonReply(message) {
    const id = message && message.body;
    if (typeof id !== "string" || !id.startsWith("top:")) return false;

    const parts = id.split(":");
    const action = parts[1];
    let run = null;
    if (action === "nav" && parts.length === 4 && has(CATEGORIES, parts[2]) && /^\d{1,6}$/.test(parts[3])) {
      run = () => showCategory(message, parts[2], Number(parts[3]));
    } else if (action === "cat" && parts.length === 3 && has(CATEGORIES, parts[2])) {
      run = () => showCategory(message, parts[2], 0);
    } else if (action === "catmenu" && parts.length === 2) {
      run = () => showCategoryMenu(message);
    }
    if (!run) return false;

    try {
      if (!message.isGroup) {
        await message.reply(getLang("extra.group_cmd"));
      } else {
        await run();
      }
    } catch (err) {
      console.error("leaderboard: button failed", safeLog(err));
      try {
        await message.reply(getLang("common.error"));
      } catch (_) {
        // nothing more to do
      }
    }
    return true;
  },

  showCategory,
  CATEGORIES,
};
