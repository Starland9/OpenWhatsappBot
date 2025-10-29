const { getLang } = require("../lib/utils/language");
const { GoogleGenAI } = require("@google/genai");
const config = require("../config");

/**
 * Gemini command - AI chat using Google Gemini
 */
module.exports = {
  command: {
    pattern: "gemini|gem",
    desc: getLang("plugins.gemini.desc"),
    type: "ai",
  },

  async execute(message, query) {
    if (!config.GEMINI_API_KEY) {
      return await message.reply(getLang("plugins.gemini.Key"));
    }

    if (!query) {
      return await message.reply(getLang("plugins.gemini.example"));
    }

    try {
      await message.react("⏳");

      const genAI = new GoogleGenAI({
        apiKey: config.GEMINI_API_KEY,
      });
      const response = await genAI.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: query,
      });

      const text = response.text;

      await message.react("✅");
      await message.reply(`${text}`);
    } catch (error) {
      await message.react("❌");
      console.error("Gemini error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
