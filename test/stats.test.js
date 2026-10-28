"use strict";
/**
 * lib/utils/stats.js (specs/002-admin-panel T011, data-model 1.8, runtime.md section 5).
 *
 *  - counters accumulate in memory; flush() is ONE multi-row upsert and two flushes add up;
 *  - `day` is the local date in TIMEZONE (invalid zone falls back to UTC);
 *  - 5000 distinct keys trigger an early flush; a failing flush keeps the counters;
 *  - flush() is skipped while maintenance mode is active;
 *  - messagesByDay / topCommands / failingCommands / topGroups over the 7-day window;
 *  - stop() flushes; no timer exists before start().
 *
 * In-memory database, no network, fake clocks through the `now` arguments.
 */

const { test, describe, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv();
const stats = require("../lib/utils/stats");

let db;

const DAY = 24 * 60 * 60 * 1000;
// 2026-01-10 12:00 UTC, midday so that every zone from UTC-11 to UTC+11 is on the same date
const NOON = Date.UTC(2026, 0, 10, 12, 0, 0);

const rows = async () =>
  (await db.DailyStat.findAll({ order: [["day", "ASC"], ["metric", "ASC"], ["subject", "ASC"]], raw: true })).map(
    ({ day, metric, subject, count }) => ({ day, metric, subject, count }),
  );

const setZone = (zone) => {
  config.TIMEZONE = zone;
};

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  stats._reset();
  setZone("UTC");
  await db.DailyStat.destroy({ where: {} });
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  stats._reset();
  setZone("UTC");
});

describe("counting and flushing", () => {
  test("counters accumulate in memory and nothing is written before flush()", async () => {
    stats.count("messages", "", 1, NOON);
    stats.count("messages", "", 1, NOON);
    stats.count("messages", "", 3, NOON);
    stats.count("cmd_ok", "ping", 1, NOON);
    assert.equal(stats.pendingKeys(), 2, "two distinct keys");
    assert.deepEqual(await rows(), []);

    assert.equal(await stats.flush(), 2);
    assert.equal(stats.pendingKeys(), 0);
    assert.deepEqual(await rows(), [
      { day: "2026-01-10", metric: "cmd_ok", subject: "ping", count: 1 },
      { day: "2026-01-10", metric: "messages", subject: "", count: 5 },
    ]);
  });

  test("flush() is one multi-row upsert with the ON CONFLICT ... count + excluded.count rule", async () => {
    stats.count("messages", "", 1, NOON);
    stats.count("group_msgs", "120363@g.us", 1, NOON);
    stats.count("cmd_ok", "ping", 1, NOON);
    stats.count("cmd_fail", "play", 1, NOON);

    const query = mock.method(db.DATABASE, "query");
    await stats.flush();
    assert.equal(query.mock.calls.length, 1, "a single statement for the four keys");
    const sql = query.mock.calls[0].arguments[0];
    assert.match(sql, /^INSERT INTO "daily_stats" \("day","metric","subject","count"\) VALUES \(\?,\?,\?,\?\),\(\?,\?,\?,\?\),\(\?,\?,\?,\?\),\(\?,\?,\?,\?\) /);
    assert.match(sql, /ON CONFLICT \("day","metric","subject"\) DO UPDATE SET "count" = "daily_stats"\."count" \+ excluded\."count"$/);
    assert.equal((await rows()).length, 4);
  });

  test("two flushes add up (the second one updates the existing rows)", async () => {
    stats.count("cmd_ok", "ping", 2, NOON);
    stats.count("messages", "", 1, NOON);
    await stats.flush();
    stats.count("cmd_ok", "ping", 3, NOON);
    stats.count("cmd_ok", "menu", 1, NOON);
    await stats.flush();
    assert.deepEqual(await rows(), [
      { day: "2026-01-10", metric: "cmd_ok", subject: "menu", count: 1 },
      { day: "2026-01-10", metric: "cmd_ok", subject: "ping", count: 5 },
      { day: "2026-01-10", metric: "messages", subject: "", count: 1 },
    ]);
  });

  test("an empty flush writes nothing", async () => {
    const query = mock.method(db.DATABASE, "query");
    assert.equal(await stats.flush(), 0);
    assert.equal(query.mock.calls.length, 0);
  });

  test("count() never throws and ignores what is not a counter", async () => {
    assert.doesNotThrow(() => {
      stats.count("unknown_metric", "x", 1, NOON);
      stats.count("cmd_ok", "x", 0, NOON);
      stats.count("cmd_ok", "x", -2, NOON);
      stats.count("cmd_ok", "x", Number.NaN, NOON);
      stats.count(undefined);
      stats.count("cmd_ok", { toString: () => { throw new Error("boom"); } }, 1, NOON);
    });
    assert.equal(stats.pendingKeys(), 0);
    stats.count("cmd_ok", undefined, 1, NOON);
    stats.count("cmd_ok", "x".repeat(400), 1, NOON);
    await stats.flush();
    const stored = await rows();
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map((r) => r.subject.length).sort((a, b) => a - b), [0, 255]);
  });

  test("a failing flush keeps the counters for the next attempt", async () => {
    stats.count("cmd_ok", "ping", 4, NOON);
    mock.method(db.DATABASE, "query", async () => {
      throw new Error("database is down");
    }, { times: 1 });
    assert.equal(await stats.flush(), 0, "flush() never rejects");
    assert.equal(stats.pendingKeys(), 1);
    assert.deepEqual(await rows(), []);

    mock.restoreAll();
    stats.count("cmd_ok", "ping", 1, NOON);
    assert.equal(await stats.flush(), 1);
    assert.deepEqual(await rows(), [{ day: "2026-01-10", metric: "cmd_ok", subject: "ping", count: 5 }]);
  });
});

