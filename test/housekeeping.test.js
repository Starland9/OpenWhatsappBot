"use strict";
/**
 * Retention of the data this feature adds (T151, data-model 1.15, contracts/runtime.md section 9;
 * lib/utils/housekeeping.js), on an in-memory database, a fake clock and a temporary data directory.
 *
 * One test per statement of 1.15: daily_stats (local day), audit_logs (180 days, the 20 000-row cap, login.success
 * exempt and kept to 500), sessions, tokens, alert_outbox, alert_states, broadcast runs and targets, once broadcasts
 * with no run, known_chats, the files (uploads older than 1 h, data/tmp at boot, orphan media directories). Every
 * statement is idempotent; the optional broadcaster.sweepMedia call is skipped when the engine is absent; start() is
 * idempotent and unref()'d; no timer exists at require time.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DateTime } = require("luxon");
const fakes = require("./helpers/fakes");
const { createClock } = require("./helpers/fakeClock");

fakes.setupEnv();

const mutex = require("../lib/utils/mutex");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

let db;
let clock;
let dir;
let housekeeping;
let createHousekeeping;

const TABLES = [
  "DailyStat", "AuditLog", "AdminSession", "AdminToken", "AlertOutbox", "AlertState",
  "BroadcastTarget", "BroadcastRun", "Broadcast", "KnownChat",
];

before(async () => {
  db = await fakes.syncDb();
  ({ createHousekeeping } = require("../lib/utils/housekeeping"));
});

beforeEach(async () => {
  for (const name of TABLES) await db[name].destroy({ where: {} });
  clock = createClock(NOW);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-housekeeping-"));
  housekeeping = createHousekeeping({
    models: db,
    clock: () => clock.now(),
    timers: clock.timers,
    dataDir: dir,
    broadcaster: null,
    timezone: () => "UTC",
  });
});

afterEach(() => {
  housekeeping.stop();
  clock.restore();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ago = (ms) => new Date(NOW - ms);
const count = (model, where = {}) => db[model].count({ where });
const write = (...parts) => {
  const file = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  return file;
};
const touch = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));
/** `updatedAt` cannot be set through create() or update(): write the column in the dialect's own date format */
const setUpdatedAt = (model, id, date) =>
  db.DATABASE.query(`UPDATE "${db[model].getTableName()}" SET "updatedAt" = :value WHERE "id" = :id`, {
    replacements: { value: date.toISOString().replace("T", " ").replace("Z", " +00:00"), id },
  });
const sumCounts = (value) => (value && typeof value === "object" ? Object.values(value).reduce((n, v) => n + sumCounts(v), 0) : Number(value) || 0);

describe("daily_stats", () => {
  test("rows older than 90 days go; the day is the local date in TIMEZONE", async () => {
    const cutoff = DateTime.fromMillis(NOW, { zone: "UTC" }).minus({ days: 90 }).toFormat("yyyy-MM-dd");
    assert.equal(cutoff, "2025-10-03");
    await db.DailyStat.bulkCreate([
      { day: "2025-10-02", metric: "messages", subject: "", count: 1 },
      { day: "2025-10-03", metric: "messages", subject: "", count: 2 },
      { day: "2025-12-31", metric: "cmd_ok", subject: "ping", count: 3 },
    ]);
    const report = await housekeeping.run();
    assert.equal(report.dailyStats, 1);
    assert.deepEqual((await db.DailyStat.findAll({ raw: true, order: [["day", "ASC"]] })).map((row) => row.day), ["2025-10-03", "2025-12-31"]);
  });

  test("a zone ahead of UTC moves the cutoff by a day; an invalid zone falls back to UTC", async () => {
    await db.DailyStat.bulkCreate([
      { day: "2025-10-03", metric: "messages", subject: "", count: 1 },
      { day: "2025-10-04", metric: "messages", subject: "", count: 1 },
    ]);
    // 2026-01-01 12:00 UTC is already 2026-01-02 02:00 in Kiritimati: the cutoff is 2025-10-04
    const ahead = createHousekeeping({ models: db, clock: () => NOW, dataDir: dir, broadcaster: null, timezone: () => "Pacific/Kiritimati" });
    await ahead.run();
    assert.deepEqual((await db.DailyStat.findAll({ raw: true })).map((row) => row.day), ["2025-10-04"]);

    await db.DailyStat.create({ day: "2025-10-02", metric: "messages", subject: "", count: 1 });
    const invalid = createHousekeeping({ models: db, clock: () => NOW, dataDir: dir, broadcaster: null, timezone: () => "Not/AZone" });
    await invalid.run();
    assert.deepEqual((await db.DailyStat.findAll({ raw: true, order: [["day", "ASC"]] })).map((row) => row.day), ["2025-10-04"], "UTC: 10-02 goes, 10-04 stays");
  });
});

