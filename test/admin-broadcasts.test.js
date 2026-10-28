"use strict";
/**
 * BC-1 to BC-10 (admin-http-api.md 2.11, specs/002-admin-panel T160), through the real admin on the test harness
 * with a real engine on a fake clock, a fake socket and temporary directories.
 *
 *  - BC-2 preview writes nothing; BC-3 `confirmTargets` must equal the resolved count, `unknown_target` with the
 *    indices, `too_many_items`, `in_past`, upload sniffing and the caption cap, `uploadId` + `reuseMediaOf` mutually
 *    exclusive, recurrence validation;
 *  - the shapes of BC-1 / BC-4 / BC-10 (`state` derived, `mediaAvailable`, `mayHaveBeenDelivered`, `selectable`);
 *  - BC-5 `not_editable` for `once`, BC-6 / BC-7 recurring only, BC-8 cancel (`409 not_pending`), BC-9 `409 busy`
 *    while running;
 *  - there is NO retry route (a request to any `.../retry` path is a 404); the "new broadcast to the failed
 *    destinations" flow is BC-10 then BC-3 with `reuseMediaOf`;
 *  - progress on the hub `job` topic; the audit actions.
 */

const { test, describe, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DateTime } = require("luxon");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createTestAdmin } = require("./helpers/adminHarness");
const { createClock } = require("./helpers/fakeClock");
const { createBroadcaster } = require("../lib/utils/broadcaster");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]);

let t;
let client;
let engine;
let bot;
let sock;
let clock;
let tmp;
let db;
let config;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-bc-"));
  clock = createClock(T0);
  config = { TIMEZONE: "Europe/Paris", MAX_UPLOAD: 230, BROADCAST_DELAY_MS: 5000 };
  sock = fakes.fakeSocket();
  bot = fakes.fakeClient(sock);
  engine = createBroadcaster({
    rootDir: tmp,
    config,
    clock: () => clock.now(),
    random: () => 0,
    timers: clock.timers,
    settingsStore: { onChange: () => () => {} },
  });
  engine.start(bot);
  t = await createTestAdmin({ clock, config: { BROADCAST_DELAY_MS: 5000, TIMEZONE: "Europe/Paris" }, deps: { broadcaster: engine, client: bot } });
  db = t.db;
  client = await t.loginClient();
});

