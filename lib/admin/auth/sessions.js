"use strict";

/**
 * Admin sessions and their cookies (data-model 1.2, admin-http-api.md 1.4 and 1.5, FR-006, research B4 and U11).
 *
 *   const sessions = createSessions({ models, now, timers, hub, logger });
 *   await sessions.create({ origin, userAgent })  -> { value, session }   `value` is the cookie value (shown once)
 *   await sessions.resolve(value)                 -> session | throws session_expired | db_unavailable
 *   sessions.touch(id)                            extends the idle clock (write-behind, one write per 60 s)
 *   await sessions.revoke(id, reason)             delete the row, close its live streams
 *   await sessions.destroyAll({ except, transaction })  -> [ids]; then sessions.forget(ids, reason) after the commit
 *   await sessions.sweep()                        delete the expired rows (also hourly once start() ran)
 *
 * What is stored: only the SHA-256 of the 32-byte cookie value (a copy of the database yields no usable
 * cookie) and a per-session CSRF secret. Idle expiry 24 h from `lastSeenAt`, absolute cap 7 days from
 * `createdAt`, at most 10 live sessions (the oldest is evicted). A hot in-process cache (60 s TTL) avoids one
 * read per request; with the database down a cached session keeps working and an uncached one gets
 * `db_unavailable` (503), never 401. `resolve` never extends the idle clock: only `touch` does, and the router
 * calls `touch` only for routes that do not declare `touch: false`.
 *
 * A session snapshot is `{ id, csrf, origin, userAgent, createdAt, lastSeenAt, idleExpiresAt,
 * absoluteExpiresAt }` (ms). `id` is the SHA-256 hex of the cookie value: the live-stream and upload quotas
 * are per `id`, and it is never sent to the client.
 *
 * Cookies: `__Host-owb_sid` over HTTPS and `owb_sid` over plain HTTP (both accepted on read, the `__Host-` one
 * wins), `Path=/; HttpOnly; SameSite=Strict` (+ `Secure` over HTTPS), `Max-Age = min(86400, remaining absolute
 * lifetime)`. The one-time setup cookie `owb_setup` lives under `/admin/api/setup`.
 */

const crypto = require("crypto");
const { Op } = require("sequelize");
const { AdminError, isDbDown } = require("../http/response");
const { withLock } = require("../../utils/mutex");

const IDLE_MS = 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const WRITE_BEHIND_MS = 60 * 1000;
const COOKIE_REFRESH_MS = 60 * 1000;
const COOKIE_MAX_AGE_SEC = 24 * 60 * 60;
const MAX_SESSIONS = 10;
const SWEEP_MS = 60 * 60 * 1000;
const MAX_CACHE = 200;

const COOKIE_SECURE = "__Host-owb_sid";
const COOKIE_PLAIN = "owb_sid";
const COOKIE_SETUP = "owb_setup";
const SETUP_COOKIE_PATH = "/admin/api/setup";
/** 32 random bytes in base64url. */
const VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sha256Hex = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** `Cookie` header -> Map (first occurrence of a name wins; values are not decoded). */
function parseCookies(header) {
  const jar = new Map();
  if (!header) return jar;
  for (const part of String(Array.isArray(header) ? header.join(";") : header).split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name && !jar.has(name)) jar.set(name, value);
  }
  return jar;
}

/** The session cookie value of a request, or null. The `__Host-` cookie wins over the plain one. */
function readSessionCookie(req) {
  const jar = parseCookies(req && req.headers && req.headers.cookie);
  return jar.get(COOKIE_SECURE) || jar.get(COOKIE_PLAIN) || null;
}

/** The one-time setup cookie of a request, or null. */
function readSetupCookie(req) {
  return parseCookies(req && req.headers && req.headers.cookie).get(COOKIE_SETUP) || null;
}

function serializeCookie(name, value, { path = "/", https = false, maxAgeSec } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, "HttpOnly", "SameSite=Strict"];
  if (https) parts.push("Secure");
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  return parts.join("; ");
}

/** `Set-Cookie` line of the session cookie (the name follows the scheme). */
function sessionCookie(value, { https, maxAgeSec = COOKIE_MAX_AGE_SEC } = {}) {
  return serializeCookie(https ? COOKIE_SECURE : COOKIE_PLAIN, value, { https, maxAgeSec });
}

