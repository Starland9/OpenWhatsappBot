/**
 * Group Rules Plugin
 * Set and display group rules
 */

const { Group } = require("../lib/database");

module.exports = {
  command: {
    pattern: "rules",
    desc: "Afficher ou définir les règles du groupe",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const [group] = await Group.findOrCreate({
      where: { jid: message.jid },
      defaults: { jid: message.jid },
    });

    const parts = (args || "").trim();

    // Set rules (admin only)
    if (parts.toLowerCase().startsWith("set ")) {
      const isAdmin = await message.isSenderAdmin();
      if (!isAdmin && !message.isSudo()) {
        return await message.reply("❌ Réservé aux admins du groupe.");
      }

      const newRules = parts.slice(4).trim();
      if (!newRules) return await message.reply("❌ Fournissez le texte des règles.");

      // Auto-number lines if they don't already start with a number
      const lines = newRules.split(/[|;,\n]+/).map((l) => l.trim()).filter(Boolean);
      const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");

      await group.update({ rules: numbered });
      return await message.reply(`✅ *Règles du groupe mises à jour !*\n\n${numbered}`);
    }

    if (parts.toLowerCase() === "clear") {
      const isAdmin = await message.isSenderAdmin();
      if (!isAdmin && !message.isSudo()) {
        return await message.reply("❌ Réservé aux admins du groupe.");
      }
      await group.update({ rules: "" });
      return await message.reply("✅ Règles effacées.");
    }

    // Display rules
    if (!group.rules || group.rules.trim() === "") {
      return await message.reply(
        "📋 Aucune règle définie pour ce groupe.\n\n*Admins :* utilisez `.rules set Règle1 | Règle2 | Règle3`"
      );
    }

    return await message.reply(
      `*📋 Règles du Groupe*\n\n${group.rules}\n\n_Respectez les règles pour une bonne ambiance !_ 🙏`
    );
  },
};
