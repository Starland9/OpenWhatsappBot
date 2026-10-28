"use strict";

/**
 * Usage statistics (specs/002-admin-panel: contracts/runtime.md section 5 "Stats",
 * data-model 1.8).
 *
 * `count(metric, subject, n)` bumps an in-memory counter (synchronous, never throws);
 * `flush()` writes the pending counters to `daily_stats` with ONE multi-row upsert:
 *
 *   INSERT INTO "daily_stats" ("day","metric","subject","count") VALUES (...), (...)
 *   ON CONFLICT ("day","metric","subject") DO UPDATE SET "count" = "daily_stats"."count" + excluded."count"
 *
 * so two flushes add up (SQLite >= 3.24 and Postgres). `start()` flushes every 30 s from an
 * `unref`'d timer, `stop()` flushes once more. A crash loses at most 30 s of counters.
 *
 * Metrics (subject):
 *   messages    ""                non-fromMe messages of processed chats (pipeline)
 *   group_msgs  group JID         the same, per group (pipeline)
 *   cmd_ok      command name      after `execute` resolved (registry)
 *   cmd_fail    command name      in the registry's catch block (registry)
 *
 * `day` is `YYYY-MM-DD` in `config.TIMEZONE` at count time (an invalid zone falls back to UTC,
 * like scheduler.resolveZone); a later TIMEZONE change does not rewrite history.
 *
 * The in-memory map is bounded: at 5000 distinct keys an early flush starts at once (the map is
 * swapped synchronously); when a flush keeps failing (database down) or is skipped (maintenance
 * mode), new keys are dropped beyond twice that bound so memory stays flat.
 *
 * Panel queries read the window "today and the previous days - 1 local days" (7 by default):
 *   messagesByDay(days)           -> [{ day, messages }]  zero-filled, oldest first
 *   topCommands(limit, days)      -> [{ name, count }]    cmd_ok, most used first
 *   failingCommands(days)         -> [{ name, count }]    cmd_fail, most failing first
 *   topGroups(limit, days)        -> [{ jid, count }]     group_msgs, most active first
 * Each query takes a trailing `{ now }` option (ms or Date, default Date.now()).
 *
 * Time: every function that depends on the clock takes `now`. No timer exists before `start()`.
 */

const { QueryTypes } = require("sequelize");
const { DateTime, Info } = require("luxon");
const config = require("../../config");
const { DATABASE } = require("../database");
const { createLogger } = require("./logger");

const logger = createLogger("stats");

const METRICS = Object.freeze(["messages", "group_msgs", "cmd_ok", "cmd_fail"]);
const FLUSH_INTERVAL_MS = 30 * 1000;
const MAX_KEYS = 5000; // distinct (day, metric, subject) held before an early flush
const HARD_CAP = MAX_KEYS * 2; // never exceeded, new keys are dropped beyond it
const ROWS_PER_STATEMENT = 500; // 4 bound values per row, far under the SQLite/Postgres limits
const SUBJECT_MAX = 255;
const MAX_WINDOW_DAYS = 90; // retention

const SEP = "\u0000";

/** key -> { day, metric, subject, n } */
const buffer = new Map();
let timer = null;
let writeChain = Promise.resolve();
let maintenanceProbe = null; // test seam, see _setMaintenanceProbe

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const toMillis = (now) => {
  if (now instanceof Date) return now.getTime();
  return Number.isFinite(now) ? Number(now) : Date.now();
};

/** The configured IANA zone, or "UTC" when it is not valid */
function resolveZone() {
  const zone = config.TIMEZONE || "UTC";
  return Info.isValidIANAZone(zone) ? zone : "UTC";
}

/** Local date `YYYY-MM-DD` of an instant in the bot's time zone */
function dayOf(now) {
  return DateTime.fromMillis(toMillis(now), { zone: resolveZone() }).toFormat("yyyy-MM-dd");
}

/** Local dates of the window, oldest first (`days` entries ending with today) */
function windowDays(days, now) {
  const end = DateTime.fromMillis(toMillis(now), { zone: resolveZone() }).startOf("day");
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(end.minus({ days: i }).toFormat("yyyy-MM-dd"));
  return out;
}

const clampDays = (days) => {
  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, MAX_WINDOW_DAYS);
};

const clampLimit = (limit, fallback) => {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
};

// ---------------------------------------------------------------------------
// Maintenance mode (required lazily: the module is delivered separately and
// lib/utils never needs it at load time)
// ---------------------------------------------------------------------------