describe("audit_logs", () => {
  test("rows older than 180 days go, login.success rows included", async () => {
    await db.AuditLog.bulkCreate([
      { action: "setting.update", origin: "a", createdAt: ago(181 * DAY) },
      { action: "login.success", origin: "a", createdAt: ago(181 * DAY) },
      { action: "setting.update", origin: "a", createdAt: ago(179 * DAY) },
      { action: "login.success", origin: "a", createdAt: ago(179 * DAY) },
    ]);
    const report = await housekeeping.run();
    assert.equal(report.auditLogs.aged, 2);
    assert.equal(await count("AuditLog"), 2);
    assert.equal(await count("AuditLog", { createdAt: { [require("sequelize").Op.lt]: ago(180 * DAY) } }), 0);
  });

  test("the newest 20 000 rows are kept; login.success rows are exempt from that cap and kept to 500", async () => {
    const rows = (n, action, start) =>
      Array.from({ length: n }, (_, i) => ({ action, origin: "o", target: String(start + i), createdAt: ago(DAY) }));
    const insert = async (list) => {
      for (let i = 0; i < list.length; i += 1000) await db.AuditLog.bulkCreate(list.slice(i, i + 1000));
    };
    // oldest first, as the ids grow with time: 505 successes, then 20 003 other rows
    await insert(rows(505, "login.success", 0));
    await insert(rows(20003, "setting.update", 1000));

    const report = await housekeeping.run();
    assert.equal(report.auditLogs.capped, 3);
    assert.equal(report.auditLogs.successes, 5);
    assert.equal(await count("AuditLog", { action: "setting.update" }), 20000);
    assert.equal(await count("AuditLog", { action: "login.success" }), 500);
    // the survivors are the newest ones
    const oldestKept = await db.AuditLog.findOne({ where: { action: "setting.update" }, order: [["id", "ASC"]], raw: true });
    assert.equal(oldestKept.target, "1003");
    const oldestSuccess = await db.AuditLog.findOne({ where: { action: "login.success" }, order: [["id", "ASC"]], raw: true });
    assert.equal(oldestSuccess.target, "5");

    // idempotent
    const again = await housekeeping.run();
    assert.deepEqual(again.auditLogs, { aged: 0, capped: 0, successes: 0 });
  });

  test("a flood of other rows never evicts a login.success row", async () => {
    await db.AuditLog.bulkCreate([{ action: "login.success", origin: "known", createdAt: ago(10 * DAY) }]);
    const flood = Array.from({ length: 20100 }, () => ({ action: "login.failure", origin: "x", createdAt: ago(DAY) }));
    for (let i = 0; i < flood.length; i += 1000) await db.AuditLog.bulkCreate(flood.slice(i, i + 1000));
    await housekeeping.run();
    assert.equal(await count("AuditLog", { action: "login.success", origin: "known" }), 1);
    assert.equal(await count("AuditLog", { action: "login.failure" }), 20000);
  });
});

