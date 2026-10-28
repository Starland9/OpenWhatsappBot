"use strict";

/**
 * Warnings of the `Warn` model, shared by the `.warn` command (plugins/warnuser.js), the anti-link
 * guard (plugins/groupguard.js) and the admin panel (specs/002-admin-panel: contracts/runtime.md section 7,
 * data-model 3.1). Extracted from warnuser.js without a change of behaviour.
 *
 * One row per (user, group): `Warn.jid` holds the phone-number form when it is known. The counter is
 * incremented in SQL (`row.increment`), so two concurrent warnings never lose one. Warnings are read from
 * the database each time (no `settingsCache` key).
 *
 *   identityForms(message, jid)         every form the user may be stored under (PN first, then as received)
 *   isVip(message, forms)               VIPs (plugins/role.js) can't be warned; absent or failing role => false
 *   findOrCreateRow(forms, groupJid)    the existing row (any form) or a new one with count 0
 *   addWarning({ forms, groupJid, reason })   +1 and the reason; resolves with the reloaded row
 *   listWarned(groupJid)                rows with count > 0, highest count first
 *   clearWarnings(forms, groupJid)      rows removed (a user's own, any form)
 *   clearGroupWarnings(groupJid)        rows removed for a whole group
 *   fillPlaceholders(template, values)  replace every occurrence of each placeholder
 *
 * `message` is anything with the Message shape `toPnJid` needs (`isGroup`, `getGroupMetadata()`, `client`):
 * the admin panel passes a small stand-in built from the live socket.
 */

const { Op } = require("sequelize");
const { Warn } = require("../database");
const { toPnJid } = require("./permissions");
const { safeLog } = require("./http");

/**
 * Every form of the target stored warnings may use: the phone-number form
 * (the one we persist) first, then the JID as received.
 */
async function identityForms(message, jid) {
  const pn = await toPnJid(message, jid);
  return [...new Set([pn, jid].filter(Boolean))];
}

/** VIPs (plugins/role.js) can't be warned. Absent or failing role => false. */
async function isVip(message, forms) {
  try {
    const role = require("../../plugins/role");
    if (typeof role.isVip !== "function") return false;
    for (const jid of forms) {
      if (await role.isVip(message.jid, jid)) return true;
    }
  } catch (err) {
    console.error("warn: VIP check failed", safeLog(err));
  }
  return false;
}

/**
 * Existing row (any known form of the user) or a new one with count 0.
 * Two concurrent first warnings: the unique index rejects the second insert,
 * which then reads the first one's row.
 */
async function findOrCreateRow(forms, groupJid, reason) {
  const where = { jid: { [Op.in]: forms }, groupJid };
  const existing = await Warn.findOne({ where });
  if (existing) return existing;
  try {
    return await Warn.create({ jid: forms[0], groupJid, reason, count: 0 });
  } catch (err) {
    if (err?.name !== "SequelizeUniqueConstraintError") throw err;
    return await Warn.findOne({ where });
  }
}

/**
 * One more warning for the user: the counter is incremented in SQL, then the reason is stored.
 * @returns {Promise<object>} the reloaded row (`row.count` is the new total)
 */
async function addWarning({ forms, groupJid, reason }) {
  const row = await findOrCreateRow(forms, groupJid, reason);
  await row.increment("count");
  await row.update({ reason });
  await row.reload();
  return row;
}

/** Members with at least one warning, highest count first (what `.warn list` shows) */
async function listWarned(groupJid) {
  return await Warn.findAll({
    where: { groupJid, count: { [Op.gt]: 0 } },
    order: [
      ["count", "DESC"],
      ["updatedAt", "DESC"],
    ],
  });
}

/** Remove the warnings of one user, whatever form they are stored under. @returns {Promise<number>} rows removed */
async function clearWarnings(forms, groupJid) {
  return await Warn.destroy({ where: { jid: { [Op.in]: forms }, groupJid } });
}

/** Remove every warning of a group. @returns {Promise<number>} rows removed */
async function clearGroupWarnings(groupJid) {
  return await Warn.destroy({ where: { groupJid } });
}

/** Replace every occurrence of each placeholder (replacers: no `$` surprises) */
function fillPlaceholders(template, values) {
  let out = String(template);
  for (const [placeholder, value] of Object.entries(values)) {
    out = out.replaceAll(placeholder, () => String(value));
  }
  return out;
}

module.exports = {
  identityForms,
  isVip,
  findOrCreateRow,
  addWarning,
  listWarned,
  clearWarnings,
  clearGroupWarnings,
  fillPlaceholders,
};
