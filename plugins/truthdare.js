const { getLang } = require("../lib/utils/language");
const { Group } = require("../lib/database");

/**
 * Action ou Vérité / Truth or Dare plugin
 * Usage: .av [truth|dare|mode|get|on|off]
 */

const MODES = ["mild", "flirty", "romantic", "adult"];

const ITEMS = {
  mild: {
    truth: [
      "Quel est ton film préféré ?",
      "Quelle est ta pire habitude ?",
      "Quel est ton souvenir d'enfance préféré ?",
      "As-tu déjà menti pour sortir d'un rendez-vous ?",
    ],
    dare: [
      "Envoie une photo de ton sourire maintenant (optionnel).",
      "Fais une blague pendant 30 secondes.",
      "Imite une célébrité pendant 20 secondes.",
      "Chante le refrain de ta chanson préférée.",
    ],
  },
  flirty: {
    truth: [
      "Qu'est-ce que tu trouves le plus attirant chez ton/ta partenaire ?",
      "Quelle a été ta première pensée en voyant ton/ta partenaire aujourd'hui ?",
      "Quelle est ta partie préférée chez ton/ta partenaire ?",
    ],
    dare: [
      "Envoie un message coquin en 10 secondes (garde-le non explicite si public).",
      "Donne un bisou visible à la caméra (si privé).",
      "Envoie un compliment sincère, très détaillé.",
    ],
  },
  romantic: {
    truth: [
      "Raconte le moment le plus romantique que tu as vécu.",
      "Quelle est ta plus grande qualité selon toi ?",
      "Que ferais-tu pour surprendre ton/ta partenaire ?",
    ],
    dare: [
      "Écris un petit poème de 2 lignes à ton/ta partenaire.",
      "Envoie un message vocal doux de 10 secondes.",
      "Fais une déclaration romantique en 20 secondes.",
    ],
  },
  adult: {
    truth: [
      "Quelle est ta plus grande fantaisie (réponds discrètement) ?",
      "As-tu déjà eu un rendez-vous très chaud ? Raconte une anecdote brève.",
    ],
    dare: [
      "Rien de graphique : envoie un ton suggestif par message vocal.",
      "Garde une main derrière ton dos et fais un compliment coquin.",
    ],
  },
};

module.exports = {
  command: {
    pattern: "av",
    desc: getLang("plugins.truthdare.desc") || "Action ou Vérité (jeu)",
    type: "fun",
  },

  async execute(message, argsString) {
    const args = (argsString || "").trim();
    const sub = args.split(" ")[0]?.toLowerCase() || "";
    const chatId = message.jid;

    // For group configurations we use Group model
    let group = null;
    try {
      group = await Group.findOne({ where: { jid: chatId } });
      if (!group) {
        // Create default group entry if missing
        group = await Group.create({
          jid: chatId,
          name: (await message.getGroupMetadata())?.subject || "Unknown",
        });
      }
    } catch (err) {
      console.error("Error loading group for truthdare:", err);
    }

    // Manage mode and on/off if the sender is admin or sudo (for groups)
    if (sub === "mode") {
      // Only in group or sudo/admin can change
      if (message.isGroup) {
        const isAdmin = await message.isSenderAdmin();
        if (!isAdmin && !message.isSudo())
          return await message.reply(getLang("common.not_admin"));
      }

      const rest = args.split(" ").slice(1).join(" ").trim();
      if (!rest || rest === "get") {
        const current = (group && group.truthDareMode) || "mild";
        return await message.reply(
          getLang("plugins.truthdare.mode_status").replace("{0}", current)
        );
      }

      if (rest === "on" || rest === "off") {
        const enable = rest === "on";
        if (group) {
          group.truthDareEnabled = enable;
          await group.save();
        }
        return await message.reply(
          getLang("plugins.truthdare.mode_updated").replace(
            "{0}",
            enable
              ? getLang("common.status_enabled")
              : getLang("common.status_disabled")
          )
        );
      }

      if (!MODES.includes(rest)) {
        return await message.reply(getLang("plugins.truthdare.mode_invalid"));
      }

      // Adult mode safety: require sudo/admin to enable
      if (rest === "adult" && message.isGroup) {
        const isAdmin = await message.isSenderAdmin();
        if (!isAdmin && !message.isSudo()) {
          return await message.reply(
            getLang("plugins.truthdare.adult_requires_admin")
          );
        }
      }

      // Save mode
      if (group) {
        group.truthDareMode = rest;
        group.truthDareEnabled = true;
        await group.save();
      }

      return await message.reply(
        getLang("plugins.truthdare.mode_changed").replace("{0}", rest)
      );
    }

    if (sub === "on" || sub === "off") {
      if (message.isGroup) {
        const isAdmin = await message.isSenderAdmin();
        if (!isAdmin && !message.isSudo())
          return await message.reply(getLang("common.not_admin"));
      }
      const enable = sub === "on";
      if (group) {
        group.truthDareEnabled = enable;
        await group.save();
      }
      return await message.reply(
        getLang("plugins.truthdare.mode_updated").replace(
          "{0}",
          enable
            ? getLang("common.status_enabled")
            : getLang("common.status_disabled")
        )
      );
    }

    // Show help only if explicitly asked for; otherwise an empty args means random
    if (sub === "help" || sub === "usage") {
      return await message.reply(getLang("plugins.truthdare.usage"));
    }

    // Check if enabled
    if (group && !group.truthDareEnabled) {
      return await message.reply(getLang("plugins.truthdare.disabled"));
    }

    // Determine mode
    const mode = group?.truthDareMode || "mild";

    // Specific truth/dare
    if (sub === "truth" || sub === "t") {
      const list = ITEMS[mode].truth;
      const item = list[Math.floor(Math.random() * list.length)];
      return await message.reply(
        `🔍 *${getLang("plugins.truthdare.truth")}*\n\n${item}`
      );
    }

    if (sub === "dare" || sub === "a" || sub === "action") {
      const list = ITEMS[mode].dare;
      const item = list[Math.floor(Math.random() * list.length)];
      return await message.reply(
        `🎲 *${getLang("plugins.truthdare.dare")}*\n\n${item}`
      );
    }

    // Random truth or dare
    if (sub === "random" || args === "") {
      const choose = Math.random() > 0.5 ? "truth" : "dare";
      const list = ITEMS[mode][choose];
      const item = list[Math.floor(Math.random() * list.length)];
      const emoji = choose === "truth" ? "🔍" : "🎲";
      const label =
        choose === "truth"
          ? getLang("plugins.truthdare.truth")
          : getLang("plugins.truthdare.dare");
      return await message.reply(`${emoji} *${label}*\n\n${item}`);
    }

    // unknown action
    return await message.reply(getLang("plugins.truthdare.usage"));
  },
};
