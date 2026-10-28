const knownChats = require("../lib/utils/knownChats");
const { createLogger } = require("../lib/utils/logger");
const { safeLog } = require("../lib/utils/http");
const { getBotJids, normalizeJid } = require("../lib/utils/permissions");

/**
 * Known chats (specs/002-admin-panel: contracts/runtime.md section 8, data-model 1.9).
 *
 * Hook-only observer that feeds the `known_chats` table: the chats the admin panel may offer as broadcast
 * destinations and the list of former groups. The data layer is lib/utils/knownChats.js; this file only
 * decides when to call it.
 *
 *  - onMessage: the first message of a private chat is recorded (the helper throttles `lastSeenAt` to one
 *    write per hour per chat, ignores groups, the bot's own messages and non-chat JIDs). Never consumes, and
 *    runs before every other hook (priority 5). Chats where the bot is disabled never reach it (the pipeline
 *    gate runs first).
 *  - onReady: seeds an empty table, then refreshes the group names and `leftAt` with
 *    `groupFetchAllParticipating()` at most every 6 hours (reconnections run it again; it is idempotent).
 *  - onGroupParticipants: the bot itself removed from a group sets `leftAt` ("ancien groupe"); added back
 *    clears it.
 *
 * The admin panel reuses `syncGroups` for its refresh button and `subscribeGroups` to learn the member counts
 * and admin flags of every fetch made here.
 */

const logger = createLogger("knownchats");

const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;

let lastRefreshAt = 0;
const listeners = new Set();

/** Number of groups the bot is believed to be in right now */
async function currentGroupCount() {
  const { KnownChat } = require("../lib/database");
  return await KnownChat.count({ where: { kind: "group", leftAt: null } });
}

/**
 * Fetch every group the bot is in and synchronize `known_chats` (names, `leftAt`). An empty answer while
 * groups are known is treated as a failed fetch: it would mark every group as left.
 *
 * @param {object} sock Baileys socket
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ groups: object, listed: number, added: number, back: number, left: number }|null>}
 *   null when the answer was ignored; throws when the fetch itself failed
 */
async function syncGroups(sock, { now = Date.now() } = {}) {
  const groups = await sock.groupFetchAllParticipating();
  const size = Array.isArray(groups) ? groups.length : Object.keys(groups || {}).length;
  if (size === 0 && (await currentGroupCount()) > 0) {
    logger.warn("group fetch answered with no group: ignored");
    return null;
  }
  const result = await knownChats.refreshGroups(groups, now);
  lastRefreshAt = now;
  for (const listener of [...listeners]) {
    try {
      listener(groups, now);
    } catch (err) {
      logger.warn({ err: err?.message }, "knownchats listener failed");
    }
  }
  return { groups, ...result };
}

/**
 * Be told about every group fetch (the raw Baileys answer and the time).
 * @param {(groups: object, now: number) => void} fn
 * @returns {() => void} unsubscribe
 */
function subscribeGroups(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every form of a participant entry of a `group-participants.update` event (string or object) */
function formsOf(entry) {
  const raw = typeof entry === "string" ? [entry] : [entry?.id, entry?.phoneNumber, entry?.lid];
  return raw.map(normalizeJid).filter(Boolean);
}

/** Hook: record the chat of the message. Never consumes. */
function onMessage(message) {
  knownChats.record(message); // fire-and-forget: the helper never rejects
  return false;
}

/** Hook: seed the table, then refresh the groups at most every 6 hours. */
async function onReady(client) {
  try {
    await knownChats.seedIfEmpty();
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_EVERY_MS) return;
    const sock = client?.getSocket?.();
    if (!sock) return;
    await syncGroups(sock, { now });
  } catch (err) {
    logger.warn({ err: safeLog(err) }, "known chats not refreshed");
  }
}

/** Hook: the bot itself was removed from (or added back to) a group. */
async function onGroupParticipants(update, client) {
  try {
    if (!update || !String(update.id).endsWith("@g.us")) return;
    if (update.action !== "remove" && update.action !== "add") return;

    const bot = getBotJids(client?.getSocket?.());
    const botForms = [bot.pn, bot.lid].filter(Boolean);
    const involved = (update.participants || []).some((entry) =>
      formsOf(entry).some((form) => botForms.includes(form)),
    );
    if (!involved) return;

    if (update.action === "remove") await knownChats.markLeft(update.id);
    else await knownChats.clearLeft(update.id);
  } catch (err) {
    logger.warn({ err: safeLog(err) }, "known chats: group membership not recorded");
  }
}

/** Forget the refresh bookkeeping (tests only) */
function _reset() {
  lastRefreshAt = 0;
  listeners.clear();
}

module.exports = {
  // onMessage order (lower first, default 100): an observer that runs before everything else
  hookPriority: { onMessage: 5 },

  onMessage,
  onReady,
  onGroupParticipants,

  // Shared with the admin panel (lib/admin/services/groups.js)
  syncGroups,
  subscribeGroups,
  REFRESH_EVERY_MS,
  _reset,
};
