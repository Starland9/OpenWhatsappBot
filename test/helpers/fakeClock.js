"use strict";
/**
 * Injectable clock for the tests of feature 002 (contracts/runtime.md section 16).
 *
 *   const clock = createClock(Date.UTC(2026, 0, 1));
 *   clock.now()                  current time (ms), moved only by advance() / set()
 *   await clock.advance(ms)      move time forward, firing the fake timers that fall due in order
 *   clock.timers                 { setTimeout, clearTimeout, setInterval, clearInterval } with the Node timer
 *                                surface (unref / ref / hasRef): hand it to a module that takes `timers`
 *   clock.pending()              number of live fake timers (a module must leave none while idle)
 *   clock.install()              also mock the global `Date` through `mock.timers` (apis: ["Date"]), so code that
 *                                reads Date.now() (cooldown.hit...) follows the clock; undone by restore()
 *   clock.restore()              uninstall and drop the fake timers
 *
 * Only the global Date is ever mocked, never the global timers: real HTTP traffic (fetch, node:http) in the
 * same test keeps its own timers, while the code under test is driven by `clock.timers`.
 */

const { mock } = require("node:test");

function createClock(start = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  let current = Number(start);
  let seq = 0;
  let installed = false;
  /** @type {Map<number, object>} id -> { id, due, every, fn, args } */
  const live = new Map();

  function handleFor(entry) {
    return {
      id: entry.id,
      unref() {
        entry.refed = false;
        return this;
      },
      ref() {
        entry.refed = true;
        return this;
      },
      hasRef() {
        return entry.refed;
      },
      refresh() {
        entry.due = current + (entry.every || entry.delay);
        return this;
      },
      [Symbol.toPrimitive]() {
        return entry.id;
      },
    };
  }

  function schedule(fn, delay, args, every) {
    const wait = Math.max(1, Number(delay) || 1);
    const entry = { id: ++seq, due: current + wait, delay: wait, every: every ? wait : 0, fn, args, refed: true };
    live.set(entry.id, entry);
    entry.handle = handleFor(entry);
    return entry.handle;
  }

  function cancel(handle) {
    const id = handle && typeof handle === "object" ? handle.id : handle;
    live.delete(id);
  }

  const timers = {
    setTimeout: (fn, delay, ...args) => schedule(fn, delay, args, false),
    clearTimeout: cancel,
    setInterval: (fn, delay, ...args) => schedule(fn, delay, args, true),
    clearInterval: cancel,
  };

  function syncDate() {
    if (installed) mock.timers.setTime(current);
  }

  /** The next timer that falls due at or before `limit`, earliest first (creation order on ties). */
  function nextDue(limit) {
    let best = null;
    for (const entry of live.values()) {
      if (entry.due > limit) continue;
      if (!best || entry.due < best.due || (entry.due === best.due && entry.id < best.id)) best = entry;
    }
    return best;
  }

  async function flush() {
    // let the promise chains started by a fired timer settle before the next one runs
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    now: () => current,
    set(ms) {
      current = Number(ms);
      syncDate();
    },
    async advance(ms) {
      const target = current + Number(ms);
      for (;;) {
        const entry = nextDue(target);
        if (!entry) break;
        current = Math.max(current, entry.due);
        syncDate();
        if (entry.every) entry.due = current + entry.every;
        else live.delete(entry.id);
        try {
          entry.fn(...entry.args);
        } catch (err) {
          // a throwing timer callback must not stop the clock; surface it as an unhandled error like Node does
          process.nextTick(() => {
            throw err;
          });
        }
        await flush();
      }
      current = target;
      syncDate();
      await flush();
    },
    timers,
    pending: () => live.size,
    install() {
      if (installed) return this;
      mock.timers.enable({ apis: ["Date"], now: current });
      installed = true;
      return this;
    },
    restore() {
      if (installed) {
        mock.timers.reset();
        installed = false;
      }
      live.clear();
    },
  };
}

module.exports = { createClock };
