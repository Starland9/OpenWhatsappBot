"use strict";
/**
 * STAT-1 `GET /admin/api/stats` (US7, FR-035): messages per day over 7 days (zero-filled, oldest first, in the
 * bot's TIMEZONE), the 10 most used commands (`cmd_ok`), the failing commands (`cmd_fail`) and the 10 most
 * active groups with their names. The window is today and the 6 previous local days. Offline: in-memory
 * database, the real counters of lib/utils/stats.js, a fake clock.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { createFakeRuntime } = require("./helpers/fakeBotRuntime");
const { createClock } = require("./helpers/fakeClock");
const stats = require("../lib/utils/stats");
const botConfig = require("../config");
const settingsStore = require("../lib/utils/settingsStore");
const { createStatsService } = require("../lib/admin/services/stats");

const DAY = 24 * 60 * 60 * 1000;
// 23:30 UTC on 10 March is already 11 March in Africa/Douala (UTC+1, no daylight saving)
const NIGHT = Date.UTC(2026, 2, 10, 23, 30, 0);
const group = (n) => `1203630${String(n).padStart(5, "0")}@g.us`;

let t;
let client;
let rt;

async function boot({ zone = "Africa/Douala", start = NIGHT, deps = {}, config } = {}) {
  botConfig.TIMEZONE = zone;
  stats._reset();
  const db = await fakes.syncDb();
  await db.DailyStat.destroy({ where: {}, truncate: true });
  await db.KnownChat.destroy({ where: {}, truncate: true });
  rt = createFakeRuntime();
  t = await createTestAdmin({ clock: createClock(start), config: { TIMEZONE: zone, ...config }, deps: { runtime: rt, stats, dbProbe: async () => true, ...deps } });
  await t.admin.start();
  client = await t.loginClient();
  return t;
}

afterEach(async () => {
  if (t) await t.close();
  t = null;
  stats._reset();
  settingsStore.clearRuntime("TIMEZONE");
});

const getStats = async () => {
  const res = await client.get("/admin/api/stats");
  assert.equal(res.status, 200, res.text);
  return res.json;
};

/** Count an event on a given instant (the day bucket is the local date of that instant). */
const count = (metric, subject, n, at) => stats.count(metric, subject, n, at);