describe("day bucket in TIMEZONE", () => {
  // 23:30 UTC on the 10th is already 00:30 on the 11th in Africa/Douala (UTC+1)
  const LATE = Date.UTC(2026, 0, 10, 23, 30, 0);

  test("the local date of the configured zone, not the UTC date", async () => {
    setZone("UTC");
    stats.count("messages", "", 1, LATE);
    setZone("Africa/Douala");
    stats.count("messages", "", 1, LATE);
    assert.equal(stats.dayOf(LATE), "2026-01-11");
    await stats.flush();
    assert.deepEqual(await rows(), [
      { day: "2026-01-10", metric: "messages", subject: "", count: 1 },
      { day: "2026-01-11", metric: "messages", subject: "", count: 1 },
    ]);
  });

  test("an invalid zone falls back to UTC", () => {
    setZone("Mars/Olympus_Mons");
    assert.equal(stats.dayOf(LATE), "2026-01-10");
    setZone("");
    assert.equal(stats.dayOf(LATE), "2026-01-10");
  });

  test("a Date is accepted as `now`", () => {
    setZone("Africa/Douala");
    assert.equal(stats.dayOf(new Date(LATE)), "2026-01-11");
  });
});

describe("bound and maintenance mode", () => {
  test("5000 distinct keys trigger an early flush, the map is swapped at once", async () => {
    for (let i = 0; i < stats.MAX_KEYS - 1; i++) stats.count("group_msgs", `g${i}@g.us`, 1, NOON);
    assert.equal(stats.pendingKeys(), stats.MAX_KEYS - 1, "no flush below the bound");
    assert.equal(await db.DailyStat.count(), 0);

    stats.count("group_msgs", "last@g.us", 1, NOON);
    assert.equal(stats.pendingKeys(), 0, "the 5000th key started a flush");
    await stats.flush(); // waits for the flush in flight
    assert.equal(await db.DailyStat.count(), stats.MAX_KEYS);
  });

  test("an existing key never counts against the bound", () => {
    for (let i = 0; i < 10000; i++) stats.count("messages", "", 1, NOON);
    assert.equal(stats.pendingKeys(), 1);
  });

  test("flush() is skipped while maintenance mode is active, and the counters survive", async () => {
    let active = true;
    stats._setMaintenanceProbe(() => active);
    stats.count("cmd_ok", "ping", 1, NOON);

    const query = mock.method(db.DATABASE, "query");
    assert.equal(await stats.flush(), 0);
    assert.equal(query.mock.calls.length, 0);
    assert.equal(stats.pendingKeys(), 1);
    assert.deepEqual(await rows(), []);

    active = false;
    assert.equal(await stats.flush(), 1);
    assert.deepEqual(await rows(), [{ day: "2026-01-10", metric: "cmd_ok", subject: "ping", count: 1 }]);
  });

  test("a missing maintenanceMode module counts as not active", async () => {
    stats._setMaintenanceProbe(() => {
      throw new Error("Cannot find module './maintenanceMode'");
    });
    stats.count("cmd_ok", "ping", 1, NOON);
    assert.equal(await stats.flush(), 1);
  });
});

