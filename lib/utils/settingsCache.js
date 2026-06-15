const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Settings Cache Manager
 * Caches database settings to reduce query overhead
 */
class SettingsCache {
  constructor() {
    this.cache = new Map();
    this.ttl = 5 * 60 * 1000; // 5 minutes cache TTL
  }

  /**
   * Get cached settings or fetch from database
   * @param {string} key - Cache key (e.g., 'auto_responder', 'anti_delete')
   * @param {Function} fetchFn - Function to fetch from database if cache miss
   * @returns {Promise<any>} - Cached or fresh settings
   */
  async get(key, fetchFn) {
    const cached = this.cache.get(key);
    const now = Date.now();

    // Return cached value if still valid
    if (cached && now - cached.timestamp < this.ttl) {
      return cached.value;
    }

    // Fetch fresh value
    try {
      const value = await fetchFn();
      this.cache.set(key, {
        value,
        timestamp: now,
      });
      return value;
    } catch (error) {
      logger.error(`Error fetching settings for ${key}:`, error);
      // Return cached value even if expired, better than nothing
      return cached ? cached.value : null;
    }
  }

  /**
   * Invalidate cache for a specific key
   * @param {string} key - Cache key to invalidate
   */
  invalidate(key) {
    this.cache.delete(key);
    logger.debug(`Cache invalidated for ${key}`);
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
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
