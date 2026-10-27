const OpenAI = require("openai");
const { extractMessageContent, getContentType } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const cooldown = require("../lib/utils/cooldown");
const config = require("../config");

/**
 * ChatGPT command - AI chat using OpenAI with multimodal support
 *   .gpt <question>
 *   .gpt <question>   (with, or replying to, an image)
 */

// gpt-4o-mini is scheduled for removal on 2027-01-14: set OPENAI_MODEL to override
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const COOLDOWN_MS = 5000;
const SYSTEM_PROMPT =
  "You are a helpful assistant integrated into a WhatsApp bot. Keep responses concise and friendly. Answer in the language of the user's message.";

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

module.exports = {
  command: {
    pattern: "gpt",
    desc: getLang("plugins.chatgpt.desc"),
    type: "ai",
  },

  async execute(message, query, ctx) {
    if (!config.OPENAI_API_KEY) {
      return await message.reply(getLang("common.not_configured"));
    }

    const question = (ctx?.rawArgs ?? query ?? "").trim();
    const quotedText = message.getQuotedText();

    // Validate everything before reacting or spending a request
    const image = await getImage(message);
    if (!image && !question && !quotedText) {
      return await message.reply(getLang("plugins.chatgpt.usage", config.PREFIX));
    }

    if (!message.isSudo()) {
      const wait = cooldown.hit(message.sender, "gpt", COOLDOWN_MS);
      if (wait) {
        return await message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
      }
    }

    try {
      await message.react("⏳");

      const openai = new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        timeout: 60000,
        maxRetries: 0,
      });

      const prompt =
        [quotedText, question].filter(Boolean).join("\n\n") ||
        getLang("plugins.chatgpt.default_image_prompt");

      const userContent = image
        ? [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${image.mimetype};base64,${image.buffer.toString("base64")}`,
              },
            },
          ]
        : prompt;

      const completion = await openai.chat.completions.create({
        model: config.OPENAI_MODEL || DEFAULT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_completion_tokens: 1000,
      });

      const answer = completion?.choices?.[0]?.message?.content?.trim();
      if (!answer) {
        await message.react("❌");
        return await message.reply(getLang("plugins.chatgpt.no_answer"));
      }

      await message.react("✅");
      await message.reply(
        getLang(image ? "plugins.chatgpt.reply_vision" : "plugins.chatgpt.reply", answer),
      );
    } catch (error) {
      await message.react("❌");
      console.error("ChatGPT error:", safeLog(error));
      await message.reply(
        getLang(replyKeyFor(classifyError(error, { hasKey: !!config.OPENAI_API_KEY }))),
      );
    }
  },
};
