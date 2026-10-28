"use strict";
/**
 * T038: the core bus (lib/utils/events.js).
 *
 *  - emitSafe calls every listener with the payload;
 *  - a throwing listener never throws into the emitter and never starves the next listeners;
 *  - a rejecting async listener is swallowed too (no unhandled rejection);
 *  - `once` listeners still remove themselves; the plain EventEmitter API keeps working.
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const bus = require("../lib/utils/events");

beforeEach(() => {
  bus.removeAllListeners();
});

test("the three documented topics are exported", () => {
  assert.deepEqual(
    Object.values(bus.TOPICS).sort(),
    ["command:error", "groupguard:action", "key:refused"],
  );
  assert.equal(typeof bus.emitSafe, "function");
});

test("emitSafe passes the payload to every listener, in order", () => {
  const seen = [];
  bus.on("command:error", (p) => seen.push(["a", p]));
  bus.on("command:error", (p) => seen.push(["b", p]));
  const payload = { name: "ping", at: 1 };
  assert.equal(bus.emitSafe("command:error", payload), true);
  assert.deepEqual(seen, [["a", payload], ["b", payload]]);
});

test("emitSafe without listeners returns false and does not throw", () => {
  assert.equal(bus.emitSafe("key:refused", { service: "openai", at: 1 }), false);
});

test("a throwing listener never throws into the emitter", () => {
  bus.on("key:refused", () => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => bus.emitSafe("key:refused", { service: "openai", at: 1 }));
});

test("listeners are isolated: a throwing one does not stop the following ones", () => {
  const calls = [];
  bus.on("groupguard:action", () => calls.push("first"));
  bus.on("groupguard:action", () => {
    calls.push("second");
    throw new TypeError("bad");
  });
  bus.on("groupguard:action", () => calls.push("third"));
  bus.emitSafe("groupguard:action", { rule: "r", groupJid: "g", userJid: "u", outcome: "removed" });
  assert.deepEqual(calls, ["first", "second", "third"]);
});

test("a rejecting async listener is swallowed (no unhandled rejection)", async () => {
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled++;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    let ran = false;
    bus.on("command:error", async () => {
      throw new Error("async boom");
    });
    bus.on("command:error", () => {
      ran = true;
    });
    assert.doesNotThrow(() => bus.emitSafe("command:error", { name: "x", at: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ran, true);
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a once listener runs a single time even when it throws", () => {
  let n = 0;
  bus.once("command:error", () => {
    n++;
    throw new Error("once boom");
  });
  bus.emitSafe("command:error", { name: "x", at: 1 });
  bus.emitSafe("command:error", { name: "x", at: 2 });
  assert.equal(n, 1);
  assert.equal(bus.listenerCount("command:error"), 0);
});

test("emitting the reserved 'error' topic without a listener does not throw", () => {
  assert.doesNotThrow(() => bus.emitSafe("error", new Error("nobody listens")));
});

test("a listener removed during the emit does not break the iteration", () => {
  const calls = [];
  const second = () => calls.push("second");
  bus.on("key:refused", () => {
    calls.push("first");
    bus.off("key:refused", second);
  });
  bus.on("key:refused", second);
  bus.emitSafe("key:refused", { service: "s", at: 1 });
  // emit semantics: the listener list is snapshotted before the first call
  assert.deepEqual(calls, ["first", "second"]);
});
