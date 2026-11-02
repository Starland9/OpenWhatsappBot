"use strict";
/**
 * Retention of the messaging API's data (feature 004, data-model.md 5, contracts/runtime.md 17.3 and 10.4): the five
 * housekeeping steps appended to `run()` (apiIdempotency, apiTransient, apiMessages, apiKeys, apiMedia) on a fake
 * clock, an in-memory database and a temporary data directory, and `messaging.sweepMedia` on real staged files.
 *
 * `assertMessageInvariants` runs on what is left after each scenario.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");
const { createClock } = require("./helpers/fakeClock");
const { assertMessageInvariants } = require("./helpers/apiInvariants");

fakes.setupEnv();

const { createEngineKit } = require("./helpers/messagingKit");
const { createStage } = require("../lib/messaging/stage");
const mutex = require("../lib/utils/mutex");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const PN = "237690000001@s.whatsapp.net";

let db;
let clock;
let dir;
let stage;
let housekeeping;
let createHousekeeping;
let cfg;
let invalidated;
let sweeps;
let seq = 0;

before(async () => {
  db = await fakes.syncDb();
  ({ createHousekeeping } = require("../lib/utils/housekeeping"));
});

beforeEach(async () => {
  for (const name of ["ApiMessageResponse", "ApiMessage", "ApiKey"]) await db[name].destroy({ where: {} });
  clock = createClock(NOW);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-api-retention-"));
  stage = createStage({ rootDir: dir, dataDir: dir });
  cfg = { API_RETENTION_DAYS: 30, API_REPLY_WINDOW_DAYS: 7, TIMEZONE: "UTC" };
  invalidated = [];
  sweeps = [];
  housekeeping = build();
});

afterEach(async () => {
  housekeeping.stop();
  clock.restore();
  fs.rmSync(dir, { recursive: true, force: true });
});

function build(over = {}) {
  return createHousekeeping({
    models: db,
    clock: () => clock.now(),
    timers: clock.timers,
    dataDir: dir,
    broadcaster: null,
    messaging: { sweepMedia: async ({ now }) => (sweeps.push(now), { removed: 0, freedBytes: 0 }) },
    stage,
    config: cfg,
    settingsCache: { invalidate: (key) => invalidated.push(key) },
    timezone: () => cfg.TIMEZONE,
    ...over,
  });
}

const ago = (ms) => new Date(NOW - ms);
const publicId = () => `msg_${String(++seq).padStart(22, "H")}`;
const waId = () => `3EB0HOUSEKEEP${String(++seq).padStart(7, "0")}`;
const message = (over = {}) =>
  db.ApiMessage.create({
    publicId: publicId(),
    apiKeyId: 1,
    recipient: PN,
    format: "text",
    status: "sent",
    acceptedAt: ago(HOUR),
    expiresAt: ago(HOUR - 10 * MIN),
    sendingAt: ago(HOUR - SEC),
    sentAt: ago(HOUR - 2 * SEC),
    waId: waId(),
    ...over,
  });
const fresh = (row) => db.ApiMessage.findByPk(row.id);
const check = async () => {
  for (const row of await db.ApiMessage.findAll()) assertMessageInvariants(row);
};

describe("the report: five steps after mediaSweep, in order", () => {
  test("run() reports apiIdempotency, apiTransient, apiMessages, apiKeys, apiMedia after the older keys", async () => {
    const report = await housekeeping.run();
    const keys = Object.keys(report);
    const tail = keys.slice(keys.indexOf("mediaSweep") + 1);
    assert.deepEqual(tail.filter((k) => k !== "errors"), ["apiIdempotency", "apiTransient", "apiMessages", "apiKeys", "apiMedia"]);
    assert.deepEqual(report.errors, []);
    assert.equal(housekeeping.LIMITS.API_IDEMPOTENCY_MS, DAY);
    assert.equal(housekeeping.LIMITS.API_SENDING_STUCK_MS, 15 * MIN);
  });

  test("with the API never used all five steps are cheap no-ops", async () => {
    const report = await housekeeping.run();
    assert.equal(report.apiIdempotency, 0);
    assert.deepEqual(report.apiTransient, { interrupted: 0, payloads: 0, media: 0, replyData: 0 });
    assert.deepEqual(report.apiMessages, { messages: 0, responses: 0 });
    assert.equal(report.apiKeys, 0);
  });

  test("a failing step is reported and the others still run", async () => {
    const failing = new Proxy(db.ApiMessage, {
      get(target, prop) {
        if (prop === "update") return async () => Promise.reject(Object.assign(new Error("boom"), { code: "SQLITE_BUSY" }));
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const h = build({ models: { ...db, ApiMessage: failing } });
    const report = await h.run();
    assert.ok(report.errors.includes("apiIdempotency"));
    assert.ok(report.errors.includes("apiTransient"));
    assert.equal(report.apiIdempotency, null);
    assert.deepEqual(report.apiMessages, { messages: 0, responses: 0 }, "the later steps ran");
    assert.equal(report.apiKeys, 0);
    assert.equal(sweeps.length, 1, "apiMedia ran too");
  });
});

describe("apiIdempotency: the fingerprint lives 24 hours (FR-034)", () => {
  test("a key and a hash older than 24 h are released, younger ones and rows without a key are untouched", async () => {
    const old = await message({ idempotencyKey: "old", requestHash: "a".repeat(32), acceptedAt: ago(25 * HOUR), expiresAt: ago(25 * HOUR - 10 * MIN), sendingAt: ago(25 * HOUR - SEC), sentAt: ago(25 * HOUR - 2 * SEC) });
    const young = await message({ idempotencyKey: "young", requestHash: "b".repeat(32), acceptedAt: ago(23 * HOUR), expiresAt: ago(23 * HOUR - 10 * MIN), sendingAt: ago(23 * HOUR - SEC), sentAt: ago(23 * HOUR - 2 * SEC) });
    const none = await message({ acceptedAt: ago(40 * HOUR), expiresAt: ago(40 * HOUR - 10 * MIN), sendingAt: ago(40 * HOUR - SEC), sentAt: ago(40 * HOUR - 2 * SEC) });
    const report = await housekeeping.run();
    assert.equal(report.apiIdempotency, 1);
    const released = await fresh(old);
    assert.deepEqual([released.idempotencyKey, released.requestHash], [null, null], "both columns together (I8)");
    assert.equal((await fresh(young)).idempotencyKey, "young");
    assert.equal((await fresh(none)).idempotencyKey, null);
    assert.equal((await housekeeping.run()).apiIdempotency, 0, "idempotent");
    await check();
  });

  test("the released pair can be reused by the same key", async () => {
    await message({ apiKeyId: 5, idempotencyKey: "reuse", requestHash: "c".repeat(32), acceptedAt: ago(26 * HOUR), expiresAt: ago(26 * HOUR - 10 * MIN), sendingAt: ago(26 * HOUR - SEC), sentAt: ago(26 * HOUR - 2 * SEC) });
    await housekeeping.run();
    const again = await message({ apiKeyId: 5, idempotencyKey: "reuse", requestHash: "d".repeat(32) });
    assert.equal(again.idempotencyKey, "reuse");
  });
});

describe("apiTransient: the 15-minute net, the content wipe, the media pointers, the reply material (FR-073, FR-075)", () => {
  test("a row stuck in sending for 15 minutes becomes unknown / interrupted (T8); a younger one is left", async () => {
    const stuck = await message({ status: "sending", sentAt: null, sendingAt: ago(16 * MIN), acceptedAt: ago(17 * MIN), expiresAt: ago(7 * MIN), payload: { v: 1, input: { text: "x" }, media: null, quote: null } });
    const young = await message({ status: "sending", sentAt: null, sendingAt: ago(10 * MIN), acceptedAt: ago(11 * MIN), expiresAt: ago(MIN), payload: { v: 1, input: { text: "y" }, media: null, quote: null } });
    const report = await housekeeping.run();
    assert.equal(report.apiTransient.interrupted, 1);
    const row = await fresh(stuck);
    assert.deepEqual([row.status, row.errorCode, row.payload, row.waId === stuck.waId], ["unknown", "interrupted", null, true]);
    assert.equal(row.endedAt.getTime(), NOW);
    assert.equal(row.sentAt, null);
    assert.equal((await fresh(young)).status, "sending");
    await check();
  });

  test("an interactive stuck row keeps its reply material and gets repliesUntil = now + the reply window", async () => {
    const poll = await message({
      format: "poll",
      status: "sending",
      sentAt: null,
      sendingAt: ago(20 * MIN),
      acceptedAt: ago(21 * MIN),
      expiresAt: ago(11 * MIN),
      choices: [{ id: "0", label: "a" }, { id: "1", label: "b" }],
      replyData: { v: 1, multi: false, hashes: ["a".repeat(64), "b".repeat(64)] },
      pollSecret: "enc:v1:x:y:z",
      payload: { v: 1, input: { question: "q", options: ["a", "b"], multiple: false }, media: null, quote: null },
    });
    await housekeeping.run();
    const row = await fresh(poll);
    assert.equal(row.status, "unknown");
    assert.ok(row.choices && row.replyData && row.pollSecret, "the message may have left: answers still count");
    assert.equal(row.repliesUntil.getTime(), NOW + 7 * DAY);
    await check();
  });

  test("a late real settle is a harmless no-op after the net, and nothing is ever resent", async () => {
    const stuck = await message({ status: "sending", sentAt: null, sendingAt: ago(30 * MIN), acceptedAt: ago(31 * MIN), expiresAt: ago(21 * MIN), payload: { v: 1, input: { text: "x" }, media: null, quote: null } });
    await housekeeping.run();
    const [changed] = await db.ApiMessage.update({ status: "sent", sentAt: new Date(NOW), payload: null }, { where: { id: stuck.id, status: "sending" } });
    assert.equal(changed, 0);
    assert.equal((await fresh(stuck)).status, "unknown");
  });

  test("belt and braces: content left on a row outside queued and sending is wiped; queued and sending keep theirs", async () => {
    const leaked = await message({ payload: { v: 1, input: { text: "LEAK" }, media: null, quote: null } });
    const queued = await message({ status: "queued", sendingAt: null, sentAt: null, waId: null, acceptedAt: ago(MIN), expiresAt: new Date(NOW + 9 * MIN), payload: { v: 1, input: { text: "wait" }, media: null, quote: null } });
    const sending = await message({ status: "sending", sentAt: null, sendingAt: ago(MIN), acceptedAt: ago(2 * MIN), expiresAt: new Date(NOW + 8 * MIN), payload: { v: 1, input: { text: "now" }, media: null, quote: null } });
    const report = await housekeeping.run();
    assert.equal(report.apiTransient.payloads, 1);
    assert.equal((await fresh(leaked)).payload, null);
    assert.ok((await fresh(queued)).payload);
    assert.ok((await fresh(sending)).payload);
    await check();
  });

  test("a terminal row still holding mediaPath: the directory goes, then the pointer (I6); active rows keep theirs", async () => {
    const make = async (status, over = {}) => {
      const id = publicId();
      const source = path.join(dir, `in-${id}`);
      fs.writeFileSync(source, "pixels");
      const { mediaPath } = await stage.adopt(id, source, { mode: "move" });
      const row = await message({ publicId: id, format: "image", status, mediaPath, ...over });
      return { id, row };
    };
    const done = await make("sent");
    const failed = await make("failed", { sentAt: null, sendingAt: null, waId: null, endedAt: ago(HOUR), errorCode: "payload_unavailable" });
    const queued = await make("queued", { sendingAt: null, sentAt: null, waId: null, acceptedAt: ago(MIN), expiresAt: new Date(NOW + 9 * MIN) });
    const report = await housekeeping.run();
    assert.equal(report.apiTransient.media, 2);
    for (const { id, row } of [done, failed]) {
      assert.equal((await fresh(row)).mediaPath, null);
      assert.equal(fs.existsSync(path.join(stage.rootDir(), id)), false);
    }
    assert.ok((await fresh(queued.row)).mediaPath);
    assert.ok(fs.existsSync(path.join(stage.rootDir(), queued.id)));
    await check();
  });

  test("a pointer whose directory is already gone is still cleared", async () => {
    const gone = await message({ format: "image", mediaPath: `data/api-media/${publicId()}/source` });
    await housekeeping.run();
    assert.equal((await fresh(gone)).mediaPath, null);
  });

  test("replyData and pollSecret are NULLed once repliesUntil has passed; a live window keeps them", async () => {
    const base = { format: "poll", choices: [{ id: "0", label: "a" }], replyData: { v: 1, multi: false, hashes: ["a".repeat(64)] }, pollSecret: "enc:v1:x:y:z" };
    const expired = await message({ ...base, repliesUntil: ago(MIN) });
    const live = await message({ ...base, repliesUntil: new Date(NOW + DAY) });
    const report = await housekeeping.run();
    assert.equal(report.apiTransient.replyData, 1);
    const a = await fresh(expired);
    assert.deepEqual([a.replyData, a.pollSecret], [null, null]);
    assert.ok(a.choices, "the labels stay for the retention period");
    const b = await fresh(live);
    assert.ok(b.replyData && b.pollSecret);
    await check();
  });
});

describe("apiMessages: the retention purge (FR-074)", () => {
  const old = (days, over = {}) => ({
    acceptedAt: ago(days * DAY),
    expiresAt: ago(days * DAY - 10 * MIN),
    sendingAt: ago(days * DAY - SEC),
    sentAt: ago(days * DAY - 2 * SEC),
    ...over,
  });

  test("messages older than API_RETENTION_DAYS go with their responses; younger ones stay", async () => {
    const gone = await message(old(31, { format: "buttons", choices: [{ id: "a", label: "A" }] }));
    const kept = await message(old(29, { format: "buttons", choices: [{ id: "a", label: "A" }] }));
    await db.ApiMessageResponse.bulkCreate([
      { messageId: gone.id, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: "s1", respondedAt: ago(30 * DAY) },
      { messageId: gone.id, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: "s2", respondedAt: ago(30 * DAY) },
      { messageId: kept.id, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: "s3", respondedAt: ago(28 * DAY) },
    ]);
    const report = await housekeeping.run();
    assert.deepEqual(report.apiMessages, { messages: 1, responses: 2 });
    assert.equal(await fresh(gone), null);
    assert.ok(await fresh(kept));
    assert.equal(await db.ApiMessageResponse.count(), 1);
    assert.equal((await housekeeping.run()).apiMessages.messages, 0, "idempotent");
  });

  test("the retention is read from the settings at run time", async () => {
    const row = await message(old(10));
    await housekeeping.run();
    assert.ok(await fresh(row));
    cfg.API_RETENTION_DAYS = 7;
    await housekeeping.run();
    assert.equal(await fresh(row), null);
  });

  test("a queued message is never purged however old; a stuck sending one is first ended by the net, then it is old enough to go", async () => {
    const queued = await message(old(90, { status: "queued", sendingAt: null, sentAt: null, waId: null }));
    const sending = await message(old(90, { status: "sending", sentAt: null, sendingAt: ago(90 * DAY - SEC) }));
    await housekeeping.run();
    // the 15-minute net turns the stuck sending row into unknown first, then it is old enough to go; the queued one stays
    assert.ok(await fresh(queued));
    assert.equal(await fresh(sending), null);
  });

  test("a big purge runs in batches of 500, responses first", async () => {
    const rows = [];
    for (let i = 0; i < 1100; i += 1) rows.push({ publicId: `msg_${String(i).padStart(22, "B")}`, apiKeyId: 1, recipient: PN, format: "text", status: "sent", acceptedAt: ago(40 * DAY), expiresAt: ago(40 * DAY - 10 * MIN), sendingAt: ago(40 * DAY - SEC), sentAt: ago(40 * DAY - 2 * SEC), waId: `3EB0BATCH${String(i).padStart(11, "0")}` });
    await db.ApiMessage.bulkCreate(rows);
    const first = await db.ApiMessage.findOne({ order: [["id", "ASC"]] });
    await db.ApiMessageResponse.create({ messageId: first.id, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: "batch", respondedAt: ago(40 * DAY) });
    const report = await housekeeping.run();
    assert.equal(report.apiMessages.messages, 1100);
    assert.equal(await db.ApiMessage.count(), 0);
    assert.equal(await db.ApiMessageResponse.count(), 0);
  });

  test("orphan responses (their message is gone) and responses older than the cutoff are removed", async () => {
    const live = await message({ format: "buttons", choices: [{ id: "a", label: "A" }], acceptedAt: ago(DAY), expiresAt: ago(DAY - 10 * MIN), sendingAt: ago(DAY - SEC), sentAt: ago(DAY - 2 * SEC) });
    await db.ApiMessageResponse.bulkCreate([
      { messageId: 987654, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: "orphan", respondedAt: ago(HOUR) },
      { messageId: live.id, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: "ancient", respondedAt: ago(45 * DAY) },
      { messageId: live.id, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: "fine", respondedAt: ago(HOUR) },
    ]);
    const report = await housekeeping.run();
    assert.equal(report.apiMessages.responses, 2);
    assert.deepEqual((await db.ApiMessageResponse.findAll()).map((r) => r.sourceId), ["fine"]);
  });

  test("today's rows are never purged, even on a 25-hour day (the cutoff is the earlier of the retention and the start of the local day)", async () => {
    // Europe/Paris falls back on 2026-10-25: that local day lasts 25 hours, from 22:00Z the day before to 23:00Z
    cfg.TIMEZONE = "Europe/Paris";
    cfg.API_RETENTION_DAYS = 1;
    const now = Date.UTC(2026, 9, 25, 22, 30, 0); // 23:30 local, the last half hour of that day
    clock.set(now);
    const startOfDay = Date.UTC(2026, 9, 24, 22, 0, 0);
    const early = new Date(startOfDay + 15 * MIN); // 00:15 local today: 24 h 15 min before `now`
    const yesterday = new Date(startOfDay - HOUR);
    const mk = (at, over = {}) =>
      message({ acceptedAt: at, expiresAt: new Date(at.getTime() + 10 * MIN), sendingAt: new Date(at.getTime() + SEC), sentAt: new Date(at.getTime() + 2 * SEC), ...over });
    const today = await mk(early);
    const before = await mk(yesterday);
    const h = build();
    await h.run({ now });
    assert.ok(await fresh(today), "today's rows feed the day quota: kept although older than 24 h");
    assert.equal(await fresh(before), null, "yesterday's row is past both limits");
    h.stop();
  });
});

describe("apiKeys: revoked keys leave after the retention (U10)", () => {
  const key = (name, over = {}) =>
    db.ApiKey.create({ name, nameKey: over.revokedAt ? null : name.toLowerCase(), lookupId: String(++seq).padStart(16, "0"), secretHash: String(seq).padStart(64, "0"), last4: "abcd", ...over });

  test("a key revoked more than API_RETENTION_DAYS ago is deleted after its messages, then the key cache is invalidated", async () => {
    const gone = await key("Old", { revokedAt: ago(31 * DAY) });
    const recent = await key("Recent", { revokedAt: ago(29 * DAY) });
    const live = await key("Live");
    const expired = await key("Expired", { expiresAt: ago(90 * DAY) });
    const msg = await message({ apiKeyId: gone.id, ...{ acceptedAt: ago(40 * DAY), expiresAt: ago(40 * DAY - 10 * MIN), sendingAt: ago(40 * DAY - SEC), sentAt: ago(40 * DAY - 2 * SEC) } });
    const report = await housekeeping.run();
    assert.equal(report.apiKeys, 1);
    assert.equal(await db.ApiKey.findByPk(gone.id), null);
    assert.ok(await db.ApiKey.findByPk(recent.id));
    assert.ok(await db.ApiKey.findByPk(live.id));
    assert.ok(await db.ApiKey.findByPk(expired.id), "an expired key that is not revoked stays: the owner can extend it");
    assert.equal(await fresh(msg), null, "its messages went first");
    assert.deepEqual(invalidated, ["api_keys"]);
  });

  test("nothing deleted means no invalidation", async () => {
    await key("Live");
    await housekeeping.run();
    assert.deepEqual(invalidated, []);
  });
});

describe("apiMedia: the sweep of the staging area (FR-075)", () => {
  test("the engine's sweepMedia is called with the run's time, outside any lock; absent engine: null; a failure is listed", async () => {
    let lockHeld = null;
    const held = mutex.withLock("api-outbox", () => new Promise((resolve) => (lockHeld = resolve)));
    const report = await housekeeping.run({ now: NOW });
    lockHeld();
    await held;
    assert.deepEqual(sweeps, [NOW]);
    assert.deepEqual(report.apiMedia, { removed: 0, freedBytes: 0 });

    const absent = build({ messaging: null });
    assert.equal((await absent.run()).apiMedia, null);

    const failing = build({ messaging: { sweepMedia: async () => Promise.reject(new Error("disk")) } });
    const failed = await failing.run();
    assert.deepEqual(failed.errors, ["apiMedia"]);
  });
});

describe("messaging.sweepMedia on real staged files (10.4)", () => {
  let kit;

  beforeEach(async () => {
    kit = await createEngineKit({ realTime: true });
    await kit.key();
  });
  afterEach(async () => {
    await kit.close();
  });

  const stageDir = (id) => path.join(kit.stage.rootDir(), id);
  async function staged(id, ageMs) {
    const source = path.join(kit.tmp, `src-${id}`);
    fs.writeFileSync(source, "x".repeat(100));
    await kit.stage.adopt(id, source, { mode: "move" });
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(stageDir(id), when, when);
  }
  const queuedRow = (id, status) =>
    kit.db.ApiMessage.create({
      publicId: id,
      apiKeyId: 1,
      recipient: PN,
      format: "image",
      status,
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * MIN),
      ...(status === "sending" ? { sendingAt: new Date(), waId: `3EB0SWEEP${seq++}00000000` } : {}),
      payload: { v: 1, input: {}, media: null, quote: null },
    });

  test("an orphan older than an hour goes, a younger one stays, a queued or sending one stays however old", async () => {
    const orphan = `msg_${"O".repeat(22)}`;
    const young = `msg_${"Y".repeat(22)}`;
    const queued = `msg_${"Q".repeat(22)}`;
    const sending = `msg_${"S".repeat(22)}`;
    await staged(orphan, 2 * HOUR);
    await staged(young, 10 * MIN);
    await staged(queued, 5 * HOUR);
    await staged(sending, 5 * HOUR);
    await queuedRow(queued, "queued");
    await queuedRow(sending, "sending");

    const result = await kit.messaging.sweepMedia({ now: Date.now() });
    assert.equal(result.removed, 1);
    assert.equal(result.freedBytes, 100);
    assert.equal(fs.existsSync(stageDir(orphan)), false);
    for (const id of [young, queued, sending]) assert.equal(fs.existsSync(stageDir(id)), true, id);
  });

  test("a terminal row's directory is an orphan too; foreign names in the root are left alone", async () => {
    const done = `msg_${"T".repeat(22)}`;
    await staged(done, 3 * HOUR);
    await kit.db.ApiMessage.create({ publicId: done, apiKeyId: 1, recipient: PN, format: "image", status: "failed", acceptedAt: new Date(Date.now() - 4 * HOUR), expiresAt: new Date(Date.now() - 3 * HOUR), endedAt: new Date(Date.now() - 3 * HOUR), errorCode: "send_failed", mediaPath: `data/api-media/${done}/source` });
    fs.mkdirSync(path.join(kit.stage.rootDir(), "not-a-message"), { recursive: true });
    fs.utimesSync(path.join(kit.stage.rootDir(), "not-a-message"), new Date(Date.now() - 9 * HOUR), new Date(Date.now() - 9 * HOUR));
    await kit.messaging.sweepMedia({ now: Date.now() });
    assert.equal(fs.existsSync(stageDir(done)), false);
    assert.equal(fs.existsSync(path.join(kit.stage.rootDir(), "not-a-message")), true, "only directories named like a message are the engine's");
  });

  test("upload leftovers data/tmp/api/*.part older than an hour are swept, younger ones and other files stay", async () => {
    const tmpApi = path.join(kit.dataDir, "tmp", "api");
    fs.mkdirSync(tmpApi, { recursive: true });
    const oldPart = path.join(tmpApi, "aaaa.part");
    const youngPart = path.join(tmpApi, "bbbb.part");
    const other = path.join(tmpApi, "keep.txt");
    for (const file of [oldPart, youngPart, other]) fs.writeFileSync(file, "z".repeat(10));
    const old = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(oldPart, old, old);
    fs.utimesSync(other, old, old);
    const result = await kit.messaging.sweepMedia({ now: Date.now() });
    assert.deepEqual([result.removed, result.freedBytes], [1, 10]);
    assert.equal(fs.existsSync(oldPart), false);
    assert.equal(fs.existsSync(youngPart), true);
    assert.equal(fs.existsSync(other), true);
  });

  test("it takes no engine lock (Y13) and an empty or missing staging area is zero", async () => {
    const held = mutex.withLock("api-outbox", () => new Promise((resolve) => setTimeout(resolve, 150)));
    const result = await Promise.race([kit.messaging.sweepMedia({ now: Date.now() }), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))]);
    assert.deepEqual(result, { removed: 0, freedBytes: 0 });
    await held;
  });

  test("start() sweeps once, before the loop begins", async () => {
    const orphan = `msg_${"W".repeat(22)}`;
    await staged(orphan, 2 * HOUR);
    await kit.start();
    assert.equal(fs.existsSync(stageDir(orphan)), false);
  });
});

test("the boot sweep of data/tmp also takes the upload leftovers of the API", async () => {
  const tmpApi = path.join(dir, "tmp", "api");
  fs.mkdirSync(tmpApi, { recursive: true });
  fs.writeFileSync(path.join(tmpApi, "left.part"), "x");
  await housekeeping.bootSweep();
  assert.deepEqual(fs.existsSync(path.join(tmpApi, "left.part")), false);
});

test("only a Date/number `now` is honoured by the steps (a run is deterministic on the injected clock)", async () => {
  const row = await message({ acceptedAt: ago(10 * DAY), expiresAt: ago(10 * DAY - 10 * MIN), sendingAt: ago(10 * DAY - SEC), sentAt: ago(10 * DAY - 2 * SEC) });
  await housekeeping.run({ now: new Date(NOW + 25 * DAY) });
  assert.equal(await fresh(row), null);
});