describe("panel queries over the 7-day window", () => {
  const at = (daysAgo, hour = 12) => NOON - daysAgo * DAY + (hour - 12) * 60 * 60 * 1000;

  async function seed() {
    // today = 2026-01-10; the window is 2026-01-04 .. 2026-01-10
    stats.count("messages", "", 4, at(0));
    stats.count("messages", "", 2, at(0, 20));
    stats.count("messages", "", 7, at(2));
    stats.count("messages", "", 1, at(6)); // 2026-01-04, first day of the window
    stats.count("messages", "", 99, at(7)); // 2026-01-03, outside
    stats.count("messages", "", 99, at(30)); // outside

    stats.count("cmd_ok", "ping", 5, at(0));
    stats.count("cmd_ok", "ping", 3, at(6));
    stats.count("cmd_ok", "menu", 6, at(1));
    stats.count("cmd_ok", "sticker", 2, at(3));
    stats.count("cmd_ok", "old", 100, at(7)); // outside

    stats.count("cmd_fail", "play", 4, at(0));
    stats.count("cmd_fail", "play", 1, at(5));
    stats.count("cmd_fail", "weather", 2, at(1));
    stats.count("cmd_fail", "old", 50, at(8)); // outside

    stats.count("group_msgs", "120363000000000001@g.us", 10, at(0));
    stats.count("group_msgs", "120363000000000002@g.us", 30, at(1));
    stats.count("group_msgs", "120363000000000002@g.us", 5, at(2));
    stats.count("group_msgs", "120363000000000003@g.us", 99, at(9)); // outside
    await stats.flush();
  }

  test("messagesByDay: 7 entries, zero-filled, oldest first, today included", async () => {
    await seed();
    assert.deepEqual(await stats.messagesByDay(7, { now: NOON }), [
      { day: "2026-01-04", messages: 1 },
      { day: "2026-01-05", messages: 0 },
      { day: "2026-01-06", messages: 0 },
      { day: "2026-01-07", messages: 0 },
      { day: "2026-01-08", messages: 7 },
      { day: "2026-01-09", messages: 0 },
      { day: "2026-01-10", messages: 6 },
    ]);
    assert.equal((await stats.messagesByDay(3, { now: NOON })).length, 3);
    assert.equal((await stats.messagesByDay(undefined, { now: NOON })).length, 7, "7 days by default");
  });

  test("topCommands counts cmd_ok per command, most used first, within the window", async () => {
    await seed();
    assert.deepEqual(await stats.topCommands(10, 7, { now: NOON }), [
      { name: "ping", count: 8 },
      { name: "menu", count: 6 },
      { name: "sticker", count: 2 },
    ]);
    assert.deepEqual(await stats.topCommands(1, 7, { now: NOON }), [{ name: "ping", count: 8 }]);
    // a shorter window drops the oldest occurrences
    assert.deepEqual(await stats.topCommands(10, 2, { now: NOON }), [
      { name: "menu", count: 6 },
      { name: "ping", count: 5 },
    ]);
  });

  test("failingCommands counts cmd_fail only; a command that always fails shows only there", async () => {
    await seed();
    assert.deepEqual(await stats.failingCommands(7, { now: NOON }), [
      { name: "play", count: 5 },
      { name: "weather", count: 2 },
    ]);
    const ok = (await stats.topCommands(10, 7, { now: NOON })).map((c) => c.name);
    assert.ok(!ok.includes("play") && !ok.includes("weather"));
  });

  test("topGroups counts group_msgs per group JID, most active first", async () => {
    await seed();
    assert.deepEqual(await stats.topGroups(10, 7, { now: NOON }), [
      { jid: "120363000000000002@g.us", count: 35 },
      { jid: "120363000000000001@g.us", count: 10 },
    ]);
    assert.deepEqual(await stats.topGroups(1, 7, { now: NOON }), [{ jid: "120363000000000002@g.us", count: 35 }]);
  });

  test("the window follows the local days of TIMEZONE", async () => {
    setZone("Africa/Douala"); // 23:30 UTC on the 10th = 00:30 on the 11th
    const late = Date.UTC(2026, 0, 10, 23, 30, 0);
    stats.count("messages", "", 2, late);
    await stats.flush();
    const days = await stats.messagesByDay(7, { now: late });
    assert.equal(days[6].day, "2026-01-11");
    assert.equal(days[6].messages, 2);
    assert.equal(days[0].day, "2026-01-05");
  });

  test("queries answer an empty window with zeros and empty lists", async () => {
    const days = await stats.messagesByDay(7, { now: NOON });
    assert.equal(days.length, 7);
    assert.ok(days.every((d) => d.messages === 0));
    assert.deepEqual(await stats.topCommands(10, 7, { now: NOON }), []);
    assert.deepEqual(await stats.failingCommands(7, { now: NOON }), []);
    assert.deepEqual(await stats.topGroups(10, 7, { now: NOON }), []);
  });
});

