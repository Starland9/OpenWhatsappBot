const { Conversation } = require('../database');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Conversation Context Manager
 * Manages conversation history for AI auto-responder
 */
class ConversationManager {
  constructor(maxContextLength = 10) {
    this.maxContextLength = maxContextLength;
    this.contextTimeout = 30 * 60 * 1000; // 30 minutes
    this.pendingUpdates = new Map(); // Batch updates
    this.updateInterval = require('../../config').CONVERSATION_UPDATE_INTERVAL;
    this.batchSize = require('../../config').CONVERSATION_BATCH_SIZE;
    
    // Start batch update processor
    this.startBatchProcessor();
  }

  /**
   * Start batch update processor to reduce database writes
   */
  startBatchProcessor() {
    setInterval(async () => {
      if (this.pendingUpdates.size === 0) return;
      
      // Get all pending updates
      const updates = Array.from(this.pendingUpdates.entries());
      this.pendingUpdates.clear();
      
      // Process updates in parallel (with limit)
      const batchSize = this.batchSize;
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(([jid, data]) => this.commitUpdate(jid, data))
        );
      }
    }, this.updateInterval);
  }

  /**
   * Commit a pending update to database
   */
  async commitUpdate(jid, data) {
    try {
      let conversation = await Conversation.findOne({ where: { jid } });
      if (!conversation) {
        conversation = await Conversation.create({
          jid,
          context: data.context,
          lastMessageTime: data.lastMessageTime
        });
      } else {
        await conversation.update({
          context: data.context,
          lastMessageTime: data.lastMessageTime
        });
      }
    } catch (error) {
      logger.error('Error committing conversation update:', error);
    }
  }

  /**
   * Get conversation context for a JID
   */
  async getContext(jid) {
    try {
      const conversation = await Conversation.findOne({ where: { jid } });
      
      if (!conversation) {
        return [];
      }

      // Check if context is expired (older than 30 minutes)
      const lastMessageTime = new Date(conversation.lastMessageTime);
      const now = new Date();
      
      if (now - lastMessageTime > this.contextTimeout) {
        // Context expired, clear it
        await this.clearContext(jid);
        return [];
      }

      return conversation.context || [];
    } catch (error) {
      console.error('Error getting conversation context:', error);
      return [];
    }
  }

  /**
   * Add message to conversation context
   */
  async addMessage(jid, role, content) {
    try {
      let conversation = await Conversation.findOne({ where: { jid } });

      // Get current context
      let context = conversation?.context || [];

      // Add new message
      context.push({ role, content });

      // Keep only last N messages
      if (context.length > this.maxContextLength) {
        context = context.slice(-this.maxContextLength);
      }

      // Queue update instead of immediate write (debouncing)
      this.pendingUpdates.set(jid, {
        context,
        lastMessageTime: new Date()
      });

      return context;
    } catch (error) {
      logger.error('Error adding message to context:', error);
      return [];
    }
  }

  /**
   * Clear conversation context
   */
  async clearContext(jid) {
    try {
      await Conversation.update(
        { context: [], lastMessageTime: new Date() },
        { where: { jid } }
      );
      return true;
    } catch (error) {
      logger.error('Error clearing context:', error);
      return false;
    }
  }

  /**
   * Format context for Gemini API
   */
  formatForGemini(context) {
    return context.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));
  }
}

module.exports = new ConversationManager();
