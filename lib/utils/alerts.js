"use strict";

/**
 * Alerts to the owners (specs/002-admin-panel: contracts/runtime.md section 10, data-model 1.13, 1.14 and 2.6;
 * FR-061, FR-062, FR-063). Six kinds of event are announced by a WhatsApp message to every owner (`SUDO`):
 *
 *   type              toggle              trigger                                              rate-limit slot (persisted)
 *   reconnected       ALERT_RECONNECT     `ready` after more than 5 minutes without a heartbeat   reconnected, 10 min
 *   errors_series     ALERT_ERROR_BURST   10 `command:error` events within 10 minutes             errors_series, 1 h
 *   key_refused       ALERT_KEY_REFUSED   bus `key:refused { service }`                            key_refused:<service>, 24 h
 *   login_blocked     ALERT_LOGIN_BLOCKED the admin authentication (an origin is blocked)          login_blocked:<origin>, 15 min
 *   new_origin        ALERT_NEW_ORIGIN    the admin authentication (first login of an origin)    none
 *   update_available  ALERT_UPDATE        the updater checker                                    update_available, once per version
 *
 *   alerts.start(client, { now, timers })   idempotent; subscribes to the client's `ready` / `close` and to the bus
 *                                           topics, starts the 60 s heartbeat and the 30 s flush (both `unref`'d)
 *   alerts.stop()                           unsubscribes, clears the timers, writes the last heartbeat
 *   alerts.raise(type, payload, { now })    -> { queued, reason? }, `reason`: disabled | no_recipient | rate_limited
 *                                           (invalid: an unknown type or a payload that cannot be announced)
 *   alerts.flush(client?)                   sends the pending rows of the outbox; never rejects
 *   alerts.getStatus({ recent })            -> { enabled, recipients, lastSent, pending, pendingByType, recent }
 *   alerts.prune({ now })                   retention of the outbox and of the `login_blocked:*` slots
 *
 * `raise` order (the first refusal ends it, and only the last two steps cost anything):
 *   1. the type's toggle is off                      -> dropped, no slot consumed
 *   2. `getOwnerJids()` is empty                     -> dropped, no slot consumed (the panel shows "no recipient")
 *   3. the persisted compare-and-swap on `alert_states` is lost -> dropped (`UPDATE ... SET lastSentAt = :now WHERE
 *      key = :k AND (lastSentAt IS NULL OR lastSentAt <= :now_minus_window)`, one changed row means allowed, so a
 *      restart cannot re-send and two simultaneous raises cannot both pass)
 *   4. a row is inserted in `alert_outbox` (status pending)
 *   5. `flush()` at once when the client is connected
 * The slot is taken when the alert is born, not when it is sent, so an alert born during a disconnection is sent at
 * the reconnection and neither duplicated nor lost.
 *
 * The text is rendered at send time with `getLang("alerts.<type>", ...)` (the bot's language of that moment).
 * A payload only ever holds a service name, a version, a duration, an origin, command names with counts and times:
 * it is rebuilt field by field from the input, so a key, a stack or a JID given by mistake never reaches the
 * outbox. The engine works with the panel disabled and never requires `lib/admin/**`.
 *
 * Time: every function that depends on the clock takes `now` (ms number or Date) in its options, default
 * `Date.now()`; `start()` takes a `now()` function for the triggers that carry no `now` of their own.
 */

const { Op } = require("sequelize");
const config = require("../../config");
const db = require("../database");
const bus = require("./events");
const { createLogger } = require("./logger");
const { getOwnerJids } = require("./permissions");
const { getLang } = require("./language");
const { withTimeout, safeLog } = require("./http");

const logger = createLogger("alerts");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const HEARTBEAT_KEY = "conn_heartbeat";
const HEARTBEAT_INTERVAL_MS = MINUTE;
const FLUSH_INTERVAL_MS = 30 * 1000;
const RECONNECT_MIN_DOWN_MS = 5 * MINUTE; // a shorter cut is not announced
const ERROR_WINDOW_MS = 10 * MINUTE;
const ERROR_BURST = 10; // command errors within the window
const ERROR_TOP = 5; // commands named in the text
const MAX_ATTEMPTS = 3;
const PENDING_TTL_MS = DAY; // a pending row older than this becomes `expired`
const RETAIN_MS = 7 * DAY; // resolved rows are deleted after this
const SLOT_PRUNE_MS = DAY; // `login_blocked:*` slots are deleted after this
const PRUNE_EVERY_MS = HOUR;
const FLUSH_BATCH = 50;
const SEND_TIMEOUT_MS = 15 * 1000;

