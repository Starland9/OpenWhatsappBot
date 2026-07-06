/**
 * Reputation Plugin
 * Group reputation system — give +rep to members, view leaderboard
 */

const { Reputation } = require("../lib/database");

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

module.exports = {
  command: {
    pattern: "rep",
    desc: "Système de réputation : donner un +rep ou voir le classement",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const sub = (args || "").toLowerCase().trim();

    // Show leaderboard
    if (sub === "list" || sub === "top") {
      const top = await Reputation.findAll({
        where: { groupJid: message.jid },
        order: [["reputation", "DESC"]],
        limit: 10,
      });

      if (top.length === 0) {
        return await message.reply("📊 Aucune réputation dans ce groupe encore. Donnez des +rep !");
      }

      const medals = ["🥇", "🥈", "🥉"];
      let text = "*🏆 Classement Réputation*\n\n";
      top.forEach((r, i) => {
        const medal = medals[i] || `${i + 1}.`;
        const num = r.jid.split("@")[0];
        text += `${medal} @${num} — ⭐ ${r.reputation} rep\n`;
      });

      return await message.reply(text, { mentions: top.map((r) => r.jid) });
    }

    // Give +rep
    const target =
      message.mentions?.[0] ||
      message.quoted?.sender ||
      null;

    if (!target) {
      return await message.reply(
        `*⭐ Réputation*\n\n*Usage :*\n• Mentionnez ou répondez à quelqu'un\n.rep @user → donner +1 rep\n.rep list → classement\n\n*Cooldown :* 24h par personne`
      );
    }

    if (target === message.sender) {
      return await message.reply("❌ Vous ne pouvez pas vous donner de réputation à vous-même !");
    }

    // Check cooldown: check if THIS sender already gave to THIS target in the last 24h
    const giverKey = `${message.jid}:${message.sender}:${target}`;
    // Simple in-memory cooldown map
    if (!module.exports._cooldowns) module.exports._cooldowns = new Map();
    const lastGiven = module.exports._cooldowns.get(giverKey) || 0;
    const now = Date.now();
    if (now - lastGiven < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - lastGiven)) / 3600000);
      return await message.reply(`⏱️ Vous avez déjà donné un rep à cet utilisateur. Réessayez dans ~${remaining}h.`);
    }

    // Update reputation
    const [record] = await Reputation.findOrCreate({
      where: { jid: target, groupJid: message.jid },
      defaults: { jid: target, groupJid: message.jid, reputation: 0 },
    });

    await record.increment({ reputation: 1 });
    module.exports._cooldowns.set(giverKey, now);

    const num = target.split("@")[0];
    const senderNum = message.sender.split("@")[0];
    const newRep = record.reputation + 1;

    return await message.reply(
      `⭐ @${senderNum} a donné +1 rep à @${num} !\n\n${num} a maintenant *${newRep} rep* 🎉`,
      { mentions: [message.sender, target] }
    );
  },
};
