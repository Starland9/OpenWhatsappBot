"use strict";
/**
 * The API page's message routes (feature 004, contracts/admin-api.md sections 1.2, 1.4 and 2).
 *
 * Part 1: API-9 `GET /admin/api/api/messages` (filters, pages, order, no content column), API-10
 * `GET /admin/api/api/messages/:id` (steps, answers of the interactive formats, 404) and API-12
 * `GET /admin/api/api/usage` (dense days in a non-UTC time zone, the sent and failed classes, entry selection).
 * Part 2: API-11 `POST /admin/api/api/test` and the uploads of purpose `api` (below).
 *
 * The real createAdmin, authentication and database; the engine is the recording stand-in of
 * test/helpers/apiPanelKit.js (`describeResponses` answers what the test scripts). Offline.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { bootApiPanel } = require("./helpers/apiPanelKit");
const { MessagingError } = require("../lib/messaging/errors");
const formats = require("../lib/messaging/formats");

const P = "/admin/api/api";
const A = "237690000001@s.whatsapp.net";
const B = "237690000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

let kit;
let tmp = null;
afterEach(async () => {
  if (kit) await kit.close();
  kit = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

const boot = async (options) => {
  kit = await bootApiPanel(options);
  return kit;
};
const errorOf = (res) => (res.json && res.json.error) || {};
const at = (ms) => new Date(ms);

// ---------------------------------------------------------------------------------------------------------------
// API-9
// ---------------------------------------------------------------------------------------------------------------

describe("API-9 GET /admin/api/api/messages", () => {
  test("an empty history is an empty page", async () => {
    await boot();
    const res = await kit.get(`${P}/messages`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { items: [], page: 1, pageSize: 50, total: 0 });
  });

  test("MessageRow: the documented fields; key is { id, name } for an API message and null for the panel's", async () => {
    await boot();
    const key = await kit.makeKey({ name: "n8n" });
    const api = await kit.makeMessage({ apiKeyId: key.id, recipient: A, format: "text", size: 12, status: "failed", errorCode: "not_on_whatsapp" });
    const panel = await kit.makeMessage({ source: "panel", recipient: GROUP, format: "poll", status: "queued", acceptedAt: at(kit.clock.now() + SECOND) });
    const { items } = (await kit.get(`${P}/messages`)).json;
    assert.deepEqual(items.map((m) => m.id), [panel.id, api.id], "newest first");
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ["acceptedAt", "failureCode", "format", "id", "key", "kind", "size", "source", "status", "to", "toName"]);
    }
    assert.deepEqual(items[1], {
      id: api.id,
      source: "api",
      key: { id: key.id, name: "n8n" },
      to: A,
      toName: null,
      kind: "private",
      format: "text",
      size: 12,
      status: "failed",
      failureCode: "not_on_whatsapp",
      acceptedAt: at(kit.clock.now()).toISOString(),
    });
    assert.equal(items[0].source, "panel");
    assert.equal(items[0].key, null);
    assert.equal(items[0].kind, "group");
    assert.equal(items[0].size, null);
    assert.equal(items[0].failureCode, null);
  });

  test("the recipient is the full JID and carries the KnownChat name; a purged key keeps its id with a null name", async () => {
    await boot();
    const key = await kit.makeKey({ name: "short lived" });
    await kit.makeMessage({ apiKeyId: key.id, recipient: A });
    await kit.makeMessage({ apiKeyId: 999, recipient: GROUP });
    const now = at(kit.clock.now());
    await kit.db.KnownChat.bulkCreate([
      { jid: "5@lid", kind: "private", pnJid: A, name: "Awa", firstSeenAt: now, lastSeenAt: now },
      { jid: GROUP, kind: "group", name: "Family", firstSeenAt: now, lastSeenAt: now },
    ]);
    const { items } = (await kit.get(`${P}/messages`)).json;
    const byTo = Object.fromEntries(items.map((m) => [m.to, m]));
    assert.equal(byTo[A].toName, "Awa");
    assert.equal(byTo[GROUP].toName, "Family");
    assert.deepEqual(byTo[GROUP].key, { id: 999, name: null });
  });

  test("no content ever: no text, caption, file, option, secret or request fingerprint is part of a row", async () => {
    await boot();
    const key = await kit.makeKey();
    await kit.makeMessage({
      apiKeyId: key.id,
      payload: { text: "CANARY-TEXT", caption: "CANARY-CAPTION", fileName: "CANARY-FILE.pdf", options: ["CANARY-OPTION"] },
      replyData: { hashes: ["CANARY-HASH"] },
      choices: [{ id: "a", label: "CANARY-LABEL" }],
      pollSecret: "enc:v1:CANARY-POLL",
      mediaPath: "data/api-media/CANARY/source",
      requestHash: "c".repeat(64),
      idempotencyKey: "CANARY-IDEM",
      waId: "3EB0CANARYWAID",
    });
    const list = await kit.get(`${P}/messages`);
    assert.ok(!list.text.includes("CANARY"), list.text);
    assert.ok(!list.text.includes("cccccccc"));
  });

  test("order: acceptedAt descending, then id descending", async () => {
    await boot();
    const t0 = kit.clock.now();
    const same1 = await kit.makeMessage({ acceptedAt: at(t0) });
    const same2 = await kit.makeMessage({ acceptedAt: at(t0) });
    const later = await kit.makeMessage({ acceptedAt: at(t0 + MINUTE) });
    const earlier = await kit.makeMessage({ acceptedAt: at(t0 - MINUTE) });
    assert.deepEqual((await kit.get(`${P}/messages`)).json.items.map((m) => m.id), [later.id, same2.id, same1.id, earlier.id]);
  });

  test("filters: key (an id or panel), status, format, from and to (inclusive bounds on acceptedAt)", async () => {
    await boot();
    const t0 = kit.clock.now();
    const k1 = await kit.makeKey({ name: "one" });
    const k2 = await kit.makeKey({ name: "two" });
    const m1 = await kit.makeMessage({ apiKeyId: k1.id, status: "sent", format: "text", acceptedAt: at(t0 - 3 * MINUTE) });
    const m2 = await kit.makeMessage({ apiKeyId: k1.id, status: "failed", format: "image", acceptedAt: at(t0 - 2 * MINUTE) });
    const m3 = await kit.makeMessage({ apiKeyId: k2.id, status: "sent", format: "text", acceptedAt: at(t0 - MINUTE) });
    const m4 = await kit.makeMessage({ source: "panel", status: "queued", format: "text", acceptedAt: at(t0) });
    const ids = async (query) => (await kit.get(`${P}/messages?${query}`)).json.items.map((m) => m.id);

    assert.deepEqual(await ids(`key=${k1.id}`), [m2.id, m1.id]);
    assert.deepEqual(await ids("key=panel"), [m4.id]);
    assert.deepEqual(await ids("key=777"), [], "an id with no match is an empty page, not a 404");
    assert.deepEqual(await ids("status=sent"), [m3.id, m1.id]);
    assert.deepEqual(await ids("format=image"), [m2.id]);
    assert.deepEqual(await ids("status=sent&format=text&key=" + k2.id), [m3.id]);
    const iso = (ms) => encodeURIComponent(at(ms).toISOString());
    assert.deepEqual(await ids(`from=${iso(t0 - 2 * MINUTE)}&to=${iso(t0 - MINUTE)}`), [m3.id, m2.id], "both bounds are inclusive");
    assert.deepEqual(await ids(`from=${iso(t0 - MINUTE)}`), [m4.id, m3.id]);
    assert.deepEqual(await ids(`to=${iso(t0 - 3 * MINUTE)}`), [m1.id]);
    assert.deepEqual(await ids(`from=${iso(t0)}&to=${iso(t0 - MINUTE)}`), [], "from after to is an empty page");
    assert.deepEqual(await ids(`from=${encodeURIComponent("2026-01-15T13:00:00+01:00")}&to=${encodeURIComponent("2026-01-15T12:00:00Z")}`), [m4.id], "an offset is read");
  });

  test("pages: page and pageSize (1 to 200, 50 by default), total counts the whole filtered set", async () => {
    await boot();
    const t0 = kit.clock.now();
    const made = [];
    for (let i = 0; i < 7; i += 1) made.push(await kit.makeMessage({ acceptedAt: at(t0 + i * SECOND) }));
    const newest = made.map((m) => m.id).reverse();
    const first = (await kit.get(`${P}/messages?pageSize=3`)).json;
    assert.deepEqual({ page: first.page, pageSize: first.pageSize, total: first.total }, { page: 1, pageSize: 3, total: 7 });
    assert.deepEqual(first.items.map((m) => m.id), newest.slice(0, 3));
    const third = (await kit.get(`${P}/messages?pageSize=3&page=3`)).json;
    assert.deepEqual(third.items.map((m) => m.id), newest.slice(6));
    const beyond = (await kit.get(`${P}/messages?pageSize=3&page=9`)).json;
    assert.deepEqual({ items: beyond.items, total: beyond.total }, { items: [], total: 7 });
    assert.equal((await kit.get(`${P}/messages?pageSize=200`)).status, 200);
    assert.equal((await kit.get(`${P}/messages?pageSize=1`)).json.items.length, 1);
  });

  test("a strict query: an unknown parameter, a bad value and an out-of-range page are 422 with their field", async () => {
    await boot();
    const field = async (query) => errorOf(await kit.get(`${P}/messages?${query}`)).fields;
    assert.deepEqual(await field("surprise=1"), { $unknown: { code: "unknown_field" } });
    assert.deepEqual(await field("key=abc"), { key: { code: "invalid_format" } });
    assert.deepEqual(await field("key=0"), { key: { code: "invalid_format" } });
    assert.equal((await field("status=lost")).status.code, "not_allowed");
    assert.deepEqual(await field("format=Text"), { format: { code: "invalid_format" } });
    assert.deepEqual(await field("from=yesterday"), { from: { code: "invalid_format" } });
    assert.deepEqual(await field("to=2026-01-15"), { to: { code: "invalid_format" } }, "a date without a time is not an instant");
    assert.deepEqual(await field("page=0"), { page: { code: "out_of_range", params: { min: 1 } } });
    assert.deepEqual(await field("pageSize=0"), { pageSize: { code: "out_of_range", params: { min: 1, max: 200 } } });
    assert.deepEqual(await field("pageSize=201"), { pageSize: { code: "out_of_range", params: { min: 1, max: 200 } } });
    assert.deepEqual(await field("pageSize=x"), { pageSize: { code: "invalid_format" } });
  });

  test("a read writes nothing", async () => {
    await boot();
    await kit.makeMessage();
    const before = await kit.snapshot();
    await kit.get(`${P}/messages?pageSize=5`);
    assert.deepEqual(await kit.snapshot(), before);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// API-10
// ---------------------------------------------------------------------------------------------------------------

describe("API-10 GET /admin/api/api/messages/:id", () => {
  const detail = async (id) => (await kit.get(`${P}/messages/${id}`)).json;

  test("404 not_found { resource: 'message' } for an unknown id and for one too large to exist", async () => {
    await boot();
    const unknown = await kit.get(`${P}/messages/12345`);
    assert.equal(unknown.status, 404);
    assert.equal(errorOf(unknown).code, "not_found");
    assert.deepEqual(errorOf(unknown).params, { resource: "message" });
    const huge = await kit.get(`${P}/messages/9999999999`);
    assert.equal(huge.status, 404);
    assert.equal((await kit.get(`${P}/messages/0`)).status, 404);
  });

  test("MessageDetail = MessageRow + publicId, waId, expiresAt, steps, interactive, responses", async () => {
    await boot();
    const key = await kit.makeKey({ name: "n8n" });
    const t0 = kit.clock.now();
    const row = await kit.makeMessage({ apiKeyId: key.id, status: "read", waId: "3EB0ABCDEF", acceptedAt: at(t0), sentAt: at(t0 + 2 * SECOND), readAt: at(t0 + 9 * SECOND), expiresAt: at(t0 + 10 * MINUTE) });
    const { message } = await detail(row.id);
    assert.deepEqual(Object.keys(message).sort(), [
      "acceptedAt", "expiresAt", "failureCode", "format", "id", "interactive", "key", "kind", "publicId", "responses", "size", "source", "status", "steps", "to", "toName", "waId",
    ]);
    assert.equal(message.id, row.id);
    assert.equal(message.publicId, row.publicId);
    assert.match(message.publicId, /^msg_[A-Za-z0-9_-]{22}$/);
    assert.equal(message.waId, "3EB0ABCDEF");
    assert.equal(message.expiresAt, at(t0 + 10 * MINUTE).toISOString());
    assert.deepEqual(message.key, { id: key.id, name: "n8n" });
    assert.equal(message.interactive, false);
    assert.equal(message.responses, null);
  });

  test("steps come from the timestamp columns, ascending; ties keep the lifecycle order", async () => {
    await boot();
    const t0 = kit.clock.now();
    const full = await kit.makeMessage({
      status: "read",
      acceptedAt: at(t0),
      sendingAt: at(t0), // the same millisecond as the acceptance: queued still comes first
      sentAt: at(t0 + 2 * SECOND),
      deliveredAt: at(t0 + 2 * SECOND), // a tie again: sent before delivered
      readAt: at(t0 + 9 * SECOND),
    });
    const steps = (await detail(full.id)).message.steps;
    assert.deepEqual(steps.map((s) => s.status), ["queued", "sending", "sent", "delivered", "read"]);
    assert.deepEqual(steps.map((s) => s.at), [t0, t0, t0 + 2 * SECOND, t0 + 2 * SECOND, t0 + 9 * SECOND].map((ms) => at(ms).toISOString()));
  });

  test("the terminal status is a step at endedAt, last among equals", async () => {
    await boot();
    const t0 = kit.clock.now();
    const failed = await kit.makeMessage({ status: "failed", errorCode: "send_failed", acceptedAt: at(t0), sendingAt: at(t0 + SECOND), endedAt: at(t0 + SECOND) });
    assert.deepEqual((await detail(failed.id)).message.steps, [
      { status: "queued", at: at(t0).toISOString() },
      { status: "sending", at: at(t0 + SECOND).toISOString() },
      { status: "failed", at: at(t0 + SECOND).toISOString() },
    ]);
    const expired = await kit.makeMessage({ status: "expired", acceptedAt: at(t0), endedAt: at(t0 + 10 * MINUTE) });
    assert.deepEqual((await detail(expired.id)).message.steps.map((s) => s.status), ["queued", "expired"]);
    const cancelled = await kit.makeMessage({ status: "cancelled", errorCode: "key_revoked", acceptedAt: at(t0), endedAt: at(t0) });
    assert.deepEqual((await detail(cancelled.id)).message.steps.map((s) => s.status), ["queued", "cancelled"]);
    const unknown = await kit.makeMessage({ status: "unknown", errorCode: "interrupted", acceptedAt: at(t0), sendingAt: at(t0 + SECOND), endedAt: at(t0 + 2 * SECOND) });
    assert.deepEqual((await detail(unknown.id)).message.steps.map((s) => s.status), ["queued", "sending", "unknown"]);
    const queued = await kit.makeMessage({ status: "queued", acceptedAt: at(t0) });
    assert.deepEqual((await detail(queued.id)).message.steps, [{ status: "queued", at: at(t0).toISOString() }]);
  });

  test("an unknown message later confirmed by a receipt shows no terminal step (its endedAt is cleared)", async () => {
    await boot();
    const t0 = kit.clock.now();
    const row = await kit.makeMessage({ status: "delivered", acceptedAt: at(t0), sendingAt: at(t0 + SECOND), sentAt: at(t0 + SECOND), deliveredAt: at(t0 + 4 * SECOND), endedAt: null });
    assert.deepEqual((await detail(row.id)).message.steps.map((s) => s.status), ["queued", "sending", "sent", "delivered"]);
  });

  test("a non-interactive format never asks the engine for answers", async () => {
    await boot();
    const row = await kit.makeMessage({ format: "text" });
    const { message } = await detail(row.id);
    assert.equal(message.interactive, false);
    assert.equal(message.responses, null);
    assert.equal(kit.messaging.calls.describeResponses.length, 0);
  });

  test("buttons, list and poll: the engine's describeResponses object, served unchanged", async () => {
    await boot();
    const t0 = kit.clock.now();
    const answer = {
      until: at(t0 + 7 * DAY).toISOString(),
      total: 2,
      items: [
        { at: at(t0 + SECOND).toISOString(), author: "237690000001", kind: "vote", via: null, choices: [{ id: "a", label: "Yes" }] },
        { at: at(t0 + 2 * SECOND).toISOString(), author: "237690000002", kind: "vote", via: null, choices: [{ id: "b", label: "No" }] },
      ],
      totals: [{ id: "a", label: "Yes", count: 1 }, { id: "b", label: "No", count: 1 }],
    };
    kit.messaging.responses = answer;
    for (const format of ["buttons", "list", "poll"]) {
      const row = await kit.makeMessage({ format, status: "sent", repliesUntil: at(t0 + 7 * DAY), choices: [{ id: "a", label: "Yes" }, { id: "b", label: "No" }] });
      const { message } = await detail(row.id);
      assert.equal(message.interactive, true, format);
      assert.deepEqual(message.responses, answer, format);
    }
    assert.equal(kit.messaging.calls.describeResponses.length, 3);
  });

  test("describeResponses gets the message row and its answers oldest first", async () => {
    await boot();
    const t0 = kit.clock.now();
    const row = await kit.makeMessage({ format: "poll", choices: [{ id: "a", label: "Yes" }], repliesUntil: at(t0 + DAY) });
    await kit.db.ApiMessageResponse.bulkCreate([
      { messageId: row.id, kind: "vote", author: B, voterKey: B, choiceIds: ["a"], respondedAt: at(t0 + 2 * SECOND) },
      { messageId: row.id, kind: "vote", author: A, voterKey: A, choiceIds: ["a"], respondedAt: at(t0 + SECOND) },
    ]);
    const other = await kit.makeMessage({ format: "poll" });
    await kit.db.ApiMessageResponse.create({ messageId: other.id, kind: "vote", author: A, voterKey: A, choiceIds: [], respondedAt: at(t0) });
    kit.messaging.responses = { until: null, total: 0, items: [], totals: [] };
    await detail(row.id);
    const call = kit.messaging.calls.describeResponses[0];
    assert.equal(call.row.id, row.id);
    assert.deepEqual(call.row.choices, [{ id: "a", label: "Yes" }]);
    assert.deepEqual(call.answers.map((a) => a.author), [A, B]);
    assert.ok(call.answers.every((a) => a.messageId === row.id), "only this message's answers");
  });

  test("a removed format module still shows the answers of the interactive formats it replaced", async () => {
    await boot();
    kit.messaging.formats = { get: () => null }; // the module is gone
    kit.messaging.responses = { until: null, total: 0, items: [], totals: null };
    const row = await kit.makeMessage({ format: "poll" });
    assert.equal((await detail(row.id)).message.interactive, true);
    const text = await kit.makeMessage({ format: "gone_format" });
    assert.equal((await detail(text.id)).message.interactive, false);
  });

  test("no content is served: payload, secrets and fingerprints stay in the table", async () => {
    await boot();
    const row = await kit.makeMessage({
      payload: { text: "CANARY-TEXT" },
      replyData: { hashes: ["CANARY-HASH"] },
      pollSecret: "enc:v1:CANARY-POLL",
      mediaPath: "data/api-media/CANARY/source",
      requestHash: "d".repeat(64),
      idempotencyKey: "CANARY-IDEM",
    });
    const res = await kit.get(`${P}/messages/${row.id}`);
    assert.ok(!res.text.includes("CANARY") && !res.text.includes("dddddddd"), res.text);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// API-12
// ---------------------------------------------------------------------------------------------------------------

describe("API-12 GET /admin/api/api/usage", () => {
  const usage = async (query = "") => (await kit.get(`${P}/usage${query ? `?${query}` : ""}`)).json;
  const total = (entry) => entry.days.reduce((sum, d) => ({ sent: sum.sent + d.sent, failed: sum.failed + d.failed }), { sent: 0, failed: 0 });

  test("dense: every day of the window appears for every entry, zeros included; 7 days by default, 30 on request", async () => {
    await boot();
    await kit.makeKey({ name: "quiet" });
    const week = await usage();
    assert.equal(week.timezone, "UTC");
    assert.equal(week.from, "2026-01-09");
    assert.equal(week.to, "2026-01-15");
    assert.equal(week.keys.length, 1);
    assert.deepEqual(week.keys[0].days.map((d) => d.day), ["2026-01-09", "2026-01-10", "2026-01-11", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15"]);
    assert.ok(week.keys[0].days.every((d) => d.sent === 0 && d.failed === 0));
    const month = await usage("days=30");
    assert.equal(month.from, "2025-12-17");
    assert.equal(month.keys[0].days.length, 30);
  });

  test("days are the local days of TIMEZONE: two messages one second apart land on two days across a day edge", async () => {
    await boot();
    kit.t.config.TIMEZONE = "Pacific/Auckland"; // UTC+13 in January
    const key = await kit.makeKey({ name: "edge" });
    // 2026-01-15T10:59:59Z is 23:59:59 on the 15th in Auckland, one second later it is the 16th
    await kit.makeMessage({ apiKeyId: key.id, status: "sent", acceptedAt: new Date("2026-01-15T10:59:59Z") });
    await kit.makeMessage({ apiKeyId: key.id, status: "sent", acceptedAt: new Date("2026-01-15T11:00:00Z") });
    const answer = await usage();
    assert.equal(answer.timezone, "Pacific/Auckland");
    assert.equal(answer.to, "2026-01-16", "now is 01:00 on the 16th in Auckland");
    assert.equal(answer.from, "2026-01-10");
    const days = Object.fromEntries(answer.keys[0].days.map((d) => [d.day, d]));
    assert.deepEqual([days["2026-01-15"].sent, days["2026-01-16"].sent], [1, 1]);
    // the same instants in UTC are the same day
    kit.t.config.TIMEZONE = "UTC";
    const utc = Object.fromEntries((await usage()).keys[0].days.map((d) => [d.day, d]));
    assert.equal(utc["2026-01-15"].sent, 2);
  });

  test("an invalid TIMEZONE falls back to UTC", async () => {
    await boot();
    kit.t.config.TIMEZONE = "Mars/Olympus";
    assert.equal((await usage()).timezone, "UTC");
  });

  test("sent counts sent, delivered and read; failed counts failed, expired and unknown; queued, sending and cancelled count in neither", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k" });
    for (const status of ["sent", "delivered", "read", "failed", "expired", "unknown", "queued", "sending", "cancelled"]) {
      await kit.makeMessage({ apiKeyId: key.id, status });
    }
    await kit.makeMessage({ apiKeyId: key.id, status: "sent" });
    const entry = (await usage()).keys[0];
    assert.deepEqual(total(entry), { sent: 4, failed: 3 });
    assert.deepEqual(entry.days.at(-1), { day: "2026-01-15", sent: 4, failed: 3 });
  });

  test("messages older than the window are not counted (and retention purged data reads zero)", async () => {
    await boot();
    const key = await kit.makeKey({ name: "old" });
    await kit.makeMessage({ apiKeyId: key.id, status: "sent", acceptedAt: at(kit.clock.now() - 8 * DAY) });
    await kit.makeMessage({ apiKeyId: key.id, status: "sent", acceptedAt: at(kit.clock.now() - 6 * DAY) });
    assert.deepEqual(total((await usage()).keys[0]), { sent: 1, failed: 0 });
    assert.deepEqual(total((await usage("days=30")).keys[0]), { sent: 2, failed: 0 });
  });

  test("entries for 'all': every live key, a revoked key only with messages in the window, the panel only with messages", async () => {
    await boot();
    const live = await kit.makeKey({ name: "live" });
    const revokedBusy = await kit.makeKey({ name: "busy then revoked", revokedAt: at(kit.clock.now() - DAY) });
    const revokedIdle = await kit.makeKey({ name: "idle then revoked", revokedAt: at(kit.clock.now() - DAY) });
    const live2 = await kit.makeKey({ name: "live too" });
    const names = async (query) => (await usage(query)).keys.map((e) => [e.id, e.name, e.source, e.revoked]);

    assert.deepEqual(await names(), [[live.id, "live", "api", false], [live2.id, "live too", "api", false]]);
    await kit.makeMessage({ apiKeyId: revokedBusy.id, status: "sent" });
    await kit.makeMessage({ source: "panel", status: "failed" });
    assert.deepEqual(await names(), [
      [live.id, "live", "api", false],
      [live2.id, "live too", "api", false],
      [revokedBusy.id, "busy then revoked", "api", true],
      [null, null, "panel", false],
    ]);
    assert.ok(!(await names()).some(([id]) => id === revokedIdle.id));
  });

  test("a key id selects that key (a revoked one too); 'panel' gives the panel entry even without messages; an unknown id is 404", async () => {
    await boot();
    const one = await kit.makeKey({ name: "one" });
    const two = await kit.makeKey({ name: "two", revokedAt: at(kit.clock.now() - DAY) });
    await kit.makeMessage({ apiKeyId: one.id, status: "sent" });
    await kit.makeMessage({ apiKeyId: two.id, status: "failed" });
    const picked = await usage(`key=${one.id}`);
    assert.deepEqual(picked.keys.map((e) => e.id), [one.id]);
    assert.deepEqual(total(picked.keys[0]), { sent: 1, failed: 0 });
    const revoked = await usage(`key=${two.id}`);
    assert.deepEqual([revoked.keys[0].id, revoked.keys[0].revoked], [two.id, true]);
    assert.deepEqual(total(revoked.keys[0]), { sent: 0, failed: 1 });

    const panel = await usage("key=panel");
    assert.deepEqual(panel.keys.map((e) => [e.id, e.name, e.source]), [[null, null, "panel"]]);
    assert.deepEqual(total(panel.keys[0]), { sent: 0, failed: 0 });
    await kit.makeMessage({ source: "panel", status: "sent" });
    assert.deepEqual(total((await usage("key=panel")).keys[0]), { sent: 1, failed: 0 });

    const missing = await kit.get(`${P}/usage?key=4242`);
    assert.equal(missing.status, 404);
    assert.deepEqual(errorOf(missing).params, { resource: "key" });
  });

  test("a strict query: days is 7 or 30, key is all, panel or an id", async () => {
    await boot();
    const field = async (query) => errorOf(await kit.get(`${P}/usage?${query}`)).fields;
    assert.equal((await field("days=8")).days.code, "not_allowed");
    assert.deepEqual((await field("days=8")).days.params, { allowed: ["7", "30"] });
    assert.deepEqual(await field("key=abc"), { key: { code: "invalid_format" } });
    assert.deepEqual(await field("window=7"), { $unknown: { code: "unknown_field" } });
  });

  test("a read writes nothing", async () => {
    await boot();
    const key = await kit.makeKey();
    await kit.makeMessage({ apiKeyId: key.id });
    const before = await kit.snapshot();
    await kit.get(`${P}/usage?days=30&key=all`);
    assert.deepEqual(await kit.snapshot(), before);
  });
});

// ===============================================================================================================
// Part 2: API-11, the test send
// ===============================================================================================================

const NUMBER = "237690000001";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]);

/** A kit with the switch on and, optionally, a file the fake engine "fetches" from media.url */
async function bootSend(options = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-test-send-"));
  const staged = path.join(tmp, "fetched.png");
  fs.writeFileSync(staged, PNG);
  await boot({ fetched: () => ({ path: staged, size: PNG.length, name: null, sha256: "b".repeat(64), mime: "image/png", ext: "png", kind: "image", source: "url" }), ...options });
  kit.staged = staged;
  if (options.enabled !== false) await kit.apiState.setState({ enabled: true }, { now: kit.clock.now() });
  return kit;
}
const send = (over = {}) => kit.post(`${P}/test`, { format: "text", to: NUMBER, ...((over.format || "text") === "text" ? { text: "hello" } : {}), ...over });
const upload = async (buffer, query = "purpose=api&name=photo.png", client = kit.client) => {
  const res = await client.raw({
    method: "PUT",
    path: `/admin/api/uploads?${query}`,
    headers: { Origin: kit.t.base, "X-CSRF-Token": client.csrf, "Content-Type": "application/octet-stream", "Content-Length": buffer.length },
    body: buffer,
  });
  return res;
};

