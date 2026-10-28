"use strict";

/**
 * Storage page (US11 scenario 4, FR-056; contracts/runtime.md section 14 "storage"; admin-http-api.md MNT-6 and
 * MNT-7; research D3, U5, U15):
 *
 *   const storage = createStorageService(deps);
 *   await storage.list({ refresh })   -> { categories: [{ id, bytes, files, items, unit, truncated, purgeable,
 *                                         protectedBytes, protectedItems, measuredAt, dialect }], disk }
 *   await storage.purge(id, { confirm, actor, now }) -> { freedBytes, removed, skipped }
 *
 * The six categories are the ones that really exist:
 *
 *   temp_media        `media/temp` plus crash leftovers in the OS temp dir (`owb-*`, `voice-*`, older than 15 min,
 *                     owned by our uid). Purge: children of `media/temp` (entries modified in the last 60 s are
 *                     kept) and those leftovers.
 *   broadcast_media   `data/broadcast-media/`. `protectedBytes` / `protectedItems` count the media of recurring
 *                     broadcasts and of one-shot broadcasts whose run is not final. Purge: ONLY
 *                     `broadcaster.purgeFinishedMedia()` (U15), never a generic children purge, so a scheduled or
 *                     recurring broadcast keeps its media; what is kept is reported in `skipped`.
 *   antidelete_cache  the in-memory cache (`antiDeleteHandler.getCacheStats()` / `clearCache()`), unit "messages";
 *                     the content is never exposed.
 *   panel_backups     `data/backups/` (the pre-restore files). `restore.lock` is never removed.
 *   logs              `logs/*.log` (PM2 only; Docker is 0). Purge TRUNCATES the files: PM2 holds the descriptors.
 *   database          size only (SQLite file with -wal / -shm / -journal, or `pg_database_size`): `purgeable: false`,
 *                     `purge("database")` throws `not_purgeable`.
 *
 * Paths are constants of this module (the request only carries a category id). `lib/utils/safeFs.js` does the
 * walking and the deleting: children only, never the target, a symlink is unlinked and never followed, `.gitkeep`
 * is kept; `sessions/`, `data/` (other than `data/backups` and, through the broadcaster, `data/broadcast-media`),
 * the `media/` root, the database and `data/status_save.json` are never named here.
 *
 * Results are cached 30 s per category; `list({ refresh: true })` re-measures and is limited to one per 5 s
 * (`rate_limited`, `retryAfterMs`); one purge at a time per category (`busy`). Free disk comes from `fs.statfs`.
 *
 * DEPS (all optional, looked up when used): rootDir, dataDir, tmpDir, uid, models, broadcaster, antiDeleteHandler,
 * safeFs, statfs, clock, logger.
 */

const nodeFs = require("fs");
const nodeOs = require("os");
const path = require("path");
const { Op } = require("sequelize");
const { AdminError } = require("../http/response");
const { createLogger } = require("../../utils/logger");

const CACHE_MS = 30 * 1000;
const REFRESH_GAP_MS = 5 * 1000;
const FRESH_MS = 60 * 1000; // entries of media/temp modified more recently are in use
const LEFTOVER_AGE_MS = 15 * 60 * 1000;
const LEFTOVER_SCAN_MAX = 500;
const LEFTOVER_NAME = /^(owb|voice)-/;
const OPEN_RUN = ["scheduled", "running"];

const CATEGORY_IDS = Object.freeze(["temp_media", "broadcast_media", "antidelete_cache", "panel_backups", "logs", "database"]);

