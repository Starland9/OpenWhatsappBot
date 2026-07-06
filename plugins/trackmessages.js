const { UserStats } = require("../lib/database");
const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Per-message activity tracker.
 * Wired into index.js processMessage so every non-status message is counted.
 * All DB writes are non-blocking (setImmediate) to keep the hot path fast.
 */
const PREFIX = config.PREFIX;

function computeLevel(xp) {
  // MEE6-like formula: level = floor(sqrt(xp / 100))
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100));
}

async function trackMessage(message) {
  if (!message || !message.jid || !message.sender) return;
  if (message.jid === "status@broadcast") return;
  if (message.fromMe) return;

  const isCommand =
    typeof message.body === "string" && message.body.startsWith(PREFIX);
  const isMedia = !!message.hasMedia;

  setImmediate(async () => {
    try {
      const [row, created] = await UserStats.findOrCreate({
        where: { jid: message.sender, groupJid: message.jid },
        defaults: {
          messageCount: 0,
          commandCount: 0,
          mediaCount: 0,
          xp: 0,
          level: 0,
          lastActiveAt: new Date(),
        },
      });

      row.messageCount = (row.messageCount || 0) + 1;
      if (isCommand) row.commandCount = (row.commandCount || 0) + 1;
      if (isMedia) row.mediaCount = (row.mediaCount || 0) + 1;

      // XP: 5 per text msg, 10 per command, 15 per media
      const xpGain = isMedia ? 15 : isCommand ? 10 : 5;
      const oldLevel = row.level || 0;
      row.xp = (row.xp || 0) + xpGain;
      row.level = computeLevel(row.xp);
      row.lastActiveAt = new Date();

      await row.save();

      // Optional: log level-up (silent — could broadcast a congrats)
      if (!created && row.level > oldLevel) {
        // No-op for now (could emit a sticker or reaction)
      }
    } catch (err) {
      // Silently swallow — tracking is best-effort
    }
  });
}

module.exports = {
  trackMessage,
  computeLevel,
};
