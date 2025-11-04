const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Memory Management Utility
 * Helps reduce memory footprint and prevent leaks
 */
class MemoryManager {
  constructor() {
    this.cleanupInterval = 15 * 60 * 1000; // 15 minutes
    this.startPeriodicCleanup();
  }

  /**
   * Start periodic memory cleanup
   */
  startPeriodicCleanup() {
    setInterval(() => {
      this.performCleanup();
    }, this.cleanupInterval);
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
      if (usageMB.heapUsed > 400) {
        logger.warn("High memory usage detected! Consider restarting the bot.");
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