after(async () => {
  engine.stop();
  await t.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const name of ["BroadcastTarget", "BroadcastRun", "Broadcast", "KnownChat", "BannedChat"]) await db[name].destroy({ where: {} });
  await db.AuditLog.destroy({ where: {} });
  sock.sent.length = 0;
  bot.ready = () => true;
  bot.getSocket = () => sock;
  delete sock.sendMessage.__fail;
  clock.set(clock.now() + 60000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function chats(count, { start = 1000, kind = "private", prefix = "" } = {}) {
  const jids = [];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const id = start + i;
    const jid = kind === "group" ? `${id}@g.us` : `${id}@s.whatsapp.net`;
    jids.push(jid);
    rows.push({ jid, kind, pnJid: kind === "private" ? jid : null, name: `${prefix}chat ${id}`, firstSeenAt: new Date(clock.now()), lastSeenAt: new Date(clock.now()) });
  }
  await db.KnownChat.bulkCreate(rows);
  return jids;
}

const create = (body, extra) => client.api("POST", "/admin/api/broadcasts", body, extra);
const preview = (body) => client.api("POST", "/admin/api/broadcasts/preview", body);
const get = (id) => client.get(`/admin/api/broadcasts/${id}`);
const once = (jids, over = {}) => ({ kind: "once", text: "hello", targets: jids, confirmTargets: jids.length, spacingMs: 2000, ...over });
const daily = (jids, over = {}) => ({ kind: "recurring", text: "good morning", targets: jids, confirmTargets: jids.length, recurrence: { kind: "daily", time: "08:00" }, ...over });

async function uploadMedia(buffer = PNG, name = "photo.png") {
  const res = await client.raw({
    method: "PUT",
    path: `/admin/api/uploads?purpose=broadcast&name=${encodeURIComponent(name)}`,
    headers: { Origin: t.base, "Content-Type": "application/octet-stream", "X-CSRF-Token": client.csrf },
    body: buffer,
  });
  return res;
}

const fieldsOf = (answer) => answer.json && answer.json.error && answer.json.error.fields;
const tick = (at = clock.now()) => engine.tick(at);
const audits = async (action) => (await db.AuditLog.findAll({ where: { action }, order: [["id", "ASC"]], raw: true }));

async function advance(ms) {
  clock.set(clock.now() + ms);
}

// ---------------------------------------------------------------------------
// BC-2
// ---------------------------------------------------------------------------

describe("BC-2 preview", () => {
  test("returns the numbers of the confirmation and writes nothing", async () => {
    const jids = await chats(5);
    const before = await t.dumpTables();
    const answer = await preview({ kind: "once", text: "hello world", targets: jids, spacingMs: 4000 });
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json, {
      targetCount: 5,
      estimatedDurationMs: Math.round(4 * 4000 * 1.1),
      nextOccurrences: null,
      mediaKind: null,
      textLength: 11,
      spacingMs: 4000,
      warnings: [],
    });
    const after = await t.dumpTables();
    for (const name of ["Broadcast", "BroadcastRun", "BroadcastTarget"]) assert.deepEqual(after[name], before[name], name);
    assert.deepEqual(after.AuditLog, before.AuditLog);
  });

  test("the spacing defaults to the BROADCAST_DELAY_MS setting; the estimate never counts under 2 s", async () => {
    const jids = await chats(3);
    const answer = await preview({ kind: "once", text: "x", targets: jids });
    assert.equal(answer.json.spacingMs, 5000);
    assert.equal(answer.json.estimatedDurationMs, Math.round(2 * 5000 * 1.1));
    assert.equal((await preview({ kind: "once", text: "x", targets: [jids[0]] })).json.estimatedDurationMs, 0);
  });

  test("a recurring rule gets its next 5 occurrences in the bot's time zone", async () => {
    const jids = await chats(2);
    const answer = await preview({ kind: "recurring", text: "x", targets: jids, recurrence: { kind: "weekly", days: [1, 3], time: "07:30" } });
    assert.equal(answer.status, 200, answer.text);
    const list = answer.json.nextOccurrences;
    assert.equal(list.length, 5);
    for (let i = 1; i < list.length; i += 1) assert.ok(Date.parse(list[i]) > Date.parse(list[i - 1]));
    for (const instant of list) {
      const local = DateTime.fromISO(instant, { zone: "Europe/Paris" });
      assert.equal(local.toFormat("HH:mm"), "07:30");
      assert.ok([1, 3].includes(local.weekday));
    }
    assert.ok(Date.parse(list[0]) > clock.now());
  });

  test("monthly le 31 in the next occurrences lands on the last day of shorter months", async () => {
    const jids = await chats(1);
    clock.set(DateTime.fromObject({ year: 2026, month: 2, day: 1, hour: 6 }, { zone: "Europe/Paris" }).toMillis());
    const answer = await preview({ kind: "recurring", text: "x", targets: jids, recurrence: { kind: "monthly", day: 31, time: "08:00" } });
    const days = answer.json.nextOccurrences.map((i) => DateTime.fromISO(i, { zone: "Europe/Paris" }).toISODate());
    assert.deepEqual(days, ["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  test("bot_disconnected warns that the run would wait", async () => {
    const jids = await chats(1);
    bot.ready = () => false;
    assert.deepEqual((await preview({ kind: "once", text: "x", targets: jids })).json.warnings, ["bot_disconnected"]);
  });

  test("an upload gives its media kind and the caption cap applies", async () => {
    const jids = await chats(1);
    const up = await uploadMedia();
    assert.equal(up.status, 201, up.text);
    const ok = await preview({ kind: "once", text: "caption", targets: jids, uploadId: up.json.uploadId });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.mediaKind, "image");
    const long = await preview({ kind: "once", text: "x".repeat(1025), targets: jids, uploadId: up.json.uploadId });
    assert.equal(long.status, 422);
    assert.deepEqual(fieldsOf(long).text, { code: "too_long", params: { max: 1024 } });
    assert.equal((await db.Broadcast.count()), 0);
    // the upload is still there for the real call
    assert.equal((await create(once(jids, { uploadId: up.json.uploadId }))).status, 201);
  });

  test("BC-2 takes no confirmTargets", async () => {
    const jids = await chats(1);
    const answer = await preview({ kind: "once", text: "x", targets: jids, confirmTargets: 1 });
    assert.equal(answer.status, 422);
    assert.deepEqual(fieldsOf(answer).$unknown, { code: "unknown_field" });
  });
});

// ---------------------------------------------------------------------------
// BC-3
// ---------------------------------------------------------------------------

describe("BC-3 create", () => {
  test("201 { broadcast, run }: the shapes, state scheduled, no media", async () => {
    const jids = await chats(3);
    const answer = await create(once(jids, { title: "Promo" }));
    assert.equal(answer.status, 201, answer.text);
    const { broadcast, run } = answer.json;
    assert.deepEqual(Object.keys(broadcast).sort(), [
      "createdAt", "id", "kind", "lastRunAt", "latestRun", "mediaAvailable", "mediaKind", "mediaName", "mediaSize", "nextRunAt", "paused",
      "recurrence", "runAt", "spacingMs", "state", "targetCount", "text", "title",
    ].sort());
    assert.equal(broadcast.kind, "once");
    assert.equal(broadcast.title, "Promo");
    assert.equal(broadcast.text, "hello");
    assert.equal(broadcast.targetCount, 3);
    assert.equal(broadcast.spacingMs, 2000);
    assert.equal(broadcast.mediaAvailable, null);
    assert.equal(broadcast.mediaKind, null);
    assert.equal(broadcast.state, "scheduled");
    assert.equal(broadcast.paused, null);
    assert.equal(broadcast.runAt, null);
    assert.equal(broadcast.recurrence, null);
    assert.equal(broadcast.nextRunAt, null);
    assert.ok(!Number.isNaN(Date.parse(broadcast.createdAt)));
    assert.deepEqual(Object.keys(run).sort(), ["dueAt", "failed", "finishedAt", "id", "note", "pending", "sent", "startedAt", "status", "total", "cancelled"].sort());
    assert.deepEqual({ status: run.status, total: run.total, sent: run.sent, pending: run.pending, note: run.note }, { status: "scheduled", total: 3, sent: 0, pending: 3, note: null });
    assert.deepEqual(broadcast.latestRun, run);
    assert.equal(Date.parse(run.dueAt), clock.now());
  });

  test("confirmTargets must equal the resolved count: 409 confirmation_required with the count, nothing created", async () => {
    const jids = await chats(4);
    for (const confirmTargets of [3, 5, 0]) {
      const answer = await create(once(jids, { confirmTargets }));
      assert.equal(answer.status, 409, answer.text);
      assert.deepEqual(answer.json.error.params, { confirm: "targets", targetCount: 4 });
      assert.equal(answer.json.error.code, "confirmation_required");
    }
    const missing = await create({ kind: "once", text: "x", targets: jids });
    assert.equal(missing.status, 409);
    assert.equal(missing.json.error.params.targetCount, 4);
    assert.equal(await db.Broadcast.count(), 0);
  });

  test("the count is the resolved one: duplicates by phone number collapse, so 3 typed entries confirm as 2", async () => {
    await db.KnownChat.bulkCreate([
      { jid: "111@s.whatsapp.net", kind: "private", pnJid: "111@s.whatsapp.net", firstSeenAt: new Date(), lastSeenAt: new Date() },
      { jid: "9991@lid", kind: "private", pnJid: "111@s.whatsapp.net", firstSeenAt: new Date(), lastSeenAt: new Date() },
      { jid: "222@s.whatsapp.net", kind: "private", pnJid: "222@s.whatsapp.net", firstSeenAt: new Date(), lastSeenAt: new Date() },
    ]);
    const targets = ["111@s.whatsapp.net", "9991@lid", "222@s.whatsapp.net"];
    const refused = await create(once(targets, { confirmTargets: 3 }));
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.params.targetCount, 2);
    const ok = await create(once(targets, { confirmTargets: 2 }));
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.broadcast.targetCount, 2);
  });

  test("unknown_target with the indices (no values): a number typed by hand, a left group, a disabled chat", async () => {
    const [known] = await chats(1);
    const [left] = await chats(1, { start: 2000, kind: "group" });
    await db.KnownChat.update({ leftAt: new Date() }, { where: { jid: left } });
    const [banned] = await chats(1, { start: 3000 });
    await db.BannedChat.create({ jid: banned });
    const typed = "237650000000@s.whatsapp.net";
    const answer = await create(once([known, typed, left, banned], { confirmTargets: 4 }));
    assert.equal(answer.status, 422, answer.text);
    assert.deepEqual(fieldsOf(answer).targets, { code: "unknown_target", params: { indices: [1, 2, 3] } });
    assert.ok(!answer.text.includes(typed), "the submitted value is never echoed");
    assert.equal(await db.Broadcast.count(), 0);
  });

  test("too_many_items over 200 targets; exactly 200 is accepted", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `${9000 + i}@s.whatsapp.net`);
    const refused = await create(once(many, { confirmTargets: 201 }));
    assert.equal(refused.status, 422);
    assert.deepEqual(fieldsOf(refused).targets, { code: "too_many_items", params: { max: 200 } });
    const ok = await chats(200, { start: 5000 });
    const accepted = await create(once(ok));
    assert.equal(accepted.status, 201, accepted.text);
    assert.equal(accepted.json.run.total, 200);
    const empty = await create(once([], { confirmTargets: 0 }));
    assert.equal(empty.status, 422);
    assert.equal(fieldsOf(empty).targets.code, "too_short");
  });

  test("in_past: a run time earlier than now minus 60 s; a recent past or the future is fine", async () => {
    const jids = await chats(1);
    const past = await create(once(jids, { runAt: new Date(clock.now() - 120000).toISOString() }));
    assert.equal(past.status, 422);
    assert.deepEqual(fieldsOf(past).runAt, { code: "in_past" });
    const recent = await create(once(jids, { runAt: new Date(clock.now() - 30000).toISOString() }));
    assert.equal(recent.status, 201, recent.text);
    const future = await create(once(jids, { runAt: new Date(clock.now() + HOUR).toISOString() }));
    assert.equal(future.status, 201);
    assert.equal(future.json.broadcast.runAt, new Date(clock.now() + HOUR).toISOString());
    assert.equal(future.json.run.dueAt, new Date(clock.now() + HOUR).toISOString());
    const garbage = await create(once(jids, { runAt: "tomorrow-ish" }));
    assert.deepEqual(fieldsOf(garbage).runAt, { code: "invalid_format" });
  });

  test("kind rules: once refuses recurrence; recurring needs it and refuses runAt", async () => {
    const jids = await chats(1);
    assert.deepEqual(fieldsOf(await create(once(jids, { recurrence: { kind: "daily", time: "08:00" } }))).recurrence, { code: "not_allowed" });
    const noRule = await create({ kind: "recurring", text: "x", targets: jids, confirmTargets: 1 });
    assert.deepEqual(fieldsOf(noRule).recurrence, { code: "required" });
    const withRunAt = await create(daily(jids, { runAt: new Date(clock.now() + HOUR).toISOString() }));
    assert.deepEqual(fieldsOf(withRunAt).runAt, { code: "not_allowed" });
    assert.equal(fieldsOf(await create({ text: "x", targets: jids, confirmTargets: 1 })).kind.code, "required");
    assert.equal(fieldsOf(await create(once(jids, { kind: "weekly" }))).kind.code, "not_allowed");
  });

  test("recurrence validation: each bad part names its own field", async () => {
    const jids = await chats(1);
    const rule = async (recurrence) => fieldsOf(await create(daily(jids, { recurrence })));
    assert.deepEqual((await rule({ kind: "yearly", time: "08:00" }))["recurrence.kind"].code, "not_allowed");
    assert.equal((await rule({ kind: "weekly", days: [], time: "08:00" }))["recurrence.days"].code, "invalid_format");
    assert.equal((await rule({ kind: "weekly", days: [8], time: "08:00" }))["recurrence.days"].code, "invalid_format");
    assert.deepEqual((await rule({ kind: "monthly", day: 32, time: "08:00" }))["recurrence.day"], { code: "out_of_range", params: { min: 1, max: 31 } });
    assert.equal((await rule({ kind: "daily", time: "24:00" }))["recurrence.time"].code, "invalid_format");
    assert.equal((await rule({ kind: "daily", time: "8:00" }))["recurrence.time"].code, "invalid_format");
    assert.equal((await rule({ kind: "daily", time: "08:00", extra: 1 })).recurrence.code, "unknown_field");
    assert.equal((await rule("daily")).recurrence.code, "invalid_type");
    assert.equal(await db.Broadcast.count(), 0);
  });

  test("text rules: required, 4096 without media, 1024 as a caption", async () => {
    const jids = await chats(1);
    assert.deepEqual(fieldsOf(await create(once(jids, { text: "" }))).text, { code: "required" });
    assert.deepEqual(fieldsOf(await create(once(jids, { text: "   " }))).text, { code: "required" });
    assert.deepEqual(fieldsOf(await create({ kind: "once", targets: jids, confirmTargets: 1 })).text, { code: "required" });
    assert.deepEqual(fieldsOf(await create(once(jids, { text: "x".repeat(4097) }))).text, { code: "too_long", params: { max: 4096 } });
    assert.equal((await create(once(jids, { text: "x".repeat(4096) }))).status, 201);
    const up = await uploadMedia();
    assert.deepEqual(fieldsOf(await create(once(jids, { text: "x".repeat(1025), uploadId: up.json.uploadId }))).text, { code: "too_long", params: { max: 1024 } });
    assert.equal((await create(once(jids, { text: "x".repeat(1024), uploadId: up.json.uploadId }))).status, 201);
  });

  test("other limits: title 100, spacing 2000 to 600000, unknown properties", async () => {
    const jids = await chats(1);
    assert.equal(fieldsOf(await create(once(jids, { title: "t".repeat(101) }))).title.code, "too_long");
    assert.equal(fieldsOf(await create(once(jids, { spacingMs: 1999 }))).spacingMs.code, "out_of_range");
    assert.equal(fieldsOf(await create(once(jids, { spacingMs: 600001 }))).spacingMs.code, "out_of_range");
    assert.equal(fieldsOf(await create(once(jids, { spacingMs: "fast" }))).spacingMs.code, "invalid_type");
    assert.equal((await create(once(jids, { spacingMs: 600000 }))).status, 201);
    assert.deepEqual(fieldsOf(await create(once(jids, { phone: "237650000000" }))).$unknown, { code: "unknown_field" });
  });

  test("with no spacing the default is the BROADCAST_DELAY_MS setting", async () => {
    const jids = await chats(1);
    const body = once(jids);
    delete body.spacingMs;
    assert.equal((await create(body)).json.broadcast.spacingMs, 5000);
  });

  test("uploadId: the media is moved into the broadcast's own directory; mediaAvailable true; the upload is consumed", async () => {
    const jids = await chats(2);
    const up = await uploadMedia();
    assert.equal(up.status, 201, up.text);
    assert.equal(up.json.kind, "image");
    const answer = await create(once(jids, { text: "look", uploadId: up.json.uploadId }));
    assert.equal(answer.status, 201, answer.text);
    const { broadcast } = answer.json;
    assert.equal(broadcast.mediaKind, "image");
    assert.equal(broadcast.mediaName, "photo.png");
    assert.equal(broadcast.mediaSize, PNG.length);
    assert.equal(broadcast.mediaAvailable, true);
    assert.ok(fs.existsSync(path.join(tmp, "data", "broadcast-media", String(broadcast.id), "photo.png")));
    assert.ok(!answer.text.includes("mediaPath"), "the stored path never leaves the server");
    const again = await create(once(jids, { uploadId: up.json.uploadId }));
    assert.equal(again.status, 422);
    assert.deepEqual(fieldsOf(again).uploadId, { code: "invalid_format" });
  });

  test("uploadId must be an upload of this session with purpose broadcast: unknown, wrong format, a backup", async () => {
    const jids = await chats(1);
    assert.deepEqual(fieldsOf(await create(once(jids, { uploadId: "0".repeat(32) }))).uploadId, { code: "invalid_format" });
    assert.deepEqual(fieldsOf(await create(once(jids, { uploadId: "nope" }))).uploadId, { code: "invalid_format" });
    // an executable is refused at the upload itself (UP-1 sniffing)
    const elf = await uploadMedia(ELF, "tool.png");
    assert.equal(elf.status, 422);
    assert.equal(elf.json.error.code, "unsupported_file_type");
    // another session cannot use it
    const up = await uploadMedia();
    const other = client.fork();
    assert.equal((await other.login("a long enough password")).status, 200);
    const foreign = await other.api("POST", "/admin/api/broadcasts", once(jids, { uploadId: up.json.uploadId }));
    assert.equal(foreign.status, 422);
    assert.deepEqual(fieldsOf(foreign).uploadId, { code: "invalid_format" });
    assert.equal((await create(once(jids, { uploadId: up.json.uploadId }))).status, 201, "still usable by its own session");
  });

  test("uploadId and reuseMediaOf are mutually exclusive; reuseMediaOf needs a source with media", async () => {
    const jids = await chats(2);
    const up = await uploadMedia();
    const source = await create(once([jids[0]], { uploadId: up.json.uploadId }));
    const up2 = await uploadMedia();
    const both = await create(once([jids[1]], { uploadId: up2.json.uploadId, reuseMediaOf: source.json.broadcast.id }));
    assert.equal(both.status, 422);
    assert.deepEqual(fieldsOf(both).reuseMediaOf, { code: "not_allowed" });
    const plain = await create(once([jids[1]]));
    const noMedia = await create(once([jids[1]], { reuseMediaOf: plain.json.broadcast.id }));
    assert.deepEqual(fieldsOf(noMedia).reuseMediaOf, { code: "not_applicable" });
    const unknown = await create(once([jids[1]], { reuseMediaOf: 999999 }));
    assert.deepEqual(fieldsOf(unknown).reuseMediaOf, { code: "not_applicable" });
    const ok = await create(once([jids[1]], { reuseMediaOf: source.json.broadcast.id, text: "again" }));
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.broadcast.mediaAvailable, true);
    assert.notEqual(ok.json.broadcast.id, source.json.broadcast.id);
  });

  test("a recurring broadcast has no run until its first occurrence; the rule and nextRunAt are echoed", async () => {
    const jids = await chats(2);
    const answer = await create(daily(jids, { recurrence: { kind: "weekly", days: [5, 1], time: "07:30" } }));
    assert.equal(answer.status, 201, answer.text);
    const { broadcast, run } = answer.json;
    assert.equal(run, null);
    assert.equal(broadcast.kind, "recurring");
    assert.deepEqual(broadcast.recurrence, { kind: "weekly", days: [1, 5], time: "07:30" });
    assert.equal(broadcast.state, "scheduled");
    assert.equal(broadcast.latestRun, null);
    const next = DateTime.fromISO(broadcast.nextRunAt, { zone: "Europe/Paris" });
    assert.equal(next.toFormat("HH:mm"), "07:30");
    assert.ok([1, 5].includes(next.weekday));
    assert.ok(Date.parse(broadcast.nextRunAt) > clock.now());
  });

  test("audit broadcast.create: the id and counts, never the text or a destination", async () => {
    const jids = await chats(2);
    const answer = await create(once(jids, { text: "a secret promo text" }));
    const [row] = await audits("broadcast.create");
    assert.equal(row.target, String(answer.json.broadcast.id));
    assert.equal(row.result, "ok");
    const detail = JSON.parse(row.detail);
    assert.deepEqual(detail, { kind: "once", targets: 2, media: null });
    assert.ok(!row.detail.includes("secret promo"));
    assert.ok(!row.detail.includes("@s.whatsapp.net"));
    // a refused request writes no row
    await create(once(jids, { confirmTargets: 9 }));
    assert.equal((await audits("broadcast.create")).length, 1);
  });
});

