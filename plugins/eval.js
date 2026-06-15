const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Eval Plugin - Execute JavaScript Code
 * WARNING: Only for bot owner - can be dangerous!
 */

module.exports = {
  command: {
    pattern: "exec",
    desc: "Execute JavaScript code (OWNER ONLY - DANGEROUS)",
    type: "owner",
  },

  async execute(message, args) {
    // Strict owner-only check
    if (!message.isSudo()) {
      return await message.reply("*⛔ This command is only for bot owner!*");
    }

    if (!args) {
      return await message.reply(
        `*⚠️ JavaScript Code Executor*

*Usage:* .eval <code>

*Example:*
.eval return 2 + 2
.eval return process.version
.eval return Object.keys(message)

*WARNING:* This can execute ANY code!
Use with extreme caution!`
      );
    }

    try {
      await message.react("⚙️");

      // Create async function wrapper
      const code = args;
      const AsyncFunction = Object.getPrototypeOf(
        async function () {}
      ).constructor;

      // Available context
      const context = {
        message,
        client: message.client,
        console,
        require,
        process,
        Buffer,
        axios,
        config: require("../config"),
      };

      // Execute code
      const fn = new AsyncFunction(...Object.keys(context), code);
      const result = await fn(...Object.values(context));

      // Format result
      let output = "";
      if (result === undefined) {
        output = "*No return value*";
      } else if (typeof result === "object") {
        output = `\`\`\`${JSON.stringify(result, null, 2)}\`\`\``;
      } else {
        output = `\`\`\`${String(result)}\`\`\``;
      }

      // Limit output length
      if (output.length > 4000) {
        output = output.substring(0, 4000) + "\n\n...(truncated)";
      }

      await message.reply(`*✅ Result:*\n\n${output}`);
      await message.react("✅");
    } catch (error) {
      console.error("Eval error:", error);
      await message.reply(
        `*❌ Error:*\n\n\`\`\`${error.message}\`\`\`\n\n${
          error.stack?.split("\n").slice(0, 5).join("\n") || ""
        }`
      );
      await message.react("❌");
    }
  },
};
