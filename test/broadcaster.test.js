"use strict";
/**
 * lib/utils/broadcaster.js (specs/002-admin-panel T159, contracts/runtime.md section 9, data-model 2.3-2.5, research
 * C4, C5, U14, U15, O1). Fake clock (`tick(now)`), fake socket, in-process mutex, in-memory database, temporary
 * directories for the media.
 *
 *  - SC-012: a 50-destination broadcast interrupted by a restart (both crash windows) never sends twice and serves
 *    the remaining destinations; a target caught mid-send becomes failed/interrupted and is never retried;
 *  - SC-016: a daily message over 7 occurrences with one inside an outage of more than an hour: 7 runs (6 completed,
 *    1 expired/late), 6 sends, ticking the same instant twice or restarting the engine adds nothing;
 *  - pacing max(2000, spacingMs) x (1 + jitter) with a restart that cannot burst; one send per tick, global FIFO;
 *  - cancel, client down, expiry of a late run, the 24 h safety, the creation limits, no retry (U14),
 *    media retention (U15), reuseMediaOf (O1), missing media, pause / resume / rule edit / TIMEZONE recomputation.
 */

const { test, describe, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DateTime } = require("luxon");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createClock } = require("./helpers/fakeClock");
const { createBroadcaster, LIMITS, classify } = require("../lib/utils/broadcaster");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]);

let db;
let tmp;
let clock;
let cfg;
let store;
const engines = [];

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  for (const name of ["BroadcastTarget", "BroadcastRun", "Broadcast", "KnownChat", "BannedChat"]) {
    await db[name].destroy({ where: {} });
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-bc-"));
  fs.mkdirSync(path.join(tmp, "stage"));
  clock = createClock(T0);
  cfg = { TIMEZONE: "Europe/Paris", MAX_UPLOAD: 1, BROADCAST_DELAY_MS: 5000 };
  store = fakeStore();
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  clock.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

after(() => {
  engines.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeStore() {
  const handlers = new Set();
  return {
    onChange(keys, fn) {
      const entry = { keys, fn };
      handlers.add(entry);
      return () => handlers.delete(entry);
    },
    emit(keys) {
      for (const entry of [...handlers]) if (entry.keys.some((k) => keys.includes(k))) entry.fn({ keys });
    },
    size: () => handlers.size,
  };
}

/** An engine on the fake clock; `sock`, `client` and `random` can be shared to simulate a restart. */
function newEngine(over = {}) {
  const sock = over.sock || fakes.fakeSocket();
  const client = over.client || fakes.fakeClient(sock);
  const engine = createBroadcaster({
    rootDir: tmp,
    config: cfg,
    clock: () => clock.now(),
    random: over.random || (() => 0),
    timers: clock.timers,
    settingsStore: store,
    ...over.options,
  });
  if (over.start !== false) engine.start(client);
  engines.push(engine);
  return { engine, sock, client };
}

async function chats(count, { start = 1000, kind = "private" } = {}) {
  const jids = [];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const jid = kind === "group" ? `${start + i}@g.us` : `${start + i}@s.whatsapp.net`;
    jids.push(jid);
    rows.push({ jid, kind, pnJid: kind === "private" ? jid : null, name: `chat ${start + i}`, firstSeenAt: new Date(T0), lastSeenAt: new Date(T0) });
  }
  await db.KnownChat.bulkCreate(rows);
  return jids;
}

function stage(name, content) {
  const file = path.join(tmp, "stage", name);
  fs.writeFileSync(file, content);
  return file;
}

const mediaRoot = () => path.join(tmp, "data", "broadcast-media");
const sentJids = (sock) => sock.sent.map((s) => s.jid);
const targetsOf = async (runId) => (await db.BroadcastTarget.findAll({ where: { runId }, order: [["position", "ASC"]], raw: true }));
const statusOf = async (runId) => Object.fromEntries((await targetsOf(runId)).map((t) => [t.chatJid, t.errorCode ? `${t.status}/${t.errorCode}` : t.status]));
const runRow = (id) => db.BroadcastRun.findByPk(id, { raw: true });
const settle = async (engine, at = clock.now()) => engine.tick(at);

/** Tick every `stepMs` for `steps` steps, returning the summed counters */
async function drive(engine, { steps, stepMs }) {
  const total = { materialized: 0, claimed: 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
  for (let i = 0; i < steps; i += 1) {
    clock.set(clock.now() + stepMs);
    const r = await engine.tick(clock.now());
    for (const key of Object.keys(total)) total[key] += r[key];
  }
  return total;
}

/** Make the next matching `BroadcastTarget.update` die like the process would; returns the restore function */
function crashOn(predicate) {
  const original = db.BroadcastTarget.update;
  let armed = true;
  db.BroadcastTarget.update = function patched(values, options) {
    if (armed && predicate(values)) {
      armed = false;
      return Promise.reject(new Error("process died"));
    }
    return original.call(this, values, options);
  };
  return () => {
    db.BroadcastTarget.update = original;
  };
}

const boom = (statusCode, message = "boom") => Object.assign(new Error(message), { output: { statusCode } });

// ---------------------------------------------------------------------------
// SC-012
// ---------------------------------------------------------------------------

describe("SC-012: a restart never sends twice and serves the rest", () => {
  const COUNT = 50;

  test("crash window 1: after picking, before the sending claim", async () => {
    const targets = await chats(COUNT);
    const first = newEngine();
    const { runId } = await first.engine.createOnce({ text: "hello", targets, spacingMs: 2000 }, { now: clock.now() });

    // some sends go out, then the claim of the next one dies with the process
    await drive(first.engine, { steps: 3, stepMs: 2000 });
    assert.equal(first.sock.sent.length, 3);
    const restore = crashOn((values) => values.status === "sending");
    clock.set(clock.now() + 2000);
    const dying = await first.engine.tick(clock.now());
    restore();
    assert.equal(dying.claimed, 0);
    assert.equal(first.sock.sent.length, 3, "nothing went out");

    // restart: a new engine on the same database serves every remaining destination once
    const second = newEngine({ sock: first.sock, client: first.client });
    await drive(second.engine, { steps: COUNT + 2, stepMs: 2000 });

    const jids = sentJids(first.sock);
    assert.equal(jids.length, COUNT);
    assert.equal(new Set(jids).size, COUNT, "no destination twice");
    assert.deepEqual([...jids].sort(), [...targets].sort());
    assert.equal((await runRow(runId)).status, "completed");
    assert.ok(Object.values(await statusOf(runId)).every((s) => s === "sent"));
  });

  test("crash window 2: between the send and the sent write", async () => {
    const targets = await chats(COUNT);
    const first = newEngine();
    const { runId } = await first.engine.createOnce({ text: "hello", targets, spacingMs: 2000 }, { now: clock.now() });

    await drive(first.engine, { steps: 2, stepMs: 2000 });
    const restore = crashOn((values) => values.status === "sent");
    clock.set(clock.now() + 2000);
    await first.engine.tick(clock.now());
    restore();
    const crashedAt = clock.now();
    assert.equal(first.sock.sent.length, 3, "the third message did go out");
    const stuck = (await db.BroadcastTarget.findAll({ where: { runId, status: "sending" }, raw: true }));
    assert.equal(stuck.length, 1, "the target is caught mid-send");
    assert.equal(stuck[0].chatJid, targets[2]);

    // restart: a new engine cannot burst right behind the message that may have gone out
    const second = newEngine({ sock: first.sock, client: first.client });
    clock.set(crashedAt + 1000);
    assert.equal((await second.engine.tick(clock.now())).claimed, 0, "no burst after a restart");
    assert.equal(first.sock.sent.length, 3);

    // the rest is served (49 sends take longer than the 60 s lease), the stuck one is never re-sent
    await drive(second.engine, { steps: COUNT + 5, stepMs: 2000 });
    const jids = sentJids(first.sock);
    assert.equal(jids.length, COUNT);
    assert.equal(new Set(jids).size, COUNT, "no destination twice");
    const states = await statusOf(runId);
    assert.equal(states[targets[2]], "failed/interrupted");
    assert.equal(Object.values(states).filter((s) => s === "sent").length, COUNT - 1);
    assert.equal((await runRow(runId)).status, "completed");

    // later ticks never touch it again
    await drive(second.engine, { steps: 5, stepMs: 60000 });
    assert.equal(first.sock.sent.length, COUNT);
    assert.equal((await statusOf(runId))[targets[2]], "failed/interrupted");
  });

  test("the interrupted target is flagged in the report as possibly delivered", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    const restore = crashOn((values) => values.status === "sent");
    await engine.tick(clock.now());
    restore();
    assert.equal(sock.sent.length, 1);
    clock.set(clock.now() + 2 * LIMITS.LEASE_MS);
    const result = await engine.tick(clock.now());
    assert.equal(result.failed, 1);
    const { targets, run } = await engine.report(runId);
    assert.equal(targets[0].status, "failed");
    assert.equal(targets[0].errorCode, "interrupted");
    assert.equal(targets[0].mayHaveBeenDelivered, true);
    assert.equal(run.status, "failed", "nothing was confirmed sent");
    assert.equal(sock.sent.length, 1, "never retried");
  });
});

// ---------------------------------------------------------------------------
// SC-016
// ---------------------------------------------------------------------------

describe("SC-016: a daily message over 7 occurrences", () => {
  test("7 runs (6 completed, 1 expired/late), exactly 6 sends, nothing added by a repeated tick or a restart", async () => {
    const [jid] = await chats(1);
    const paris = (day, hour, minute = 0) => DateTime.fromObject({ year: 2026, month: 6, day, hour, minute }, { zone: "Europe/Paris" }).toMillis();
    clock.set(paris(1, 6));
    const first = newEngine();
    const { broadcastId, nextRunAt } = await first.engine.createRecurring(
      { text: "good morning", targets: [jid], rule: { kind: "daily", time: "08:00" } },
      { now: clock.now() },
    );
    assert.equal(nextRunAt.getTime(), paris(1, 8));

    const at = [paris(1, 8), paris(2, 8), paris(3, 8), paris(4, 9, 30) /* outage 06:00 to 09:30 */, paris(5, 8), paris(6, 8), paris(7, 8)];
    for (const instant of at) {
      clock.set(instant);
      await first.engine.tick(clock.now());
      await first.engine.tick(clock.now()); // the same instant twice adds nothing
    }

    const runs = await db.BroadcastRun.findAll({ where: { broadcastId }, order: [["dueAt", "ASC"]], raw: true });
    assert.equal(runs.length, 7);
    assert.deepEqual(
      runs.map((r) => r.status),
      ["completed", "completed", "completed", "expired", "completed", "completed", "completed"],
    );
    assert.equal(runs[3].note, "late");
    assert.equal(new Date(runs[3].dueAt).getTime(), paris(4, 8));
    assert.equal(first.sock.sent.length, 6);

    // a restart (a new engine) and more ticks add nothing
    const second = newEngine({ sock: first.sock, client: first.client });
    await second.engine.tick(clock.now());
    await second.engine.tick(clock.now() + 1000);
    assert.equal((await db.BroadcastRun.count({ where: { broadcastId } })), 7);
    assert.equal(first.sock.sent.length, 6);

    const row = await db.Broadcast.findByPk(broadcastId, { raw: true });
    assert.equal(new Date(row.nextRunAt).getTime(), paris(8, 8), "next run on the next day");
    assert.equal(new Date(row.lastRunAt).getTime(), paris(7, 8));
  });

  test("the unique index (broadcastId, dueAt) refuses a second run of the same occurrence", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "12:00" } }, { now: clock.now() });
    clock.set(clock.now() + DAY);
    await engine.tick(clock.now());
    const [run] = await db.BroadcastRun.findAll({ where: { broadcastId }, raw: true });
    await assert.rejects(db.BroadcastRun.create({ broadcastId, dueAt: run.dueAt, status: "scheduled" }), /Validation|unique/i);
  });

  test("an occurrence already present (a restored backup) only moves the schedule on", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const { broadcastId, nextRunAt } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "12:00" } }, { now: clock.now() });
    await db.BroadcastRun.create({ broadcastId, dueAt: nextRunAt, status: "completed", total: 1, targetsReady: true, finishedAt: nextRunAt });
    clock.set(nextRunAt.getTime() + 60000);
    const result = await engine.tick(clock.now());
    assert.equal(result.materialized, 0);
    assert.equal(sock.sent.length, 0);
    assert.equal((await db.BroadcastRun.count({ where: { broadcastId } })), 1);
    const row = await db.Broadcast.findByPk(broadcastId, { raw: true });
    assert.ok(new Date(row.nextRunAt).getTime() > nextRunAt.getTime());
  });

  test("a bot down for weeks: at most 50 occurrences are recorded, then nextRunAt jumps to after now", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const { broadcastId } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "08:00" } }, { now: clock.now() });
    clock.set(clock.now() + 80 * DAY);
    const result = await engine.tick(clock.now());
    assert.equal(result.expired, 50);
    assert.equal(result.materialized, 0);
    assert.equal(sock.sent.length, 0);
    const row = await db.Broadcast.findByPk(broadcastId, { raw: true });
    assert.ok(new Date(row.nextRunAt).getTime() > clock.now());
    assert.ok(new Date(row.nextRunAt).getTime() - clock.now() <= DAY);
    assert.equal(await db.BroadcastRun.count({ where: { broadcastId, status: "expired", note: "late" } }), 50);
  });

  test("an occurrence within the hour is materialized and sent, a late one is only recorded", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const { broadcastId, nextRunAt } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "12:00" } }, { now: clock.now() });
    clock.set(nextRunAt.getTime() + HOUR); // exactly one hour late: still on time
    const onTime = await engine.tick(clock.now());
    assert.equal(onTime.materialized, 1);
    assert.equal(sock.sent.length, 1);
    clock.set(nextRunAt.getTime() + DAY + HOUR + 1); // one millisecond over the hour
    const late = await engine.tick(clock.now());
    assert.equal(late.expired, 1);
    assert.equal(late.materialized, 0);
    assert.equal(sock.sent.length, 1);
    assert.equal(await db.BroadcastRun.count({ where: { broadcastId } }), 2);
  });
});

