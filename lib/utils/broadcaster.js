"use strict";

/**
 * Broadcast engine (specs/002-admin-panel: contracts/runtime.md section 9, data-model 1.10-1.12 and 2.3-2.5,
 * research C4, C5, U12, U14, U15, O1).
 *
 * A sibling of `scheduler.js` (which stays untouched): the same shape, one `unref`'d loop, `start(client)`
 * idempotent, `tick(now)` as the test hook, a `clientIsDown()` skip and compare-and-swap claims. It is started by
 * the bootstrap, so it runs with `ADMIN_PANEL=false` too. It never requires `lib/admin/**`; the callers audit.
 *
 *   const broadcaster = require("./broadcaster");                 // the process-wide engine
 *   const engine = broadcaster.createBroadcaster({ ... });        // a separate one (tests: a restart is a new engine)
 *
 *   start(client) / stop() / isRunning()
 *   tick(now?) -> { materialized, claimed, sent, failed, expired, skipped }
 *   createOnce(input, { now }) -> { broadcastId, runId }
 *   createRecurring(input, { now }) -> { broadcastId, nextRunAt }
 *   updateRecurring(id, patch, { now }) / pause(id) / resume(id, { now }) / remove(id)
 *   cancelRun(runId) -> the run
 *   report(runId) / get(id) / runs(id) / list({ kind, status }) / subscribe(fn)
 *   recomputeRecurrences({ now })                 TIMEZONE changed: recompute the pending occurrences from now
 *   sweepMedia({ now }) / purgeFinishedMedia({ now })    media retention (U15)
 *   LIMITS, BroadcastError
 *
 * `input = { title?, text, media?: { path, name, mime, size } | reuseMediaOf?: broadcastId, targets: [jid],
 * spacingMs?, runAt? | rule }`, `rule = { kind: "daily"|"weekly"|"monthly", days?, day?, time: "HH:mm" }`.
 *
 * DELIVERY CONTRACT (at most once per target, SC-012). One send per tick, global FIFO by `run.dueAt` then
 * `position`. Every transition is a conditional `UPDATE ... WHERE status = <from>`; a lost race changes 0 rows and
 * is ignored.
 *   1. gate     `scheduled` runs more than 1 h late become `expired` (note `late`); `running` runs older than 24 h
 *               become `cancelled` (note `stale`); targets stuck in `sending` past their lease become
 *               `failed` / `interrupted` and are NEVER retried (the message may have gone out);
 *   2. pick     the first run `scheduled|running`, `targetsReady`, due; then its first `pending` target;
 *   3. pace     eligible only when `now - lastSendAt >= max(2000, spacingMs) * (1 + jitter)`, jitter in [0, 0.2]
 *               drawn once per send; `lastSendAt` starts as `max(sentAt)` (a restart cannot burst);
 *   4. claim    `UPDATE targets SET status = 'sending', attempts = attempts + 1, leaseUntil = now + 60 s WHERE
 *               id = ? AND status = 'pending' AND its run is still open`; only the caller seeing 1 row sends;
 *   5. send     under `withTimeout(30 s)`; the socket is read at send time, `clientIsDown()` is re-checked right
 *               before the claim; a missing media file settles `failed` / `error`, never a text-only send;
 *   6. settle   `sent` (`sentAt`, `messageId`) or `failed` with a code (`forbidden`, `not_found`, `timeout`,
 *               `connection_closed`, `error`); `timeout` and `connection_closed` may have been delivered;
 *   7. complete no `pending` / `sending` left: the run is `completed` (or `failed` with 0 sent);
 *   8. while the client is down `tick` returns at once and changes nothing; a started run resumes paced.
 * NO RETRY (U14): no function of this module moves a target out of a final state (`sent`, `failed`,
 * `cancelled`) and none reopens a final run. Failed destinations are served by a NEW broadcast.
 *
 * `tick` counters: `materialized` recurring occurrences turned into a scheduled run, `claimed` targets claimed,
 * `sent` / `failed` targets settled (an `interrupted` target counts as failed), `expired` runs recorded as
 * `expired` (late runs and late recurring occurrences), `skipped` claims lost to another caller.
 *
 * Creation (definition, run, up to 200 targets, `targetsReady = true` last) and every other multi-statement write
 * run inside `mutex("broadcasts")` plus a transaction (in-memory SQLite has one connection, data-model 0.4).
 * Time: everything that depends on the clock takes `now` (ms or Date) in its options, default `Date.now()`.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Op, fn, col, literal } = require("sequelize");
const database = require("../database");
const recurrence = require("./recurrence");
const mutex = require("./mutex");
const safeFs = require("./safeFs");
const { createLogger } = require("./logger");
const { safeLog, withTimeout } = require("./http");

const logger = createLogger("broadcaster");

const { Broadcast, BroadcastRun, BroadcastTarget } = database;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  MAX_TARGETS: 200,
  MIN_SPACING_MS: 2000,
  MAX_SPACING_MS: 600000,
  LATE_MS: HOUR_MS,
  STALE_RUN_MS: DAY_MS,
  TEXT: 4096,
  CAPTION: 1024,
  LEASE_MS: 60 * 1000,
  SEND_TIMEOUT_MS: 30 * 1000,
  MEDIA_RETENTION_MS: 7 * DAY_MS,
  MATERIALIZE_ITERATIONS: 50,
  TICK_INTERVAL_MS: 1000,
});

const LOCK = "broadcasts";
const OPEN_RUN = ["scheduled", "running"];
const DELIVERED_UNSURE = new Set(["timeout", "connection_closed", "interrupted"]);

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/zip",
  "application/x-cfb",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);
const EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

/**
 * Error of the engine, with a stable snake_case `code` and optional `params`:
 * invalid_destination (`params.indices`), too_many_targets (`params.max`), empty_text, text_too_long
 * (`params.max`), media_type, media_too_large (`params.maxBytes`), media_unavailable, invalid_rule
 * (`params.code`), not_found, not_pending, not_editable, busy.
 */
class BroadcastError extends Error {
  constructor(code, params, message) {
    super(message || code);
    this.name = "BroadcastError";
    this.code = code;
    if (params) this.params = params;
  }
}

const fail = (code, params) => new BroadcastError(code, params);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** ms of a number, a Date or an ISO string; NaN when it is none of them */
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value) return Date.parse(value);
  return NaN;
}

const isFiniteMs = (value) => Number.isFinite(value);
const unlinkQuiet = (file) => fsp.unlink(file).catch(() => {});

