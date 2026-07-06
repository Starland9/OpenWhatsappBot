const { getLang } = require("../lib/utils/language");
const { UserStats } = require("../lib/database");
const { sendList, sendQuickReplies } = require("./buttons");
const { Op } = require("sequelize");

/**
 * Group statistics dashboard: total messages, top user, top command, peak hour.
 *   .groupinfo         → overview
 *   .groupinfo detail  → drill-down (most active users, peak hour)
 */
module.exports = {
  command: {
    pattern: "groupinfo|ginfo|stats2",
    desc: getLang("plugins.groupinfo.desc"),
    type: "stats",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const arg = (argsString || "").trim().toLowerCase();
    const total = await UserStats.count({ where: { groupJid: message.jid } });
    if (total === 0) {
      return await message.reply(getLang("plugins.groupinfo.empty"));
    }

    const [totals] = await UserStats.findAll({
      where: { groupJid: message.jid },
      attributes: [
        [UserStats.sequelize.fn("SUM", UserStats.sequelize.col("messageCount")), "totalMessages"],
        [UserStats.sequelize.fn("SUM", UserStats.sequelize.col("commandCount")), "totalCommands"],
        [UserStats.sequelize.fn("SUM", UserStats.sequelize.col("mediaCount")), "totalMedia"],
        [UserStats.sequelize.fn("MAX", UserStats.sequelize.col("xp")), "topXp"],
      ],
      raw: true,
    });

    const topUser = await UserStats.findOne({
      where: { groupJid: message.jid },
      order: [["messageCount", "DESC"]],
    });
    const topXp = await UserStats.findOne({
      where: { groupJid: message.jid },
      order: [["xp", "DESC"]],
    });

    const text =
      `📊 *Group Stats*\n\n` +
      `👥 Tracked users: _${total}_\n` +
      `💬 Total messages: _${totals.totalMessages || 0}_\n` +
      `⚙ Total commands: _${totals.totalCommands || 0}_\n` +
      `🖼 Total media: _${totals.totalMedia || 0}_\n` +
      (topUser
        ? `🏆 Most active: @${topUser.jid.split("@")[0]} _(${topUser.messageCount} msgs)_\n`
        : "") +
      (topXp
        ? `⭐ Highest XP: @${topXp.jid.split("@")[0]} _(${topXp.xp} XP)_\n`
        : "");

    const mentions = [];
    if (topUser) mentions.push(topUser.jid);
    if (topXp && topXp.jid !== topUser?.jid) mentions.push(topXp.jid);

    const buttons = [
      { id: `ginfo:detail:${message.jid}`, text: "🔍 Top 5" },
      { id: `ginfo:peak:${message.jid}`, text: "⏰ Peak Hours" },
      { id: `ginfo:menu:${message.jid}`, text: "📋 More" },
    ];
    try {
      return await sendQuickReplies(sock, message.jid, text, buttons, {
        title: "📊 Group Info",
        footer: "OpenWhatsappBot",
        quoted: message.data,
      });
    } catch (e) {
      return await message.reply(text, { mentions });
    }
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("ginfo:")) return false;
    const parts = message.body.split(":");
    const action = parts[1];

    if (action === "detail") {
      const top = await UserStats.findAll({
        where: { groupJid: message.jid },
        order: [["messageCount", "DESC"]],
        limit: 5,
      });
      if (top.length === 0) {
        await message.reply(getLang("plugins.groupinfo.empty"));
        return true;
      }
      const text = `📊 *Top 5 in this group*\n\n` +
        top
          .map((r, i) => `  ${i + 1}. @${r.jid.split("@")[0]} — _${r.messageCount} msgs / ${r.xp} XP (Lv.${r.level || 0})_`)
          .join("\n");
      await message.reply(text, { mentions: top.map((r) => r.jid) });
      return true;
    }

    if (action === "peak") {
      const all = await UserStats.findAll({
        where: { groupJid: message.jid },
        attributes: ["lastActiveAt"],
        raw: true,
      });
      const hours = new Array(24).fill(0);
      for (const r of all) {
        if (r.lastActiveAt) hours[new Date(r.lastActiveAt).getHours()] += 1;
      }
      const peak = hours.indexOf(Math.max(...hours));
      const text = `⏰ *Peak Hour*\n\n` +
        hours
          .map((c, h) => `  ${String(h).padStart(2, "0")}:00 — _${c} msgs_`)
          .join("\n") +
        `\n\n_Peak: ${String(peak).padStart(2, "0")}:00_`;
      await message.reply("```\n" + text + "\n```");
      return true;
    }

    if (action === "menu") {
      const sections = [
        {
          title: "Stats",
          rows: [
            { id: `top:cat:chat`, title: "💬 Top Chatters", description: "Most active" },
            { id: `top:cat:media`, title: "🖼 Top Media", description: "Most media shared" },
            { id: `top:cat:cmds`, title: "⚙ Top Commands", description: "Most commands" },
            { id: `top:cat:xp`, title: "🏆 Top XP", description: "Highest experience" },
          ],
        },
      ];
      await sendList(
        message.client.getSocket(),
        message.jid,
        getLang("plugins.leaderboard.pick"),
        sections,
        {
          title: getLang("plugins.leaderboard.title"),
          buttonLabel: "📊 Pick",
          footer: "OpenWhatsappBot",
          quoted: message.data,
        }
      );
      return true;
    }

    return false;
  },
};
