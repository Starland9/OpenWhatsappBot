const statusListStore = require("../lib/utils/statusListStore");

module.exports = {
  command: {
    pattern: "statussave|ss",
    desc: "Gérer l'auto-save des statuses (on/off/add/rm/list)",
    type: "admin",
    fromMe: false,
    onlyGroup: false,
    onlyPm: false,
  },

  async execute(message, argsString = "") {
    if (!message.isSudo()) return await message.reply("Permission refusée.");

    const parts = argsString.trim().split(/\s+/).filter(Boolean);
    const cmd = parts[0] ? parts[0].toLowerCase() : "";

    try {
      if (!cmd || cmd === "help") {
        return await message.reply(
          "Usage: statussave on|off|add <number>|rm <number>|list",
        );
      }

      if (cmd === "on") {
        const st = await statusListStore.setEnabled(true);
        return await message.reply(
          `Auto status save activé. Liste: ${st.list.join(", ")}`,
        );
      }

      if (cmd === "off") {
        const st = await statusListStore.setEnabled(false);
        return await message.reply(`Auto status save désactivé.`);
      }

      if (cmd === "add") {
        const num = parts[1];
        if (!num)
          return await message.reply(
            "Spécifie un numéro à ajouter (sans @...).",
          );
        const st = await statusListStore.add(num);
        return await message.reply(`Ajouté. Liste: ${st.list.join(", ")}`);
      }

      if (cmd === "rm" || cmd === "remove" || cmd === "del") {
        const num = parts[1];
        if (!num) return await message.reply("Spécifie un numéro à supprimer.");
        const st = await statusListStore.remove(num);
        return await message.reply(`Retiré. Liste: ${st.list.join(", ")}`);
      }

      if (cmd === "list") {
        const st = await statusListStore.get();
        return await message.reply(
          `Auto save: ${st.enabled ? "ON" : "OFF"}\nListe: ${st.list.join(", ") || "(vide)"}`,
        );
      }

      return await message.reply(
        "Commande inconnue. Utilise: on|off|add|rm|list",
      );
    } catch (err) {
      console.error("statussave plugin error:", err);
      return await message.reply(
        "Erreur interne lors de la commande statussave.",
      );
    }
  },
};