/**
 * type -> { setting, windowMs, slot(payload), byValue(payload) }.
 * `slot` is the key of the rate-limit row (none: no limiter); `byValue` replaces the window by "once per value".
 */
const TYPES = Object.freeze({
  reconnected: Object.freeze({ setting: "ALERT_RECONNECT", windowMs: 10 * MINUTE, slot: () => "reconnected" }),
  errors_series: Object.freeze({ setting: "ALERT_ERROR_BURST", windowMs: HOUR, slot: () => "errors_series" }),
  key_refused: Object.freeze({ setting: "ALERT_KEY_REFUSED", windowMs: DAY, slot: (p) => `key_refused:${p.service}` }),
  login_blocked: Object.freeze({ setting: "ALERT_LOGIN_BLOCKED", windowMs: 15 * MINUTE, slot: (p) => `login_blocked:${p.origin}` }),
  new_origin: Object.freeze({ setting: "ALERT_NEW_ORIGIN" }),
  update_available: Object.freeze({ setting: "ALERT_UPDATE", slot: () => "update_available", byValue: (p) => p.version }),
});

/** type -> setting key, in the order the panel lists them (admin-http-api.md ALR-1) */
const TYPE_SETTINGS = Object.freeze(Object.fromEntries(Object.entries(TYPES).map(([type, spec]) => [type, spec.setting])));

// ---------------------------------------------------------------------------
// Module state (one engine per process; `_reset()` for the tests)
// ---------------------------------------------------------------------------

/** @type {null|{ client: object, now: () => number, timers: object, heartbeat: any, flush: any, listeners: object }} */
let running = null;
let errorWindow = []; // [{ name, at }]
let lifecycle = Promise.resolve(); // serializes the heartbeat writes and the `ready` / `close` handling
let flushChain = Promise.resolve(); // serializes the flushes (never two sends of the same row)
let lastPrune = 0;
const inflight = new Set(); // work started by a bus event or a client event (see `_settled`)

/** Remember a promise started by an event until it settles (the tests wait for them) */
function track(promise) {
  inflight.add(promise);
  const done = () => inflight.delete(promise);
  promise.then(done, done);
  return promise;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toMillis = (now) => {
  if (now instanceof Date) return now.getTime();
  return Number.isFinite(now) ? Number(now) : Date.now();
};

const clockNow = () => (running ? running.now() : Date.now());

const isEnabled = (type) => config[TYPES[type].setting] !== false;

const isCount = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
const whole = (value) => Math.trunc(Number(value));

/** A text from the outside, cut and stripped of control characters (a name, an origin) */
function plain(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

/** ISO string of a time given as ISO text, a Date or ms, else of `fallback` */
function isoOf(value, fallback) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number(value);
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : fallback).toISOString();
}

/**
 * Rebuild the payload of an alert field by field (never a copy): the outbox only ever holds these fields.
 * @returns {object|null} null when the alert cannot be announced
 */
function sanitize(type, payload, nowMs) {
  const input = payload && typeof payload === "object" ? payload : {};
  const at = isoOf(input.at, nowMs);
  switch (type) {
    case "reconnected":
      return isCount(input.downMs) ? { downMs: whole(input.downMs), at } : null;
    case "errors_series": {
      const top = (Array.isArray(input.top) ? input.top : [])
        .map((entry) => ({ name: plain(entry && entry.name, 64), count: whole(entry && entry.count) }))
        .filter((entry) => entry.name && entry.count > 0)
        .slice(0, ERROR_TOP);
      return isCount(input.count) && whole(input.count) > 0 ? { count: whole(input.count), top, at } : null;
    }
    case "key_refused": {
      const service = plain(input.service, 40).toLowerCase();
      return /^[a-z0-9_.-]+$/.test(service) ? { service, at } : null;
    }
    case "login_blocked": {
      const origin = plain(input.origin, 64);
      if (!origin) return null;
      return { origin, retryAfterMs: isCount(input.retryAfterMs) ? whole(input.retryAfterMs) : 0, at };
    }
    case "new_origin": {
      const origin = plain(input.origin, 64);
      return origin ? { origin, at } : null;
    }
    case "update_available": {
      const version = plain(input.version, 40);
      return /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version) ? { version, at } : null;
    }
    default:
      return null;
  }
}

