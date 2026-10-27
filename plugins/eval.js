const util = require("util");
const axios = require("axios");
const { getLang } = require("../lib/utils/language");
const { withTimeout } = require("../lib/utils/http");
const config = require("../config");

/**
 * Eval Plugin - Execute JavaScript Code
 * WARNING: owner only, private chat only - can be dangerous!
 */

const SECRET_KEY_RE = /KEY|SECRET|TOKEN|PASSWORD|SESSION|DATABASE_URL/i;
const MIN_SECRET_LENGTH = 6;
const MAX_OUTPUT_CHARS = 3500;
const EVAL_TIMEOUT_MS = 60000;

/** Values of the config / environment entries that look like secrets */
function collectSecrets() {
  const secrets = new Set();
  for (const source of [config, process.env]) {
    for (const [name, value] of Object.entries(source)) {
      if (!SECRET_KEY_RE.test(name)) continue;
      if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
      secrets.add(value);
    }
  }
  // longest first, so a secret that contains another one is masked whole
  return [...secrets].sort((a, b) => b.length - a.length);
}

function maskSecrets(text) {
  let out = String(text);
  for (const secret of collectSecrets()) {
    out = out.split(secret).join("[hidden]");
  }
  return out;
}

/** Text of an eval result (strings as they are, the rest through util.inspect) */
function formatResult(result) {
  if (typeof result === "string") return result;
  return util.inspect(result, { depth: 3, maxArrayLength: 50, maxStringLength: 1000, breakLength: 80 });
}

/**
 * Masked, truncated text inside a code fence. The closing fence is always kept.
 */
function fence(text) {
  let body = maskSecrets(text).replace(/```/g, "`​``");
  if (body.length > MAX_OUTPUT_CHARS) {
    body = `${body.slice(0, MAX_OUTPUT_CHARS)}\n${getLang("plugins.eval.truncated")}`;
  }
  return `\`\`\`${body}\`\`\``;
}

module.exports = {
  command: {
    pattern: "exec|eval",
    desc: getLang("plugins.eval.desc"),
    type: "owner",
    fromMe: true,
    onlyPm: true,
  },

  async execute(message, args, ctx) {
    // rawArgs keeps the newlines of multi-line code
    const code = String(ctx?.rawArgs ?? args ?? "").trim();

    if (!code) {
      return await message.reply(getLang("plugins.eval.usage", config.PREFIX));
    }

    try {
      await message.react("⚙️");

      // Create async function wrapper
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

      // Available context
      const context = {
        message,
        client: message.client,
        console,
        require,
        process,
        Buffer,
        axios,
        util,
        config,
      };

      // Execute code
      const fn = new AsyncFunction(...Object.keys(context), code);
      const result = await withTimeout(
        () => fn(...Object.values(context)),
        EVAL_TIMEOUT_MS,
        "eval",
      );

      const output =
        result === undefined
          ? getLang("plugins.eval.no_return")
          : fence(formatResult(result));

      await message.reply(getLang("plugins.eval.result", output));
      await message.react("✅");
    } catch (error) {
      console.error("Eval error:", maskSecrets(error?.message));
      // The sender is the owner, in private: show the error to help debugging
      const detail = [error?.message, ...(error?.stack?.split("\n").slice(1, 5) || [])].join("\n");
      await message.reply(getLang("plugins.eval.error", fence(detail)));
      await message.react("❌");
    }
  },
};
