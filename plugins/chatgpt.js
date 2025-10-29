const OpenAI = require("openai");
const config = require("../config");

/**
 * ChatGPT command - AI chat using OpenAI
 */
module.exports = {
  command: {
    pattern: "gpt|ai|chatgpt",
    desc: "Chat with ChatGPT",
    type: "ai",
  },

  async execute(message, query) {
    if (!config.OPENAI_API_KEY) {
      return await message.reply(
        "❌ OpenAI API key not configured. Set OPENAI_API_KEY in config.env"
      );
    }

    if (!query) {
      return await message.reply(
        "❌ Please provide a question\n\nExample: .gpt What is Node.js?"
      );
    }

    try {
      await message.react("⏳");

      const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant integrated into a WhatsApp bot. Keep responses concise and friendly.",
          },
          {
            role: "user",
            content: query,
          },
        ],
        max_tokens: 1000,
        temperature: 0.7,
      });

      const response = completion.choices[0].message.content;

      await message.react("✅");
      await message.reply(`🤖 *ChatGPT*\n\n${response}`);
    } catch (error) {
      await message.react("❌");
      console.error("ChatGPT error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
