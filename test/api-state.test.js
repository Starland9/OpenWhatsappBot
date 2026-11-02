"use strict";
/**
 * lib/utils/apiState.js: the messaging API's switch and plain-HTTP network list (feature 004,
 * contracts/runtime.md section 13, data-model.md section 4), over the singleton `ApiState` row.
 *
 * In-memory SQLite built from the real model files (test/helpers/backupKit.js#makeDb); the module is a singleton,
 * so every test starts with `load()` on an emptied table. No network, no clock but explicit dates.
 */

const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { test, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const kit = require("./helpers/backupKit");
const config = require("../config");
const logger = require("../lib/utils/logger");
const apiState = require("../lib/utils/apiState");
const ipRules = require("../lib/api/ipRules");
const format = require("../lib/admin/backup/format");

let db;

before(async () => {
  db = await kit.makeDb();
});

after(async () => {
  if (db) await db.DATABASE.close();
});

beforeEach(async () => {
  config.ADMIN_PANEL = true; // setupEnv turns the panel off; the switch tests need it on
  await db.ApiState.destroy({ where: {} });
  await apiState.load({ models: db });
});

afterEach(() => {
  config.ADMIN_PANEL = undefined; // drop the runtime assignment
});

const NOW = new Date("2026-04-01T09:00:00.000Z");
const rowCount = () => db.ApiState.count();
const stored = async () => (await db.ApiState.findByPk(1)).get({ plain: true });

/** `models` whose ApiState counts the writes and can be made to fail */
function spiedModels({ failWrites = false, failReads = false } = {}) {
  const calls = [];
  const ApiState = {
    findByPk: (...args) => (failReads ? Promise.reject(new Error("read failed")) : db.ApiState.findByPk(...args)),
    upsert: (values, options) => {
      calls.push(values);
      return failWrites ? Promise.reject(new Error("disk full")) : db.ApiState.upsert(values, options);
    },
  };
  return { models: { ApiState }, calls };
}

describe("load and the read side", () => {
  test("no row means disabled with an empty list, and a read never creates one", async () => {
    assert.deepEqual({ ...apiState.get() }, { enabled: false, plainHttpFrom: [], updatedAt: null });
    assert.equal(apiState.isEnabled(), false);
    assert.deepEqual(apiState.plainHttpFrom(), []);
    await apiState.load({ models: db });
    apiState.get();
    apiState.isEnabled();
    apiState.plainHttpFrom();
    assert.equal(await rowCount(), 0, "the no-GET-writes rule of test/admin-security.test.js");
  });

  test("an existing row is loaded", async () => {
    await db.ApiState.create({ enabled: true, plainHttpFrom: ["10.0.0.0/8", "fd00::/8"] });
    await apiState.load({ models: db });
    const state = apiState.get();
    assert.equal(state.enabled, true);
    assert.deepEqual([...state.plainHttpFrom], ["10.0.0.0/8", "fd00::/8"]);
    assert.ok(state.updatedAt instanceof Date);
    assert.equal(apiState.isEnabled(), true);
    assert.deepEqual([...apiState.plainHttpFrom()], ["10.0.0.0/8", "fd00::/8"]);
  });

  test("a read failure means disabled, with a warning that names nothing secret", async () => {
    await db.ApiState.create({ enabled: true });
    await apiState.load({ models: db });
    assert.equal(apiState.isEnabled(), true);

    const lines = [];
    logger.setOutput((text) => lines.push(String(text)));
    logger.setLevel("warn");
    try {
      await apiState.load(spiedModels({ failReads: true }));
    } finally {
      logger.setLevel("silent");
      logger.setOutput();
    }
    assert.equal(apiState.isEnabled(), false, "fail closed");
    assert.deepEqual({ ...apiState.get() }, { enabled: false, plainHttpFrom: [], updatedAt: null });
    assert.equal(lines.length, 1, "one warning");
    assert.match(lines[0], /api/i);
  });

  test("get() is a frozen snapshot: nothing a caller does changes the state", async () => {
    await apiState.setPlainHttpFrom(["10.0.0.0/8"], { now: NOW });
    const snapshot = apiState.get();
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.plainHttpFrom));
    assert.throws(() => snapshot.plainHttpFrom.push("192.168.0.0/16"), TypeError);
    assert.throws(() => {
      snapshot.enabled = true;
    }, TypeError);
    assert.deepEqual([...apiState.plainHttpFrom()], ["10.0.0.0/8"]);
    assert.equal(apiState.isEnabled(), false);
    // an older snapshot is not rewritten by a later change
    await apiState.setEnabled(true, { now: NOW });
    assert.equal(snapshot.enabled, false);
    assert.equal(apiState.get().enabled, true);
  });

  test("ADMIN_PANEL=false forces isEnabled() false whatever the row says, read at call time (FR-007)", async () => {
    await apiState.setEnabled(true, { now: NOW });
    assert.equal(apiState.isEnabled(), true);
    config.ADMIN_PANEL = false;
    assert.equal(apiState.isEnabled(), false);
    assert.equal(apiState.get().enabled, true, "the row is not touched by the panel setting");
    assert.equal((await stored()).enabled, true);
    config.ADMIN_PANEL = true;
    assert.equal(apiState.isEnabled(), true);
  });
});

