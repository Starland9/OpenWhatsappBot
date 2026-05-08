const { getLang } = require("../lib/utils/language");

/**
 * Group Statistics Plugin - Analyze message activity in groups
 */

// Store message statistics
const groupStats = new Map(); // chatId -> {messages: Map<userJid, count>, words: Map<word, count>}

module.exports = {
  command: {
    pattern: "stats",
    desc: getLang("plugins.stats.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, query) {
    const chatId = message.jid;

    try {
      const action = query?.toLowerCase() || "summary";

      if (action === "reset") {
        // Only admins can reset stats
        const isAdmin = await message.isSenderAdmin();
        if (!isAdmin) {
          return await message.reply(getLang("plugins.common.not_admin"));
        }

        groupStats.delete(chatId);
        await message.react("✅");
        return await message.reply(`✅ ${getLang("plugins.stats.reset")}`);
      }

      // Get or create stats for this group
      if (!groupStats.has(chatId)) {
        return await message.reply(getLang("plugins.stats.no_data"));
      }

      const stats = groupStats.get(chatId);

      if (action === "summary" || action === "messages") {
        // Show message count per user
        const messageStats = Array.from(stats.messages.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        if (messageStats.length === 0) {
          return await message.reply(getLang("plugins.stats.no_messages"));
        }

        let response = `📊 *${getLang("plugins.stats.title")}*\n\n`;
        response += `📈 *${getLang("plugins.stats.top_users")}:*\n\n`;

        messageStats.forEach(([userJid, count], index) => {
          const number = userJid.split("@")[0];
          response += `${index + 1}. @${number}: ${count} ${getLang(
            "plugins.stats.messages_label"
          )}\n`;
        });

        response += `\n📝 _${getLang("plugins.stats.total_tracked")}: ${
          stats.messages.size
        } ${getLang("plugins.stats.users_label")}_`;

        const mentions = messageStats.map(([userJid]) => userJid);
        await message.client.getSocket().sendMessage(chatId, {
          text: response,
          mentions,
        });
      } else if (action === "words") {
        // Show most used words
        const wordStats = Array.from(stats.words.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20);

        if (wordStats.length === 0) {
          return await message.reply(getLang("plugins.stats.no_words"));
        }

        let response = `📊 *${getLang("plugins.stats.word_title")}*\n\n`;
        response += `🔤 *${getLang("plugins.stats.top_words")}:*\n\n`;

        wordStats.forEach(([word, count], index) => {
          response += `${index + 1}. ${word}: ${count}×\n`;
        });

        await message.reply(response);
      } else {
        await message.reply(getLang("plugins.stats.usage"));
      }
    } catch (error) {
      await message.react("❌");
      console.error("Stats error:", error);
      await message.reply(
        `❌ ${getLang("plugins.stats.error")}: ${error.message}`
      );
    }
  },
};

/**
 * Function to track messages (should be called from message handler)
 * Export this so it can be used by the message processor
 */
function trackMessage(chatId, userJid, messageText) {
  if (!messageText || messageText.startsWith(require("../config").PREFIX)) {
    return; // Don't track commands
  }

  if (!groupStats.has(chatId)) {
    groupStats.set(chatId, {
      messages: new Map(),
      words: new Map(),
    });
  }

  const stats = groupStats.get(chatId);

  // Track message count
  const currentCount = stats.messages.get(userJid) || 0;
  stats.messages.set(userJid, currentCount + 1);

  // Track words (only words with 3+ characters, exclude common words)
  const words = messageText
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => {
      // Remove punctuation and filter
      word = word.replace(/[^\w]/g, "");
      return word.length >= 3 && !isCommonWord(word);
    });

  words.forEach((word) => {
    const wordCount = stats.words.get(word) || 0;
    stats.words.set(word, wordCount + 1);
  });
}

function isCommonWord(word) {
  const commonWords = [
    "the",
    "and",
    "for",
    "are",
    "but",
    "not",
    "you",
    "all",
    "can",
    "her",
    "was",
    "one",
    "our",
    "out",
    "day",
    "get",
    "has",
    "him",
    "his",
    "how",
    "man",
    "new",
    "now",
    "old",
    "see",
    "two",
    "way",
    "who",
    "boy",
    "did",
    "its",
    "let",
    "put",
    "say",
    "she",
    "too",
    "use",
    "what",
    "when",
    "this",
    "that",
    "with",
    "have",
    "from",
    "they",
    "will",
    "your",
    "there",
    "been",
    "were",
    "said",
    "each",
    "which",
    "their",
    "about",
    "would",
    "these",
    "other",
  ];
  return commonWords.includes(word);
}

module.exports.trackMessage = trackMessage;