// ---------------------------------------------------------------------------
// BC-1 and BC-4
// ---------------------------------------------------------------------------

describe("BC-1 list and BC-4 detail", () => {
  test("BC-1: newest first, pagination, kind filter", async () => {
    const jids = await chats(1);
    for (let i = 0; i < 3; i += 1) await create(once(jids, { text: `one ${i}` }));
    await create(daily(jids));
    const all = await client.get("/admin/api/broadcasts");
    assert.equal(all.status, 200, all.text);
    assert.deepEqual({ page: all.json.page, pageSize: all.json.pageSize, total: all.json.total }, { page: 1, pageSize: 20, total: 4 });
    assert.deepEqual(all.json.items.map((i) => i.kind), ["recurring", "once", "once", "once"]);
    assert.equal(all.json.items[1].text, "one 2");
    const paged = await client.get("/admin/api/broadcasts?pageSize=2&page=2");
    assert.deepEqual({ page: paged.json.page, total: paged.json.total, n: paged.json.items.length }, { page: 2, total: 4, n: 2 });
    assert.equal((await client.get("/admin/api/broadcasts?kind=once")).json.total, 3);
    assert.equal((await client.get("/admin/api/broadcasts?kind=recurring")).json.total, 1);
    assert.equal((await client.get("/admin/api/broadcasts?kind=weekly")).status, 422);
    assert.equal((await client.get("/admin/api/broadcasts?state=nope")).status, 422);
  });

  test("BC-1: the state is derived from the latest run, paused by the owner or by a disconnection", async () => {
    const [a, b, c, d, e, f] = await chats(6);
    const sched = (await create(once([a], { runAt: new Date(clock.now() + 2 * HOUR).toISOString() }))).json.broadcast.id;
    const done = (await create(once([d], { text: "done" }))).json.broadcast.id;
    await tick();
    await advance(5000);
    const running = (await create(once([b, c], { text: "run" }))).json.broadcast.id;
    await tick(); // one of its two messages goes out
    const cancelled = (await create(once([e], { runAt: new Date(clock.now() + HOUR).toISOString() }))).json;
    await client.api("POST", `/admin/api/broadcasts/${cancelled.broadcast.id}/cancel`, {});
    const paused = (await create(daily([f]))).json.broadcast.id;
    await client.api("POST", `/admin/api/broadcasts/${paused}/pause`, {});

    const states = Object.fromEntries((await client.get("/admin/api/broadcasts")).json.items.map((i) => [i.id, [i.state, i.paused]]));
    assert.deepEqual(states[sched], ["scheduled", null]);
    assert.deepEqual(states[running], ["running", null]);
    assert.deepEqual(states[done], ["completed", null]);
    assert.deepEqual(states[cancelled.broadcast.id], ["cancelled", null]);
    assert.deepEqual(states[paused], ["paused", { by: "admin" }]);

    // the filter uses the derived state
    const onlyPaused = await client.get("/admin/api/broadcasts?state=paused");
    assert.deepEqual(onlyPaused.json.items.map((i) => i.id), [paused]);
    assert.deepEqual((await client.get("/admin/api/broadcasts?state=completed")).json.items.map((i) => i.id), [done]);

    // disconnected while a run is open: "en pause", a started run is not expired
    bot.ready = () => false;
    const down = Object.fromEntries((await client.get("/admin/api/broadcasts")).json.items.map((i) => [i.id, [i.state, i.paused]]));
    assert.deepEqual(down[running], ["paused", { by: "disconnected" }]);
    assert.deepEqual(down[sched], ["scheduled", null], "not due yet: nothing is waiting");
    assert.deepEqual(down[done], ["completed", null]);
    assert.deepEqual(down[paused], ["paused", { by: "admin" }]);
    bot.ready = () => true;
  });

  test("BC-1: expired and failed runs", async () => {
    const [a, b] = await chats(2);
    const expired = (await create(once([a]))).json.broadcast.id;
    bot.ready = () => false; // the bot is down at the time: nothing is sent
    await advance(2 * HOUR);
    bot.ready = () => true;
    await tick();
    const failing = (await create(once([b]))).json.broadcast.id;
    const original = sock.sendMessage;
    sock.sendMessage = async () => {
      throw Object.assign(new Error("forbidden"), { output: { statusCode: 403 } });
    };
    await tick();
    sock.sendMessage = original;
    const byId = Object.fromEntries((await client.get("/admin/api/broadcasts")).json.items.map((i) => [i.id, i.state]));
    assert.equal(byId[expired], "expired");
    assert.equal(byId[failing], "failed");
  });

  test("BC-4: the broadcast, its newest runs and the next occurrences", async () => {
    const [jid] = await chats(1);
    const created = (await create(daily([jid]))).json.broadcast;
    const one = await get(created.id);
    assert.equal(one.status, 200, one.text);
    assert.deepEqual(Object.keys(one.json).sort(), ["broadcast", "nextOccurrences", "runs"]);
    assert.equal(one.json.broadcast.id, created.id);
    assert.deepEqual(one.json.runs, []);
    assert.equal(one.json.nextOccurrences.length, 5);

    // 25 daily occurrences are due: the newest 20 runs are listed
    clock.set(Date.parse(created.nextRunAt));
    await tick();
    for (let day = 1; day <= 24; day += 1) {
      await advance(DAY);
      await tick();
    }
    const detail = await get(created.id);
    assert.equal(detail.json.runs.length, 20);
    assert.ok(detail.json.runs[0].id > detail.json.runs[19].id, "newest first");
    assert.equal(detail.json.broadcast.latestRun.id, detail.json.runs[0].id);

    const onceId = (await create(once([jid]))).json.broadcast.id;
    assert.equal((await get(onceId)).json.nextOccurrences, null);
    const missing = await get(424242);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json.error, { code: "not_found", params: { resource: "broadcast" }, requestId: missing.json.error.requestId });
  });

  test("BC-4 and BC-10 are touch:false routes; the others touch the session", async () => {
    const touch = Object.fromEntries(t.admin.routes().filter((r) => r.path.startsWith("/admin/api/broadcasts")).map((r) => [`${r.method} ${r.path}`, r.touch]));
    assert.equal(touch["GET /admin/api/broadcasts/:id"], false);
    assert.equal(touch["GET /admin/api/broadcasts/:id/runs/:runId"], false);
    assert.equal(touch["GET /admin/api/broadcasts"], true);
    assert.equal(touch["POST /admin/api/broadcasts"], true);
    assert.equal(Object.keys(touch).length, 11, "the ten routes of 2.11 plus the 405 guard of /preview");
  });
});

