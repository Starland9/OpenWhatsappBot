"use strict";

/**
 * Process-wide pacing floor shared by the messaging outbox and the broadcaster (feature 004, contracts/runtime.md
 * section 11, FR-035, RT-110). Two automatic sends, API and broadcasts together, are never closer than the spacing.
 *
 *   const gate = createSendGate({ clock, random, config });
 *   gate.ready(at, extraMs)   true when `at - last >= max(minSpacing(), extraMs) * (1 + jitter)`;
 *                             true when nothing was ever reserved or seeded
 *   gate.waitMs(at, extraMs)  remaining ms until it is ready, >= 0
 *   gate.reserve(at)          a message is being sent at `at`; draws the jitter (random() * 0.2) of the NEXT gap, once
 *   gate.seed(ms)             last = max(last, ms): a restart cannot burst; a non-finite value is ignored
 *   gate.lastSendAt()         ms of the last reservation or seed, null when there never was one
 *   shared                    the process-wide instance (the outbox and the default broadcaster)
 *
 * The spacing is `max(2000, Number(config.SEND_MIN_SPACING_MS) || 2000)`, read at every call (the setting can only
 * be raised above the 2 s floor). The formula and the jitter are those of the broadcaster's own per-broadcast
 * gap, which stays in place on top of this gate. No timer, no listener, no query at `require`.
 */

const MIN_SPACING_FLOOR_MS = 2000;
const JITTER_RANGE = 0.2;

/**
 * @param {object} [options]
 * @param {() => number} [options.clock]   default Date.now (used when `at` is omitted)
 * @param {() => number} [options.random]  default Math.random
 * @param {object|(() => object)} [options.config] default ../../config, required lazily (SEND_MIN_SPACING_MS)
 */
function createSendGate(options = {}) {
  const clock = options.clock || Date.now;
  const random = options.random || Math.random;
  const configOf = () => {
    const given = options.config;
    if (typeof given === "function") return given();
    return given || require("../../config");
  };

  /** @type {number|null} */
  let last = null;
  let jitter = 0;

  /** The spacing floor, read at call time: never below 2000 whatever the setting says. */
  const minSpacing = () => {
    const configured = Number(configOf().SEND_MIN_SPACING_MS) || MIN_SPACING_FLOOR_MS;
    return Math.max(MIN_SPACING_FLOOR_MS, configured);
  };

  const gapOf = (extraMs) => Math.max(minSpacing(), Number(extraMs) || 0) * (1 + jitter);
  const atOf = (at) => (at === undefined || at === null ? clock() : at);

  function waitMs(at, extraMs = 0) {
    if (last === null) return 0;
    return Math.max(0, last + gapOf(extraMs) - atOf(at));
  }

  function ready(at, extraMs = 0) {
    if (last === null) return true;
    return atOf(at) - last >= gapOf(extraMs);
  }

  function reserve(at) {
    last = atOf(at);
    jitter = random() * JITTER_RANGE;
  }

  function seed(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    if (last === null || ms > last) last = ms;
  }

  const lastSendAt = () => last;

  return { ready, waitMs, reserve, seed, lastSendAt };
}

module.exports = { createSendGate, shared: createSendGate() };
