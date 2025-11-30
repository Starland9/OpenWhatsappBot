const { getLang } = require("../lib/utils/language");
const gtts = require("google-tts-api");
const axios = require("axios");

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
    let text = args || (message.quoted && message.body);

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
      let lang = "en";
      const langMatch = text.match(/\{([a-z]{2})\}/i);

      if (langMatch) {
        lang = langMatch[1].toLowerCase();
        text = text.replace(langMatch[0], "").trim();
      }

      if (!text) {
        return await message.reply("*Please provide text to convert!*");
      }

      // Limit text length
      if (text.length > 200) {
        text = text.substring(0, 200);
        await message.reply("*Text too long! Truncated to 200 characters.*");
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

      // Send as voice note
      await message.sendAudio(buffer, {
        mimetype: "audio/mp4",
        ptt: false,
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
