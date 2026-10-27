const { Op } = require("sequelize");
const { Conversation } = require("../database");
const pino = require("pino");
const config = require("../../config");
const { safeLog } = require("./http");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PURGE_FIRST_RUN_MS = 60 * 1000; // after the database is ready
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Conversation Context Manager
 * Manages conversation history for AI auto-responder.
 *
 * Writes are batched: addMessage() only fills `pendingUpdates`, a timer flushes
 * them to the database. Every read goes through the pending updates first, so a
 * turn that is not flushed yet is never lost.
 */
class ConversationManager {
  constructor(maxContextLength = 10) {
    this.maxContextLength = maxContextLength;
    this.contextTimeout = 30 * 60 * 1000; // 30 minutes
    this.pendingUpdates = new Map(); // jid -> { context, lastMessageTime }
    this.updateInterval = config.CONVERSATION_UPDATE_INTERVAL;
    this.batchSize = config.CONVERSATION_BATCH_SIZE;
    this.flushing = null;

    this.startBatchProcessor();
    this.startPurge();
    this.registerShutdownHooks();
  }

  /**
   * Start batch update processor to reduce database writes
   */
  startBatchProcessor() {
    // unref: the timer alone must not keep the process alive
    this.batchTimer = setInterval(() => {
      this.flush().catch((error) =>
        logger.error({ err: safeLog(error) }, "Conversation flush failed"),
      );
    }, this.updateInterval);
    this.batchTimer.unref();
  }

  /**
   * Delete conversations nobody touched for 30 days (first run 1 minute after boot, then hourly)
   */
  startPurge() {
    const run = () => this.purgeOld().catch(() => {});
    this.purgeFirstTimer = setTimeout(run, PURGE_FIRST_RUN_MS);
    this.purgeFirstTimer.unref();
    this.purgeTimer = setInterval(run, PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  /**
   * @returns {Promise<number>} number of deleted conversations
   */
  async purgeOld() {
    try {
      return await Conversation.destroy({
        where: { lastMessageTime: { [Op.lt]: new Date(Date.now() - RETENTION_MS) } },
      });
    } catch (error) {
      logger.error({ err: safeLog(error) }, "Error purging old conversations");
      return 0;
    }
  }

  /**
   * Write what is pending when the process stops.
   * A SIGTERM / SIGINT listener removes Node's default "exit", so exit after the flush
   * unless another listener (panel.js) owns the shutdown.
   */
  registerShutdownHooks() {
    process.once("beforeExit", () => {
      this.flush().catch(() => {});
    });
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.once(signal, () => {
        const othersHandleIt = process.listenerCount(signal) > 0;
        this.flush()
          .catch(() => {})
          .finally(() => {
            if (!othersHandleIt) process.exit(0);
          });
      });
    }
  }

  /**
   * Write every pending update to the database (also called on shutdown).
   * Calls overlap safely: a second call waits for the first one, then flushes what arrived since.
   */
  async flush() {
    if (this.flushing) {
      await this.flushing.catch(() => {});
    }
    if (this.pendingUpdates.size === 0) return;

    this.flushing = (async () => {
      const updates = Array.from(this.pendingUpdates.entries());
      this.pendingUpdates.clear();

      // Process updates in parallel (with limit)
      const batchSize = this.batchSize || 5;
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(([jid, data]) => this.commitUpdate(jid, data)),
        );
      }
    })();

    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /**
   * Commit a pending update to database (insert or update in one statement)
   */
  async commitUpdate(jid, data) {
    try {
      await Conversation.upsert({
        jid,
        context: data.context,
        lastMessageTime: data.lastMessageTime,
      });
    } catch (error) {
      logger.error({ err: safeLog(error) }, "Error committing conversation update");
      // Keep the data for the next flush, unless a newer turn replaced it meanwhile
      if (!this.pendingUpdates.has(jid)) this.pendingUpdates.set(jid, data);
    }
  }

  /**
   * Stored context of a JID, or null. A turn waiting for a flush wins over the database.
   * An expired context (older than 30 minutes) counts as empty.
   * @returns {Promise<{ context: Array, lastMessageTime: Date }|null>}
   */
  async readStored(jid) {
    const pending = this.pendingUpdates.get(jid);
    let stored = pending || null;

    if (!stored) {
      const conversation = await Conversation.findOne({ where: { jid } });
      if (!conversation) return null;
      stored = {
        context: conversation.context,
        lastMessageTime: conversation.lastMessageTime,
      };
    }

    const age = Date.now() - new Date(stored.lastMessageTime).getTime();
    if (age > this.contextTimeout) return null;
    return {
      context: Array.isArray(stored.context) ? stored.context : [],
      lastMessageTime: stored.lastMessageTime,
    };
  }

  /**
   * Get conversation context for a JID
   */
  async getContext(jid) {
    try {
      const stored = await this.readStored(jid);
      return stored ? stored.context : [];
    } catch (error) {
      logger.error({ err: safeLog(error) }, "Error getting conversation context");
      return [];
    }
  }

  /**
   * Add message to conversation context
   */
  async addMessage(jid, role, content) {
    try {
      // Pending updates first: the previous turn may not be flushed yet
      const stored = await this.readStored(jid);
      let context = stored ? [...stored.context] : [];

      context.push({ role, content });

      // Keep only last N messages
      if (context.length > this.maxContextLength) {
        context = context.slice(-this.maxContextLength);
      }

      // Queue update instead of immediate write (debouncing)
      this.pendingUpdates.set(jid, {
        context,
        lastMessageTime: new Date(),
      });

      return context;
    } catch (error) {
      logger.error({ err: safeLog(error) }, "Error adding message to context");
      return [];
    }
  }

  /**
   * Clear conversation context
   */
  async clearContext(jid) {
    try {
      this.pendingUpdates.delete(jid);
      await Conversation.update(
        { context: [], lastMessageTime: new Date() },
        { where: { jid } },
      );
      return true;
    } catch (error) {
      logger.error({ err: safeLog(error) }, "Error clearing context");
      return false;
    }
  }

  /**
   * Format context for Gemini API
   */
  formatForGemini(context) {
    const turns = (context || [])
      .filter((msg) => msg && typeof msg.content === "string" && msg.content.trim())
      .map((msg) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      }));
    // The conversation must open with the user's turn
    while (turns.length > 0 && turns[0].role !== "user") turns.shift();
    return turns;
  }
}

module.exports = new ConversationManager();
