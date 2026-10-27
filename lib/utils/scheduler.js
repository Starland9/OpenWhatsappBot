const { Op } = require("sequelize");
const { DateTime, Info } = require("luxon");
const config = require("../../config");
const { getLang } = require("./language");
const { safeLog, withTimeout } = require("./http");
const { jidUser } = require("./permissions");
const { Reminder } = require("../database");

/**
 * Reminder scheduler (research R17).
 *
 * One polling loop (`start(client)`, every 20 s, `unref`'d) delivers the
 * `Reminder` rows that are due. State lives in the database only.
 *
 * Delivery contract of `tick()`:
 *  - picks `status = 'pending' AND dueAt <= now ORDER BY dueAt LIMIT 50`;
 *  - CLAIM: before sending, a row is leased with a compare-and-swap
 *    `UPDATE SET dueAt = now + 60 s, attempts = attempts + 1
 *     WHERE id = ? AND status = 'pending' AND dueAt <= now`.
 *    Only the caller that sees one affected row sends the message, so two
 *    ticks running at the same time (or overlapping) never send twice. The
 *    lease also keeps the row out of the next selects while the send is in
 *    flight; if the process dies mid-send the row becomes due again when the
 *    lease expires (at-least-once, counted as an attempt);
 *  - success: `UPDATE SET status = 'sent', sentAt = ... WHERE id = ? AND status = 'pending'`;
 *  - send error: `lastError` is stored (logs only, never shown), the row stays
 *    `pending` with `dueAt = now + 2^attempts * 30 s`; at 5 attempts it becomes
 *    `failed`;
 *  - the socket is read with `client.getSocket()` at send time (never captured),
 *    and a tick is skipped while `client.ready()` is false, so a long disconnection
 *    does not burn attempts;
 *  - rows overdue by more than 6 h are marked `missed` instead of being sent (the
 *    creators get one DM), overdue ones below that are sent with a "delayed" note.
 */

const POLL_INTERVAL_MS = 20 * 1000;
const BATCH_SIZE = 50;
const SEND_TIMEOUT_MS = 30 * 1000;
const CLAIM_LEASE_MS = 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const MISSED_AFTER_MS = 6 * 60 * 60 * 1000;
const DELAYED_AFTER_MS = 60 * 1000;
const MIN_DELAY_MS = 5 * 1000;
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_USER = 20;
const MAX_TEXT_LENGTH = 500;
const MAX_MISSED_LINES = 10;

const LIMITS = Object.freeze({
  POLL_INTERVAL_MS,
  BATCH_SIZE,
  MAX_ATTEMPTS,
  MISSED_AFTER_MS,
  DELAYED_AFTER_MS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  MAX_PENDING_PER_USER,
  MAX_TEXT_LENGTH,
});

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  j: 24 * 60 * 60 * 1000, // jours
};

/** @type {NodeJS.Timeout|null} */
let timer = null;
let currentClient = null;
let busy = false; // an interval-driven tick is running
let scheduleChain = Promise.resolve();

/* -------------------------------------------------------------------------- */
/* Time parsing and formatting                                                */
/* -------------------------------------------------------------------------- */

const toDate = (value) => {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

/** The configured IANA zone, or "UTC" when it is not valid */
function resolveZone(timezone) {
  const zone = timezone || config.TIMEZONE || "UTC";
  return Info.isValidIANAZone(zone) ? zone : "UTC";
}

/**
 * Parse a "when" token.
 *  - relative: `30s`, `10m`, `2h`, `1d`, `3j` (j = jours), combined `1h30m`;
 *  - clock: `HH:MM` in `timezone`, today, or tomorrow when already passed;
 *  - `YYYY-MM-DD HH:MM` in `timezone`.
 * @param {string} input
 * @param {{ timezone?: string, now?: Date|number }} [opts]
 * @returns {Date|null} the instant (a JS Date, UTC), or null when not a time
 */
function parseWhen(input, { timezone, now } = {}) {
  const raw = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const nowMs = (toDate(now) || new Date()).getTime();

  // Relative: one or more <number><unit>
  if (/^(?:\d{1,7}\s*[smhdj]\s*)+$/.test(raw)) {
    let total = 0;
    for (const [, amount, unit] of raw.matchAll(/(\d+)\s*([smhdj])/g)) {
      total += Number(amount) * UNIT_MS[unit];
    }
    if (!(total > 0)) return null;
    return toDate(nowMs + total);
  }

  const zone = resolveZone(timezone);

  // Clock: HH:MM, next occurrence
  const clock = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (clock) {
    let target = DateTime.fromMillis(nowMs, { zone }).set({
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: 0,
      millisecond: 0,
    });
    if (target.toMillis() <= nowMs) target = target.plus({ days: 1 });
    return target.isValid ? target.toJSDate() : null;
  }

  // Absolute: YYYY-MM-DD HH:MM
  const absolute = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ t]+([01]?\d|2[0-3]):([0-5]\d)$/);
  if (absolute) {
    const [, year, month, day, hour, minute] = absolute.map(Number);
    const target = DateTime.fromObject({ year, month, day, hour, minute }, { zone });
    return target.isValid ? target.toJSDate() : null;
  }

  return null;
}

