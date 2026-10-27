const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Settings Cache Manager
 * Caches database settings to reduce query overhead.
 *
 * Keys in use (see specs/001-audit-fix-commands/data-model.md):
 * `view_once`, `anti_delete`, `auto_responder`, `banned_chats`, `sticker_cmds`,
 * `afk_users`, `filters:<groupJid>`, `group:<groupJid>`, `roles:<groupJid>`.
 * Every setter that writes one of these settings must call `invalidate(key)`.
 */
class SettingsCache {
  constructor() {
    this.cache = new Map(); // key -> { value, timestamp, ttl }
    this.inflight = new Map(); // key -> Promise of a running load
    this.generations = new Map(); // key -> number, bumped by invalidate()
    this.ttl = 5 * 60 * 1000; // 5 minutes cache TTL
  }

  _isFresh(entry, now = Date.now()) {
    if (!entry) return false;
    const ttl = entry.ttl ?? this.ttl;
    return now - entry.timestamp < ttl;
  }

  /**
   * Get cached settings or fetch from database
   * @param {string} key - Cache key (e.g., 'auto_responder', 'anti_delete')
   * @param {Function} fetchFn - Function to fetch from database if cache miss
   * @returns {Promise<any>} - Cached or fresh settings
   */
  async get(key, fetchFn) {
    return this.getOrLoad(key, fetchFn);
  }

  /**
   * Same as `get`, with a per-key TTL. Concurrent misses for the same key share
   * one load. On a load error the expired value (or null) is returned.
   * @param {string} key
   * @param {Function} loader - async () => value
   * @param {number} [ttlMs] - defaults to the global TTL (5 minutes)
   * @returns {Promise<any>}
   */
  async getOrLoad(key, loader, ttlMs) {
    const cached = this.cache.get(key);
    if (this._isFresh(cached)) return cached.value;

    if (this.inflight.has(key)) return this.inflight.get(key);

    const generation = this.generations.get(key) || 0;
    const load = (async () => {
      try {
        const value = await loader();
        // Do not store a value loaded before an invalidate() for this key
        if ((this.generations.get(key) || 0) === generation) {
          this.cache.set(key, {
            value,
            timestamp: Date.now(),
            ttl: ttlMs ?? cached?.ttl,
          });
        }
        return value;
      } catch (error) {
        logger.error(
          { err: error },
          `Error fetching settings for ${key}: ${error?.message}`,
        );
        // Return cached value even if expired, better than nothing
        return cached ? cached.value : null;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, load);
    return load;
  }

  /**
   * Store a value directly
   * @param {string} key
   * @param {any} value
   * @param {number} [ttlMs]
   */
  set(key, value, ttlMs) {
    this.cache.set(key, { value, timestamp: Date.now(), ttl: ttlMs });
  }

  /**
   * Invalidate cache for a specific key
   * @param {string} key - Cache key to invalidate
   */
  invalidate(key) {
    this.cache.delete(key);
    this.inflight.delete(key);
    this.generations.set(key, (this.generations.get(key) || 0) + 1);
    logger.debug(`Cache invalidated for ${key}`);
  }

  /**
   * Invalidate every key starting with `prefix` (e.g. "filters:")
   * @param {string} prefix
   */
  invalidatePrefix(prefix) {
    const keys = new Set([...this.cache.keys(), ...this.inflight.keys()]);
    for (const key of keys) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    for (const key of this.inflight.keys()) {
      this.generations.set(key, (this.generations.get(key) || 0) + 1);
    }
    for (const key of this.cache.keys()) {
      this.generations.set(key, (this.generations.get(key) || 0) + 1);
    }
    this.cache.clear();
    this.inflight.clear();
    logger.debug("All cache cleared");
  }

  /**
   * Set cache TTL
   * @param {number} ttl - Time to live in milliseconds
   */
  setTTL(ttl) {
    this.ttl = ttl;
  }
}

module.exports = new SettingsCache();
