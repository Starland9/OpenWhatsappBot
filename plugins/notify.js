const { Op } = require("sequelize");
const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { NotifyKeyword } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const cooldown = require("../lib/utils/cooldown");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid, jidUser, toPnJid } = require("../lib/utils/permissions");

/**
 * Keyword alerts (research R17).
 *
 *   .notify add <keyword>     group only: the keyword is scoped to this group
 *   .notify del <keyword>     in a group: this group's keyword; in private: all scopes
 *   .notify list              in a group: this group's keywords; in private: all of them
 *   .notify on | off          all your keywords
 *   .notify clear             in a group: this group's keywords; in private: all of them
 *
 * The `onMessage` hook watches group messages only. A keyword alerts its owner
 * by DM when it appears as a whole word (case-insensitive) in a message of the
 * group where it was registered, provided the owner is still a member of that
 * group and is not the author. Never from private chats. Keywords are read from
 * a cache (settingsCache `notify:<groupJid>`), never from the database per
 * message. The hook never stops the pipeline.
 */

const MIN_KEYWORD_LENGTH = 3;
const MAX_KEYWORD_LENGTH = 50;
const MAX_KEYWORDS_PER_USER = 20;
const CACHE_PREFIX = "notify:";
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MS = 5 * 60 * 1000; // one alert per (user, keyword) every 5 minutes
const DM_LIMIT = 10; // alerts per user and hour
const DM_WINDOW_MS = 60 * 60 * 1000;
const EXCERPT_LENGTH = 300;
const MAX_SCANNED_LENGTH = 4096;

const ADD_WORDS = new Set(["add", "set"]);
const DELETE_WORDS = new Set(["del", "delete", "remove"]);
const LIST_WORDS = new Set(["list", "liste"]);
const ON_WORDS = new Set(["on", "enable"]);
const OFF_WORDS = new Set(["off", "disable"]);
const CLEAR_WORDS = new Set(["clear"]);

const cacheKey = (groupJid) => `${CACHE_PREFIX}${groupJid}`;

/** Lower-cased, single-spaced keyword */
const normalizeKeyword = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive matcher (letters and digits, any script) */
function compileKeyword(keyword) {
  const body = escapeRegex(keyword).replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
}

/** Stored user id (phone-number form first) and the other forms of the sender */
async function identityForms(message) {
  const pn = await toPnJid(message, message.sender);
  return [...new Set([pn, normalizeJid(message.sender), normalizeJid(message.senderLid)].filter(Boolean))];
}

function usage() {
  return `${getLang("common.usage_prefix")}\n${getLang("plugins.notify.usage", config.PREFIX)}`;
}

/** Drop every cached group (the keyword set changed) */
const invalidateAll = () => settingsCache.invalidatePrefix(CACHE_PREFIX);

/* -------------------------------------------------------------------------- */
/* Command                                                                    */
/* -------------------------------------------------------------------------- */

async function addKeyword(message, rest) {
  if (!message.isGroup) return message.reply(getLang("plugins.notify.group_only"));

  const keyword = normalizeKeyword(rest);
  if (!keyword) return message.reply(getLang("plugins.notify.add_usage", config.PREFIX));
  if (keyword.length < MIN_KEYWORD_LENGTH || !/[\p{L}\p{N}]/u.test(keyword)) {
    return message.reply(getLang("plugins.notify.too_short", MIN_KEYWORD_LENGTH));
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return message.reply(getLang("plugins.notify.too_long", MAX_KEYWORD_LENGTH));
  }

  const forms = await identityForms(message);
  const mine = await NotifyKeyword.findAll({ where: { userJid: { [Op.in]: forms } } });

  if (mine.some((row) => row.scopeJid === message.jid && row.keyword === keyword)) {
    return message.reply(getLang("plugins.notify.already_watching", keyword));
  }
  if (mine.length >= MAX_KEYWORDS_PER_USER) {
    return message.reply(getLang("plugins.notify.limit_reached", MAX_KEYWORDS_PER_USER, config.PREFIX));
  }

  // A user who switched alerts off keeps them off for the new keyword
  const enabled = mine.length === 0 || mine.some((row) => row.enabled);
  await NotifyKeyword.create({ userJid: forms[0], keyword, scopeJid: message.jid, enabled });
  settingsCache.invalidate(cacheKey(message.jid));

  await message.react("✅");
  return message.reply(getLang("plugins.notify.added", keyword, mine.length + 1, MAX_KEYWORDS_PER_USER));
}

