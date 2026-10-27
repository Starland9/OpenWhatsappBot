const config = require("../../config");

/**
 * Shared permission helpers (research R9, R10).
 *
 * JIDs come in two namespaces with Baileys 7: phone numbers
 * (`<number>@s.whatsapp.net`, PN) and LIDs (`<id>@lid`). Helpers here accept
 * either form, with or without a device suffix (`:12`).
 */

/**
 * Normalize a JID: drop the device/agent suffix, map `c.us` to `s.whatsapp.net`.
 * A bare number ("+237 6xx") becomes `<digits>@s.whatsapp.net`.
 * @param {string} jid
 * @returns {string} normalized JID, or "" when empty/invalid
 */
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const value = jid.trim();
  const at = value.indexOf("@");
  if (at < 0) {
    const digits = value.replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : "";
  }
  const user = value.slice(0, at).split(":")[0].split("_")[0];
  let server = value.slice(at + 1).toLowerCase();
  if (server === "c.us") server = "s.whatsapp.net";
  if (!user) return "";
  return `${user}@${server}`;
}

/** User part of a JID ("237600000000"), or "" */
function jidUser(jid) {
  const normalized = normalizeJid(jid);
  return normalized ? normalized.split("@")[0] : "";
}

function isLidJid(jid) {
  const n = normalizeJid(jid);
  return n.endsWith("@lid") || n.endsWith("@hosted.lid");
}

function isPnJid(jid) {
  const n = normalizeJid(jid);
  return n.endsWith("@s.whatsapp.net") || n.endsWith("@hosted");
}

function sudoEntries() {
  return String(config.SUDO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Owner JIDs from the SUDO list (bare numbers or full JIDs), normalized.
 * @returns {string[]} e.g. ["237600000000@s.whatsapp.net"]
 */
function getOwnerJids() {
  const out = [];
  for (const entry of sudoEntries()) {
    const jid = normalizeJid(entry);
    if (jid && !out.includes(jid)) out.push(jid);
  }
  return out;
}

/**
 * True when the JID (PN or LID, any device) belongs to an owner.
 * The user part is compared with the user part of each SUDO entry.
 * @param {string} jid
 */
function isOwnerJid(jid) {
  const user = jidUser(jid);
  if (!user) return false;
  return getOwnerJids().some((owner) => jidUser(owner) === user);
}

/**
 * Normalized identities of the bot account: { pn, lid } (either may be "").
 * @param {object} sock - Baileys socket
 */
function getBotJids(sock) {
  const user = sock?.user || {};
  return { pn: normalizeJid(user.id), lid: normalizeJid(user.lid) };
}

/**
 * Every known identity of a JID: itself, plus the PN/LID forms found in the
 * group metadata or in Baileys' LID mapping.
 * @returns {Promise<Set<string>>}
 */
async function identitiesOf(message, jid, metadata) {
  const target = normalizeJid(jid);
  const ids = new Set(target ? [target] : []);
  if (!target) return ids;

  const participants = metadata?.participants || [];
  for (const p of participants) {
    const forms = [p.id, p.phoneNumber, p.lid].map(normalizeJid).filter(Boolean);
    if (forms.includes(target)) forms.forEach((f) => ids.add(f));
  }

  if (isLidJid(target) && ![...ids].some(isPnJid)) {
    try {
      const mapping = message?.client?.getSocket?.()?.signalRepository?.lidMapping;
      const pn = mapping && (await mapping.getPNForLID(target));
      if (pn) ids.add(normalizeJid(pn));
    } catch (_) {
      // best effort
    }
  }
  return ids;
}

/**
 * Phone-number form of a JID when it can be resolved (group metadata, LID
 * mapping), otherwise the normalized JID itself. Use it before persisting ids.
 * @param {Message} message
 * @param {string} jid
 * @returns {Promise<string>}
 */
async function toPnJid(message, jid) {
  const target = normalizeJid(jid);
  if (!target || isPnJid(target)) return target;
  const metadata =
    message?.isGroup && typeof message.getGroupMetadata === "function"
      ? await message.getGroupMetadata()
      : null;
  const ids = await identitiesOf(message, target, metadata);
  return [...ids].find(isPnJid) || target;
}

/**
 * Check that a group action (kick, warn, demote...) may target `jid`.
 * @param {Message} message - the command message
 * @param {string} jid - target JID (PN or LID)
 * @returns {Promise<string|null>} null when allowed, otherwise a lang key:
 *   "common.cannot_target_bot" | "common.cannot_target_self" |
 *   "common.cannot_target_owner" | "common.cannot_target_creator"
 */
async function guardTarget(message, jid) {
  if (!normalizeJid(jid)) return null;

  const metadata =
    message?.isGroup && typeof message.getGroupMetadata === "function"
      ? await message.getGroupMetadata()
      : null;
  const ids = await identitiesOf(message, jid, metadata);
  const has = (other) => {
    const n = normalizeJid(other);
    return !!n && ids.has(n);
  };

  const bot = getBotJids(message?.client?.getSocket?.());
  if (has(bot.pn) || has(bot.lid)) return "common.cannot_target_bot";

  if (has(message?.sender) || has(message?.senderLid)) {
    return "common.cannot_target_self";
  }

  if ([...ids].some(isOwnerJid)) return "common.cannot_target_owner";

  if (metadata && (has(metadata.owner) || has(metadata.ownerPn))) {
    return "common.cannot_target_creator";
  }

  return null;
}

/**
 * `groupParticipantsUpdate` resolves with one `{ status, jid }` per target
 * instead of throwing. Success only when every status is "200".
 * @param {any} res
 * @returns {boolean}
 */
function assertParticipantResult(res) {
  if (!Array.isArray(res)) return true;
  return res.every((r) => String(r?.status) === "200");
}

module.exports = {
  normalizeJid,
  jidUser,
  isLidJid,
  isPnJid,
  getOwnerJids,
  isOwnerJid,
  getBotJids,
  toPnJid,
  guardTarget,
  assertParticipantResult,
};