function maintenanceActive() {
  try {
    if (maintenanceProbe) return Boolean(maintenanceProbe());
    return Boolean(require("./maintenanceMode").isActive());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Add `entry.n` to the pending counter of its key (dropping a new key beyond the hard cap) */
function add(entry) {
  const key = `${entry.day}${SEP}${entry.metric}${SEP}${entry.subject}`;
  const current = buffer.get(key);
  if (current) {
    current.n += entry.n;
    return false;
  }
  if (buffer.size >= HARD_CAP) return false;
  buffer.set(key, { ...entry });
  return true;
}

/**
 * Count an event. Synchronous, never throws.
 * @param {"messages"|"group_msgs"|"cmd_ok"|"cmd_fail"} metric
 * @param {string} [subject] command name or group JID ("" for `messages`)
 * @param {number} [n] positive integer, default 1
 * @param {number|Date} [now] default Date.now()
 */
function count(metric, subject = "", n = 1, now) {
  try {
    if (!METRICS.includes(metric)) return;
    const amount = Math.trunc(Number(n));
    if (!Number.isFinite(amount) || amount < 1) return;
    const isNew = add({
      day: dayOf(now),
      metric,
      subject: String(subject ?? "").slice(0, SUBJECT_MAX),
      n: amount,
    });
    if (isNew && buffer.size >= MAX_KEYS) {
      flush().catch(() => {}); // flush() already logs; the map is swapped synchronously
    }
  } catch (err) {
    logger.debug({ err: err?.message }, "stats.count ignored");
  }
}

/** Number of distinct keys waiting for a flush */
function pendingKeys() {
  return buffer.size;
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/** One multi-row upsert for a slice of rows */
function upsert(rows) {
  const placeholders = rows.map(() => "(?,?,?,?)").join(",");
  const replacements = rows.flatMap((r) => [r.day, r.metric, r.subject, r.n]);
  return DATABASE.query(
    `INSERT INTO "daily_stats" ("day","metric","subject","count") VALUES ${placeholders} ` +
      `ON CONFLICT ("day","metric","subject") DO UPDATE SET "count" = "daily_stats"."count" + excluded."count"`,
    { replacements, type: QueryTypes.RAW },
  );
}

/** Write a snapshot; on a failure the rows not written yet go back to the buffer */
async function write(rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const slice = rows.slice(i, i + ROWS_PER_STATEMENT);
    try {
      await upsert(slice);
      written += slice.length;
    } catch (err) {
      for (const row of rows.slice(i)) add(row);
      logger.warn({ err: err?.message }, "stats flush failed, counters kept for the next attempt");
      break;
    }
  }
  return written;
}

/**
 * Write the pending counters. Resolves with the number of rows written; never rejects.
 * Skipped (counters kept) while maintenance mode is active. Concurrent flushes are serialized.
 * @param {{ now?: number|Date }} [_options] accepted for the uniform signature: the day
 *   buckets were fixed at count() time
 * @returns {Promise<number>}
 */
function flush(_options = {}) {
  if (maintenanceActive()) return Promise.resolve(0);
  if (buffer.size === 0) return writeChain.then(() => 0);

  const rows = [...buffer.values()];
  buffer.clear();
  const job = writeChain.then(() => write(rows));
  writeChain = job.catch(() => {});
  return job;
}

/** Start the 30 s flush timer (idempotent, `unref`'d) */
function start() {
  if (timer) return;
  timer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

/** Stop the timer and flush what is pending */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  return flush();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Rows `{ subject, total }` of one metric over the window, most frequent first */
async function totalsBySubject(metric, limit, days, now) {
  const span = clampDays(days);
  const [from] = windowDays(span, now);
  const to = dayOf(now);
  const rows = await DATABASE.query(
    `SELECT "subject", SUM("count") AS "total" FROM "daily_stats" ` +
      `WHERE "metric" = ? AND "day" >= ? AND "day" <= ? AND "subject" <> '' ` +
      `GROUP BY "subject" ORDER BY "total" DESC, "subject" ASC LIMIT ?`,
    { replacements: [metric, from, to, limit], type: QueryTypes.SELECT },
  );
  return rows.map((r) => ({ subject: r.subject, count: Number(r.total) }));
}

/**
 * Messages per local day over the window, zero-filled, oldest first.
 * @returns {Promise<{ day: string, messages: number }[]>}
 */
async function messagesByDay(days = 7, { now } = {}) {
  const span = clampDays(days);
  const labels = windowDays(span, now);
  const rows = await DATABASE.query(
    `SELECT "day", SUM("count") AS "total" FROM "daily_stats" ` +
      `WHERE "metric" = 'messages' AND "day" >= ? AND "day" <= ? GROUP BY "day"`,
    { replacements: [labels[0], labels[labels.length - 1]], type: QueryTypes.SELECT },
  );
  const byDay = new Map(rows.map((r) => [r.day, Number(r.total)]));
  return labels.map((day) => ({ day, messages: byDay.get(day) || 0 }));
}

/** Most used commands (`cmd_ok`) @returns {Promise<{ name: string, count: number }[]>} */
async function topCommands(limit = 10, days = 7, { now } = {}) {
  const rows = await totalsBySubject("cmd_ok", clampLimit(limit, 10), days, now);
  return rows.map((r) => ({ name: r.subject, count: r.count }));
}

/** Commands that fail (`cmd_fail`) @returns {Promise<{ name: string, count: number }[]>} */
async function failingCommands(days = 7, { now } = {}) {
  const rows = await totalsBySubject("cmd_fail", 1000, days, now);
  return rows.map((r) => ({ name: r.subject, count: r.count }));
}

/** Most active groups (`group_msgs`) @returns {Promise<{ jid: string, count: number }[]>} */
async function topGroups(limit = 10, days = 7, { now } = {}) {
  const rows = await totalsBySubject("group_msgs", clampLimit(limit, 10), days, now);
  return rows.map((r) => ({ jid: r.subject, count: r.count }));
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Drop pending counters and the timer (tests only) */
function _reset() {
  buffer.clear();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  maintenanceProbe = null;
}

/** Replace the maintenance check by `fn() -> boolean`; `null` restores the real module (tests only) */
function _setMaintenanceProbe(fn) {
  maintenanceProbe = fn;
}

module.exports = {
  METRICS,
  FLUSH_INTERVAL_MS,
  MAX_KEYS,
  count,
  pendingKeys,
  flush,
  start,
  stop,
  dayOf,
  messagesByDay,
  topCommands,
  failingCommands,
  topGroups,
  _reset,
  _setMaintenanceProbe,
};
