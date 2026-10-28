"use strict";

/**
 * State service of the dashboard (US2, FR-012, FR-013; admin-http-api.md 2.3 and 3.3).
 *
 *   const state = getStateService(deps);      one instance per `deps` object (created by whichever area asks first)
 *   await state.build()                        the DASH-1 object, which is also the SSE `state` payload
 *   state.addBannerProvider(fn) -> remove      other areas add banners (see below)
 *   state.noteProxyHeaders(names)             remembers the forwarded headers a request carried from an undeclared peer
 *   state.runRestart(handle)                   body of the `restart` job of RST-1
 *   state.install() / attach() / detach()      hub snapshot; runtime and settings listeners (start / stop hooks)
 *
 * `createStateService(deps)` does no I/O and starts no timer; every collaborator is looked up when it is used and
 * can be injected: runtime (BotRuntime), hub, jobs, ring, redactor, settingsStore, secretBox, maintenanceMode,
 * updater (optional: `restartRequired() -> { required, from, to }`), models (database), config,
 * clock, logger, memoryUsage, dbProbe (`async () => boolean`, replaces the database ping).
 *
 * DASH-1 is
 *   { at, bot: { status, number, since, uptimeSec, version, messagesProcessed, lastActivity, registered },
 *     memory: { rss, heapUsed, heapTotal, external }, errors: [{ seq, ts, name, msg }], restartPending: [key],
 *     banners: [{ id, severity, params }], db: "ok" | "unavailable", maintenance: boolean, job | null }
 * built field by field: nothing of the runtime status is copied wholesale, so the QR string and the pairing code
 * (which the client keeps out of its state anyway) can never reach the browser through here.
 *
 * BANNERS (3.3). Computed on every build from their sources, in the order of the contract table: restart_needed
 * (settingsStore.pendingRestart), update_restart (updater.restartRequired), undeclared_proxy (forwarded headers
 * seen from an undeclared peer in the last ten minutes), secret_key_lost (stored secrets that cannot be
 * decrypted, or a key file that is not a key), db_unavailable, no_owner (SUDO empty), maintenance,
 * logged_out, invalid_file_values (settingsStore.problems). `no_https` is the browser's. The result is ordered
 * errors, warnings, information.
 *
 * HOW ANOTHER AREA ADDS A BANNER (W-BAK `restore_interrupted`, W-MNT `update_restart`...): from its own route
 * module, in `register()` or in an `onStart` hook,
 *     const state = require("../services/state").getStateService(deps);   // or deps.state once it exists
 *     const remove = state.addBannerProvider(() => ({ id, severity: "error", params: {} }));
 * The provider returns a banner, an array of banners, or nothing; it may be async. A provider that throws is
 * ignored, a banner without a valid `id` / `severity` is dropped, the first banner of an id wins.
 */

const { createLogger } = require("../../utils/logger");

const CLIENT_STATUSES = ["idle", "connecting", "qr", "open", "reconnecting", "stopped", "logged_out"];
const SEVERITIES = ["error", "warn", "info"];
const PROXY_SIGHTING_TTL_MS = 10 * 60 * 1000;
const DB_CACHE_MS = 5 * 1000;
const DB_TIMEOUT_MS = 2 * 1000;
const ERRORS_SHOWN = 10;
const RESTART_PHASES = ["stop", "settings", "start", "ready"];
const BANNER_ID = /^[a-z][a-z0-9_]{0,47}$/;

/** `require(request)` that tolerates only the absence of that exact module (a later batch delivers it). */
function optionalRequire(request) {
  try {
    return require(request);
  } catch (err) {
    const missing = err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes(`'${request}'`);
    if (!missing) throw err;
    return null;
  }
}