// ---------------------------------------------------------------------------
// Pacing and ordering
// ---------------------------------------------------------------------------

describe("pacing", () => {
  test("one send per tick, spaced by max(2000, spacingMs) x (1 + jitter)", async () => {
    const targets = await chats(3);
    const { engine, sock } = newEngine({ random: () => 1 }); // jitter 0.2
    await engine.createOnce({ text: "x", targets, spacingMs: 5000 }, { now: clock.now() });

    let result = await engine.tick(clock.now());
    assert.equal(result.sent, 1);
    clock.set(clock.now() + 5999);
    assert.equal((await engine.tick(clock.now())).sent, 0, "5000 x 1.2 = 6000 ms");
    clock.set(clock.now() + 1);
    assert.equal((await engine.tick(clock.now())).sent, 1);
    clock.set(clock.now() + 1000000);
    result = await engine.tick(clock.now());
    assert.equal(result.sent, 1, "a long wait still sends one message per tick");
    assert.equal(sock.sent.length, 3);
  });

  test("the jitter is drawn once per send, not at every tick", async () => {
    const targets = await chats(2);
    const draws = [];
    const { engine } = newEngine({ random: () => (draws.push(1), 0) });
    await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await engine.tick(clock.now());
    const afterFirst = draws.length;
    for (let i = 0; i < 5; i += 1) {
      clock.set(clock.now() + 100);
      await engine.tick(clock.now());
    }
    assert.equal(draws.length, afterFirst + 1, "one draw for the next send, held while it waits");
  });

  test("the floor of 2 s holds even if a spacing below it is stored", async () => {
    const targets = await chats(2);
    const { engine, sock } = newEngine();
    const { broadcastId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await db.Broadcast.update({ spacingMs: 500 }, { where: { id: broadcastId }, validate: false });
    await engine.tick(clock.now());
    clock.set(clock.now() + 1999);
    assert.equal((await engine.tick(clock.now())).sent, 0);
    clock.set(clock.now() + 1);
    assert.equal((await engine.tick(clock.now())).sent, 1);
    assert.equal(sock.sent.length, 2);
  });

  test("a spacing outside 2 s to 10 min is brought back into range at creation; the default is the setting", async () => {
    const [a, b, c] = await chats(3);
    const { engine } = newEngine();
    const low = await engine.createOnce({ text: "x", targets: [a], spacingMs: 10 }, { now: clock.now() });
    const high = await engine.createOnce({ text: "x", targets: [b], spacingMs: 99999999 }, { now: clock.now() });
    cfg.BROADCAST_DELAY_MS = 7000;
    const dflt = await engine.createOnce({ text: "x", targets: [c] }, { now: clock.now() });
    const spacing = async (id) => (await db.Broadcast.findByPk(id, { raw: true })).spacingMs;
    assert.equal(await spacing(low.broadcastId), 2000);
    assert.equal(await spacing(high.broadcastId), 600000);
    assert.equal(await spacing(dflt.broadcastId), 7000);
  });

  test("a restart cannot burst: lastSendAt comes from max(sentAt)", async () => {
    const targets = await chats(3);
    const first = newEngine();
    await first.engine.createOnce({ text: "x", targets, spacingMs: 5000 }, { now: clock.now() });
    await first.engine.tick(clock.now());
    assert.equal(first.sock.sent.length, 1);

    const second = newEngine({ sock: first.sock, client: first.client });
    clock.set(clock.now() + 1);
    assert.equal((await second.engine.tick(clock.now())).sent, 0);
    clock.set(clock.now() + 4999);
    assert.equal((await second.engine.tick(clock.now())).sent, 1);
    assert.equal(first.sock.sent.length, 2);
  });

  test("the gap is global across broadcasts and the queue is FIFO by dueAt then position", async () => {
    const [a1, a2, b1, b2] = await chats(4);
    const { engine, sock } = newEngine();
    // B is scheduled 1 minute before A became due: it goes first
    await engine.createOnce({ text: "A", targets: [a1, a2], spacingMs: 2000 }, { now: clock.now() });
    await engine.createOnce({ text: "B", targets: [b1, b2], spacingMs: 2000, runAt: clock.now() - 60000 }, { now: clock.now() });
    await drive(engine, { steps: 6, stepMs: 2000 });
    assert.deepEqual(sentJids(sock), [b1, b2, a1, a2]);
    assert.deepEqual(
      sock.sent.map((s) => s.content.text),
      ["B", "B", "A", "A"],
    );
  });

  test("a run with a future dueAt waits for its time", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets: [jid], runAt: clock.now() + 10 * 60000 }, { now: clock.now() });
    assert.equal((await engine.tick(clock.now())).claimed, 0);
    clock.set(clock.now() + 10 * 60000);
    assert.equal((await engine.tick(clock.now())).sent, 1);
    assert.equal(sock.sent.length, 1);
    assert.equal((await runRow(runId)).status, "completed");
  });
});