describe("timer", () => {
  test("no timer exists before start(); start() is idempotent and unref'd; stop() flushes and clears it", async () => {
    const realSetInterval = global.setInterval;
    let handle = null;
    const setIntervalSpy = mock.method(global, "setInterval", (fn, ms) => {
      handle = realSetInterval(fn, ms);
      mock.method(handle, "unref");
      return handle;
    });
    const clearIntervalSpy = mock.method(global, "clearInterval");

    stats.count("cmd_ok", "ping", 1, NOON);
    assert.equal(setIntervalSpy.mock.calls.length, 0, "nothing scheduled by require or count");

    stats.start();
    stats.start();
    assert.equal(setIntervalSpy.mock.calls.length, 1, "start() is idempotent");
    assert.equal(setIntervalSpy.mock.calls[0].arguments[1], 30000);
    assert.equal(handle.unref.mock.calls.length, 1, "the timer is unref'd");
    assert.equal(handle.hasRef(), false);

    await stats.stop();
    assert.equal(clearIntervalSpy.mock.calls.length, 1);
    assert.deepEqual(await rows(), [{ day: "2026-01-10", metric: "cmd_ok", subject: "ping", count: 1 }]);

    await stats.stop();
    assert.equal(clearIntervalSpy.mock.calls.length, 1, "a second stop() has nothing to clear");
  });

  test("the timer flushes every 30 s", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    stats.start();
    stats.count("cmd_ok", "ping", 2, NOON);

    mock.timers.tick(29999);
    assert.equal(stats.pendingKeys(), 1, "not yet");
    mock.timers.tick(1);
    assert.equal(stats.pendingKeys(), 0, "the 30 s tick flushed");
    await stats.flush(); // waits for the write
    assert.deepEqual(await rows(), [{ day: "2026-01-10", metric: "cmd_ok", subject: "ping", count: 2 }]);

    stats.count("cmd_ok", "ping", 1, NOON);
    mock.timers.tick(30000);
    await stats.flush();
    assert.deepEqual(await rows(), [{ day: "2026-01-10", metric: "cmd_ok", subject: "ping", count: 3 }]);
  });
});
