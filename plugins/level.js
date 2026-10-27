const { Op, QueryTypes } = require("sequelize");
const { UserStats } = require("../lib/database");
const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid, toPnJid } = require("../lib/utils/permissions");
const { sendQuickReplies } = require("./buttons");
const { computeLevel, xpForLevel } = require("./trackmessages");
const config = require("../config");

const BAR_LENGTH = 12;

// Buttons of the group card -> ranking field and message
const TOP_CATEGORIES = {
  chat: { field: "messageCount", key: "plugins.level.top_chat" },
  media: { field: "mediaCount", key: "plugins.level.top_media" },
  cmds: { field: "commandCount", key: "plugins.level.top_cmds" },
};

const tag = (jid) => `@${String(jid).split("@")[0]}`;

/** Progress inside the current level, as a bar */
function progressBar(xp, level, length = BAR_LENGTH) {
  const floor = xpForLevel(level);
  const span = xpForLevel(level + 1) - floor;
  const ratio = span > 0 ? Math.max(0, Math.min(1, (xp - floor) / span)) : 0;
  const filled = Math.round(ratio * length);
  return "▓".repeat(filled) + "░".repeat(length - filled);
}

/** First mention, else author of the quoted message, else the sender (phone-number form when known) */
async function resolveTarget(message) {
  const raw =
    (message.mentions && message.mentions[0]) ||
    (message.quoted && message.quoted.sender) ||
    message.sender;
  const normalized = normalizeJid(raw);
  if (!normalized) return normalizeJid(message.sender);
  return normalizeJid(await toPnJid(message, normalized)) || normalized;
}

/** Numbers shown on a card for a given amount of XP */
function cardNumbers(xp) {
  const level = computeLevel(xp);
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    level,
    bar: progressBar(xp, level),
    progress: xp - floor,
    needed: next - floor,
  };
}

const rankText = (xp, higher) => (xp > 0 ? `#${higher + 1}` : "—");

async function sendGroupCard(message, target) {
  const groupJid = message.jid;
  const row = await UserStats.findOne({ where: { jid: target, groupJid } });
  const xp = row ? row.xp || 0 : 0;
  const n = cardNumbers(xp);

  const higher =
    xp > 0
      ? await UserStats.count({ where: { groupJid, xp: { [Op.gt]: xp } } })
      : 0;
  const top = await UserStats.findAll({
    where: { groupJid, xp: { [Op.gt]: 0 } },
    order: [
      ["xp", "DESC"],
      ["jid", "ASC"],
    ],
    limit: 3,
  });

  const lines = top.length
    ? top
        .map((r, i) =>
          getLang(
            "plugins.level.top_line",
            i + 1,
            tag(r.jid),
            r.xp || 0,
            computeLevel(r.xp || 0),
          ),
        )
        .join("\n")
    : getLang("plugins.level.no_activity");

  const text = getLang(
    "plugins.level.card_group",
    tag(target),
    xp,
    n.level,
    n.bar,
    n.progress,
    n.needed,
    rankText(xp, higher),
    lines,
  );
  const mentions = [...new Set([target, ...top.map((r) => r.jid)])];
  const buttons = [
    { id: "level:top:chat", text: getLang("plugins.level.btn_chat") },
    { id: "level:top:media", text: getLang("plugins.level.btn_media") },
    { id: "level:top:cmds", text: getLang("plugins.level.btn_cmds") },
  ];

  try {
    return await sendQuickReplies(
      message.client.getSocket(),
      message.jid,
      text,
      buttons,
      {
        title: getLang("plugins.level.title"),
        footer: "OpenWhatsappBot",
        quoted: message.data,
        mentions,
      },
    );
  } catch (err) {
    console.error("level: buttons failed", safeLog(err));
    return await message.reply(text, { mentions });
  }
}

async function sendGlobalCard(message, target) {
  const total = Number(await UserStats.sum("xp", { where: { jid: target } })) || 0;
  const n = cardNumbers(total);

  // Rank among distinct users (their XP summed over every group)
  let higher = 0;
  if (total > 0) {
    const [result] = await UserStats.sequelize.query(
      "SELECT COUNT(*) AS n FROM (SELECT jid FROM user_stats GROUP BY jid HAVING SUM(xp) > :xp) AS t",
      { replacements: { xp: total }, type: QueryTypes.SELECT },
    );
    higher = Number(result && result.n) || 0;
  }

  const text = getLang(
    "plugins.level.card",
    tag(target),
    total,
    n.level,
    n.bar,
    n.progress,
    n.needed,
    rankText(total, higher),
  );
  return await message.reply(text, { mentions: [target] });
}

/**
 * Show XP, level, progress bar and the top-3 of the group.
 */
module.exports = {
  command: {
    pattern: "level|xp|rank",
    desc: getLang("plugins.level.desc"),
    type: "stats",
  },

  async execute(message, argsString) {
    const sub = String(argsString || "").trim().toLowerCase().split(/\s+/)[0];
    const target = await resolveTarget(message);

    if (sub === "global" || (!sub && !message.isGroup)) {
      return await sendGlobalCard(message, target);
    }
    if (sub === "top" || !sub) {
      if (!message.isGroup) return await message.reply(getLang("extra.group_cmd"));
      return await sendGroupCard(message, target);
    }
    return await message.reply(getLang("plugins.level.usage", config.PREFIX));
  },

  async handleButtonReply(message) {
    const id = message && message.body;
    if (typeof id !== "string" || !id.startsWith("level:top:")) return false;
    const categoryKey = id.slice("level:top:".length);
    if (!Object.prototype.hasOwnProperty.call(TOP_CATEGORIES, categoryKey)) return false;
    const category = TOP_CATEGORIES[categoryKey];

    try {
      if (!message.isGroup) {
        await message.reply(getLang("extra.group_cmd"));
        return true;
      }
      const top = await UserStats.findAll({
        where: { groupJid: message.jid, [category.field]: { [Op.gt]: 0 } },
        order: [
          [category.field, "DESC"],
          ["jid", "ASC"],
        ],
        limit: 5,
      });
      if (!top.length) {
        await message.reply(getLang("plugins.level.no_activity"));
        return true;
      }
      const lines = top
        .map((r, i) =>
          getLang("plugins.level.top_entry", i + 1, tag(r.jid), r[category.field] || 0),
        )
        .join("\n");
      await message.reply(getLang(category.key, lines), {
        mentions: top.map((r) => r.jid),
      });
    } catch (err) {
      console.error("level: button failed", safeLog(err));
      try {
        await message.reply(getLang("common.error"));
      } catch (_) {
        // nothing more to do
      }
    }
    return true;
  },
};
