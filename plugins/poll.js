const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Poll Plugin - Create interactive polls in groups
 */

// Store poll data
const polls = new Map(); // messageId -> {question, options, votes}

module.exports = {
  command: {
    pattern: "vote",
    desc: getLang("plugins.poll.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, query) {
    const chatId = message.jid;

    try {
      if (!query) {
        return await message.reply(getLang("plugins.poll.usage"));
      }

      // Parse poll format: poll Question? Option1, Option2, Option3
      const parts = query.split("?");
      if (parts.length < 2) {
        return await message.reply(getLang("plugins.poll.format_error"));
      }

      const question = parts[0].trim() + "?";
      const optionsText = parts[1].trim();

      const options = optionsText
        .split(",")
        .map((opt) => opt.trim())
        .filter((opt) => opt.length > 0);

      if (options.length < 2) {
        return await message.reply(getLang("plugins.poll.min_options"));
      }

      if (options.length > 12) {
        return await message.reply(getLang("plugins.poll.max_options"));
      }

      await message.react("📊");

      try {
        // Try to send native WhatsApp poll (requires recent WhatsApp version)
        await message.sendPoll(question, options, { selectableCount: 1 });
        await message.react("✅");
      } catch (pollError) {
        // Fallback to manual poll with reactions
        console.log("Native poll not supported, using manual poll");

        const emojis = [
          "1️⃣",
          "2️⃣",
          "3️⃣",
          "4️⃣",
          "5️⃣",
          "6️⃣",
          "7️⃣",
          "8️⃣",
          "9️⃣",
          "🔟",
          "🅰️",
          "🅱️",
        ];

        let pollMessage = `📊 *${getLang("plugins.poll.title")}*\n\n`;
        pollMessage += `❓ *${question}*\n\n`;

        options.forEach((option, index) => {
          pollMessage += `${emojis[index]} ${option}\n`;
        });

        pollMessage += `\n_${getLang("plugins.poll.instruction")}_`;

        const sentMsg = await message.reply(pollMessage);

        // Store poll data
        if (sentMsg && sentMsg.key) {
          polls.set(sentMsg.key.id, {
            question,
            options,
            votes: new Map(), // emoji -> [userJids]
            created: Date.now(),
            chatId,
          });
        }

        await message.react("✅");
      }
    } catch (error) {
      await message.react("❌");
      console.error("Poll error:", error);
      await message.reply(
        `❌ ${getLang("plugins.poll.error")}: ${error.message}`
      );
    }
  },
};
