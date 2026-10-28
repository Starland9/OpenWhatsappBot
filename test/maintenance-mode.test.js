"use strict";
/**
 * T042: lib/utils/maintenanceMode.js
 *
 *  - enter() sets the flag at once, then waits for the work begun with begin() (up to 10 s);
 *  - the 10 s cap is checked with fake timers; the wait never hangs and never rejects;
 *  - leave() is idempotent; done() counts once; no timer exists outside a wait.
 */

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const maintenanceMode = require("../lib/utils/maintenanceMode");

/** Let pending promise callbacks run (fake timers do not touch microtasks) */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Track whether a promise has settled without awaiting it */
function track(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => {
      box.settled = true;
      box.value = value;
    },
    (error) => {
      box.settled = true;
      box.error = error;
    }
  );
  return box;
}

beforeEach(() => {
  maintenanceMode._reset();
});

afterEach(() => {
  mock.timers.reset();
  maintenanceMode._reset();
});

test("starts inactive; requiring the module sets no timer", () => {
  assert.equal(maintenanceMode.isActive(), false);
  assert.equal(maintenanceMode.getReason(), null);
  assert.equal(maintenanceMode.pending(), 0);
});

test("enter() sets the flag immediately and resolves at once when nothing is in flight", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const wait = maintenanceMode.enter("restore");
  assert.equal(maintenanceMode.isActive(), true, "the flag is set before the first await");
  assert.equal(maintenanceMode.getReason(), "restore");
  await wait;
});

test("enter() starts no timer when there is nothing to wait for", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const spy = mock.fn(global.setTimeout);
  mock.method(global, "setTimeout", spy);
  await maintenanceMode.enter("restore");
  assert.equal(spy.mock.callCount(), 0);
});

test("enter() waits for a pending begin() and resolves when done() is called", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const done = maintenanceMode.begin();
  assert.equal(maintenanceMode.pending(), 1);

  const wait = track(maintenanceMode.enter("restore"));
  await flush();
  assert.equal(maintenanceMode.isActive(), true);
  assert.equal(wait.settled, false, "still waiting for the message in flight");

  done();
  await flush();
  assert.equal(wait.settled, true);
  assert.equal(wait.error, undefined);
  assert.equal(maintenanceMode.pending(), 0);
});

test("enter() waits for every unit of work, not just the first", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const first = maintenanceMode.begin();
  const second = maintenanceMode.begin();
  const wait = track(maintenanceMode.enter("restore"));

  first();
  await flush();
  assert.equal(wait.settled, false);

  second();
  await flush();
  assert.equal(wait.settled, true);
});

test("a begin() after enter() (a message already past the gate) is waited for too", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  await maintenanceMode.enter("restore");
  const done = maintenanceMode.begin();
  const wait = track(maintenanceMode.enter("restore"));
  await flush();
  assert.equal(wait.settled, false);
  done();
  await flush();
  assert.equal(wait.settled, true);
});

test("the wait is capped at 10 s: enter() resolves even if work is still running", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(maintenanceMode.DRAIN_TIMEOUT_MS, 10000);
  const done = maintenanceMode.begin();
  const wait = track(maintenanceMode.enter("restore"));

  mock.timers.tick(9999);
  await flush();
  assert.equal(wait.settled, false, "not before 10 s");

  mock.timers.tick(1);
  await flush();
  assert.equal(wait.settled, true, "released at 10 s");
  assert.equal(wait.error, undefined, "a timeout is not an error");
  assert.equal(maintenanceMode.isActive(), true, "the mode stays on after the cap");
  assert.equal(maintenanceMode.pending(), 1, "the straggler is still counted");

  done();
  assert.equal(maintenanceMode.pending(), 0);
});

test("the timeout can be shortened for a caller that knows better", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  maintenanceMode.begin();
  const wait = track(maintenanceMode.enter("restore", { timeoutMs: 500 }));
  mock.timers.tick(500);
  await flush();
  assert.equal(wait.settled, true);
});

test("the wait timer is cleared as soon as the work is done", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const done = maintenanceMode.begin();
  const wait = track(maintenanceMode.enter("restore"));
  done();
  await flush();
  assert.equal(wait.settled, true);
  // ticking past 10 s afterwards must not do anything (no late timeout, no log, no throw)
  assert.doesNotThrow(() => mock.timers.tick(20000));
});

