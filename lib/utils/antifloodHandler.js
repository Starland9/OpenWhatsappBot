/**
 * Anti-Flood Handler
 * Detects and handles message flooding in groups
 */

const { Group } = require("../database");

const FLOOD_WINDOW_MS = 5000; // 5 second window
const WARN_THRESHOLD = 5;  // warn after 5 messages in window
const KICK_THRESHOLD = 10; // kick after 10 messages in window

// Map: `${groupJid}:${userJid}` → { count, windowStart, warned }
const floodMap = new Map();

/**
 * Handle a group message — checks for flood
 * @param {import('../classes/Message').Message} message
 * @returns {boolean} true if flood detected
 */
async function handleMessage(message) {
  if (!message.isGroup || !message.body) return false;
  if (message.isSudo()) return false;

  try {
    const group = await Group.findOne({ where: { jid: message.jid } });
    if (!group || !group.antiflood) return false;

    const isAdmin = await message.isSenderAdmin();
    if (isAdmin) return false;

    const key = `${message.jid}:${message.sender}`;
    const now = Date.now();
    const entry = floodMap.get(key) || { count: 0, windowStart: now, warned: false };

    // Reset window if expired
    if (now - entry.windowStart > FLOOD_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
      entry.warned = false;
    }

    entry.count += 1;
    floodMap.set(key, entry);

    const num = message.sender.split("@")[0];

    if (entry.count >= KICK_THRESHOLD) {
      // Kick
      floodMap.delete(key);
      const isBotAdmin = await message.isBotAdmin();
      if (isBotAdmin) {
        await message.kick(message.sender);
        await message.client.getSocket().sendMessage(message.jid, {
          text: `⛔ @${num} a été expulsé pour flood (${entry.count} messages en 5s).`,
          mentions: [message.sender],
        });
      }
      return true;
    }

    if (entry.count >= WARN_THRESHOLD && !entry.warned) {
      entry.warned = true;
      floodMap.set(key, entry);
      await message.client.getSocket().sendMessage(message.jid, {
        text: `⚠️ @${num}, arrêtez d'envoyer des messages aussi rapidement !`,
        mentions: [message.sender],
      });
      return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

module.exports = { handleMessage };