// ---------------------------------------------------------------------------
// Cancel, disconnection, expiry
// ---------------------------------------------------------------------------

describe("cancel", () => {
  test("pending targets become cancelled, the sent ones stay sent, the run is cancelled", async () => {
    const targets = await chats(4);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await drive(engine, { steps: 2, stepMs: 2000 });
    assert.equal(sock.sent.length, 2);
    const run = await engine.cancelRun(runId);
    assert.equal(run.status, "cancelled");
    assert.deepEqual(
      { sent: run.sent, cancelled: run.cancelled, pending: run.pending },
      { sent: 2, cancelled: 2, pending: 0 },
    );
    await drive(engine, { steps: 4, stepMs: 2000 });
    assert.equal(sock.sent.length, 2, "nothing more goes out");
    assert.equal((await runRow(runId)).status, "cancelled");
    await assert.rejects(engine.cancelRun(runId), (err) => err.code === "not_pending");
    await assert.rejects(engine.cancelRun(999999), (err) => err.code === "not_found");
  });

  test("the message in flight completes and is reported sent", async () => {
    const targets = await chats(3);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    let release;
    const original = sock.sendMessage;
    sock.sendMessage = (jid, content, options) =>
      new Promise((resolve) => {
        release = () => resolve(original(jid, content, options));
      });
    const ticking = engine.tick(clock.now());
    await fakes.waitFor(() => release !== undefined);
    const cancelled = await engine.cancelRun(runId);
    assert.equal(cancelled.status, "cancelled");
    release();
    const result = await ticking;
    assert.equal(result.sent, 1);
    const states = await statusOf(runId);
    assert.deepEqual(Object.values(states), ["sent", "cancelled", "cancelled"]);
    assert.equal((await runRow(runId)).status, "cancelled", "the late settle does not reopen or complete the run");
  });

  test("a scheduled run can be cancelled before it starts, and then nothing is ever sent", async () => {
    const targets = await chats(2);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets, runAt: clock.now() + HOUR }, { now: clock.now() });
    await engine.cancelRun(runId);
    clock.set(clock.now() + 2 * HOUR);
    const result = await engine.tick(clock.now());
    assert.equal(result.claimed, 0);
    assert.equal(sock.sent.length, 0);
    assert.deepEqual(Object.values(await statusOf(runId)), ["cancelled", "cancelled"]);
  });

  test("for a recurring broadcast only that occurrence ends", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const { broadcastId, nextRunAt } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "13:00" } }, { now: clock.now() });
    // materialize without sending: the client is up but the occurrence is not due for sending yet (spacing)
    clock.set(nextRunAt.getTime() - 1);
    await engine.tick(clock.now());
    clock.set(nextRunAt.getTime());
    let release;
    sock.sendMessage = () => new Promise((resolve) => (release = () => resolve({ key: { id: "LATE1" } }))); // the run stays open
    const pending = engine.tick(clock.now());
    await fakes.waitFor(() => release !== undefined);
    const [run] = await db.BroadcastRun.findAll({ where: { broadcastId }, raw: true });
    await engine.cancelRun(run.id);
    clock.set(nextRunAt.getTime() + DAY);
    const next = newEngine({ sock: fakes.fakeSocket() });
    await next.engine.tick(clock.now());
    const row = await db.Broadcast.findByPk(broadcastId, { raw: true });
    assert.equal(row.status, "active", "the series goes on");
    assert.equal(await db.BroadcastRun.count({ where: { broadcastId } }), 2);
    release();
    await pending;
  });
});

describe("disconnection and expiry", () => {
  test("client down: tick returns at once and changes nothing; a started run resumes paced", async () => {
    const targets = await chats(3);
    const { engine, sock, client } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await engine.tick(clock.now());
    assert.equal(sock.sent.length, 1);

    const before = JSON.stringify(await db.BroadcastTarget.findAll({ raw: true }));
    client.ready = () => false;
    clock.set(clock.now() + 3 * HOUR); // far longer than the 1 h lateness gate: a started run is not expired
    const down = await engine.tick(clock.now());
    assert.deepEqual(down, { materialized: 0, claimed: 0, sent: 0, failed: 0, expired: 0, skipped: 0 });
    assert.equal(JSON.stringify(await db.BroadcastTarget.findAll({ raw: true })), before);
    assert.equal((await runRow(runId)).status, "running");

    client.ready = () => true;
    assert.equal((await engine.tick(clock.now())).sent, 1, "resumes after reconnection");
    assert.equal((await engine.tick(clock.now())).sent, 0, "still paced");
    clock.set(clock.now() + 2000);
    assert.equal((await engine.tick(clock.now())).sent, 1);
    assert.equal((await runRow(runId)).status, "completed");
  });

  test("no client yet: tick does nothing", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine({ start: false });
    await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    const result = await engine.tick(clock.now());
    assert.equal(result.claimed, 0);
  });

  test("a socket gone at send time is not claimed", async () => {
    const [jid] = await chats(1);
    const { engine, client } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    client.getSocket = () => null;
    assert.equal((await engine.tick(clock.now())).claimed, 0);
    assert.deepEqual(Object.values(await statusOf(runId)), ["pending"]);
  });

  test("a run still scheduled more than 1 h after its dueAt is expired, not sent", async () => {
    const targets = await chats(3);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets }, { now: clock.now() });
    clock.set(clock.now() + HOUR + 1);
    const result = await engine.tick(clock.now());
    assert.equal(result.expired, 1);
    assert.equal(result.claimed, 0);
    assert.equal(sock.sent.length, 0);
    const run = await runRow(runId);
    assert.equal(run.status, "expired");
    assert.equal(run.note, "late");
    assert.deepEqual(Object.values(await statusOf(runId)), ["cancelled", "cancelled", "cancelled"]);
    assert.ok(run.finishedAt);
  });

  test("exactly one hour late is still sent", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    clock.set(clock.now() + HOUR);
    assert.equal((await engine.tick(clock.now())).sent, 1);
    assert.equal(sock.sent.length, 1);
  });

  test("a run started more than 24 h ago is cancelled (stale) and its remaining targets cancelled", async () => {
    const targets = await chats(3);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await engine.tick(clock.now());
    assert.equal(sock.sent.length, 1);
    clock.set(clock.now() + DAY + 1);
    const result = await engine.tick(clock.now());
    assert.equal(result.claimed, 0);
    const run = await runRow(runId);
    assert.equal(run.status, "cancelled");
    assert.equal(run.note, "stale");
    assert.deepEqual(Object.values(await statusOf(runId)), ["sent", "cancelled", "cancelled"]);
    assert.equal(sock.sent.length, 1);
  });

  test("a completed run whose close was lost is closed by the next tick", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    // the last target settled, the process died before the run was closed
    await db.BroadcastRun.update({ status: "running", startedAt: new Date(clock.now()) }, { where: { id: runId } });
    await db.BroadcastTarget.update({ status: "sent", sentAt: new Date(clock.now()) }, { where: { runId } });
    await engine.tick(clock.now() + 1);
    assert.equal((await runRow(runId)).status, "completed");
  });
});