function attempt(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** An ISO string, a Date or a millisecond timestamp -> ISO string, or null. */
const isoOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = value instanceof Date ? value.getTime() : typeof value === "string" && Number.isNaN(Number(value)) ? Date.parse(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

const count = (n) => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Math.trunc(Number(n)) : 0);

/** The user part of a number or JID, digits only ("237600000001@s.whatsapp.net" -> "237600000001"). */
function digitsOf(value) {
  if (value === undefined || value === null) return null;
  const digits = String(value).split("@")[0].split(":")[0].replace(/\D/g, "");
  return digits || null;
}

/** QR art and the "QR available" line never reach a log view (consoleCapture keeps them out of the ring too). */
const isQrLine = (text) => /[▀▄█]{8,}/.test(text) || text.includes("QR available");

/**
 * A ring entry as the panel shows it: `{ seq, ts, level, name, msg }` with the message scrubbed once more (a secret
 * registered after the entry was logged is caught here), or null for a QR line.
 */
function cleanLogEntry(entry, redactor) {
  if (!entry || typeof entry !== "object") return null;
  let msg = entry.msg === undefined || entry.msg === null ? "" : String(entry.msg);
  if (isQrLine(msg)) return null;
  if (redactor && typeof redactor.scrub === "function") msg = redactor.scrub(msg);
  return { seq: entry.seq, ts: entry.ts, level: entry.level, name: entry.name === undefined || entry.name === null ? "" : String(entry.name), msg };
}

/** A banner as the contract defines it, or null. */
function normalizeBanner(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !BANNER_ID.test(raw.id)) return null;
  if (!SEVERITIES.includes(raw.severity)) return null;
  const params = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params) ? { ...raw.params } : {};
  return { id: raw.id, severity: raw.severity, params };
}

function restartFailed(reason) {
  const err = new Error("restart failed");
  err.code = "restart_failed";
  err.params = { reason };
  return err;
}

