const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Inspirational quotes (external API).
 *   .quoteof          → random quote
 *   .quoteof tech     → category (best-effort, ignored by API)
 */
module.exports = {
  command: {
    pattern: "quoteof|inspirational",
    desc: getLang("plugins.quoteof.desc"),
    type: "fun",
  },

  async execute(message) {
    try {
      await message.react("✨");
      let quote = null;
      let author = null;

      // Try Quotable
      try {
        const response = await axios.get("https://api.quotable.io/random", {
          timeout: 10000,
        });
        if (response.data && response.data.content) {
          quote = response.data.content;
          author = response.data.author;
        }
      } catch (e) {
        /* fallthrough */
      }

      // Try ZenQuotes
      if (!quote) {
        try {
          const response = await axios.get("https://zenquotes.io/api/random", {
            timeout: 10000,
          });
          if (response.data && response.data[0]) {
            quote = response.data[0].q;
            author = response.data[0].a;
          }
        } catch (e) {
          /* fallthrough */
        }
      }

      if (!quote) {
        return await message.reply(getLang("plugins.quoteof.api_error"));
      }

      await message.reply(
        `✨ *Quote of the Moment*\n\n_"${quote}"_\n\n— *${author || "Unknown"}*`,
      );
    } catch (err) {
      console.error("quoteof error:", err.message);
      await message.react("❌");
      await message.reply(getLang("plugins.quoteof.api_error"));
    }
  },
};
