const { getLang } = require("../lib/utils/language");
const settingsStore = require("../lib/utils/settingsStore");
const { normalizeJid } = require("../lib/utils/permissions");
const config = require("../config");

const JID_RE = /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/;
const NUMBER_RE = /^\+?\d{6,16}$/;

/**
 * The AUTOVV_MODE / AUTOVV_JID values of a `.autovv` argument, or null when it is not one.
 * on / p: the first owner's private chat; a JID (user, group or LID) or a phone number: that chat;
 * off / null / false: disabled.
 */
function parseTarget(raw) {
  const arg = String(raw || "").trim().toLowerCase().replace(/\s+/g, "");
  if (["off", "null", "false"].includes(arg)) return { AUTOVV_MODE: "off", AUTOVV_JID: "" };
  if (["on", "p"].includes(arg)) return { AUTOVV_MODE: "p", AUTOVV_JID: "" };
  if (JID_RE.test(arg) || NUMBER_RE.test(arg)) {
    const jid = normalizeJid(arg);
    if (jid) return { AUTOVV_MODE: "jid", AUTOVV_JID: jid };
  }
  return null;
}

/** Where autovv sends, in words */
function targetText() {
  if (config.AUTOVV_MODE === "p") return getLang("plugins.autovv.target_private");
  if (config.AUTOVV_MODE === "jid" && config.AUTOVV_JID) return getLang("plugins.autovv.target_jid", config.AUTOVV_JID);
  return getLang("plugins.autovv.target_off");
}

/** WhatsApp sends view-once media to Android devices only: say so while autovv is on and the bot is not one */
function androidNotice() {
  if (config.AUTOVV_MODE === "off" || config.BAILEYS_DEVICE === "android") return null;
  return getLang("plugins.autovv.needs_android");
}

/**
 * autovv: forward every view-once message the bot receives (lib/utils/viewOnceHandler.js). Same settings as
 * the panel (Settings > Behavior): AUTOVV_MODE and AUTOVV_JID.
 */
module.exports = {
  parseTarget,

  command: {
    pattern: "autovv",
    desc: getLang("plugins.autovv.desc"),
    type: "whatsapp",
    fromMe: true,
    delegable: false,
    lockReason: "config",
  },

  async execute(message, argsString) {
    if (!String(argsString || "").trim()) {
      const parts = [
        getLang("plugins.autovv.status", targetText()),
        getLang("plugins.autovv.usage", config.PREFIX),
        androidNotice(),
      ];
      const text = parts.filter(Boolean).join("\n\n");
      return await message.reply(text);
    }

    const target = parseTarget(argsString);
    if (!target) return await message.reply(getLang("plugins.autovv.usage", config.PREFIX));

    await settingsStore.set(target);
    await message.react("✅");
    const text = [getLang("plugins.autovv.updated", targetText()), androidNotice()].filter(Boolean).join("\n\n");
    return await message.reply(text);
  },
};
