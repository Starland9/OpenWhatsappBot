const { getLang } = require("../lib/utils/language");
const { GoogleGenAI } = require("@google/genai");
const config = require("../config");

/**
 * Imagen command - Generate images using Google's Imagen
 */
module.exports = {
  command: {
    pattern: "imagine|imagen",
    desc: "Generate images with Google Imagen AI",
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
        "❌ Please provide a description\n\nExample: .imagine a beautiful sunset over the ocean"
      );
    }

    try {
      await message.react("⏳");

      const genAI = new GoogleGenAI({
        apiKey: config.GEMINI_API_KEY,
      });

      // Use Imagen 3 for image generation
      const response = await genAI.models.generateImages({
        model: "imagen-4.0-fast-generate-001",
        prompt: query,
        number: 1,
        aspectRatio: "1:1",
      });

      if (!response.images || response.images.length === 0) {
        await message.react("❌");
        return await message.reply(
          "❌ No image was generated. Try a different prompt."
        );
      }

      // Get the first generated image
      const imageData = response.images[0];

      // Convert base64 to buffer
      const imageBuffer = Buffer.from(imageData.data, "base64");

      await message.react("✅");
      await message.sendImage(imageBuffer, `🎨 *Imagen AI*\n\n${query}`);
    } catch (error) {
      await message.react("❌");
      console.error("Imagen error:", error);

      // More detailed error message
      if (
        error.message.includes("quota") ||
        error.message.includes("rate limit")
      ) {
        await message.reply(
          "❌ API quota exceeded. Please try again later or upgrade your API plan."
        );
      } else if (
        error.message.includes("safety") ||
        error.message.includes("blocked")
      ) {
        await message.reply(
          "❌ Your prompt was blocked by content safety filters. Try a different description."
        );
      } else {
        await message.reply(`❌ Error: ${error.message}`);
      }
    }
  },
};
