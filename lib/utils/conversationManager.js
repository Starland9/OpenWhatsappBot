const { Conversation } = require('../database');

/**
 * Conversation Context Manager
 * Manages conversation history for AI auto-responder
 */
class ConversationManager {
  constructor(maxContextLength = 10) {
    this.maxContextLength = maxContextLength;
    this.contextTimeout = 30 * 60 * 1000; // 30 minutes
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

      if (!conversation) {
        conversation = await Conversation.create({
          jid,
          context: [],
          lastMessageTime: new Date()
        });
      }

      // Get current context
      let context = conversation.context || [];

      // Add new message
      context.push({ role, content });

      // Keep only last N messages
      if (context.length > this.maxContextLength) {
        context = context.slice(-this.maxContextLength);
      }

      // Update conversation
      await conversation.update({
        context,
        lastMessageTime: new Date()
      });

      return context;
    } catch (error) {
      console.error('Error adding message to context:', error);
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
      console.error('Error clearing context:', error);
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
