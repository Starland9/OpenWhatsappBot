"use strict";

/**
 * Retention of the data this feature adds (data-model 1.15, contracts/runtime.md section 9). One daily job,
 * started by `bootstrap` next to the other engines, so it runs whether or not the panel is enabled.
 *
 *   housekeeping.start()            idempotent: the first run 2 minutes later, then every 24 hours (both timers
 *                                   `unref()`'d, none exists before `start()` or at `require` time); also sweeps
 *                                   `data/tmp/*` once, now (the boot sweep). Resolves when that sweep is over;
 *                                   never rejects
 *   housekeeping.stop()             clears the timers
 *   housekeeping.run({ now })       one pass over every rule -> a report of the rows and files removed
 *   housekeeping.bootSweep()        `data/tmp/*` (uploaded restore files): the whole content, at boot only
 *   housekeeping.isRunning()
 *
 * The rules (each statement is idempotent, bounded by the retention window, written with model methods):
 *
 *   daily_stats        day older than 90 days (the day is the local date in TIMEZONE)
 *   audit_logs         older than 180 days; then only the newest 20 000 rows are kept, except `login.success`
 *                      rows, which the cap does not touch (a flood of failures must not make a known origin look
 *                      new, FR-061): they are limited to the newest 500
 *   admin_sessions     idle for 24 h, or created more than 7 days ago
 *   admin_tokens       expired for more than a day
 *   alert_outbox       resolved rows after 7 days; `pending` rows older than 24 h become `expired`
 *   alert_states       `login_blocked:*` slots after 24 h
 *   broadcast_runs     finished more than 90 days ago, and runs whose targets were never completed
 *                      (`targetsReady = false`) after 1 h; their targets first
 *   broadcasts         `once` definitions with no run left
 *   known_chats        private chats silent for more than 365 days
 *   files              `data/admin-uploads/*` older than 1 h; `data/broadcast-media/<id>/` with no `Broadcast` row
 *
 * Then `broadcaster.sweepMedia({ now })` (media retention, U15) when the engine exists: it is resolved lazily and
 * skipped silently while it is not delivered. The broadcast statements and the media directories run behind
 * `mutex("broadcasts")`, the lock the broadcaster takes to create and to materialize, so a definition being
 * created is never mistaken for an orphan. A failing rule is logged and reported; the next rules still run.
 *
 * Time: `run` takes `now` (ms or Date), default the injected clock. Nothing here touches the real `data/`
 * unless it is asked to: `dataDir` is an option.
 */

const fsp = require("fs/promises");
const path = require("path");
const { Op } = require("sequelize");
const { DateTime, Info } = require("luxon");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  FIRST_RUN_MS: 2 * 60 * 1000,
  INTERVAL_MS: DAY_MS,
  DAILY_STATS_DAYS: 90,
  AUDIT_DAYS: 180,
  AUDIT_MAX_ROWS: 20000,
  LOGIN_SUCCESS_MAX_ROWS: 500,
  SESSION_IDLE_MS: DAY_MS,
  SESSION_ABSOLUTE_MS: 7 * DAY_MS,
  TOKEN_GRACE_MS: DAY_MS,
  OUTBOX_RETAIN_MS: 7 * DAY_MS,
  OUTBOX_PENDING_MS: DAY_MS,
  ALERT_SLOT_MS: DAY_MS,
  RUN_RETAIN_MS: 90 * DAY_MS,
  RUN_INCOMPLETE_MS: HOUR_MS,
  KNOWN_CHAT_SILENT_MS: 365 * DAY_MS,
  UPLOAD_MS: HOUR_MS,
  BATCH: 500,
});

const BROADCAST_LOCK = "broadcasts";

const toMs = (value) => (value instanceof Date ? value.getTime() : Number(value));
const before = (nowMs, ms) => new Date(nowMs - ms);

