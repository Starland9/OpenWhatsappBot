const fs = require("fs").promises;
const path = require("path");
const { extractMessageContent, getContentType } = require("baileys");
const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { runFfmpeg } = require("../lib/utils/ffmpeg");
const { withTempDir } = require("../lib/utils/media");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const cooldown = require("../lib/utils/cooldown");

// Whisper refuses files over 25 MB
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const WHISPER_MAX_MB = 25;
const OPENAI_TIMEOUT_MS = 60000;
const FFMPEG_TIMEOUT_MS = 90000;
const TRANSCRIBE_COOLDOWN_MS = 10000;

function maxTextLength() {
  return Number(config.TTS_MAX_LENGTH) || 500;
}

// Lang key of the reply for an audio that could not be processed
function failureKey(error, fallbackKey) {
  const kind = classifyError(error, { hasKey: true });
  return kind === "error" ? fallbackKey : replyKeyFor(kind);
}

function isQuotedAudio(message) {
  if (!message.quoted?.message) return false;
  const content = extractMessageContent(message.quoted.message);
  return getContentType(content) === "audioMessage";
}

/**
 * Voice Processing Plugin - Speech-to-text and text-to-speech
 * Uses OpenAI Whisper for transcription and Google TTS for synthesis
 */
module.exports = {
  command: {
    pattern: "transcribe|speak",
    desc: getLang("plugins.voice.desc"),
    type: "media",
  },

  async execute(message, args, ctx) {
    if (ctx?.command === "speak") {
      await handleTextToSpeech(message, ctx?.rawArgs ?? args);
    } else {
      await handleTranscription(message);
    }
  },
};

async function handleTranscription(message) {
  // The key is checked first: nothing is downloaded for a bot that can't transcribe
  if (!config.OPENAI_API_KEY) {
    return await message.reply(getLang("common.not_configured"));
  }
  if (!isQuotedAudio(message)) {
    return await message.reply(
      getLang("plugins.voice.reply_audio", config.PREFIX),
    );
  }

  // Whisper is a paid API
  if (!message.isSudo()) {
    const wait = cooldown.hit(
      message.sender || message.jid,
      "voice:transcribe",
      TRANSCRIBE_COOLDOWN_MS,
    );
    if (wait) {
      return await message.reply(
        getLang("common.cooldown", Math.ceil(wait / 1000)),
      );
    }
  }

  // Throws MEDIA_TOO_LARGE before downloading when over the cap
  const media = await message.getQuotedMedia({ maxBytes: WHISPER_MAX_BYTES });
  if (!media) {
    return await message.reply(getLang("plugins.voice.download_failed"));
  }

  await message.react("⏳");

  try {
    // Small mono mp3 for Whisper
    const mp3 = await withTempDir(async (dir) => {
      const input = path.join(dir, "input");
      const output = path.join(dir, "output.mp3");
      await fs.writeFile(input, media.buffer);
      await runFfmpeg(
        [
          "-i", input,
          "-vn",
          "-ar", "16000",
          "-ac", "1",
          "-c:a", "libmp3lame",
          "-b:a", "32k",
          output,
        ],
        { timeout: FFMPEG_TIMEOUT_MS },
      );
      return fs.readFile(output);
    });

    if (mp3.length > WHISPER_MAX_BYTES) {
      await message.react("❌");
      return await message.reply(
        getLang("common.media_too_large", WHISPER_MAX_MB),
      );
    }

    const OpenAI = require("openai");
    const openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: OPENAI_TIMEOUT_MS,
      maxRetries: 0,
    });
    const transcription = await openai.audio.transcriptions.create({
      file: new File([mp3], "audio.mp3", { type: "audio/mpeg" }),
      model: "whisper-1",
    });

    const text = String(transcription?.text || "").trim();
    if (!text) {
      await message.react("❌");
      return await message.reply(getLang("plugins.voice.no_speech"));
    }

    await message.react("✅");
    await message.reply(getLang("plugins.voice.transcription", text));
  } catch (error) {
    // Never reply with error.message: OpenAI errors can contain a key fragment
    console.error("Voice transcription error:", safeLog(error));
    await message.react("❌");
    await message.reply(getLang(failureKey(error, "plugins.voice.error")));
  }
}

async function handleTextToSpeech(message, rawArgs) {
  const typed = String(rawArgs || "").replace(/\s+/g, " ").trim();
  const text = typed || message.getQuotedText().replace(/\s+/g, " ").trim();

  if (!text) {
    return await message.reply(
      `${getLang("common.usage_prefix")}\n${getLang("plugins.voice.tts_usage", config.PREFIX, maxTextLength())}`,
    );
  }
  if (text.length > maxTextLength()) {
    return await message.reply(
      getLang("plugins.voice.text_too_long", maxTextLength()),
    );
  }

  await message.react("⏳");

  try {
    // Same synthesis as the tts command: pieces of 200 characters at most, joined
    const { synthesizeSpeech } = require("./tts");
    const audio = await synthesizeSpeech(
      text,
      String(config.LANG || "en").toLowerCase(),
    );
    await message.sendVoice(audio);
    await message.react("✅");
  } catch (error) {
    console.error("Speak error:", safeLog(error));
    await message.react("❌");
    await message.reply(getLang(failureKey(error, "plugins.voice.tts_error")));
  }
}
