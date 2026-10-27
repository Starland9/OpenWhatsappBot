const { GoogleGenAI } = require("@google/genai");
const { getLang } = require("../lib/utils/language");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const cooldown = require("../lib/utils/cooldown");
const config = require("../config");

/**
 * Imagen command - generate an image from a text prompt with Google's image models.
 *
 * The imagen-4.0-* models were shut down on 2026-08-17. The replacement is a Gemini
 * native image model ("Nano Banana"), called through generateContent with the IMAGE
 * response modality; the image comes back as base64 `inlineData` in the parts.
 * Set IMAGE_MODEL to use another model. An `imagen-*` id still goes through
 * generateImages (Vertex or older projects).
 */

const DEFAULT_MODEL = "gemini-nano-banana-2.1";
const ASPECT_RATIO = "1:1";
const REQUEST_TIMEOUT_MS = 90000;
const COOLDOWN_MS = 20000;
const MAX_PROMPT_LENGTH = 1500;
const MAX_CAPTION_LENGTH = 900;
const BLOCK_REASONS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "RECITATION",
]);

const truncate = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

const isImagenModel = (model) => /^imagen-/i.test(model);

/**
 * Ask the model for one image.
 * @returns {Promise<{ buffer: Buffer|null, blocked: boolean }>}
 */
async function generate(prompt) {
  const model = config.IMAGE_MODEL || DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  const httpOptions = { timeout: REQUEST_TIMEOUT_MS };

  if (isImagenModel(model)) {
    const response = await ai.models.generateImages({
      model,
      prompt,
      config: { numberOfImages: 1, aspectRatio: ASPECT_RATIO, httpOptions },
    });
    const image = response?.generatedImages?.[0];
    return {
      buffer: image?.image?.imageBytes
        ? Buffer.from(image.image.imageBytes, "base64")
        : null,
      blocked: !!image?.raiFilteredReason,
    };
  }

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: ASPECT_RATIO },
      httpOptions,
    },
  });
  return extractImage(response);
}

/** Pull the first image out of a generateContent response */
function extractImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const part = parts.find(
    (p) => p?.inlineData?.data && /^image\//i.test(p.inlineData.mimeType || "image/png"),
  );
  if (part) {
    return { buffer: Buffer.from(part.inlineData.data, "base64"), blocked: false };
  }
  const blocked =
    !!response?.promptFeedback?.blockReason ||
    BLOCK_REASONS.has(response?.candidates?.[0]?.finishReason);
  return { buffer: null, blocked };
}

/**
 * Image generation is not part of the free Gemini tier: the API answers 429 with
 * "limit: 0" (or 403 / FAILED_PRECONDITION about billing) for a free key.
 */
function isPaidOnlyError(error) {
  const status = error?.status ?? error?.response?.status;
  const text = String(error?.message || "");
  if (status === 429) return /limit:\s*0\b/i.test(text);
  if (status === 403) return true;
  return status === 400 && /billing|paid|FAILED_PRECONDITION/i.test(text);
}

module.exports = {
  command: {
    pattern: "imagen",
    desc: getLang("plugins.imagen.desc"),
    type: "ai",
  },

  async execute(message, query, ctx) {
    if (!config.GEMINI_API_KEY) {
      return await message.reply(getLang("plugins.imagen.no_key"));
    }

    const prompt = (ctx?.rawArgs ?? query ?? "").trim();
    if (!prompt) {
      return await message.reply(getLang("plugins.imagen.no_query", config.PREFIX));
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return await message.reply(getLang("plugins.imagen.too_long", MAX_PROMPT_LENGTH));
    }

    if (!message.isSudo()) {
      const wait = cooldown.hit(message.sender, "imagen", COOLDOWN_MS);
      if (wait) {
        return await message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
      }
    }

    try {
      await message.react("⏳");

      const { buffer, blocked } = await generate(prompt);
      if (!buffer || buffer.length === 0) {
        await message.react("❌");
        return await message.reply(
          getLang(blocked ? "plugins.imagen.safety" : "plugins.imagen.no_image"),
        );
      }

      await message.react("✅");
      await message.sendImage(
        buffer,
        getLang("plugins.imagen.caption", truncate(prompt, MAX_CAPTION_LENGTH)),
      );
    } catch (error) {
      await message.react("❌");
      console.error("Imagen error:", safeLog(error));

      if (isPaidOnlyError(error)) {
        return await message.reply(getLang("plugins.imagen.paid_only"));
      }
      if (error?.status === 404) {
        // Wrong or retired IMAGE_MODEL
        return await message.reply(getLang("plugins.imagen.model_not_found"));
      }
      await message.reply(
        getLang(replyKeyFor(classifyError(error, { hasKey: true }))),
      );
    }
  },

  // exported for tests
  extractImage,
  isPaidOnlyError,
};
