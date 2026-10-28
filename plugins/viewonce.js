const { getLang } = require("../lib/utils/language");
const { ViewOnce } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const { normalizeJid } = require("../lib/utils/permissions");
const config = require("../config");

const SETTINGS_KEY = "view_once";
const JID_RE = /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/;
const NUMBER_RE = /^\+?\d{6,16}$/;

/**
 * Settings values for a `.setvv` argument, or null when it is not valid.
 * Accepts g, p, null/false, a JID (user, group or LID) or a bare phone number.
 */
function parseMode(raw) {
  const mode = String(raw || "").trim().toLowerCase();
  if (mode === "g" || mode === "p") {
    return { mode, values: { vvMode: mode, vvJid: null, enabled: true } };
  }
  if (mode === "null" || mode === "false") {
    return { mode, values: { vvMode: "null", vvJid: null, enabled: false } };
  }
  let jid = null;
  if (JID_RE.test(mode)) jid = normalizeJid(mode);
  else if (NUMBER_RE.test(mode)) jid = normalizeJid(mode.replace(/\D/g, ""));
  if (!jid) return null;
  return { mode: jid, values: { vvMode: "jid", vvJid: jid, enabled: true } };
}

/** Settings row (id 1), created when missing. Pass `{ transaction }` to join one (admin panel). */
async function loadSettings(options = {}) {
  const [settings] = await ViewOnce.findOrCreate({
    where: { id: 1 },
    defaults: { id: 1 },
    ...options,
  });
  return settings;
}

/**
 * Write the values of `parseMode(...)` and drop the cached copy the forwarding handler reads.
 * Inside a transaction the cache is dropped once it has committed.
 */
async function saveSettings(values, options = {}) {
  const settings = await loadSettings(options);
  await settings.update(values, options);
  const { transaction } = options;
  if (transaction && typeof transaction.afterCommit === "function") {
    transaction.afterCommit(() => settingsCache.invalidate(SETTINGS_KEY));
  } else {
    settingsCache.invalidate(SETTINGS_KEY);
  }
  return settings;
}

/**
 * Set View-Once forwarding settings
 */
module.exports = {
  // reused by the admin panel (settings adapter `viewOnce`): same parsing, same row, same cache key
  parseMode,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,

  command: {
    pattern: "setvv",
    desc: getLang("plugins.viewonce.setvv_desc"),
    type: "whatsapp",
    fromMe: true,
  },

  async execute(message, query) {
    const parsed = parseMode(query);
    if (!parsed) {
      return await message.reply(getLang("plugins.viewonce.usage", config.PREFIX));
    }

    // The forwarding handler reads the settings through the cache: saveSettings drops it
    await saveSettings(parsed.values);

    await message.react("✅");

    // Handle disable
    if (!parsed.values.enabled) {
      return await message.reply(getLang("plugins.viewonce.disabled"));
    }

    const modeText =
      parsed.mode === "p"
        ? getLang("plugins.viewonce.mode_private")
        : parsed.mode === "g"
          ? getLang("plugins.viewonce.mode_group")
          : getLang("plugins.viewonce.mode_jid", parsed.mode);

    return await message.reply(getLang("plugins.viewonce.updated", modeText));
  },
};