describe("STAT-1", () => {
  test("session-authenticated GET that needs the database", async () => {
    await boot();
    const route = t.admin.routes().find((r) => r.path === "/admin/api/stats");
    assert.deepEqual({ method: route.method, auth: route.auth, db: route.db, touch: route.touch, mutates: route.mutates }, { method: "GET", auth: "session", db: null, touch: true, mutates: false });
    assert.equal((await t.client().get("/admin/api/stats")).status, 401);
    rt.dbReady = false;
    const early = await client.get("/admin/api/stats");
    assert.equal(early.status, 503);
    assert.equal(early.json.error.code, "starting");
  });

  test("the shape: timezone, exactly 7 zero-filled days oldest first, and the three lists", async () => {
    await boot();
    const body = await getStats();
    assert.deepEqual(Object.keys(body).sort(), ["days", "failedCommands", "timezone", "topCommands", "topGroups"]);
    assert.equal(body.timezone, "Africa/Douala");
    assert.deepEqual(body.days, [
      { day: "2026-03-05", messages: 0 },
      { day: "2026-03-06", messages: 0 },
      { day: "2026-03-07", messages: 0 },
      { day: "2026-03-08", messages: 0 },
      { day: "2026-03-09", messages: 0 },
      { day: "2026-03-10", messages: 0 },
      { day: "2026-03-11", messages: 0 },
    ]);
    assert.deepEqual([body.topCommands, body.failedCommands, body.topGroups], [[], [], []]);
  });

  test("the days are the local days of TIMEZONE: 23:30 UTC is already tomorrow in Africa/Douala", async () => {
    await boot();
    count("messages", "", 4, NIGHT); // 23:30 UTC on the 10th = 00:30 on the 11th in Douala
    count("messages", "", 3, NIGHT - HOURS(2)); // 21:30 UTC = 22:30 on the 10th
    count("messages", "", 2, NIGHT - DAY - HOURS(2)); // 21:30 UTC on the 9th = 22:30 on the 9th
    await stats.flush();
    const { days } = await getStats();
    assert.deepEqual(days.map((d) => d.messages), [0, 0, 0, 0, 2, 3, 4]);
  });

  test("the same instants in UTC fall on the other days, and the window follows", async () => {
    await boot({ zone: "UTC" });
    count("messages", "", 4, NIGHT);
    count("messages", "", 3, NIGHT - HOURS(2));
    await stats.flush();
    const body = await getStats();
    assert.equal(body.timezone, "UTC");
    assert.equal(body.days[0].day, "2026-03-04");
    assert.equal(body.days[6].day, "2026-03-10");
    assert.equal(body.days[6].messages, 7);
  });

  test("an invalid TIMEZONE reads as UTC", async () => {
    await boot({ zone: "Not/AZone" });
    const body = await getStats();
    assert.equal(body.timezone, "UTC");
    assert.equal(body.days.length, 7);
    assert.equal(body.days[6].day, "2026-03-10");
  });

  test("messages are summed per day over the window; older and future days are ignored", async () => {
    await boot();
    for (let back = 0; back < 7; back += 1) count("messages", "", back + 1, NIGHT - back * DAY);
    count("messages", "", 500, NIGHT - 7 * DAY); // eight days ago: out of the window
    count("messages", "", 600, NIGHT + 3 * DAY); // in the future: out of the window
    await stats.flush();
    const { days } = await getStats();
    assert.deepEqual(days.map((d) => d.messages), [7, 6, 5, 4, 3, 2, 1]);
  });

  test("counters not yet flushed are included (the route flushes first)", async () => {
    await boot();
    count("messages", "", 9, NIGHT);
    count("cmd_fail", "weather", 2, NIGHT);
    assert.equal(stats.pendingKeys(), 2);
    const body = await getStats();
    assert.equal(body.days[6].messages, 9);
    assert.deepEqual(body.failedCommands, [{ name: "weather", count: 2 }]);
    assert.equal(stats.pendingKeys(), 0);
  });

  test("the 10 most used commands (cmd_ok), most used first, ties by name", async () => {
    await boot();
    for (let i = 1; i <= 12; i += 1) count("cmd_ok", `cmd${String(i).padStart(2, "0")}`, i, NIGHT);
    count("cmd_ok", "cmd01", 5, NIGHT - DAY); // 1 + 5 = 6, ties with cmd06
    await stats.flush();
    const { topCommands } = await getStats();
    assert.equal(topCommands.length, 10);
    assert.deepEqual(topCommands.slice(0, 3), [
      { name: "cmd12", count: 12 },
      { name: "cmd11", count: 11 },
      { name: "cmd10", count: 10 },
    ]);
    assert.deepEqual(topCommands.slice(6, 8), [{ name: "cmd01", count: 6 }, { name: "cmd06", count: 6 }]);
    assert.ok(!topCommands.some((c) => c.name === "cmd02"), "cmd02 and cmd03 are out of the first ten");
    for (const entry of topCommands) assert.deepEqual(Object.keys(entry), ["name", "count"]);
  });

  test("a command that always fails is only in failedCommands; one that sometimes fails is in both", async () => {
    await boot();
    count("cmd_fail", "broken", 7, NIGHT);
    count("cmd_ok", "shaky", 10, NIGHT);
    count("cmd_fail", "shaky", 3, NIGHT);
    count("cmd_ok", "fine", 20, NIGHT);
    await stats.flush();
    const body = await getStats();
    assert.deepEqual(body.failedCommands, [{ name: "broken", count: 7 }, { name: "shaky", count: 3 }]);
    assert.deepEqual(body.topCommands.map((c) => c.name), ["fine", "shaky"]);
    assert.ok(!body.topCommands.some((c) => c.name === "broken"));
  });

  test("the failing commands are bounded", async () => {
    await boot();
    for (let i = 1; i <= 80; i += 1) count("cmd_fail", `f${String(i).padStart(2, "0")}`, i, NIGHT);
    await stats.flush();
    const { failedCommands } = await getStats();
    assert.equal(failedCommands.length, 50);
    assert.equal(failedCommands[0].name, "f80");
  });

  test("the 10 most active groups, with their names from the chats snapshot; an unknown group has name null", async () => {
    await boot();
    const db = t.db;
    for (let i = 1; i <= 12; i += 1) count("group_msgs", group(i), i * 10, NIGHT);
    await stats.flush();
    await db.KnownChat.bulkCreate([
      { jid: group(12), kind: "group", name: "Family", firstSeenAt: new Date(NIGHT), lastSeenAt: new Date(NIGHT) },
      { jid: group(11), kind: "group", name: null, firstSeenAt: new Date(NIGHT), lastSeenAt: new Date(NIGHT) },
      { jid: group(1), kind: "group", name: "Out of the first ten", firstSeenAt: new Date(NIGHT), lastSeenAt: new Date(NIGHT) },
    ]);
    const { topGroups } = await getStats();
    assert.equal(topGroups.length, 10);
    assert.deepEqual(topGroups[0], { jid: group(12), name: "Family", count: 120 });
    assert.deepEqual(topGroups[1], { jid: group(11), name: null, count: 110 });
    assert.deepEqual(topGroups[2], { jid: group(10), name: null, count: 100 });
    assert.ok(!topGroups.some((g) => g.jid === group(1)));
    for (const entry of topGroups) assert.deepEqual(Object.keys(entry), ["jid", "name", "count"]);
  });

  test("an injected group-name source (the groups snapshot) wins over the chats table", async () => {
    const seen = [];
    await boot({
      deps: {
        groupNames: async (jids) => {
          seen.push([...jids]);
          return new Map([[group(2), "From the snapshot"]]);
        },
      },
    });
    count("group_msgs", group(2), 5, NIGHT);
    count("group_msgs", group(3), 4, NIGHT);
    await stats.flush();
    await t.db.KnownChat.create({ jid: group(2), kind: "group", name: "From the table", firstSeenAt: new Date(NIGHT), lastSeenAt: new Date(NIGHT) });
    const { topGroups } = await getStats();
    assert.deepEqual(topGroups, [
      { jid: group(2), name: "From the snapshot", count: 5 },
      { jid: group(3), name: null, count: 4 },
    ]);
    assert.deepEqual(seen, [[group(2), group(3)]]);
  });

  test("a group-name source that fails costs the names, not the page", async () => {
    await boot({
      deps: {
        groupNames: async () => {
          throw new Error("metadata unavailable");
        },
      },
    });
    count("group_msgs", group(2), 5, NIGHT);
    await stats.flush();
    const { topGroups } = await getStats();
    assert.deepEqual(topGroups, [{ jid: group(2), name: null, count: 5 }]);
  });

  test("the answer holds numbers and names only: nothing else of the tables leaks", async () => {
    await boot();
    count("cmd_ok", "ping", 1, NIGHT);
    count("group_msgs", group(1), 1, NIGHT);
    await stats.flush();
    const text = JSON.stringify(await getStats());
    assert.ok(!/"(metric|subject|createdAt|updatedAt)"/.test(text));
  });
});