describe("sessions and tokens", () => {
  test("a session idle for 24 h or older than 7 days goes", async () => {
    const make = (idHash, lastSeenAt, createdAt) =>
      db.AdminSession.create({ idHash, csrfSecret: "c", origin: "o", lastSeenAt, createdAt });
    await make("idle", ago(25 * HOUR), ago(26 * HOUR));
    await make("absolute", ago(HOUR), ago(8 * DAY));
    await make("live", ago(HOUR), ago(2 * DAY));
    await make("edge", ago(23 * HOUR), ago(6 * DAY));
    const report = await housekeeping.run();
    assert.equal(report.sessions, 2);
    assert.deepEqual((await db.AdminSession.findAll({ raw: true, order: [["idHash", "ASC"]] })).map((row) => row.idHash), ["edge", "live"]);
  });

  test("a token expired for more than a day goes", async () => {
    const make = (tokenHash, expiresAt) => db.AdminToken.create({ kind: "setup", tokenHash, expiresAt });
    await make("old", ago(2 * DAY));
    await make("recent", ago(HOUR));
    await make("future", new Date(NOW + 10 * 60 * 1000));
    const report = await housekeeping.run();
    assert.equal(report.tokens, 1);
    assert.deepEqual((await db.AdminToken.findAll({ raw: true, order: [["tokenHash", "ASC"]] })).map((row) => row.tokenHash), ["future", "recent"]);
  });
});

describe("alerts", () => {
  test("outbox: resolved rows after 7 days; pending rows over 24 h become expired", async () => {
    const make = async (status, createdAt, updatedAt) => {
      const row = await db.AlertOutbox.create({ type: "reconnected", status, createdAt });
      await setUpdatedAt("AlertOutbox", row.id, updatedAt);
      return row.id;
    };
    const oldSent = await make("sent", ago(9 * DAY), ago(8 * DAY));
    const oldDropped = await make("dropped", ago(9 * DAY), ago(8 * DAY));
    const freshSent = await make("sent", ago(9 * DAY), ago(6 * DAY));
    const late = await make("pending", ago(25 * HOUR), ago(25 * HOUR));
    const waiting = await make("pending", ago(23 * HOUR), ago(23 * HOUR));
    const ancient = await make("pending", ago(10 * DAY), ago(10 * DAY));

    const report = await housekeeping.run();
    assert.deepEqual(report.alertOutbox, { deleted: 2, expired: 2 });
    const status = async (id) => (await db.AlertOutbox.findByPk(id))?.status ?? null;
    assert.equal(await status(oldSent), null);
    assert.equal(await status(oldDropped), null);
    assert.equal(await status(freshSent), "sent");
    assert.equal(await status(late), "expired");
    assert.equal(await status(waiting), "pending");
    assert.equal(await status(ancient), "expired", "expired now, deleted by a pass 7 days later");

    assert.deepEqual((await housekeeping.run()).alertOutbox, { deleted: 0, expired: 0 }, "idempotent");
    // the two rows expired above carry the time they expired (the real clock, stamped by Sequelize)
    const later = await housekeeping.run({ now: Date.now() + 8 * DAY });
    assert.equal(later.alertOutbox.deleted, 3, "the row sent 6 days ago and the two that expired above");
    assert.equal(await status(late), null);
    assert.equal(await status(ancient), null);
  });

  test("states: login_blocked slots after 24 h, nothing else", async () => {
    await db.AlertState.bulkCreate([
      { key: "login_blocked:1.2.3.4", lastSentAt: ago(25 * HOUR) },
      { key: "login_blocked:5.6.7.8", lastSentAt: ago(23 * HOUR) },
      { key: "errors_series", lastSentAt: ago(100 * HOUR) },
    ]);
    const report = await housekeeping.run();
    assert.equal(report.alertStates, 1);
    assert.deepEqual((await db.AlertState.findAll({ raw: true, order: [["key", "ASC"]] })).map((row) => row.key), ["errors_series", "login_blocked:5.6.7.8"]);
  });
});

