/**
 * Per-(user, key) cooldowns.
 *
 *   const wait = cooldown.hit(message.sender, "feedback", 60000);
 *   if (wait) return message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
 *
 * In memory only: a restart clears them. The map is bounded and pruned.
 */

const MAX_ENTRIES = 10000;
const PRUNE_INTERVAL_MS = 60 * 1000;

/** @type {Map<string, number>} "user\0key" -> expiry timestamp (ms) */
const entries = new Map();

const idOf = (userJid, key) => `${userJid}\u0000${key}`;

function prune(now = Date.now()) {
  for (const [id, expiresAt] of entries) {
    if (expiresAt <= now) entries.delete(id);
  }
}

/**
 * Check a cooldown and, when it is over, start a new one.
 * @param {string} userJid
 * @param {string} key - Action name, e.g. "feedback" or "download"
 * @param {number} ms - Cooldown length
 * @returns {number} remaining ms; 0 means allowed (and the hit is recorded)
 */
function hit(userJid, key, ms) {
  const now = Date.now();
  const id = idOf(userJid, key);
  const expiresAt = entries.get(id);
  if (expiresAt && expiresAt > now) return Math.ceil(expiresAt - now);

  if (!(ms > 0)) {
    entries.delete(id);
    return 0;
  }

  // delete first so that the entry moves to the end of the Map (oldest first)
  entries.delete(id);
  if (entries.size >= MAX_ENTRIES) {
    prune(now);
    while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  }
  entries.set(id, now + ms);
  return 0;
}

/**
 * Remaining time of a cooldown without recording a hit.
 * @param {string} userJid
 * @param {string} key
 * @returns {number} remaining ms (0 = free)
 */
function peek(userJid, key) {
  const expiresAt = entries.get(idOf(userJid, key));
  const remaining = expiresAt ? expiresAt - Date.now() : 0;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

/**
 * Forget a cooldown (e.g. the command failed before doing anything).
 * @param {string} userJid
 * @param {string} key
 */
function reset(userJid, key) {
  entries.delete(idOf(userJid, key));
}

/** Number of live entries (tests, metrics) */
function size() {
  prune();
  return entries.size;
}

setInterval(prune, PRUNE_INTERVAL_MS).unref();

module.exports = { hit, peek, reset, size };