// ---------------------------------------------------------------------------
// BC-5, BC-6, BC-7
// ---------------------------------------------------------------------------

describe("BC-5 to BC-7 recurring messages", () => {
  test("BC-5, BC-6 and BC-7 answer 409 not_editable for a one-shot broadcast", async () => {
    const [jid] = await chats(1);
    const id = (await create(once([jid]))).json.broadcast.id;
    for (const answer of [
      await client.api("PATCH", `/admin/api/broadcasts/${id}`, { text: "new" }),
      await client.api("POST", `/admin/api/broadcasts/${id}/pause`, {}),
      await client.api("POST", `/admin/api/broadcasts/${id}/resume`, {}),
    ]) {
      assert.equal(answer.status, 409, answer.text);
      assert.equal(answer.json.error.code, "not_editable");
    }
    assert.equal(await db.Broadcast.count({ where: { status: "paused" } }), 0);
    assert.equal((await client.api("PATCH", "/admin/api/broadcasts/424242", { text: "x" })).status, 404);
    assert.equal((await client.api("POST", "/admin/api/broadcasts/424242/pause", {})).status, 404);
  });

  test("BC-5: edits the given fields; targets need confirmTargets; the rule recomputes nextRunAt; audit", async () => {
    const [a, b] = await chats(2);
    const created = (await create(daily([a]))).json.broadcast;
    const patch = (body) => client.api("PATCH", `/admin/api/broadcasts/${created.id}`, body);

    const text = await patch({ text: "new text", title: "Morning", spacingMs: 8000 });
    assert.equal(text.status, 200, text.text);
    assert.deepEqual(Object.keys(text.json), ["broadcast"]);
    assert.equal(text.json.broadcast.text, "new text");
    assert.equal(text.json.broadcast.title, "Morning");
    assert.equal(text.json.broadcast.spacingMs, 8000);
    assert.equal(text.json.broadcast.targetCount, 1, "the other fields are untouched");

    const noConfirm = await patch({ targets: [a, b] });
    assert.equal(noConfirm.status, 409);
    assert.deepEqual(noConfirm.json.error.params, { confirm: "targets", targetCount: 2 });
    const bad = await patch({ targets: [a, "999@s.whatsapp.net"], confirmTargets: 2 });
    assert.deepEqual(fieldsOf(bad).targets, { code: "unknown_target", params: { indices: [1] } });
    const targets = await patch({ targets: [a, b], confirmTargets: 2 });
    assert.equal(targets.json.broadcast.targetCount, 2);

    const rule = await patch({ recurrence: { kind: "weekly", days: [3], time: "18:15" } });
    assert.deepEqual(rule.json.broadcast.recurrence, { kind: "weekly", days: [3], time: "18:15" });
    const local = DateTime.fromISO(rule.json.broadcast.nextRunAt, { zone: "Europe/Paris" });
    assert.deepEqual([local.weekday, local.toFormat("HH:mm")], [3, "18:15"]);

    assert.deepEqual(fieldsOf(await patch({ recurrence: { kind: "daily", time: "99:99" } }))["recurrence.time"], { code: "invalid_format" });
    assert.deepEqual(fieldsOf(await patch({ runAt: new Date().toISOString() })).runAt, { code: "not_allowed" });
    assert.equal((await patch({ kind: "once" })).status, 409);
    assert.deepEqual(fieldsOf(await patch({ text: "" })).text, { code: "required" });
    assert.deepEqual(fieldsOf(await patch({ bogus: 1 })).$unknown, { code: "unknown_field" });
    assert.equal((await patch({})).status, 200, "an empty patch changes nothing");

    const rows = await audits("broadcast.update");
    assert.ok(rows.length >= 4);
    assert.equal(rows[0].target, String(created.id));
    assert.deepEqual(JSON.parse(rows[0].detail), { fields: ["title", "text", "spacingMs"] });
  });

  test("BC-5 can replace the media with an upload; the caption cap holds", async () => {
    const [a] = await chats(1);
    const created = (await create(daily([a]))).json.broadcast;
    assert.equal(created.mediaAvailable, null);
    const up = await uploadMedia(PNG, "banner.png");
    const patched = await client.api("PATCH", `/admin/api/broadcasts/${created.id}`, { uploadId: up.json.uploadId });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.broadcast.mediaKind, "image");
    assert.equal(patched.json.broadcast.mediaName, "banner.png");
    assert.equal(patched.json.broadcast.mediaAvailable, true);
    const tooLong = await client.api("PATCH", `/admin/api/broadcasts/${created.id}`, { text: "x".repeat(1025) });
    assert.deepEqual(fieldsOf(tooLong).text, { code: "too_long", params: { max: 1024 } });
  });

  test("BC-6 pause stops the occurrences; BC-7 resume recomputes nextRunAt from now with no catch-up", async () => {
    const [a] = await chats(1);
    const created = (await create(daily([a]))).json.broadcast;
    const paused = await client.api("POST", `/admin/api/broadcasts/${created.id}/pause`, {});
    assert.equal(paused.status, 200, paused.text);
    assert.deepEqual([paused.json.broadcast.state, paused.json.broadcast.paused], ["paused", { by: "admin" }]);
    assert.deepEqual((await get(created.id)).json.nextOccurrences, [], "nothing will fire while paused");

    await advance(3 * DAY);
    await tick();
    assert.equal(await db.BroadcastRun.count({ where: { broadcastId: created.id } }), 0);

    const resumed = await client.api("POST", `/admin/api/broadcasts/${created.id}/resume`, {});
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(resumed.json.broadcast.state, "scheduled");
    assert.equal(resumed.json.broadcast.paused, null);
    assert.ok(Date.parse(resumed.json.broadcast.nextRunAt) > clock.now(), "no backlog: the next occurrence after now");
    await tick();
    assert.equal(await db.BroadcastRun.count({ where: { broadcastId: created.id } }), 0);

    assert.deepEqual((await audits("broadcast.pause")).map((r) => r.target), [String(created.id)]);
    assert.deepEqual((await audits("broadcast.resume")).map((r) => r.target), [String(created.id)]);
  });
});

