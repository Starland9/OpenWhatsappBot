const { getLang } = require("../lib/utils/language");

/**
 * Fancy Text Plugin
 * Generate fancy text styles
 */

const fancyFonts = {
  1: (text) => text.split("").join(" "), // Spaced
  2: (text) =>
    text
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code + 119743); // A-Z
        if (code >= 97 && code <= 122)
          return String.fromCharCode(code + 119737); // a-z
        return c;
      })
      .join(""), // Bold
  3: (text) =>
    text
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code + 119795); // A-Z
        if (code >= 97 && code <= 122)
          return String.fromCharCode(code + 119789); // a-z
        return c;
      })
      .join(""), // Italic
  4: (text) =>
    text
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code + 119951); // A-Z
        if (code >= 97 && code <= 122)
          return String.fromCharCode(code + 119945); // a-z
        return c;
      })
      .join(""), // Monospace
  5: (text) =>
    text
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code + 119847); // A-Z
        if (code >= 97 && code <= 122)
          return String.fromCharCode(code + 119841); // a-z
        return c;
      })
      .join(""), // Script
  6: (text) =>
    text
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code + 8333); // A-Z
        if (code >= 97 && code <= 122)
          return String.fromCharCode(code - 32 + 8333); // a-z
        return c;
      })
      .join(""), // Circled
  7: (text) =>
    text
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code + 127280); // A-Z
        if (code >= 97 && code <= 122)
          return String.fromCharCode(code - 32 + 127280); // a-z
        return c;
      })
      .join(""), // Squared
  8: (text) =>
    text
      .toLowerCase()
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 97 && code <= 122) return String.fromCharCode(code + 9327); // a-z
        return c;
      })
      .join(""), // Circled Black
  9: (text) =>
    text
      .toUpperCase()
      .split("")
      .map((c, i) => (i % 2 === 0 ? c : c.toLowerCase()))
      .join(""), // Alternating Case
  10: (text) =>
    text
      .split("")
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code + 120211); // A-Z
        if (code >= 97 && code <= 122)
          return String.fromCharCode(code + 120205); // a-z
        return c;
      })
      .join(""), // Double Struck
};

module.exports = {
  command: {
    pattern: "fancy",
    desc: "Generate fancy text in different styles",
    type: "utility",
  },

  async execute(message, args) {
    if (!args) {
      // Show list of available styles
      const stylesList = `*📝 Fancy Text Styles*

*Usage:* .fancy <style> <text>
*Example:* .fancy 5 Hello World

*Available Styles:*
1️⃣ Spaced
2️⃣ Bold
3️⃣ Italic
4️⃣ Monospace
5️⃣ Script
6️⃣ Circled
7️⃣ Squared
8️⃣ Circled Black
9️⃣ Alternating Case
🔟 Double Struck

*Or use:* .fancy all <text> to see all styles`;

      return await message.reply(stylesList);
    }

    const parts = args.split(" ");
    const styleNum = parts[0];
    const text = parts.slice(1).join(" ");

    if (!text) {
      return await message.reply(
        "*Please provide text to convert!*\n\nExample: `.fancy 5 Hello World`"
      );
    }

    try {
      if (styleNum.toLowerCase() === "all") {
        // Show all styles
        let allStyles = `*📝 Fancy Text - All Styles*\n\n`;
        for (let i = 1; i <= 10; i++) {
          const styled = fancyFonts[i](text);
          allStyles += `*${i}.* ${styled}\n\n`;
        }
        await message.reply(allStyles);
      } else {
        // Show specific style
        const num = parseInt(styleNum);
        if (num >= 1 && num <= 10) {
          const styled = fancyFonts[num](text);
          await message.reply(styled);
        } else {
          await message.reply(
            "*Invalid style number!*\n\nUse a number between 1-10 or 'all'"
          );
        }
      }
    } catch (error) {
      console.error("Fancy text error:", error);
      await message.reply("*Error generating fancy text!*");
    }
  },
};