function createStateService(deps = {}) {
  const logger = () => deps.logger || createLogger("admin");
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());

  // ----- collaborators, looked up when used ----------------------------------------------------------
  const runtime = () => deps.runtime || null;
  const getRing = () => deps.ring || require("../logs/ring");
  const getRedactor = () => deps.redactor || require("../logs/redactor");
  const getStore = () => (deps.settingsStore !== undefined ? deps.settingsStore : optionalRequire("../../utils/settingsStore"));
  const getBox = () => (deps.secretBox !== undefined ? deps.secretBox : optionalRequire("../../utils/secretBox"));
  const getMaintenance = () => deps.maintenanceMode || require("../../utils/maintenanceMode");
  const getUpdater = () => (deps.updater !== undefined ? deps.updater : optionalRequire("../../utils/updater"));
  const getConfig = () => deps.config || {};

  const providers = new Set();
  let proxySighting = null; // { at, headers: Set<string> }
  let dbCache = { at: -Infinity, ok: true };
  let detach = null; // set while attached
  let lastKey = null;
  let lastPending = null;

  // ----- sources of the DASH-1 object -----------------------------------------------------------------

  function readStatus() {
    const rt = runtime();
    return rt && typeof rt.getStatus === "function" ? attempt(() => rt.getStatus(), {}) || {} : {};
  }

  function memoryOf() {
    const raw = (deps.memoryUsage ? attempt(() => deps.memoryUsage(), null) : process.memoryUsage()) || {};
    return { rss: count(raw.rss), heapUsed: count(raw.heapUsed), heapTotal: count(raw.heapTotal), external: count(raw.external) };
  }

  function errorsOf() {
    const ring = attempt(getRing, null);
    if (!ring || typeof ring.lastErrors !== "function") return [];
    const redactor = attempt(getRedactor, null);
    const out = [];
    for (const entry of attempt(() => ring.lastErrors(ERRORS_SHOWN * 2), []) || []) {
      const clean = cleanLogEntry(entry, redactor);
      if (clean) out.push({ seq: clean.seq, ts: clean.ts, name: clean.name, msg: clean.msg });
      if (out.length === ERRORS_SHOWN) break;
    }
    return out;
  }

  function pendingKeysOf(status) {
    const store = attempt(getStore, null);
    if (store && typeof store.pendingRestart === "function") {
      const keys = attempt(() => store.pendingRestart(), null);
      if (Array.isArray(keys)) return keys.slice();
    }
    return Array.isArray(status.pendingRestart) ? status.pendingRestart.slice() : [];
  }

  function jobOf() {
    const jobs = deps.jobs;
    const job = jobs && typeof jobs.current === "function" ? attempt(() => jobs.current(), null) : null;
    return job ? { id: job.id, type: job.type, status: job.status, phase: job.phase } : null;
  }

  /** The database answers: `runtime.dbReady`, then a cached ping (or the injected probe). */
  async function databaseOk() {
    const rt = runtime();
    if (rt && rt.dbReady === false) return false;
    if (typeof deps.dbProbe === "function") {
      try {
        return Boolean(await deps.dbProbe());
      } catch {
        return false;
      }
    }
    const at = now();
    if (at - dbCache.at < DB_CACHE_MS) return dbCache.ok;
    let ok = true;
    try {
      const models = deps.models || require("../../database");
      if (models && models.DATABASE && typeof models.DATABASE.authenticate === "function") {
        await require("../../utils/http").withTimeout(() => models.DATABASE.authenticate(), DB_TIMEOUT_MS, "database probe");
      }
    } catch {
      ok = false;
    }
    dbCache = { at, ok };
    return ok;
  }

  function ownersConfigured() {
    const config = getConfig();
    const value = config.SUDO !== undefined ? config.SUDO : attempt(() => require("../../../config").SUDO, "");
    const list = Array.isArray(value) ? value : String(value === undefined || value === null ? "" : value).split(",");
    return list.some((item) => String(item).trim() !== "");
  }

  // ----- banners --------------------------------------------------------------------------------------

  function proxyBanner() {
    if (!proxySighting) return null;
    if (now() - proxySighting.at > PROXY_SIGHTING_TTL_MS) {
      proxySighting = null;
      return null;
    }
    return { id: "undeclared_proxy", severity: "warn", params: { headers: [...proxySighting.headers].sort() } };
  }

  /** Banners that depend on nothing asynchronous, in the order of the contract table. */
  function localBanners({ status, pending, db, maintenanceActive }) {
    const out = [];
    if (pending.length) out.push({ id: "restart_needed", severity: "info", params: { keys: pending } });

    const updater = attempt(getUpdater, null);
    const verdict = updater && typeof updater.restartRequired === "function" ? attempt(() => updater.restartRequired(), null) : null;
    if (verdict && verdict.required === true) {
      out.push({ id: "update_restart", severity: "warn", params: { from: verdict.from ?? null, to: verdict.to ?? null } });
    }

    const proxy = proxyBanner();
    if (proxy) out.push(proxy);

    const store = attempt(getStore, null);
    const problems = store && typeof store.problems === "function" ? attempt(() => store.problems(), {}) || {} : {};
    const withCode = (code) =>
      Object.keys(problems)
        .filter((key) => problems[key] && problems[key].code === code)
        .sort();
    const box = attempt(getBox, null);
    const keyFile = box && typeof box.status === "function" ? attempt(() => box.status(), null) : null;
    const lostKeys = withCode("reenter");
    if (lostKeys.length || (keyFile && keyFile.keyPresent && !keyFile.keyValid)) {
      out.push({ id: "secret_key_lost", severity: "error", params: { keys: lostKeys } });
    }

    if (db === "unavailable") out.push({ id: "db_unavailable", severity: "error", params: {} });
    if (!ownersConfigured()) out.push({ id: "no_owner", severity: "warn", params: {} });

    if (maintenanceActive) {
      const job = jobOf();
      const maintenance = attempt(getMaintenance, null);
      const reason = maintenance && typeof maintenance.getReason === "function" ? attempt(() => maintenance.getReason(), null) : null;
      const phase = job && job.type === "restore" && job.phase ? job.phase : reason || "maintenance";
      out.push({ id: "maintenance", severity: "info", params: { phase } });
    }

    if (status.status === "logged_out") out.push({ id: "logged_out", severity: "warn", params: {} });

    const invalid = withCode("invalid_file_value");
    if (invalid.length) out.push({ id: "invalid_file_values", severity: "warn", params: { keys: invalid } });
    return out;
  }

  async function providerBanners() {
    const out = [];
    for (const provider of [...providers]) {
      try {
        const result = await provider();
        for (const raw of Array.isArray(result) ? result : [result]) {
          const banner = normalizeBanner(raw);
          if (banner) out.push(banner);
        }
      } catch {
        // a broken provider never breaks the state
      }
    }
    return out;
  }

  function arrange(list) {
    const seen = new Set();
    const unique = [];
    for (const banner of list) {
      if (seen.has(banner.id)) continue;
      seen.add(banner.id);
      unique.push(banner);
    }
    const rank = (banner) => SEVERITIES.indexOf(banner.severity);
    return unique.map((banner, index) => ({ banner, index })).sort((a, b) => rank(a.banner) - rank(b.banner) || a.index - b.index).map((x) => x.banner);
  }

  // ----- the object ------------------------------------------------------------------------------------

  async function build() {
    // everything that must show "now" is read before the first await
    const at = now();
    const status = readStatus();
    const rt = runtime();
    const pending = pendingKeysOf(status);
    const maintenanceActive = Boolean(attempt(() => getMaintenance().isActive(), false));
    const clientStatus = status.restarting ? "restarting" : CLIENT_STATUSES.includes(status.status) ? status.status : "idle";
    const bot = {
      status: clientStatus,
      number: digitsOf(status.me && status.me.number),
      since: isoOrNull(status.since),
      uptimeSec: Math.floor(count(status.uptimeMs) / 1000),
      version: status.version ?? attempt(() => require("../../../config").VERSION, null) ?? null,
      messagesProcessed: count(status.messagesProcessed),
      lastActivity: rt && rt.state ? isoOrNull(rt.state.lastActivity) : null,
      registered: Boolean(status.registered),
    };
    const memory = memoryOf();
    const errors = errorsOf();
    const job = jobOf();
    const local = (db) => localBanners({ status, pending, db, maintenanceActive });

    const db = (await databaseOk()) ? "ok" : "unavailable";
    const extra = await providerBanners();
    return {
      at: new Date(at).toISOString(),
      bot,
      memory,
      errors,
      restartPending: pending,
      banners: arrange([...local(db), ...extra]),
      db,
      maintenance: maintenanceActive,
      job,
    };
  }

  // ----- live updates -----------------------------------------------------------------------------------

  function publish(force) {
    const hub = deps.hub;
    if (!hub || typeof hub.publishState !== "function") return;
    try {
      Promise.resolve(hub.publishState({ force })).catch(() => {});
    } catch {
      // publishing never breaks the producer
    }
  }

  /** Hub snapshot of the `state` topic: a new stream starts from the current object, the 2 s ticker republishes it. */
  function install() {
    if (deps.hub && typeof deps.hub.setSnapshot === "function") deps.hub.setSnapshot("state", build);
  }

  /** Follow the runtime and the settings; idempotent. Forced events: ready, close, qr, restart phases, restartPending. */
  function attach() {
    if (detach) return;
    const offs = [];
    lastKey = null;

    const rt = runtime();
    if (rt && rt.events && typeof rt.events.on === "function") {
      const onState = (snapshot) => {
        const s = snapshot || {};
        const key = [s.status, s.restarting ? 1 : 0, s.qrVersion ?? 0, s.registered ? 1 : 0].join("|");
        const changed = key !== lastKey;
        lastKey = key;
        publish(changed);
      };
      rt.events.on("state", onState);
      offs.push(() => rt.events.off("state", onState));
    }

    const store = attempt(getStore, null);
    if (store && typeof store.onChange === "function") {
      lastPending = JSON.stringify(pendingKeysOf({}));
      const off = store.onChange(null, () => {
        const next = JSON.stringify(pendingKeysOf({}));
        const changed = next !== lastPending;
        lastPending = next;
        publish(changed);
      });
      if (typeof off === "function") offs.push(off);
    }

    detach = () => {
      for (const off of offs) attempt(off);
    };
  }

  function release() {
    if (!detach) return;
    const off = detach;
    detach = null;
    off();
  }

  // ----- restart (RST-1) ----------------------------------------------------------------------------------

  /**
   * Body of the `restart` job: runtime.restartBot() with the phases stop, settings, start, ready. The runtime
   * reports no phase itself, so they follow its `state` events (the client stopping, then connecting again) and
   * `ready` is set when it has answered. Throws `restart_failed` (params.reason: busy, timeout, failed...).
   */
  async function runRestart(handle) {
    const rt = runtime();
    if (!rt || typeof rt.restartBot !== "function") throw restartFailed("unavailable");
    let reached = 0;
    const advance = (phase) => {
      const index = RESTART_PHASES.indexOf(phase);
      if (index <= reached) return;
      reached = index;
      handle.setPhase(phase);
    };
    handle.setPhase("stop");
    const onState = (snapshot) => {
      if (!snapshot) return;
      if (snapshot.status === "stopped") advance("settings");
      else if (snapshot.status === "connecting" && reached >= 1) advance("start");
    };
    const events = rt.events && typeof rt.events.on === "function" ? rt.events : null;
    if (events) events.on("state", onState);
    let result;
    try {
      result = await rt.restartBot({ actor: "panel" });
    } catch (err) {
      logger().error({ name: err && err.name, code: err && err.code }, "admin: the restart threw");
      throw restartFailed("failed");
    } finally {
      if (events) events.off("state", onState);
    }
    if (!result || result.ok !== true) throw restartFailed((result && typeof result.code === "string" && result.code) || "failed");
    advance("ready");
    return { ok: true };
  }

  return {
    build,
    install,
    attach,
    detach: release,
    attached: () => detach !== null,
    runRestart,

    /** Add a banner source (see the header). Returns the function that removes it. */
    addBannerProvider(fn) {
      if (typeof fn !== "function") throw new TypeError("addBannerProvider needs a function");
      providers.add(fn);
      return () => providers.delete(fn);
    },

    /**
     * Remember the names of forwarded headers (`trustProxy.proxyHint(req)`: the route asks) that arrived from a peer
     * PANEL_TRUST_PROXY does not declare. The sighting lasts ten minutes, so the `undeclared_proxy` banner also
     * reaches the live stream, which has no request of its own.
     */
    noteProxyHeaders(names) {
      if (!Array.isArray(names) || !names.length) return;
      const at = now();
      if (!proxySighting || at - proxySighting.at > PROXY_SIGHTING_TTL_MS) proxySighting = { at, headers: new Set() };
      proxySighting.at = at;
      for (const name of names) proxySighting.headers.add(String(name));
    },
  };
}

const services = new WeakMap();

/**
 * The one state service of a `deps` object (the object createAdmin hands to every route module). Any area may
 * call it first; the service is also stored as `deps.state`.
 */
function getStateService(deps) {
  let service = services.get(deps);
  if (!service) {
    service = createStateService(deps);
    services.set(deps, service);
    if (deps.state === undefined) deps.state = service;
  }
  return service;
}

module.exports = {
  createStateService,
  getStateService,
  cleanLogEntry,
  isQrLine,
  normalizeBanner,
  digitsOf,
  RESTART_PHASES,
  PROXY_SIGHTING_TTL_MS,
};