// ---------------------------------------------------------------------------
// BC-8 and BC-9
// ---------------------------------------------------------------------------

describe("BC-8 cancel and BC-9 delete", () => {
  test("BC-8 cancels the open run: pending targets cancelled, the sent one stays sent; audit", async () => {
    const jids = await chats(3);
    const id = (await create(once(jids))).json.broadcast.id;
    await tick(); // one message goes out
    const answer = await client.api("POST", `/admin/api/broadcasts/${id}/cancel`, {});
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(Object.keys(answer.json), ["run"]);
    assert.deepEqual(
      { status: answer.json.run.status, sent: answer.json.run.sent, cancelled: answer.json.run.cancelled, pending: answer.json.run.pending },
      { status: "cancelled", sent: 1, cancelled: 2, pending: 0 },
    );
    await advance(10000);
    await tick();
    assert.equal(sock.sent.length, 1);
    assert.equal((await get(id)).json.broadcast.state, "cancelled");
    assert.deepEqual((await audits("broadcast.cancel")).map((r) => [r.target, JSON.parse(r.detail).runId]), [[String(id), answer.json.run.id]]);
  });

  test("BC-8: 409 not_pending when no run is open, and for a run that is already final", async () => {
    const [a] = await chats(1);
    const id = (await create(once([a]))).json.broadcast.id;
    await tick();
    const done = await client.api("POST", `/admin/api/broadcasts/${id}/cancel`, {});
    assert.equal(done.status, 409, done.text);
    assert.equal(done.json.error.code, "not_pending");
    const runId = (await get(id)).json.runs[0].id;
    const explicit = await client.api("POST", `/admin/api/broadcasts/${id}/cancel`, { runId });
    assert.equal(explicit.status, 409);
    assert.equal(explicit.json.error.code, "not_pending");
    const recurring = (await create(daily([a]))).json.broadcast.id;
    assert.equal((await client.api("POST", `/admin/api/broadcasts/${recurring}/cancel`, {})).status, 409, "no run yet");
    assert.equal((await client.api("POST", "/admin/api/broadcasts/424242/cancel", {})).status, 404);
    assert.equal((await audits("broadcast.cancel")).length, 0, "a refused cancel writes no row");
  });

  test("BC-8: an explicit runId must belong to the broadcast", async () => {
    const [a, b] = await chats(2);
    const first = (await create(once([a], { runAt: new Date(clock.now() + HOUR).toISOString() }))).json;
    const second = (await create(once([b], { runAt: new Date(clock.now() + HOUR).toISOString() }))).json;
    const foreign = await client.api("POST", `/admin/api/broadcasts/${first.broadcast.id}/cancel`, { runId: second.run.id });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.error.params.resource, "run");
    const own = await client.api("POST", `/admin/api/broadcasts/${first.broadcast.id}/cancel`, { runId: first.run.id });
    assert.equal(own.status, 200);
    assert.equal((await get(second.broadcast.id)).json.broadcast.state, "scheduled");
  });

  test("BC-8 on a recurring broadcast cancels only that occurrence", async () => {
    const [a] = await chats(1);
    const created = (await create(daily([a]))).json.broadcast;
    bot.ready = () => true;
    clock.set(Date.parse(created.nextRunAt));
    // keep the occurrence open: the send never answers until we say so
    let release;
    const original = sock.sendMessage;
    sock.sendMessage = () => new Promise((resolve) => (release = () => resolve({ key: { id: "X1" } })));
    const ticking = tick();
    await fakes.waitFor(() => release !== undefined);
    const answer = await client.api("POST", `/admin/api/broadcasts/${created.id}/cancel`, {});
    assert.equal(answer.status, 200, answer.text);
    release();
    await ticking;
    sock.sendMessage = original;
    const detail = await get(created.id);
    assert.equal(detail.json.broadcast.latestRun.status, "cancelled");
    assert.equal(detail.json.broadcast.state, "cancelled");
    assert.equal(detail.json.broadcast.latestRun.sent, 1, "the message in flight completed");
    assert.ok(detail.json.broadcast.nextRunAt, "the series goes on");
    assert.equal(await db.Broadcast.count({ where: { id: created.id, status: "active" } }), 1);
  });

  test("BC-9 needs ?confirm=true; it removes the definition, runs, targets and media", async () => {
    const [a] = await chats(1);
    const up = await uploadMedia();
    const id = (await create(once([a], { runAt: new Date(clock.now() + DAY).toISOString(), uploadId: up.json.uploadId }))).json.broadcast.id;
    const dir = path.join(tmp, "data", "broadcast-media", String(id));
    assert.ok(fs.existsSync(dir));

    const unconfirmed = await client.api("DELETE", `/admin/api/broadcasts/${id}`);
    assert.equal(unconfirmed.status, 409, unconfirmed.text);
    assert.deepEqual(unconfirmed.json.error.params, { confirm: "delete" });
    assert.equal((await client.api("DELETE", `/admin/api/broadcasts/${id}?confirm=false`)).status, 409);
    assert.equal(await db.Broadcast.count(), 1);

    const answer = await client.api("DELETE", `/admin/api/broadcasts/${id}?confirm=true`);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json, { deleted: true });
    assert.equal(await db.Broadcast.count(), 0);
    assert.equal(await db.BroadcastRun.count(), 0);
    assert.equal(await db.BroadcastTarget.count(), 0);
    assert.ok(!fs.existsSync(dir));
    assert.deepEqual((await audits("broadcast.delete")).map((r) => r.target), [String(id)]);
    assert.equal((await client.api("DELETE", `/admin/api/broadcasts/${id}?confirm=true`)).status, 404);
  });

  test("BC-9: 409 busy while a run is running (cancel first)", async () => {
    const jids = await chats(2);
    const id = (await create(once(jids))).json.broadcast.id;
    await tick();
    const busy = await client.api("DELETE", `/admin/api/broadcasts/${id}?confirm=true`);
    assert.equal(busy.status, 409, busy.text);
    assert.equal(busy.json.error.code, "busy");
    assert.equal(await db.Broadcast.count(), 1);
    assert.equal((await audits("broadcast.delete")).length, 0);
    await client.api("POST", `/admin/api/broadcasts/${id}/cancel`, {});
    assert.equal((await client.api("DELETE", `/admin/api/broadcasts/${id}?confirm=true`)).status, 200);
  });
});

