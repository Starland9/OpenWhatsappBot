const { getLang } = require("../lib/utils/language");
const translate = require("translate-google-api");

/**
 * Translation Plugin - Automatic message translation
 */
module.exports = {
  command: {
    pattern: "translate|tr|tl",
    desc: getLang("plugins.translate.desc"),
    type: "utility",
  },

  async execute(message, query) {
    try {
      // Check if replying to a message
      let textToTranslate = query;
      let targetLang = "en";

      if (message.quoted && message.quoted.message) {
        const quotedMsg = message.quoted.message;
        const quotedType = Object.keys(quotedMsg)[0];
        const quotedContent = quotedMsg[quotedType];
        
        textToTranslate = quotedContent.text || quotedContent.caption || quotedContent.conversation || "";
        
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

      if (!textToTranslate) {
        return await message.reply(getLang("plugins.translate.usage"));
      }

      await message.react("⏳");

      const result = await translate(textToTranslate, { to: targetLang });
      
      const response = `🌐 *Translation*\n\n` +
        `*From:* ${result.from.language.iso || 'auto'}\n` +
        `*To:* ${targetLang}\n\n` +
        `*Original:*\n${textToTranslate}\n\n` +
        `*Translation:*\n${result[0]}`;

      await message.react("✅");
      await message.reply(response);
    } catch (error) {
      await message.react("❌");
      console.error("Translation error:", error);
      await message.reply(`❌ ${getLang("plugins.translate.error")}: ${error.message}`);
    }
  },
};
