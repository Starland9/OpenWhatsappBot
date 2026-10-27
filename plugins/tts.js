const gtts = require("google-tts-api");
const { translate } = require("@vitalets/google-translate-api");
const config = require("../config");
const { getLang } = require("../lib/utils/language");
const {
  fetchBuffer,
  withTimeout,
  classifyError,
  replyKeyFor,
  safeLog,
} = require("../lib/utils/http");
const { runFfmpeg } = require("../lib/utils/ffmpeg");
const { withTempDir } = require("../lib/utils/media");
const fs = require("fs").promises;
const path = require("path");

// "en", "fra" or "zh-CN"
const LANG_RE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;
// Language code written by the user between braces, e.g. {es}
const LANG_TOKEN_RE = /\{([a-z]{2,3}(?:-[a-z]{2,4})?)\}/i;
const TTS_HOST = "https://translate.google.com";
// Break long texts on these too, so that text without spaces (CJK) can be cut
const SPLIT_PUNCT = ",.?;!:。！？，、；：";
const DETECT_TIMEOUT_MS = 10000;

function maxTextLength() {
  return Number(config.TTS_MAX_LENGTH) || 500;
}

function defaultLang() {
  const lang = String(config.LANG || "en").toLowerCase();
  return LANG_RE.test(lang) ? lang : "en";
}

// "zh-cn" -> "zh-CN": Google TTS wants the region in upper case
function normalizeLang(code) {
  const [language, region] = String(code).split("-");
  return region
    ? `${language.toLowerCase()}-${region.toUpperCase()}`
    : language.toLowerCase();
}

/**
 * Language of a text, detected by Google Translate (`raw.src`).
 * Falls back to `fallback` when detection fails or takes too long.
 */
async function detectLanguage(text, fallback) {
  try {
    const result = await withTimeout(
      () => translate(text.slice(0, 500), { to: fallback }),
      DETECT_TIMEOUT_MS,
      "language detection",
    );
    const detected = result?.raw?.src;
    if (typeof detected === "string" && LANG_RE.test(detected) && detected !== "und") {
      return normalizeLang(detected);
    }
  } catch (error) {
    console.error("TTS language detection error:", safeLog(error));
  }
  return fallback;
}

/**
 * Speech for a text, as an audio buffer `message.sendVoice` can send.
 * Google TTS takes 200 characters at most: longer texts are cut into several
 * pieces that are then joined (and encoded to ogg/opus) with ffmpeg.
 * Also used by the `speak` command (plugins/voice.js).
 * @param {string} text - single line
 * @param {string} lang - e.g. "fr", "zh-CN"
 * @returns {Promise<Buffer>} mp3 (one piece) or ogg/opus (several pieces)
 */
async function synthesizeSpeech(text, lang) {
  const pieces = gtts.getAllAudioUrls(text, {
    lang,
    slow: false,
    host: TTS_HOST,
    splitPunct: SPLIT_PUNCT,
  });
  if (!pieces.length) throw new Error("No audio to generate");

  const audio = await Promise.all(
    pieces.map(async ({ url }) => {
      const { buffer } = await fetchBuffer(url, {
        maxBytes: 5 * 1024 * 1024,
        timeoutMs: 20000,
      });
      return buffer;
    }),
  );
  if (audio.length === 1) return audio[0];

  return withTempDir(async (dir) => {
    const files = [];
    for (let i = 0; i < audio.length; i++) {
      const file = path.join(dir, `piece${i}.mp3`);
      await fs.writeFile(file, audio[i]);
      files.push(file);
    }
    const inputs = files.flatMap((file) => ["-i", file]);
    const labels = files.map((_, i) => `[${i}:a]`).join("");
    const { stdout } = await runFfmpeg(
      [
        ...inputs,
        "-filter_complex",
        `${labels}concat=n=${files.length}:v=0:a=1[out]`,
        "-map", "[out]",
        "-c:a", "libopus",
        "-b:a", "24k",
        "-ar", "48000",
        "-ac", "1",
        "-f", "ogg",
        "pipe:1",
      ],
      { timeout: 60000 },
    );
    return stdout;
  });
}

/**
 * Text to Speech Plugin
 * Convert text to a voice note in multiple languages
 */
module.exports = {
  command: {
    pattern: "tts",
    desc: getLang("plugins.tts.desc"),
    type: "utility",
  },

  synthesizeSpeech,

  async execute(message, args, ctx) {
    const usage = () =>
      message.reply(
        `${getLang("common.usage_prefix")}\n${getLang("plugins.tts.usage", config.PREFIX, maxTextLength())}`,
      );

    // A language code can be given anywhere in the typed text
    let typed = String(ctx?.rawArgs ?? args ?? "");
    const langMatch = typed.match(LANG_TOKEN_RE);
    if (langMatch) typed = typed.replace(langMatch[0], " ");
    typed = typed.replace(/\s+/g, " ").trim();

    const text =
      typed || message.getQuotedText().replace(/\s+/g, " ").trim();

    if (!text) {
      return langMatch
        ? await message.reply(getLang("plugins.tts.empty_text"))
        : await usage();
    }
    if (text.length > maxTextLength()) {
      return await message.reply(
        getLang("plugins.tts.text_too_long", maxTextLength()),
      );
    }

    await message.react("🎤");

    try {
      const lang = langMatch
        ? normalizeLang(langMatch[1])
        : await detectLanguage(text, defaultLang());

      const audio = await synthesizeSpeech(text, lang);
      await message.sendVoice(audio);
      await message.react("✅");
    } catch (error) {
      console.error("TTS error:", safeLog(error));
      await message.react("❌");

      // Google answers 400 to a language it doesn't know
      if (langMatch && error?.response?.status === 400) {
        return await message.reply(
          getLang("plugins.tts.invalid_lang", langMatch[1]),
        );
      }
      const kind = classifyError(error);
      await message.reply(
        getLang(kind === "error" ? "plugins.tts.error" : replyKeyFor(kind)),
      );
    }
  },
};