// ---------------------------------------------------------------------------
// BC-10 and the no-retry rule
// ---------------------------------------------------------------------------

describe("BC-10 report", () => {
  async function failedRun() {
    const jids = await chats(4, { start: 100 });
    const original = sock.sendMessage;
    const errors = {
      [jids[1]]: Object.assign(new Error("forbidden"), { output: { statusCode: 403 } }),
      [jids[2]]: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    };
    sock.sendMessage = async (jid, content, options) => {
      if (errors[jid]) throw errors[jid];
      return original.call(sock, jid, content, options);
    };
    const created = (await create(once(jids, { text: "report me" }))).json;
    for (let i = 0; i < 5; i += 1) {
      await tick();
      await advance(3000);
    }
    sock.sendMessage = original;
    return { jids, created };
  }

  test("every destination with status, errorCode, mayHaveBeenDelivered, selectable, name and sentAt", async () => {
    const { jids, created } = await failedRun();
    const answer = await client.get(`/admin/api/broadcasts/${created.broadcast.id}/runs/${created.run.id}`);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(Object.keys(answer.json).sort(), ["run", "targets"]);
    assert.equal(answer.json.run.id, created.run.id);
    assert.equal(answer.json.run.status, "completed");
    assert.deepEqual(
      answer.json.targets.map((x) => [x.chatJid, x.name, x.position, x.status, x.errorCode, x.mayHaveBeenDelivered, x.selectable, Boolean(x.sentAt)]),
      [
        [jids[0], "chat 100", 1, "sent", null, false, true, true],
        [jids[1], "chat 101", 2, "failed", "forbidden", false, true, false],
        [jids[2], "chat 102", 3, "failed", "timeout", true, true, false],
        [jids[3], "chat 103", 4, "sent", null, false, true, true],
      ],
    );
    for (const target of answer.json.targets) {
      assert.deepEqual(Object.keys(target).sort(), ["chatJid", "errorCode", "mayHaveBeenDelivered", "name", "position", "selectable", "sentAt", "status"]);
    }
    assert.ok(!answer.text.includes("report me"), "no message content in the report");
  });

  test("selectable follows the CHAT-1 rules: a group the bot left and a disabled chat are not", async () => {
    const group = (await chats(1, { start: 700, kind: "group" }))[0];
    const priv = (await chats(2, { start: 800 }));
    const created = (await create(once([group, ...priv], { spacingMs: 2000 }))).json;
    for (let i = 0; i < 3; i += 1) {
      await tick();
      await advance(3000);
    }
    await db.KnownChat.update({ leftAt: new Date() }, { where: { jid: group } });
    await db.BannedChat.create({ jid: priv[1] });
    const answer = await client.get(`/admin/api/broadcasts/${created.broadcast.id}/runs/${created.run.id}`);
    assert.deepEqual(answer.json.targets.map((x) => [x.chatJid, x.selectable]), [[group, false], [priv[0], true], [priv[1], false]]);
  });

  test("404 for an unknown broadcast or run, and for a run of another broadcast", async () => {
    const [a, b] = await chats(2);
    const first = (await create(once([a], { runAt: new Date(clock.now() + HOUR).toISOString() }))).json;
    const second = (await create(once([b], { runAt: new Date(clock.now() + HOUR).toISOString() }))).json;
    const unknownRun = await client.get(`/admin/api/broadcasts/${first.broadcast.id}/runs/999999`);
    assert.equal(unknownRun.status, 404);
    assert.equal(unknownRun.json.error.params.resource, "run");
    assert.equal((await client.get(`/admin/api/broadcasts/${first.broadcast.id}/runs/${second.run.id}`)).status, 404);
    assert.equal((await client.get(`/admin/api/broadcasts/999999/runs/${first.run.id}`)).status, 404);
    assert.equal((await client.get(`/admin/api/broadcasts/${first.broadcast.id}/runs/abc`)).status, 404);
  });

  test("the interrupted target of a crash is flagged as possibly delivered", async () => {
    const [jid] = await chats(1);
    const created = (await create(once([jid]))).json;
    const original = db.BroadcastTarget.update;
    let armed = true;
    db.BroadcastTarget.update = function patched(values, options) {
      if (armed && values.status === "sent") {
        armed = false;
        return Promise.reject(new Error("process died"));
      }
      return original.call(this, values, options);
    };
    try {
      await tick();
    } finally {
      db.BroadcastTarget.update = original;
    }
    await advance(2 * 60000);
    await tick();
    const answer = await client.get(`/admin/api/broadcasts/${created.broadcast.id}/runs/${created.run.id}`);
    assert.deepEqual(
      answer.json.targets.map((x) => [x.status, x.errorCode, x.mayHaveBeenDelivered]),
      [["failed", "interrupted", true]],
    );
    assert.equal(sock.sent.length, 1);
  });
});

