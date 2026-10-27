const { UserStats } = require("../lib/database");
const cooldown = require("../lib/utils/cooldown");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid } = require("../lib/utils/permissions");
const config = require("../config");

/**
 * Per-message activity tracker (research R16): hook-only module, no command.
 *
 * `onMessage` counts the messages of group members into UserStats:
 *   - groups only (a private chat is never tracked);
 *   - text, image, video, audio, sticker and document messages only (no reactions,
 *     protocol messages, poll updates, button replies or empty bodies);
 *   - messages sent by the bot's own account (`fromMe`) are skipped, because they
 *     cannot be told apart from the bot's automated replies;
 *   - counters are incremented in SQL (atomic, no read-modify-write race);
 *   - XP is granted at most once a minute per (user, group), counters always grow.
 *
 * Tracking is best effort and runs in the background: the hook never throws and
 * never stops the pipeline.
 */

const XP_PER_LEVEL = 100;
const XP_TEXT = 5;
const XP_COMMAND = 10;
const XP_MEDIA = 15;
const XP_COOLDOWN_MS = 60 * 1000;

const TEXT_TYPES = new Set(["conversation", "extendedTextMessage"]);
const MEDIA_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "stickerMessage",
  "documentMessage",
]);

// (group, user) rows known to exist: spares one INSERT OR IGNORE per message
const MAX_KNOWN_ROWS = 20000;
const knownRows = new Set();

/** Level reached with `xp` experience points: floor(sqrt(xp / 100)) */
function computeLevel(xp) {
  return Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / XP_PER_LEVEL));
}

/** Experience points needed to reach `level` (inverse of computeLevel) */
function xpForLevel(level) {
  const n = Math.max(0, Math.floor(Number(level) || 0));
  return n * n * XP_PER_LEVEL;
}

/** "<prefix>word" where the word starts with a letter or a digit ("..." is not a command) */
function looksLikeCommand(body) {
  const prefix = String(config.PREFIX || "");
  if (!prefix || !body.startsWith(prefix)) return false;
  return /^[\p{L}\p{N}]/u.test(body.slice(prefix.length));
}

/**
 * What a message counts for, or null when it is not tracked.
 * @returns {{ media: boolean, command: boolean, xp: number }|null}
 */
function classify(message) {
  if (!message || !message.isGroup || message.fromMe) return null;
  if (message.isInteractiveReply) return null;

  const isMedia = MEDIA_TYPES.has(message.type);
  if (!isMedia && !TEXT_TYPES.has(message.type)) return null;

  const body = typeof message.body === "string" ? message.body : "";
  if (!isMedia && !body.trim()) return null;

  const command = looksLikeCommand(body);
  return {
    media: isMedia,
    command,
    xp: isMedia ? XP_MEDIA : command ? XP_COMMAND : XP_TEXT,
  };
}

/** Make sure the (group, user) row exists; concurrent calls are safe */
async function ensureRow(groupJid, jid) {
  const key = `${groupJid}\u0000${jid}`;
  if (knownRows.has(key)) return;
  await UserStats.bulkCreate(
    [
      {
        jid,
        groupJid,
        messageCount: 0,
        commandCount: 0,
        mediaCount: 0,
        xp: 0,
        level: 0,
        lastActiveAt: new Date(),
      },
    ],
    { ignoreDuplicates: true },
  );
  if (knownRows.size >= MAX_KNOWN_ROWS) knownRows.clear();
  knownRows.add(key);
}

/** Bring the stored level up to date after an XP grant (the level never goes down here) */
async function syncLevel(groupJid, jid) {
  const where = { jid, groupJid };
  const row = await UserStats.findOne({
    where,
    attributes: ["xp", "level"],
    raw: true,
  });
  if (!row) return;
  const level = Math.max(row.level || 0, computeLevel(row.xp));
  await UserStats.update({ level, lastActiveAt: new Date() }, { where });
}

/**
 * Count one message. Resolves to true when it was counted.
 * (Exported for tests; the pipeline calls `onMessage`.)
 * @param {import("../lib/classes/Message").Message} message
 */
async function track(message) {
  const info = classify(message);
  if (!info) return false;

  const jid = normalizeJid(message.sender);
  const groupJid = message.jid;
  if (!jid || !groupJid) return false;

  const grantXp = cooldown.hit(jid, `xp:${groupJid}`, XP_COOLDOWN_MS) === 0;

  await ensureRow(groupJid, jid);

  const fields = { messageCount: 1 };
  if (info.media) fields.mediaCount = 1;
  if (info.command) fields.commandCount = 1;
  if (grantXp) fields.xp = info.xp;
  await UserStats.increment(fields, { where: { jid, groupJid } });

  if (grantXp) await syncLevel(groupJid, jid);
  return true;
}

module.exports = {
  // onMessage order (lower first, default 100): count every message before anything can consume it
  hookPriority: { onMessage: 20 },
  /**
   * Hook: every non-status message, before command dispatch.
   * Fire and forget; always lets the pipeline continue.
   */
  onMessage(message) {
    try {
      if (classify(message)) {
        track(message).catch((err) => {
          console.error("trackmessages: write failed", safeLog(err));
        });
      }
    } catch (err) {
      console.error("trackmessages: error", safeLog(err));
    }
    return false;
  },

  track,
  computeLevel,
  xpForLevel,
  XP_PER_LEVEL,
};