describe("API-11 POST /admin/api/api/test: availability and the body", () => {
  test("202 { message: MessageRow }: source panel, no key, queued, the engine got a panel submission (no key policy, no quota, no idempotency)", async () => {
    await bootSend();
    const res = await send();
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(Object.keys(res.json), ["message"]);
    const message = res.json.message;
    assert.deepEqual(Object.keys(message).sort(), ["acceptedAt", "failureCode", "format", "id", "key", "kind", "size", "source", "status", "to", "toName"]);
    assert.equal(message.source, "panel");
    assert.equal(message.key, null);
    assert.equal(message.status, "queued");
    assert.equal(message.to, `${NUMBER}@s.whatsapp.net`);
    assert.equal(message.kind, "private");
    assert.equal(message.format, "text");
    const [request] = kit.messaging.calls.submit;
    assert.equal(request.source, "panel");
    assert.equal(request.apiKeyId, null);
    assert.equal(request.policy, null, "no recipient policy of a key applies");
    assert.equal(request.limits, null, "no per-key quota applies");
    assert.equal(request.idempotency, null);
    assert.equal(request.media, null);
    assert.match(request.requestId, /^[0-9a-f]{16}$/);
    assert.equal(request.fields.text, "hello");
    assert.equal(request.now, kit.clock.now());
    assert.deepEqual(kit.messaging.calls.resolveRecipient[0].opts, { policy: null });
    assert.equal((await kit.rows("ApiMessage"))[0].source, "panel");
  });

  test("a disconnected bot still accepts (the message is queued)", async () => {
    await bootSend();
    kit.messaging.botReady = false;
    assert.equal((await send()).status, 202);
  });

  test("409 api_disabled { reason: 'switch_off' } while the switch is off: the engine is not reached", async () => {
    await bootSend({ enabled: false });
    const res = await send();
    assert.equal(res.status, 409);
    assert.equal(errorOf(res).code, "api_disabled");
    assert.deepEqual(errorOf(res).params, { reason: "switch_off" });
    assert.equal(kit.messaging.calls.resolveRecipient.length, 0);
    assert.deepEqual(await kit.audits("api."), []);
  });

  test("409 api_disabled { reason: 'registry_failed', endpoint } when the registry failed", async () => {
    await bootSend({ failure: { endpoint: "messages.create" } });
    const res = await send();
    assert.equal(res.status, 409);
    assert.deepEqual(errorOf(res).params, { reason: "registry_failed", endpoint: "messages.create" });
  });

  test("413 payload_too_large above 64 KiB; a body that is not an object is 400", async () => {
    await bootSend();
    const big = await send({ text: "x".repeat(70 * 1024) });
    assert.equal(big.status, 413);
    assert.equal(errorOf(big).code, "payload_too_large");
    assert.deepEqual(errorOf(big).params, { maxBytes: 65536 });
    const array = await kit.client.api("POST", `${P}/test`, "[1,2]");
    assert.equal(array.status, 400);
    assert.equal(kit.messaging.calls.submit.length, 0);
  });

  test("format: required, invalid_type, and not_allowed with the list of formats", async () => {
    await bootSend();
    assert.deepEqual(errorOf(await kit.post(`${P}/test`, { to: NUMBER })).fields, { format: { code: "required" } });
    assert.deepEqual(errorOf(await kit.post(`${P}/test`, { format: 3, to: NUMBER })).fields, { format: { code: "invalid_type" } });
    const unknown = await send({ format: "fax" });
    assert.equal(unknown.status, 422);
    assert.equal(errorOf(unknown).fields.format.code, "not_allowed");
    assert.deepEqual(errorOf(unknown).fields.format.params.allowed, formats.list().map((row) => row.name));
  });

  test("to: required, invalid_type, invalid_format; the bot's own number and a disabled chat are the engine's answers", async () => {
    await bootSend();
    assert.deepEqual(errorOf(await kit.post(`${P}/test`, { format: "text", text: "x" })).fields, { to: { code: "required" } });
    assert.deepEqual(errorOf(await kit.post(`${P}/test`, { format: "text", text: "x", to: 5 })).fields, { to: { code: "invalid_type" } });
    assert.deepEqual(errorOf(await send({ to: "abc" })).fields, { to: { code: "invalid_format" } });
    assert.equal((await send({ to: `${NUMBER}@s.whatsapp.net` })).status, 422, "a JID is not a number");
    kit.messaging.refuse.resolveRecipient = () => new MessagingError("chat_disabled");
    const disabled = await send();
    assert.equal(disabled.status, 409);
    assert.equal(errorOf(disabled).code, "chat_disabled");
    kit.messaging.refuse.resolveRecipient = () => new MessagingError("validation_failed", { fields: { to: { code: "not_allowed" } } });
    assert.deepEqual(errorOf(await send()).fields, { to: { code: "not_allowed" } });
  });

  test("the format's own fields: dotted paths, $unknown at the level of an unknown property, nothing echoed", async () => {
    await bootSend();
    const res = await kit.post(`${P}/test`, {
      format: "buttons",
      to: NUMBER,
      text: "pick one",
      buttons: [{ id: "yes", label: "Yes" }, { id: "no id!", label: "" }, { id: "x", label: "X", color: "red" }],
      surprise: "SECRET-VALUE",
    });
    assert.equal(res.status, 422, res.text);
    const fields = errorOf(res).fields;
    assert.ok(fields["buttons.1.id"] || fields["buttons.1.label"], JSON.stringify(fields));
    assert.equal(fields["buttons.2.$unknown"].code, "unknown_field");
    assert.equal(fields.$unknown.code, "unknown_field");
    assert.ok(!res.text.includes("SECRET-VALUE") && !res.text.includes("no id!"));
  });

  test("wait and idempotencyKey belong to the public API: unknown properties here", async () => {
    await bootSend();
    const res = await send({ wait: 5, idempotencyKey: "abc" });
    assert.equal(res.status, 422);
    assert.deepEqual(errorOf(res).fields, { $unknown: { code: "unknown_field" } });
    assert.equal(kit.messaging.calls.submit.length, 0);
  });

  test("quote: the public id of an earlier panel message to the same chat, else fields.quote = not_found", async () => {
    await bootSend();
    const missing = await send({ quote: "msg_AAAAAAAAAAAAAAAAAAAAAA" });
    assert.deepEqual(errorOf(missing).fields, { quote: { code: "not_found" } });
    const first = await send();
    assert.equal(first.status, 202);
    const row = (await kit.rows("ApiMessage"))[0];
    kit.messaging.quotable.add(row.publicId);
    const quoted = await send({ quote: row.publicId });
    assert.equal(quoted.status, 202, quoted.text);
    assert.equal(kit.messaging.calls.submit.at(-1).quote, row.publicId);
  });
});