describe("no retry (U14)", () => {
  test("there is no retry route: any .../retry path is a 404 and the route table has none", async () => {
    const [a] = await chats(1);
    const created = (await create(once([a]))).json;
    const id = created.broadcast.id;
    const runId = created.run.id;
    const paths = [
      ["POST", `/admin/api/broadcasts/${id}/retry`],
      ["POST", `/admin/api/broadcasts/${id}/runs/${runId}/retry`],
      ["POST", `/admin/api/broadcasts/${id}/runs/${runId}/targets/1/retry`],
      ["POST", `/admin/api/broadcasts/${id}/retry-failed`],
      ["PATCH", `/admin/api/broadcasts/${id}/runs/${runId}`],
      ["POST", "/admin/api/broadcasts/retry"],
    ];
    for (const [method, route] of paths) {
      const answer = await client.api(method, route, {});
      assert.ok([404, 405].includes(answer.status), `${method} ${route} -> ${answer.status}`);
      if (answer.status === 404) assert.equal(answer.json.error.code, "not_found");
    }
    assert.equal((await client.api("POST", `/admin/api/broadcasts/${id}/runs/${runId}/retry`, {})).status, 404);
    assert.equal((await client.api("POST", `/admin/api/broadcasts/${id}/retry`, {})).status, 404);
    assert.ok(!t.admin.routes().some((r) => /retry|requeue|resend|reopen/i.test(r.path)));
  });

  test("the new broadcast to the failed destinations is BC-10 then BC-3 with reuseMediaOf", async () => {
    const jids = await chats(4, { start: 300 });
    const up = await uploadMedia(PNG, "flyer.png");
    const original = sock.sendMessage;
    const failing = new Set([jids[1], jids[2]]);
    sock.sendMessage = async (jid, content, options) => {
      if (failing.has(jid)) throw Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } });
      return original.call(sock, jid, content, options);
    };
    const first = (await create(once(jids, { text: "flyer", uploadId: up.json.uploadId }))).json;
    for (let i = 0; i < 5; i += 1) {
      await tick();
      await advance(3000);
    }
    sock.sendMessage = original;

    // the UI reads the report ...
    const report = (await client.get(`/admin/api/broadcasts/${first.broadcast.id}/runs/${first.run.id}`)).json;
    const failed = report.targets.filter((x) => x.status === "failed" && x.selectable).map((x) => x.chatJid);
    assert.deepEqual(failed, [jids[1], jids[2]]);
    assert.ok(report.targets.filter((x) => x.status === "failed").every((x) => x.mayHaveBeenDelivered));
    const source = (await get(first.broadcast.id)).json.broadcast;
    assert.equal(source.mediaAvailable, true);

    // ... and submits an ordinary create form
    sock.sent.length = 0;
    const second = await create({ kind: "once", text: source.text, spacingMs: source.spacingMs, targets: failed, confirmTargets: failed.length, reuseMediaOf: source.id });
    assert.equal(second.status, 201, second.text);
    assert.notEqual(second.json.broadcast.id, first.broadcast.id);
    assert.notEqual(second.json.run.id, first.run.id);
    assert.equal(second.json.broadcast.mediaAvailable, true);
    assert.equal(second.json.broadcast.mediaKind, "image");
    assert.deepEqual((await audits("broadcast.create")).map((r) => r.target), [String(first.broadcast.id), String(second.json.broadcast.id)]);
    for (let i = 0; i < 3; i += 1) {
      await tick();
      await advance(3000);
    }
    assert.deepEqual(sock.sent.map((s) => s.jid), failed);
    assert.deepEqual(sock.sent.map((s) => s.content.caption), ["flyer", "flyer"]);
    // the first run is untouched
    const again = (await client.get(`/admin/api/broadcasts/${first.broadcast.id}/runs/${first.run.id}`)).json;
    assert.deepEqual(again.targets.map((x) => x.status), ["sent", "failed", "failed", "sent"]);
  });

  test("a destination that stopped being valid since the report was opened is unknown_target", async () => {
    const group = (await chats(1, { start: 400, kind: "group" }))[0];
    const [priv] = await chats(1, { start: 500 });
    const original = sock.sendMessage;
    sock.sendMessage = async () => {
      throw Object.assign(new Error("forbidden"), { output: { statusCode: 403 } });
    };
    const first = (await create(once([group, priv]))).json;
    for (let i = 0; i < 3; i += 1) {
      await tick();
      await advance(3000);
    }
    sock.sendMessage = original;
    await db.KnownChat.update({ leftAt: new Date() }, { where: { jid: group } });
    const answer = await create(once([group, priv], { confirmTargets: 2 }));
    assert.equal(answer.status, 422);
    assert.deepEqual(fieldsOf(answer).targets, { code: "unknown_target", params: { indices: [0] } });
    void first;
  });

  test("reuseMediaOf after the 7-day retention: not_applicable, the owner re-uploads", async () => {
    const [a, b] = await chats(2);
    const up = await uploadMedia();
    const first = (await create(once([a], { uploadId: up.json.uploadId }))).json;
    await tick();
    await engine.sweepMedia({ now: clock.now() + 8 * DAY });
    const detail = (await get(first.broadcast.id)).json.broadcast;
    assert.equal(detail.mediaAvailable, false, "the history shows that the file is gone");
    assert.equal(detail.mediaKind, "image");
    const answer = await create(once([b], { reuseMediaOf: first.broadcast.id }));
    assert.deepEqual(fieldsOf(answer).reuseMediaOf, { code: "not_applicable" });
  });
});

