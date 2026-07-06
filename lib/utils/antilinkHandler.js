/**
 * Anti-Link Handler
 * Detects and removes URLs from group messages when antilink is enabled
 */

const { Group } = require("../database");

// Regex for detecting URLs (http/https, WhatsApp links, t.me, etc.)
const URL_REGEX =
  /(https?:\/\/[^\s]+)|(wa\.me\/[^\s]+)|(chat\.whatsapp\.com\/[^\s]+)|(t\.me\/[^\s]+)/gi;

// Track warnings per user per group (in-memory, resets on restart)
const warnMap = new Map(); // key: `${groupJid}:${userJid}`, value: count

/**
 * Handle a group message — checks antilink setting and removes URLs
 * @param {import('../classes/Message').Message} message
 * @returns {boolean} true if message was handled (URL detected + antilink on)
 */
async function handleMessage(message) {
  if (!message.isGroup || !message.body) return false;
  // Admins and sudo are exempt
  if (message.isSudo()) return false;

  try {
    const group = await Group.findOne({ where: { jid: message.jid } });
    if (!group || !group.antilink) return false;

    // Check if message contains a URL
    const hasUrl = URL_REGEX.test(message.body);
    URL_REGEX.lastIndex = 0; // reset regex state

    if (!hasUrl) return false;

    // Check if sender is admin (admins are exempt)
    const isAdmin = await message.isSenderAdmin();
    if (isAdmin) return false;

    // Delete the message
    try {
      await message.delete();
    } catch (_) {
      // ignore if can't delete (bot not admin)
    }

    const key = `${message.jid}:${message.sender}`;
    const currentWarns = (warnMap.get(key) || 0) + 1;
    warnMap.set(key, currentWarns);

    const num = message.sender.split("@")[0];

    if (currentWarns >= 3) {
      // Kick after 3 antilink warnings
      warnMap.delete(key);
      const isBotAdmin = await message.isBotAdmin();
      if (isBotAdmin) {
        await message.kick(message.sender);
        await message.client
          .getSocket()
          .sendMessage(message.jid, {
            text: `⛔ @${num} a été expulsé pour envoi répété de liens.`,
            mentions: [message.sender],
          });
      }
    } else {
      await message.client.getSocket().sendMessage(message.jid, {
        text: `⚠️ @${num}, les liens sont interdits dans ce groupe ! (Avertissement ${currentWarns}/3)`,
        mentions: [message.sender],
      });
    }

    return true;
  } catch (err) {
    // Non-blocking
    return false;
  }
}

module.exports = { handleMessage };
