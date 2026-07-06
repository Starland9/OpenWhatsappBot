const { UserStats } = require("../lib/database");
const { getLang } = require("../lib/utils/language");
const { sendList, sendQuickReplies } = require("./buttons");
const { Op } = require("sequelize");
const config = require("../config");

const CATEGORIES = {
  chat: { field: "messageCount", label: "💬 Top Chatters", desc: "Most messages sent" },
  media: { field: "mediaCount", label: "🖼 Top Media Senders", desc: "Most media shared" },
  cmds: { field: "commandCount", label: "⚙ Top Commanders", desc: "Most bot commands used" },
  xp: { field: "xp", label: "🏆 Top XP", desc: "Highest experience" },
};

const PAGE_SIZE = 5;

/**
 * Group leaderboard with category picker, pagination, and quick-reply navigation.
 */
module.exports = {
  command: {
    pattern: "top|active|leaderboard|lb",
    desc: getLang("plugins.leaderboard.desc"),
    type: "stats",
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const args = (argsString || "").trim().toLowerCase();
    const parts = args.split(/\s+/);
    const cat = parts[0];
    const page = Math.max(0, parseInt(parts[1] || "0", 10) || 0);

    if (!cat || !CATEGORIES[cat]) {
      // Show category picker
      const sections = [
        {
          title: "Categories",
          rows: Object.entries(CATEGORIES).map(([k, v]) => ({
            id: `top:cat:${k}`,
            title: v.label,
            description: v.desc,
          })),
        },
      ];
      return await sendList(sock, message.jid, getLang("plugins.leaderboard.pick"), sections, {
        title: getLang("plugins.leaderboard.title"),
        buttonLabel: "📊 Pick category",
        footer: "OpenWhatsappBot",
        quoted: message.data,
      });
    }

    return await this._showCategory(sock, message, cat, page);
  },

  async _showCategory(sock, message, cat, page) {
    const { field, label } = CATEGORIES[cat];
    const offset = page * PAGE_SIZE;
    const rows = await UserStats.findAll({
      where: { groupJid: message.jid },
      order: [[field, "DESC"]],
      limit: PAGE_SIZE,
      offset,
    });
    const total = await UserStats.count({ where: { groupJid: message.jid } });
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    if (rows.length === 0) {
      return await message.reply(getLang("plugins.leaderboard.empty", cat));
    }

    const text =
      `${label}\n_Page ${page + 1}/${totalPages}_\n\n` +
      rows
        .map((r, i) => `  ${offset + i + 1}. @${r.jid.split("@")[0]} — _${r[field] || 0} ${field}_`)
        .join("\n");

    const navButtons = [];
    if (page > 0) navButtons.push({ id: `top:nav:${cat}:${page - 1}`, text: "◀ Prev" });
    if (page < totalPages - 1) navButtons.push({ id: `top:nav:${cat}:${page + 1}`, text: "Next ▶" });
    navButtons.push({ id: `top:catmenu`, text: "🔀 Categories" });

    try {
      return await sendQuickReplies(sock, message.jid, text, navButtons, {
        title: label,
        footer: `Page ${page + 1}/${totalPages}`,
        quoted: message.data,
      });
    } catch (e) {
      return await message.reply(text, { mentions: rows.map((r) => r.jid) });
    }
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("top:")) return false;
    const parts = message.body.slice("top:".length).split(":");
    if (parts[0] === "nav" && parts.length === 3) {
      const cat = parts[1];
      const page = parseInt(parts[2], 10) || 0;
      if (!CATEGORIES[cat]) return false;
      await this._showCategory(message.client.getSocket(), message, cat, page);
      return true;
    }
    if (parts[0] === "cat") {
      const cat = parts[1];
      if (!CATEGORIES[cat]) return false;
      await this._showCategory(message.client.getSocket(), message, cat, 0);
      return true;
    }
    if (parts[0] === "catmenu") {
      const sections = [
        {
          title: "Categories",
          rows: Object.entries(CATEGORIES).map(([k, v]) => ({
            id: `top:cat:${k}`,
            title: v.label,
            description: v.desc,
          })),
        },
      ];
      await sendList(
        message.client.getSocket(),
        message.jid,
        getLang("plugins.leaderboard.pick"),
        sections,
        {
          title: getLang("plugins.leaderboard.title"),
          buttonLabel: "📊 Pick category",
          footer: "OpenWhatsappBot",
          quoted: message.data,
        }
      );
      return true;
    }
    return false;
  },
};