/** Rows of the sender, limited to this group when the command is used in a group */
async function ownRows(message) {
  const forms = await identityForms(message);
  const where = { userJid: { [Op.in]: forms } };
  if (message.isGroup) where.scopeJid = message.jid;
  return { forms, where };
}

async function deleteKeyword(message, rest) {
  const keyword = normalizeKeyword(rest);
  if (!keyword) return message.reply(getLang("plugins.notify.remove_usage", config.PREFIX));

  const { where } = await ownRows(message);
  const removed = await NotifyKeyword.destroy({ where: { ...where, keyword } });
  if (!removed) return message.reply(getLang("plugins.notify.not_watching", keyword));

  invalidateAll();
  await message.react("✅");
  return message.reply(getLang("plugins.notify.removed", keyword));
}

async function listKeywords(message) {
  const { forms, where } = await ownRows(message);
  const rows = await NotifyKeyword.findAll({
    where,
    order: [["keyword", "ASC"], ["id", "ASC"]],
  });
  if (!rows.length) return message.reply(getLang("plugins.notify.no_keywords"));

  // In private, a keyword registered in several groups is shown once
  const counts = new Map();
  for (const row of rows) counts.set(row.keyword, (counts.get(row.keyword) || 0) + 1);
  const lines = [...counts].map(([keyword, groups], index) =>
    message.isGroup || groups === 1
      ? getLang("plugins.notify.list_item", index + 1, keyword)
      : getLang("plugins.notify.list_item_groups", index + 1, keyword, groups),
  );

  // On/off is global: look at all the keywords of the user
  const all = message.isGroup
    ? await NotifyKeyword.findAll({ where: { userJid: { [Op.in]: forms } }, attributes: ["enabled"] })
    : rows;
  const enabled = all.some((row) => row.enabled);
  return message.reply(
    `${getLang("plugins.notify.list_title")}\n\n${lines.join("\n")}\n\n` +
      getLang("plugins.notify.status_line", getLang(enabled ? "common.status_enabled" : "common.status_disabled")),
  );
}

async function setEnabled(message, enabled) {
  const forms = await identityForms(message);
  const where = { userJid: { [Op.in]: forms } };
  if (!(await NotifyKeyword.count({ where }))) {
    return message.reply(getLang("plugins.notify.no_keywords"));
  }
  await NotifyKeyword.update({ enabled }, { where });

  invalidateAll();
  await message.react(enabled ? "✅" : "🔕");
  return message.reply(getLang(enabled ? "plugins.notify.enabled_msg" : "plugins.notify.disabled_msg"));
}

