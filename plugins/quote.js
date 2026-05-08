const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Quote Plugin
 * Get inspirational quotes
 */

module.exports = {
  command: {
    pattern: "quote",
    desc: "Get a random inspirational quote",
    type: "fun",
  },

  async execute(message, args) {
    try {
      await message.react("✨");

      // Try multiple quote APIs
      let quote = null;
      let author = null;

      // Method 1: Quotable API
      try {
        const response = await axios.get("https://api.quotable.io/random", {
          timeout: 10000,
        });

        if (response.data && response.data.content) {
          quote = response.data.content;
          author = response.data.author;
        }
      } catch (e) {
        console.log("Quotable API failed");
      }

      // Method 2: ZenQuotes API
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
          console.log("ZenQuotes API failed");
        }
      }

      if (quote) {
        const quoteMsg = `✨ *Quote of the Moment*

_"${quote}"_

— *${author || "Unknown"}*`;

        await message.reply(quoteMsg);
        await message.react("✅");
      } else {
        await message.reply(
          "*Couldn't fetch a quote right now!*\n\nPlease try again later."
        );
        await message.react("❌");
      }
    } catch (error) {
      console.error("Quote error:", error);
      await message.reply("*Error fetching quote!*");
      await message.react("❌");
    }
  },
};
