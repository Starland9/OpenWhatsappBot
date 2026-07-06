/**
 * Activity Plugin
 * Track and display user activity statistics within groups
 */

const { UserActivity } = require("../lib/database");
const { Op } = require("sequelize");
const { jidNormalizedUser } = require("baileys");

const PAGE_SIZE = 10;

module.exports = {
  command: {
    pattern: "topactive|topinactive|activityrank|mystats|resetstats",
    desc: "Statistiques d'activité des membres du groupe",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const cmd = message.body.split(/\s+/)[0].slice(1).toLowerCase();

    if (cmd === "topactive") return handleTopActive(message, args);
    if (cmd === "topinactive") return handleTopInactive(message, args);
    if (cmd === "activityrank") return handleRank(message);
    if (cmd === "mystats") return handleMyStats(message);
    if (cmd === "resetstats") return handleReset(message);
  },
};

async function handleTopActive(message, args) {
  const n = parseInt(args) || PAGE_SIZE;
  const limit = Math.min(n, 20);

  const records = await UserActivity.findAll({
    where: { groupJid: message.jid },
    order: [["messageCount", "DESC"]],
    limit,
  });

  if (records.length === 0) {
    return await message.reply("📊 Aucune donnée d'activité pour ce groupe.\n\nEnvoyez des messages pour commencer à comptabiliser !");
  }

  const medals = ["🥇", "🥈", "🥉"];
  let text = `*📊 Top ${limit} Membres les Plus Actifs*\n\n`;

  records.forEach((r, i) => {
    const medal = medals[i] || `${i + 1}.`;
    const num = r.jid.split("@")[0];
    text += `${medal} @${num}\n   💬 ${r.messageCount} msgs | 📸 ${r.mediaCount} médias | 🎭 ${r.stickerCount} stickers\n\n`;
  });

  const lastUpdate = new Date().toLocaleDateString("fr-FR");
  text += `_Mise à jour : ${lastUpdate}_`;

  return await message.reply(text, { mentions: records.map((r) => r.jid) });
}

async function handleTopInactive(message, args) {
  const n = parseInt(args) || PAGE_SIZE;
  const limit = Math.min(n, 20);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const records = await UserActivity.findAll({
    where: {
      groupJid: message.jid,
      lastActive: { [Op.lt]: sevenDaysAgo },
    },
    order: [["lastActive", "ASC"]],
    limit,
  });

  if (records.length === 0) {
    return await message.reply("✅ Tous les membres ont été actifs ces 7 derniers jours !");
  }

  let text = `*😴 Top ${limit} Membres Inactifs (>7 jours)*\n\n`;
  records.forEach((r, i) => {
    const num = r.jid.split("@")[0];
    const daysAgo = Math.floor((Date.now() - new Date(r.lastActive).getTime()) / 86400000);
    text += `${i + 1}. @${num} — inactif depuis ${daysAgo} jour(s)\n`;
  });

  return await message.reply(text, { mentions: records.map((r) => r.jid) });
}

async function handleRank(message) {
  const allRecords = await UserActivity.findAll({
    where: { groupJid: message.jid },
    order: [["messageCount", "DESC"]],
  });

  const rank = allRecords.findIndex((r) => r.jid === message.sender) + 1;
  const myRecord = allRecords.find((r) => r.jid === message.sender);

  if (!myRecord) {
    return await message.reply("📊 Aucune activité enregistrée pour vous. Envoyez un message !");
  }

  const num = message.sender.split("@")[0];
  const total = allRecords.length;
  const percentile = Math.round(((total - rank) / total) * 100);

  return await message.reply(
    `*📊 Votre Rang d'Activité*\n\n` +
    `👤 @${num}\n` +
    `🏆 Rang : *#${rank}* sur ${total} membres\n` +
    `📈 Percentile : Top ${100 - percentile}%\n\n` +
    `💬 Messages : ${myRecord.messageCount}\n` +
    `📸 Médias : ${myRecord.mediaCount}\n` +
    `🎭 Stickers : ${myRecord.stickerCount}\n` +
    `🎙️ Vocaux : ${myRecord.voiceCount}`,
    { mentions: [message.sender] }
  );
}

async function handleMyStats(message) {
  const record = await UserActivity.findOne({
    where: { jid: message.sender, groupJid: message.jid },
  });

  if (!record) {
    return await message.reply("📊 Aucune statistique pour vous encore. Envoyez des messages !");
  }

  const lastActive = record.lastActive
    ? new Date(record.lastActive).toLocaleDateString("fr-FR")
    : "Inconnu";
  const joinDate = record.createdAt
    ? new Date(record.createdAt).toLocaleDateString("fr-FR")
    : "Inconnu";

  const num = message.sender.split("@")[0];
  return await message.reply(
    `*📊 Mes Statistiques d'Activité*\n\n` +
    `👤 @${num}\n\n` +
    `💬 Messages envoyés : *${record.messageCount}*\n` +
    `📸 Médias partagés : *${record.mediaCount}*\n` +
    `🎭 Stickers envoyés : *${record.stickerCount}*\n` +
    `🎙️ Messages vocaux : *${record.voiceCount}*\n\n` +
    `📅 Première activité : ${joinDate}\n` +
    `⏰ Dernière activité : ${lastActive}`,
    { mentions: [message.sender] }
  );
}

async function handleReset(message) {
  const isAdmin = await message.isSenderAdmin();
  if (!isAdmin && !message.isSudo()) {
    return await message.reply("❌ Réservé aux admins du groupe.");
  }

  const deleted = await UserActivity.destroy({ where: { groupJid: message.jid } });
  return await message.reply(
    `✅ *Statistiques réinitialisées !*\n\n${deleted} enregistrement(s) supprimé(s).`
  );
}
