const { GoogleGenAI } = require("@google/genai");
const { AutoResponder } = require("../database");
const conversationManager = require("./conversationManager");
const settingsCache = require("./settingsCache");
const { jidUser } = require("./permissions");
const { safeLog } = require("./http");
const config = require("../../config");
const settingsStore = require("./settingsStore");

const SETTINGS_KEY = "auto_responder";
const REQUEST_TIMEOUT_MS = 30000;
// Gemini 2.5+ counts its thinking tokens in maxOutputTokens: leave room for them
const MAX_OUTPUT_TOKENS = 1024;
const RATE_MAP_MAX = 5000;

/** Only 1:1 chats: groups, broadcasts, newsletters are never answered */
const USER_CHAT_RE = /@(s\.whatsapp\.net|lid)$/;

/**
 * Auto Responder Handler
 * Handles automatic responses using Gemini AI.
 *
 * The pipeline does not await handleMessage(): the human-like delays below only
 * hold this call. It never throws.
 */
class AutoResponderHandler {
  constructor() {
    this.genAI = null;
    this.processing = new Set(); // Message ids being processed
    this.rateHistory = new Map(); // jid -> timestamps of recent replies (per-JID rate limit)
    this.queues = new Map(); // jid -> promise of the last queued message (one reply at a time)

    // A new key from the panel: the cached client was built with the old one
    settingsStore.onChange(["GEMINI_API_KEY"], () => {
      this.genAI = null;
    });
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
   * Generate a random delay between min and max
   */
  getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Calculate typing duration based on message length
   * Simulates human typing speed
   */
  calculateTypingDuration(text) {
    const typingSpeed = config.AUTO_RESPONDER_TYPING_SPEED || 50; // characters per second
    const maxTypingTime = config.AUTO_RESPONDER_MAX_TYPING_TIME || 10000; // max 10 seconds

    // Calculate duration based on text length
    const calculatedDuration = (text.length / typingSpeed) * 1000;

    // Cap at maximum typing time
    const duration = Math.min(calculatedDuration, maxTypingTime);

    // Add some randomness (±20%)
    const randomFactor = 0.8 + Math.random() * 0.4;
    return Math.floor(duration * randomFactor);
  }

  /**
   * Simulate human-like delay
   */
  async simulateDelay(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  /**
   * Settings row (id 1), cached; created from the config defaults when missing
   */
  async getSettings() {
    return await settingsCache.get(SETTINGS_KEY, async () => {
      let settings = await AutoResponder.findOne({ where: { id: 1 } });
      if (!settings) {
        settings = await AutoResponder.create({
          id: 1,
          ignoreNumbers: config.AUTO_RESPONDER_IGNORE_NUMBERS,
          personality: config.AUTO_RESPONDER_PERSONALITY,
          enabled: config.AUTO_RESPONDER_ENABLED,
        });
      }
      return settings;
    });
  }

  /**
   * Per-JID rate limit. The hit is recorded here, at the start, so a burst of
   * messages cannot slip through while the first reply is still being generated.
   * @returns {boolean} true when the message is allowed
   */
  allowByRate(jid) {
    const now = Date.now();
    const rateWindow = config.AUTO_RESPONDER_RATE_WINDOW || 60000;
    const rateLimit = config.AUTO_RESPONDER_RATE_LIMIT || 5;

    const recent = (this.rateHistory.get(jid) || []).filter(
      (timestamp) => now - timestamp < rateWindow,
    );
    if (recent.length >= rateLimit) {
      this.rateHistory.set(jid, recent);
      console.log(
        `Rate limit exceeded for auto responder (${recent.length}/${rateLimit} in ${rateWindow}ms)`,
      );
      return false;
    }

    recent.push(now);
    this.rateHistory.delete(jid); // re-insert: Map order = least recently used first
    this.rateHistory.set(jid, recent);
    if (this.rateHistory.size > RATE_MAP_MAX) {
      for (const [key, stamps] of this.rateHistory) {
        if (!stamps.some((t) => now - t < rateWindow)) this.rateHistory.delete(key);
      }
      while (this.rateHistory.size > RATE_MAP_MAX) {
        this.rateHistory.delete(this.rateHistory.keys().next().value);
      }
    }
    return true;
  }

  /**
   * Check if auto responder should respond to this message
   * (records the rate-limit hit when it says yes)
   */
  async shouldRespond(message) {
    try {
      // Cheap checks first: no database for messages we never answer
      if (message.fromMe) return false;
      if (!USER_CHAT_RE.test(message.jid || "")) return false;
      if (message.isGroup) return false;
      if (message.isInteractiveReply) return false;
      // Reactions, protocol messages, media without caption: nothing to answer
      if (message.type === "reactionMessage") return false;
      if (typeof message.body !== "string" || !message.body.trim()) return false;
      if (this.processing.has(message.id)) return false;

      if (!config.GEMINI_API_KEY) return false;

      const settings = await this.getSettings();
      if (!settings || !settings.enabled) return false;

      // Ignore list (numbers, any JID form of the sender)
      const ignoreList = (settings.ignoreNumbers || "")
        .split(",")
        .map((n) => n.replace(/\D/g, ""))
        .filter(Boolean);
      if (ignoreList.length > 0) {
        const senderIds = [message.sender, message.senderLid, message.jid]
          .map((jid) => jidUser(jid))
          .filter(Boolean);
        if (senderIds.some((id) => ignoreList.includes(id))) return false;
      }

      return this.allowByRate(message.jid);
    } catch (error) {
      console.error("Error checking auto responder conditions:", safeLog(error));
      return false;
    }
  }

  /**
   * Generate response using Gemini AI
   * @returns {Promise<string|null>} the answer, or null when Gemini sent no text
   */
  async generateResponse(message) {
    try {
      // Initialize AI
      const ai = this.initializeAI();
      if (!ai) {
        throw new Error("Gemini AI not initialized");
      }

      const settings = await this.getSettings();
      const personality =
        settings?.personality || config.AUTO_RESPONDER_PERSONALITY;

      // Conversation so far (includes turns not flushed to the database yet)
      const context = await conversationManager.getContext(message.jid);
      const formattedContext = conversationManager.formatForGemini(context);

      const response = await ai.models.generateContent({
        model: config.GEMINI_MODEL,
        contents: [
          ...formattedContext,
          { role: "user", parts: [{ text: message.body }] },
        ],
        config: {
          systemInstruction: `${personality}\n\nImportant: Keep your responses concise and natural. Respond in the same language as the user's message.`,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.9,
          httpOptions: { timeout: REQUEST_TIMEOUT_MS },
        },
      });

      // `text` is undefined when the answer is empty or blocked: store and send nothing
      const responseText = response?.text?.trim();
      if (!responseText) {
        console.log("Auto responder: Gemini returned no text, skipping the reply");
        return null;
      }

      // Both turns together, only after a usable answer
      await conversationManager.addMessage(message.jid, "user", message.body);
      await conversationManager.addMessage(message.jid, "assistant", responseText);

      return responseText;
    } catch (error) {
      console.error("Error generating auto response:", safeLog(error));
      throw error;
    }
  }

  /**
   * Answer one message (called one at a time per chat)
   */
  async respond(message) {
    const sock = message.client.getSocket();
    let typing = false;
    try {
      // Add initial random delay (simulate reading time)
      const minDelay = config.AUTO_RESPONDER_MIN_DELAY || 1000;
      const maxDelay = config.AUTO_RESPONDER_MAX_DELAY || 3000;
      await this.simulateDelay(this.getRandomDelay(minDelay, maxDelay));

      // Show typing indicator
      typing = true;
      await sock.sendPresenceUpdate("composing", message.jid);

      // Generate response
      const response = await this.generateResponse(message);
      if (!response) return false;

      // Simulate typing time based on response length
      await this.simulateDelay(this.calculateTypingDuration(response));

      await message.reply(response);
      return true;
    } catch (error) {
      console.error("Auto responder error:", safeLog(error));
      return false;
    } finally {
      // Clear typing indicator, success or not
      if (typing) {
        try {
          await sock.sendPresenceUpdate("paused", message.jid);
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  /**
   * Handle incoming message with auto responder.
   * Never throws; resolves to true when a reply was sent.
   */
  async handleMessage(message) {
    let queued = false;
    try {
      if (!(await this.shouldRespond(message))) return false;

      // Mark as processing: the same message id is never answered twice
      this.processing.add(message.id);
      queued = true;

      // One reply at a time per chat, so that fast messages are answered in order
      const jid = message.jid;
      const previous = this.queues.get(jid) || Promise.resolve();
      const run = previous.then(() => this.respond(message));
      const tail = run.catch(() => false);
      this.queues.set(jid, tail);
      tail.then(() => {
        if (this.queues.get(jid) === tail) this.queues.delete(jid);
      });
      return await run;
    } catch (error) {
      console.error("Auto responder error:", safeLog(error));
      return false;
    } finally {
      if (queued) this.processing.delete(message.id);
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