/** `Set-Cookie` lines that clear the session cookie (both names over HTTPS: a stale plain one may linger). */
function clearSessionCookies({ https } = {}) {
  const lines = [serializeCookie(COOKIE_PLAIN, "", { maxAgeSec: 0 })];
  if (https) lines.unshift(serializeCookie(COOKIE_SECURE, "", { https: true, maxAgeSec: 0 }));
  return lines;
}

function setupCookie(value, { https, maxAgeSec }) {
  return serializeCookie(COOKIE_SETUP, value, { path: SETUP_COOKIE_PATH, https, maxAgeSec });
}

function clearSetupCookie({ https } = {}) {
  return serializeCookie(COOKIE_SETUP, "", { path: SETUP_COOKIE_PATH, https, maxAgeSec: 0 });
}

const cookies = Object.freeze({
  parseCookies,
  readSessionCookie,
  readSetupCookie,
  sessionCookie,
  clearSessionCookies,
  setupCookie,
  clearSetupCookie,
  names: Object.freeze({ secure: COOKIE_SECURE, plain: COOKIE_PLAIN, setup: COOKIE_SETUP }),
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {object} [options.models]      the database module (default: required lazily)
 * @param {() => number} [options.now]
 * @param {object} [options.timers]      { setInterval, clearInterval } (default: global)
 * @param {object} [options.hub]         lib/admin/events.js hub (`publish("session", ...)`)
 * @param {object} [options.logger]
 */
function createSessions(options = {}) {
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  const timers = options.timers || { setInterval, clearInterval };
  const hub = options.hub || null;
  const logger = options.logger || null;
  const modelsOf = () => options.models || require("../../database");

  /** @type {Map<string, object>} idHash -> cache entry */
  const cache = new Map();
  let sweepTimer = null;

  const warn = (err, message) => {
    if (logger && logger.warn) logger.warn({ name: err && err.name, code: err && err.code }, message);
  };

  const snapshot = (entry) => ({
    id: entry.idHash,
    csrf: entry.csrf,
    origin: entry.origin,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt,
    lastSeenAt: entry.lastSeenAt,
    idleExpiresAt: entry.lastSeenAt + IDLE_MS,
    absoluteExpiresAt: entry.createdAt + ABSOLUTE_MS,
  });

  const isExpired = (entry, at) => at >= entry.lastSeenAt + IDLE_MS || at >= entry.createdAt + ABSOLUTE_MS;

  function publish(ids, reason) {
    if (!hub || typeof hub.publish !== "function") return;
    for (const sessionId of ids) {
      try {
        hub.publish("session", { sessionId, reason });
      } catch {
        // a subscriber never breaks an auth operation
      }
    }
  }

  function trimCache(at) {
    if (cache.size <= MAX_CACHE) return;
    for (const [id, entry] of cache) {
      if (isExpired(entry, at)) cache.delete(id);
    }
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }

  function entryFromRow(row, previous) {
    const lastSeenAt = new Date(row.lastSeenAt).getTime();
    return {
      idHash: row.idHash,
      csrf: row.csrfSecret,
      origin: row.origin,
      userAgent: row.userAgent || null,
      createdAt: new Date(row.createdAt).getTime(),
      // memory may be ahead of the row (write-behind)
      lastSeenAt: previous ? Math.max(previous.lastSeenAt, lastSeenAt) : lastSeenAt,
      writtenAt: previous ? previous.writtenAt : lastSeenAt,
      cookieSetAt: previous ? previous.cookieSetAt : 0,
      dirty: previous ? previous.dirty : false,
      loadedAt: 0,
    };
  }

  async function persist(entry, at) {
    const { AdminSession } = modelsOf();
    try {
      await AdminSession.update({ lastSeenAt: new Date(at) }, { where: { idHash: entry.idHash } });
    } catch (err) {
      entry.dirty = true;
      warn(err, "admin: a session activity write failed");
    }
  }

  async function dropExpired(entry) {
    cache.delete(entry.idHash);
    try {
      const { AdminSession } = modelsOf();
      await AdminSession.destroy({ where: { idHash: entry.idHash } });
    } catch (err) {
      warn(err, "admin: an expired session could not be deleted");
    }
    publish([entry.idHash], "expired");
  }

  /** Delete the rows past their idle or absolute limit. */
  async function sweep() {
    const at = clock();
    const { AdminSession } = modelsOf();
    const removed = await AdminSession.destroy({
      where: {
        [Op.or]: [{ lastSeenAt: { [Op.lt]: new Date(at - IDLE_MS) } }, { createdAt: { [Op.lt]: new Date(at - ABSOLUTE_MS) } }],
      },
    });
    for (const [id, entry] of cache) {
      if (isExpired(entry, at)) cache.delete(id);
    }
    return removed;
  }

  /** Keep at most MAX_SESSIONS rows: the oldest (never `keep`) go first. */
  async function evictOverflow(keep) {
    const { AdminSession } = modelsOf();
    await sweep();
    const rows = await AdminSession.findAll({
      attributes: ["idHash", "createdAt"],
      order: [
        ["createdAt", "ASC"],
        ["lastSeenAt", "ASC"],
      ],
    });
    const overflow = rows.length - MAX_SESSIONS;
    if (overflow <= 0) return [];
    const victims = rows.filter((row) => row.idHash !== keep).slice(0, overflow).map((row) => row.idHash);
    if (!victims.length) return [];
    await AdminSession.destroy({ where: { idHash: { [Op.in]: victims } } });
    forget(victims, "revoked");
    return victims;
  }

  /** Drop sessions from the cache and close their live streams (after the rows are gone). */
  function forget(ids, reason = "revoked") {
    for (const id of ids) cache.delete(id);
    publish(ids, reason);
  }

  return {
    cookies,
    limits: Object.freeze({ IDLE_MS, ABSOLUTE_MS, CACHE_TTL_MS, WRITE_BEHIND_MS, MAX_SESSIONS }),

    /** The session id (SHA-256 hex) behind a cookie value, and whether a value has the right shape. */
    idOf: sha256Hex,
    isValidValue: (value) => typeof value === "string" && VALUE_PATTERN.test(value),

    /** Open a session: a fresh cookie value (rotation: every login, setup and password change). */
    create({ origin, userAgent } = {}) {
      return withLock("admin-sessions", async () => {
        const { AdminSession } = modelsOf();
        const at = clock();
        const value = crypto.randomBytes(32).toString("base64url");
        const idHash = sha256Hex(value);
        const csrf = crypto.randomBytes(32).toString("base64url");
        const ua = userAgent ? String(userAgent).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : null;
        await AdminSession.create({
          idHash,
          csrfSecret: csrf,
          origin: String(origin || "unknown").slice(0, 64),
          userAgent: ua,
          lastSeenAt: new Date(at),
          createdAt: new Date(at),
        });
        const entry = {
          idHash,
          csrf,
          origin: String(origin || "unknown").slice(0, 64),
          userAgent: ua,
          createdAt: at,
          lastSeenAt: at,
          writtenAt: at,
          cookieSetAt: at,
          dirty: false,
          loadedAt: at,
        };
        cache.set(idHash, entry);
        trimCache(at);
        await evictOverflow(idHash);
        return { value, session: snapshot(entry) };
      });
    },

    /**
     * The live session behind a cookie value. Never extends the idle clock.
     * @throws {AdminError} session_expired (unknown, idle-expired, absolute-expired, revoked) | db_unavailable
     */
    async resolve(value) {
      if (typeof value !== "string" || !VALUE_PATTERN.test(value)) throw new AdminError("session_expired");
      const idHash = sha256Hex(value);
      const at = clock();
      let entry = cache.get(idHash);

      if (!entry || at - entry.loadedAt >= CACHE_TTL_MS) {
        let row = null;
        let dbFailed = false;
        try {
          const { AdminSession } = modelsOf();
          row = await AdminSession.findByPk(idHash);
        } catch (err) {
          if (!isDbDown(err)) throw err;
          dbFailed = true;
        }
        if (dbFailed) {
          // cached sessions keep working, uncached ones are a 503 (never a 401: the SPA must not drop to login)
          if (!entry) throw new AdminError("db_unavailable");
        } else if (!row) {
          cache.delete(idHash);
          throw new AdminError("session_expired");
        } else {
          entry = entryFromRow(row, entry);
          entry.loadedAt = at;
          cache.set(idHash, entry);
          trimCache(at);
        }
      }

      if (isExpired(entry, at)) {
        await dropExpired(entry);
        throw new AdminError("session_expired");
      }
      return snapshot(entry);
    },

    /** Extend the idle clock of a session (the router calls it for `touch` routes only). */
    touch(id) {
      const entry = cache.get(String(id));
      if (!entry) return;
      const at = clock();
      if (at > entry.lastSeenAt) entry.lastSeenAt = at;
      if (at - entry.writtenAt >= WRITE_BEHIND_MS) {
        entry.writtenAt = at;
        entry.dirty = false;
        persist(entry, at);
      } else {
        entry.dirty = true;
      }
    },

    /** The session cookie is due for a new Max-Age (at most once per 60 s per session). */
    cookieDue(id) {
      const entry = cache.get(String(id));
      return Boolean(entry) && clock() - entry.cookieSetAt >= COOKIE_REFRESH_MS;
    },

    markCookie(id) {
      const entry = cache.get(String(id));
      if (entry) entry.cookieSetAt = clock();
    },

    /** Max-Age of the session cookie: min(24 h, remaining absolute lifetime), at least 1 s. */
    cookieMaxAge(session) {
      return Math.max(1, Math.min(COOKIE_MAX_AGE_SEC, Math.floor((session.absoluteExpiresAt - clock()) / 1000)));
    },

    /** Delete one session (logout, rotation) and close its live streams. */
    async revoke(id, reason = "logout") {
      const { AdminSession } = modelsOf();
      await AdminSession.destroy({ where: { idHash: String(id) } });
      forget([String(id)], reason);
    },

    /**
     * Delete every session except `except`. Pass `transaction` to do it inside the caller's transaction, then
     * call `forget(ids, reason)` once it has committed.
     * @returns {Promise<string[]>} the ids that were deleted
     */
    async destroyAll({ except, transaction } = {}) {
      const { AdminSession } = modelsOf();
      const where = except ? { idHash: { [Op.ne]: String(except) } } : {};
      const rows = await AdminSession.findAll({ attributes: ["idHash"], where, transaction });
      const ids = rows.map((row) => row.idHash);
      if (ids.length) await AdminSession.destroy({ where: { idHash: { [Op.in]: ids } }, transaction });
      return ids;
    },

    forget,
    sweep,

    /** Live rows (tests, diagnostics). */
    async count() {
      const { AdminSession } = modelsOf();
      return AdminSession.count();
    },

    /** Cache size (tests). */
    cacheSize: () => cache.size,

    /** Forget the whole cache (the next request re-reads the database). */
    clearCache: () => cache.clear(),

    /** Hourly sweep of expired rows; idempotent, the timer is unref()'d. */
    start() {
      if (sweepTimer) return;
      sweepTimer = timers.setInterval(() => {
        sweep().catch((err) => warn(err, "admin: the session sweep failed"));
      }, SWEEP_MS);
      if (sweepTimer && typeof sweepTimer.unref === "function") sweepTimer.unref();
    },

    /** Stop the sweep and write the pending activity times. */
    async stop() {
      if (sweepTimer) {
        timers.clearInterval(sweepTimer);
        sweepTimer = null;
      }
      const pending = [];
      for (const entry of cache.values()) {
        if (entry.dirty) {
          entry.dirty = false;
          entry.writtenAt = entry.lastSeenAt;
          pending.push(persist(entry, entry.lastSeenAt));
        }
      }
      await Promise.allSettled(pending);
    },
  };
}

module.exports = {
  createSessions,
  cookies,
  parseCookies,
  readSessionCookie,
  readSetupCookie,
  sessionCookie,
  clearSessionCookies,
  setupCookie,
  clearSetupCookie,
  sha256Hex,
  VALUE_PATTERN,
  IDLE_MS,
  ABSOLUTE_MS,
  CACHE_TTL_MS,
  WRITE_BEHIND_MS,
  MAX_SESSIONS,
  COOKIE_SECURE,
  COOKIE_PLAIN,
  COOKIE_SETUP,
};
