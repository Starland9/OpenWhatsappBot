const { getLang } = require("../lib/utils/language");
const { AntiDelete } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const { normalizeJid } = require("../lib/utils/permissions");
const config = require("../config");

const JID_RE = /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/;
const NUMBER_RE = /^\+?\d{6,16}$/;

/**
 * Settings values for an `.antidelete` argument, or null when it is not valid.
 * Accepts g, p, sudo, null/false, a JID (user, group or LID) or a bare phone number.
 */
function parseMode(raw) {
  const mode = String(raw || "").trim().toLowerCase();
  if (mode === "g" || mode === "p" || mode === "sudo") {
    return { mode, values: { antiDelMode: mode, antiDelJid: null, enabled: true } };
  }
  if (mode === "null" || mode === "false") {
    return { mode, values: { antiDelMode: "null", antiDelJid: null, enabled: false } };
  }
  let jid = null;
  if (JID_RE.test(mode)) jid = normalizeJid(mode);
  else if (NUMBER_RE.test(mode)) jid = normalizeJid(mode.replace(/\D/g, ""));
  if (!jid) return null;
  return { mode: jid, values: { antiDelMode: "jid", antiDelJid: jid, enabled: true } };
}

/**
 * Set Anti-Delete message forwarding settings
 */
module.exports = {
  command: {
    pattern: "antidelete|antidel",
    desc: getLang("plugins.antidelete.desc"),
    type: "whatsapp",
    fromMe: true,
  },

  async execute(message, query) {
    const parsed = parseMode(query);
    if (!parsed) {
      return await message.reply(getLang("plugins.antidelete.usage", config.PREFIX));
    }

    // Get or create settings
    const [settings] = await AntiDelete.findOrCreate({
      where: { id: 1 },
      defaults: { id: 1 },
    });
    await settings.update(parsed.values);
    // The deletion handler reads the settings through the cache
    settingsCache.invalidate("anti_delete");

    await message.react("✅");

    // Handle disable
    if (!parsed.values.enabled) {
      return await message.reply(getLang("plugins.antidelete.disabled"));
    }

    const modeText =
      parsed.mode === "p"
        ? getLang("plugins.antidelete.mode_private")
        : parsed.mode === "g"
          ? getLang("plugins.antidelete.mode_group")
          : parsed.mode === "sudo"
            ? getLang("plugins.antidelete.mode_sudo")
            : getLang("plugins.antidelete.mode_jid", parsed.mode);

    return await message.reply(getLang("plugins.antidelete.updated", modeText));
  },
};