/** A file name that is safe to store: a base name, no control or separator characters, at most 100 characters */
function sanitizeName(raw, mime) {
  let base = path.basename(String(raw === undefined || raw === null ? "" : raw).replace(/\\/g, "/"));
  base = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (Array.from(base).length > 100) {
    const ext = path.extname(base).slice(0, 10);
    base = Array.from(base.slice(0, base.length - ext.length)).slice(0, 100 - ext.length).join("") + ext;
  }
  return base || `file${EXTENSIONS[mime] || ""}`;
}

/** Sniff a file with `file-type`: { kind: "image"|"document", mime } or null (the extension only tells CSV from text) */
async function defaultSniff(file, name = "") {
  let detected = null;
  try {
    const { fileTypeFromFile } = await import("file-type"); // ESM only
    detected = await fileTypeFromFile(file);
  } catch {
    detected = null;
  }
  if (detected) {
    if (IMAGE_MIMES.has(detected.mime)) return { kind: "image", mime: detected.mime };
    if (DOCUMENT_MIMES.has(detected.mime)) return { kind: "document", mime: detected.mime };
    return null;
  }
  // text and CSV have no signature: clean UTF-8 without NUL bytes
  let head;
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (!head.length || head.includes(0)) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(head);
  } catch {
    try {
      decoder.decode(head.subarray(0, Math.max(0, head.length - 3))); // the cut may split a character
    } catch {
      return null;
    }
  }
  return { kind: "document", mime: /\.csv$/i.test(name) ? "text/csv" : "text/plain" };
}