describe("API-11: the engine's refusals are mapped by code, never a 500", () => {
  const cases = [
    ["chat_disabled", () => new MessagingError("chat_disabled"), 409, null],
    ["queue_full", () => new MessagingError("queue_full", { params: { scope: "global", retryAfterMs: 30000 } }), 503, { scope: "global", retryAfterMs: 30000 }],
    ["media_type_mismatch", () => new MessagingError("media_type_mismatch", { params: { expected: ["image"] } }), 422, { expected: ["image"] }],
    ["media_too_large", () => new MessagingError("media_too_large", { params: { maxBytes: 100 } }), 413, { maxBytes: 100 }],
    ["url_forbidden", () => new MessagingError("url_forbidden", { params: { reason: "private_address" } }), 422, { reason: "private_address" }],
    ["url_unreachable", () => new MessagingError("url_unreachable"), 502, null],
    ["recipient_not_allowed", () => new MessagingError("recipient_not_allowed"), 403, null],
    ["pending_limit_reached", () => new MessagingError("pending_limit_reached", { params: { retryAfterMs: 5000 } }), 429, { retryAfterMs: 5000 }],
  ];
  for (const [code, make, status, params] of cases) {
    test(`${code} -> ${status}${params ? " with its parameters" : ""}`, async () => {
      await bootSend();
      kit.messaging.refuse.submit = make;
      const res = await send();
      assert.equal(res.status, status, res.text);
      assert.equal(errorOf(res).code, code);
      if (params) assert.deepEqual(errorOf(res).params, params);
      assert.deepEqual(await kit.audits("api."), [], "a refusal is not audited");
    });
  }

  test("queue_full: retryAfterMs becomes Retry-After in seconds", async () => {
    await bootSend();
    kit.messaging.refuse.submit = () => new MessagingError("queue_full", { params: { scope: "wait", retryAfterMs: 12500 } });
    assert.equal((await send()).headers.get("retry-after"), "13");
  });

  test("an unexpected failure is an opaque 500 internal_error, logged, with no cause in the answer", async () => {
    await bootSend();
    kit.messaging.refuse.submit = new Error("kaboom with a secret detail");
    const res = await send();
    assert.equal(res.status, 500);
    assert.equal(errorOf(res).code, "internal_error");
    assert.ok(!res.text.includes("kaboom"));
  });
});

