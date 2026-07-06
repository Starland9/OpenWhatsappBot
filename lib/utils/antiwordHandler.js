/**
 * Anti-Word Handler
 * Detects and removes messages containing banned words
 */

const { Group } = require("../database");

// Cache: groupJid → string[] of banned words (lowercased)
const wordCache = new Map();

/**
 * Invalidate the cache for a group (call after updating bannedWords)
 */
function invalidateCache(groupJid) {
  wordCache.delete(groupJid);
}

/**
 * Get banned words list for a group
 */
async function getBannedWords(groupJid) {
  if (wordCache.has(groupJid)) return wordCache.get(groupJid);
  const group = await Group.findOne({ where: { jid: groupJid } });
  if (!group || !group.bannedWords) {
    wordCache.set(groupJid, []);
    return [];
  }
  const words = group.bannedWords
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  wordCache.set(groupJid, words);
  return words;
}

/**
 * Handle a group message — checks for banned words
 * @param {import('../classes/Message').Message} message
 * @returns {boolean} true if banned word detected + action taken
 */
async function handleMessage(message) {
  if (!message.isGroup || !message.body) return false;
  if (message.isSudo()) return false;

  try {
    const group = await Group.findOne({ where: { jid: message.jid } });
    if (!group) return false;

    const isAdmin = await message.isSenderAdmin();
    if (isAdmin) return false;

    const words = await getBannedWords(message.jid);
    if (words.length === 0) return false;

    const bodyLower = message.body.toLowerCase();
    const found = words.find((w) => bodyLower.includes(w));
    if (!found) return false;

    // Delete and warn
    try {
      await message.delete();
    } catch (_) {}

    const num = message.sender.split("@")[0];
    await message.client.getSocket().sendMessage(message.jid, {
      text: `⚠️ @${num}, votre message a été supprimé car il contient un mot interdit.`,
      mentions: [message.sender],
    });

    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { handleMessage, invalidateCache, getBannedWords };
