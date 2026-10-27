const { Op } = require("sequelize");
const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { User } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const cooldown = require("../lib/utils/cooldown");
const { safeLog } = require("../lib/utils/http");
const {
  normalizeJid,
  jidUser,
  isLidJid,
  toPnJid,
} = require("../lib/utils/permissions");

/**
 * AFK (away from keyboard) plugin, per user.
 *   .afk [reason]  → mark yourself away (open to everyone)
 *
 * The status lives in User.afkReason / User.afkTime (afkTime null = not away)
 * and is mirrored in a cached Map (settingsCache key "afk_users"), so the
 * `onMessage` hook never queries the database:
 *  - the next message from an away user clears the status ("back after ...");
 *  - a message that mentions or quotes an away user gets a notice (one per
 *    chat and user every 60 s).
 * The hook never stops the pipeline.
 */

const AFK_KEY = "afk_users";
const AFK_CACHE_TTL_MS = 10 * 60 * 1000;
const NOTICE_COOLDOWN_MS = 60 * 1000;
const MAX_REASON_LENGTH = 150;
const MAX_NOTICES_PER_MESSAGE = 3;
const COMMAND_NAMES = ["afk"];

/** @returns {Promise<Map<string, { reason: string, since: number }>>} jid -> status */
async function loadAfkUsers() {
  const rows = await User.findAll({
    where: { afkTime: { [Op.ne]: null } },
    attributes: ["jid", "afkReason", "afkTime"],
    raw: true,
  });
  const users = new Map();
  for (const row of rows) {
    const jid = normalizeJid(row.jid);
    const since = new Date(row.afkTime).getTime();
    if (jid && Number.isFinite(since)) {
      users.set(jid, { reason: row.afkReason || "", since });
    }
  }
  return users;
}

/** Away users. The Map is shared: it is updated in place when a status changes. */
async function getAfkUsers() {
  const users = await settingsCache.getOrLoad(AFK_KEY, loadAfkUsers, AFK_CACHE_TTL_MS);
  return users instanceof Map ? users : new Map();
}

/** "2 h 5 min", "3 min", "40 s": the two largest units */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts = [];
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) parts.push(getLang("plugins.afk.unit_d", days));
  if (hours) parts.push(getLang("plugins.afk.unit_h", hours));
  if (minutes) parts.push(getLang("plugins.afk.unit_m", minutes));
  if (!parts.length) parts.push(getLang("plugins.afk.unit_s", Math.max(1, total)));
  return parts.slice(0, 2).join(" ");
}

/** The message is the `afk` command itself (it must not end the status) */
function isAfkCommand(message) {
  if (!message.isCommand) return false;
  const word = String(message.body)
    .slice(config.PREFIX.length)
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
  return COMMAND_NAMES.includes(word);
}

/** Identities of the author as stored keys (phone-number form first) */
const senderKeys = (message) =>
  [...new Set([message.sender, message.senderLid].map(normalizeJid).filter(Boolean))];

/** The author is back: clear the status (cache first, so a concurrent message can't repeat it) */
async function handleReturn(message, afk) {
  for (const jid of senderKeys(message)) {
    const entry = afk.get(jid);
    if (!entry) continue;

    afk.delete(jid);
    try {
      await User.update({ afkReason: null, afkTime: null }, { where: { jid } });
    } catch (error) {
      afk.set(jid, entry); // keep the cache in line with the database
      console.error("afk: could not clear the status", safeLog(error));
      return;
    }
    await message.reply(
      getLang("plugins.afk.back", `@${jidUser(jid)}`, formatDuration(Date.now() - entry.since)),
      { mentions: [jid] },
    );
    return;
  }
}

/** The message mentions or quotes away users: tell the chat (with a cooldown per chat and user) */
async function handleMentions(message, afk) {
  if (!message.isGroup) return;

  const candidates = [...(message.mentions || []), message.quoted?.sender].filter(Boolean);
  if (!candidates.length) return;

  const own = new Set(senderKeys(message));
  const found = new Map(); // phone-number JID -> status
  for (const raw of candidates) {
    let jid = normalizeJid(raw);
    if (!jid) continue;
    let entry = afk.get(jid);
    if (!entry && isLidJid(jid)) {
      jid = await toPnJid(message, jid);
      entry = afk.get(jid);
    }
    if (!entry || own.has(jid) || found.has(jid)) continue;
    found.set(jid, entry);
    if (found.size >= MAX_NOTICES_PER_MESSAGE) break;
  }

  const lines = [];
  const mentions = [];
  for (const [jid, entry] of found) {
    if (cooldown.hit(message.jid, `afk:${jid}`, NOTICE_COOLDOWN_MS)) continue;
    const since = formatDuration(Date.now() - entry.since);
    lines.push(
      entry.reason
        ? getLang("plugins.afk.notice_reason", `@${jidUser(jid)}`, entry.reason, since)
        : getLang("plugins.afk.notice", `@${jidUser(jid)}`, since),
    );
    mentions.push(jid);
  }
  if (lines.length) await message.reply(lines.join("\n"), { mentions });
}

/**
 * Hook: end the status of an author who is back, and answer mentions / quotes
 * of away users. Cache only, never stops the pipeline.
 */
async function onMessage(message) {
  try {
    const afk = await getAfkUsers();
    if (afk.size === 0) return false;

    const isActivity = !!message.body || message.hasMedia;
    if (isActivity && !isAfkCommand(message)) await handleReturn(message, afk);

    // The bot's own messages (including these notices) never trigger a notice
    if (!message.fromMe) await handleMentions(message, afk);
  } catch (error) {
    console.error("afk: hook failed", safeLog(error));
  }
  return false;
}

/** Hook: (re)load the away users when the connection opens */
async function onReady() {
  settingsCache.invalidate(AFK_KEY);
  await getAfkUsers();
}

module.exports = {
  // onMessage order (lower first, default 100): observer: clears AFK / answers mentions, never consumes
  hookPriority: { onMessage: 30 },
  command: {
    pattern: COMMAND_NAMES.join("|"),
    desc: getLang("plugins.afk.desc"),
    type: "general",
  },

  async execute(message, argsString, ctx) {
    const jid = await toPnJid(message, message.sender);
    if (!jid) return;

    const reason = String(ctx?.rawArgs ?? argsString ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_REASON_LENGTH);

    const afk = await getAfkUsers();
    const previous = afk.get(jid);

    const [user] = await User.findOrCreate({ where: { jid }, defaults: { name: "" } });
    // Setting a new reason while already away keeps the original start time
    const since = previous ? new Date(previous.since) : new Date();
    await user.update({ afkReason: reason || null, afkTime: since });
    afk.set(jid, { reason, since: since.getTime() });

    let text;
    if (previous) {
      text = reason
        ? getLang("plugins.afk.updated_reason", reason)
        : getLang("plugins.afk.updated");
    } else {
      text = reason ? getLang("plugins.afk.set_reason", reason) : getLang("plugins.afk.set");
    }
    return await message.reply(text);
  },

  onMessage,
  onReady,
};