// ---------------------------------------------------------------------------
// Progress, audit, access
// ---------------------------------------------------------------------------

describe("progress and audit", () => {
  test("progress is published on the hub job topic at every settled target", async () => {
    const jids = await chats(3);
    const events = [];
    const off = t.hub.subscribe("job", (payload) => events.push(payload));
    const created = (await create(once(jids))).json;
    for (let i = 0; i < 3; i += 1) {
      await tick();
      await advance(3000);
    }
    off();
    assert.ok(events.length >= 4, JSON.stringify(events));
    for (const event of events) {
      assert.equal(event.type, "broadcast");
      assert.equal(event.broadcastId, created.broadcast.id);
      assert.equal(event.runId, created.run.id);
      assert.deepEqual(Object.keys(event).sort(), ["broadcastId", "cancelled", "failed", "pending", "runId", "sent", "status", "total", "type", "updatedAt"]);
      assert.equal(event.total, 3);
      assert.ok(!Number.isNaN(Date.parse(event.updatedAt)));
    }
    const settled = events.filter((e) => e.status === "running" || e.status === "completed").map((e) => `${e.sent}/${e.total}`);
    assert.ok(settled.includes("1/3") && settled.includes("2/3") && settled.includes("3/3"), settled.join(","));
    assert.equal(events[events.length - 1].status, "completed");
    assert.ok(!JSON.stringify(events).includes("@s.whatsapp.net"), "no destination in the progress events");
  });

  test("the engine subscription follows the admin's start and stop and republishes without the engine type", () => {
    const { register } = require("../lib/admin/routes/broadcasts");
    const listeners = new Set();
    const fakeEngine = { subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
    const starts = [];
    const stops = [];
    const published = [];
    register({
      router: { route() {} },
      deps: { broadcaster: fakeEngine },
      hub: { publish: (...args) => published.push(args) },
      onStart: (fn) => starts.push(fn),
      onStop: (fn) => stops.push(fn),
    });
    assert.equal(listeners.size, 0, "nothing at registration");
    starts[0]();
    starts[0]();
    assert.equal(listeners.size, 1, "one subscription however many starts");
    const progress = { broadcastId: 1, runId: 2, status: "running", total: 3, sent: 1, failed: 0, cancelled: 0, pending: 2, updatedAt: "2026-06-01T10:00:00.000Z" };
    for (const listener of listeners) listener({ type: "target", ...progress });
    assert.deepEqual(published, [["job", { type: "broadcast", ...progress }]]);
    stops[0]();
    assert.equal(listeners.size, 0);
  });

  test("every action is audited with the broadcast id and no content", async () => {
    const [a] = await chats(1);
    const id = (await create(daily([a]))).json.broadcast.id;
    await client.api("PATCH", `/admin/api/broadcasts/${id}`, { text: "changed" });
    await client.api("POST", `/admin/api/broadcasts/${id}/pause`, {});
    await client.api("POST", `/admin/api/broadcasts/${id}/resume`, {});
    const one = (await create(once([a], { runAt: new Date(clock.now() + HOUR).toISOString() }))).json;
    await client.api("POST", `/admin/api/broadcasts/${one.broadcast.id}/cancel`, {});
    await client.api("DELETE", `/admin/api/broadcasts/${one.broadcast.id}?confirm=true`);
    const rows = (await db.AuditLog.findAll({ order: [["id", "ASC"]], raw: true })).filter((r) => r.action.startsWith("broadcast."));
    assert.deepEqual(rows.map((r) => r.action), [
      "broadcast.create", "broadcast.update", "broadcast.pause", "broadcast.resume", "broadcast.create", "broadcast.cancel", "broadcast.delete",
    ]);
    assert.ok(rows.every((r) => r.result === "ok" && r.origin));
    assert.ok(rows.every((r) => !String(r.detail || "").includes("changed") && !String(r.detail || "").includes("@s.whatsapp.net")));
  });

  test("every route needs a session", async () => {
    const stranger = t.client();
    for (const [method, route] of [
      ["GET", "/admin/api/broadcasts"],
      ["POST", "/admin/api/broadcasts/preview"],
      ["POST", "/admin/api/broadcasts"],
      ["GET", "/admin/api/broadcasts/1"],
      ["PATCH", "/admin/api/broadcasts/1"],
      ["POST", "/admin/api/broadcasts/1/pause"],
      ["POST", "/admin/api/broadcasts/1/resume"],
      ["POST", "/admin/api/broadcasts/1/cancel"],
      ["DELETE", "/admin/api/broadcasts/1?confirm=true"],
      ["GET", "/admin/api/broadcasts/1/runs/1"],
    ]) {
      const answer = await stranger.api(method, route, method === "GET" ? undefined : {});
      assert.equal(answer.status, 401, `${method} ${route}`);
    }
  });

  test("GET on the preview path is a 405 with Allow: POST (not the 404 of GET /:id)", async () => {
    const answer = await client.get("/admin/api/broadcasts/preview");
    assert.equal(answer.status, 405, answer.text);
    assert.equal(answer.json.error.code, "method_not_allowed");
    assert.match(answer.headers.get("allow"), /POST/);
    assert.equal((await client.get("/admin/api/broadcasts/previews")).status, 404);
  });

  test("the route table declares the ten routes of 2.11 and the 405 guard of /preview (and no other)", () => {
    const own = t.admin.routes().filter((r) => r.path.startsWith("/admin/api/broadcasts")).map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(own, [
      "DELETE /admin/api/broadcasts/:id",
      "GET /admin/api/broadcasts",
      "GET /admin/api/broadcasts/:id",
      "GET /admin/api/broadcasts/:id/runs/:runId",
      "GET /admin/api/broadcasts/preview",
      "PATCH /admin/api/broadcasts/:id",
      "POST /admin/api/broadcasts",
      "POST /admin/api/broadcasts/:id/cancel",
      "POST /admin/api/broadcasts/:id/pause",
      "POST /admin/api/broadcasts/:id/resume",
      "POST /admin/api/broadcasts/preview",
    ]);
  });
});