// ---------------------------------------------------------------------------
// Settling and errors
// ---------------------------------------------------------------------------

describe("settling", () => {
  test("sent keeps sentAt and messageId; a failure keeps a code and the run goes on", async () => {
    const targets = await chats(4);
    const { engine, sock } = newEngine();
    const original = sock.sendMessage;
    const errors = {
      [targets[1]]: boom(403, "forbidden"),
      [targets[2]]: boom(404, "item-not-found"),
    };
    sock.sendMessage = async (jid, content, options) => {
      if (errors[jid]) throw errors[jid];
      return original(jid, content, options);
    };
    const { runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    const total = await drive(engine, { steps: 6, stepMs: 2000 });
    assert.equal(total.sent, 2);
    assert.equal(total.failed, 2);
    const states = await statusOf(runId);
    assert.equal(states[targets[0]], "sent");
    assert.equal(states[targets[1]], "failed/forbidden");
    assert.equal(states[targets[2]], "failed/not_found");
    assert.equal(states[targets[3]], "sent");
    assert.equal((await runRow(runId)).status, "completed");
    const [first] = await targetsOf(runId);
    assert.ok(first.sentAt);
    assert.match(first.messageId, /^BOT\d+$/);
    assert.equal(first.attempts, 1);
    assert.equal(first.leaseUntil, null);
  });

  test("error codes: forbidden, not_found, timeout, connection_closed, error; the last two flag 'may have been delivered'", async () => {
    assert.equal(classify(boom(403)), "forbidden");
    assert.equal(classify(boom(404)), "not_found");
    assert.equal(classify(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "timeout");
    assert.equal(classify(new Error("broadcast send timed out after 30000ms")), "timeout");
    assert.equal(classify(boom(428, "Connection Closed")), "connection_closed");
    assert.equal(classify(new Error("Connection Closed")), "connection_closed");
    assert.equal(classify(new Error("whatever")), "error");
    assert.equal(classify(null), "error");

    const targets = await chats(5);
    const { engine, sock } = newEngine();
    const original = sock.sendMessage;
    const errors = [
      Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      boom(428, "Connection Closed"),
      boom(403, "forbidden"),
      new Error("unexpected"),
    ];
    let n = 0;
    sock.sendMessage = async (jid, content, options) => {
      if (n < errors.length) throw errors[n++];
      return original(jid, content, options);
    };
    const { runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await drive(engine, { steps: 6, stepMs: 2000 });
    const { targets: report } = await engine.report(runId);
    assert.deepEqual(
      report.map((t) => [t.status, t.errorCode, t.mayHaveBeenDelivered]),
      [
        ["failed", "timeout", true],
        ["failed", "connection_closed", true],
        ["failed", "forbidden", false],
        ["failed", "error", false],
        ["sent", null, false],
      ],
    );
  });

  test("a run where nothing was sent is `failed`, one with a single success is `completed`", async () => {
    const targets = await chats(2);
    const { engine, sock } = newEngine();
    sock.sendMessage = async () => {
      throw boom(403, "forbidden");
    };
    const { runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await drive(engine, { steps: 3, stepMs: 2000 });
    assert.equal((await runRow(runId)).status, "failed");
  });

  test("the raw error text never reaches the database", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    sock.sendMessage = async () => {
      throw new Error("secret-token-123 leaked in a message");
    };
    const { runId } = await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    await engine.tick(clock.now());
    const dump = JSON.stringify(await db.BroadcastTarget.findAll({ where: { runId }, raw: true }));
    assert.ok(!dump.includes("secret-token"));
  });

  test("the claim is a compare-and-swap: two ticks at once send once", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    const results = await Promise.all([engine.tick(clock.now()), engine.tick(clock.now())]);
    assert.equal(sock.sent.length, 1);
    assert.equal(results.reduce((sum, r) => sum + r.sent, 0), 1);
  });

  test("a claim lost to another caller counts as skipped", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    const original = db.BroadcastTarget.update;
    db.BroadcastTarget.update = async function patched(values, options) {
      if (values.status === "sending") await db.BroadcastTarget.update.original.call(this, { status: "cancelled" }, { where: { runId, status: "pending" } });
      return original.call(this, values, options);
    };
    db.BroadcastTarget.update.original = original;
    try {
      const result = await engine.tick(clock.now());
      assert.equal(result.skipped, 1);
      assert.equal(result.claimed, 0);
    } finally {
      db.BroadcastTarget.update = original;
    }
    assert.equal(sock.sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// createOnce / createRecurring limits
// ---------------------------------------------------------------------------

describe("creation limits", () => {
  const code = (promise) => promise.then(() => null, (err) => ({ code: err.code, params: err.params }));

  test("1 to 200 targets", async () => {
    const { engine } = newEngine();
    assert.equal((await code(engine.createOnce({ text: "x", targets: [] }))).code, "invalid_destination");
    assert.equal((await code(engine.createOnce({ text: "x" }))).code, "invalid_destination");
    const many = Array.from({ length: 201 }, (_, i) => `${5000 + i}@s.whatsapp.net`);
    const refused = await code(engine.createOnce({ text: "x", targets: many }));
    assert.deepEqual(refused, { code: "too_many_targets", params: { max: 200 } });

    const ok = await chats(200, { start: 7000 });
    const { runId } = await engine.createOnce({ text: "x", targets: ok }, { now: clock.now() });
    assert.equal((await runRow(runId)).total, 200);
    assert.equal(await db.BroadcastTarget.count({ where: { runId } }), 200);
  });

  test("invalid_destination: a hand-typed number, a left group, a disabled chat (with the indices)", async () => {
    const [known] = await chats(1);
    const [group] = await chats(1, { start: 2000, kind: "group" });
    await db.KnownChat.update({ leftAt: new Date(T0) }, { where: { jid: group } });
    const [banned] = await chats(1, { start: 3000 });
    await db.BannedChat.create({ jid: banned });
    const { engine } = newEngine();
    const result = await code(engine.createOnce({ text: "x", targets: [known, "237650000000@s.whatsapp.net", group, banned, "status@broadcast"] }));
    assert.equal(result.code, "invalid_destination");
    assert.deepEqual(result.params.indices, [1, 2, 3, 4]);
    assert.equal(await db.Broadcast.count(), 0, "nothing was created");
  });

  test("destinations are de-duplicated by phone-number JID", async () => {
    await db.KnownChat.bulkCreate([
      { jid: "111@s.whatsapp.net", kind: "private", pnJid: "111@s.whatsapp.net", firstSeenAt: new Date(T0), lastSeenAt: new Date(T0) },
      { jid: "9991@lid", kind: "private", pnJid: "111@s.whatsapp.net", firstSeenAt: new Date(T0), lastSeenAt: new Date(T0) },
    ]);
    const { engine } = newEngine();
    const { runId } = await engine.createOnce({ text: "x", targets: ["111@s.whatsapp.net", "9991@lid", "111@s.whatsapp.net"] }, { now: clock.now() });
    assert.equal(await db.BroadcastTarget.count({ where: { runId } }), 1);
  });

  test("empty_text and text_too_long (4096 without media, 1024 with a caption)", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    for (const text of [undefined, null, "", "   \n ", 42]) {
      assert.equal((await code(engine.createOnce({ text, targets: [jid] }))).code, "empty_text", String(text));
    }
    const max = await code(engine.createOnce({ text: "x".repeat(4097), targets: [jid] }));
    assert.deepEqual(max, { code: "text_too_long", params: { max: 4096 } });
    await engine.createOnce({ text: "x".repeat(4096), targets: [jid] }, { now: clock.now() });

    const media = { path: stage("p.png", PNG), name: "p.png" };
    const caption = await code(engine.createOnce({ text: "x".repeat(1025), targets: [jid], media }));
    assert.deepEqual(caption, { code: "text_too_long", params: { max: 1024 } });
    assert.ok(fs.existsSync(media.path), "a refused upload is left where it was");
    const ok = await engine.createOnce({ text: "x".repeat(1024), targets: [jid], media }, { now: clock.now() });
    assert.ok(ok.runId);
  });

  test("media_type: only images and documents; media_too_large against the live MAX_UPLOAD", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const elf = await code(engine.createOnce({ text: "x", targets: [jid], media: { path: stage("a.png", ELF), name: "a.png" } }));
    assert.equal(elf.code, "media_type");
    const missing = await code(engine.createOnce({ text: "x", targets: [jid], media: { path: path.join(tmp, "nope.png"), name: "x" } }));
    assert.equal(missing.code, "media_type");
    const noPath = await code(engine.createOnce({ text: "x", targets: [jid], media: { name: "x" } }));
    assert.equal(noPath.code, "media_type");

    const big = stage("big.pdf", Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]));
    const tooBig = await code(engine.createOnce({ text: "x", targets: [jid], media: { path: big, name: "big.pdf" } }));
    assert.equal(tooBig.code, "media_too_large");
    assert.equal(tooBig.params.maxBytes, 1024 * 1024);
    cfg.MAX_UPLOAD = 2; // live: the same file now fits
    const fits = await engine.createOnce({ text: "x", targets: [jid], media: { path: big, name: "big.pdf" } }, { now: clock.now() });
    assert.ok(fits.broadcastId);
    assert.equal(await db.Broadcast.count({ where: { mediaKind: "document" } }), 1);
  });

  test("plain text files are accepted as documents; media and reuseMediaOf together are refused", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId } = await engine.createOnce(
      { text: "x", targets: [jid], media: { path: stage("n.txt", "hello\n"), name: "n.txt" } },
      { now: clock.now() },
    );
    const row = await db.Broadcast.findByPk(broadcastId, { raw: true });
    assert.equal(row.mediaKind, "document");
    assert.equal(row.mediaMime, "text/plain");
    const both = await code(engine.createOnce({ text: "x", targets: [jid], reuseMediaOf: broadcastId, media: { path: stage("m.png", PNG), name: "m" } }));
    assert.equal(both.code, "media_type");
  });

  test("invalid_rule carries the recurrence code; the once/recurring field rules of the model hold", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    assert.deepEqual(await code(engine.createRecurring({ text: "x", targets: [jid] })), { code: "invalid_rule", params: { code: "bad_kind" } });
    assert.deepEqual(await code(engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "weekly", days: [], time: "08:00" } })), {
      code: "invalid_rule",
      params: { code: "bad_days" },
    });
    assert.deepEqual(await code(engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "monthly", day: 32, time: "08:00" } })), {
      code: "invalid_rule",
      params: { code: "bad_day" },
    });
    assert.deepEqual(await code(engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "8am" } })), {
      code: "invalid_rule",
      params: { code: "bad_time" },
    });
    assert.equal((await code(engine.createOnce({ text: "x", targets: [jid], runAt: "not a date" }))).code, "invalid_rule");

    const weekly = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "weekly", days: [5, 1], time: "07:30" } }, { now: clock.now() });
    const monthly = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "monthly", day: 31, time: "07:30" } }, { now: clock.now() });
    const daily = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "07:30" } }, { now: clock.now() });
    const rows = await Promise.all([weekly, monthly, daily].map((r) => db.Broadcast.findByPk(r.broadcastId, { raw: true })));
    assert.deepEqual(rows.map((r) => [r.kind, r.recurKind, r.recurDays, r.recurTime, r.status, r.runAt]), [
      ["recurring", "weekly", "1,5", "07:30", "active", null],
      ["recurring", "monthly", "31", "07:30", "active", null],
      ["recurring", "daily", null, "07:30", "active", null],
    ]);
    assert.deepEqual(engine.ruleOf(rows[0]), { kind: "weekly", days: [1, 5], time: "07:30" });
    assert.equal(engine.ruleOf({ kind: "once" }), null);
  });

  test("a one-shot broadcast creates its run and targets together, targetsReady last", async () => {
    const targets = await chats(3);
    const { engine } = newEngine();
    const when = clock.now() + 5 * 60000;
    const { broadcastId, runId } = await engine.createOnce({ title: "  Promo  ", text: " hello ", targets, runAt: new Date(when) }, { now: clock.now() });
    const row = (await db.Broadcast.findByPk(broadcastId)).get({ plain: true });
    assert.equal(row.kind, "once");
    assert.equal(row.title, "Promo");
    assert.equal(row.text, "hello");
    assert.equal(row.status, "active");
    assert.equal(new Date(row.runAt).getTime(), when);
    assert.deepEqual(row.targets, targets);
    const run = await runRow(runId);
    assert.equal(run.status, "scheduled");
    assert.equal(run.total, 3);
    assert.equal(run.targetsReady, 1);
    assert.equal(new Date(run.dueAt).getTime(), when);
    assert.deepEqual((await targetsOf(runId)).map((t) => [t.position, t.status, t.attempts]), [[1, "pending", 0], [2, "pending", 0], [3, "pending", 0]]);
  });

  test("send now: dueAt is the creation time and runAt stays empty", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId, runId } = await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    assert.equal((await db.Broadcast.findByPk(broadcastId, { raw: true })).runAt, null);
    assert.equal(new Date((await runRow(runId)).dueAt).getTime(), clock.now());
  });

  test("a creation that fails midway leaves nothing behind", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const original = db.BroadcastTarget.bulkCreate;
    db.BroadcastTarget.bulkCreate = () => Promise.reject(new Error("disk full"));
    try {
      await assert.rejects(engine.createOnce({ text: "x", targets: [jid], media: { path: stage("k.png", PNG), name: "k.png" } }, { now: clock.now() }), /disk full/);
    } finally {
      db.BroadcastTarget.bulkCreate = original;
    }
    assert.equal(await db.Broadcast.count(), 0);
    assert.equal(await db.BroadcastRun.count(), 0);
    assert.ok(!fs.existsSync(mediaRoot()) || fs.readdirSync(mediaRoot()).length === 0, "the media directory is removed");
    assert.ok(fs.existsSync(path.join(tmp, "stage", "k.png")), "the staged upload is kept");
  });
});

