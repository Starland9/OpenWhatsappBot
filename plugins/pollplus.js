/**
 * Intentionally empty.
 *
 * `poll+` and `pollplus` are aliases of the single native-poll command in
 * plugins/poll.js (pattern `poll|vote|poll+|pollplus`; the multi-answer poll is
 * chosen from the alias used). The former in-memory tally, the "close" button
 * and the reaction-based fallback were removed: WhatsApp counts native votes
 * itself. This file exports nothing, so the loader registers no duplicate alias.
 */
module.exports = {};