describe("broadcasts", () => {
  const once = (over = {}) => db.Broadcast.create({ kind: "once", text: "hello", targets: ["120363000000000001@g.us"], ...over });
  const run = (broadcastId, over = {}) =>
    db.BroadcastRun.create({ broadcastId, dueAt: ago(DAY), status: "completed", total: 1, targetsReady: true, ...over });
  const target = (runId, chatJid = "120363000000000001@g.us") => db.BroadcastTarget.create({ runId, chatJid, position: 1, status: "sent" });

  test("runs finished more than 90 days ago go with their targets; runs without targets after an hour go too", async () => {
    const b = await once();
    const old = await run(b.id, { finishedAt: ago(91 * DAY), dueAt: ago(92 * DAY) });
    const young = await run(b.id, { finishedAt: ago(89 * DAY), dueAt: ago(90 * DAY) });
    const open = await run(b.id, { status: "running", finishedAt: null, dueAt: ago(2 * DAY) });
    const leftover = await run(b.id, { targetsReady: false, status: "scheduled", dueAt: ago(3 * DAY) });
    const building = await run(b.id, { targetsReady: false, status: "scheduled", dueAt: ago(4 * DAY) });
    await db.BroadcastRun.update({ createdAt: ago(2 * HOUR) }, { where: { id: leftover.id }, silent: true });
    await db.BroadcastRun.update({ createdAt: ago(30 * 60 * 1000) }, { where: { id: building.id }, silent: true });
    for (const r of [old, young, open, leftover, building]) await target(r.id);
    await target(old.id, "120363000000000002@g.us");

    const report = await housekeeping.run();
    assert.deepEqual(report.broadcastRuns, { runs: 2, targets: 3 });
    assert.deepEqual((await db.BroadcastRun.findAll({ raw: true, order: [["id", "ASC"]] })).map((row) => row.id), [young.id, open.id, building.id]);
    assert.deepEqual(
      (await db.BroadcastTarget.findAll({ raw: true, order: [["runId", "ASC"]] })).map((row) => row.runId),
      [young.id, open.id, building.id],
      "the targets of a deleted run are gone first, never left orphan",
    );
    assert.deepEqual((await housekeeping.run()).broadcastRuns, { runs: 0, targets: 0 }, "idempotent");
  });

  test("a once broadcast with no run goes (its media directory too); recurring ones and those with a run stay", async () => {
    const lonely = await once();
    const emptied = await once();
    await run(emptied.id, { finishedAt: ago(91 * DAY), dueAt: ago(92 * DAY) });
    const kept = await once();
    await run(kept.id);
    const recurring = await db.Broadcast.create({
      kind: "recurring", text: "daily", targets: ["120363000000000001@g.us"], recurKind: "daily", recurTime: "08:00", nextRunAt: new Date(NOW + DAY),
    });
    for (const b of [lonely, emptied, kept, recurring]) write("broadcast-media", String(b.id), "photo.png");

    const report = await housekeeping.run();
    assert.equal(report.onceBroadcasts, 2, "the lonely one and the one whose only run was just pruned");
    assert.deepEqual((await db.Broadcast.findAll({ raw: true, order: [["id", "ASC"]] })).map((row) => row.id), [kept.id, recurring.id]);
    const media = fs.readdirSync(path.join(dir, "broadcast-media")).sort();
    assert.deepEqual(media, [String(kept.id), String(recurring.id)].sort(), "the media of a deleted definition is removed as an orphan");
    assert.equal(report.orphanMedia.removed, 2);
  });
});

describe("known_chats", () => {
  test("private chats silent for more than 365 days go; groups never", async () => {
    const make = (jid, kind, lastSeenAt) => db.KnownChat.create({ jid, kind, firstSeenAt: ago(500 * DAY), lastSeenAt });
    await make("1@s.whatsapp.net", "private", ago(366 * DAY));
    await make("2@s.whatsapp.net", "private", ago(364 * DAY));
    await make("120363000000000009@g.us", "group", ago(900 * DAY));
    const report = await housekeeping.run();
    assert.equal(report.knownChats, 1);
    assert.deepEqual((await db.KnownChat.findAll({ raw: true, order: [["jid", "ASC"]] })).map((row) => row.jid), ["120363000000000009@g.us", "2@s.whatsapp.net"]);
  });
});

