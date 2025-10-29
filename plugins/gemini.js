const { GoogleGenAI } = require("@google/genai");
const config = require("../config");

/**
 * Gemini command - AI chat using Google Gemini
 */
module.exports = {
  command: {
    pattern: "gemini|gem",
    desc: "Chat with Google Gemini 1.5 Flash",
    type: "ai",
  },

  async execute(message, query) {
    if (!config.GEMINI_API_KEY) {
      return await message.reply(
        "❌ Gemini API key not configured. Set GEMINI_API_KEY in config.env"
      );
    }

    if (!query) {
      return await message.reply(
        "❌ Please provide a question\n\nExample: .gemini Explain quantum computing"
      );
    }

    try {
      await message.react("⏳");

      const genAI = new GoogleGenAI({
        apiKey: config.GEMINI_API_KEY,
      });
      const response = await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: query,
      });

      const text = response.text;

      await message.react("✅");
      await message.reply(`🌟\n${text}`);
    } catch (error) {
      await message.react("❌");
      console.error("Gemini error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