describe("API-11: the media, an uploaded file or media.url", () => {
  test("an upload of purpose api is sent as a copy, then consumed ONLY after acceptance", async () => {
    await bootSend();
    const put = await upload(PNG);
    assert.equal(put.status, 201, put.text);
    const { uploadId } = put.json;
    assert.equal(put.json.kind, "image");
    const res = await send({ format: "image", caption: "look", uploadId });
    assert.equal(res.status, 202, res.text);
    const [request] = kit.messaging.calls.submit;
    assert.equal(request.media.mode, "copy", "the engine copies: the upload record is consumed after acceptance");
    assert.equal(request.media.source, "upload");
    assert.equal(request.media.size, PNG.length);
    assert.deepEqual(request.fields, { caption: "look" });
    assert.equal(kit.t.admin.uploads.peek(uploadId, await kit.sessionId(), { purpose: "api" }), null, "consumed");
    assert.equal(fs.existsSync(request.media.path), false, "and its file deleted");
  });

  test("a refused test leaves the upload in place so the owner can fix the other fields and retry", async () => {
    await bootSend();
    const { uploadId } = (await upload(PNG)).json;
    kit.messaging.refuse.submit = () => new MessagingError("media_type_mismatch", { params: { expected: ["image"] } });
    const refused = await send({ format: "image", uploadId });
    assert.equal(refused.status, 422);
    assert.ok(kit.t.admin.uploads.peek(uploadId, (await kit.sessionId()), { purpose: "api" }), "kept");
    delete kit.messaging.refuse.submit;
    const retry = await send({ format: "image", uploadId });
    assert.equal(retry.status, 202, retry.text);
    assert.equal(kit.t.admin.uploads.peek(uploadId, (await kit.sessionId()), { purpose: "api" }), null);
    const again = await send({ format: "image", uploadId });
    assert.deepEqual(errorOf(again).fields, { uploadId: { code: "not_found" } }, "a consumed upload");
  });

  test("an unknown, foreign or wrong-purpose upload is fields.uploadId = not_found, never told apart", async () => {
    await bootSend();
    const other = kit.t.client();
    assert.equal((await other.login(kit.PASSWORD)).status, 200);
    const foreign = (await upload(PNG, "purpose=api", other)).json.uploadId;
    const wrong = (await upload(PNG, "purpose=broadcast&name=a.png")).json.uploadId;
    for (const uploadId of ["a".repeat(32), foreign, wrong]) {
      const res = await send({ format: "image", uploadId });
      assert.equal(res.status, 422);
      assert.deepEqual(errorOf(res).fields, { uploadId: { code: "not_found" } });
    }
    assert.equal(kit.messaging.calls.submit.length, 0);
    assert.ok(kit.t.admin.uploads.peek(foreign, "x", { purpose: "api" }) === null);
  });

  test("uploadId must be 32 hex characters; on a format without media it is not_allowed", async () => {
    await bootSend();
    assert.deepEqual(errorOf(await send({ format: "image", uploadId: "xyz" })).fields, { uploadId: { code: "invalid_format" } });
    assert.deepEqual(errorOf(await send({ format: "image", uploadId: 5 })).fields, { uploadId: { code: "invalid_type" } });
    const { uploadId } = (await upload(PNG)).json;
    assert.deepEqual(errorOf(await send({ uploadId })).fields, { uploadId: { code: "not_allowed" } });
    assert.ok(kit.t.admin.uploads.peek(uploadId, (await kit.sessionId()), { purpose: "api" }), "the upload is untouched");
  });

  test("exactly one source: neither is media required, both is media not_allowed", async () => {
    await bootSend();
    assert.deepEqual(errorOf(await send({ format: "image" })).fields, { media: { code: "required" } });
    const { uploadId } = (await upload(PNG)).json;
    const both = await send({ format: "image", uploadId, media: { url: "https://media.example.org/a.png" } });
    assert.deepEqual(errorOf(both).fields, { media: { code: "not_allowed" } });
    assert.equal(kit.messaging.calls.fetchMedia.length, 0);
  });

  test("media.url: the engine fetches it (same protections) and the file travels as a move from the url source", async () => {
    await bootSend();
    const res = await send({ format: "image", media: { url: "https://media.example.org/a.png" } });
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(kit.messaging.calls.fetchMedia.map((c) => [c.name, c.url]), [["image", "https://media.example.org/a.png"]]);
    const [request] = kit.messaging.calls.submit;
    assert.equal(request.media.mode, "move");
    assert.equal(request.media.source, "url");
    assert.equal(fs.existsSync(kit.staged), false, "the fetched temporary file is not left behind");
  });

  test("a refused fetch or send removes the temporary file it fetched", async () => {
    await bootSend();
    kit.messaging.refuse.submit = () => new MessagingError("queue_full", { params: { scope: "disk", retryAfterMs: 1000 } });
    const res = await send({ format: "image", media: { url: "https://media.example.org/a.png" } });
    assert.equal(res.status, 503);
    assert.equal(fs.existsSync(kit.staged), false);
    kit.messaging.refuse.fetchMedia = () => new MessagingError("url_forbidden", { params: { reason: "private_address" } });
    const forbidden = await send({ format: "image", media: { url: "http://10.0.0.1/a.png" } });
    assert.equal(forbidden.status, 422);
    assert.equal(errorOf(forbidden).code, "url_forbidden");
  });
});

