const { GoogleGenAI } = require("@google/genai");
const { AutoResponder } = require("../database");
const conversationManager = require("./conversationManager");
const config = require("../../config");

/**
 * Auto Responder Handler
 * Handles automatic responses using Gemini AI
 */
class AutoResponderHandler {
  constructor() {
    this.genAI = null;
    this.processing = new Set(); // Track messages being processed
  }

  /**
   * Initialize Gemini AI
   */
  initializeAI() {
    if (!this.genAI && config.GEMINI_API_KEY) {
      this.genAI = new GoogleGenAI({
        apiKey: config.GEMINI_API_KEY,
      });
    }
    return this.genAI;
  }

  /**
   * Check if auto responder should respond to this message
   */
  async shouldRespond(message) {
    try {
      // Get settings
      let settings = await AutoResponder.findOne({ where: { id: 1 } });
      if (!settings) {
        settings = await AutoResponder.create({
          id: 1,
          ignoreNumbers: config.AUTO_RESPONDER_IGNORE_NUMBERS,
          personality: config.AUTO_RESPONDER_PERSONALITY,
          enabled: config.AUTO_RESPONDER_ENABLED,
        });
      }

      // Check if enabled
      if (!settings.enabled) {
        return false;
      }

      // Don't respond to own messages
      if (message.fromMe) {
        return false;
      }

      // Don't respond to group messages (to avoid spam)
      if (message.isGroup) {
        return false;
      }

      // Don't respond to status updates
      if (message.jid === "status@broadcast") {
        return false;
      }

      // Check if API key is available
      if (!config.GEMINI_API_KEY) {
        return false;
      }

      // Check ignore list
      const senderNumber = message.sender.split("@")[0];
      const ignoreList = settings.ignoreNumbers
        ? settings.ignoreNumbers.split(",").map(n => n.trim()).filter(Boolean)
        : [];

      if (ignoreList.includes(senderNumber)) {
        return false;
      }

      // Check if already processing this message
      if (this.processing.has(message.id)) {
        return false;
      }

      return true;
    } catch (error) {
      console.error("Error checking auto responder conditions:", error);
      return false;
    }
  }

  /**
   * Generate response using Gemini AI
   */
  async generateResponse(message) {
    try {
      // Mark as processing
      this.processing.add(message.id);

      // Initialize AI
      const ai = this.initializeAI();
      if (!ai) {
        throw new Error("Gemini AI not initialized");
      }

      // Get settings
      const settings = await AutoResponder.findOne({ where: { id: 1 } });
      const personality = settings?.personality || config.AUTO_RESPONDER_PERSONALITY;

      // Get conversation context
      const context = await conversationManager.getContext(message.jid);

      // Add user message to context
      await conversationManager.addMessage(message.jid, "user", message.body);

      // Build prompt with personality
      const systemPrompt = `${personality}\n\nImportant: Keep your responses concise and natural. Respond in the same language as the user's message.`;

      // Format context for Gemini
      const formattedContext = conversationManager.formatForGemini(context);

      // Add system prompt and current message
      const contents = [
        {
          role: "user",
          parts: [{ text: systemPrompt }],
        },
        ...formattedContext,
        {
          role: "user",
          parts: [{ text: message.body }],
        },
      ];

      // Generate response
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash-exp",
        contents: contents,
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.9,
        },
      });

      const responseText = response.text;

      // Add assistant response to context
      await conversationManager.addMessage(message.jid, "assistant", responseText);

      return responseText;
    } catch (error) {
      console.error("Error generating auto response:", error);
      throw error;
    } finally {
      // Remove from processing
      this.processing.delete(message.id);
    }
  }

  /**
   * Handle incoming message with auto responder
   */
  async handleMessage(message) {
    try {
      // Check if should respond
      const shouldRespond = await this.shouldRespond(message);
      if (!shouldRespond) {
        return false;
      }

      // Show typing indicator
      await message.client.getSocket().sendPresenceUpdate("composing", message.jid);

      // Generate response
      const response = await this.generateResponse(message);

      // Send response
      await message.reply(response);

      // Clear typing indicator
      await message.client.getSocket().sendPresenceUpdate("paused", message.jid);

      return true;
    } catch (error) {
      console.error("Auto responder error:", error);
      // Clear typing indicator on error
      try {
        await message.client.getSocket().sendPresenceUpdate("paused", message.jid);
      } catch (e) {
        // Ignore
      }
      return false;
    }
  }

  /**
   * Clear conversation context for a JID
   */
  async clearContext(jid) {
    return await conversationManager.clearContext(jid);
  }
}

module.exports = new AutoResponderHandler();