// ---------------------------------------------------------------------------
// No retry (U14)
// ---------------------------------------------------------------------------

describe("no retry (U14)", () => {
  test("no function of the engine moves a final target back to pending", async () => {
    const targets = await chats(3);
    const { engine, sock } = newEngine();
    assert.deepEqual(
      Object.keys(engine).filter((name) => /retry|requeue|reopen|redeliver|resend|reset/i.test(name)),
      [],
    );
    const original = sock.sendMessage;
    sock.sendMessage = async (jid, content, options) => {
      if (jid === targets[1]) throw boom(403, "forbidden");
      return original(jid, content, options);
    };
    const { broadcastId, runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await drive(engine, { steps: 4, stepMs: 2000 });
    const final = await statusOf(runId);
    assert.deepEqual(Object.values(final), ["sent", "failed/forbidden", "sent"]);

    // every function that could touch it, called with and without effect
    await engine.cancelRun(runId).catch(() => {});
    await engine.pause(broadcastId).catch(() => {});
    await engine.resume(broadcastId).catch(() => {});
    await engine.updateRecurring(broadcastId, { text: "y" }).catch(() => {});
    await engine.recomputeRecurrences({ now: clock.now() });
    await engine.sweepMedia({ now: clock.now() + 30 * DAY });
    await engine.purgeFinishedMedia({ now: clock.now() + 30 * DAY });
    await drive(engine, { steps: 5, stepMs: 60000 });
    clock.set(clock.now() + 3 * DAY);
    await engine.tick(clock.now());
    assert.deepEqual(await statusOf(runId), final);
    assert.equal(sock.sent.length, 2, "the failed destination was never served again");
    assert.equal((await runRow(runId)).status, "completed");
    assert.ok(!/update\(\s*\{[^}]*status:\s*["']pending["']/s.test(fs.readFileSync(require.resolve("../lib/utils/broadcaster"), "utf8")));
  });

  test("a failed destination is served again only by a new broadcast (own run, own targets)", async () => {
    const targets = await chats(2);
    const { engine, sock } = newEngine();
    const original = sock.sendMessage;
    let failOnce = true;
    sock.sendMessage = async (jid, content, options) => {
      if (jid === targets[1] && failOnce) {
        failOnce = false;
        throw boom(428, "Connection Closed");
      }
      return original(jid, content, options);
    };
    const first = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await drive(engine, { steps: 3, stepMs: 2000 });
    const { targets: report } = await engine.report(first.runId);
    const failed = report.filter((t) => t.status === "failed").map((t) => t.chatJid);
    assert.deepEqual(failed, [targets[1]]);

    const second = await engine.createOnce({ text: "x", targets: failed, spacingMs: 2000 }, { now: clock.now() });
    assert.notEqual(second.broadcastId, first.broadcastId);
    assert.notEqual(second.runId, first.runId);
    await drive(engine, { steps: 2, stepMs: 2000 });
    assert.equal(sentJids(sock).filter((j) => j === targets[1]).length, 1);
    assert.equal((await statusOf(first.runId))[targets[1]], "failed/connection_closed");
    assert.equal((await statusOf(second.runId))[targets[1]], "sent");
  });
});

// ---------------------------------------------------------------------------
// Media (U15, O1)
// ---------------------------------------------------------------------------

describe("media", () => {
  test("an upload is moved to data/broadcast-media/<id>/ with a sanitized name and sent as an image / document", async () => {
    const [a, b] = await chats(2);
    const { engine, sock } = newEngine();
    const image = await engine.createOnce({ text: "look", targets: [a], spacingMs: 2000, media: { path: stage("up1.bin", PNG), name: "../../evil name?.png" } }, { now: clock.now() });
    const row = await db.Broadcast.findByPk(image.broadcastId, { raw: true });
    assert.equal(row.mediaKind, "image");
    assert.equal(row.mediaMime, "image/png");
    assert.equal(row.mediaSize, PNG.length);
    assert.equal(row.mediaName, "evil name_.png");
    assert.equal(row.mediaPath, `data/broadcast-media/${image.broadcastId}/evil name_.png`);
    const file = path.join(tmp, row.mediaPath);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(fs.readFileSync(file), PNG);
    assert.ok(!fs.existsSync(path.join(tmp, "stage", "up1.bin")), "moved out of the staging area");

    const doc = await engine.createOnce({ text: "see", targets: [b], spacingMs: 2000, media: { path: stage("up2.bin", PDF), name: "report.pdf" } }, { now: clock.now() });
    await drive(engine, { steps: 3, stepMs: 2000 });
    const [first, second] = sock.sent;
    assert.deepEqual(first.content, { image: { url: file }, caption: "look" });
    const docRow = await db.Broadcast.findByPk(doc.broadcastId, { raw: true });
    assert.deepEqual(second.content, {
      document: { url: path.join(tmp, docRow.mediaPath) },
      mimetype: "application/pdf",
      fileName: "report.pdf",
      caption: "see",
    });
  });

  test("the media directory is checked to stay inside (a stored path that leaves it is never sent)", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    const outside = stage("outside.png", PNG);
    const { broadcastId, runId } = await engine.createOnce({ text: "x", targets: [jid], media: { path: stage("ok.png", PNG), name: "ok.png" } }, { now: clock.now() });
    await db.Broadcast.update({ mediaPath: path.relative(tmp, outside) }, { where: { id: broadcastId } });
    await engine.tick(clock.now());
    assert.equal(sock.sent.length, 0);
    assert.equal((await statusOf(runId))[jid], "failed/error");
  });

  test("a missing media file settles the target failed/error and never falls back to a text-only message", async () => {
    const targets = await chats(2);
    const { engine, sock } = newEngine();
    const { broadcastId, runId } = await engine.createOnce(
      { text: "caption", targets, spacingMs: 2000, media: { path: stage("gone.png", PNG), name: "gone.png" } },
      { now: clock.now() },
    );
    const row = await db.Broadcast.findByPk(broadcastId, { raw: true });
    fs.rmSync(path.join(tmp, row.mediaPath));
    await drive(engine, { steps: 3, stepMs: 2000 });
    assert.equal(sock.sent.length, 0, "nothing was sent, not even the text");
    assert.deepEqual(Object.values(await statusOf(runId)), ["failed/error", "failed/error"]);
    assert.equal((await runRow(runId)).status, "failed");
  });

  test("O1: reuseMediaOf copies the media into the new broadcast's own directory", async () => {
    const [a, b] = await chats(2);
    const { engine } = newEngine();
    const source = await engine.createOnce({ text: "x", targets: [a], media: { path: stage("s.png", PNG), name: "s.png" } }, { now: clock.now() });
    const copy = await engine.createOnce({ text: "again", targets: [b], reuseMediaOf: source.broadcastId }, { now: clock.now() });
    const [from, to] = await Promise.all([source, copy].map((r) => db.Broadcast.findByPk(r.broadcastId, { raw: true })));
    assert.notEqual(to.mediaPath, from.mediaPath);
    assert.equal(to.mediaPath, `data/broadcast-media/${copy.broadcastId}/s.png`);
    assert.deepEqual([to.mediaKind, to.mediaMime, to.mediaName, to.mediaSize], [from.mediaKind, from.mediaMime, from.mediaName, from.mediaSize]);
    assert.deepEqual(fs.readFileSync(path.join(tmp, to.mediaPath)), PNG);

    // the copy is independent: purging the finished source keeps it
    await engine.cancelRun(source.runId);
    await engine.purgeFinishedMedia({ now: clock.now() });
    assert.ok(!fs.existsSync(path.join(tmp, from.mediaPath)));
    assert.ok(fs.existsSync(path.join(tmp, to.mediaPath)), "the copy still has its own file");
  });

  test("O1: media_unavailable when the source has no media, never had a file, or lost it", async () => {
    const [a, b] = await chats(2);
    const { engine } = newEngine();
    const plain = await engine.createOnce({ text: "x", targets: [a] }, { now: clock.now() });
    const withMedia = await engine.createOnce({ text: "x", targets: [b], media: { path: stage("w.png", PNG), name: "w.png" } }, { now: clock.now() });
    const code = (promise) => promise.then(() => null, (err) => err.code);
    assert.equal(await code(engine.createOnce({ text: "x", targets: [a], reuseMediaOf: plain.broadcastId })), "media_unavailable");
    assert.equal(await code(engine.createOnce({ text: "x", targets: [a], reuseMediaOf: 999999 })), "media_unavailable");
    // already deleted by the retention rule
    await engine.cancelRun(withMedia.runId);
    await engine.purgeFinishedMedia({ now: clock.now() });
    assert.equal(await code(engine.createOnce({ text: "x", targets: [a], reuseMediaOf: withMedia.broadcastId })), "media_unavailable");
    const row = await db.Broadcast.findByPk(withMedia.broadcastId, { raw: true });
    assert.equal(row.mediaPath, null);
    assert.equal(row.mediaKind, "image", "the history keeps what was sent");
    assert.equal(row.mediaName, "w.png");
  });

  test("U15: the media of a once broadcast is deleted 7 days after its run ends (sweepMedia)", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId, runId } = await engine.createOnce({ text: "x", targets: [jid], media: { path: stage("r.png", PNG), name: "r.png" } }, { now: clock.now() });
    const dir = path.join(mediaRoot(), String(broadcastId));
    assert.ok(fs.existsSync(dir));

    // the run is open: kept, whatever the date
    const open = await engine.sweepMedia({ now: clock.now() + 30 * DAY });
    assert.equal(open.removed, 0);
    assert.ok(fs.existsSync(dir));

    await engine.tick(clock.now());
    const finishedAt = new Date((await runRow(runId)).finishedAt).getTime();
    assert.ok((await runRow(runId)).status === "completed");

    const early = await engine.sweepMedia({ now: finishedAt + 7 * DAY - 1 });
    assert.equal(early.removed, 0);
    assert.ok(fs.existsSync(dir));
    const due = await engine.sweepMedia({ now: finishedAt + 7 * DAY });
    assert.equal(due.removed, 1);
    assert.equal(due.freedBytes, PNG.length);
    assert.ok(!fs.existsSync(dir));
    assert.equal((await db.Broadcast.findByPk(broadcastId, { raw: true })).mediaPath, null);
    // a second sweep is a no-op
    assert.deepEqual(await engine.sweepMedia({ now: finishedAt + 8 * DAY }), { freedBytes: 0, removed: 0, skipped: 0, cleared: 0, orphans: 0 });
  });

  test("U15: a recurring broadcast keeps its media (until the broadcast is deleted)", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId } = await engine.createRecurring(
      { text: "x", targets: [jid], rule: { kind: "daily", time: "08:00" }, media: { path: stage("rec.png", PNG), name: "rec.png" } },
      { now: clock.now() },
    );
    const dir = path.join(mediaRoot(), String(broadcastId));
    assert.ok(fs.existsSync(dir));
    const swept = await engine.sweepMedia({ now: clock.now() + 365 * DAY });
    assert.equal(swept.removed, 0);
    const purged = await engine.purgeFinishedMedia({ now: clock.now() + 365 * DAY });
    assert.deepEqual(purged, { freedBytes: 0, removed: 0, skipped: 1 });
    assert.ok(fs.existsSync(dir));
    await engine.remove(broadcastId);
    assert.ok(!fs.existsSync(dir), "deleted with the broadcast");
    assert.equal(await db.Broadcast.count(), 0);
  });

  test("U15: purgeFinishedMedia deletes finished once-media at once and never touches what may still be sent", async () => {
    const [a, b, c] = await chats(3);
    const { engine } = newEngine();
    const done = await engine.createOnce({ text: "x", targets: [a], media: { path: stage("d.png", PNG), name: "d.png" } }, { now: clock.now() });
    const later = await engine.createOnce({ text: "x", targets: [b], runAt: clock.now() + 2 * HOUR, media: { path: stage("l.png", PNG), name: "l.png" } }, { now: clock.now() });
    const rec = await engine.createRecurring({ text: "x", targets: [c], rule: { kind: "daily", time: "08:00" }, media: { path: stage("c.png", PNG), name: "c.png" } }, { now: clock.now() });
    await engine.tick(clock.now()); // sends the first one only (the second is not due)
    assert.equal((await runRow(done.runId)).status, "completed");

    const result = await engine.purgeFinishedMedia({ now: clock.now() });
    assert.deepEqual(result, { freedBytes: PNG.length, removed: 1, skipped: 2 });
    assert.ok(!fs.existsSync(path.join(mediaRoot(), String(done.broadcastId))));
    assert.ok(fs.existsSync(path.join(mediaRoot(), String(later.broadcastId))));
    assert.ok(fs.existsSync(path.join(mediaRoot(), String(rec.broadcastId))));
    // idempotent
    assert.deepEqual(await engine.purgeFinishedMedia({ now: clock.now() }), { freedBytes: 0, removed: 0, skipped: 2 });
  });

  test("U15: the sweep clears a dangling mediaPath and removes directories with no broadcast", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId, runId } = await engine.createOnce({ text: "x", targets: [jid], media: { path: stage("g.png", PNG), name: "g.png" } }, { now: clock.now() });
    await engine.tick(clock.now());
    fs.rmSync(path.join(mediaRoot(), String(broadcastId)), { recursive: true });
    fs.mkdirSync(path.join(mediaRoot(), "424242"), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot(), "424242", "old.png"), PNG);
    fs.mkdirSync(path.join(mediaRoot(), "not-an-id"), { recursive: true });
    const result = await engine.sweepMedia({ now: new Date((await runRow(runId)).finishedAt).getTime() + 1000 });
    assert.equal(result.cleared, 1);
    assert.equal(result.orphans, 1);
    assert.equal((await db.Broadcast.findByPk(broadcastId, { raw: true })).mediaPath, null);
    assert.ok(!fs.existsSync(path.join(mediaRoot(), "424242")));
    assert.ok(fs.existsSync(path.join(mediaRoot(), "not-an-id")), "only numeric directories are looked at");
  });

  test("editing a recurring broadcast's media replaces the file", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId } = await engine.createRecurring(
      { text: "x", targets: [jid], rule: { kind: "daily", time: "08:00" }, media: { path: stage("first.png", PNG), name: "first.png" } },
      { now: clock.now() },
    );
    await engine.updateRecurring(broadcastId, { media: { path: stage("second.pdf", PDF), name: "second.pdf" } }, { now: clock.now() });
    const row = await db.Broadcast.findByPk(broadcastId, { raw: true });
    assert.equal(row.mediaKind, "document");
    assert.equal(row.mediaName, "second.pdf");
    assert.deepEqual(fs.readdirSync(path.join(mediaRoot(), String(broadcastId))), ["second.pdf"]);
  });
});

