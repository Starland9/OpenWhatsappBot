const { getLang } = require("../lib/utils/language");
const { downloadMedia } = require("../lib/baileys/mediaAdapter");
const OpenAI = require("openai");
const config = require("../config");

/**
 * ChatGPT command - AI chat using OpenAI with multimodal support
 */
module.exports = {
  command: {
    pattern: "gpt",
    desc: getLang("plugins.groq.desc"),
    type: "ai",
  },

  async execute(message, query) {
    if (!config.OPENAI_API_KEY) {
      return await message.reply(
        "❌ OpenAI API key not configured. Set OPENAI_API_KEY in config.env",
      );
    }

    try {
      await message.react("⏳");

      const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      const messages = [
        {
          role: "system",
          content:
            "You are a helpful assistant integrated into a WhatsApp bot. Keep responses concise and friendly.",
        },
      ];

      // Check for image in quoted message or current message
      let hasImage = false;
      let imageBuffer = null;

      if (message.quoted && message.quoted.message?.imageMessage) {
        // Normalize quoted message shape
        const quotedMessage = {
          key: {
            remoteJid: message.jid,
            id: message.quoted.id,
          },
          message: message.quoted.message,
        };

        imageBuffer = await downloadMedia(
          message.client.getSocket(),
          quotedMessage,
          "buffer",
        );
        hasImage = true;
      } else if (message.hasMedia && message.type === "imageMessage") {
        imageBuffer = await message.downloadMedia();
        hasImage = true;
      }

      if (hasImage && imageBuffer) {
        // Use GPT-4 Vision for image analysis
        const base64Image = imageBuffer.toString("base64");

        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: query || "What's in this image? Describe it in detail.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        });

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 1000,
        });

        const response = completion.choices[0].message.content;
        await message.react("✅");
        await message.reply(`🤖 *ChatGPT Vision*\n\n${response}`);
      } else {
        // Text-only query
        if (!query) {
          return await message.reply(
            "❌ Please provide a question or reply to an image\n\nExample: .gpt What is Node.js?",
          );
        }

        messages.push({
          role: "user",
          content: query,
        });

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 1000,
          temperature: 0.7,
        });

        const response = completion.choices[0].message.content;
        await message.react("✅");
        await message.reply(`🤖 *ChatGPT*\n\n${response}`);
      }
    } catch (error) {
      await message.react("❌");
      console.error("ChatGPT error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
