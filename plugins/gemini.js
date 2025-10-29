const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config");

/**
 * Gemini command - AI chat using Google Gemini
 */
module.exports = {
  command: {
    pattern: "gemini|gem",
    desc: "Chat with Google Gemini AI",
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

      const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });

      const result = await model.generateContent(query);
      const response = await result.response;
      const text = response.text();

      await message.react("✅");
      await message.reply(`🌟 *Gemini AI*\n\n${text}`);
    } catch (error) {
      await message.react("❌");
      console.error("Gemini error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