describe("setEnabled (alias set)", () => {
  test("persists, then memory, then the listeners", async () => {
    const seen = [];
    const off = apiState.onChange(async (change) => {
      seen.push({ ...change, inMemory: apiState.get().enabled, inDatabase: (await stored()).enabled });
    });
    try {
      const result = await apiState.setEnabled(true, { now: NOW });
      assert.deepEqual(result, { changed: true, enabled: true });
      assert.equal(seen.length, 1);
      assert.deepEqual([seen[0].enabled, seen[0].inMemory, seen[0].inDatabase], [true, true, true], "the row and memory are written before the listener runs");
      assert.deepEqual([...seen[0].plainHttpFrom], []);
      assert.equal(seen[0].previous.enabled, false);
      assert.equal(seen[0].previous.updatedAt, null);
    } finally {
      off();
    }
    const row = await stored();
    assert.deepEqual([row.id, row.enabled, row.plainHttpFrom, row.updatedAt.getTime()], [1, true, [], NOW.getTime()]);
    assert.equal(apiState.get().updatedAt.getTime(), NOW.getTime(), "updatedAt is the changed-at the panel shows");
    assert.equal(await rowCount(), 1);
  });

  test("the same state returns changed: false with no write and no listener call", async () => {
    const spy = spiedModels();
    await apiState.load(spy);
    let calls = 0;
    const off = apiState.onChange(() => calls++);
    try {
      assert.deepEqual(await apiState.setEnabled(false, { now: NOW }), { changed: false, enabled: false });
      assert.equal(spy.calls.length, 0, "an absent row and enabled: false is a no-op");
      assert.equal(await rowCount(), 0);

      assert.deepEqual(await apiState.setEnabled(true, { now: NOW }), { changed: true, enabled: true });
      assert.deepEqual(await apiState.setEnabled(true, { now: new Date(NOW.getTime() + 1000) }), { changed: false, enabled: true });
      assert.equal(spy.calls.length, 1);
      assert.equal(calls, 1);
      assert.equal((await stored()).updatedAt.getTime(), NOW.getTime(), "updatedAt is not bumped by a no-op");
    } finally {
      off();
    }
  });

  test("switching off writes the row and tells the listeners", async () => {
    await apiState.setEnabled(true, { now: NOW });
    const changes = [];
    const off = apiState.onChange((change) => changes.push(change));
    try {
      const later = new Date(NOW.getTime() + 60_000);
      assert.deepEqual(await apiState.setEnabled(false, { now: later }), { changed: true, enabled: false });
      assert.equal(changes.length, 1);
      assert.deepEqual([changes[0].enabled, changes[0].previous.enabled], [false, true]);
      assert.equal(apiState.isEnabled(), false);
      assert.equal((await stored()).updatedAt.getTime(), later.getTime());
    } finally {
      off();
    }
  });

  test("a failed write leaves memory unchanged and tells no listener", async () => {
    const spy = spiedModels({ failWrites: true });
    await apiState.load(spy);
    let calls = 0;
    const off = apiState.onChange(() => calls++);
    try {
      await assert.rejects(apiState.setEnabled(true, { now: NOW }), /disk full/);
      assert.equal(apiState.get().enabled, false);
      assert.equal(apiState.isEnabled(), false);
      assert.equal(calls, 0);
      assert.equal(await rowCount(), 0);
      await assert.rejects(apiState.setPlainHttpFrom(["10.0.0.0/8"], { now: NOW }), /disk full/);
      assert.deepEqual([...apiState.plainHttpFrom()], []);
    } finally {
      off();
    }
  });

  test("set is an alias of setEnabled; anything but a boolean is refused before a write", async () => {
    assert.equal(apiState.set, apiState.setEnabled);
    assert.deepEqual(await apiState.set(true, { now: NOW }), { changed: true, enabled: true });
    const spy = spiedModels();
    await apiState.load(spy);
    for (const bad of ["true", 1, null, undefined, {}]) {
      await assert.rejects(apiState.setEnabled(bad), (err) => err.code === "invalid_format", String(bad));
    }
    assert.equal(spy.calls.length, 0);
    assert.equal(apiState.get().enabled, true);
  });
});

