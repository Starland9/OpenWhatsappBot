const { getLang } = require("../lib/utils/language");
const gtts = require("google-tts-api");
const axios = require("axios");
const {
  extractMessageContent,
  getContentType,
} = require("@whiskeysockets/baileys");
const translate = require("@vitalets/google-translate-api");
const config = require("../config");

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

      // Auto-detect language if no explicit {lang}
      if (!langMatch) {
        try {
          const detection = await translate(text, {
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

      if (!text) {
        return await message.reply("*Please provide text to convert!*");
      }

      // Limit text length
      const maxLength = config.TTS_MAX_LENGTH || 200;
      if (text.length > maxLength) {
        text = text.substring(0, maxLength);
        await message.reply(
          `*Text too long! Truncated to ${maxLength} characters.*`
        );
      }

      // Get TTS audio URL
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

      const buffer = Buffer.from(response.data);

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
