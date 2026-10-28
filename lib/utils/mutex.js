"use strict";

/**
 * Per-key async mutex (contracts/runtime.md, data-model 0.4).
 *
 *   withLock(key, fn) -> Promise    runs fn() after every earlier call with the same key has settled
 *
 * Work with the same key runs one at a time, in call order; work with different keys is not
 * serialized. A rejection (or a synchronous throw) of fn is passed on to its own caller only: it
 * does not poison the queue. A key with no pending work is released, so the map never grows.
 *
 * Used by settingsStore ("settings"), and by the broadcast, backup and data engines for
 * multi-statement writes (in-memory SQLite has a single connection).
 */

/** key -> settled-version of the last queued call (never rejects) */
const tails = new Map();

const noop = () => {};

/**
 * @template T
 * @param {string} key
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function withLock(key, fn) {
  const name = String(key);
  const previous = tails.get(name) || Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(noop, noop);
  tails.set(name, tail);
  tail.then(() => {
    // still the last one queued: nobody is waiting behind it
    if (tails.get(name) === tail) tails.delete(name);
  });
  return run;
}

/** Number of keys with pending work (tests, diagnostics) */
function size() {
  return tails.size;
}

/** True while work with this key is running or queued */
function isLocked(key) {
  return tails.has(String(key));
}

module.exports = { withLock, size, isLocked };
