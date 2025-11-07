const { getLang } = require("../lib/utils/language");
const { GoogleGenAI } = require("@google/genai");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const config = require("../config");

/**
 * Gemini command - AI chat using Google Gemini with multimodal support
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

    try {
      await message.react("⏳");

      const genAI = new GoogleGenAI({
        apiKey: config.GEMINI_API_KEY,
      });

      // Check for image in quoted message or current message
      let hasImage = false;
      let imageBuffer = null;

      if (message.quoted && message.quoted.message?.imageMessage) {
        imageBuffer = await downloadMediaMessage(
          message.quoted,
          "buffer",
          {},
          {
            logger: { info() {}, error() {}, warn() {} },
            reuploadRequest: message.client.getSocket().updateMediaMessage,
          }
        );
        hasImage = true;
      } else if (message.hasMedia && message.type === "imageMessage") {
        imageBuffer = await message.downloadMedia();
        hasImage = true;
      }

      if (hasImage && imageBuffer) {
        // Use Gemini Vision for image analysis
        const base64Image = imageBuffer.toString("base64");

        const response = await genAI.models.generateContent({
          model: "gemini-2.0-flash-exp",
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

        const text = response.text;
        await message.react("✅");
        await message.reply(`🌟 *Gemini Vision*\n\n${text}`);
      } else {
        // Text-only query
        if (!query) {
          return await message.reply(getLang("plugins.gemini.example"));
        }

        const response = await genAI.models.generateContent({
          model: "gemini-2.5-flash-lite",
          contents: query,
        });

        const text = response.text;
        await message.react("✅");
        await message.reply(`🌟 *Gemini*\n\n${text}`);
      }
    } catch (error) {
      await message.react("❌");
      console.error("Gemini error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