/**
 * Split `<when> <text>` as typed after the command word. The "when" is one
 * token, or two for `YYYY-MM-DD HH:MM`. The text keeps its newlines.
 * @param {string} raw
 * @param {{ timezone?: string, now?: Date|number }} [opts]
 * @returns {{ date: Date|null, text: string }} `date` is null when the first
 *   token is not a time (then `text` is the whole input)
 */
function extractWhen(raw, opts) {
  const input = String(raw ?? "").replace(/^\s+/, "");

  const dated = input.match(/^(\d{4}-\d{2}-\d{2})[ \t]+(\d{1,2}:\d{2})(?=\s|$)/);
  if (dated) {
    const date = parseWhen(`${dated[1]} ${dated[2]}`, opts);
    if (date) return { date, text: input.slice(dated[0].length).trim() };
  }

  const token = input.match(/^\S+/);
  if (token) {
    const date = parseWhen(token[0], opts);
    if (date) return { date, text: input.slice(token[0].length).trim() };
  }
  return { date: null, text: input.trim() };
}

/**
 * Localized date and time, e.g. "ven. 27 oct. 2026, 14:30 UTC+1".
 * @param {Date|number} date
 * @param {string} [lang] defaults to config.LANG
 * @param {{ timezone?: string }} [opts]
 */
function formatWhen(date, lang, { timezone } = {}) {
  const value = toDate(date);
  if (!value) return "";
  return DateTime.fromJSDate(value, { zone: resolveZone(timezone) })
    .setLocale(lang || config.LANG || "en")
    .toLocaleString({ ...DateTime.DATETIME_MED_WITH_WEEKDAY, timeZoneName: "short" });
}

/* -------------------------------------------------------------------------- */
/* Create / read / cancel                                                     */
/* -------------------------------------------------------------------------- */

function schedulerError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Create a reminder.
 * @param {{ chatJid: string, creatorJid: string, text: string, dueAt: Date|number }} input
 * @returns {Promise<object>} the created Reminder row
 * @throws {Error} with `code`:
 *   - `INVALID_ARGS`  missing chatJid / creatorJid
 *   - `TEXT_EMPTY`    empty text
 *   - `TEXT_TOO_LONG` text over 500 characters
 *   - `INVALID_TIME`  dueAt not a date, earlier than now + 5 s, or later than now + 1 year
 *                     (`error.reason` is "invalid", "too_soon" or "too_far")
 *   - `LIMIT_REACHED` the creator already has 20 pending reminders
 */
async function schedule({ chatJid, creatorJid, text, dueAt } = {}) {
  if (!chatJid || !creatorJid) {
    throw schedulerError("INVALID_ARGS", "chatJid and creatorJid are required");
  }

  const clean = String(text ?? "").trim();
  if (!clean) throw schedulerError("TEXT_EMPTY", "The reminder text is empty");
  if (clean.length > MAX_TEXT_LENGTH) {
    throw schedulerError("TEXT_TOO_LONG", `The reminder text is over ${MAX_TEXT_LENGTH} characters`);
  }

  const due = toDate(dueAt);
  if (!due) {
    throw schedulerError("INVALID_TIME", "The reminder time is not a valid date", { reason: "invalid" });
  }
  const delay = due.getTime() - Date.now();
  if (delay < MIN_DELAY_MS) {
    throw schedulerError("INVALID_TIME", "The reminder time must be at least 5 seconds ahead", {
      reason: "too_soon",
    });
  }
  if (delay > MAX_DELAY_MS) {
    throw schedulerError("INVALID_TIME", "The reminder time must be within one year", {
      reason: "too_far",
    });
  }

  // count + create in sequence, so that parallel calls can't pass the limit together
  const run = scheduleChain.then(async () => {
    const pending = await Reminder.count({ where: { creatorJid, status: "pending" } });
    if (pending >= MAX_PENDING_PER_USER) {
      throw schedulerError("LIMIT_REACHED", `At most ${MAX_PENDING_PER_USER} pending reminders per user`);
    }
    return Reminder.create({ chatJid, creatorJid, text: clean, dueAt: due });
  });
  scheduleChain = run.catch(() => {});
  return run;
}

