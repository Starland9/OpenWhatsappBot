"use strict";

/**
 * Known chats: the chats the panel may offer as broadcast destinations, and the list of
 * former groups (specs/002-admin-panel: contracts/runtime.md section 8, data-model 1.9, FR-046).
 *
 * The hook plugin (`plugins/knownchats.js`) and the admin routes are other agents' work; this
 * module is the shared data layer:
 *
 *   record(message)                    hook helper: a private chat is stored the first time it writes,
 *                                      `lastSeenAt` is refreshed at most once per hour per JID
 *   seedIfEmpty()                      first fill from Conversation, User and the group JIDs of the other tables
 *   refreshGroups(groups, now)         names and `leftAt` from `groupFetchAllParticipating()`
 *   markLeft(jid) / clearLeft(jid)     the bot was removed from / is back in a group
 *   remove(jid)                        forget a chat (the group-settings delete service)
 *   listDestinations({ q, kind })      what the broadcaster accepts
 *   assertDestinations(jids)           throws `invalid_destination` for anything else
 *   list({ kind, q, page, pageSize, selectable })   CHAT-1
 *   pruneSilent(now)                   private chats silent for more than 365 days
 *
 * A destination is valid only if it is a `private` row that is not in `BannedChat` (neither
 * under its JID nor under its phone-number JID), or a `group` row with `leftAt IS NULL`.
 * Entries are de-duplicated by `pnJid || jid`, so a person seen as phone number and as LID is
 * one destination. A number typed by hand is never a destination: it is not in the table.
 *
 * Errors are `Error`s with a stable `code`; `invalid_destination` carries
 * `params: { indices }` (positions in the submitted list, never values).
 * Time: every function that depends on the clock takes `now` (ms or Date, default Date.now()).
 */

const { Op } = require("sequelize");
const database = require("../database");
const { createLogger } = require("./logger");

const logger = createLogger("knownChats");

const { KnownChat, BannedChat } = database;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SILENT_DAYS = 365;
const BATCH = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Tables that hold group JIDs, with the column that does */
const GROUP_SOURCES = [
  ["Group", "jid"],
  ["Filter", "groupJid"],
  ["GroupRole", "groupJid"],
  ["UserStats", "groupJid"],
  ["Warn", "groupJid"],
  ["GroupEconomy", "groupJid"],
  ["Idea", "groupJid"],
  ["Quote", "groupJid"],
];

/** jid -> ms of the last write, so one chat costs at most one write per hour */
const touched = new Map();

function chatError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

const toMillis = (now) => {
  if (now instanceof Date) return now.getTime();
  return Number.isFinite(now) ? Number(now) : Date.now();
};
const toDate = (now) => new Date(toMillis(now));