describe("setPlainHttpFrom", () => {
  test("stores the canonical strings, in order, without repeats", async () => {
    const result = await apiState.setPlainHttpFrom([" 10.1.2.3/8 ", "192.168.1.5", "FD00::1", "10.0.0.0/8", "::ffff:172.16.0.1"], { now: NOW });
    assert.deepEqual(result, { changed: true, plainHttpFrom: ["10.0.0.0/8", "192.168.1.5", "fd00::1", "172.16.0.1"] });
    assert.deepEqual([...apiState.plainHttpFrom()], result.plainHttpFrom);
    const row = await stored();
    assert.deepEqual(row.plainHttpFrom, result.plainHttpFrom);
    assert.ok(Array.isArray(row.plainHttpFrom));
    assert.equal(row.enabled, false, "the other column keeps its value");
    assert.equal(row.updatedAt.getTime(), NOW.getTime());
  });

  test("persists, then memory, then the listeners, which see the previous list", async () => {
    await apiState.setPlainHttpFrom(["10.0.0.0/8"], { now: NOW });
    const seen = [];
    const off = apiState.onChange(async (change) => seen.push({ change, row: await stored() }));
    try {
      await apiState.setPlainHttpFrom(["192.168.0.0/16", "100.64.0.0/10"], { now: NOW });
    } finally {
      off();
    }
    assert.equal(seen.length, 1);
    assert.deepEqual([...seen[0].change.plainHttpFrom], ["192.168.0.0/16", "100.64.0.0/10"]);
    assert.deepEqual([...seen[0].change.previous.plainHttpFrom], ["10.0.0.0/8"]);
    assert.deepEqual(seen[0].row.plainHttpFrom, ["192.168.0.0/16", "100.64.0.0/10"]);
  });

  test("the same list, once canonical, is changed: false with no write", async () => {
    await apiState.setPlainHttpFrom(["10.0.0.0/8", "192.168.0.0/16"], { now: NOW });
    const spy = spiedModels();
    await apiState.load(spy);
    let calls = 0;
    const off = apiState.onChange(() => calls++);
    try {
      assert.deepEqual(await apiState.setPlainHttpFrom(["10.9.9.9/8", "192.168.0.0/16"], { now: NOW }), { changed: false, plainHttpFrom: ["10.0.0.0/8", "192.168.0.0/16"] });
      assert.equal(spy.calls.length, 0);
      assert.equal(calls, 0);
      // another order is another list
      assert.equal((await apiState.setPlainHttpFrom(["192.168.0.0/16", "10.0.0.0/8"], { now: NOW })).changed, true);
    } finally {
      off();
    }
  });

  test("an empty list is allowed (strict again) and an empty list on no row is a no-op", async () => {
    const spy = spiedModels();
    await apiState.load(spy);
    assert.deepEqual(await apiState.setPlainHttpFrom([], { now: NOW }), { changed: false, plainHttpFrom: [] });
    assert.equal(spy.calls.length, 0);
    await apiState.setPlainHttpFrom(["10.0.0.0/8"], { now: NOW });
    assert.deepEqual(await apiState.setPlainHttpFrom([], { now: NOW }), { changed: true, plainHttpFrom: [] });
    assert.deepEqual((await stored()).plainHttpFrom, []);
  });

  const REFUSED = [
    ["a loopback address", ["127.0.0.1"]],
    ["the IPv4 loopback range", ["127.0.0.0/8"]],
    ["the IPv6 loopback", ["::1"]],
    ["a public address", ["8.8.8.8"]],
    ["a public range", ["203.0.113.0/24"]],
    ["any IPv4 address", ["0.0.0.0/0"]],
    ["any IPv6 address", ["::/0"]],
    ["a range that spills out of a private block", ["10.0.0.0/7"]],
    ["a link-local range", ["fe80::/10"]],
  ];
  for (const [name, list] of REFUSED) {
    test(`refuses ${name}: invalid_format with the index and not_private, nothing written`, async () => {
      const spy = spiedModels();
      await apiState.load(spy);
      let calls = 0;
      const off = apiState.onChange(() => calls++);
      try {
        await assert.rejects(apiState.setPlainHttpFrom(["10.0.0.0/8", ...list], { now: NOW }), (err) => {
          assert.ok(err instanceof Error);
          assert.equal(err.code, "invalid_format");
          assert.deepEqual(err.params, { indices: [1], reason: "not_private" });
          assert.doesNotMatch(err.message, new RegExp(list[0].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), "the submitted value is never echoed");
          return true;
        });
        assert.equal(spy.calls.length, 0, "validated before any write");
        assert.equal(calls, 0);
        assert.deepEqual([...apiState.plainHttpFrom()], []);
        assert.equal(await rowCount(), 0);
      } finally {
        off();
      }
    });
  }

  test("a syntax error is invalid_format with its indices and no reason, and wins over a public range", async () => {
    await assert.rejects(apiState.setPlainHttpFrom(["10.0.0.0/8", "nope", "8.8.8.8", "", "1.2.3.4/99"]), (err) => {
      assert.equal(err.code, "invalid_format");
      assert.deepEqual(err.params, { indices: [1, 3, 4] });
      assert.equal("reason" in err.params, false);
      return true;
    });
    assert.equal(await rowCount(), 0);
  });

  test("more than 20 entries are refused with the indices past the limit", async () => {
    const entries = (n) => Array.from({ length: n }, (_, i) => `10.${i}.0.0/16`);
    assert.equal((await apiState.setPlainHttpFrom(entries(20), { now: NOW })).changed, true);
    assert.equal(apiState.plainHttpFrom().length, 20);
    await assert.rejects(apiState.setPlainHttpFrom(entries(23), { now: NOW }), (err) => {
      assert.equal(err.code, "invalid_format");
      assert.deepEqual(err.params, { indices: [20, 21, 22], reason: "too_many" });
      return true;
    });
    assert.equal(apiState.plainHttpFrom().length, 20, "unchanged");
    // repeats do not count towards the limit
    await apiState.setPlainHttpFrom([...entries(20), ...entries(20)], { now: NOW });
  });

  test("anything that is not a list of strings is refused", async () => {
    for (const bad of ["10.0.0.0/8", null, undefined, {}, 5]) {
      await assert.rejects(apiState.setPlainHttpFrom(bad), (err) => err.code === "invalid_format", String(bad));
    }
    await assert.rejects(apiState.setPlainHttpFrom([5]), (err) => err.code === "invalid_format" && err.params.indices[0] === 0);
    assert.equal(await rowCount(), 0);
  });

  test("widening detection is ipRules.covers against the stored list (the step-up of the panel)", async () => {
    await apiState.setPlainHttpFrom(["10.0.0.0/8", "fd00::/8"], { now: NOW });
    const stored_ = [...apiState.plainHttpFrom()];
    const widens = (list) => ipRules.parse(list, { privateOnly: true }).entries.some((entry) => !ipRules.covers(stored_, entry));
    assert.equal(widens(["10.1.0.0/16"]), false, "narrowing");
    assert.equal(widens(["10.0.0.0/8", "fd00:1::/32"]), false);
    assert.equal(widens(["10.0.0.0/8", "192.168.0.0/16"]), true, "a new network");
    assert.equal(widens(["10.0.0.0/8", "172.16.0.0/12"]), true);
    assert.equal(widens([]), false, "removing everything is never a widening");
  });
});