// ---------------------------------------------------------------------------
// Recurring broadcasts: edit, pause, resume, TIMEZONE
// ---------------------------------------------------------------------------

describe("recurring broadcasts", () => {
  const paris = (day, hour, minute = 0) => DateTime.fromObject({ year: 2026, month: 6, day, hour, minute }, { zone: "Europe/Paris" }).toMillis();
  const nextOf = async (id) => new Date((await db.Broadcast.findByPk(id, { raw: true })).nextRunAt).getTime();

  test("pause stops materializing; resume recomputes nextRunAt from now with no catch-up burst", async () => {
    const [jid] = await chats(1);
    clock.set(paris(1, 6));
    const { engine, sock } = newEngine();
    const { broadcastId } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "08:00" } }, { now: clock.now() });
    await engine.pause(broadcastId);
    assert.equal((await db.Broadcast.findByPk(broadcastId, { raw: true })).status, "paused");

    clock.set(paris(5, 9));
    const paused = await engine.tick(clock.now());
    assert.equal(paused.materialized + paused.expired, 0);
    assert.equal(await db.BroadcastRun.count({ where: { broadcastId } }), 0);

    await engine.resume(broadcastId, { now: clock.now() });
    assert.equal(await nextOf(broadcastId), paris(6, 8), "the next occurrence after now");
    const resumed = await engine.tick(clock.now());
    assert.equal(resumed.materialized + resumed.expired, 0, "no backlog");
    assert.equal(sock.sent.length, 0);
    clock.set(paris(6, 8));
    assert.equal((await engine.tick(clock.now())).sent, 1);
  });

  test("a rule edit recomputes nextRunAt from now; edits apply to the next occurrences only", async () => {
    const targets = await chats(2);
    clock.set(paris(1, 6));
    const { engine, sock } = newEngine();
    const { broadcastId } = await engine.createRecurring({ text: "old", targets: [targets[0]], rule: { kind: "daily", time: "08:00" } }, { now: clock.now() });
    clock.set(paris(1, 8));
    await engine.tick(clock.now());
    const [first] = sock.sent;
    assert.equal(first.content.text, "old");

    clock.set(paris(1, 9));
    await engine.updateRecurring(
      broadcastId,
      { text: "new", targets: [targets[1]], title: "Morning", spacingMs: 8000, rule: { kind: "weekly", days: [3], time: "18:15" } },
      { now: clock.now() },
    );
    const row = (await db.Broadcast.findByPk(broadcastId)).get({ plain: true });
    assert.deepEqual([row.text, row.title, row.spacingMs, row.recurKind, row.recurDays, row.recurTime], ["new", "Morning", 8000, "weekly", "3", "18:15"]);
    assert.deepEqual(row.targets, [targets[1]]);
    assert.equal(await nextOf(broadcastId), paris(3, 18, 15), "Wednesday June 3rd");
    // the run already materialized keeps its targets
    const [oldRun] = await db.BroadcastRun.findAll({ where: { broadcastId }, raw: true });
    assert.deepEqual((await targetsOf(oldRun.id)).map((t) => t.chatJid), [targets[0]]);

    clock.set(paris(3, 18, 15));
    await engine.tick(clock.now());
    assert.equal(sock.sent[1].content.text, "new");
    assert.equal(sock.sent[1].jid, targets[1]);
  });

  test("updateRecurring: not_editable for a once broadcast, not_found, validation, caption cap with media", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const once = await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    const rec = await engine.createRecurring({ text: "x".repeat(2000), targets: [jid], rule: { kind: "daily", time: "08:00" } }, { now: clock.now() });
    const code = (promise) => promise.then(() => null, (err) => err.code);
    assert.equal(await code(engine.updateRecurring(once.broadcastId, { text: "y" })), "not_editable");
    assert.equal(await code(engine.pause(once.broadcastId)), "not_editable");
    assert.equal(await code(engine.resume(once.broadcastId)), "not_editable");
    assert.equal(await code(engine.updateRecurring(999, { text: "y" })), "not_found");
    assert.equal(await code(engine.updateRecurring(rec.broadcastId, { text: "" })), "empty_text");
    assert.equal(await code(engine.updateRecurring(rec.broadcastId, { rule: { kind: "daily", time: "99:00" } })), "invalid_rule");
    assert.equal(await code(engine.updateRecurring(rec.broadcastId, { targets: ["237650000000@s.whatsapp.net"] })), "invalid_destination");
    // 2000 characters do not fit a caption
    assert.equal(await code(engine.updateRecurring(rec.broadcastId, { media: { path: stage("c.png", PNG), name: "c.png" } })), "text_too_long");
    assert.equal(await code(engine.pause(999)), "not_found");
  });

  test("a TIMEZONE change recomputes the pending occurrences from now", async () => {
    const [jid] = await chats(1);
    clock.set(paris(1, 6));
    const { engine } = newEngine();
    const { broadcastId } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "08:00" } }, { now: clock.now() });
    const before = await nextOf(broadcastId);
    assert.equal(before, paris(1, 8));

    cfg.TIMEZONE = "Asia/Tokyo";
    assert.equal(await engine.recomputeRecurrences({ now: clock.now() }), 1);
    const tokyo = DateTime.fromObject({ year: 2026, month: 6, day: 1, hour: 8 }, { zone: "Asia/Tokyo" }).toMillis();
    const expected = tokyo > clock.now() ? tokyo : tokyo + DAY;
    assert.equal(await nextOf(broadcastId), expected);
    assert.equal(await engine.recomputeRecurrences({ now: clock.now() }), 0, "nothing to move the second time");
  });

  test("the settings store change event drives the recomputation (and stops with the engine)", async () => {
    const [jid] = await chats(1);
    clock.set(paris(1, 6));
    const { engine } = newEngine();
    const { broadcastId } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "daily", time: "08:00" } }, { now: clock.now() });
    assert.equal(store.size(), 1);
    cfg.TIMEZONE = "America/New_York";
    store.emit(["LOG_LEVEL"]);
    await fakes.waitFor(async () => true);
    assert.equal(await nextOf(broadcastId), paris(1, 8), "another setting changed: untouched");
    store.emit(["TIMEZONE"]);
    await fakes.waitFor(async () => (await nextOf(broadcastId)) !== paris(1, 8));
    const newYork = DateTime.fromObject({ year: 2026, month: 6, day: 1, hour: 8 }, { zone: "America/New_York" }).toMillis();
    assert.equal(await nextOf(broadcastId), newYork > clock.now() ? newYork : newYork + DAY);
    engine.stop();
    assert.equal(store.size(), 0);
  });

  test("a recurring occurrence needs no database for the rule: monthly le 31 in a short month", async () => {
    const [jid] = await chats(1);
    clock.set(DateTime.fromObject({ year: 2026, month: 2, day: 1, hour: 6 }, { zone: "Europe/Paris" }).toMillis());
    const { engine } = newEngine();
    const { broadcastId, nextRunAt } = await engine.createRecurring({ text: "x", targets: [jid], rule: { kind: "monthly", day: 31, time: "08:00" } }, { now: clock.now() });
    assert.equal(DateTime.fromMillis(nextRunAt.getTime(), { zone: "Europe/Paris" }).toISODate(), "2026-02-28");
    clock.set(nextRunAt.getTime());
    await engine.tick(clock.now());
    assert.equal(DateTime.fromMillis(await nextOf(broadcastId), { zone: "Europe/Paris" }).toISODate(), "2026-03-31");
  });

  test("remove: refused while a run is running, otherwise definition, runs and targets go", async () => {
    const targets = await chats(2);
    const { engine, sock } = newEngine();
    const { broadcastId, runId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await engine.tick(clock.now());
    assert.equal((await runRow(runId)).status, "running");
    await assert.rejects(engine.remove(broadcastId), (err) => err.code === "busy");
    assert.equal(await db.Broadcast.count(), 1);
    await engine.cancelRun(runId);
    assert.deepEqual(await engine.remove(broadcastId), { deleted: true });
    assert.equal(await db.Broadcast.count(), 0);
    assert.equal(await db.BroadcastRun.count(), 0);
    assert.equal(await db.BroadcastTarget.count(), 0);
    await assert.rejects(engine.remove(broadcastId), (err) => err.code === "not_found");
    assert.equal(sock.sent.length, 1);
  });

  test("remove of a scheduled broadcast needs no cancel", async () => {
    const [jid] = await chats(1);
    const { engine } = newEngine();
    const { broadcastId } = await engine.createOnce({ text: "x", targets: [jid], runAt: clock.now() + DAY }, { now: clock.now() });
    await engine.remove(broadcastId);
    assert.equal(await db.BroadcastTarget.count(), 0);
  });
});

