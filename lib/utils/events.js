"use strict";

/**
 * Core bus: a tiny in-process event bus for core-to-engine notifications that would
 * otherwise create a require cycle (contracts/runtime.md section 5).
 *
 * Three topics only:
 *
 *   command:error     { name, at }                                 registry.executeCommand -> alerts (error window)
 *   key:refused       { service, at }                              http.classifyError      -> alerts (once per service per 24 h)
 *   groupguard:action { rule, groupJid, userJid, outcome }         plugins/groupguard.js   -> admin audit (logged only when the panel is off)
 *
 * Emit with `emitSafe(topic, payload)`: every listener runs inside its own try/catch, so a
 * throwing (or rejecting) listener never reaches the emitter and never starves the listeners
 * registered after it. Subscribe with the plain EventEmitter API (`on`, `once`, `off`).
 *
 * This module requires nothing from the bot (no config, no database, no logger at load time),
 * so any module may require it without a cycle. Nothing here starts a timer.
 */

const { EventEmitter } = require("events");

const TOPICS = Object.freeze({
  COMMAND_ERROR: "command:error",
  KEY_REFUSED: "key:refused",
  GROUPGUARD_ACTION: "groupguard:action",
});

class CoreBus extends EventEmitter {
  constructor() {
    super();
    // The admin audit, alerts and the tests may each subscribe: no spurious warning
    this.setMaxListeners(50);
  }

  /**
   * Call every listener of `topic` with `payload`, isolating failures.
   * @param {string} topic
   * @param {*} [payload]
   * @returns {boolean} true when the topic had at least one listener (like `emit`)
   */
  emitSafe(topic, payload) {
    // rawListeners keeps the `once` wrappers, so a one-shot listener still removes itself
    const listeners = this.rawListeners(topic);
    for (const listener of listeners) {
      try {
        const out = listener.call(this, payload);
        if (out && typeof out.then === "function") {
          out.then(undefined, (err) => reportListenerError(topic, err));
        }
      } catch (err) {
        reportListenerError(topic, err);
      }
    }
    return listeners.length > 0;
  }
}

/** One log line per failed listener: topic, error name and code only (never a message or payload). */
function reportListenerError(topic, err) {
  try {
    const { createLogger } = require("./logger");
    createLogger("events").error({ topic, name: err && err.name, code: err && err.code }, "bus listener failed");
  } catch (e) {
    // the logger is not available (yet): a listener failure must never matter to the emitter
  }
}

const bus = new CoreBus();

module.exports = bus;
module.exports.TOPICS = TOPICS;
