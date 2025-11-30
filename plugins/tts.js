const { getLang } = require("../lib/utils/language");
const gtts = require("google-tts-api");
const axios = require("axios");
const {
  extractMessageContent,
  getContentType,
} = require("@whiskeysockets/baileys");
const translate = require("@vitalets/google-translate-api");
const config = require("../config");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

/**
 * Text to Speech Plugin
 * Convert text to speech in multiple languages
 */

module.exports = {
  command: {
    pattern: "tts",
    desc: "Convert text to speech",
    type: "converter",
  },

  async execute(message, args) {
    // Helper: extract plain text from a quoted message
    const getQuotedText = () => {
      if (!message.quoted || !message.quoted.message) return "";
      try {
        const content = extractMessageContent(message.quoted.message);
        const type = getContentType(content);
        if (!type) return "";
        const msg = content[type];
        const quotedText =
          msg?.text ||
          msg?.caption ||
          msg?.conversation ||
          msg?.selectedButtonId ||
          msg?.singleSelectReply?.selectedRowId ||
          (typeof msg === "string" ? msg : "") ||
          "";
        return quotedText || "";
      } catch (e) {
        return "";
      }
    };

    // Prefer args; if absent, use quoted text
    let text = (args && args.trim()) || getQuotedText();

    if (!text) {
      return await message.reply(
        `*Text to Speech (TTS)*

*Usage:* .tts <text>
*With language:* .tts {lang} <text>

*Examples:*
• .tts Hello World
• .tts {es} Hola Mundo
• .tts {fr} Bonjour

*Popular Languages:*
en - English
es - Spanish
fr - French
de - German
it - Italian
pt - Portuguese
hi - Hindi
ja - Japanese
ko - Korean
ar - Arabic`
      );
    }

    try {
      await message.react("🎤");

      // Check for language code in format {lang}
      let lang = (config.LANG || "en").toLowerCase();
      const langMatch = text.match(/\{([a-z]{2})\}/i);

      if (langMatch) {
        lang = langMatch[1].toLowerCase();
        text = text.replace(langMatch[0], "").trim();
      }

      if (!text) {
        return await message.reply("*Please provide text to convert!*");
      }

      // Check if text exceeds max length for TTS concatenation
      const maxLength = config.TTS_MAX_LENGTH || 200;
      const isLongText = text.length > 200;

      // Auto-detect language if no explicit {lang}
      if (!langMatch) {
        try {
          const detection = await translate(text.substring(0, 500), {
            to: (config.LANG || "en").toLowerCase(),
          });
          const detected = detection?.from?.language?.iso;
          if (detected && typeof detected === "string") {
            lang = detected.toLowerCase();
          }
        } catch (_) {
          // Ignore detection errors and fall back to config.LANG
          lang = (config.LANG || "en").toLowerCase();
        }
      }

      // Limit text if configured max is less than actual length
      if (text.length > maxLength) {
        text = text.substring(0, maxLength);
        await message.reply(
          `*Text too long! Truncated to ${maxLength} characters.*`
        );
      }

      let buffer;

      if (isLongText && text.length > 200) {
        // Use getAllAudioUrls for long text
        const results = gtts.getAllAudioUrls(text, {
          lang: lang,
          slow: false,
          host: "https://translate.google.com",
          splitPunct: ",.?;",
        });

        if (!results || results.length === 0) {
          throw new Error("Failed to generate audio URLs");
        }

        // Download all audio chunks
        const audioBuffers = await Promise.all(
          results.map(async (item) => {
            const response = await axios.get(item.url, {
              responseType: "arraybuffer",
              timeout: 30000,
            });
            return Buffer.from(response.data);
          })
        );

        // If only one chunk, no need to concatenate
        if (audioBuffers.length === 1) {
          buffer = audioBuffers[0];
        } else {
          // Concatenate multiple audio files using ffmpeg
          const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tts-"));
          const inputFiles = [];
          const listFile = path.join(tempDir, "concat.txt");
          const outputFile = path.join(tempDir, "output.mp3");

          try {
            // Write each chunk to a temp file
            for (let i = 0; i < audioBuffers.length; i++) {
              const chunkPath = path.join(tempDir, `chunk${i}.mp3`);
              await fs.writeFile(chunkPath, audioBuffers[i]);
              inputFiles.push(chunkPath);
            }

            // Create concat list file for ffmpeg
            const concatList = inputFiles
              .map((file) => `file '${file}'`)
              .join("\n");
            await fs.writeFile(listFile, concatList);

            // Concatenate using ffmpeg
            await new Promise((resolve, reject) => {
              ffmpeg()
                .input(listFile)
                .inputOptions(["-f concat", "-safe 0"])
                .outputOptions(["-c copy"])
                .output(outputFile)
                .on("end", resolve)
                .on("error", reject)
                .run();
            });

            // Read concatenated file
            buffer = await fs.readFile(outputFile);
          } finally {
            // Cleanup temp files
            await fs
              .rm(tempDir, { recursive: true, force: true })
              .catch(() => {});
          }
        }
      } else {
        // Use single getAudioUrl for short text (≤200 chars)
        const ttsUrl = gtts.getAudioUrl(text, {
          lang: lang,
          slow: false,
          host: "https://translate.google.com",
        });

        // Download audio
        const response = await axios.get(ttsUrl, {
          responseType: "arraybuffer",
          timeout: 30000,
        });

        buffer = Buffer.from(response.data);
      }

      // Send as voice note (push-to-talk)
      await message.sendAudio(buffer, {
        mimetype: "audio/mp4",
        ptt: true,
      });

      await message.react("✅");
    } catch (error) {
      console.error("TTS error:", error);

      if (error.message && error.message.includes("language")) {
        await message.reply(
          "*Invalid language code!*\n\nUse standard 2-letter ISO codes (en, es, fr, etc.)"
        );
      } else {
        await message.reply(
          "*TTS failed!*\n\nPlease try again with shorter text or different language."
        );
      }

      await message.react("❌");
    }
  },
};