/** Failure code of a send, from the error alone (the raw text only goes through `safeLog`) */
function classify(err) {
  if (!err || err instanceof BroadcastError) return "error";
  const status = err.output?.statusCode ?? err.statusCode ?? err.status ?? err.data;
  const text = String(err.message || "");
  if (err.code === "ETIMEDOUT" || status === 408 || /timed out/i.test(text)) return "timeout";
  if (status === 428 || err.code === "ECONNRESET" || err.code === "EPIPE" || /connection closed|connection lost/i.test(text)) {
    return "connection_closed";
  }
  if (status === 403 || /forbidden|not-authorized/i.test(text)) return "forbidden";
  if (status === 404 || status === 410 || /item-not-found/i.test(text)) return "not_found";
  return "error";
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {string} [options.rootDir]       repository root, default the real one (stored media paths are relative to it)
 * @param {string} [options.mediaRoot]     default <rootDir>/data/broadcast-media
 * @param {() => number} [options.clock]   default Date.now
 * @param {() => number} [options.random]  default Math.random (jitter)
 * @param {object} [options.timers]        { setInterval, clearInterval }
 * @param {object} [options.config]        default ../../config (TIMEZONE, MAX_UPLOAD, BROADCAST_DELAY_MS)
 * @param {object} [options.settingsStore] default ./settingsStore (onChange for TIMEZONE)
 * @param {object} [options.knownChats]    default ./knownChats (assertDestinations)
 * @param {Function} [options.sniff]       async (file, name) => { kind, mime } | null
 * @param {number} [options.intervalMs]    default 1000
 */
function createBroadcaster(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..", "..");
  const mediaRoot = options.mediaRoot || path.join(rootDir, "data", "broadcast-media");
  const clock = options.clock || Date.now;
  const random = options.random || Math.random;
  const timers = options.timers || { setInterval: (...a) => setInterval(...a), clearInterval: (h) => clearInterval(h) };
  const sniff = options.sniff || defaultSniff;
  const intervalMs = options.intervalMs || LIMITS.TICK_INTERVAL_MS;

  const config = () => options.config || require("../../config");
  const knownChats = () => options.knownChats || require("./knownChats");
  const settingsStore = () => options.settingsStore || require("./settingsStore");
  const sequelize = database.DATABASE;

  const zone = () => recurrence.resolveZone(config().TIMEZONE);
  const nowOf = (opts) => {
    const given = opts && opts.now !== undefined && opts.now !== null ? toMs(opts.now) : NaN;
    return isFiniteMs(given) ? given : clock();
  };

  let client = null;
  let timer = null;
  let offTimezone = null;
  let busy = false;
  /** ms of the last send, -Infinity when there never was one, null until read once from `max(sentAt)` */
  let lastSendAt = null;
  /** the jitter drawn for the next send (once per send) */
  let jitter = null;
  const listeners = new Set();

  function clientIsDown() {
    return !client || (typeof client.ready === "function" && !client.ready());
  }

  // ----- events --------------------------------------------------------------------------------

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err: safeLog(err) }, "broadcast listener failed");
      }
    }
  }

  // ----- reads ---------------------------------------------------------------------------------

  /** Map runId -> { sent, failed, cancelled, pending } (`pending` counts pending and sending targets) */
  async function countsOf(runIds) {
    const counts = new Map();
    if (!runIds.length) return counts;
    const rows = await BroadcastTarget.findAll({
      attributes: ["runId", "status", [fn("COUNT", col("id")), "n"]],
      where: { runId: { [Op.in]: runIds } },
      group: ["runId", "status"],
      raw: true,
    });
    for (const row of rows) {
      const entry = counts.get(row.runId) || { sent: 0, failed: 0, cancelled: 0, pending: 0 };
      const n = Number(row.n) || 0;
      if (row.status === "sent") entry.sent += n;
      else if (row.status === "failed") entry.failed += n;
      else if (row.status === "cancelled") entry.cancelled += n;
      else entry.pending += n; // pending and sending
      counts.set(row.runId, entry);
    }
    return counts;
  }

  function runShape(run, counts) {
    const c = counts || { sent: 0, failed: 0, cancelled: 0, pending: 0 };
    return {
      id: run.id,
      broadcastId: run.broadcastId,
      dueAt: run.dueAt,
      status: run.status,
      total: run.total,
      sent: c.sent,
      failed: c.failed,
      cancelled: c.cancelled,
      pending: c.pending,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      note: run.note || null,
    };
  }

  const plain = (row) => (row && typeof row.get === "function" ? row.get({ plain: true }) : row);

  async function runById(runId) {
    const run = await BroadcastRun.findByPk(Number(runId));
    if (!run) return null;
    const counts = await countsOf([run.id]);
    return runShape(plain(run), counts.get(run.id));
  }

  /** Publish the state of a run to the listeners (the route turns it into the hub `job` topic) */
  async function emitRun(runId, type, at) {
    if (!listeners.size) return;
    try {
      const run = await runById(runId);
      if (!run) return;
      emit({
        type,
        broadcastId: run.broadcastId,
        runId: run.id,
        status: run.status,
        total: run.total,
        sent: run.sent,
        failed: run.failed,
        cancelled: run.cancelled,
        pending: run.pending,
        updatedAt: new Date(isFiniteMs(at) ? at : clock()).toISOString(),
      });
    } catch (err) {
      logger.warn({ err: safeLog(err) }, "broadcast event not published");
    }
  }

  /** The recurrence rule of a recurring row, or null */
  function ruleOf(row) {
    if (!row || row.kind !== "recurring") return null;
    const base = { kind: row.recurKind, time: row.recurTime };
    if (row.recurKind === "weekly") base.days = String(row.recurDays || "").split(",").map(Number);
    else if (row.recurKind === "monthly") base.day = Number(row.recurDays);
    return recurrence.normalizeRule(base);
  }

  async function latestRuns(broadcastIds) {
    const latest = new Map();
    if (!broadcastIds.length) return latest;
    const heads = await BroadcastRun.findAll({
      attributes: ["broadcastId", [fn("MAX", col("id")), "lastId"]],
      where: { broadcastId: { [Op.in]: broadcastIds } },
      group: ["broadcastId"],
      raw: true,
    });
    const ids = heads.map((head) => Number(head.lastId));
    if (!ids.length) return latest;
    const runs = await BroadcastRun.findAll({ where: { id: { [Op.in]: ids } } });
    const counts = await countsOf(ids);
    for (const run of runs) latest.set(run.broadcastId, runShape(plain(run), counts.get(run.id)));
    return latest;
  }

  /**
   * One broadcast and its latest run.
   * @returns {Promise<{ broadcast: object, latestRun: object|null }|null>}
   */
  async function get(id) {
    const row = await Broadcast.findByPk(Number(id));
    if (!row) return null;
    const latest = await latestRuns([row.id]);
    return { broadcast: plain(row), latestRun: latest.get(row.id) || null };
  }

  /** The newest runs of a broadcast (newest first) with their counts */
  async function runs(broadcastId, { limit = 20 } = {}) {
    const rows = await BroadcastRun.findAll({
      where: { broadcastId: Number(broadcastId) },
      order: [["id", "DESC"]],
      limit: Math.max(1, Math.min(200, Number(limit) || 20)),
    });
    const counts = await countsOf(rows.map((r) => r.id));
    return rows.map((r) => runShape(plain(r), counts.get(r.id)));
  }

  /**
   * Broadcasts, newest first, each with its latest run. `status` is either a `Broadcast.status`
   * (`active`, `paused`) or the status of the latest run (`scheduled`, `running`, `completed`...).
   * @returns {Promise<{ broadcast: object, latestRun: object|null }[]>}
   */
  async function list({ kind, status } = {}) {
    const where = {};
    if (kind) where.kind = kind;
    if (status === "active" || status === "paused") where.status = status;
    const rows = await Broadcast.findAll({ where, order: [["id", "DESC"]] });
    const latest = await latestRuns(rows.map((row) => row.id));
    let items = rows.map((row) => ({ broadcast: plain(row), latestRun: latest.get(row.id) || null }));
    if (status && status !== "active" && status !== "paused") {
      items = items.filter((item) => item.latestRun && item.latestRun.status === status);
    }
    return items;
  }

  /**
   * The per-destination report of a run. Each target carries `mayHaveBeenDelivered` (`timeout`,
   * `connection_closed`, `interrupted`); the names and the "still selectable" flag are added by the caller.
   * @returns {Promise<{ run: object, targets: object[] }>}
   * @throws {BroadcastError} not_found
   */
  async function report(runId) {
    const run = await runById(runId);
    if (!run) throw fail("not_found");
    const rows = await BroadcastTarget.findAll({ where: { runId: run.id }, order: [["position", "ASC"]] });
    return {
      run,
      targets: rows.map((row) => ({
        chatJid: row.chatJid,
        position: row.position,
        status: row.status,
        errorCode: row.errorCode || null,
        mayHaveBeenDelivered: DELIVERED_UNSURE.has(row.errorCode),
        sentAt: row.sentAt || null,
      })),
    };
  }

  // ----- validation and media --------------------------------------------------------------------

  function checkText(text, hasMedia) {
    if (typeof text !== "string" || !text.trim()) throw fail("empty_text");
    const max = hasMedia ? LIMITS.CAPTION : LIMITS.TEXT;
    if (Array.from(text.trim()).length > max) throw fail("text_too_long", { max });
    return text.trim();
  }

  async function resolveTargets(targets) {
    if (!Array.isArray(targets) || targets.length === 0) throw fail("invalid_destination", { indices: [] });
    if (targets.length > LIMITS.MAX_TARGETS) throw fail("too_many_targets", { max: LIMITS.MAX_TARGETS });
    try {
      return await knownChats().assertDestinations(targets);
    } catch (err) {
      if (err && err.code === "invalid_destination") throw fail("invalid_destination", err.params);
      throw err;
    }
  }

  function spacingOf(value) {
    let n = value === undefined || value === null ? Number(config().BROADCAST_DELAY_MS) : Number(value);
    if (!Number.isFinite(n)) n = 5000;
    return Math.min(LIMITS.MAX_SPACING_MS, Math.max(LIMITS.MIN_SPACING_MS, Math.round(n)));
  }

  const titleOf = (title) => {
    const text = String(title === undefined || title === null ? "" : title).normalize("NFC").trim();
    return text ? Array.from(text).slice(0, 100).join("") : null;
  };

  /** Absolute path of a stored media file, checked to stay inside the media directory; null when unusable */
  async function mediaFileOf(row) {
    if (!row || !row.mediaPath) return null;
    try {
      const real = await safeFs.assertInside(mediaRoot, path.resolve(rootDir, row.mediaPath));
      const stat = await fsp.stat(real);
      return stat.isFile() ? real : null;
    } catch {
      return null;
    }
  }

  /**
   * Check the media of an input without writing anything: an upload (`media`) is sniffed and its real size is
   * compared with the live `MAX_UPLOAD`; `reuseMediaOf` names a broadcast whose stored file must still exist.
   * @returns {Promise<{ source: string, kind: string, mime: string, size: number, name: string }|null>}
   */
  async function inspectMedia(input) {
    const { media, reuseMediaOf } = input;
    const hasReuse = reuseMediaOf !== undefined && reuseMediaOf !== null;
    if (media && hasReuse) throw fail("media_type");
    if (hasReuse) {
      const origin = await Broadcast.findByPk(Number(reuseMediaOf));
      const file = origin && origin.mediaKind ? await mediaFileOf(origin) : null;
      if (!file) throw fail("media_unavailable");
      const stat = await fsp.stat(file);
      return { source: file, kind: origin.mediaKind, mime: origin.mediaMime, size: stat.size, name: origin.mediaName || path.basename(file) };
    }
    if (!media) return null;
    if (!media.path || typeof media.path !== "string") throw fail("media_type");
    let stat;
    try {
      stat = await fsp.stat(media.path);
    } catch {
      throw fail("media_type");
    }
    if (!stat.isFile()) throw fail("media_type");
    const maxBytes = (Number(config().MAX_UPLOAD) || 230) * 1024 * 1024;
    if (stat.size > maxBytes) throw fail("media_too_large", { maxBytes });
    const sniffed = await sniff(media.path, String(media.name || ""));
    if (!sniffed || !["image", "document"].includes(sniffed.kind)) throw fail("media_type");
    return { source: media.path, kind: sniffed.kind, mime: sniffed.mime, size: stat.size, name: sanitizeName(media.name, sniffed.mime) };
  }

  /** Put a file where it lives (hard link, else a copy); returns the row fields of the media */
  async function placeMedia(broadcastId, info) {
    const dir = path.join(mediaRoot, String(broadcastId));
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = sanitizeName(info.name, info.mime);
    const target = path.join(dir, name);
    const checked = await safeFs.assertInside(mediaRoot, target);
    const temp = path.join(dir, `.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      await fsp.link(info.source, temp).catch(() => fsp.copyFile(info.source, temp));
      await fsp.chmod(temp, 0o600).catch(() => {});
      await fsp.rename(temp, checked);
    } catch (err) {
      await unlinkQuiet(temp);
      throw err;
    }
    return {
      dir,
      file: checked,
      fields: {
        mediaKind: info.kind,
        mediaPath: path.relative(rootDir, target).split(path.sep).join("/"),
        mediaName: name,
        mediaMime: info.mime,
        mediaSize: info.size,
      },
    };
  }

  const removeDir = async (dir) => {
    try {
      const real = await safeFs.assertInside(mediaRoot, dir);
      await fsp.rm(real, { recursive: true, force: true });
    } catch (err) {
      if (!err || (err.code !== "root_not_found" && err.code !== "ENOENT")) {
        logger.warn({ err: safeLog(err) }, "broadcast media directory not removed");
      }
    }
  };

  /** Validate the common content of a broadcast; nothing is written */
  async function prepare(input) {
    if (!input || typeof input !== "object") throw fail("empty_text");
    const media = await inspectMedia(input);
    const text = checkText(input.text, Boolean(media));
    const targets = await resolveTargets(input.targets);
    return { media, text, targets, title: titleOf(input.title), spacingMs: spacingOf(input.spacingMs) };
  }

  // ----- creation ---------------------------------------------------------------------------------

  /**
   * Create a one-shot broadcast and its only run (`runAt` absent = send now).
   * @returns {Promise<{ broadcastId: number, runId: number }>}
   * @throws {BroadcastError}
   */
  async function createOnce(input = {}, opts = {}) {
    const at = nowOf(opts);
    const prepared = await prepare(input);
    let dueAt = at;
    let runAt = null;
    if (input.runAt !== undefined && input.runAt !== null) {
      runAt = toMs(input.runAt);
      if (!isFiniteMs(runAt)) throw fail("invalid_rule");
      dueAt = runAt;
    }

    const created = await mutex.withLock(LOCK, async () => {
      let placed = null;
      try {
        return await sequelize.transaction(async (transaction) => {
          const row = await Broadcast.create(
            {
              kind: "once",
              title: prepared.title,
              text: prepared.text,
              targets: prepared.targets,
              spacingMs: prepared.spacingMs,
              status: "active",
              runAt: runAt === null ? null : new Date(runAt),
            },
            { transaction },
          );
          if (prepared.media) {
            placed = await placeMedia(row.id, prepared.media);
            await row.update(placed.fields, { transaction });
          }
          const run = await BroadcastRun.create(
            { broadcastId: row.id, dueAt: new Date(dueAt), status: "scheduled", total: prepared.targets.length, targetsReady: false },
            { transaction },
          );
          await BroadcastTarget.bulkCreate(
            prepared.targets.map((chatJid, index) => ({ runId: run.id, chatJid, position: index + 1, status: "pending", attempts: 0 })),
            { transaction },
          );
          await run.update({ targetsReady: true }, { transaction });
          return { broadcastId: row.id, runId: run.id };
        });
      } catch (err) {
        if (placed) await removeDir(placed.dir);
        throw err;
      }
    });

    // the upload has been moved: drop what is left of the staged file
    if (input.media && input.media.path) await unlinkQuiet(input.media.path);
    await emitRun(created.runId, "run", at);
    return created;
  }

  /** Validate a rule from an input; returns the canonical rule and its next occurrence after `at` */
  function checkRule(rule, at) {
    const verdict = recurrence.validateRule(rule);
    if (!verdict.ok) throw fail("invalid_rule", { code: verdict.code });
    const clean = recurrence.normalizeRule(rule);
    const next = recurrence.nextOccurrence(clean, at, zone());
    if (next === null) throw fail("invalid_rule", { code: "bad_kind" });
    return { rule: clean, next };
  }

  const ruleFields = (rule) => ({
    recurKind: rule.kind,
    recurDays: rule.kind === "weekly" ? rule.days.join(",") : rule.kind === "monthly" ? String(rule.day) : null,
    recurTime: rule.time,
  });

  /**
   * Create a recurring broadcast (no run until its first occurrence is due).
   * @returns {Promise<{ broadcastId: number, nextRunAt: Date }>}
   * @throws {BroadcastError}
   */
  async function createRecurring(input = {}, opts = {}) {
    const at = nowOf(opts);
    const prepared = await prepare(input);
    const { rule, next } = checkRule(input.rule, at);

    const created = await mutex.withLock(LOCK, async () => {
      let placed = null;
      try {
        return await sequelize.transaction(async (transaction) => {
          const row = await Broadcast.create(
            {
              kind: "recurring",
              title: prepared.title,
              text: prepared.text,
              targets: prepared.targets,
              spacingMs: prepared.spacingMs,
              status: "active",
              ...ruleFields(rule),
              nextRunAt: new Date(next),
            },
            { transaction },
          );
          if (prepared.media) {
            placed = await placeMedia(row.id, prepared.media);
            await row.update(placed.fields, { transaction });
          }
          return { broadcastId: row.id, nextRunAt: new Date(next) };
        });
      } catch (err) {
        if (placed) await removeDir(placed.dir);
        throw err;
      }
    });
    if (input.media && input.media.path) await unlinkQuiet(input.media.path);
    return created;
  }

  /**
   * Edit a recurring broadcast. Only the given fields change: `title`, `text`, `targets`, `spacingMs`, `rule`
   * (recomputes `nextRunAt` from now), a new `media` or `reuseMediaOf`. Runs already materialized keep their targets.
   * @throws {BroadcastError} not_found, not_editable (a one-shot broadcast), and the creation errors
   */
  async function updateRecurring(id, patch = {}, opts = {}) {
    const at = nowOf(opts);
    const key = Number(id);
    return mutex.withLock(LOCK, async () => {
      const row = await Broadcast.findByPk(key);
      if (!row) throw fail("not_found");
      if (row.kind !== "recurring") throw fail("not_editable");

      const changes = {};
      const hasNewMedia = Boolean(patch.media) || (patch.reuseMediaOf !== undefined && patch.reuseMediaOf !== null);
      const media = hasNewMedia ? await inspectMedia(patch) : null;
      const mediaAfter = Boolean(media) || Boolean(row.mediaKind);
      if ("text" in patch || hasNewMedia) changes.text = checkText("text" in patch ? patch.text : row.text, mediaAfter);
      if ("title" in patch) changes.title = titleOf(patch.title);
      if ("targets" in patch) changes.targets = await resolveTargets(patch.targets);
      if ("spacingMs" in patch) changes.spacingMs = spacingOf(patch.spacingMs);
      if (patch.rule !== undefined && patch.rule !== null) {
        const { rule, next } = checkRule(patch.rule, at);
        Object.assign(changes, ruleFields(rule), { nextRunAt: new Date(next) });
      }

      let placed = null;
      const previous = media ? await mediaFileOf(row) : null;
      try {
        await sequelize.transaction(async (transaction) => {
          if (media) {
            placed = await placeMedia(row.id, media);
            Object.assign(changes, placed.fields);
          }
          await row.update(changes, { transaction });
        });
      } catch (err) {
        if (placed && placed.file !== previous) await unlinkQuiet(placed.file);
        throw err;
      }
      if (placed) {
        // the old file goes once the row points at the new one
        const dir = path.join(mediaRoot, String(row.id));
        for (const entry of await fsp.readdir(dir).catch(() => [])) {
          if (path.join(dir, entry) !== placed.file) await unlinkQuiet(path.join(dir, entry));
        }
      }
      if (patch.media && patch.media.path) await unlinkQuiet(patch.media.path);
      return { broadcastId: row.id, nextRunAt: row.nextRunAt || null };
    });
  }

  /** Stop materializing occurrences (the runs already created go on). Recurring only. */
  async function pause(id) {
    return mutex.withLock(LOCK, async () => {
      const row = await Broadcast.findByPk(Number(id));
      if (!row) throw fail("not_found");
      if (row.kind !== "recurring") throw fail("not_editable");
      await row.update({ status: "paused" });
      return { broadcastId: row.id };
    });
  }

  /** Resume: `nextRunAt` is recomputed from now, no catch-up burst. Recurring only. */
  async function resume(id, opts = {}) {
    const at = nowOf(opts);
    return mutex.withLock(LOCK, async () => {
      const row = await Broadcast.findByPk(Number(id));
      if (!row) throw fail("not_found");
      if (row.kind !== "recurring") throw fail("not_editable");
      const next = recurrence.nextOccurrence(ruleOf(row), at, zone());
      await row.update({ status: "active", nextRunAt: next === null ? row.nextRunAt : new Date(next) });
      return { broadcastId: row.id, nextRunAt: row.nextRunAt };
    });
  }

  /**
   * Delete the definition, its runs, its targets and its media. Refused (`busy`) while a run is running.
   * @throws {BroadcastError} not_found, busy
   */
  async function remove(id) {
    const key = Number(id);
    await mutex.withLock(LOCK, async () => {
      const row = await Broadcast.findByPk(key);
      if (!row) throw fail("not_found");
      const all = await BroadcastRun.findAll({ where: { broadcastId: key }, attributes: ["id", "status"], raw: true });
      if (all.some((run) => run.status === "running")) throw fail("busy");
      const runIds = all.map((run) => run.id);
      await sequelize.transaction(async (transaction) => {
        if (runIds.length) await BroadcastTarget.destroy({ where: { runId: { [Op.in]: runIds } }, transaction });
        await BroadcastRun.destroy({ where: { broadcastId: key }, transaction });
        await row.destroy({ transaction });
      });
      await removeDir(path.join(mediaRoot, String(key)));
    });
    return { deleted: true };
  }

  /** Move the pending targets of a run to `cancelled` (the message in flight is left to finish) */
  const cancelPending = (runId) => BroadcastTarget.update({ status: "cancelled" }, { where: { runId, status: "pending" } });

  /**
   * Cancel an open run (`scheduled` or `running`): its pending targets become `cancelled`, the message in flight
   * completes and is reported `sent`. For a recurring broadcast only that occurrence ends.
   * @returns {Promise<object>} the run
   * @throws {BroadcastError} not_found, not_pending
   */
  async function cancelRun(runId, opts = {}) {
    const at = nowOf(opts);
    const id = Number(runId);
    await mutex.withLock(LOCK, async () => {
      // run first: from here no new claim can succeed (the claim also checks that its run is open)
      const [changed] = await BroadcastRun.update(
        { status: "cancelled", finishedAt: new Date(at) },
        { where: { id, status: { [Op.in]: OPEN_RUN } } },
      );
      if (changed === 0) {
        const exists = await BroadcastRun.findByPk(id, { attributes: ["id"] });
        throw fail(exists ? "not_pending" : "not_found");
      }
      await cancelPending(id);
    });
    await emitRun(id, "run", at);
    return runById(id);
  }

  // ----- recurrence -------------------------------------------------------------------------------

  /**
   * TIMEZONE changed: recompute `nextRunAt` of the active recurring broadcasts from now (no catch-up burst).
   * @returns {Promise<number>} broadcasts whose schedule moved
   */
  async function recomputeRecurrences(opts = {}) {
    const at = nowOf(opts);
    return mutex.withLock(LOCK, async () => {
      const rows = await Broadcast.findAll({ where: { kind: "recurring", status: "active" } });
      let moved = 0;
      for (const row of rows) {
        const rule = ruleOf(row);
        const next = rule ? recurrence.nextOccurrence(rule, at, zone()) : null;
        if (next === null) continue;
        if (!row.nextRunAt || row.nextRunAt.getTime() !== next) {
          await row.update({ nextRunAt: new Date(next) });
          moved += 1;
        }
      }
      return moved;
    });
  }

  /**
   * One occurrence of a recurring broadcast: advance the schedule (compare-and-swap on `nextRunAt`), insert the run
   * and its targets, in one transaction behind the mutex. The unique index (broadcastId, dueAt) is the second guard.
   * @returns {Promise<{ outcome: "scheduled"|"expired"|"lost"|"exists", runId?: number }>}
   */
  async function createOccurrence(row, due, next, late, at) {
    return mutex.withLock(LOCK, async () => {
      const move = { nextRunAt: new Date(next), lastRunAt: new Date(due) };
      const guard = { id: row.id, kind: "recurring", status: "active", nextRunAt: new Date(due) };
      try {
        return await sequelize.transaction(async (transaction) => {
          const [changed] = await Broadcast.update(move, { where: guard, transaction });
          if (changed === 0) return { outcome: "lost" };
          const fresh = await Broadcast.findByPk(row.id, { transaction });
          const jids = late ? [] : Array.isArray(fresh.targets) ? fresh.targets : [];
          const run = await BroadcastRun.create(
            {
              broadcastId: row.id,
              dueAt: new Date(due),
              status: late ? "expired" : "scheduled",
              note: late ? "late" : null,
              total: jids.length,
              // an expired occurrence has no target to wait for: it is complete as it is
              targetsReady: late,
              finishedAt: late ? new Date(at) : null,
            },
            { transaction },
          );
          if (!late) {
            await BroadcastTarget.bulkCreate(
              jids.map((chatJid, index) => ({ runId: run.id, chatJid, position: index + 1, status: "pending", attempts: 0 })),
              { transaction },
            );
            await run.update({ targetsReady: true }, { transaction });
          }
          return { outcome: late ? "expired" : "scheduled", runId: run.id };
        });
      } catch (err) {
        if (err && err.name === "SequelizeUniqueConstraintError") {
          // the occurrence exists already (a restored backup...): only move the schedule on
          await Broadcast.update(move, { where: guard });
          return { outcome: "exists" };
        }
        throw err;
      }
    });
  }

  async function materializeOne(row, at, stats) {
    const rule = ruleOf(row);
    const tz = zone();
    let due = row.nextRunAt.getTime();
    if (!rule) {
      await row.update({ status: "paused" });
      logger.warn({ id: row.id }, "recurring broadcast with an unreadable rule paused");
      return;
    }
    for (let i = 0; i < LIMITS.MATERIALIZE_ITERATIONS && due <= at; i += 1) {
      const next = recurrence.nextOccurrence(rule, due, tz);
      if (next === null) {
        await row.update({ status: "paused" });
        return;
      }
      const late = at - due > LIMITS.LATE_MS;
      const { outcome, runId } = await createOccurrence(row, due, next, late, at);
      if (outcome === "lost") return; // another tick owns this occurrence
      if (outcome === "scheduled") stats.materialized += 1;
      else if (outcome === "expired") stats.expired += 1;
      if (runId) emitRun(runId, "run", at);
      due = next;
    }
    if (due <= at) {
      // the bot was down for weeks: jump to the next occurrence after now
      const jump = recurrence.nextOccurrence(rule, at, tz);
      if (jump !== null) {
        await Broadcast.update({ nextRunAt: new Date(jump) }, { where: { id: row.id, status: "active", nextRunAt: new Date(due) } });
      }
    }
  }

  async function materialize(at, stats) {
    const due = await Broadcast.findAll({
      where: { kind: "recurring", status: "active", nextRunAt: { [Op.lte]: new Date(at) } },
      order: [["nextRunAt", "ASC"], ["id", "ASC"]],
      limit: 50,
    });
    for (const row of due) {
      try {
        await materializeOne(row, at, stats);
      } catch (err) {
        logger.warn({ id: row.id, err: safeLog(err) }, "recurring broadcast not materialized");
      }
    }
  }

  // ----- delivery ---------------------------------------------------------------------------------

  /** Close a run whose targets are all settled: `completed`, or `failed` when nothing was sent */
  async function completeIfDone(runId, at) {
    const done = await mutex.withLock(LOCK, async () => {
      const open = await BroadcastTarget.count({ where: { runId, status: { [Op.in]: ["pending", "sending"] } } });
      if (open > 0) return false;
      const sent = await BroadcastTarget.count({ where: { runId, status: "sent" } });
      const [changed] = await BroadcastRun.update(
        { status: sent > 0 ? "completed" : "failed", finishedAt: new Date(at) },
        { where: { id: runId, status: "running" } },
      );
      return changed > 0;
    });
    if (done) await emitRun(runId, "run", at);
    return done;
  }

  async function gate(at, stats) {
    const now = new Date(at);

    // 1. a run that never started and is more than 1 h late is not sent any more
    const late = await BroadcastRun.findAll({
      where: { status: "scheduled", startedAt: null, dueAt: { [Op.lt]: new Date(at - LIMITS.LATE_MS) } },
      attributes: ["id"],
      raw: true,
      limit: 200,
    });
    for (const { id } of late) {
      const [changed] = await BroadcastRun.update(
        { status: "expired", note: "late", finishedAt: now },
        { where: { id, status: "scheduled", startedAt: null } },
      );
      if (changed > 0) {
        await cancelPending(id);
        stats.expired += 1;
        emitRun(id, "run", at);
      }
    }

    // 2. a run started more than 24 h ago is closed (never send a week-old announcement)
    const stale = await BroadcastRun.findAll({
      where: { status: "running", startedAt: { [Op.lt]: new Date(at - LIMITS.STALE_RUN_MS) } },
      attributes: ["id"],
      raw: true,
      limit: 200,
    });
    for (const { id } of stale) {
      const [changed] = await BroadcastRun.update(
        { status: "cancelled", note: "stale", finishedAt: now },
        { where: { id, status: "running" } },
      );
      if (changed > 0) {
        await cancelPending(id);
        emitRun(id, "run", at);
      }
    }

    // 3. a target caught mid-send by a crash may have gone out: failed, never retried
    const stuck = await BroadcastTarget.findAll({
      where: { status: "sending", leaseUntil: { [Op.lt]: now } },
      attributes: ["id", "runId"],
      raw: true,
      limit: 500,
    });
    const touched = new Set();
    for (const target of stuck) {
      const [changed] = await BroadcastTarget.update(
        { status: "failed", errorCode: "interrupted", leaseUntil: null },
        { where: { id: target.id, status: "sending" } },
      );
      if (changed > 0) {
        stats.failed += 1;
        touched.add(target.runId);
      }
    }
    for (const runId of touched) emitRun(runId, "target", at);
  }

  /** Runs whose last target settled but whose own close was lost (a crash between the two writes) */
  async function completeSweep(at) {
    const open = await BroadcastRun.findAll({ where: { status: "running", targetsReady: true }, attributes: ["id"], raw: true, limit: 200 });
    for (const { id } of open) await completeIfDone(id, at);
  }

  /**
   * `max(sentAt)`, read once. A target still `sending` (the process died mid-send) counts at its claim time
   * (`leaseUntil` minus the lease), so a restart cannot send right behind a message that may have gone out.
   */
  async function ensureLastSendAt() {
    if (lastSendAt !== null) return;
    const latest = await BroadcastTarget.max("sentAt");
    const leased = await BroadcastTarget.max("leaseUntil", { where: { status: "sending" } });
    const sent = latest === null || latest === undefined ? -Infinity : toMs(latest);
    const claimed = leased === null || leased === undefined ? -Infinity : toMs(leased) - LIMITS.LEASE_MS;
    // an unreadable date must not turn into "never sent": stay unset and try again at the next tick
    if (Number.isNaN(sent) || Number.isNaN(claimed)) return;
    lastSendAt = Math.max(sent, claimed);
  }

  /** The message of a broadcast; a missing media file never falls back to a text-only send */
  async function contentOf(broadcast) {
    if (!broadcast.mediaKind) return { text: broadcast.text };
    const file = await mediaFileOf(broadcast);
    if (!file) throw fail("media_unavailable");
    if (broadcast.mediaKind === "image") return { image: { url: file }, caption: broadcast.text };
    return {
      document: { url: file },
      mimetype: broadcast.mediaMime || "application/octet-stream",
      fileName: broadcast.mediaName || path.basename(file),
      caption: broadcast.text,
    };
  }

  /** Send the claimed target and settle it. Never throws. */
  async function sendAndSettle(run, target, broadcast, sock, settleAt, stats) {
    let outcome;
    try {
      const content = await contentOf(broadcast);
      const result = await withTimeout(() => sock.sendMessage(target.chatJid, content), LIMITS.SEND_TIMEOUT_MS, "broadcast send");
      const id = result && result.key && result.key.id ? String(result.key.id).slice(0, 64) : null;
      outcome = { ok: true, messageId: id };
    } catch (err) {
      const code = classify(err);
      if (code === "error") logger.warn({ runId: run.id, err: safeLog(err) }, "broadcast send failed");
      outcome = { ok: false, code };
    }

    const changes = outcome.ok
      ? { status: "sent", sentAt: new Date(settleAt()), messageId: outcome.messageId, leaseUntil: null }
      : { status: "failed", errorCode: outcome.code, leaseUntil: null };
    try {
      const [changed] = await BroadcastTarget.update(changes, { where: { id: target.id, status: "sending" } });
      if (changed > 0) stats[outcome.ok ? "sent" : "failed"] += 1;
    } catch (err) {
      // the message may have gone out: the lease will turn this target into failed / interrupted, never a resend
      logger.error({ runId: run.id, err: safeLog(err) }, "broadcast target not settled");
      return;
    }
    await completeIfDone(run.id, settleAt());
    await emitRun(run.id, "target", settleAt());
  }

  /** Pick, pace, claim and send at most one target */
  async function deliverOne(at, stats, settleAt) {
    await ensureLastSendAt();
    if (lastSendAt === null) return;
    const now = new Date(at);

    const candidates = await BroadcastRun.findAll({
      where: { status: { [Op.in]: OPEN_RUN }, targetsReady: true, dueAt: { [Op.lte]: now } },
      order: [["dueAt", "ASC"], ["id", "ASC"]],
      limit: 20,
    });
    for (const run of candidates) {
      const target = await BroadcastTarget.findOne({ where: { runId: run.id, status: "pending" }, order: [["position", "ASC"]] });
      if (!target) continue;
      const broadcast = await Broadcast.findByPk(run.broadcastId);
      if (!broadcast) continue; // orphan run: the housekeeping deletes it

      // pace: the gap only ever lengthens the spacing, so the 2 s floor holds
      if (jitter === null) jitter = random() * 0.2;
      const gap = Math.max(LIMITS.MIN_SPACING_MS, Number(broadcast.spacingMs) || 0) * (1 + jitter);
      if (at - lastSendAt < gap) return;

      // the socket and the connection are checked right before the claim, never after
      const sock = client && typeof client.getSocket === "function" ? client.getSocket() : null;
      if (clientIsDown() || !sock) return;

      if (run.status === "scheduled") {
        await BroadcastRun.update({ status: "running", startedAt: now }, { where: { id: run.id, status: "scheduled" } });
      }
      const open = `(SELECT "id" FROM "broadcast_runs" WHERE "id" = ${Number(run.id)} AND "status" IN ('scheduled', 'running'))`;
      const [claimed] = await BroadcastTarget.update(
        { status: "sending", attempts: literal('"attempts" + 1'), leaseUntil: new Date(at + LIMITS.LEASE_MS) },
        { where: { id: target.id, status: "pending", runId: { [Op.in]: literal(open) } } },
      );
      if (claimed === 0) {
        stats.skipped += 1;
        return;
      }
      stats.claimed += 1;
      lastSendAt = at;
      jitter = null;
      if (run.status === "scheduled") await emitRun(run.id, "run", at);

      await sendAndSettle(run, target, plain(broadcast), sock, settleAt, stats);
      return;
    }
  }

  /**
   * One pass of the engine. Safe to call concurrently (every transition is a compare-and-swap) and never rejects.
   * @param {Date|number} [nowArg] test hook: the instant to treat as "now"
   * @returns {Promise<{ materialized: number, claimed: number, sent: number, failed: number, expired: number, skipped: number }>}
   */
  async function tick(nowArg) {
    const stats = { materialized: 0, claimed: 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
    if (clientIsDown()) return stats;
    const given = nowArg !== undefined && nowArg !== null ? toMs(nowArg) : NaN;
    const at = isFiniteMs(given) ? given : clock();
    const settleAt = isFiniteMs(given) ? () => at : clock;

    for (const [label, step] of [
      ["gate", () => gate(at, stats)],
      ["materialize", () => materialize(at, stats)],
      ["complete", () => completeSweep(at)],
      ["deliver", () => deliverOne(at, stats, settleAt)],
    ]) {
      try {
        await step();
      } catch (err) {
        logger.warn({ step: label, err: safeLog(err) }, "broadcast tick step failed");
      }
    }
    return stats;
  }

  function onInterval() {
    if (busy) return; // the previous tick is still running
    busy = true;
    tick()
      .catch((err) => logger.warn({ err: safeLog(err) }, "broadcast tick failed"))
      .finally(() => {
        busy = false;
      });
  }

  /**
   * Start the loop. Idempotent: on every connection open it keeps the latest client and never creates a second
   * interval. Also follows the TIMEZONE setting (the pending occurrences are recomputed when it changes).
   * @param {{ getSocket: Function, ready?: Function }} [newClient]
   */
  function start(newClient) {
    if (newClient) client = newClient;
    if (timer) return;
    timer = timers.setInterval(onInterval, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      const store = settingsStore();
      if (store && typeof store.onChange === "function" && !offTimezone) {
        offTimezone = store.onChange(["TIMEZONE"], () => {
          recomputeRecurrences().catch((err) => logger.warn({ err: safeLog(err) }, "recurrences not recomputed"));
        });
      }
    } catch (err) {
      logger.warn({ err: safeLog(err) }, "TIMEZONE changes not followed");
    }
  }

  /** Stop the loop and forget the client */
  function stop() {
    if (timer) timers.clearInterval(timer);
    timer = null;
    if (offTimezone) offTimezone();
    offTimezone = null;
    client = null;
    busy = false;
  }

  const isRunning = () => timer !== null;

  // ----- media retention (U15) ----------------------------------------------------------------------

  async function deleteMedia(row) {
    const dir = path.join(mediaRoot, String(row.id));
    let bytes = 0;
    try {
      bytes = (await safeFs.measure(dir, { maxEntries: Infinity, maxDepth: 4, budgetMs: Infinity })).bytes;
    } catch {
      bytes = 0;
    }
    await removeDir(dir);
    await Broadcast.update({ mediaPath: null }, { where: { id: row.id } });
    return bytes;
  }

  /**
   * The shared walk of sweepMedia / purgeFinishedMedia, behind the mutex. A `once` broadcast whose runs are all
   * final loses its media (7 days after the last `finishedAt`, or at once when `immediate`); a `once` broadcast
   * with an open run and every recurring broadcast keep it. A dangling `mediaPath` (the file is gone and no run is
   * open) is cleared.
   */
  async function reapMedia(at, { immediate }) {
    return mutex.withLock(LOCK, async () => {
      const result = { freedBytes: 0, removed: 0, skipped: 0, cleared: 0 };
      const rows = await Broadcast.findAll({ where: { mediaPath: { [Op.ne]: null } }, order: [["id", "ASC"]] });
      for (const row of rows) {
        if (row.kind === "recurring") {
          if (immediate) result.skipped += 1;
          continue;
        }
        const own = await BroadcastRun.findAll({ where: { broadcastId: row.id }, attributes: ["status", "finishedAt"], raw: true });
        if (own.some((run) => OPEN_RUN.includes(run.status))) {
          if (immediate) result.skipped += 1;
          continue;
        }
        const finished = own.reduce((latest, run) => Math.max(latest, run.finishedAt ? toMs(run.finishedAt) : -Infinity), -Infinity);
        const due = immediate || (finished !== -Infinity && at - finished >= LIMITS.MEDIA_RETENTION_MS);
        if (due) {
          result.freedBytes += await deleteMedia(row);
          result.removed += 1;
        } else if (!(await mediaFileOf(row))) {
          await Broadcast.update({ mediaPath: null }, { where: { id: row.id } });
          result.cleared += 1;
        }
      }
      return result;
    });
  }

  /** Daily housekeeping: media of finished one-shot broadcasts after 7 days, orphan directories, dangling paths */
  async function sweepMedia(opts = {}) {
    const at = nowOf(opts);
    const result = await reapMedia(at, { immediate: false });
    result.orphans = await mutex.withLock(LOCK, async () => {
      let entries;
      try {
        entries = await fsp.readdir(mediaRoot);
      } catch {
        return 0;
      }
      const ids = entries.filter((name) => /^\d+$/.test(name)).map(Number);
      if (!ids.length) return 0;
      const known = new Set((await Broadcast.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id"], raw: true })).map((r) => r.id));
      let removed = 0;
      for (const id of ids) {
        if (known.has(id)) continue;
        await removeDir(path.join(mediaRoot, String(id)));
        removed += 1;
      }
      return removed;
    });
    return result;
  }

  /** Storage page: delete the media that can no longer be sent now; what may still be sent is counted in `skipped` */
  async function purgeFinishedMedia(opts = {}) {
    const result = await reapMedia(nowOf(opts), { immediate: true });
    return { freedBytes: result.freedBytes, removed: result.removed, skipped: result.skipped };
  }

  return {
    start,
    stop,
    isRunning,
    tick,
    createOnce,
    createRecurring,
    updateRecurring,
    pause,
    resume,
    remove,
    cancelRun,
    report,
    get,
    runs,
    list,
    subscribe,
    recomputeRecurrences,
    sweepMedia,
    purgeFinishedMedia,
    ruleOf,
    LIMITS,
    BroadcastError,
  };
}

const defaultEngine = createBroadcaster();

module.exports = defaultEngine;
module.exports.createBroadcaster = createBroadcaster;
module.exports.BroadcastError = BroadcastError;
module.exports.LIMITS = LIMITS;
module.exports.classify = classify;
module.exports.sanitizeName = sanitizeName;
module.exports.defaultSniff = defaultSniff;