test("the wait timer is unref()'d so it never keeps the process alive", async () => {
  let unrefCalled = false;
  const realSetTimeout = global.setTimeout;
  mock.method(global, "setTimeout", (fn, ms) => {
    const timer = realSetTimeout(fn, ms);
    const unref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefCalled = true;
      return unref();
    };
    return timer;
  });
  const done = maintenanceMode.begin();
  const wait = maintenanceMode.enter("restore");
  await flush();
  assert.equal(unrefCalled, true);
  done();
  await wait;
});

test("concurrent enter() calls share one wait", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const done = maintenanceMode.begin();
  const first = track(maintenanceMode.enter("restore"));
  const second = track(maintenanceMode.enter("restore"));
  await flush();
  assert.equal(first.settled || second.settled, false);
  done();
  await flush();
  assert.equal(first.settled && second.settled, true);
});

test("enter() while already active keeps the first reason and still waits for in-flight work", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  await maintenanceMode.enter("restore");
  const done = maintenanceMode.begin();
  const wait = track(maintenanceMode.enter("other"));
  await flush();
  assert.equal(maintenanceMode.getReason(), "restore");
  assert.equal(wait.settled, false);
  done();
  await flush();
  assert.equal(wait.settled, true);
});

test("leave() clears the flag and is idempotent", async () => {
  await maintenanceMode.enter("restore");
  assert.equal(maintenanceMode.isActive(), true);
  maintenanceMode.leave();
  assert.equal(maintenanceMode.isActive(), false);
  assert.equal(maintenanceMode.getReason(), null);
  assert.doesNotThrow(() => maintenanceMode.leave());
  assert.doesNotThrow(() => maintenanceMode.leave());
  assert.equal(maintenanceMode.isActive(), false);
});

test("leave() without a prior enter() is a no-op", () => {
  assert.doesNotThrow(() => maintenanceMode.leave());
  assert.equal(maintenanceMode.isActive(), false);
});

test("leave() releases an enter() that is still waiting", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  maintenanceMode.begin();
  const wait = track(maintenanceMode.enter("restore"));
  await flush();
  assert.equal(wait.settled, false);
  maintenanceMode.leave();
  await flush();
  assert.equal(wait.settled, true);
  assert.doesNotThrow(() => mock.timers.tick(20000), "the cleared timer does not fire");
});

test("the mode can be entered again after leave()", async () => {
  await maintenanceMode.enter("one");
  maintenanceMode.leave();
  await maintenanceMode.enter("two");
  assert.equal(maintenanceMode.isActive(), true);
  assert.equal(maintenanceMode.getReason(), "two");
});

test("done() counts once however many times it is called", () => {
  const first = maintenanceMode.begin();
  const second = maintenanceMode.begin();
  assert.equal(maintenanceMode.pending(), 2);
  first();
  first();
  first();
  assert.equal(maintenanceMode.pending(), 1);
  second();
  assert.equal(maintenanceMode.pending(), 0);
});

test("begin()/done() work with the mode off, as the pipeline always brackets", () => {
  const done = maintenanceMode.begin();
  assert.equal(typeof done, "function");
  assert.equal(maintenanceMode.pending(), 1);
  done();
  assert.equal(maintenanceMode.pending(), 0);
  assert.equal(maintenanceMode.isActive(), false);
});

test("try/finally bracket: a failing message still releases the wait", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const work = (async () => {
    const done = maintenanceMode.begin();
    try {
      throw new Error("message failed");
    } finally {
      done();
    }
  })();
  await assert.rejects(work, /message failed/);
  await maintenanceMode.enter("restore");
  assert.equal(maintenanceMode.pending(), 0);
});

test("a done() from before _reset() cannot unbalance the counter", () => {
  const stale = maintenanceMode.begin();
  maintenanceMode._reset();
  const fresh = maintenanceMode.begin();
  stale();
  assert.equal(maintenanceMode.pending(), 1);
  fresh();
  assert.equal(maintenanceMode.pending(), 0);
});