/** `require(id)`, or null when that exact module does not exist yet (any other failure is a real error) */
function optionalRequire(id) {
  try {
    return require(id);
  } catch (err) {
    const missing = err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes(`'${id}'`);
    if (!missing) throw err;
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.models]      the database module (default: required lazily)
 * @param {() => number} [options.clock] default Date.now
 * @param {object} [options.timers]      { setTimeout, clearTimeout, setInterval, clearInterval }, default the globals
 * @param {string} [options.rootDir]     repository root (default: two levels above this file)
 * @param {string} [options.dataDir]     default <rootDir>/data
 * @param {object} [options.mutex]       default ./mutex
 * @param {object} [options.safeFs]      default ./safeFs
 * @param {object|null} [options.broadcaster]  engine with `sweepMedia`; null = absent (skipped); default: lazy require
 * @param {() => string} [options.timezone]    default: config.TIMEZONE, UTC when invalid
 * @param {object} [options.logger]      default createLogger("housekeeping")
 */
function createHousekeeping(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..", "..");
  const dataDir = options.dataDir || path.join(rootDir, "data");
  const clock = options.clock || Date.now;
  const timers = options.timers || {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (h) => clearInterval(h),
  };

  const models = () => options.models || require("../database");
  const mutex = () => options.mutex || require("./mutex");
  const safeFs = () => options.safeFs || require("./safeFs");
  const broadcaster = () => (options.broadcaster !== undefined ? options.broadcaster : optionalRequire("./broadcaster"));
  const zone = () => {
    const name = typeof options.timezone === "function" ? options.timezone() : require("../../config").TIMEZONE;
    return name && Info.isValidIANAZone(name) ? name : "UTC";
  };
  let loggerInstance = options.logger || null;
  const logger = () => {
    if (!loggerInstance) loggerInstance = require("./logger").createLogger("housekeeping");
    return loggerInstance;
  };

  const uploadsDir = path.join(dataDir, "admin-uploads");
  const tmpDir = path.join(dataDir, "tmp");
  const mediaRoot = path.join(dataDir, "broadcast-media");

  let firstTimer = null;
  let dailyTimer = null;
  let started = false;
  let bootPromise = null;
  let running = null; // the pass in progress, so two passes never overlap

  const nowOf = (opts) => {
    const given = opts && opts.now !== undefined && opts.now !== null ? toMs(opts.now) : NaN;
    return Number.isFinite(given) ? given : clock();
  };

  // ---- the rules -----------------------------------------------------------------------------------

  /** `daily_stats.day` is a local date: the cutoff is "today in TIMEZONE minus 90 days" */
  async function pruneDailyStats(nowMs) {
    const cutoff = DateTime.fromMillis(nowMs, { zone: zone() })
      .minus({ days: LIMITS.DAILY_STATS_DAYS })
      .toFormat("yyyy-MM-dd");
    return models().DailyStat.destroy({ where: { day: { [Op.lt]: cutoff } } });
  }

  /** Delete every row of `where` beyond the newest `keep` (by id, which grows with time) */
  async function capRows(Model, where, keep) {
    const edge = await Model.findOne({ where, attributes: ["id"], order: [["id", "DESC"]], offset: keep, raw: true });
    if (!edge) return 0;
    return Model.destroy({ where: { ...where, id: { [Op.lte]: edge.id } } });
  }

  async function pruneAuditLogs(nowMs) {
    const { AuditLog } = models();
    const aged = await AuditLog.destroy({ where: { createdAt: { [Op.lt]: before(nowMs, LIMITS.AUDIT_DAYS * DAY_MS) } } });
    const capped = await capRows(AuditLog, { action: { [Op.ne]: "login.success" } }, LIMITS.AUDIT_MAX_ROWS);
    const successes = await capRows(AuditLog, { action: "login.success" }, LIMITS.LOGIN_SUCCESS_MAX_ROWS);
    return { aged, capped, successes };
  }

  async function pruneSessions(nowMs) {
    return models().AdminSession.destroy({
      where: {
        [Op.or]: [
          { lastSeenAt: { [Op.lt]: before(nowMs, LIMITS.SESSION_IDLE_MS) } },
          { createdAt: { [Op.lt]: before(nowMs, LIMITS.SESSION_ABSOLUTE_MS) } },
        ],
      },
    });
  }

  const pruneTokens = (nowMs) =>
    models().AdminToken.destroy({ where: { expiresAt: { [Op.lt]: before(nowMs, LIMITS.TOKEN_GRACE_MS) } } });

  async function pruneAlertOutbox(nowMs) {
    const { AlertOutbox } = models();
    const deleted = await AlertOutbox.destroy({
      where: { status: { [Op.ne]: "pending" }, updatedAt: { [Op.lt]: before(nowMs, LIMITS.OUTBOX_RETAIN_MS) } },
    });
    // `updatedAt` is stamped by Sequelize: the 7 days of retention count from the moment the row expired
    const [expired] = await AlertOutbox.update(
      { status: "expired" },
      { where: { status: "pending", createdAt: { [Op.lt]: before(nowMs, LIMITS.OUTBOX_PENDING_MS) } } },
    );
    return { deleted, expired };
  }

  const pruneAlertStates = (nowMs) =>
    models().AlertState.destroy({
      where: { key: { [Op.startsWith]: "login_blocked:" }, lastSentAt: { [Op.lt]: before(nowMs, LIMITS.ALERT_SLOT_MS) } },
    });

  /** Targets first, then the runs, in batches (an `IN` list stays short) */
  async function deleteRuns(where) {
    const { BroadcastRun, BroadcastTarget } = models();
    const total = { runs: 0, targets: 0 };
    for (;;) {
      const rows = await BroadcastRun.findAll({ where, attributes: ["id"], order: [["id", "ASC"]], limit: LIMITS.BATCH, raw: true });
      if (!rows.length) return total;
      const ids = rows.map((row) => row.id);
      total.targets += await BroadcastTarget.destroy({ where: { runId: { [Op.in]: ids } } });
      total.runs += await BroadcastRun.destroy({ where: { id: { [Op.in]: ids } } });
    }
  }

  async function pruneBroadcastRuns(nowMs) {
    const old = await deleteRuns({ finishedAt: { [Op.lt]: before(nowMs, LIMITS.RUN_RETAIN_MS) } });
    // creation is one transaction: a run whose targets were never completed can only be a leftover
    const incomplete = await deleteRuns({ targetsReady: false, createdAt: { [Op.lt]: before(nowMs, LIMITS.RUN_INCOMPLETE_MS) } });
    return { runs: old.runs + incomplete.runs, targets: old.targets + incomplete.targets };
  }

  /** `once` definitions whose runs are all gone (their media directory is an orphan, removed right after) */
  async function pruneOnceBroadcasts() {
    const { Broadcast, DATABASE } = models();
    return Broadcast.destroy({
      where: { kind: "once", id: { [Op.notIn]: DATABASE.literal('(SELECT "broadcastId" FROM "broadcast_runs")') } },
    });
  }

  /** `data/broadcast-media/<id>/` with no `Broadcast` row <id> (a restore, a crash between the steps of a delete) */
  async function pruneOrphanMedia() {
    let names;
    try {
      names = await fsp.readdir(mediaRoot);
    } catch {
      return { removed: 0, freedBytes: 0 };
    }
    const ids = names.filter((name) => /^\d{1,10}$/.test(name)).map(Number);
    if (!ids.length) return { removed: 0, freedBytes: 0 };
    const known = new Set();
    for (let i = 0; i < ids.length; i += LIMITS.BATCH) {
      const rows = await models().Broadcast.findAll({ where: { id: { [Op.in]: ids.slice(i, i + LIMITS.BATCH) } }, attributes: ["id"], raw: true });
      for (const row of rows) known.add(String(row.id));
    }
    const orphans = new Set(names.filter((name) => /^\d{1,10}$/.test(name) && !known.has(String(Number(name)))));
    if (!orphans.size) return { removed: 0, freedBytes: 0 };
    const { removed, freedBytes } = await safeFs().purgeChildren(mediaRoot, { skip: (name) => !orphans.has(name) });
    return { removed, freedBytes };
  }

  async function pruneKnownChats(nowMs) {
    return models().KnownChat.destroy({
      where: { kind: "private", lastSeenAt: { [Op.lt]: before(nowMs, LIMITS.KNOWN_CHAT_SILENT_MS) } },
    });
  }

  /** `data/admin-uploads/*` last written more than an hour ago (the upload janitor's rule, repeated for restarts) */
  const pruneUploads = (nowMs) => safeFs().purgeChildren(uploadsDir, { olderThanMs: LIMITS.UPLOAD_MS, now: nowMs });

  async function sweepBroadcastMedia(nowMs) {
    const engine = broadcaster();
    if (!engine || typeof engine.sweepMedia !== "function") return null;
    return engine.sweepMedia({ now: nowMs });
  }

  // ---- one pass --------------------------------------------------------------------------------------

  /**
   * Apply every rule once. A rule that fails is logged (name and code only) and listed in `errors`; the others
   * still run. Safe to call again at once: every statement is idempotent.
   * @param {{ now?: number|Date }} [opts]
   */
  function run(opts = {}) {
    if (running) return running;
    const nowMs = nowOf(opts);
    const report = { at: new Date(nowMs).toISOString(), errors: [] };

    const step = async (name, fn) => {
      try {
        report[name] = await fn();
      } catch (err) {
        report[name] = null;
        report.errors.push(name);
        try {
          logger().warn({ rule: name, name: err && err.name, code: err && err.code }, "housekeeping: a rule failed");
        } catch {
          // logging never matters here
        }
      }
    };

    running = (async () => {
      await step("dailyStats", () => pruneDailyStats(nowMs));
      await step("auditLogs", () => pruneAuditLogs(nowMs));
      await step("sessions", () => pruneSessions(nowMs));
      await step("tokens", () => pruneTokens(nowMs));
      await step("alertOutbox", () => pruneAlertOutbox(nowMs));
      await step("alertStates", () => pruneAlertStates(nowMs));
      await step("broadcastRuns", () => mutex().withLock(BROADCAST_LOCK, () => pruneBroadcastRuns(nowMs)));
      await step("onceBroadcasts", () => mutex().withLock(BROADCAST_LOCK, () => pruneOnceBroadcasts()));
      await step("orphanMedia", () => mutex().withLock(BROADCAST_LOCK, () => pruneOrphanMedia()));
      await step("knownChats", () => pruneKnownChats(nowMs));
      await step("uploads", () => pruneUploads(nowMs));
      // the broadcaster takes the lock itself: never call it from inside a locked section
      await step("mediaSweep", () => sweepBroadcastMedia(nowMs));
      return report;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /** `data/tmp/*`: the files of an unfinished restore are useless after a restart. Never rejects. */
  async function bootSweep() {
    try {
      return await safeFs().purgeChildren(tmpDir, {});
    } catch (err) {
      try {
        logger().warn({ name: err && err.name, code: err && err.code }, "housekeeping: the boot sweep failed");
      } catch {
        // logging never matters here
      }
      return null;
    }
  }

  // ---- lifecycle -------------------------------------------------------------------------------------

  const runQuietly = () => {
    run().catch(() => {}); // run() already reports each failure
  };

  /** Arm the two timers (idempotent) and sweep `data/tmp` once. Resolves with that sweep. */
  function start() {
    if (started) return bootPromise;
    started = true;
    firstTimer = timers.setTimeout(runQuietly, LIMITS.FIRST_RUN_MS);
    if (firstTimer && typeof firstTimer.unref === "function") firstTimer.unref();
    dailyTimer = timers.setInterval(runQuietly, LIMITS.INTERVAL_MS);
    if (dailyTimer && typeof dailyTimer.unref === "function") dailyTimer.unref();
    bootPromise = bootSweep();
    return bootPromise;
  }

  function stop() {
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (dailyTimer) timers.clearInterval(dailyTimer);
    firstTimer = null;
    dailyTimer = null;
    started = false;
    bootPromise = null;
  }

  const isRunning = () => started;

  return { start, stop, isRunning, run, bootSweep, LIMITS };
}

const defaultEngine = createHousekeeping();

module.exports = defaultEngine;
module.exports.createHousekeeping = createHousekeeping;