/** "7 min", "1 h 05": the same abbreviations read well in both languages */
function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
}

/** The text of a stored alert, in the language of the moment */
function renderText(type, payload) {
  switch (type) {
    case "reconnected":
      return getLang("alerts.reconnected", formatDuration(payload.downMs));
    case "errors_series": {
      const top = (payload.top || []).map((entry) => `${entry.name} (${entry.count})`).join(", ");
      return getLang("alerts.errors_series", payload.count, ERROR_WINDOW_MS / MINUTE, top);
    }
    case "key_refused":
      return getLang("alerts.key_refused", payload.service);
    case "login_blocked":
      return getLang("alerts.login_blocked", payload.origin, Math.max(1, Math.ceil((payload.retryAfterMs || 15 * MINUTE) / MINUTE)));
    case "new_origin":
      return getLang("alerts.new_origin", payload.origin);
    case "update_available":
      return getLang("alerts.update_available", payload.version);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Rate-limit slots (alert_states)
// ---------------------------------------------------------------------------

/**
 * Take the slot of an alert: one single-statement compare-and-swap. Resolves true when this call won it.
 * The row is created first (`ignoreDuplicates`), so the very first alert of a key passes.
 */
async function takeSlot(type, payload, nowMs) {
  const spec = TYPES[type];
  if (!spec.slot) return true;
  const key = spec.slot(payload);
  const at = new Date(nowMs);
  await db.AlertState.bulkCreate([{ key, count: 0 }], { ignoreDuplicates: true });

  const values = { lastSentAt: at, count: db.DATABASE.literal('"count" + 1'), updatedAt: at };
  let where;
  if (spec.byValue) {
    // once per value: `WHERE value IS NULL OR value <> :v`
    values.value = spec.byValue(payload);
    where = { key, [Op.or]: [{ value: null }, { value: { [Op.ne]: values.value } }] };
  } else {
    where = { key, [Op.or]: [{ lastSentAt: null }, { lastSentAt: { [Op.lte]: new Date(nowMs - spec.windowMs) } }] };
  }
  const [changed] = await db.AlertState.update(values, { where, silent: true });
  return changed === 1;
}

// ---------------------------------------------------------------------------
// raise
// ---------------------------------------------------------------------------

/** The five steps of `raise`, in order */
async function raiseNow(type, payload, options) {
  try {
    if (!Object.prototype.hasOwnProperty.call(TYPES, type)) return { queued: false, reason: "invalid" };
    const nowMs = toMillis(options.now ?? clockNow());
    const clean = sanitize(type, payload, nowMs);
    if (!clean) return { queued: false, reason: "invalid" };

    if (!isEnabled(type)) return { queued: false, reason: "disabled" }; // 1
    if (getOwnerJids().length === 0) return { queued: false, reason: "no_recipient" }; // 2
    if (!(await takeSlot(type, clean, nowMs))) return { queued: false, reason: "rate_limited" }; // 3

    const at = new Date(nowMs);
    await db.AlertOutbox.create( // 4
      { type, payload: JSON.stringify(clean), status: "pending", attempts: 0, createdAt: at, updatedAt: at },
      { silent: true },
    );
    logger.info({ type }, "alert queued");

    const client = running && running.client;
    if (client && isReady(client)) await flush(client, { now: nowMs }); // 5
    return { queued: true };
  } catch (err) {
    logger.error({ type, err: safeLog(err) }, "alert could not be raised");
    return { queued: false };
  }
}

/**
 * Announce an event to the owners.
 * @param {string} type one of `Object.keys(TYPE_SETTINGS)`
 * @param {object} [payload] fields of the type (see `sanitize`); anything else is ignored
 * @param {{ now?: number|Date }} [options]
 * @returns {Promise<{ queued: boolean, reason?: "disabled"|"no_recipient"|"rate_limited"|"invalid" }>}
 *   never rejects: a failure is logged and answered `{ queued: false }`. The call is remembered until it settles
 *   (the callers of the authentication do not wait for it, the tests do).
 */
const raise = (type, payload, options = {}) => track(raiseNow(type, payload, options));

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

function isReady(client) {
  try {
    return Boolean(client && typeof client.ready === "function" && client.ready());
  } catch {
    return false;
  }
}

function socketOf(client) {
  try {
    const sock = client.getSocket();
    return sock && typeof sock.sendMessage === "function" ? sock : null;
  } catch {
    return null;
  }
}

/**
 * `status` and friends on a row, with `updatedAt` on the injected clock. `silent: true` is what keeps the explicit
 * `updatedAt` (without it Sequelize overwrites it with the real time), so the 7-day retention counts from the
 * resolution; test/alerts.test.js pins it.
 */
const resolveRow = (row, values, nowMs) =>
  db.AlertOutbox.update({ ...values, updatedAt: new Date(nowMs) }, { where: { id: row.id }, silent: true });

/** pending rows older than 24 h become `expired` (data-model 2.6) */
async function expirePending(nowMs) {
  await db.AlertOutbox.update(
    { status: "expired", updatedAt: new Date(nowMs) },
    { where: { status: "pending", createdAt: { [Op.lt]: new Date(nowMs - PENDING_TTL_MS) } }, silent: true },
  );
}

/**
 * Retention (data-model 1.15): resolved outbox rows after 7 days, `login_blocked:*` slots after 24 h.
 * Idempotent; the daily housekeeping may run the same statements.
 * @param {{ now?: number|Date }} [options]
 */
async function prune(options = {}) {
  const nowMs = toMillis(options.now);
  await db.AlertOutbox.destroy({ where: { status: { [Op.ne]: "pending" }, updatedAt: { [Op.lt]: new Date(nowMs - RETAIN_MS) } } });
  await db.AlertState.destroy({
    where: { key: { [Op.startsWith]: "login_blocked:" }, lastSentAt: { [Op.lt]: new Date(nowMs - SLOT_PRUNE_MS) } },
  });
}

async function doFlush(client, nowMs) {
  const result = { sent: 0, dropped: 0, retry: 0 };
  await expirePending(nowMs);
  if (nowMs - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = nowMs;
    await prune({ now: nowMs });
  }
  if (!isReady(client)) return result; // the rows wait for the reconnection

  const rows = await db.AlertOutbox.findAll({
    where: { status: "pending" },
    order: [["createdAt", "ASC"], ["id", "ASC"]],
    limit: FLUSH_BATCH,
  });
  if (rows.length === 0) return result;

  const owners = getOwnerJids();
  const sock = socketOf(client);
  if (!sock) return result;

  for (const row of rows) {
    if (!isReady(client)) break; // cut mid-way: the remaining rows are not failures
    if (owners.length === 0) {
      await resolveRow(row, { status: "dropped" }, nowMs); // no recipient any more
      result.dropped += 1;
      continue;
    }
    let payload = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
    const text = payload ? renderText(row.type, payload) : null;
    if (!text) {
      await resolveRow(row, { status: "dropped" }, nowMs);
      result.dropped += 1;
      continue;
    }

    let received = 0;
    for (const owner of owners) {
      try {
        await withTimeout(() => sock.sendMessage(owner, { text }), SEND_TIMEOUT_MS, "alert send");
        received += 1;
      } catch (err) {
        logger.warn({ type: row.type, err: safeLog(err) }, "alert could not be sent to an owner");
      }
    }
    if (received > 0) {
      await resolveRow(row, { status: "sent", sentAt: new Date(nowMs) }, nowMs);
      result.sent += 1;
    } else {
      const attempts = row.attempts + 1;
      await resolveRow(row, { attempts, status: attempts >= MAX_ATTEMPTS ? "dropped" : "pending" }, nowMs);
      if (attempts >= MAX_ATTEMPTS) result.dropped += 1;
      else result.retry += 1;
    }
  }
  return result;
}

/**
 * Send the pending rows to every owner. Concurrent calls are serialized, so a row is never sent twice.
 * @param {object} [clientArg] defaults to the client given to `start()`
 * @param {{ now?: number|Date }} [options]
 * @returns {Promise<{ sent: number, dropped: number, retry: number }>} never rejects
 */
function flush(clientArg, options = {}) {
  const client = clientArg || (running && running.client) || null;
  const run = flushChain.then(async () => {
    try {
      return await doFlush(client, toMillis(options.now ?? clockNow()));
    } catch (err) {
      logger.error({ err: safeLog(err) }, "alert flush failed");
      return { sent: 0, dropped: 0, retry: 0 };
    }
  });
  flushChain = run;
  return run;
}

// ---------------------------------------------------------------------------
// Connection heartbeat and the `reconnected` alert
// ---------------------------------------------------------------------------

async function readHeartbeat() {
  const row = await db.AlertState.findByPk(HEARTBEAT_KEY);
  const ms = row && row.value ? Date.parse(row.value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

async function writeHeartbeat(nowMs) {
  const at = new Date(nowMs);
  await db.AlertState.bulkCreate([{ key: HEARTBEAT_KEY, count: 0 }], { ignoreDuplicates: true });
  await db.AlertState.update({ value: at.toISOString(), updatedAt: at }, { where: { key: HEARTBEAT_KEY }, silent: true });
}

/** Queue `fn` after the previous lifecycle step; a failure is logged and never breaks the chain */
function inLifecycle(label, fn) {
  const run = lifecycle.then(async () => {
    try {
      await fn();
    } catch (err) {
      logger.warn({ step: label, err: safeLog(err) }, "alerts lifecycle step failed");
    }
  });
  lifecycle = run;
  return run;
}

/** `ready`: announce an outage of more than 5 minutes, stamp the heartbeat, send what waited */
function onReady() {
  const nowMs = clockNow(); // the moment of the event, not of the turn it waits for in the queue
  return track(inLifecycle("ready", async () => {
    const previous = await readHeartbeat();
    await writeHeartbeat(nowMs); // before the raise: a failure there cannot re-announce the same cut
    // no heartbeat yet (first boot) raises nothing
    if (previous !== null && nowMs - previous > RECONNECT_MIN_DOWN_MS) {
      await raise("reconnected", { downMs: nowMs - previous }, { now: nowMs });
    }
    await flush(running && running.client, { now: nowMs });
  }));
}

/** `close`: the last moment the bot was connected */
function onClose() {
  const nowMs = clockNow();
  return track(inLifecycle("close", () => writeHeartbeat(nowMs)));
}

// ---------------------------------------------------------------------------
// Bus triggers
// ---------------------------------------------------------------------------

/** `command:error` { name, at }: 10 errors within 10 minutes raise `errors_series` and clear the window */
function onCommandError(payload) {
  const at = clockNow();
  errorWindow.push({ name: plain(payload && payload.name, 64) || "?", at });
  const cutoff = at - ERROR_WINDOW_MS;
  errorWindow = errorWindow.filter((entry) => entry.at >= cutoff);
  if (errorWindow.length < ERROR_BURST) return;

  // cleared whether or not the limiter lets the alert through
  const entries = errorWindow;
  errorWindow = [];
  const counts = new Map();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, ERROR_TOP)
    .map(([name, count]) => ({ name, count }));
  return raise("errors_series", { count: entries.length, top }, { now: at });
}

/** `key:refused` { service, at }: once per service per 24 h (the slot) */
function onKeyRefused(payload) {
  return raise("key_refused", { service: payload && payload.service }, { now: clockNow() });
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

/**
 * Subscribe to the client and the bus and start the two timers. Idempotent for the same client.
 * @param {object} client WhatsAppClient (or a fake with on/off/ready/getSocket)
 * @param {{ now?: () => number, timers?: { setInterval, clearInterval } }} [options]
 */
function start(client, options = {}) {
  if (running) {
    if (running.client === client) return;
    stop();
  }
  const timers = options.timers || { setInterval, clearInterval };
  const now = typeof options.now === "function" ? options.now : Date.now;
  const listeners = {
    ready: () => {
      onReady();
    },
    close: () => {
      onClose();
    },
    commandError: (payload) => {
      track(Promise.resolve(onCommandError(payload)).catch(() => {}));
    },
    keyRefused: (payload) => {
      track(Promise.resolve(onKeyRefused(payload)).catch(() => {}));
    },
  };
  running = { client, now, timers, heartbeat: null, flush: null, listeners };

  if (client && typeof client.on === "function") {
    client.on("ready", listeners.ready);
    client.on("close", listeners.close);
  }
  bus.on("command:error", listeners.commandError);
  bus.on("key:refused", listeners.keyRefused);

  const unref = (timer) => {
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  };
  running.heartbeat = unref(
    timers.setInterval(() => {
      if (running && isReady(running.client)) {
        const nowMs = clockNow();
        inLifecycle("heartbeat", () => writeHeartbeat(nowMs));
      }
    }, HEARTBEAT_INTERVAL_MS),
  );
  running.flush = unref(
    timers.setInterval(() => {
      flush();
    }, FLUSH_INTERVAL_MS),
  );

  // started while already connected (an in-process restart of the engine): behave as after a `ready`
  if (isReady(client)) onReady();
}

/**
 * Unsubscribe and clear the timers; the last heartbeat is written when the client is still connected, so a
 * planned stop is not counted as a long outage.
 * @returns {Promise<void>}
 */
function stop() {
  if (!running) return lifecycle;
  const { client, timers, heartbeat, flush: flushTimer, listeners } = running;
  const connected = isReady(client);
  if (client && typeof client.off === "function") {
    client.off("ready", listeners.ready);
    client.off("close", listeners.close);
  }
  bus.off("command:error", listeners.commandError);
  bus.off("key:refused", listeners.keyRefused);
  timers.clearInterval(heartbeat);
  timers.clearInterval(flushTimer);
  const now = running.now;
  running = null;
  errorWindow = [];
  if (connected) inLifecycle("stop", () => writeHeartbeat(now()));
  return lifecycle;
}

// ---------------------------------------------------------------------------
// Status (ALR-1)
// ---------------------------------------------------------------------------

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * State for the panel.
 * @param {{ recent?: number }} [options] number of recent outbox rows to list (0 to 50)
 * @returns {Promise<{ enabled: object, recipients: number, lastSent: object, pending: number, pendingByType: object,
 *   recent: { id: number, type: string, status: string, createdAt: string, sentAt: string|null }[] }>}
 *   `lastSent[type]`: the last send of that type (outbox), else the last slot taken; ISO text or null
 */
async function getStatus(options = {}) {
  const limit = Math.min(Math.max(Math.trunc(Number(options.recent)) || 0, 0), 50);
  const types = Object.keys(TYPES);

  const enabled = {};
  for (const type of types) enabled[type] = isEnabled(type);

  const pendingByType = Object.fromEntries(types.map((type) => [type, 0]));
  const pendingRows = await db.AlertOutbox.findAll({ where: { status: "pending" }, attributes: ["type"], raw: true });
  for (const row of pendingRows) if (row.type in pendingByType) pendingByType[row.type] += 1;

  const slots = await db.AlertState.findAll({ where: { key: { [Op.ne]: HEARTBEAT_KEY } }, limit: 5000 });
  const lastSent = {};
  for (const type of types) {
    const sent = await db.AlertOutbox.findOne({ where: { type, status: "sent" }, order: [["sentAt", "DESC"]] });
    let latest = sent && sent.sentAt ? new Date(sent.sentAt).getTime() : null;
    if (latest === null) {
      for (const slot of slots) {
        if (slot.key.split(":")[0] !== type || !slot.lastSentAt) continue;
        const ms = new Date(slot.lastSentAt).getTime();
        if (latest === null || ms > latest) latest = ms;
      }
    }
    lastSent[type] = latest === null ? null : new Date(latest).toISOString();
  }

  const recent = limit
    ? (await db.AlertOutbox.findAll({ order: [["createdAt", "DESC"], ["id", "DESC"]], limit })).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        createdAt: iso(row.createdAt),
        sentAt: iso(row.sentAt),
      }))
    : [];

  return {
    enabled,
    recipients: getOwnerJids().length,
    lastSent,
    pending: Object.values(pendingByType).reduce((sum, n) => sum + n, 0),
    pendingByType,
    recent,
  };
}

/** Test seam: resolves once every piece of work started by an event, the lifecycle and the flushes are done */
async function _settled() {
  for (let round = 0; round < 20; round += 1) {
    await Promise.all([...inflight, lifecycle, flushChain]);
    if (inflight.size === 0) return;
  }
}

/** Test seam: entries of the `command:error` window right now */
const _windowSize = () => errorWindow.length;

/** Test seam: forget the window and the serialization chains, stop the engine */
function _reset() {
  stop();
  errorWindow = [];
  lastPrune = 0;
  inflight.clear();
  lifecycle = Promise.resolve();
  flushChain = Promise.resolve();
}

module.exports = {
  start,
  stop,
  raise,
  flush,
  getStatus,
  prune,
  TYPES: Object.keys(TYPES),
  TYPE_SETTINGS,
  HEARTBEAT_KEY,
  _reset,
  _settled,
  _windowSize,
  _internals: { sanitize, renderText, formatDuration, ERROR_BURST, ERROR_WINDOW_MS, RECONNECT_MIN_DOWN_MS, MAX_ATTEMPTS },
};
