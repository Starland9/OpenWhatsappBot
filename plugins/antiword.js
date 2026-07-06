/**
 * Anti-Word Plugin
 * Manage banned words in groups
 */

const { Group } = require("../lib/database");
const { invalidateCache } = require("../lib/utils/antiwordHandler");

module.exports = {
  command: {
    pattern: "antiword",
    desc: "Gérer les mots bannis dans le groupe",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const isAdmin = await message.isSenderAdmin();
    if (!isAdmin && !message.isSudo()) {
      return await message.reply("❌ Réservé aux admins du groupe.");
    }

    const [group] = await Group.findOrCreate({
      where: { jid: message.jid },
      defaults: { jid: message.jid },
    });

    const parts = (args || "").trim().split(/\s+/);
    const sub = parts[0].toLowerCase();
    const word = parts.slice(1).join(" ").toLowerCase().trim();

    if (sub === "add" && word) {
      const current = group.bannedWords
        ? group.bannedWords
            .split(",")
            .map((w) => w.trim())
            .filter(Boolean)
        : [];
      if (current.includes(word)) {
        return await message.reply(`❌ *"${word}"* est déjà dans la liste.`);
      }
      current.push(word);
      await group.update({ bannedWords: current.join(",") });
      invalidateCache(message.jid);
      return await message.reply(
        `✅ Mot *"${word}"* ajouté à la liste des mots bannis.`,
      );
    }

    if (sub === "remove" && word) {
      const current = group.bannedWords
        ? group.bannedWords
            .split(",")
            .map((w) => w.trim())
            .filter(Boolean)
        : [];
      const filtered = current.filter((w) => w !== word);
      if (filtered.length === current.length) {
        return await message.reply(`❌ *"${word}"* n'est pas dans la liste.`);
      }
      await group.update({ bannedWords: filtered.join(",") });
      invalidateCache(message.jid);
      return await message.reply(`✅ Mot *"${word}"* retiré de la liste.`);
    }

    if (sub === "list") {
      const words = group.bannedWords
        ? group.bannedWords
            .split(",")
            .map((w) => w.trim())
            .filter(Boolean)
        : [];
      if (words.length === 0) {
        return await message.reply("📋 Aucun mot banni dans ce groupe.");
      }
      return await message.reply(
        `*📋 Mots bannis (${words.length}) :*\n\n${words.map((w, i) => `${i + 1}. ${w}`).join("\n")}`,
      );
    }

    if (sub === "clear") {
      await group.update({ bannedWords: "" });
      invalidateCache(message.jid);
      return await message.reply("✅ Liste des mots bannis effacée.");
    }

    return await message.reply(
      `*🚫 Anti-Word*\n\n*Usage :*\n.antiword add <mot> → ajouter\n.antiword remove <mot> → retirer\n.antiword list → afficher la liste\n.antiword clear → tout effacer`,
    );
  },
};
