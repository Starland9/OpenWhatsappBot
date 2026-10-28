const { getLang } = require("../lib/utils/language");
const { AutoResponder } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const config = require("../config");

/**
 * Auto Responder Management Plugin (owner only)
 *   .ar status | on | off
 *   .ar ignore add|remove <number> | list | clear
 *   .ar personality [text]
 */

const SETTINGS_KEY = "auto_responder";
const PERSONALITY_PREVIEW = 100;
const MAX_PERSONALITY_LENGTH = 1500;

const parseList = (value) =>
  value
    ? value
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
    : [];

const onlyDigits = (value) => String(value || "").replace(/[^0-9]/g, "");

/**
 * Single settings row (id 1), created from the config defaults when missing.
 * Pass `{ transaction }` to join one (admin panel).
 */
async function loadSettings(options = {}) {
  let settings = await AutoResponder.findOne({ where: { id: 1 }, ...options });
  if (!settings) {
    settings = await AutoResponder.create(
      {
        id: 1,
        ignoreNumbers: config.AUTO_RESPONDER_IGNORE_NUMBERS,
        personality: config.AUTO_RESPONDER_PERSONALITY,
        enabled: config.AUTO_RESPONDER_ENABLED,
      },
      options,
    );
    dropCache(options.transaction);
  }
  return settings;
}

/**
 * Drop the cached copy the auto-responder reads on every message; inside a transaction,
 * once it has committed (a reader must not cache the old row in between).
 */
function dropCache(transaction) {
  if (transaction && typeof transaction.afterCommit === "function") {
    transaction.afterCommit(() => settingsCache.invalidate(SETTINGS_KEY));
  } else {
    settingsCache.invalidate(SETTINGS_KEY);
  }
}

/** Write settings, then drop the cached copy the auto-responder reads on every message */
async function updateSettings(settings, values, options = {}) {
  await settings.update(values, options);
  dropCache(options.transaction);
}

async function handleIgnore(message, settings, args) {
  const subAction = args[1]?.toLowerCase();
  const current = parseList(settings.ignoreNumbers);

  if (subAction === "add" || subAction === "remove") {
    // numbers are often typed with spaces: +33 6 12 34 56 78
    const number = onlyDigits(args.slice(2).join(""));
    if (!number) return await message.reply(getLang("plugins.autorespond.ignore_usage", config.PREFIX));

    if (subAction === "add") {
      if (current.includes(number)) {
        return await message.reply(getLang("plugins.autorespond.already_ignored"));
      }
      await updateSettings(settings, { ignoreNumbers: [...current, number].join(",") });
      await message.react("✅");
      return await message.reply(getLang("plugins.autorespond.number_ignored", number));
    }

    const remaining = current.filter((n) => n !== number);
    if (remaining.length === current.length) {
      return await message.reply(getLang("plugins.autorespond.not_ignored"));
    }
    await updateSettings(settings, { ignoreNumbers: remaining.join(",") });
    await message.react("✅");
    return await message.reply(getLang("plugins.autorespond.number_unignored", number));
  }

  if (subAction === "list") {
    if (current.length === 0) {
      return await message.reply(getLang("plugins.autorespond.no_ignored"));
    }
    return await message.reply(
      `${getLang("plugins.autorespond.ignored_list")}\n${current.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
    );
  }

  if (subAction === "clear") {
    await updateSettings(settings, { ignoreNumbers: "" });
    await message.react("✅");
    return await message.reply(getLang("plugins.autorespond.ignore_cleared"));
  }

  return await message.reply(getLang("plugins.autorespond.ignore_usage", config.PREFIX));
}

module.exports = {
  // reused by the admin panel (settings adapter `autoResponder`): same row, same cache key
  loadSettings,
  updateSettings,
  parseList,
  SETTINGS_KEY,

  command: {
    pattern: "ar",
    desc: getLang("plugins.autorespond.desc"),
    type: "ai",
    fromMe: true,
  },

  async execute(message, query, ctx) {
    const args = (query || "").trim().split(/\s+/);
    const action = args[0]?.toLowerCase();
    const settings = await loadSettings();

    if (!action || action === "status") {
      const ignoreList = parseList(settings.ignoreNumbers);
      const personality = String(settings.personality || "");
      return await message.reply(
        getLang(
          "plugins.autorespond.status",
          getLang(settings.enabled ? "common.status_enabled" : "common.status_disabled"),
          ignoreList.length > 0 ? ignoreList.join(", ") : getLang("plugins.autorespond.none"),
          personality.length > PERSONALITY_PREVIEW
            ? `${personality.slice(0, PERSONALITY_PREVIEW)}...`
            : personality,
        ),
      );
    }

    if (action === "on") {
      if (!config.GEMINI_API_KEY) {
        return await message.reply(getLang("plugins.autorespond.no_api_key"));
      }
      await updateSettings(settings, { enabled: true });
      await message.react("✅");
      return await message.reply(getLang("plugins.autorespond.enabled"));
    }

    if (action === "off") {
      await updateSettings(settings, { enabled: false });
      await message.react("✅");
      return await message.reply(getLang("plugins.autorespond.disabled"));
    }

    if (action === "ignore") return await handleIgnore(message, settings, args);

    if (action === "personality") {
      // rawArgs keeps the line breaks of a multi-line personality
      const raw = (ctx?.rawArgs ?? query ?? "").trim();
      const personality = raw.replace(/^personality\s*/i, "").trim();

      if (!personality) {
        return await message.reply(
          `${getLang("plugins.autorespond.current_personality")}\n\n${settings.personality}`,
        );
      }
      if (personality.length > MAX_PERSONALITY_LENGTH) {
        return await message.reply(
          getLang("plugins.autorespond.personality_too_long", MAX_PERSONALITY_LENGTH),
        );
      }
      await updateSettings(settings, { personality });
      await message.react("✅");
      return await message.reply(getLang("plugins.autorespond.personality_updated"));
    }

    return await message.reply(getLang("plugins.autorespond.usage", config.PREFIX));
  },
};
