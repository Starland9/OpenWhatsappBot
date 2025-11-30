const { getLang } = require("../lib/utils/language");
const { AutoResponder } = require("../lib/database");
const config = require("../config");

/**
 * Auto Responder Management Plugin
 */
module.exports = {
  command: {
    pattern: "ar",
    desc: getLang("plugins.autorespond.desc"),
    type: "settings",
    fromMe: true,
  },

  async execute(message, query) {
    try {
      const args = query.trim().split(/\s+/);
      const action = args[0]?.toLowerCase();

      // Get or create settings
      let settings = await AutoResponder.findOne({ where: { id: 1 } });
      if (!settings) {
        settings = await AutoResponder.create({
          id: 1,
          ignoreNumbers: config.AUTO_RESPONDER_IGNORE_NUMBERS,
          personality: config.AUTO_RESPONDER_PERSONALITY,
          enabled: config.AUTO_RESPONDER_ENABLED,
        });
      }

      // Handle commands
      if (!action || action === "status") {
        const ignoreList = settings.ignoreNumbers
          ? settings.ignoreNumbers
              .split(",")
              .map((n) => n.trim())
              .filter(Boolean)
          : [];

        const statusMsg = getLang("plugins.autorespond.status")
          .replace("{0}", settings.enabled ? "✅ Enabled" : "❌ Disabled")
          .replace(
            "{1}",
            ignoreList.length > 0 ? ignoreList.join(", ") : "None"
          )
          .replace("{2}", settings.personality.substring(0, 100) + "...");

        return await message.reply(statusMsg);
      }

      if (action === "on") {
        if (!config.GEMINI_API_KEY) {
          return await message.reply(getLang("plugins.autorespond.no_api_key"));
        }

        await settings.update({ enabled: true });
        await message.react("✅");
        return await message.reply(getLang("plugins.autorespond.enabled"));
      }

      if (action === "off") {
        await settings.update({ enabled: false });
        await message.react("✅");
        return await message.reply(getLang("plugins.autorespond.disabled"));
      }

      if (action === "ignore") {
        const subAction = args[1]?.toLowerCase();

        if (subAction === "add" && args[2]) {
          const number = args[2].replace(/[^0-9]/g, "");
          const currentIgnore = settings.ignoreNumbers
            ? settings.ignoreNumbers
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean)
            : [];

          if (currentIgnore.includes(number)) {
            return await message.reply(
              getLang("plugins.autorespond.already_ignored")
            );
          }

          currentIgnore.push(number);
          await settings.update({ ignoreNumbers: currentIgnore.join(",") });
          await message.react("✅");
          return await message.reply(
            getLang("plugins.autorespond.number_ignored").replace("{0}", number)
          );
        }

        if (subAction === "remove" && args[2]) {
          const number = args[2].replace(/[^0-9]/g, "");
          const currentIgnore = settings.ignoreNumbers
            ? settings.ignoreNumbers
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean)
            : [];

          const filtered = currentIgnore.filter((n) => n !== number);

          if (filtered.length === currentIgnore.length) {
            return await message.reply(
              getLang("plugins.autorespond.not_ignored")
            );
          }

          await settings.update({ ignoreNumbers: filtered.join(",") });
          await message.react("✅");
          return await message.reply(
            getLang("plugins.autorespond.number_unignored").replace(
              "{0}",
              number
            )
          );
        }

        if (subAction === "list") {
          const ignoreList = settings.ignoreNumbers
            ? settings.ignoreNumbers
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean)
            : [];

          if (ignoreList.length === 0) {
            return await message.reply(
              getLang("plugins.autorespond.no_ignored")
            );
          }

          return await message.reply(
            getLang("plugins.autorespond.ignored_list") +
              "\n" +
              ignoreList.map((n, i) => `${i + 1}. ${n}`).join("\n")
          );
        }

        if (subAction === "clear") {
          await settings.update({ ignoreNumbers: "" });
          await message.react("✅");
          return await message.reply(
            getLang("plugins.autorespond.ignore_cleared")
          );
        }

        return await message.reply(getLang("plugins.autorespond.ignore_usage"));
      }

      if (action === "personality") {
        const personality = args.slice(1).join(" ");

        if (!personality) {
          return await message.reply(
            getLang("plugins.autorespond.current_personality") +
              "\n\n" +
              settings.personality
          );
        }

        await settings.update({ personality });
        await message.react("✅");
        return await message.reply(
          getLang("plugins.autorespond.personality_updated")
        );
      }

      // Show usage
      return await message.reply(getLang("plugins.autorespond.usage"));
    } catch (error) {
      await message.react("❌");
      console.error("Auto responder error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
