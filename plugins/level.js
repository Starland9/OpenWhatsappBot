const { UserStats } = require("../lib/database");
const { getLang } = require("../lib/utils/language");
const { sendQuickReplies } = require("./buttons");
const { computeLevel } = require("./trackmessages");
const config = require("../config");

const XP_PER_LEVEL = 100;

function xpForLevel(level) {
  return level * level * XP_PER_LEVEL;
}

function progressBar(current, target, length = 12) {
  const ratio = Math.max(0, Math.min(1, (current - xpForLevel(Math.floor(Math.sqrt(current / XP_PER_LEVEL)))) / (target - xpForLevel(Math.floor(Math.sqrt(current / XP_PER_LEVEL))))));
  const filled = Math.round(ratio * length);
  return "▓".repeat(filled) + "░".repeat(length - filled);
}

/**
 * Show current user XP, level, progress bar, and top-3 in the group.
 */
module.exports = {
  command: {
    pattern: "level|xp|rank",
    desc: getLang("plugins.level.desc"),
    type: "stats",
  },

  async execute(message, argsString) {
    const sub = (argsString || "").trim().toLowerCase();

    // Resolve target
    let target = message.sender;
    if (message.mentions && message.mentions.length > 0) target = message.mentions[0];
    else if (message.quoted) target = message.quoted.sender;

    const [row] = await UserStats.findOrCreate({
      where: { jid: target, groupJid: message.jid },
      defaults: { messageCount: 0, commandCount: 0, mediaCount: 0, xp: 0, level: 0 },
    });

    const level = row.level || computeLevel(row.xp || 0);
    const currentLevelXp = xpForLevel(level);
    const nextLevelXp = xpForLevel(level + 1);
    const progress = (row.xp || 0) - currentLevelXp;
    const needed = nextLevelXp - currentLevelXp;
    const bar = progressBar(row.xp || 0, nextLevelXp);

    if (sub === "global" || (message.isGroup === false && !sub)) {
      // Global rank
      const higher = await UserStats.count({ where: { xp: { [require("sequelize").Op.gt]: row.xp || 0 } } });
      const text = getLang("plugins.level.card", row.xp || 0, level, bar, progress, needed, higher + 1);
      return await message.reply(text);
    }

    if (sub === "top" || (message.isGroup && !sub)) {
      // Show self + top 3 in the group
      const top = await UserStats.findAll({
        where: { groupJid: message.jid },
        order: [["xp", "DESC"]],
        limit: 3,
      });
      const higher = await UserStats.count({
        where: {
          groupJid: message.jid,
          xp: { [require("sequelize").Op.gt]: row.xp || 0 },
        },
      });

      const lines = top
        .map((r, i) => `  ${i + 1}. @${r.jid.split("@")[0]} — _${r.xp || 0} XP (Lv.${r.level || 0})_`)
        .join("\n");

      const text = getLang("plugins.level.card_group", row.xp || 0, level, bar, progress, needed, higher + 1, lines);
      const mentions = top.map((r) => r.jid);
      if (message.isGroup) mentions.push(target);

      const buttons = [
        { id: `level:top:chat`, text: "💬 Top Chat" },
        { id: `level:top:media`, text: "🖼 Top Media" },
        { id: `level:top:cmds`, text: "⚙ Top Cmd" },
      ];

      try {
        return await sendQuickReplies(message.client.getSocket(), message.jid, text, buttons, {
          title: getLang("plugins.level.title"),
          footer: "OpenWhatsappBot",
          quoted: message.data,
        });
      } catch (e) {
        return await message.reply(text, { mentions });
      }
    }

    return await message.reply(getLang("plugins.level.usage", config.PREFIX));
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("level:top:")) return false;
    const cat = message.body.slice("level:top:".length);
    const valid = ["chat", "media", "cmds"];
    if (!valid.includes(cat)) return false;

    const sortField = cat === "chat" ? "messageCount" : cat === "media" ? "mediaCount" : "commandCount";
    const top = await UserStats.findAll({
      where: { groupJid: message.jid },
      order: [[sortField, "DESC"]],
      limit: 5,
    });

    const text = getLang(
      "plugins.level.top_" + cat,
      top
        .map((r, i) => `  ${i + 1}. @${r.jid.split("@")[0]} — _${r[sortField] || 0}_`)
        .join("\n")
    );
    await message.reply(text, { mentions: top.map((r) => r.jid) });
    return true;
  },
};
