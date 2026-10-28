"use strict";

/**
 * Maintenance mode (contracts/runtime.md section 13): a process-wide flag the pipeline reads, plus
 * a counter of work in flight so a restore can wait for the messages already being processed.
 *
 *   await maintenanceMode.enter("restore")   set the flag, then wait up to 10 s for in-flight work
 *   maintenanceMode.leave()                  clear the flag (idempotent)
 *   maintenanceMode.isActive()               true between enter() and leave()
 *   const done = maintenanceMode.begin()     bracket a unit of work; call done() when it ends
 *
 * While active, the pipeline drops new messages, `stats.flush` and `broadcaster.tick` skip, and
 * `settingsStore.set` is refused with `busy`. Those checks live in their own modules; this one
 * only keeps the state.
 *
 * Nothing runs at require time. A timer exists only while enter() is waiting for in-flight work;
 * it is unref()'d and cleared as soon as the wait ends.
 */

const logger = require("./logger").createLogger("maintenance");

/** How long enter() waits for in-flight work before giving up on it */
const DRAIN_TIMEOUT_MS = 10 * 1000;

const state = {
  active: false,
  reason: null,
  inFlight: 0,
  /** bumped by _reset() so a done() from before the reset cannot unbalance the counter */
  generation: 0,
  /** @type {{ promise: Promise<void>, finish: () => void }|null} the wait shared by concurrent enter() calls */
  drain: null,
};

/** End the current wait (drained, timed out or left) and let every enter() caller continue */
function endDrain() {
  const drain = state.drain;
  if (!drain) return;
  state.drain = null;
  drain.finish();
}

/** The wait for in-flight work, created on first use and shared */
function startDrain(timeoutMs) {
  if (state.drain) return state.drain.promise;

  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  let timer = null;
  state.drain = {
    promise,
    finish() {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve();
    },
  };
  timer = setTimeout(() => {
    timer = null;
    logger.warn({ pending: state.inFlight, timeoutMs }, "maintenance mode: in-flight work did not finish in time");
    endDrain();
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  return promise;
}

/**
 * Turn maintenance mode on and wait for the work already started (begin() without done() yet).
 * Always resolves: after at most `timeoutMs` the caller proceeds even if some work is still running.
 * Calling it again while active is allowed (it waits again; the first reason stays).
 * @param {string} [reason] - Why, for the status page and the logs (e.g. "restore")
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
async function enter(reason, { timeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  if (!state.active) {
    state.active = true;
    state.reason = reason === undefined || reason === null ? null : String(reason);
    logger.info({ reason: state.reason }, "maintenance mode on");
  }
  if (state.inFlight > 0) await startDrain(timeoutMs);
}

/** Turn maintenance mode off. Safe to call when it is not active. */
function leave() {
  const wasActive = state.active;
  state.active = false;
  state.reason = null;
  endDrain(); // an enter() still waiting must not hang
  if (wasActive) logger.info("maintenance mode off");
}

/** @returns {boolean} */
function isActive() {
  return state.active;
}

/** @returns {string|null} the reason given to enter(), null when not active */
function getReason() {
  return state.reason;
}

/** @returns {number} units of work started and not finished */
function pending() {
  return state.inFlight;
}

/**
 * Mark the start of a unit of work (the pipeline brackets each message with it).
 * Never throws; the returned `done()` may be called more than once and counts once.
 * @returns {() => void} done
 */
function begin() {
  state.inFlight++;
  const generation = state.generation;
  let finished = false;
  return function done() {
    if (finished) return;
    finished = true;
    if (generation !== state.generation) return;
    state.inFlight--;
    if (state.inFlight === 0) endDrain();
  };
}

/** Back to the initial state, for tests */
function _reset() {
  state.active = false;
  state.reason = null;
  state.inFlight = 0;
  state.generation++;
  endDrain();
}

module.exports = {
  enter,
  leave,
  isActive,
  getReason,
  pending,
  begin,
  DRAIN_TIMEOUT_MS,
  _reset,
};
