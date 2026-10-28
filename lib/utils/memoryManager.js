const config = require("../../config");

const logger = require("./logger").createLogger("memoryManager");

/**
 * Memory Management Utility
 * Helps reduce memory footprint and prevent leaks
 */
class MemoryManager {
  constructor() {
    this.startPeriodicCleanup();
  }

  /** Cleanup period (ms): read from config when the timer is armed, see reconfigure() */
  get cleanupInterval() {
    return config.MEMORY_CLEANUP_INTERVAL;
  }

  /** Heap size (MB) above which a warning is logged: live, follows config */
  get memoryWarnThreshold() {
    return config.MEMORY_WARN_THRESHOLD;
  }

  /**
   * Re-arm the cleanup timer from the current config (MEMORY_CLEANUP_INTERVAL changed and the bot
   * restarted in process). Exactly one timer exists afterwards.
   */
  reconfigure() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.startPeriodicCleanup();
  }

  /**
   * Start periodic memory cleanup
   */
  startPeriodicCleanup() {
    // unref: the cleanup must not keep the process (or a test run) alive
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.cleanupInterval);
    this.cleanupTimer.unref();
  }

  /**
   * Perform memory cleanup
   */
  performCleanup() {
    try {
      // Force garbage collection if exposed
      if (global.gc) {
        global.gc();
        logger.debug("Manual garbage collection triggered");
      }

      // Log memory usage
      const usage = process.memoryUsage();
      const usageMB = {
        rss: Math.round(usage.rss / 1024 / 1024),
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
        external: Math.round(usage.external / 1024 / 1024),
      };

      logger.info(`Memory usage: ${JSON.stringify(usageMB)} MB`);

      // Warn if memory usage is high
      if (usageMB.heapUsed > this.memoryWarnThreshold) {
        logger.warn(`High memory usage detected (${usageMB.heapUsed}MB > ${this.memoryWarnThreshold}MB)! Consider restarting the bot.`);
      }
    } catch (error) {
      logger.error("Error during memory cleanup:", error);
    }
  }

  /**
   * Get current memory usage
   */
  getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      rss: Math.round(usage.rss / 1024 / 1024),
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
      external: Math.round(usage.external / 1024 / 1024),
    };
  }
}

module.exports = new MemoryManager();
