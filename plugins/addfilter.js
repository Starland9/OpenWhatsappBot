const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { Filter } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const cooldown = require("../lib/utils/cooldown");

/**
 * Filter plugin: automatic replies to chosen words or phrases (groups only).
 *   .filter <pattern>=<response>   → add or update a filter
 *   .filter list                   → numbered list (see .delfilter)
 *
 * `onMessage` answers non-command group messages that contain the pattern as a
 * whole word or phrase (case-insensitive). The pattern is plain text: it is
 * regex-escaped, never used as a regular expression. Filters are cached per
 * group (`filters:<groupJid>`); delfilter.js shares the helpers below.
 */

const MAX_FILTERS_PER_GROUP = 50;
const MAX_PATTERN_LENGTH = 100;
const MAX_RESPONSE_LENGTH = 1000;
const LIST_RESPONSE_PREVIEW = 80;
const FILTER_COOLDOWN_MS = 10 * 1000;
const LIST_WORDS = new Set(["list", "liste", "get"]);

const filtersKey = (groupJid) => `filters:${groupJid}`;

/** Collapse whitespace and lower-case: the form used to compare patterns */
const normalizePattern = (pattern) =>
  String(pattern).trim().replace(/\s+/g, " ").toLowerCase();

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regex matching the pattern as a whole word / phrase (letters, digits and "_"
 * can't touch it on either side). Spaces match any run of whitespace.
 */
function buildMatcher(pattern) {
  const body = pattern.trim().split(/\s+/).map(escapeRegex).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
}

/**
 * Filters of a group straight from the database, oldest first. This order is
 * the numbering shown by `.filter list` and accepted by `.delfilter`.
 * @returns {Promise<Array<{ id: number, pattern: string, response: string }>>}
 */
async function loadFilters(groupJid) {
  return await Filter.findAll({
    where: { groupJid },
    attributes: ["id", "pattern", "response"],
    order: [["id", "ASC"]],
    raw: true,
  });
}

/**
 * Compiled filters of a group, cached. Empty list when the group has none.
 * @returns {Promise<Array<{ id: number, key: string, response: string, matcher: RegExp }>>}
 */
async function getGroupFilters(groupJid) {
  const list = await settingsCache.getOrLoad(filtersKey(groupJid), async () => {
    const compiled = [];
    for (const row of await loadFilters(groupJid)) {
      const key = normalizePattern(row.pattern);
      if (!key) continue;
      try {
        compiled.push({
          id: row.id,
          key,
          response: row.response,
          matcher: buildMatcher(row.pattern),
        });
      } catch (_) {
        // a pattern that can't be compiled is ignored
      }
    }
    return compiled;
  });
  return Array.isArray(list) ? list : [];
}

/** Drop the cached filters of a group; call after every add / update / delete */
function invalidateFilters(groupJid) {
  settingsCache.invalidate(filtersKey(groupJid));
}

/**
 * Muted and banned members (plugins/role.js) must reach role.onMessage, which
 * deletes their messages: a filter answer would stop the pipeline before it.
 */
async function isRestrictedAuthor(message) {
  try {
    const role = await require("./role").getMessageRole(message);
    return role === "muted" || role === "banned";
  } catch (_) {
    return false;
  }
}

/**
 * Hook: answer group messages that match a filter. Returns true (stops the
 * pipeline) when a filter matched, even while its cooldown is running.
 */
async function onMessage(message) {
  if (!message.isGroup || message.fromMe || message.isCommand) return false;
  if (message.isInteractiveReply) return false;

  const text = (message.body || "").trim();
  if (!text) return false;

  const filters = await getGroupFilters(message.jid);
  if (!filters.length) return false;

  const normalized = normalizePattern(text);
  const hit =
    filters.find((filter) => filter.key === normalized) ||
    filters.find((filter) => filter.matcher.test(text));
  if (!hit) return false;

  if (await isRestrictedAuthor(message)) return false;

  // Same filter again within 10 s: stay silent, but still consume the message
  if (cooldown.hit(message.jid, `filter:${hit.key}`, FILTER_COOLDOWN_MS)) return true;

  await message.reply(hit.response);
  return true;
}

const oneLine = (text, max) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

async function listFilters(message) {
  const rows = await loadFilters(message.jid);
  if (!rows.length) {
    return await message.reply(getLang("plugins.addfilter.empty", config.PREFIX));
  }
  const lines = rows.map((row, i) =>
    getLang(
      "plugins.addfilter.list_item",
      i + 1,
      row.pattern,
      oneLine(row.response, LIST_RESPONSE_PREVIEW),
    ),
  );
  return await message.reply(
    [
      getLang("plugins.addfilter.list_title", rows.length),
      lines.join("\n"),
      getLang("plugins.addfilter.list_hint", config.PREFIX),
    ].join("\n\n"),
  );
}

module.exports = {
  command: {
    pattern: "filter",
    desc: getLang("plugins.addfilter.desc"),
    type: "admin",
    adminOnly: true,
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").trim();

    if (!raw) {
      return await message.reply(getLang("plugins.addfilter.usage", config.PREFIX));
    }
    if (LIST_WORDS.has(raw.toLowerCase())) {
      return await listFilters(message);
    }

    const eq = raw.indexOf("=");
    if (eq < 0) {
      return await message.reply(getLang("plugins.addfilter.invalid_format", config.PREFIX));
    }
    const pattern = raw.slice(0, eq).trim().replace(/\s+/g, " ");
    const response = raw.slice(eq + 1).trim();
    if (!pattern || !response) {
      return await message.reply(getLang("plugins.addfilter.invalid_format", config.PREFIX));
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return await message.reply(getLang("plugins.addfilter.pattern_too_long", MAX_PATTERN_LENGTH));
    }
    if (response.length > MAX_RESPONSE_LENGTH) {
      return await message.reply(getLang("plugins.addfilter.response_too_long", MAX_RESPONSE_LENGTH));
    }

    const rows = await loadFilters(message.jid);
    const wanted = normalizePattern(pattern);
    const existing = rows.find((row) => normalizePattern(row.pattern) === wanted);

    let created = false;
    if (existing) {
      await Filter.update({ response }, { where: { id: existing.id } });
    } else {
      if (rows.length >= MAX_FILTERS_PER_GROUP) {
        return await message.reply(getLang("plugins.addfilter.limit", MAX_FILTERS_PER_GROUP));
      }
      const [row, wasCreated] = await Filter.findOrCreate({
        where: { groupJid: message.jid, pattern },
        defaults: { response, isGlobal: false },
      });
      created = wasCreated;
      if (!created) await row.update({ response });
    }

    invalidateFilters(message.jid);
    return await message.reply(
      created
        ? getLang("plugins.addfilter.added", pattern, response)
        : getLang("plugins.addfilter.updated", pattern, response),
    );
  },

  onMessage,

  // Helpers shared with plugins/delfilter.js
  loadFilters,
  getGroupFilters,
  invalidateFilters,
  normalizePattern,
};
