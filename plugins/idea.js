const { getLang } = require("../lib/utils/language");
const { Idea } = require("../lib/database");
const { sendList, sendQuickReplies } = require("./buttons");
const { Op } = require("sequelize");

const CATEGORIES = {
  general: "general",
  feature: "feature",
  event: "event",
  rule: "rule",
  fun: "fun",
  other: "other",
};

/**
 * Group idea/suggestion box with voting and pagination.
 */
module.exports = {
  command: {
    pattern: "idea|idee|suggest",
    desc: getLang("plugins.idea.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const args = (argsString || "").trim();
    const parts = args.split(/\s+/);
    const sub = (parts[0] || "").toLowerCase();

    if (sub === "add" || sub === "new") {
      return await this._add(message, args.slice(sub.length + 1));
    }
    if (sub === "list" || sub === "") {
      return await this._list(sock, message, 0);
    }
    if (sub === "top" || sub === "best") {
      return await this._top(sock, message);
    }
    if (sub === "vote" || sub === "v") {
      return await this._vote(message, parts[1]);
    }
    if (sub === "delete" || sub === "del") {
      return await this._delete(message, parts[1]);
    }

    // Default: show idea menu
    const buttons = [
      { id: `idea:add:${message.jid}`, text: "➕ Add Idea" },
      { id: `idea:list:${message.jid}:0`, text: "📋 List" },
      { id: `idea:top:${message.jid}`, text: "🏆 Top" },
    ];
    return await sendQuickReplies(sock, message.jid, getLang("plugins.idea.menu"), buttons, {
      title: "💡 Ideas",
      footer: "OpenWhatsappBot",
      quoted: message.data,
    });
  },

  async _add(message, text) {
    if (!text || text.trim().length < 3) {
      return await message.reply(getLang("plugins.idea.usage", require("../config").PREFIX));
    }
    const idea = await Idea.create({
      groupJid: message.jid,
      authorJid: message.sender,
      text: text.trim().slice(0, 1000),
      voters: [],
    });
    await message.react("📝");
    return await message.reply(getLang("plugins.idea.added", idea.id));
  },

  async _list(sock, message, page) {
    const PAGE = 5;
    const ideas = await Idea.findAll({
      where: { groupJid: message.jid },
      order: [["createdAt", "DESC"]],
      limit: PAGE,
      offset: page * PAGE,
    });
    if (ideas.length === 0) {
      return await message.reply(getLang("plugins.idea.empty"));
    }
    const total = await Idea.count({ where: { groupJid: message.jid } });
    const totalPages = Math.max(1, Math.ceil(total / PAGE));

    const text =
      `💡 *Ideas* — Page ${page + 1}/${totalPages}\n\n` +
      ideas
        .map((i) => `  #${i.id} — _${i.text.slice(0, 60)}${i.text.length > 60 ? "..." : ""}_ — ❤️ ${(i.voters || []).length}`)
        .join("\n");

    const nav = [];
    if (page > 0) nav.push({ id: `idea:list:${message.jid}:${page - 1}`, text: "◀ Prev" });
    if (page < totalPages - 1) nav.push({ id: `idea:list:${message.jid}:${page + 1}`, text: "Next ▶" });
    nav.push({ id: `idea:add:${message.jid}`, text: "➕ Add" });

    try {
      return await sendQuickReplies(sock, message.jid, text, nav, {
        title: "💡 Ideas",
        footer: `Page ${page + 1}/${totalPages}`,
        quoted: message.data,
      });
    } catch (e) {
      return await message.reply(text);
    }
  },

  async _top(sock, message) {
    const ideas = await Idea.findAll({
      where: { groupJid: message.jid },
      order: [["createdAt", "DESC"]],
      limit: 50,
    });
    ideas.sort((a, b) => (b.voters || []).length - (a.voters || []).length);
    const top = ideas.slice(0, 5);
    if (top.length === 0) return await message.reply(getLang("plugins.idea.empty"));
    const text =
      `🏆 *Top Ideas*\n\n` +
      top
        .map((i, idx) => `  ${idx + 1}. _${i.text.slice(0, 60)}${i.text.length > 60 ? "..." : ""}_ — ❤️ ${(i.voters || []).length}`)
        .join("\n");
    return await message.reply(text);
  },

  async _vote(message, idStr) {
    const id = parseInt(idStr, 10);
    if (!id) return await message.reply(getLang("plugins.idea.usage", require("../config").PREFIX));
    const idea = await Idea.findOne({ where: { id, groupJid: message.jid } });
    if (!idea) return await message.reply(getLang("plugins.idea.not_found", id));
    const voters = idea.voters || [];
    if (voters.includes(message.sender)) {
      // unvote
      idea.voters = voters.filter((v) => v !== message.sender);
      await idea.save();
      return await message.reply(getLang("plugins.idea.unvoted", id, idea.voters.length));
    }
    idea.voters = [...voters, message.sender];
    await idea.save();
    return await message.reply(getLang("plugins.idea.voted", id, idea.voters.length));
  },

  async _delete(message, idStr) {
    if (!message.isSudo() && !(await message.isSenderAdmin())) {
      return await message.reply(getLang("plugins.common.not_admin"));
    }
    const id = parseInt(idStr, 10);
    if (!id) return await message.reply(getLang("plugins.idea.usage", require("../config").PREFIX));
    const deleted = await Idea.destroy({ where: { id, groupJid: message.jid } });
    if (!deleted) return await message.reply(getLang("plugins.idea.not_found", id));
    return await message.reply(getLang("plugins.idea.deleted", id));
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("idea:")) return false;
    const parts = message.body.split(":");
    const action = parts[1];
    if (action === "add") {
      // User picked "Add Idea" — wait for text
      await message.reply(getLang("plugins.idea.usage", require("../config").PREFIX));
      return true;
    }
    if (action === "list" && parts.length >= 4) {
      const page = parseInt(parts[3], 10) || 0;
      await this._list(message.client.getSocket(), message, page);
      return true;
    }
    if (action === "top") {
      await this._top(message.client.getSocket(), message);
      return true;
    }
    return false;
  },
};
