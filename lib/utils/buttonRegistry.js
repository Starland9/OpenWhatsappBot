/**
 * Button registry (research R8)
 *
 * `plugins/buttons.js` records the ids offered by every interactive message it
 * sends (including the plain-text fallback). When a user quotes one of those
 * messages with a bare number ("2"), the pipeline turns the number into the
 * matching id before dispatching it to the `handleButtonReply` hooks.
 */

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 500;

// sentMessageId -> { ids: string[], expiresAt: number }; Map keeps insertion order (oldest first)
const entries = new Map();

function toMessageId(sent) {
  if (!sent) return null;
  if (typeof sent === "string") return sent;
  // Accept the WAMessage returned by sock.sendMessage
  return sent.key?.id || sent.id || null;
}

function prune(now = Date.now()) {
  for (const [id, entry] of entries) {
    if (entry.expiresAt > now) break; // later entries are newer
    entries.delete(id);
  }
  while (entries.size > MAX_ENTRIES) {
    entries.delete(entries.keys().next().value);
  }
}

/**
 * Record the ids offered by a sent message.
 * @param {string|object} sentMessageId - message id, or the message returned by sendMessage
 * @param {Array<string|{id:string}>} ids - ids in display order (1-based for the user)
 */
function record(sentMessageId, ids) {
  const id = toMessageId(sentMessageId);
  if (!id || !Array.isArray(ids) || ids.length === 0) return;

  const clean = ids
    .map((b) => (typeof b === "string" ? b : b?.id))
    .filter((b) => typeof b === "string" && b.length > 0);
  if (clean.length === 0) return;

  entries.delete(id); // refresh insertion order
  entries.set(id, { ids: clean, expiresAt: Date.now() + TTL_MS });
  prune();
}

/**
 * Resolve a numeric reply to a recorded message.
 * @param {string} quotedId - id of the quoted message
 * @param {string} digitBody - the reply body, e.g. "2"
 * @returns {string|null} the recorded id, or null
 */
function resolve(quotedId, digitBody) {
  if (!quotedId) return null;
  const entry = entries.get(quotedId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(quotedId);
    return null;
  }
  const text = String(digitBody ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const index = parseInt(text, 10) - 1;
  return entry.ids[index] ?? null;
}

/** For tests */
function _reset() {
  entries.clear();
}

module.exports = { record, resolve, _reset, TTL_MS, MAX_ENTRIES };
