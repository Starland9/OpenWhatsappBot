const { getLang } = require("../lib/utils/language");
const translate = require("@vitalets/google-translate-api");

/**
 * Translation Plugin - Automatic message translation
 */
module.exports = {
  command: {
    pattern: "trt",
    desc: getLang("plugins.translate.desc"),
    type: "utility",
  },

  async execute(message, query) {
    try {
      await message.react("⏳");

      // Check if replying to a message
      let textToTranslate = "";
      let targetLang = "en";

      if (message.quoted) {
        // Extract text from quoted message
        const quotedMsg = message.quoted.message;
        const quotedType = Object.keys(quotedMsg)[0];
        const quotedContent = quotedMsg[quotedType];

        textToTranslate =
          quotedContent?.text ||
          quotedContent?.caption ||
          quotedContent?.conversation ||
          "";

        // If query is provided when replying, it's the target language
        if (query) {
          targetLang = query.toLowerCase();
        }
      } else if (query) {
        // Format: .translate <lang> <text> or .translate <text>
        const parts = query.split(" ");
        if (parts.length > 1 && parts[0].length === 2) {
          targetLang = parts[0].toLowerCase();
          textToTranslate = parts.slice(1).join(" ");
        } else {
          textToTranslate = query;
        }
      }

      if (!textToTranslate || textToTranslate.trim() === "") {
        await message.react("❌");
        return await message.reply(getLang("plugins.translate.usage"));
      }

      const result = await translate.translate(textToTranslate, {
        to: targetLang,
      });

      const response = result.text;

      await message.react("✅");
      await message.reply(response);
    } catch (error) {
      await message.react("❌");
      console.error("Translation error:", error);
      await message.reply(
        `❌ ${getLang("plugins.translate.error")}: ${error.message}`
      );
    }
  },
};