describe("API-11: the audit", () => {
  test("api.test on acceptance only, target the message id, detail { format, kind } and nothing of the recipient or content", async () => {
    await bootSend();
    await send({ text: "refuse me", to: "abc" });
    assert.deepEqual(await kit.audits("api."), []);
    const ok = await send({ text: "SECRET-BODY" });
    const audits = await kit.audits("api.");
    assert.equal(audits.length, 1);
    assert.deepEqual([audits[0].action, audits[0].target, audits[0].detail], ["api.test", String(ok.json.message.id), { format: "text", kind: "private" }]);
    assert.ok(!audits[0].raw.includes("SECRET-BODY") && !audits[0].raw.includes(NUMBER));
    const group = await send({ format: "poll", to: "120363025246125486@g.us", question: "Q?", options: ["a", "b"] });
    assert.equal(group.status, 202, group.text);
    assert.deepEqual((await kit.audits("api.")).at(-1).detail, { format: "poll", kind: "group" });
  });

  test("the route table: POST test is session + csrf, no step-up", async () => {
    await bootSend();
    const row = kit.t.admin.routes().find((r) => r.method === "POST" && r.path === `${P}/test`);
    assert.deepEqual({ auth: row.auth, csrf: row.csrf, stepUp: row.stepUp }, { auth: "session", csrf: true, stepUp: false });
    await kit.expireConfirmation();
    assert.equal((await send()).status, 202, "a test send asks no password (not listed in FR-021)");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same routes against the real engine facade (lib/messaging, as committed by E-OUT)
// ---------------------------------------------------------------------------------------------------------------

describe("API-11, API-9 and API-10 over the real messaging facade", () => {
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  let engine = null;

  afterEach(async () => {
    if (engine) await engine.close();
    engine = null;
  });

  async function bootReal() {
    const { createEngineKit } = require("./helpers/messagingKit");
    engine = await createEngineKit();
    await engine.start(); // the engine knows its own socket (the bot's number) once started
    await boot({ messaging: engine.messaging });
    await kit.apiState.setState({ enabled: true }, { now: kit.clock.now() });
    return kit;
  }

  test("a text and a poll are accepted by the engine, listed in the history and described with their real steps and answers", async () => {
    await bootReal();
    const text = await send({ text: "hello from the panel" });
    assert.equal(text.status, 202, text.text);
    assert.equal(text.json.message.status, "queued");
    assert.equal(text.json.message.source, "panel");
    const poll = await send({ format: "poll", to: "120363025246125486@g.us", question: "Which day?", options: ["Tuesday", "Thursday"], multiple: false });
    assert.equal(poll.status, 202, poll.text);
    assert.equal(poll.json.message.kind, "group");

    const list = (await kit.get(`${P}/messages?key=panel`)).json;
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map((m) => m.format).sort(), ["poll", "text"]);

    const plain = (await kit.get(`${P}/messages/${text.json.message.id}`)).json.message;
    assert.equal(plain.interactive, false);
    assert.equal(plain.responses, null);
    assert.deepEqual(plain.steps.map((s) => s.status), ["queued"]);
    assert.ok(!JSON.stringify(plain).includes("hello from the panel"), "no content in the detail");

    const detail = (await kit.get(`${P}/messages/${poll.json.message.id}`)).json.message;
    assert.equal(detail.interactive, true);
    assert.equal(detail.responses.total, 0);
    assert.deepEqual(detail.responses.items, []);
    assert.equal(detail.responses.until, null, "the reply window opens when the message is sent");
    assert.ok(!JSON.stringify(detail).includes("Which day?"), "no question in the detail");
  });

  test("an upload is copied into the engine's staging area and consumed after acceptance; a wrong type is the engine's media_type_mismatch and keeps the upload", async () => {
    await bootReal();
    const wrongType = (await upload(PDF, "purpose=api&name=doc.pdf")).json.uploadId;
    const mismatch = await send({ format: "image", uploadId: wrongType });
    assert.equal(mismatch.status, 422, mismatch.text);
    assert.equal(errorOf(mismatch).code, "media_type_mismatch");
    assert.ok(kit.t.admin.uploads.peek(wrongType, await kit.sessionId(), { purpose: "api" }), "kept for a retry");
    assert.equal(await kit.db.ApiMessage.count(), 0);

    const right = (await upload(PNG)).json.uploadId;
    const ok = await send({ format: "image", caption: "look", uploadId: right });
    assert.equal(ok.status, 202, ok.text);
    assert.equal(kit.t.admin.uploads.peek(right, await kit.sessionId(), { purpose: "api" }), null, "consumed after acceptance");
    const [row] = await kit.rows("ApiMessage");
    assert.equal(row.format, "image");
    assert.ok(row.mediaPath, "the engine staged the file");
  });

  test("a disabled chat is the engine's chat_disabled (409) and nothing is queued", async () => {
    await bootReal();
    engine.banned.add(`${NUMBER}@s.whatsapp.net`);
    const res = await send();
    assert.equal(res.status, 409, res.text);
    assert.equal(errorOf(res).code, "chat_disabled");
    assert.equal(await kit.db.ApiMessage.count(), 0);
    assert.deepEqual(await kit.audits("api."), []);
  });

  test("the engine's own number is refused as a recipient (U7) and a bad number is invalid_format", async () => {
    await bootReal();
    const { OWN_NUMBER } = require("./helpers/messagingKit");
    const own = await send({ to: OWN_NUMBER });
    assert.equal(own.status, 422, own.text);
    assert.deepEqual(errorOf(own).fields, { to: { code: "not_allowed" } });
    assert.deepEqual(errorOf(await send({ to: "12" })).fields, { to: { code: "invalid_format" } });
  });
});
