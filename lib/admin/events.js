"use strict";

/**
 * Topic hub of the admin panel (contracts/runtime.md section 15 "Audit and hub", admin-http-api.md section 3).
 *
 *   hub.publish(topic, payload, { force })   deliver to the subscribers of `topic`
 *   hub.subscribe(topic, fn) -> unsubscribe
 *   hub.subscriberCount(topic)
 *   hub.setSnapshot(topic, fn)               fn() -> payload | null (sync or async): the CURRENT value of a topic,
 *                                            sent to a new stream right after it connects and, for `state`, by the
 *                                            ticker
 *   hub.snapshot(topic) -> Promise<payload|null>
 *   hub.publishState({ force })              publish the `state` snapshot (what a producer calls when something
 *                                            changed: ready, close, qr, job start or end...)
 *   hub.stop()                               clears every timer and drops every subscriber
 *
 * Topics (exactly these five): `state`, `pairing`, `log`, `job`, `session`. Payload shapes are those of the
 * contract (section 3.2) and never hold a secret, the QR string or a pairing code. `session` carries
 * `{ sessionId, reason: "expired" | "revoked" | "logout" }`: the SSE streams of that session send the event
 * `{ reason }` and close.
 *
 * Producers (set up by the owner of each area in its route module, see runtime.md section 15):
 *   - dashboard: hub.setSnapshot("state", buildState) and a forced publishState() on ready / close / qr / restart
 *     phases / settings changes affecting restartPending;
 *   - pairing:   hub.setSnapshot("pairing", ...) and hub.publish("pairing", ...) on each QR renewal and status change;
 *   - logs:      createAdmin wires ring.subscribe -> hub.publish("log", entry);
 *   - jobs:      lib/admin/jobs.js publishes `job` on every phase change.
 *
 * `state` is coalesced to at most one per second except when `force` is set. A 2 s ticker republishes the
 * snapshot, armed lazily only while at least one client is subscribed to `state` (its timer is unref()'d and
 * cleared with the last subscriber). Nothing runs at require time or at creation. Timers and the clock are
 * injectable (`timers`, `now`) so a test needs no real waiting.
 */

const TOPICS = Object.freeze(["state", "pairing", "log", "job", "session"]);
const STATE_MIN_INTERVAL_MS = 1000;
const TICK_MS = 2000;

/** Timers resolved at call time, so a test that replaces the globals (or passes `timers`) is honoured. */
const globalTimers = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (handle) => clearInterval(handle),
};

function createHub({ now = Date.now, timers = globalTimers, logger } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const subscribers = new Map(TOPICS.map((topic) => [topic, new Set()]));
  /** @type {Map<string, Function>} */
  const snapshots = new Map();
  let ticker = null;
  let lastStateAt = -Infinity;
  let pendingState = null;
  let pendingTimer = null;

  const assertTopic = (topic) => {
    if (!subscribers.has(topic)) throw new Error(`unknown hub topic: ${String(topic)}`);
  };

  function deliver(topic, payload) {
    for (const fn of [...subscribers.get(topic)]) {
      try {
        fn(payload);
      } catch (err) {
        // one broken subscriber never starves the others
        if (logger && logger.debug) logger.debug({ topic, name: err && err.name }, "admin hub: subscriber failed");
      }
    }
  }

  function flushPending() {
    pendingTimer = null;
    if (pendingState === null) return;
    const payload = pendingState;
    pendingState = null;
    lastStateAt = now();
    deliver("state", payload);
  }

  function publish(topic, payload, { force = false } = {}) {
    assertTopic(topic);
    if (!subscribers.get(topic).size) {
      if (topic === "state") pendingState = null;
      return;
    }
    if (topic !== "state") {
      deliver(topic, payload);
      return;
    }
    const at = now();
    if (force || at - lastStateAt >= STATE_MIN_INTERVAL_MS) {
      pendingState = null;
      if (pendingTimer) {
        timers.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      lastStateAt = at;
      deliver("state", payload);
      return;
    }
    // coalesce: only the newest payload of the second is delivered, once the second is over
    pendingState = payload;
    if (!pendingTimer) {
      pendingTimer = timers.setTimeout(flushPending, STATE_MIN_INTERVAL_MS - (at - lastStateAt));
      if (pendingTimer && pendingTimer.unref) pendingTimer.unref();
    }
  }

  async function snapshot(topic) {
    assertTopic(topic);
    const fn = snapshots.get(topic);
    if (!fn) return null;
    try {
      const value = await fn();
      return value === undefined ? null : value;
    } catch (err) {
      if (logger && logger.debug) logger.debug({ topic, name: err && err.name }, "admin hub: snapshot failed");
      return null;
    }
  }

  async function publishState({ force = false } = {}) {
    if (!subscribers.get("state").size) return;
    const payload = await snapshot("state");
    if (payload !== null) publish("state", payload, { force });
  }

  function armTicker() {
    if (ticker) return;
    ticker = timers.setInterval(() => {
      publishState().catch(() => {});
    }, TICK_MS);
    if (ticker && ticker.unref) ticker.unref();
  }

  function disarmTicker() {
    if (ticker) timers.clearInterval(ticker);
    ticker = null;
    if (pendingTimer) timers.clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingState = null;
  }

  return {
    TOPICS,

    publish,
    snapshot,
    publishState,

    subscribe(topic, fn) {
      assertTopic(topic);
      if (typeof fn !== "function") throw new Error("hub.subscribe needs a function");
      const set = subscribers.get(topic);
      set.add(fn);
      if (topic === "state") armTicker();
      return () => {
        set.delete(fn);
        if (topic === "state" && !set.size) disarmTicker();
      };
    },

    subscriberCount(topic) {
      assertTopic(topic);
      return subscribers.get(topic).size;
    },

    setSnapshot(topic, fn) {
      assertTopic(topic);
      if (fn === null || fn === undefined) snapshots.delete(topic);
      else if (typeof fn === "function") snapshots.set(topic, fn);
      else throw new Error("hub.setSnapshot needs a function");
    },

    /** True while the 2 s ticker is armed (tests: no timer without subscribers). */
    tickerArmed: () => ticker !== null,

    stop() {
      disarmTicker();
      for (const set of subscribers.values()) set.clear();
    },
  };
}

module.exports = { createHub, TOPICS, STATE_MIN_INTERVAL_MS, TICK_MS };
