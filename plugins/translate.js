const { translate } = require("@vitalets/google-translate-api");
const { decode } = require("html-entities");
const { getLang } = require("../lib/utils/language");
const { fetchJson, withTimeout, classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const config = require("../config");

/**
 * Translation Plugin
 *   .trt <lang> <text>     translate the text into <lang>
 *   .trt <text>            translate into the bot language (config.LANG)
 *   .trt [lang]            as a reply to a message: translate that message
 * Google Translate (scraper) first, MyMemory when it fails.
 */

const TIMEOUT_MS = 10000;
const MAX_TEXT_LENGTH = 4000;
const MYMEMORY_MAX_LENGTH = 500; // MyMemory refuses longer queries

// ISO 639-1 codes supported by Google Translate (and, for the most part, MyMemory)
const LANGUAGES = new Set(
  (
    "af am ar az be bg bn bs ca co cs cy da de el en eo es et eu fa fi fr fy ga gd gl gu " +
    "ha he hi hr ht hu hy id ig is it ja jv ka kk km kn ko ku ky la lb lo lt lv mg mi mk " +
    "ml mn mr ms mt my ne nl no ny pa pl ps pt ro ru sd si sk sl sm sn so sq sr st su sv " +
    "sw ta te tg th tl tr uk ur uz vi xh yi yo zh zu"
  ).split(" "),
);

/** "FR" → "fr", "zh" → "zh-CN"; null when it is not a language code */
function normalizeLang(code) {
  const lower = String(code || "").toLowerCase();
  if (lower === "zh" || lower === "zh-cn") return "zh-CN";
  if (lower === "zh-tw") return "zh-TW";
  return LANGUAGES.has(lower) ? lower : null;
}

/** Target language when none is given: the bot language */
function defaultTarget() {
  return normalizeLang((config.LANG || "").slice(0, 2)) || "en";
}

/**
 * Split the command arguments.
 * @returns {{ target: string|null, text: string, invalid: boolean }}
 */
function parseInput(input, quotedText) {
  if (quotedText) {
    // As a reply the only argument is the target language
    const word = input.split(/\s+/)[0];
    const target = word ? normalizeLang(word) : null;
    return { target, text: quotedText, invalid: !!word && !target };
  }

  const match = input.match(/^(\S+)\s+([\s\S]+)$/);
  const target = match ? normalizeLang(match[1]) : null;
  if (target) return { target, text: match[2].trim(), invalid: false };

  // A lone language code is not a text to translate
  if (normalizeLang(input)) return { target: null, text: "", invalid: false };
  return { target: null, text: input, invalid: false };
}

async function googleTranslate(text, to) {
  const result = await withTimeout(
    translate(text, { to, fetchOptions: { signal: AbortSignal.timeout(TIMEOUT_MS) } }),
    TIMEOUT_MS,
    "translate",
  );
  return result?.text || null;
}

async function myMemoryTranslate(text, to) {
  const data = await fetchJson("https://api.mymemory.translated.net/get", {
    params: { q: text, langpair: `autodetect|${to}` },
    timeoutMs: TIMEOUT_MS,
  });
  // responseStatus is 200 (number) on success; errors come as text in translatedText
  if (Number(data?.responseStatus) !== 200 || data?.quotaFinished) return null;
  const translated = data?.responseData?.translatedText;
  return typeof translated === "string" && translated ? decode(translated) : null;
}

module.exports = {
  command: {
    pattern: "trt|translate|tr",
    desc: getLang("plugins.translate.desc"),
    type: "utility",
  },

  async execute(message, query, ctx) {
    const input = (ctx?.rawArgs ?? query ?? "").trim();
    const { target, text, invalid } = parseInput(input, message.getQuotedText().trim());

    if (invalid) {
      return await message.reply(getLang("plugins.translate.invalid_lang", config.PREFIX));
    }
    if (!text) {
      return await message.reply(getLang("plugins.translate.usage", config.PREFIX));
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return await message.reply(getLang("plugins.translate.too_long", MAX_TEXT_LENGTH));
    }

    const to = target || defaultTarget();

    try {
      await message.react("⏳");

      let translated = null;
      let firstError = null;
      try {
        translated = await googleTranslate(text, to);
      } catch (error) {
        firstError = error;
        console.warn("Google Translate failed:", safeLog(error));
      }

      if (!translated && text.length <= MYMEMORY_MAX_LENGTH) {
        try {
          translated = await myMemoryTranslate(text, to);
        } catch (error) {
          firstError = firstError || error;
          console.warn("MyMemory failed:", safeLog(error));
        }
      }

      if (!translated) {
        throw firstError || new Error("Empty translation");
      }

      await message.react("✅");
      await message.reply(translated);
    } catch (error) {
      await message.react("❌");
      console.error("Translation error:", safeLog(error));
      await message.reply(getLang(replyKeyFor(classifyError(error))));
    }
  },
};