describe("files", () => {
  test("data/admin-uploads/*: only what was written more than an hour ago", async () => {
    const old = write("admin-uploads", "old.part");
    const fresh = write("admin-uploads", "fresh.part");
    touch(old, NOW - 2 * HOUR);
    touch(fresh, NOW - 30 * 60 * 1000);
    const report = await housekeeping.run();
    assert.equal(report.uploads.removed, 1);
    assert.deepEqual(fs.readdirSync(path.join(dir, "admin-uploads")), ["fresh.part"]);
    assert.equal((await housekeeping.run()).uploads.removed, 0);
  });

  test("data/tmp/* is swept at boot (start), not by the daily pass", async () => {
    write("tmp", "restore-abc.owb");
    write("tmp", "other.bin");
    await housekeeping.run();
    assert.equal(fs.readdirSync(path.join(dir, "tmp")).length, 2, "the daily pass leaves a restore in progress alone");
    await housekeeping.start();
    assert.deepEqual(fs.readdirSync(path.join(dir, "tmp")), []);
    assert.ok(fs.existsSync(path.join(dir, "tmp")), "the directory itself stays");
  });

  test("data/broadcast-media/<id>/ with no Broadcast row goes; known ids and unrelated entries stay", async () => {
    const b = await db.Broadcast.create({ kind: "once", text: "t", targets: ["120363000000000001@g.us"] });
    await run0(b.id);
    write("broadcast-media", String(b.id), "keep.png");
    write("broadcast-media", "987654", "orphan.png");
    write("broadcast-media", "notes", "readme.txt");
    write("broadcast-media", ".gitkeep");
    const report = await housekeeping.run();
    assert.equal(report.orphanMedia.removed, 1);
    assert.deepEqual(fs.readdirSync(path.join(dir, "broadcast-media")).sort(), [".gitkeep", "notes", String(b.id)].sort());
    assert.equal((await housekeeping.run()).orphanMedia.removed, 0);

    async function run0(id) {
      await db.BroadcastRun.create({ broadcastId: id, dueAt: ago(DAY), status: "completed", targetsReady: true });
    }
  });

  test("missing directories are fine", async () => {
    const report = await housekeeping.run();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.uploads, { freedBytes: 0, removed: 0, skipped: 0 });
    assert.deepEqual(report.orphanMedia, { removed: 0, freedBytes: 0 });
  });
});

describe("broadcaster.sweepMedia", () => {
  test("is called with now when the engine exists, and skipped when it is absent", async () => {
    const calls = [];
    const engine = { sweepMedia: async (options) => { calls.push(options); return { removed: 2 }; } };
    const withEngine = createHousekeeping({ models: db, clock: () => NOW, dataDir: dir, broadcaster: engine, timezone: () => "UTC" });
    const report = await withEngine.run();
    assert.deepEqual(calls, [{ now: NOW }]);
    assert.deepEqual(report.mediaSweep, { removed: 2 });

    const without = await housekeeping.run();
    assert.equal(without.mediaSweep, null);
    assert.deepEqual(without.errors, []);
  });

  test("the lazy default tolerates a missing module and a failing sweep does not stop the other rules", async () => {
    const failing = createHousekeeping({
      models: db, clock: () => NOW, dataDir: dir, timezone: () => "UTC",
      broadcaster: { sweepMedia: async () => { throw new Error("disk full"); } },
    });
    await db.AlertState.create({ key: "login_blocked:x", lastSentAt: ago(2 * DAY) });
    const report = await failing.run();
    assert.deepEqual(report.errors, ["mediaSweep"]);
    assert.equal(await count("AlertState"), 0, "the rules before it ran");
  });

  test("the sweep runs after the broadcast rules and outside their lock", async () => {
    let lockedDuringSweep = null;
    const engine = {
      sweepMedia: async () => {
        // the real engine takes the same lock itself: it must be free when housekeeping calls it
        lockedDuringSweep = mutex.isLocked("broadcasts");
        return {};
      },
    };
    const h = createHousekeeping({ models: db, clock: () => NOW, dataDir: dir, broadcaster: engine, timezone: () => "UTC" });
    await h.run();
    assert.equal(lockedDuringSweep, false);
  });
});

