"use strict";

/**
 * Login throttling (admin-http-api.md 1.12, data-model 4.5, research B6, FR-005).
 *
 *   const limits = createRateLimits({ now });
 *   limits.login      5 failures in 15 minutes per origin, then blocked for 15 minutes
 *   limits.token      the same thresholds, a SEPARATE bucket, for wrong setup / reset tokens
 *   limits.password   a separate bucket for a wrong current password on AUTH-5 (a stolen session must not be
 *                     able to guess the password faster than the login can)
 *   limits.clearAll() the reset flow lifts every lockout
 *
 * One limiter:
 *   check(key)    -> { blocked: false } | { blocked: true, retryAfterMs }     call it BEFORE any verification:
 *                    the right password is refused too while the block lasts
 *   fail(key)     -> { blocked, newlyBlocked, retryAfterMs }                  a blocked key is not extended
 *   success(key)  forget the key
 *   clearAll(), size(), rehydrate(rows)
 *
 * State is `Map<originKey, { fails: number[], blockedUntil }>` in memory: a restart only resets counters,
 * which never weakens a password. At most 10 000 entries, the oldest evicted first. `now` is a function
 * returning milliseconds (an injectable clock). `rehydrate` rebuilds counters from `login.failure` audit
 * rows ({ origin, at }) so a restart inside a block does not hand the attacker a fresh budget.
 */

const LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10000;

function createLimiter(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const limit = options.limit || LIMIT;
  const windowMs = options.windowMs || WINDOW_MS;
  const blockMs = options.blockMs || BLOCK_MS;
  const maxEntries = options.maxEntries || MAX_ENTRIES;

  /** @type {Map<string, { fails: number[], blockedUntil: number }>} */
  const entries = new Map();

  /** The live entry of `key` at time `at`: expired blocks and old failures are dropped first. */
  function current(key, at) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.blockedUntil && entry.blockedUntil <= at) {
      entries.delete(key);
      return null;
    }
    if (!entry.blockedUntil) {
      entry.fails = entry.fails.filter((time) => at - time < windowMs);
      if (!entry.fails.length) {
        entries.delete(key);
        return null;
      }
    }
    return entry;
  }

  function put(key, entry) {
    entries.delete(key); // re-inserted last: Map order is the eviction order
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  return {
    limit,
    windowMs,
    blockMs,

    check(key, at = now()) {
      const entry = current(String(key), at);
      if (entry && entry.blockedUntil > at) return { blocked: true, retryAfterMs: entry.blockedUntil - at };
      return { blocked: false };
    },

    fail(key, at = now()) {
      const id = String(key);
      const entry = current(id, at);
      if (entry && entry.blockedUntil > at) {
        // refused attempts never extend the block
        return { blocked: true, newlyBlocked: false, retryAfterMs: entry.blockedUntil - at };
      }
      const fails = entry ? entry.fails : [];
      fails.push(at);
      if (fails.length >= limit) {
        put(id, { fails: [], blockedUntil: at + blockMs });
        return { blocked: true, newlyBlocked: true, retryAfterMs: blockMs };
      }
      put(id, { fails, blockedUntil: 0 });
      return { blocked: false, newlyBlocked: false, failures: fails.length };
    },

    success(key) {
      entries.delete(String(key));
    },

    clearAll() {
      entries.clear();
    },

    size: () => entries.size,

    /**
     * Rebuild counters from past failures.
     * @param {Array<{ origin: string, at: number|Date }>} rows  oldest first or not, any order
     */
    rehydrate(rows, at = now()) {
      const byOrigin = new Map();
      for (const row of rows || []) {
        if (!row || !row.origin) continue;
        const time = row.at instanceof Date ? row.at.getTime() : Number(row.at);
        if (!Number.isFinite(time) || at - time >= windowMs || time > at) continue;
        if (!byOrigin.has(row.origin)) byOrigin.set(row.origin, []);
        byOrigin.get(row.origin).push(time);
      }
      let restored = 0;
      for (const [origin, times] of byOrigin) {
        times.sort((a, b) => a - b);
        if (times.length >= limit) {
          const blockedUntil = times[limit - 1] + blockMs;
          if (blockedUntil > at) {
            put(origin, { fails: [], blockedUntil });
            restored += 1;
          }
        } else {
          put(origin, { fails: times, blockedUntil: 0 });
          restored += 1;
        }
      }
      return restored;
    },
  };
}

/** The three buckets of the authentication module. */
function createRateLimits(options = {}) {
  const login = createLimiter(options);
  const token = createLimiter(options);
  const password = createLimiter(options);
  return {
    login,
    token,
    password,
    clearAll() {
      login.clearAll();
      token.clearAll();
      password.clearAll();
    },
  };
}

module.exports = { createLimiter, createRateLimits, LIMIT, WINDOW_MS, BLOCK_MS, MAX_ENTRIES };