async function clearKeywords(message) {
  const { where } = await ownRows(message);
  const removed = await NotifyKeyword.destroy({ where });
  if (!removed) return message.reply(getLang("plugins.notify.no_keywords"));

  invalidateAll();
  await message.react("✅");
  return message.reply(getLang("plugins.notify.cleared", removed));
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

/** Enabled keywords of a group, compiled: [{ userJid, keyword, regex }] */
async function getGroupKeywords(groupJid) {
  const entries = await settingsCache.getOrLoad(
    cacheKey(groupJid),
    async () => {
      const rows = await NotifyKeyword.findAll({
        where: { scopeJid: groupJid, enabled: true },
        raw: true,
      });
      return rows.map((row) => ({
        userJid: normalizeJid(row.userJid),
        keyword: row.keyword,
        regex: compileKeyword(row.keyword),
      }));
    },
    CACHE_TTL_MS,
  );
  return Array.isArray(entries) ? entries : [];
}

/** Every identity (PN, LID, ...) the group metadata knows for a participant */
const participantForms = (participant) =>
  [participant.id, participant.phoneNumber, participant.lid].map(normalizeJid).filter(Boolean);

/** Take an alert slot of the user (max DM_LIMIT per hour); returns a release function or null */
function takeDmSlot(userJid) {
  for (let slot = 0; slot < DM_LIMIT; slot += 1) {
    const key = `notify:dm:${slot}`;
    if (cooldown.hit(userJid, key, DM_WINDOW_MS) === 0) return () => cooldown.reset(userJid, key);
  }
  return null;
}

const excerpt = (text) => {
  const clean = String(text).trim();
  return clean.length > EXCERPT_LENGTH ? `${clean.slice(0, EXCERPT_LENGTH - 1)}…` : clean;
};

async function sendAlert(message, metadata, userJid, keywords) {
  // One alert per (user, keyword) every 5 minutes
  const fresh = [];
  const released = [];
  for (const keyword of keywords) {
    const key = `notify:${message.jid}:${keyword}`;
    if (cooldown.hit(userJid, key, DEDUPE_MS) === 0) {
      fresh.push(keyword);
      released.push(() => cooldown.reset(userJid, key));
    }
  }
  if (!fresh.length) return;

  const releaseSlot = takeDmSlot(userJid);
  if (!releaseSlot) {
    released.forEach((release) => release());
    return;
  }

  const author = message.sender || message.senderLid;
  try {
    await message.client.getSocket().sendMessage(userJid, {
      text: getLang(
        "plugins.notify.alert",
        fresh.join(", "),
        metadata.subject || jidUser(message.jid),
        jidUser(author),
        excerpt(message.body),
      ),
      mentions: author ? [author] : [],
    });
  } catch (error) {
    released.forEach((release) => release());
    releaseSlot();
    console.error("notify: could not send the alert", safeLog(error));
  }
}

/**
 * Hook: alert the owners of the keywords found in a group message. Cache only
 * (the database is not queried per message); never stops the pipeline.
 */
async function onMessage(message) {
  try {
    if (!message.isGroup || message.fromMe || message.isCommand || message.isInteractiveReply) {
      return false;
    }
    if (typeof message.body !== "string" || !message.body) return false;

    const entries = await getGroupKeywords(message.jid);
    if (!entries.length) return false;

    const text = message.body.slice(0, MAX_SCANNED_LENGTH);
    const lower = text.toLowerCase();
    const matches = new Map(); // userJid -> [keyword]
    for (const entry of entries) {
      if (!lower.includes(entry.keyword) || !entry.regex.test(text)) continue;
      if (!matches.has(entry.userJid)) matches.set(entry.userJid, []);
      if (!matches.get(entry.userJid).includes(entry.keyword)) {
        matches.get(entry.userJid).push(entry.keyword);
      }
    }
    if (!matches.size) return false;

    // Members only, never the author. Without metadata nothing is sent.
    const metadata = await message.getGroupMetadata();
    if (!metadata?.participants?.length) return false;

    const authorForms = new Set([message.sender, message.senderLid].map(normalizeJid).filter(Boolean));
    const authorEntry = metadata.participants.find((p) => participantForms(p).some((f) => authorForms.has(f)));
    if (authorEntry) participantForms(authorEntry).forEach((f) => authorForms.add(f));

    const deliveries = [];
    for (const [userJid, keywords] of matches) {
      const member = metadata.participants.find((p) => participantForms(p).includes(userJid));
      if (!member) continue; // left the group, or not a member
      if (participantForms(member).some((f) => authorForms.has(f))) continue; // the author
      deliveries.push(sendAlert(message, metadata, userJid, keywords));
    }
    await Promise.allSettled(deliveries);
  } catch (error) {
    console.error("notify: hook failed", safeLog(error));
  }
  return false;
}

module.exports = {
  command: {
    pattern: "notify",
    desc: getLang("plugins.notify.desc"),
    type: "utility",
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").replace(/^\s+/, "");
    const first = raw.split(/\s+/, 1)[0];
    const action = first.toLowerCase();
    const rest = raw.slice(first.length);

    if (ADD_WORDS.has(action)) return addKeyword(message, rest);
    if (DELETE_WORDS.has(action)) return deleteKeyword(message, rest);
    if (LIST_WORDS.has(action)) return listKeywords(message);
    if (ON_WORDS.has(action)) return setEnabled(message, true);
    if (OFF_WORDS.has(action)) return setEnabled(message, false);
    if (CLEAR_WORDS.has(action)) return clearKeywords(message);
    return message.reply(usage());
  },

  onMessage,
};