describe("a pass", () => {
  test("a failing rule is reported and the next ones still run", async () => {
    const broken = {
      ...db,
      DailyStat: { destroy: async () => { throw Object.assign(new Error("secret detail"), { code: "SQLITE_BUSY" }); } },
    };
    const logged = [];
    const h = createHousekeeping({
      models: broken, clock: () => NOW, dataDir: dir, broadcaster: null, timezone: () => "UTC",
      logger: { warn: (...args) => logged.push(args), debug() {}, info() {}, error() {} },
    });
    await db.AdminToken.create({ kind: "setup", tokenHash: "gone", expiresAt: ago(3 * DAY) });
    const report = await h.run();
    assert.deepEqual(report.errors, ["dailyStats"]);
    assert.equal(report.dailyStats, null);
    assert.equal(report.tokens, 1);
    assert.equal(JSON.stringify(logged).includes("secret detail"), false, "only the rule, the error name and code are logged");
    assert.equal(logged[0][0].code, "SQLITE_BUSY");
  });

  test("two passes at once share one run; the second pass finds nothing left to do", async () => {
    await db.AdminToken.create({ kind: "setup", tokenHash: "gone", expiresAt: ago(3 * DAY) });
    const [a, b] = [housekeeping.run(), housekeeping.run()];
    assert.equal(a, b, "the pass in progress is returned");
    const first = await a;
    assert.equal(first.tokens, 1);
    const second = await housekeeping.run();
    assert.equal(sumCounts({ ...second, at: 0, errors: 0 }), 0, JSON.stringify(second));
  });

  test("the broadcast statements wait for the broadcasts lock", async () => {
    let release;
    const held = mutex.withLock("broadcasts", () => new Promise((resolve) => { release = resolve; }));
    let done = false;
    const pass = housekeeping.run().then((report) => {
      done = true;
      return report;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(done, false, "a definition being created cannot be taken for an orphan");
    release();
    await held;
    assert.deepEqual((await pass).errors, []);
  });
});

describe("lifecycle", () => {
  test("no timer at require time; start() arms two unref()'d timers once; stop() clears them", async () => {
    const timersBefore = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    delete require.cache[require.resolve("../lib/utils/housekeeping")];
    const fresh = require("../lib/utils/housekeeping");
    assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, timersBefore, "requiring it starts nothing");
    assert.equal(fresh.isRunning(), false);

    const handles = [];
    const spy = {
      setTimeout: (...a) => { const h = clock.timers.setTimeout(...a); handles.push(h); return h; },
      clearTimeout: (h) => clock.timers.clearTimeout(h),
      setInterval: (...a) => { const h = clock.timers.setInterval(...a); handles.push(h); return h; },
      clearInterval: (h) => clock.timers.clearInterval(h),
    };
    const h = fresh.createHousekeeping({ models: db, clock: () => clock.now(), timers: spy, dataDir: dir, broadcaster: null, timezone: () => "UTC" });
    assert.equal(clock.pending(), 0, "no timer before start()");
    await h.start();
    assert.equal(clock.pending(), 2);
    assert.equal(h.isRunning(), true);
    assert.ok(handles.length === 2 && handles.every((handle) => handle.hasRef() === false), "both timers are unref()'d");
    await h.start();
    await h.start();
    assert.equal(clock.pending(), 2, "idempotent");
    assert.equal(handles.length, 2);
    h.stop();
    assert.equal(clock.pending(), 0);
    assert.equal(h.isRunning(), false);
    await h.start(); // a stopped engine can be started again
    assert.equal(clock.pending(), 2);
    h.stop();
  });

  test("the first run is 2 minutes after start(), then every 24 hours", async () => {
    await db.AdminToken.create({ kind: "setup", tokenHash: "first", expiresAt: ago(3 * DAY) });
    await housekeeping.start();
    await clock.advance(2 * 60 * 1000 - 1);
    assert.equal(await count("AdminToken"), 1, "not yet");
    await clock.advance(1);
    await fakes.waitFor(async () => (await count("AdminToken")) === 0, { timeout: 3000 });
    assert.equal(await count("AdminToken"), 0, "the first pass ran");
    await housekeeping.run(); // joins the pass that is still finishing its other rules

    await db.AdminToken.create({ kind: "setup", tokenHash: "second", expiresAt: new Date(clock.now() - 3 * DAY) });
    await clock.advance(DAY);
    await fakes.waitFor(async () => (await count("AdminToken")) === 0, { timeout: 3000 });
    assert.equal(await count("AdminToken"), 0, "and again a day later");
  });

  test("the default engine is exported next to the factory", () => {
    const module_ = require("../lib/utils/housekeeping");
    for (const name of ["start", "stop", "run", "bootSweep", "isRunning", "createHousekeeping", "LIMITS"]) {
      assert.ok(module_[name], name);
    }
  });
});