describe("setState: both fields in one statement", () => {
  test("writes the enabled flag and the list together, once", async () => {
    const spy = spiedModels();
    await apiState.load(spy);
    const seen = [];
    const off = apiState.onChange((change) => seen.push(change));
    try {
      const result = await apiState.setState({ enabled: true, plainHttpFrom: ["10.0.0.0/8"] }, { now: NOW });
      assert.deepEqual(result, { changed: true, enabled: true, plainHttpFrom: ["10.0.0.0/8"] });
      assert.equal(spy.calls.length, 1, "one statement");
      assert.deepEqual(Object.keys(spy.calls[0]).sort(), ["enabled", "id", "plainHttpFrom", "updatedAt"]);
      assert.equal(seen.length, 1, "one notification");
      assert.deepEqual([seen[0].enabled, [...seen[0].plainHttpFrom]], [true, ["10.0.0.0/8"]]);
      // only what changed is written
      await apiState.setState({ enabled: true, plainHttpFrom: ["192.168.0.0/16"] }, { now: NOW });
      assert.deepEqual(Object.keys(spy.calls[1]).sort(), ["id", "plainHttpFrom", "updatedAt"]);
      assert.deepEqual(await apiState.setState({ enabled: true, plainHttpFrom: ["192.168.0.0/16"] }, { now: NOW }), { changed: false, enabled: true, plainHttpFrom: ["192.168.0.0/16"] });
      assert.equal(spy.calls.length, 2);
    } finally {
      off();
    }
    // a refused list stops the whole change, the switch included
    await assert.rejects(apiState.setState({ enabled: false, plainHttpFrom: ["8.8.8.8"] }, { now: NOW }), (err) => err.code === "invalid_format");
    assert.equal(apiState.get().enabled, true);
  });
});