/**
 * Pending reminders of a chat, soonest first.
 * @param {{ chatJid: string, creatorJids?: string[], limit?: number }} filter
 */
async function list({ chatJid, creatorJids, limit = 30 } = {}) {
  const where = { status: "pending" };
  if (chatJid) where.chatJid = chatJid;
  if (creatorJids?.length) where.creatorJid = { [Op.in]: creatorJids };
  return Reminder.findAll({ where, order: [["dueAt", "ASC"], ["id", "ASC"]], limit });
}

/** One reminder by id, or null */
async function get(id) {
  const key = Number(id);
  if (!Number.isInteger(key) || key <= 0) return null;
  return Reminder.findByPk(key);
}

/**
 * Cancel a pending reminder. Permissions are the caller's business.
 * @returns {Promise<boolean>} false when it was not pending any more (sent, cancelled...)
 */
async function cancel(id) {
  const key = Number(id);
  if (!Number.isInteger(key) || key <= 0) return false;
  const [changed] = await Reminder.update(
    { status: "cancelled" },
    { where: { id: key, status: "pending" } },
  );
  return changed > 0;
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

const backoffMs = (attempts) => 2 ** attempts * BACKOFF_BASE_MS;

/** The socket at this very moment (never kept between sends) */
function liveSocket() {
  const sock = currentClient?.getSocket?.();
  if (!sock) throw schedulerError("NO_SOCKET", "No socket");
  return sock;
}

function clientIsDown() {
  return !currentClient || (typeof currentClient.ready === "function" && !currentClient.ready());
}

const oneLine = (text, max) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Rows overdue by more than 6 h become `missed`; each creator gets one DM
 * (best effort). Idempotent: only rows still `pending` are changed.
 * @returns {Promise<number>} number of rows marked missed
 */
async function expireOverdue(now = new Date()) {
  const cutoff = new Date(now.getTime() - MISSED_AFTER_MS);
  const rows = await Reminder.findAll({
    where: { status: "pending", dueAt: { [Op.lt]: cutoff } },
    order: [["dueAt", "ASC"]],
    limit: 200,
  });

  const missed = [];
  for (const row of rows) {
    const [changed] = await Reminder.update(
      { status: "missed" },
      { where: { id: row.id, status: "pending", dueAt: { [Op.lt]: cutoff } } },
    );
    if (changed > 0) missed.push(row);
  }
  if (missed.length > 0) await notifyMissed(missed);
  return missed.length;
}

async function notifyMissed(rows) {
  const byCreator = new Map();
  for (const row of rows) {
    if (!byCreator.has(row.creatorJid)) byCreator.set(row.creatorJid, []);
    byCreator.get(row.creatorJid).push(row);
  }

  for (const [creatorJid, items] of byCreator) {
    const lines = items
      .slice(0, MAX_MISSED_LINES)
      .map((row) => getLang("plugins.reminder.missed_line", oneLine(row.text, 80), formatWhen(row.dueAt)));
    if (items.length > MAX_MISSED_LINES) {
      lines.push(getLang("plugins.reminder.missed_more", items.length - MAX_MISSED_LINES));
    }
    try {
      await withTimeout(
        () =>
          liveSocket().sendMessage(creatorJid, {
            text: `${getLang("plugins.reminder.missed", items.length)}\n${lines.join("\n")}`,
          }),
        SEND_TIMEOUT_MS,
        "reminder missed notice",
      );
    } catch (error) {
      console.error("scheduler: could not send the missed notice", safeLog(error));
    }
  }
}

/**
 * Claim, send and settle one due reminder.
 * @returns {Promise<"sent"|"retried"|"failed"|"skipped">}
 */
async function deliver(row, now) {
  const lateBy = now.getTime() - new Date(row.dueAt).getTime();
  const attempts = row.attempts + 1;

  // CLAIM: compare-and-swap, only the winner (one affected row) sends
  const [claimed] = await Reminder.update(
    { dueAt: new Date(now.getTime() + CLAIM_LEASE_MS), attempts },
    { where: { id: row.id, status: "pending", dueAt: { [Op.lte]: now } } },
  );
  if (claimed === 0) return "skipped";

  const who = `@${jidUser(row.creatorJid)}`;
  const text =
    lateBy > DELAYED_AFTER_MS
      ? getLang("plugins.reminder.fire_delayed", who, formatWhen(row.dueAt), row.text)
      : getLang("plugins.reminder.fire", who, row.text);

  try {
    await withTimeout(
      () => liveSocket().sendMessage(row.chatJid, { text, mentions: [row.creatorJid] }),
      SEND_TIMEOUT_MS,
      "reminder send",
    );
  } catch (error) {
    console.error(`scheduler: reminder ${row.id} send failed (attempt ${attempts})`, safeLog(error));
    const lastError = String(error?.message || error || "unknown").slice(0, 500);
    if (attempts >= MAX_ATTEMPTS) {
      await Reminder.update({ status: "failed", lastError }, { where: { id: row.id, status: "pending" } });
      return "failed";
    }
    await Reminder.update(
      { lastError, dueAt: new Date(now.getTime() + backoffMs(attempts)) },
      { where: { id: row.id, status: "pending" } },
    );
    return "retried";
  }

  try {
    await Reminder.update(
      { status: "sent", sentAt: new Date(), lastError: null },
      { where: { id: row.id, status: "pending" } },
    );
  } catch (error) {
    // The message went out; the lease expires and the row may be sent again
    console.error(`scheduler: reminder ${row.id} sent but not marked`, safeLog(error));
  }
  return "sent";
}

/**
 * Deliver every due reminder (up to 50, oldest first). Safe to call
 * concurrently: a reminder is claimed by exactly one caller.
 * @param {Date|number} [nowArg] test hook: the instant to treat as "now"
 * @returns {Promise<{ due: number, sent: number, retried: number, failed: number,
 *   missed: number, skipped: number }>} `skipped` = claimed by another caller.
 *   All zeros when the scheduler is not started or the client is not connected.
 */
async function tick(nowArg) {
  const stats = { due: 0, sent: 0, retried: 0, failed: 0, missed: 0, skipped: 0 };
  if (clientIsDown()) return stats;

  const now = toDate(nowArg) || new Date();
  stats.missed = await expireOverdue(now);

  const rows = await Reminder.findAll({
    where: { status: "pending", dueAt: { [Op.lte]: now } },
    order: [["dueAt", "ASC"], ["id", "ASC"]],
    limit: BATCH_SIZE,
  });
  stats.due = rows.length;

  for (const row of rows) {
    try {
      stats[await deliver(row, now)] += 1;
    } catch (error) {
      console.error(`scheduler: reminder ${row.id} failed`, safeLog(error));
    }
  }
  return stats;
}

function onInterval() {
  if (busy) return; // the previous tick is still running
  busy = true;
  tick()
    .catch((error) => console.error("scheduler: tick failed", safeLog(error)))
    .finally(() => {
      busy = false;
    });
}

/**
 * Start the polling loop. Idempotent: called on every connection open, it
 * keeps the latest client and never creates a second interval.
 * On a fresh start, reminders overdue by more than 6 h are marked `missed`
 * (the creators get a DM); the others are sent by the next tick with a
 * "delayed" note.
 * @param {{ getSocket: Function, ready?: Function }} client
 * @returns {Promise<void>} resolves once the restart recovery is done; never rejects
 */
async function start(client) {
  if (client) currentClient = client;
  if (timer) return;

  timer = setInterval(onInterval, POLL_INTERVAL_MS);
  timer.unref();

  try {
    await expireOverdue(new Date());
  } catch (error) {
    console.error("scheduler: restart recovery failed", safeLog(error));
  }
}

/** Stop the polling loop and forget the client */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  currentClient = null;
  busy = false;
}

/** The polling loop is running */
const isRunning = () => timer !== null;

module.exports = {
  start,
  stop,
  tick,
  isRunning,
  schedule,
  list,
  get,
  cancel,
  parseWhen,
  extractWhen,
  formatWhen,
  LIMITS,
};