function createStorageService(deps = {}) {
  const fs = nodeFs.promises;
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());
  const logger = () => deps.logger || createLogger("admin-storage");

  const rootDir = deps.rootDir || path.resolve(__dirname, "..", "..", "..");
  const dataDir = deps.dataDir || path.join(rootDir, "data");
  const tmpDir = deps.tmpDir || nodeOs.tmpdir();
  const uid = deps.uid !== undefined ? deps.uid : typeof process.getuid === "function" ? process.getuid() : null;
  const paths = Object.freeze({
    tempMedia: path.join(rootDir, "media", "temp"),
    broadcastMedia: path.join(dataDir, "broadcast-media"),
    backups: path.join(dataDir, "backups"),
    logs: path.join(rootDir, "logs"),
  });

  const safeFs = () => deps.safeFs || require("../../utils/safeFs");
  const models = () => deps.models || require("../../database");
  const broadcaster = () => deps.broadcaster || require("../../utils/broadcaster");
  const antiDelete = () => deps.antiDeleteHandler || require("../../utils/antiDeleteHandler");

  const cache = new Map(); // id -> { at, value }
  const inflight = new Map(); // id -> Promise (concurrent list() calls share one measurement)
  const purging = new Set();
  let lastRefreshAt = null;

  // ----- measuring ---------------------------------------------------------------------------------

  /** Crash leftovers of the OS temp dir that are safe to count and to delete: ours, old, not a link */
  async function tmpLeftovers(at) {
    let names;
    try {
      names = await fs.readdir(tmpDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!LEFTOVER_NAME.test(name)) continue;
      if (out.length >= LEFTOVER_SCAN_MAX) break;
      const full = path.join(tmpDir, name);
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) continue;
        if (uid !== null && stat.uid !== uid) continue;
        if (at - stat.mtimeMs < LEFTOVER_AGE_MS) continue;
        out.push({ full, stat });
      } catch {
        // vanished
      }
    }
    return out;
  }

  async function sizeOfEntry({ full, stat }) {
    if (!stat.isDirectory()) return { bytes: stat.size, files: 1, truncated: false };
    return safeFs().measure(full);
  }

  async function measureTempMedia() {
    const main = await safeFs().measure(paths.tempMedia);
    const total = { ...main };
    for (const entry of await tmpLeftovers(now())) {
      const part = await sizeOfEntry(entry);
      total.bytes += part.bytes;
      total.files += part.files;
      total.truncated = total.truncated || part.truncated;
    }
    return { ...total, unit: "files", items: total.files };
  }

  /** Media still owed to a broadcast that can be sent: recurring ones and one-shot ones with an open run */
  async function protectedMedia() {
    const { Broadcast, BroadcastRun } = models();
    const rows = await Broadcast.findAll({ where: { mediaPath: { [Op.ne]: null } }, attributes: ["id", "kind", "mediaSize"], raw: true });
    const onceIds = rows.filter((row) => row.kind === "once").map((row) => row.id);
    const open = new Set();
    if (onceIds.length) {
      const runs = await BroadcastRun.findAll({ where: { broadcastId: onceIds, status: OPEN_RUN }, attributes: ["broadcastId"], raw: true });
      for (const run of runs) open.add(run.broadcastId);
    }
    const kept = rows.filter((row) => row.kind === "recurring" || open.has(row.id));
    return { items: kept.length, bytes: kept.reduce((sum, row) => sum + (Number(row.mediaSize) || 0), 0) };
  }

  async function measureBroadcastMedia() {
    const total = await safeFs().measure(paths.broadcastMedia);
    let kept = { items: null, bytes: null };
    try {
      kept = await protectedMedia();
      kept.bytes = Math.min(kept.bytes, total.bytes);
    } catch (err) {
      logger().warn({ name: err && err.name, code: err && err.code }, "storage: protected media could not be counted");
    }
    return { ...total, unit: "files", items: total.files, protectedBytes: kept.bytes, protectedItems: kept.items };
  }

  async function measureLogs() {
    // only *.log, the files PM2 writes (a directory of anything else would not drop to zero after a purge)
    const out = { bytes: 0, files: 0, truncated: false, unit: "files" };
    let names;
    try {
      names = await fs.readdir(paths.logs);
    } catch {
      return { ...out, items: 0 };
    }
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      try {
        const stat = await fs.lstat(path.join(paths.logs, name));
        if (!stat.isFile()) continue;
        out.bytes += stat.size;
        out.files += 1;
      } catch {
        // vanished
      }
    }
    return { ...out, items: out.files };
  }

  function measureAntiDelete() {
    const stats = antiDelete().getCacheStats();
    return { bytes: stats.bytes, files: 0, truncated: false, unit: "messages", items: stats.entries };
  }

  async function measureDatabase() {
    const { DATABASE } = models();
    const dialect = DATABASE.getDialect();
    if (dialect === "sqlite") {
      const file = DATABASE.options && DATABASE.options.storage;
      const out = { bytes: 0, files: 0, truncated: false, unit: "files", dialect };
      if (typeof file === "string" && file && file !== ":memory:") {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          try {
            const stat = await fs.stat(file + suffix);
            if (stat.isFile()) {
              out.bytes += stat.size;
              out.files += 1;
            }
          } catch {
            // the sibling files only exist while SQLite uses them
          }
        }
      }
      return { ...out, items: out.files };
    }
    const rows = await DATABASE.query("SELECT pg_database_size(current_database()) AS size", { type: "SELECT" });
    const size = Number(rows && rows[0] && rows[0].size);
    return { bytes: Number.isFinite(size) ? size : 0, files: 0, truncated: false, unit: "bytes", items: 0, dialect };
  }

  async function measureBackups() {
    const out = await safeFs().measure(paths.backups);
    return { ...out, unit: "files", items: out.files };
  }

  const MEASURE = {
    temp_media: measureTempMedia,
    broadcast_media: measureBroadcastMedia,
    antidelete_cache: measureAntiDelete,
    panel_backups: measureBackups,
    logs: measureLogs,
    database: measureDatabase,
  };

  /** One category as the page shows it. A measurement that fails reads as unknown, never as zero. */
  async function measureCategory(id) {
    const at = now();
    try {
      const m = await MEASURE[id]();
      return {
        id,
        bytes: m.bytes,
        files: m.files,
        items: m.items,
        unit: m.unit,
        truncated: Boolean(m.truncated),
        purgeable: id !== "database",
        protectedBytes: id === "broadcast_media" ? (m.protectedBytes ?? null) : null,
        protectedItems: id === "broadcast_media" ? (m.protectedItems ?? null) : null,
        measuredAt: new Date(at).toISOString(),
        dialect: id === "database" ? m.dialect || null : null,
      };
    } catch (err) {
      logger().warn({ id, name: err && err.name, code: err && err.code }, "storage: a category could not be measured");
      return {
        id,
        bytes: null,
        files: null,
        items: null,
        unit: id === "antidelete_cache" ? "messages" : "files",
        truncated: false,
        purgeable: id !== "database",
        protectedBytes: null,
        protectedItems: null,
        measuredAt: new Date(at).toISOString(),
        dialect: null,
      };
    }
  }

  function categoryOf(id, at) {
    const hit = cache.get(id);
    if (hit && at - hit.at < CACHE_MS) return Promise.resolve(hit.value);
    if (!inflight.has(id)) {
      inflight.set(
        id,
        measureCategory(id)
          .then((value) => {
            cache.set(id, { at: now(), value });
            return value;
          })
          .finally(() => inflight.delete(id)),
      );
    }
    return inflight.get(id);
  }

  async function diskOf() {
    try {
      const statfs = deps.statfs || fs.statfs;
      const stat = await statfs(rootDir);
      const size = Number(stat.bsize);
      return { freeBytes: Number(stat.bavail) * size, totalBytes: Number(stat.blocks) * size };
    } catch {
      return { freeBytes: null, totalBytes: null };
    }
  }

  /**
   * Every category, cached 30 s. `refresh` re-measures them all, at most once per 5 s.
   * @throws {AdminError} rate_limited (`params.retryAfterMs`)
   */
  async function list({ refresh = false } = {}) {
    const at = now();
    if (refresh) {
      if (lastRefreshAt !== null && at - lastRefreshAt < REFRESH_GAP_MS) {
        throw new AdminError("rate_limited", { params: { retryAfterMs: REFRESH_GAP_MS - (at - lastRefreshAt) } });
      }
      lastRefreshAt = at;
      cache.clear();
    }
    const categories = [];
    for (const id of CATEGORY_IDS) categories.push(await categoryOf(id, at));
    return { categories, disk: await diskOf() };
  }

  // ----- purging -----------------------------------------------------------------------------------

  /** A purge step that cannot run (target is a link or not a directory...) skips instead of failing the request */
  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      logger().warn({ code: err && err.code, name: err && err.name }, "storage: a purge step was skipped");
      return { freedBytes: 0, removed: 0, skipped: 1 };
    }
  }

  async function purgeTempMedia(at) {
    const total = await guarded(() => safeFs().purgeChildren(paths.tempMedia, { olderThanMs: FRESH_MS, now: at }));
    const result = { freedBytes: total.freedBytes, removed: total.removed, skipped: total.skipped };
    for (const entry of await tmpLeftovers(at)) {
      try {
        await safeFs().assertInside(tmpDir, entry.full);
        const { bytes } = await sizeOfEntry(entry);
        await fs.rm(entry.full, { recursive: true, force: true });
        result.freedBytes += bytes;
        result.removed += 1;
      } catch {
        result.skipped += 1;
      }
    }
    return result;
  }

  async function purgeBroadcastMedia(at) {
    const out = await broadcaster().purgeFinishedMedia({ now: at });
    return { freedBytes: out.freedBytes || 0, removed: out.removed || 0, skipped: out.skipped || 0 };
  }

  function purgeAntiDelete() {
    const dropped = antiDelete().clearCache();
    return { freedBytes: dropped.bytes, removed: dropped.entries, skipped: 0 };
  }

  const purgeBackups = (at) =>
    guarded(() => safeFs().purgeChildren(paths.backups, { skip: ["restore.lock"], now: at }));

  async function purgeLogs() {
    const out = await guarded(() => safeFs().truncateFiles(paths.logs, "*.log"));
    return { freedBytes: out.freedBytes || 0, removed: out.files || 0, skipped: out.skipped || 0 };
  }

  /**
   * Empty one category. The caller has asked the owner (`confirm: true` is also enforced here).
   * @throws {AdminError} not_found (unknown id), not_purgeable (database), confirmation_required, busy
   * @returns {Promise<{ freedBytes: number, removed: number, skipped: number }>}
   */
  async function purge(id, { confirm, actor, now: nowArg } = {}) {
    if (!CATEGORY_IDS.includes(id)) throw new AdminError("not_found", { params: { resource: "category" } });
    if (id === "database") throw new AdminError("not_purgeable");
    if (confirm !== true) throw new AdminError("confirmation_required", { params: { confirm: "purge" } });
    if (purging.has(id)) throw new AdminError("busy", { params: { type: "storage.purge" } });

    purging.add(id);
    try {
      const at = nowArg !== undefined ? nowArg : now();
      let result;
      if (id === "temp_media") result = await purgeTempMedia(at);
      else if (id === "broadcast_media") result = await purgeBroadcastMedia(at);
      else if (id === "antidelete_cache") result = purgeAntiDelete();
      else if (id === "panel_backups") result = await purgeBackups(at);
      else result = await purgeLogs();
      logger().info({ id, freedBytes: result.freedBytes, removed: result.removed, skipped: result.skipped, actor }, "storage purged");
      return { freedBytes: result.freedBytes, removed: result.removed, skipped: result.skipped };
    } finally {
      purging.delete(id);
      cache.delete(id); // the next list() measures again
    }
  }

  return {
    list,
    purge,
    CATEGORY_IDS,
    /** the constant locations, for tests */
    paths,
  };
}

module.exports = { createStorageService, CATEGORY_IDS, CACHE_MS, REFRESH_GAP_MS };