const isString = (value) => typeof value === "string" && value.length > 0;
const isGroupJid = (jid) => isString(jid) && jid.endsWith("@g.us");
const isPrivateJid = (jid) => isString(jid) && (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"));
const isPnJid = (jid) => isString(jid) && jid.endsWith("@s.whatsapp.net");

/** De-duplication key: the phone-number form when known */
const keyOf = (row) => row.pnJid || row.jid;

// ---------------------------------------------------------------------------
// Recording (hook helper)
// ---------------------------------------------------------------------------

/**
 * Record the chat of a message. Cheap: a throttled message costs one Map lookup. The write is
 * fire-and-forget for the hook (it may ignore the returned promise); it never rejects.
 *
 * Only a private chat that wrote to the bot is recorded: `!isGroup && !fromMe`, JID ending
 * `@s.whatsapp.net` or `@lid` (never `status@broadcast`, a newsletter or a broadcast list).
 *
 * @param {{ jid: string, isGroup?: boolean, fromMe?: boolean, sender?: string, pushName?: string, data?: { pushName?: string } }} message
 * @param {{ now?: number|Date }} [options]
 * @returns {Promise<void>|null} the write in flight, or null when nothing is written
 */
function record(message, { now } = {}) {
  try {
    if (!message || message.isGroup || message.fromMe) return null;
    const jid = message.jid;
    if (!isPrivateJid(jid)) return null;

    const at = toMillis(now);
    const last = touched.get(jid);
    if (last !== undefined && at - last < HOUR_MS) return null;

    // Entries older than 1 h are dropped on each write: the map stays as small as the last hour
    for (const [key, ts] of touched) {
      if (at - ts >= HOUR_MS) touched.delete(key);
    }
    touched.set(jid, at);

    const sender = message.sender;
    const pnJid = isPnJid(jid) ? jid : isPnJid(sender) ? sender : null;
    const name = String(message.pushName || message.data?.pushName || "").trim().slice(0, 255) || null;
    const date = new Date(at);

    // A missing name/phone number must not erase a known one
    const updateOnDuplicate = ["lastSeenAt"];
    if (pnJid) updateOnDuplicate.push("pnJid");
    if (name) updateOnDuplicate.push("name");

    return KnownChat.bulkCreate([{ jid, kind: "private", pnJid, name, firstSeenAt: date, lastSeenAt: date }], {
      updateOnDuplicate,
    })
      .then(() => undefined)
      .catch((err) => {
        touched.delete(jid); // try again with the next message
        logger.warn({ err: err?.message }, "known chat not recorded");
      });
  } catch (err) {
    logger.debug({ err: err?.message }, "known chat ignored");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seeding and group refresh
// ---------------------------------------------------------------------------

/** Distinct values of one column of one model */
async function distinctValues(modelName, column) {
  const model = database[modelName];
  if (!model) return [];
  const rows = await model.findAll({ attributes: [column], group: [column], raw: true });
  return rows.map((row) => row[column]).filter(isString);
}

/**
 * Fill an empty table from what the bot already knows: `Conversation.jid` and `User.jid`
 * (private chats), and every group JID found in Group, Filter, GroupRole, UserStats, Warn,
 * GroupEconomy, Idea and Quote. Does nothing when the table already has a row.
 * @param {{ now?: number|Date }} [options]
 * @returns {Promise<number>} rows created
 */
async function seedIfEmpty({ now } = {}) {
  if ((await KnownChat.count()) > 0) return 0;
  const date = toDate(now);
  const rows = new Map();

  for (const modelName of ["Conversation", "User"]) {
    for (const jid of await distinctValues(modelName, "jid")) {
      if (isPrivateJid(jid) && !rows.has(jid)) {
        rows.set(jid, { jid, kind: "private", pnJid: isPnJid(jid) ? jid : null, name: null, firstSeenAt: date, lastSeenAt: date });
      }
    }
  }

  const groupNames = new Map();
  if (database.Group) {
    for (const group of await database.Group.findAll({ attributes: ["jid", "name"], raw: true })) {
      if (group.name) groupNames.set(group.jid, String(group.name).slice(0, 255));
    }
  }
  for (const [modelName, column] of GROUP_SOURCES) {
    for (const jid of await distinctValues(modelName, column)) {
      if (isGroupJid(jid) && !rows.has(jid)) {
        rows.set(jid, { jid, kind: "group", pnJid: null, name: groupNames.get(jid) || null, firstSeenAt: date, lastSeenAt: date });
      }
    }
  }

  const all = [...rows.values()];
  for (let i = 0; i < all.length; i += BATCH) {
    await KnownChat.bulkCreate(all.slice(i, i + BATCH), { ignoreDuplicates: true });
  }
  if (all.length > 0) logger.info({ count: all.length }, "known chats seeded");
  return all.length;
}

/**
 * Synchronize the group rows with the groups the bot is in right now.
 * Present groups get their name and `lastSeenAt` refreshed and `leftAt` cleared; group rows that
 * are absent get `leftAt = now` (kept when already set). Call it only after a successful
 * `groupFetchAllParticipating()`: an empty list marks every group as left.
 *
 * @param {Array<{ id?: string, jid?: string, subject?: string, name?: string }>|Object<string, object>} groups
 *   the array, or the object keyed by JID, that Baileys returns
 * @param {number|Date} [now]
 * @returns {Promise<{ listed: number, added: number, back: number, left: number }>}
 */
async function refreshGroups(groups, now) {
  const date = toDate(now);
  const list = Array.isArray(groups) ? groups : Object.entries(groups || {}).map(([id, g]) => ({ id, ...g }));

  const present = new Map();
  for (const group of list) {
    const jid = group?.id || group?.jid;
    if (!isGroupJid(jid)) continue;
    present.set(jid, String(group.subject || group.name || "").trim().slice(0, 255) || null);
  }

  const existing = new Map(
    (await KnownChat.findAll({ where: { kind: "group" }, attributes: ["jid", "name", "leftAt"], raw: true })).map((row) => [row.jid, row]),
  );

  let added = 0;
  let back = 0;
  const rows = [];
  for (const [jid, name] of present) {
    const known = existing.get(jid);
    if (!known) added++;
    else if (known.leftAt) back++;
    rows.push({ jid, kind: "group", pnJid: null, name: name || known?.name || null, firstSeenAt: date, lastSeenAt: date, leftAt: null });
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    await KnownChat.bulkCreate(rows.slice(i, i + BATCH), { updateOnDuplicate: ["name", "lastSeenAt", "leftAt"] });
  }

  const absent = { kind: "group", leftAt: null };
  if (present.size > 0) absent.jid = { [Op.notIn]: [...present.keys()] };
  const [left] = await KnownChat.update({ leftAt: date }, { where: absent });

  return { listed: present.size, added, back, left };
}

/**
 * The bot was removed from a group: it becomes a former group. An unknown group is recorded
 * as already left. Keeps the first `leftAt`.
 * @returns {Promise<boolean>} true when something changed
 */
async function markLeft(jid, now) {
  if (!isGroupJid(jid)) return false;
  const date = toDate(now);
  const row = await KnownChat.findByPk(jid, { attributes: ["jid", "leftAt"], raw: true });
  if (!row) {
    await KnownChat.bulkCreate([{ jid, kind: "group", firstSeenAt: date, lastSeenAt: date, leftAt: date }], { ignoreDuplicates: true });
    return true;
  }
  const [changed] = await KnownChat.update({ leftAt: date }, { where: { jid, leftAt: null } });
  return changed > 0;
}

/**
 * The bot is back in a group.
 * @returns {Promise<boolean>} true when a `leftAt` was cleared
 */
async function clearLeft(jid) {
  const [changed] = await KnownChat.update({ leftAt: null }, { where: { jid, leftAt: { [Op.ne]: null } } });
  return changed > 0;
}

/**
 * Forget a chat (a former group whose settings were deleted).
 * @returns {Promise<boolean>}
 */
async function remove(jid) {
  touched.delete(jid);
  return (await KnownChat.destroy({ where: { jid } })) > 0;
}

/**
 * Delete the private rows silent for more than 365 days (group rows stay, so "former group" keeps
 * showing until the owner deletes the group's settings).
 * @param {number|Date} [now]
 * @returns {Promise<number>} rows deleted
 */
async function pruneSilent(now) {
  const cutoff = new Date(toMillis(now) - SILENT_DAYS * DAY_MS);
  return KnownChat.destroy({ where: { kind: "private", lastSeenAt: { [Op.lt]: cutoff } } });
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** JIDs of the chats where the bot is disabled, as a Set */
async function bannedSet() {
  const rows = await BannedChat.findAll({ attributes: ["jid"], raw: true });
  return new Set(rows.map((row) => row.jid));
}

/** Can the broadcaster send to this row? */
function isSelectable(row, banned) {
  if (row.kind === "group") return !row.leftAt;
  return !banned.has(row.jid) && !(row.pnJid && banned.has(row.pnJid));
}

const publicRow = (row, banned) => ({
  jid: row.jid,
  kind: row.kind,
  name: row.name || null,
  pnJid: row.pnJid || null,
  lastSeenAt: row.lastSeenAt,
  selectable: isSelectable(row, banned),
});

/**
 * De-duplicate by `pnJid || jid`: the first row wins (rows are ordered by `lastSeenAt`, newest
 * first), except that a selectable row replaces a non-selectable one.
 */
function dedupe(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const kept = byKey.get(key);
    if (!kept || (!kept.selectable && item.selectable)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

/** Rows (newest first) filtered by kind and a case-insensitive `q` on name and JID */
async function findRows({ kind, q } = {}) {
  const where = {};
  if (kind === "private" || kind === "group") where.kind = kind;
  const rows = await KnownChat.findAll({
    where,
    attributes: ["jid", "kind", "pnJid", "name", "lastSeenAt", "leftAt"],
    order: [["lastSeenAt", "DESC"], ["jid", "ASC"]],
    raw: true,
  });
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => `${row.name || ""}\n${row.jid}\n${row.pnJid || ""}`.toLowerCase().includes(needle));
}

/**
 * What the broadcaster accepts: private rows not in `BannedChat`, group rows with `leftAt IS NULL`,
 * de-duplicated by `pnJid || jid`.
 * @param {{ q?: string, kind?: "private"|"group" }} [filter]
 * @returns {Promise<{ jid: string, kind: string, name: string|null, pnJid: string|null, lastSeenAt: Date }[]>}
 */
async function listDestinations({ q, kind } = {}) {
  const banned = await bannedSet();
  const items = (await findRows({ q, kind })).map((row) => publicRow(row, banned)).filter((item) => item.selectable);
  return dedupe(items).map(({ selectable, ...item }) => item);
}

/**
 * Check a list of destinations typed or submitted by the client (FR-046).
 * @param {string[]} jids
 * @returns {Promise<string[]>} the JIDs, in order, de-duplicated by `pnJid || jid`
 * @throws {Error} code `invalid_destination`, `params.indices`: positions of the refused entries
 */
async function assertDestinations(jids) {
  if (!Array.isArray(jids)) throw chatError("invalid_destination", "destinations must be a list", { params: { indices: [] } });

  const wanted = jids.filter((jid) => isString(jid) && jid !== "status@broadcast");
  const rows = wanted.length ? await KnownChat.findAll({ where: { jid: wanted }, raw: true }) : [];
  const banned = await bannedSet();
  const byJid = new Map(rows.map((row) => [row.jid, row]));

  const indices = [];
  const seen = new Set();
  const accepted = [];
  jids.forEach((jid, index) => {
    const row = isString(jid) ? byJid.get(jid) : null;
    if (!row || !isSelectable(row, banned)) {
      indices.push(index);
      return;
    }
    const key = keyOf(row);
    if (seen.has(key)) return;
    seen.add(key);
    accepted.push(jid);
  });

  if (indices.length > 0) {
    throw chatError("invalid_destination", `${indices.length} destination(s) refused`, { params: { indices } });
  }
  return accepted;
}

/**
 * The known-chat picker (CHAT-1).
 * @param {{ kind?: "private"|"group", q?: string, page?: number, pageSize?: number, selectable?: boolean }} [options]
 *   `selectable: true` keeps only valid broadcast destinations
 * @returns {Promise<{ items: { jid: string, kind: string, name: string|null, lastSeenAt: Date, selectable: boolean }[], page: number, pageSize: number, total: number }>}
 */
async function list({ kind, q, page, pageSize, selectable } = {}) {
  const size = Math.min(Math.max(Math.trunc(Number(pageSize)) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const banned = await bannedSet();
  let items = dedupe((await findRows({ kind, q })).map((row) => publicRow(row, banned)));
  if (selectable) items = items.filter((item) => item.selectable);

  const total = items.length;
  const lastPage = Math.max(Math.ceil(total / size), 1);
  const current = Math.min(Math.max(Math.trunc(Number(page)) || 1, 1), lastPage);
  const slice = items.slice((current - 1) * size, current * size);
  return {
    items: slice.map(({ jid, kind: k, name, lastSeenAt, selectable: ok }) => ({ jid, kind: k, name, lastSeenAt, selectable: ok })),
    page: current,
    pageSize: size,
    total,
  };
}

/** Forget the throttle map (tests only) */
function _reset() {
  touched.clear();
}

/** Number of JIDs in the throttle map (tests only) */
function _touchedSize() {
  return touched.size;
}

module.exports = {
  HOUR_MS,
  SILENT_DAYS,
  record,
  seedIfEmpty,
  refreshGroups,
  markLeft,
  clearLeft,
  remove,
  pruneSilent,
  listDestinations,
  assertDestinations,
  list,
  _reset,
  _touchedSize,
};
