const { getLang } = require("../lib/utils/language");
const { GoogleGenAI } = require("@google/genai");
const { downloadMedia } = require("../lib/baileys/mediaAdapter");
const config = require("../config");

/**
 * Gemini command - AI chat using Google Gemini with multimodal support
 */
module.exports = {
  command: {
    pattern: "gemini",
    desc: getLang("plugins.gemini.desc"),
    type: "ai",
  },

  async execute(message, query) {
    if (!config.GEMINI_API_KEY) {
      return await message.reply(getLang("plugins.gemini.Key"));
    }

    try {
      await message.react("⏳");

      const genAI = new GoogleGenAI({
        apiKey: config.GEMINI_API_KEY,
      });

      // Check for image in quoted message or current message
      let hasImage = false;
      let imageBuffer = null;

      if (message.quoted && message.quoted.message?.imageMessage) {
        const quotedShape = {
          key: message.quoted.key,
          message: message.quoted.message,
        };
        imageBuffer = await downloadMedia(
          message.client.getSocket(),
          quotedShape,
          "buffer",
        );
        hasImage = true;
      } else if (message.hasMedia && message.type === "imageMessage") {
        imageBuffer = await message.downloadMedia();
        hasImage = true;
      }

      // Allow overriding models via env for compatibility
      const MODEL_TEXT = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const MODEL_VISION =
        process.env.GEMINI_VISION_MODEL ||
        process.env.GEMINI_MODEL ||
        "gemini-2.5-flash";

      if (hasImage && imageBuffer) {
        // Use Gemini Vision for image analysis
        const base64Image = imageBuffer.toString("base64");
        const response = await genAI.models.generateContent({
          model: MODEL_VISION,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: query || "What's in this image? Describe it in detail.",
                },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: base64Image,
                  },
                },
              ],
            },
          ],
        });

        const text = response?.text;
        await message.react("✅");
        await message.reply(`🌟 *Gemini Vision*\n\n${text}`);
      } else {
        // Text-only query
        if (!query) {
          return await message.reply(getLang("plugins.gemini.example"));
        }

        const response = await genAI.models.generateContent({
          model: MODEL_TEXT,
          contents: query,
        });

        const text = response?.text;
        await message.react("✅");
        await message.reply(`🌟 *Gemini*\n\n${text}`);
      }
    } catch (error) {
      await message.react("❌");
      console.error("Gemini error:", error);
      // If model not found, give actionable hint
      if (
        error?.status === 404 ||
        (error?.message && error.message.includes("not found"))
      ) {
        await message.reply(
          `❌ Gemini model not found. Vérifie la variable GEMINI_MODEL ou GEMINI_VISION_MODEL. Erreur: ${error.message}`,
        );
      } else {
        await message.reply(`❌ Error: ${error.message}`);
      }
    }
  },
};