describe("listeners and concurrency", () => {
  test("onChange returns off(); listeners run in order, each isolated from the others and from the write", async () => {
    const order = [];
    const offs = [
      apiState.onChange(() => order.push("first")),
      apiState.onChange(() => {
        order.push("throws");
        throw new Error("listener bug");
      }),
      apiState.onChange(async () => {
        order.push("rejects");
        throw new Error("async listener bug");
      }),
      apiState.onChange(() => order.push("last")),
    ];
    try {
      const result = await apiState.setEnabled(true, { now: NOW });
      assert.deepEqual(result, { changed: true, enabled: true }, "the write succeeded");
      assert.deepEqual(order, ["first", "throws", "rejects", "last"]);
      assert.equal(apiState.get().enabled, true);
    } finally {
      offs.forEach((off) => off());
    }

    order.length = 0;
    const off = apiState.onChange(() => order.push("one"));
    off();
    off(); // idempotent
    await apiState.setEnabled(false, { now: NOW });
    assert.deepEqual(order, []);
  });

  test("onChange refuses a non-function", () => {
    for (const bad of [undefined, null, "fn", {}]) assert.throws(() => apiState.onChange(bad), TypeError);
  });

  test("concurrent changes are applied one after the other: memory ends equal to the row", async () => {
    await Promise.all([
      apiState.setEnabled(true, { now: NOW }),
      apiState.setPlainHttpFrom(["10.0.0.0/8"], { now: NOW }),
      apiState.setEnabled(false, { now: NOW }),
      apiState.setPlainHttpFrom(["192.168.0.0/16"], { now: NOW }),
      apiState.setEnabled(true, { now: NOW }),
    ]);
    const row = await stored();
    assert.deepEqual([apiState.get().enabled, [...apiState.plainHttpFrom()]], [row.enabled, row.plainHttpFrom]);
    assert.deepEqual([row.enabled, row.plainHttpFrom], [true, ["192.168.0.0/16"]]);
    assert.equal(await rowCount(), 1);
  });
});

describe("what a restore and the module's layering guarantee", () => {
  test("ApiState is excluded from backups, so a restore can neither switch the API on nor widen the list", () => {
    assert.ok(format.EXCLUDED_MODELS.includes("ApiState"));
    assert.ok(!format.MODELS.includes("ApiState"));
  });

  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "utils", "apiState.js"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("it requires no lib/admin and, at load, no lib/api: ipRules is required lazily inside setPlainHttpFrom (RT-01)", () => {
    const requires = [...code.matchAll(/^(\s*).*\brequire\(\s*["']([^"']+)["']\s*\)/gm)].map((m) => ({ indent: m[1].length, target: m[2] }));
    assert.ok(requires.length > 0);
    for (const { target } of requires) assert.doesNotMatch(target, /admin/, `${target} must not be required`);
    for (const { indent, target } of requires.filter((r) => /api\//.test(r.target))) {
      assert.ok(indent > 0, `${target} must be required inside a function, not at load`);
      assert.match(target, /api\/ipRules$/);
    }
  });

  test("no timer, no listener and no query at load; config is read at call time (RT-02, RT-03)", () => {
    assert.doesNotMatch(code, /setTimeout|setInterval/);
    assert.doesNotMatch(code, /^(const|let|var)\s+\w+\s*=\s*config\./m, "no module-level copy of a setting");
    assert.doesNotMatch(code, /^(?:await\s+)?[\w.]*\.(findAll|findByPk|findOne|upsert)\(/m, "no query at the top level");
  });
});
