const { GoogleGenAI } = require("@google/genai");
const { extractMessageContent, getContentType } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const cooldown = require("../lib/utils/cooldown");
const config = require("../config");

/**
 * Gemini command - AI chat using Google Gemini with multimodal support
 *   .gemini <question>
 *   .gemini <question>   (with, or replying to, an image or a text)
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const COOLDOWN_MS = 5000;
// Gemini 2.5+ counts its thinking tokens in maxOutputTokens: leave room for them
const MAX_OUTPUT_TOKENS = 2048;
const SYSTEM_PROMPT =
  "You are a helpful assistant integrated into a WhatsApp bot. Keep responses concise and friendly. Answer in the language of the user's message.";
const BLOCK_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
  "RECITATION",
]);

/** Image attached to the command message, or to the message it quotes */
async function getImage(message) {
  if (message.hasMedia && message.type === "imageMessage") {
    const buffer = await message.downloadMedia();
    if (buffer) {
      return {
        buffer,
        mimetype: message.content?.imageMessage?.mimetype || "image/jpeg",
      };
    }
  }

  // Look at the type first so that a quoted video is never downloaded
  const quotedContent = extractMessageContent(message.quoted?.message);
  if (quotedContent && getContentType(quotedContent) === "imageMessage") {
    const media = await message.getQuotedMedia({ maxBytes: MAX_IMAGE_BYTES });
    if (media && media.type === "image") {
      return { buffer: media.buffer, mimetype: media.mimetype || "image/jpeg" };
    }
  }
  return null;
}

/** Lang key explaining why Gemini returned no text */
function emptyAnswerKey(response) {
  const blocked =
    !!response?.promptFeedback?.blockReason ||
    BLOCK_REASONS.has(response?.candidates?.[0]?.finishReason);
  return blocked ? "plugins.gemini.blocked" : "plugins.gemini.no_answer";
}

module.exports = {
  command: {
    pattern: "gemini",
    desc: getLang("plugins.gemini.desc"),
    type: "ai",
  },

  async execute(message, query, ctx) {
    if (!config.GEMINI_API_KEY) {
      return await message.reply(getLang("plugins.gemini.Key"));
    }

    const question = (ctx?.rawArgs ?? query ?? "").trim();
    const quotedText = message.getQuotedText();

    // Validate everything before reacting or spending a request
    const image = await getImage(message);
    if (!image && !question && !quotedText) {
      return await message.reply(getLang("plugins.gemini.example", config.PREFIX));
    }

    if (!message.isSudo()) {
      const wait = cooldown.hit(message.sender, "gemini", COOLDOWN_MS);
      if (wait) {
        return await message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
      }
    }

    try {
      await message.react("⏳");

      const genAI = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

      // Quoted text first (context), then the user's question
      const promptText =
        [quotedText, question].filter(Boolean).join("\n\n") ||
        getLang("plugins.gemini.default_image_prompt");

      const contents = image
        ? [
            {
              role: "user",
              parts: [
                { text: promptText },
                {
                  inlineData: {
                    mimeType: image.mimetype,
                    data: image.buffer.toString("base64"),
                  },
                },
              ],
            },
          ]
        : promptText;

      const response = await genAI.models.generateContent({
        model: image ? config.GEMINI_VISION_MODEL : config.GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.7,
          httpOptions: { timeout: REQUEST_TIMEOUT_MS },
        },
      });

      // `text` is undefined when the answer is empty or blocked
      const text = response?.text?.trim();
      if (!text) {
        await message.react("❌");
        return await message.reply(getLang(emptyAnswerKey(response)));
      }

      await message.react("✅");
      await message.reply(
        getLang(image ? "plugins.gemini.reply_vision" : "plugins.gemini.reply", text),
      );
    } catch (error) {
      await message.react("❌");
      console.error("Gemini error:", safeLog(error));
      if (error?.status === 404) {
        // Wrong GEMINI_MODEL / GEMINI_VISION_MODEL
        return await message.reply(getLang("plugins.gemini.model_not_found"));
      }
      await message.reply(
        getLang(replyKeyFor(classifyError(error, { hasKey: !!config.GEMINI_API_KEY }))),
      );
    }
  },
};