describe("the stats service on its own", () => {
  test("it builds the window from the clock it is given, and zero-fills even when the engine returns holes", async () => {
    const calls = [];
    const engine = {
      flush: async () => 0,
      messagesByDay: async (days, options) => {
        calls.push(["messagesByDay", days, options.now]);
        return [{ day: "2026-03-11", messages: 5 }, { day: "1999-01-01", messages: 99 }];
      },
      topCommands: async (limit, days, options) => {
        calls.push(["topCommands", limit, days, options.now]);
        return [{ name: "a", count: 2 }];
      },
      failingCommands: async (days, options) => {
        calls.push(["failingCommands", days, options.now]);
        return [];
      },
      topGroups: async (limit, days, options) => {
        calls.push(["topGroups", limit, days, options.now]);
        return [{ jid: group(1), count: 3 }];
      },
    };
    const service = createStatsService({ stats: engine, config: { TIMEZONE: "Africa/Douala" }, clock: { now: () => NIGHT }, groupNames: async () => ({ [group(1)]: "G" }) });
    const body = await service.get();
    assert.equal(body.days.length, 7);
    assert.deepEqual(body.days.map((d) => d.messages), [0, 0, 0, 0, 0, 0, 5]);
    assert.deepEqual(body.topGroups, [{ jid: group(1), name: "G", count: 3 }]);
    assert.deepEqual(calls.map((c) => c[0]), ["messagesByDay", "topCommands", "failingCommands", "topGroups"]);
    assert.ok(calls.every((c) => c[c.length - 1] === NIGHT), "every query is asked for the same instant");
    assert.deepEqual(calls[1].slice(1, 3), [10, 7]);
  });
});

function HOURS(n) {
  return n * 60 * 60 * 1000;
}