// ---------------------------------------------------------------------------
// Reads, events, lifecycle
// ---------------------------------------------------------------------------

describe("reads, events and lifecycle", () => {
  test("report, get, runs and list", async () => {
    const targets = await chats(3);
    const { engine } = newEngine();
    const one = await engine.createOnce({ title: "A", text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    const rec = await engine.createRecurring({ title: "B", text: "y", targets: [targets[0]], rule: { kind: "daily", time: "08:00" } }, { now: clock.now() });
    await drive(engine, { steps: 2, stepMs: 2000 });

    const got = await engine.get(one.broadcastId);
    assert.equal(got.broadcast.title, "A");
    assert.deepEqual(
      { status: got.latestRun.status, total: got.latestRun.total, sent: got.latestRun.sent, pending: got.latestRun.pending },
      { status: "running", total: 3, sent: 2, pending: 1 },
    );
    assert.equal(await engine.get(424242), null);
    assert.equal((await engine.runs(one.broadcastId)).length, 1);
    assert.deepEqual(await engine.runs(rec.broadcastId), []);

    const all = await engine.list();
    assert.deepEqual(all.map((i) => i.broadcast.id), [rec.broadcastId, one.broadcastId]);
    assert.equal(all[0].latestRun, null);
    assert.deepEqual((await engine.list({ kind: "once" })).map((i) => i.broadcast.id), [one.broadcastId]);
    assert.deepEqual((await engine.list({ status: "running" })).map((i) => i.broadcast.id), [one.broadcastId]);
    assert.deepEqual((await engine.list({ status: "active" })).map((i) => i.broadcast.id), [rec.broadcastId, one.broadcastId]);
    await engine.pause(rec.broadcastId);
    assert.deepEqual((await engine.list({ status: "paused" })).map((i) => i.broadcast.id), [rec.broadcastId]);

    await assert.rejects(engine.report(999999), (err) => err.code === "not_found");
    const { run, targets: rows } = await engine.report(one.runId);
    assert.equal(run.sent, 2);
    assert.deepEqual(rows.map((t) => [t.position, t.chatJid, t.status]), targets.map((jid, i) => [i + 1, jid, i < 2 ? "sent" : "pending"]));
    assert.ok(rows.every((t) => "mayHaveBeenDelivered" in t && "errorCode" in t && "sentAt" in t));
  });

  test("subscribe: an event per settled target and per run change, with the counters", async () => {
    const targets = await chats(2);
    const { engine } = newEngine();
    const events = [];
    const off = engine.subscribe((event) => events.push(event));
    const { runId, broadcastId } = await engine.createOnce({ text: "x", targets, spacingMs: 2000 }, { now: clock.now() });
    await drive(engine, { steps: 2, stepMs: 2000 });
    const kinds = events.map((e) => `${e.type}:${e.status}:${e.sent}/${e.total}`);
    assert.deepEqual(kinds, ["run:scheduled:0/2", "run:running:0/2", "target:running:1/2", "run:completed:2/2", "target:completed:2/2"]);
    const settledEvents = events.filter((e) => e.type === "target");
    assert.equal(settledEvents.length, 2);
    for (const e of events) {
      assert.equal(e.runId, runId);
      assert.equal(e.broadcastId, broadcastId);
      assert.ok(!Number.isNaN(Date.parse(e.updatedAt)));
      assert.equal(typeof e.cancelled, "number");
      assert.equal(typeof e.failed, "number");
      assert.equal(typeof e.pending, "number");
    }
    off();
    const count = events.length;
    await engine.cancelRun(runId).catch(() => {});
    assert.equal(events.length, count);
  });

  test("a throwing listener never breaks the engine", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    engine.subscribe(() => {
      throw new Error("listener bug");
    });
    await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    await engine.tick(clock.now());
    assert.equal(sock.sent.length, 1);
  });

  test("start() is idempotent with one unref'd timer, stop() clears it; no timer at require or creation", async () => {
    const created = createBroadcaster({ rootDir: tmp, config: cfg, clock: () => clock.now(), timers: clock.timers, settingsStore: store });
    engines.push(created);
    assert.equal(clock.pending(), 0);
    assert.equal(created.isRunning(), false);
    const client = fakes.fakeClient();
    created.start(client);
    created.start(client);
    assert.equal(clock.pending(), 1);
    assert.equal(created.isRunning(), true);
    assert.equal(store.size(), 1);
    created.stop();
    assert.equal(clock.pending(), 0);
    assert.equal(created.isRunning(), false);
    assert.equal(store.size(), 0);
    created.start(client); // can be started again
    assert.equal(clock.pending(), 1);
  });

  test("the interval drives tick: a due broadcast goes out without a manual tick", async () => {
    const [jid] = await chats(1);
    const { engine, sock } = newEngine();
    await engine.createOnce({ text: "x", targets: [jid] }, { now: clock.now() });
    await clock.advance(LIMITS.TICK_INTERVAL_MS + 1);
    await fakes.waitFor(() => sock.sent.length === 1);
    assert.equal(sock.sent.length, 1);
  });

  test("LIMITS", () => {
    assert.equal(LIMITS.MAX_TARGETS, 200);
    assert.equal(LIMITS.MIN_SPACING_MS, 2000);
    assert.equal(LIMITS.LATE_MS, HOUR);
    assert.equal(LIMITS.STALE_RUN_MS, DAY);
    assert.equal(LIMITS.TEXT, 4096);
    assert.equal(LIMITS.CAPTION, 1024);
    assert.ok(Object.isFrozen(LIMITS));
  });

  test("the module requires nothing from lib/admin and starts nothing at require", () => {
    const source = fs.readFileSync(require.resolve("../lib/utils/broadcaster"), "utf8");
    assert.ok(!/require\([^)]*admin/.test(source));
    const recurrenceSource = fs.readFileSync(require.resolve("../lib/utils/recurrence"), "utf8");
    assert.ok(!/require\([^)]*admin/.test(recurrenceSource));
  });
});
