"use strict";
/**
 * Feature 004 (messaging API): PUB-1 to PUB-3 over the REAL stack (test/helpers/apiHarness.js), contracts/public-api.md
 * sections 2, 3, 4, 7.4 and 11. Part 1: PUB-1 (the 202, `wait`, `to`, a text that looks like a command, idempotency,
 * rate limits, SC-010). Part 2: files and URLs. Part 3: PUB-2 and PUB-3. Part 4: polls. Part 5: buttons and lists.
 */

const { test, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createApiHarness } = require("./helpers/apiHarness");
const { assertMessageInvariants } = require("./helpers/apiInvariants");

const SEC = 1000;
const MIN = 60 * SEC;
const TO = "237690000001";
const TEXT = { format: "text", to: TO, text: "Hello Awa, your order #4821 has shipped." };

let h;
let key;
before(async () => {
  h = await createApiHarness({});
  key = await h.createKey({ name: "main", rights: "all" });
});
after(async () => {
  await h.close();
});

// every test starts with an empty queue and an open gate, so what it sends is what it queued
beforeEach(async () => {
  await h.drain();
});

const sentText = (at = 0) => {
  const entry = h.sock.sent[at];
  return entry ? fakes.textOf(entry.content) : null;
};

describe("part 1: PUB-1 POST /api/v1/messages", () => {
  test("202 with Location and the message resource of 4.1, exactly", async () => {
    const res = await h.send(key, TEXT);
    assert.equal(res.status, 202);
    const message = res.json.message;
    assert.deepEqual(Object.keys(res.json), ["message"]);
    assert.deepEqual(Object.keys(message), ["id", "format", "to", "chatType", "status", "size", "requestId", "steps", "expiresAt", "endedAt", "failure", "responses"]);
    assert.match(message.id, /^msg_[A-Za-z0-9_-]{22}$/);
    assert.equal(res.headers.location, `/api/v1/messages/${message.id}`);
    assert.equal(message.format, "text");
    assert.equal(message.to, TO);
    assert.equal(message.chatType, "private");
    assert.equal(message.status, "queued");
    assert.equal(message.size, Buffer.byteLength(TEXT.text, "utf8"));
    assert.equal(message.requestId, res.headers["x-request-id"]);
    assert.deepEqual(message.steps, { queued: new Date(h.now()).toISOString(), sending: null, sent: null, delivered: null, read: null });
    assert.equal(message.expiresAt, new Date(h.now() + 10 * MIN).toISOString());
    assert.equal(message.endedAt, null);
    assert.equal(message.failure, null);
    assert.equal(message.responses, null);
    assert.equal(res.headers["idempotent-replayed"], undefined);
    assert.equal(h.sock.sent.length, 0, "the answer does not wait for the send");
    // nothing about the content leaves the server
    assert.equal(res.text.includes("Awa"), false);
    const row = await h.row(message.id);
    assertMessageInvariants(row);
    assert.equal(row.source, "api");
    assert.equal(row.apiKeyId, key.id);
  });

  test("the RateLimit headers describe the per-minute window of the key", async () => {
    const limited = await h.createKey({ name: "limited", limits: { perMinute: 5 } });
    const first = await h.send(limited, TEXT);
    assert.equal(first.headers["ratelimit-limit"], "5");
    assert.equal(first.headers["ratelimit-remaining"], "4");
    assert.equal(first.headers["ratelimit-reset"], "60");
    await h.clock.advance(10 * SEC);
    const second = await h.send(limited, TEXT);
    assert.equal(second.headers["ratelimit-remaining"], "3");
    assert.equal(second.headers["ratelimit-reset"], "50");
  });

  test("the message is sent by the queue, and a send moves it to sent", async () => {
    const before = h.sock.sent.length;
    const res = await h.send(key, TEXT);
    await h.tick(2 * SEC);
    assert.equal(h.sock.sent.length, before + 1);
    assert.equal(sentText(before), TEXT.text);
    const got = await h.get(`/api/v1/messages/${res.json.message.id}`, key);
    assert.equal(got.json.message.status, "sent");
    assert.ok(got.json.message.steps.sent);
  });

  describe("wait", () => {
    test("resolves when the message is sent, not before", async () => {
      const count = await h.db.ApiMessage.count();
      const pending = h.request("POST", "/api/v1/messages?wait=30", { key, body: { ...TEXT, text: "wait for the send" } });
      assert.ok(await h.accepted(count + 1));
      await fakes.sleep(40);
      await h.tick(2 * SEC);
      const res = await h.until(pending, { advance: false });
      assert.equal(res.status, 202);
      assert.equal(res.json.message.status, "sent");
      assert.ok(res.json.message.steps.sent);
      assert.equal(res.headers.location, `/api/v1/messages/${res.json.message.id}`);
    });

    test("times out at the bound with the current status", async () => {
      const paused = await h.createKey({ name: "paused" });
      h.setConnected(false);
      try {
        const started = h.clock.now();
        const pending = h.request("POST", "/api/v1/messages?wait=2", { key: paused, body: TEXT });
        const res = await h.until(pending, { step: 500 });
        assert.equal(res.status, 202);
        assert.equal(res.json.message.status, "queued");
        assert.ok(h.clock.now() - started >= 2 * SEC);
        assert.ok(h.clock.now() - started < 10 * SEC);
      } finally {
        h.setConnected(true);
        await h.run(20 * SEC, 2 * SEC);
      }
    });

    test("a caller that disconnects only abandons the wait: the message stays queued and is sent", async () => {
      const gone = await h.createKey({ name: "gone" });
      const controller = new AbortController();
      h.setConnected(false);
      const count = await h.db.ApiMessage.count();
      const pending = h.request("POST", "/api/v1/messages?wait=30", { key: gone, body: { ...TEXT, text: "abandoned" }, signal: controller.signal }).catch((err) => err);
      assert.ok(await h.accepted(count + 1));
      controller.abort();
      const outcome = await pending;
      assert.ok(outcome instanceof Error);
      const rows = (await h.rows()).filter((r) => r.apiKeyId === gone.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "queued");
      h.setConnected(true);
      await h.run(10 * SEC, 2 * SEC);
      assert.equal((await h.row(rows[0].publicId)).status, "sent");
    });

    test("31, true, -1 and 1.5 are refused, the Prefer header is ignored", async () => {
      const count = await h.db.ApiMessage.count();
      const over = await h.request("POST", "/api/v1/messages?wait=31", { key, body: TEXT });
      assert.equal(over.status, 422);
      assert.deepEqual(over.json.error.fields.wait, { code: "out_of_range", params: { min: 0, max: 30 } });
      for (const value of ["true", "-1", "1.5", "abc", ""]) {
        const res = await h.request("POST", `/api/v1/messages?wait=${value}`, { key, body: TEXT });
        assert.equal(res.status, 422, value);
        assert.deepEqual(res.json.error.fields.wait, { code: "invalid_format" }, value);
      }
      assert.equal(await h.db.ApiMessage.count(), count, "nothing queued");
      const started = Date.now();
      const preferred = await h.request("POST", "/api/v1/messages", { key, body: TEXT, headers: { Prefer: "wait=30" } });
      assert.equal(preferred.json.message.status, "queued");
      assert.ok(Date.now() - started < 2000);
    });

    test("a bad wait appears next to the body faults", async () => {
      const res = await h.request("POST", "/api/v1/messages?wait=99", { key, body: { format: "text", to: TO } });
      assert.equal(res.status, 422);
      assert.deepEqual(Object.keys(res.json.error.fields).sort(), ["text", "wait"]);
    });
  });

  describe("to", () => {
    const GOOD = ["237690000001", "+237 690 00 00 01", "00237690000001", "(237) 690.000.001", "237-690-000-001", "  237690000001  ", "+237690000001"];
    for (const input of GOOD) {
      test(`normalised: ${JSON.stringify(input)}`, async () => {
        const res = await h.send(key, { ...TEXT, to: input });
        assert.equal(res.status, 202);
        assert.equal(res.json.message.to, "237690000001");
        assert.equal(res.json.message.chatType, "private");
      });
    }

    const BAD = ["690", "2376900000011111", "0690000001", "abc", "237690000001@s.whatsapp.net", "123456789012@lid", "1203630252@g.us@x", "237690000001 x"];
    for (const input of BAD) {
      test(`refused: ${JSON.stringify(input)}`, async () => {
        const count = await h.db.ApiMessage.count();
        const res = await h.send(key, { ...TEXT, to: input });
        assert.equal(res.status, 422);
        assert.deepEqual(res.json.error.fields, { to: { code: "invalid_format" } }, "returned alone");
        assert.equal(res.text.includes(input.trim()) && input.trim().length > 3, false, "the value is never echoed");
        assert.equal(await h.db.ApiMessage.count(), count);
      });
    }

    test("a group id is kept as is", async () => {
      const res = await h.send(key, { ...TEXT, to: "120363025246125486@g.us" });
      assert.equal(res.status, 202);
      assert.equal(res.json.message.to, "120363025246125486@g.us");
      assert.equal(res.json.message.chatType, "group");
    });

    test("missing, wrong type, empty and the bot's own number", async () => {
      const missing = await h.send(key, { format: "text", text: "x" });
      assert.deepEqual(missing.json.error.fields, { to: { code: "required" } });
      const number = await h.send(key, { ...TEXT, to: 237690000001 });
      assert.deepEqual(number.json.error.fields, { to: { code: "invalid_type" } });
      const empty = await h.send(key, { ...TEXT, to: "" });
      assert.equal(empty.status, 422);
      assert.ok(empty.json.error.fields.to);
      const own = await h.send(key, { ...TEXT, to: h.OWN_NUMBER });
      assert.deepEqual(own.json.error.fields, { to: { code: "not_allowed" } });
    });

    test("format problems come first and alone", async () => {
      const none = await h.send(key, { to: "bad", text: 1 });
      assert.deepEqual(none.json.error.fields, { format: { code: "required" } });
      const wrongType = await h.send(key, { format: 7, to: TO });
      assert.deepEqual(wrongType.json.error.fields, { format: { code: "invalid_type" } });
      const unknown = await h.send(key, { format: "fax", to: TO });
      assert.equal(unknown.json.error.fields.format.code, "not_allowed");
      assert.equal(unknown.json.error.fields.format.params.allowed.length, 13);
      assert.deepEqual(Object.keys(unknown.json.error.fields), ["format"]);
    });
  });

  describe("a text is a text, whatever its first characters (FR-039, US1.7)", () => {
    for (const text of [".ping", ".eval globalThis.__owbPwned = true", "/start", "!help", ".restart"]) {
      test(`delivered verbatim: ${JSON.stringify(text)}`, async () => {
        const before = h.sock.sent.length;
        const res = await h.send(key, { ...TEXT, text });
        assert.equal(res.status, 202);
        await h.tick(2 * SEC);
        assert.equal(h.sock.sent.length, before + 1, "exactly one message left, no reply of a command");
        assert.equal(sentText(before), text);
        assert.equal(globalThis.__owbPwned, undefined, "nothing was executed");
      });
    }
  });

  describe("idempotency (7.4)", () => {
    test("a replay answers 202 with the stored message, Idempotent-Replayed, no second row and no quota", async () => {
      const own = await h.createKey({ name: "idem" });
      const headers = { "Idempotency-Key": "invoice-2026-0042" };
      const first = await h.send(own, TEXT, { headers });
      assert.equal(first.status, 202);
      const second = await h.send(own, TEXT, { headers });
      assert.equal(second.status, 202);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.equal(second.headers.location, first.headers.location);
      assert.equal(second.json.message.id, first.json.message.id);
      assert.equal(first.headers["idempotent-replayed"], undefined);
      assert.equal((await h.rows()).filter((r) => r.apiKeyId === own.id).length, 1);
      assert.equal(second.headers["ratelimit-remaining"], first.headers["ratelimit-remaining"], "a replay consumes no quota");
      // the replay shows the CURRENT state
      await h.tick(2 * SEC);
      const third = await h.send(own, TEXT, { headers });
      assert.equal(third.json.message.status, "sent");
      assert.equal(third.headers["idempotent-replayed"], "true");
    });

    test("the key order is free, an explicitly sent default is a different content", async () => {
      const own = await h.createKey({ name: "idem2" });
      const headers = { "Idempotency-Key": "order-1" };
      const a = await h.send(own, { format: "text", to: TO, text: "same" }, { headers });
      const b = await h.send(own, { text: "same", to: TO, format: "text" }, { headers });
      assert.equal(b.headers["idempotent-replayed"], "true");
      assert.equal(b.json.message.id, a.json.message.id);
      const c = await h.send(own, { format: "text", to: TO, text: "same", linkPreview: false }, { headers });
      assert.equal(c.status, 409);
      assert.equal(c.json.error.code, "idempotency_conflict");
      const d = await h.send(own, { format: "text", to: TO, text: "other" }, { headers });
      assert.equal(d.status, 409);
      assert.equal((await h.rows()).filter((r) => r.apiKeyId === own.id).length, 1);
    });

    test("wait and the Idempotency-Key are not part of the content, and wait applies to a replay", async () => {
      const own = await h.createKey({ name: "idem3" });
      const first = await h.send(own, TEXT, { headers: { "Idempotency-Key": "wait-1" } });
      await fakes.sleep(20);
      const pending = h.request("POST", "/api/v1/messages?wait=30", { key: own, body: TEXT, headers: { "Idempotency-Key": "wait-1" } });
      await fakes.sleep(40);
      await h.tick(2 * SEC);
      const replay = await h.until(pending, { advance: false });
      assert.equal(replay.headers["idempotent-replayed"], "true");
      assert.equal(replay.json.message.id, first.json.message.id);
      assert.equal(replay.json.message.status, "sent");
    });

    test("the scope is the key, and a refused request leaves the Idempotency-Key free", async () => {
      const a = await h.createKey({ name: "idem-a" });
      const b = await h.createKey({ name: "idem-b" });
      const headers = { "Idempotency-Key": "shared" };
      const one = await h.send(a, TEXT, { headers });
      const two = await h.send(b, TEXT, { headers });
      assert.notEqual(one.json.message.id, two.json.message.id);
      assert.equal(two.headers["idempotent-replayed"], undefined);
      const refused = await h.send(a, { format: "text", to: TO }, { headers: { "Idempotency-Key": "fresh" } });
      assert.equal(refused.status, 422);
      const corrected = await h.send(a, TEXT, { headers: { "Idempotency-Key": "fresh" } });
      assert.equal(corrected.status, 202);
      assert.equal(corrected.headers["idempotent-replayed"], undefined);
    });

    test("a malformed Idempotency-Key is a field fault of the header", async () => {
      for (const value of ["has space", "a".repeat(81), "café"]) {
        const res = await h.request("POST", "/api/v1/messages", { key, body: TEXT, headers: { "Idempotency-Key": Buffer.from(value, "utf8").toString("latin1") } });
        assert.equal(res.status, 422, value);
        assert.deepEqual(res.json.error.fields["idempotency-key"], { code: "invalid_format" });
      }
    });

    test("the key is free again 24 hours after the first acceptance", async () => {
      const own = await h.createKey({ name: "idem24" });
      const headers = { "Idempotency-Key": "day-1" };
      const first = await h.send(own, TEXT, { headers });
      await h.clock.advance(24 * 60 * MIN - SEC);
      assert.equal((await h.send(own, TEXT, { headers })).headers["idempotent-replayed"], "true");
      await h.clock.advance(2 * SEC);
      const later = await h.send(own, TEXT, { headers });
      assert.equal(later.status, 202);
      assert.equal(later.headers["idempotent-replayed"], undefined);
      assert.notEqual(later.json.message.id, first.json.message.id);
    });

    test("a replay precedes the quota, so a lost response can be retried at the limit", async () => {
      const own = await h.createKey({ name: "idem-limit", limits: { perMinute: 1 } });
      const headers = { "Idempotency-Key": "limit-1" };
      assert.equal((await h.send(own, TEXT, { headers })).status, 202);
      assert.equal((await h.send(own, { ...TEXT, text: "next" })).status, 429);
      const replay = await h.send(own, TEXT, { headers });
      assert.equal(replay.status, 202);
      assert.equal(replay.headers["idempotent-replayed"], "true");
    });
  });

  describe("limits", () => {
    test("rate_limited carries the scope, the limit, Retry-After and RateLimit-*", async () => {
      const own = await h.createKey({ name: "minute", limits: { perMinute: 2 } });
      assert.equal((await h.send(own, TEXT)).status, 202);
      await h.clock.advance(5 * SEC);
      assert.equal((await h.send(own, TEXT)).status, 202);
      const res = await h.send(own, TEXT);
      assert.equal(res.status, 429);
      assert.equal(res.json.error.code, "rate_limited");
      assert.equal(res.json.error.params.scope, "minute");
      assert.equal(res.json.error.params.limit, 2);
      assert.equal(res.json.error.params.retryAfterMs, 55 * SEC);
      assert.equal(res.headers["retry-after"], "55");
      assert.equal(res.headers["ratelimit-limit"], "2");
      assert.equal(res.headers["ratelimit-remaining"], "0");
      assert.equal(res.headers["ratelimit-reset"], "55");
      await h.clock.advance(56 * SEC);
      assert.equal((await h.send(own, TEXT)).status, 202);
    });

    test("daily_quota_exceeded and pending_limit_reached", async () => {
      const daily = await h.createKey({ name: "daily", limits: { perDay: 2 } });
      assert.equal((await h.send(daily, TEXT)).status, 202);
      assert.equal((await h.send(daily, TEXT)).status, 202);
      const over = await h.send(daily, TEXT);
      assert.equal(over.status, 429);
      assert.equal(over.json.error.code, "daily_quota_exceeded");
      assert.equal(over.json.error.params.limit, 2);
      assert.ok(over.headers["retry-after"]);
      const pending = await h.createKey({ name: "pending", limits: { pending: 1 } });
      h.setConnected(false);
      try {
        assert.equal((await h.send(pending, TEXT)).status, 202);
        const full = await h.send(pending, TEXT);
        assert.equal(full.status, 429);
        assert.equal(full.json.error.code, "pending_limit_reached");
        assert.equal(full.json.error.params.limit, 1);
      } finally {
        h.setConnected(true);
      }
    });

    // The pipeline checks the key's pending override at step 16, but the engine re-runs the admission under its lock with
    // `request.limits`, which the handler cannot fill (ctx never carries the key's limits, RT-133): until the bound
    // `submit` of the pipeline adds `policy` and `limits.maxPending` of the key, the engine falls back to the default.
    test("a key's own pending limit above the default applies inside the engine too", { todo: "needs the pipeline to hand the key's policy and limits to submit (Request to D-HTTP's pipeline.js)" }, async () => {
      const previous = h.config.API_MAX_PENDING;
      h.config.API_MAX_PENDING = 2;
      const wide = await h.createKey({ name: "wide pending", limits: { pending: 5, perMinute: 100 } });
      h.setConnected(false);
      try {
        for (let i = 0; i < 4; i += 1) assert.equal((await h.send(wide, { ...TEXT, text: `wide ${i}` })).status, 202, `message ${i + 1} of 4`);
        assert.equal((await h.send(wide, TEXT)).status, 202);
        const full = await h.send(wide, TEXT);
        assert.equal(full.json.error.code, "pending_limit_reached");
        assert.equal(full.json.error.params.limit, 5);
      } finally {
        h.config.API_MAX_PENDING = previous;
        h.setConnected(true);
      }
    });

    test("a refused request does not count against the quota", async () => {
      const own = await h.createKey({ name: "refused", limits: { perMinute: 2 } });
      for (let i = 0; i < 5; i += 1) assert.equal((await h.send(own, { format: "text", to: TO })).status, 422);
      assert.equal((await h.send(own, TEXT)).status, 202);
      assert.equal((await h.send(own, TEXT)).status, 202);
    });
  });

  test("content: a disabled chat is refused with 409 and queues nothing", async () => {
    h.engine.banned.add(`${TO}@s.whatsapp.net`);
    try {
      const count = await h.db.ApiMessage.count();
      const res = await h.send(key, TEXT);
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "chat_disabled");
      assert.equal(await h.db.ApiMessage.count(), count);
    } finally {
      h.engine.banned.delete(`${TO}@s.whatsapp.net`);
    }
  });

  test("wrong content types, bodies and fields", async () => {
    const wrongType = await h.request("POST", "/api/v1/messages", { key, rawBody: "format=text", contentType: "application/x-www-form-urlencoded" });
    assert.equal(wrongType.status, 415);
    assert.equal(wrongType.json.error.code, "unsupported_media_type");
    const malformed = await h.request("POST", "/api/v1/messages", { key, rawBody: "{not json", contentType: "application/json" });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error.code, "bad_request");
    const array = await h.request("POST", "/api/v1/messages", { key, rawBody: "[1]", contentType: "application/json" });
    assert.equal(array.status, 400);
    const big = await h.request("POST", "/api/v1/messages", { key, rawBody: JSON.stringify({ ...TEXT, text: "x".repeat(70 * 1024) }), contentType: "application/json" });
    assert.equal(big.status, 413);
    assert.equal(big.json.error.code, "payload_too_large");
    assert.deepEqual(big.json.error.params, { maxBytes: 65536 });
    const unknown = await h.send(key, { ...TEXT, idempotencyKey: "x", extra: 1 });
    assert.equal(unknown.status, 422);
    assert.deepEqual(unknown.json.error.fields, { $unknown: { code: "unknown_field" } }, "the name of an unknown property is never echoed");
    assert.equal(unknown.text.includes("extra"), false);
  });

  test("SC-010: accepting a text takes well under a second", async () => {
    const own = await h.createKey({ name: "fast", limits: { perMinute: 1000 } });
    const timings = [];
    for (let i = 0; i < 10; i += 1) {
      const started = process.hrtime.bigint();
      const res = await h.send(own, { ...TEXT, text: `timing ${i}` });
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(res.status, 202);
    }
    timings.sort((a, b) => a - b);
    assert.ok(timings[timings.length - 1] < 1000, `slowest ${timings[timings.length - 1].toFixed(0)} ms`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 2: files and URLs (public-api.md 3.3, 3.4, 8.1)
// ---------------------------------------------------------------------------------------------------------------------
describe("part 2: media by file and by URL", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const config = require("../config");
  const { execFileSync } = require("node:child_process");

  const ffmpeg = (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const tmpDir = () => path.join(h.engine.dataDir, "tmp", "api");
  const leftovers = () => (fs.existsSync(tmpDir()) ? fs.readdirSync(tmpDir()) : []);
  const staged = async () => (await h.engine.stage.list()).map((entry) => entry.name);

  const MESSAGES = {
    image: { format: "image", to: TO, caption: "Your receipt" },
    video: { format: "video", to: TO, caption: "Training" },
    gif: { format: "gif", to: TO, caption: "Done!" },
    audio: { format: "audio", to: TO },
    voice: { format: "voice", to: TO },
    document: { format: "document", to: TO, caption: "Invoice", fileName: "invoice-2026-0042.pdf" },
    sticker: { format: "sticker", to: TO },
  };

  async function fileFor(format) {
    if (format === "gif") return { data: await require("sharp")({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).gif().toBuffer(), name: "a.gif", type: "image/gif" };
    return h.sampleFor(format);
  }

  for (const [format, message] of Object.entries(MESSAGES)) {
    const needsFfmpeg = format === "voice" || format === "gif";
    test(`${format}: a multipart request is accepted, sent from the staged copy, and the staging is emptied`, { skip: needsFfmpeg && !ffmpeg ? "no ffmpeg" : false }, async () => {
      const file = await fileFor(format);
      const res = await h.sendFile(key, message, file, { headers: { "Idempotency-Key": `media-${format}` } });
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.message.format, format);
      assert.equal(res.json.message.size, file.data.length);
      assert.equal(res.json.message.status, "queued");
      assert.deepEqual(leftovers(), [], "the upload is handed over, nothing stays in data/tmp/api");
      assert.deepEqual(await staged(), [res.json.message.id], "one staged copy, named after the public id");
      const before = h.sock.sent.length;
      await h.tick(2 * SEC);
      assert.equal(h.sock.sent.length, before + 1);
      const row = await h.row(res.json.message.id);
      assert.equal(row.status, "sent", `${row.status} ${row.errorCode}`);
      assert.deepEqual(await staged(), [], "the staged file is deleted when the message ends");
      assert.equal(row.payload, null);
      // the content is detected from the bytes: the declared type and the name are free
      assert.equal(res.text.includes(file.name), false);
    });
  }

  test("a document keeps the caller's fileName only as a sanitised label, and the filename of the part as a default", async () => {
    const file = await h.sampleFor("document");
    const named = await h.sendFile(key, { format: "document", to: TO, fileName: "../../etc/passwd.pdf" }, { ...file, name: "ignored.pdf" });
    assert.equal(named.status, 202);
    await h.tick(2 * SEC);
    const sent = h.sock.sent[h.sock.sent.length - 1];
    assert.ok(sent.content.document, "sent as a document");
    assert.doesNotMatch(String(sent.content.fileName), /\.\.|\//);
  });

  test("the sources: exactly one of a file and media.url", async () => {
    const png = await h.sampleFor("image");
    const none = await h.send(key, { format: "image", to: TO });
    assert.equal(none.status, 422);
    assert.deepEqual(none.json.error.fields, { media: { code: "required" } });
    const both = await h.sendFile(key, { format: "image", to: TO, media: { url: "https://files.example.com/a.png" } }, png);
    assert.equal(both.status, 422);
    assert.deepEqual(both.json.error.fields, { media: { code: "not_allowed" } });
    const onText = await h.sendFile(key, TEXT, png);
    assert.equal(onText.status, 422);
    assert.deepEqual(onText.json.error.fields, { file: { code: "not_allowed" } });
    const first = await h.request("POST", "/api/v1/messages", { key, body: { format: "image", to: TO }, files: { file: png }, order: "file-first" });
    assert.equal(first.status, 422);
    assert.deepEqual(first.json.error.fields, { file: { code: "invalid_order" } });
    assert.equal(h.web.calls.length, 0);
    assert.deepEqual(leftovers(), []);
    assert.equal((await h.rows()).filter((r) => r.format === "image" && r.recipient === `${TO}@s.whatsapp.net`).length >= 0, true);
  });

  describe("the content is judged by its bytes", () => {
    test("an executable named .jpg and a fake.pdf are media_type_mismatch, discarded at once", async () => {
      const exe = h.samples.exe();
      const count = await h.db.ApiMessage.count();
      const asImage = await h.sendFile(key, MESSAGES.image, { data: exe, name: "photo.jpg", type: "image/jpeg" });
      assert.equal(asImage.status, 422);
      assert.equal(asImage.json.error.code, "media_type_mismatch");
      assert.deepEqual(asImage.json.error.params, { expected: ["image"] });
      const asDocument = await h.sendFile(key, MESSAGES.document, { data: exe, name: "fake.pdf", type: "application/pdf" });
      assert.equal(asDocument.json.error.code, "media_type_mismatch");
      assert.equal(asDocument.text.toLowerCase().includes("elf"), false, "the detected type is never echoed");
      // a real PNG sent as a document is not a document either
      const wrongKind = await h.sendFile(key, MESSAGES.document, await h.sampleFor("image"));
      assert.equal(wrongKind.json.error.code, "media_type_mismatch");
      const audioAsImage = await h.sendFile(key, MESSAGES.image, await h.sampleFor("audio"));
      assert.equal(audioAsImage.json.error.code, "media_type_mismatch");
      assert.equal(await h.db.ApiMessage.count(), count);
      assert.deepEqual(leftovers(), []);
    });

    test("a corrupt image that passes the signature is accepted, then ends failed / media_conversion_failed", async () => {
      // a real PNG cut after its header chunk: the signature and IHDR are there, the image data is not
      const corrupt = (await h.samples.png()).subarray(0, 41);
      const res = await h.sendFile(key, MESSAGES.sticker, { data: corrupt, name: "s.png", type: "image/png" });
      assert.equal(res.status, 202, "the HTTP status never encodes the message status");
      await h.tick(2 * SEC);
      const seen = await h.get(`/api/v1/messages/${res.json.message.id}`, key);
      assert.equal(seen.json.message.status, "failed");
      assert.deepEqual(seen.json.message.failure, { code: "media_conversion_failed" });
      assert.deepEqual(await staged(), [], "the staged file is deleted when the message ends, whatever the outcome");
    });
  });

  describe("sizes", () => {
    test("the cap is the smaller of the format cap and MAX_UPLOAD, cut while streaming, the partial file deleted", async () => {
      config.MAX_UPLOAD = 1;
      try {
        const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024 * 1024 + 70 * 1024, 1)]);
        const count = await h.db.ApiMessage.count();
        // no Content-Length: the body is cut as soon as the cap plus 64 KiB is read
        const streamed = await h.request("POST", "/api/v1/messages", { key, body: MESSAGES.image, files: { file: { data: big, name: "b.png" } }, chunked: true });
        assert.equal(streamed.status, 413);
        assert.equal(streamed.json.error.code, "media_too_large");
        assert.deepEqual(streamed.json.error.params, { maxBytes: 1024 * 1024 });
        // a declared length above the bound is refused before anything is read, and the connection is closed
        const declared = await h.sendFile(key, MESSAGES.image, { data: big, name: "b.png" });
        assert.equal(declared.status, 413);
        assert.equal(declared.json.error.code, "media_too_large");
        assert.equal(declared.headers.connection, "close");
        assert.equal(await h.db.ApiMessage.count(), count);
        assert.deepEqual(leftovers(), [], "no partial file");
      } finally {
        config.MAX_UPLOAD = undefined;
      }
    });

    test("the JSON part is limited to 64 KiB (payload_too_large)", async () => {
      const png = await h.sampleFor("image");
      const res = await h.sendFile(key, { ...MESSAGES.image, caption: "x".repeat(70 * 1024) }, png);
      assert.equal(res.status, 413);
      assert.equal(res.json.error.code, "payload_too_large");
      assert.deepEqual(leftovers(), []);
    });
  });

  describe("multipart idempotency (the fingerprint includes the file hash)", () => {
    test("the same key and file replays after the upload; another file is a conflict; nothing else is stored", async () => {
      const own = await h.createKey({ name: "multipart idem" });
      const png = await h.sampleFor("image");
      const headers = { "Idempotency-Key": "upload-1" };
      const first = await h.sendFile(own, MESSAGES.image, png, { headers });
      assert.equal(first.status, 202);
      const again = await h.sendFile(own, MESSAGES.image, { ...png, name: "renamed.png", type: "application/octet-stream" }, { headers });
      assert.equal(again.status, 202);
      assert.equal(again.headers["idempotent-replayed"], "true");
      assert.equal(again.json.message.id, first.json.message.id);
      const other = await h.sendFile(own, MESSAGES.image, { data: await h.samples.jpeg(), name: "x.jpg" }, { headers });
      assert.equal(other.status, 409);
      assert.equal(other.json.error.code, "idempotency_conflict");
      const changed = await h.sendFile(own, { ...MESSAGES.image, caption: "other" }, png, { headers });
      assert.equal(changed.status, 409);
      assert.equal((await h.rows()).filter((r) => r.apiKeyId === own.id).length, 1);
      assert.deepEqual(leftovers(), []);
      assert.deepEqual(await staged(), [first.json.message.id]);
    });

    test("a replay of a multipart request found before the upload does not count against the quota", async () => {
      const own = await h.createKey({ name: "multipart idem 2", limits: { perMinute: 1 } });
      const png = await h.sampleFor("image");
      const headers = { "Idempotency-Key": "upload-2" };
      assert.equal((await h.sendFile(own, MESSAGES.image, png, { headers })).status, 202);
      const replay = await h.sendFile(own, MESSAGES.image, png, { headers });
      assert.equal(replay.status, 202);
      assert.equal(replay.headers["idempotent-replayed"], "true");
      const fresh = await h.sendFile(own, MESSAGES.image, png);
      assert.equal(fresh.status, 429);
      assert.deepEqual(leftovers(), []);
    });
  });

  test("an early refusal of a multipart request carries Connection: close and leaves nothing behind", async () => {
    const limited = await h.createKey({ name: "no image", rights: ["messages.read"] });
    const png = await h.sampleFor("image");
    const res = await h.sendFile(limited, MESSAGES.image, png);
    assert.equal(res.status, 403);
    assert.deepEqual(res.json.error.params, { right: "messages.send.image" });
    assert.equal(res.headers.connection, "close");
    const unauthenticated = await h.request("POST", "/api/v1/messages", { body: MESSAGES.image, files: { file: png }, fresh: true });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.connection, "close");
    assert.deepEqual(leftovers(), []);
  });

  describe("media.url (FR-060, FR-061)", () => {
    const URL_BODY = { format: "image", to: TO, media: { url: "https://files.example.com/receipt.png" } };

    test("the file is downloaded during the request through the guarded fetcher, then queued and sent", async () => {
      const png = await h.sampleFor("image");
      h.web.serve(png.data, { "Content-Type": "image/png" });
      const callsBefore = h.web.calls.length;
      const res = await h.send(key, URL_BODY);
      assert.equal(res.status, 202, res.text);
      assert.equal(h.web.calls.length, callsBefore + 1, "one connection");
      const options = h.web.calls[h.web.calls.length - 1];
      assert.equal(options.host, "93.184.216.34", "the connection goes to the address that was checked");
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.Cookie, undefined);
      assert.deepEqual(leftovers(), []);
      await h.tick(2 * SEC);
      assert.equal((await h.row(res.json.message.id)).status, "sent");
      // the URL is nowhere on the server
      const dump = JSON.stringify(await h.dumpTables());
      assert.equal(dump.includes("files.example.com"), false);
      assert.equal(res.text.includes("example.com"), false);
    });

    for (const [name, url, reason] of [
      ["scheme", "http://files.example.com/a.png", "scheme"],
      ["credentials", "https://user:pass@files.example.com/a.png", "credentials"],
      ["port", "https://files.example.com:8443/a.png", "port"],
      ["IP literal", "https://93.184.216.34/a.png", "host"],
      ["decimal IP", "https://2130706433/a.png", "host"],
      ["IPv6 literal", "https://[::1]/a.png", "host"],
      ["localhost", "https://localhost/a.png", "host"],
      ["an .internal name", "https://db.internal/a.png", "host"],
      ["no dot", "https://intranet/a.png", "host"],
    ]) {
      test(`refused before any connection: ${name}`, async () => {
        const calls = h.web.calls.length;
        const count = await h.db.ApiMessage.count();
        const res = await h.send(key, { ...URL_BODY, media: { url } });
        assert.equal(res.status, 422, res.text);
        assert.equal(res.json.error.code, "url_forbidden");
        assert.deepEqual(res.json.error.params, { reason });
        assert.equal(res.text.includes("example.com") || res.text.includes("pass"), false, "the URL is never echoed");
        assert.equal(h.web.calls.length, calls, "no connection was opened");
        assert.equal(await h.db.ApiMessage.count(), count);
      });
    }

    test("one private record refuses the whole name; an unresolvable name is `host`, not url_unreachable", async () => {
      h.web.hosts["mixed.example.com"] = ["93.184.216.34", "10.0.0.5"];
      h.web.hosts["metadata.example.com"] = ["169.254.169.254"];
      const calls = h.web.calls.length;
      for (const host of ["mixed.example.com", "metadata.example.com"]) {
        const res = await h.send(key, { ...URL_BODY, media: { url: `https://${host}/a.png` } });
        assert.equal(res.status, 422);
        assert.deepEqual(res.json.error.params, { reason: "host" });
      }
      assert.equal(h.web.calls.length, calls);
    });

    test("redirects: followed at most three times, each re-validated; a fourth is `redirects`", async () => {
      const png = await h.sampleFor("image");
      const hop = (n) => ({ status: 302, headers: { Location: `https://files.example.com/hop${n}` } });
      h.web.serve((options, index) => (index < 3 ? h.web.reply(hop(index + 1)) : h.web.reply({ body: png.data, headers: { "content-type": "image/png" } })));
      const ok = await h.send(key, URL_BODY);
      assert.equal(ok.status, 202, ok.text);
      h.web.serve(() => h.web.reply(hop(1)));
      const tooMany = await h.send(key, URL_BODY);
      assert.equal(tooMany.status, 422);
      assert.deepEqual(tooMany.json.error.params, { reason: "redirects" });
      h.web.serve(() => h.web.reply({ status: 302, headers: { Location: "http://files.example.com/plain" } }));
      const downgrade = await h.send(key, URL_BODY);
      assert.deepEqual(downgrade.json.error.params, { reason: "scheme" });
      await h.drain();
    });

    test("a remote failure is 502 url_unreachable; a 404, a reset and a wrong content are refused", async () => {
      h.web.serve(() => h.web.reply({ status: 404 }));
      const missing = await h.send(key, URL_BODY);
      assert.equal(missing.status, 502);
      assert.equal(missing.json.error.code, "url_unreachable");
      h.web.serve(() => ({ error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
      const reset = await h.send(key, URL_BODY);
      assert.equal(reset.status, 502);
      h.web.serve(h.samples.exe(), { "Content-Type": "image/png" });
      const wrong = await h.send(key, URL_BODY);
      assert.equal(wrong.status, 422);
      assert.equal(wrong.json.error.code, "media_type_mismatch");
      assert.deepEqual(leftovers(), [], "the downloaded temp file is removed on every refusal");
    });

    test("the download is capped like an upload, whatever Content-Length says", async () => {
      config.MAX_UPLOAD = 1;
      try {
        const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024 * 1024 + 10, 1)]);
        h.web.serve(big, { "Content-Type": "image/png", "Content-Length": "100" });
        const res = await h.send(key, URL_BODY);
        assert.equal(res.status, 413);
        assert.equal(res.json.error.code, "media_too_large");
        assert.deepEqual(leftovers(), []);
      } finally {
        config.MAX_UPLOAD = undefined;
      }
    });

    test("an idempotent replay of a media.url request fetches nothing", async () => {
      const own = await h.createKey({ name: "url idem" });
      const png = await h.sampleFor("image");
      h.web.serve(png.data, { "Content-Type": "image/png" });
      const headers = { "Idempotency-Key": "url-1" };
      const first = await h.send(own, URL_BODY, { headers });
      assert.equal(first.status, 202);
      const calls = h.web.calls.length;
      const replay = await h.send(own, URL_BODY, { headers });
      assert.equal(replay.headers["idempotent-replayed"], "true");
      assert.equal(h.web.calls.length, calls, "the URL string counts, the bytes are not fetched again");
      const conflict = await h.send(own, { ...URL_BODY, media: { url: "https://files.example.com/other.png" } }, { headers });
      assert.equal(conflict.status, 409);
      assert.equal(h.web.calls.length, calls);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 3: PUB-2 GET /api/v1/messages/:id and PUB-3 GET /api/v1/messages (public-api.md 2.2, 2.3, 4)
// ---------------------------------------------------------------------------------------------------------------------
describe("part 3: reading messages", () => {
  const { CODE_STATUS, STATUSES } = require("../lib/messaging/errors");
  const GOOD_ID = `msg_${"Z".repeat(22)}`;

  const answer = (res) => JSON.stringify({ status: res.status, body: res.text.replace(/"requestId":"[0-9a-f]{16}"/g, '"requestId":"X"'), headers: { ct: res.headers["content-type"], cc: res.headers["cache-control"] } });

  /** a queued row that a status machine step turned into `status` (the columns each status carries) */
  async function force(id, patch) {
    await h.db.ApiMessage.update({ ...patch }, { where: { publicId: id } });
    return h.get(`/api/v1/messages/${id}`, key);
  }
  const queue = async (over = {}, body = TEXT) => (await h.send(over.key || key, body)).json.message;

  describe("PUB-2", () => {
    test("another key's message, a panel message, a purged one, an unknown id and a malformed id are the same 404", async () => {
      const other = await h.createKey({ name: "other reader" });
      const theirs = await h.send(other, TEXT);
      const panel = await h.messaging.submit(h.engine.request({ source: "panel", apiKeyId: null, fields: { text: "from the panel" } }));
      const mine = await queue();
      await h.db.ApiMessage.destroy({ where: { publicId: mine.id } });
      const answers = new Set();
      for (const id of [theirs.json.message.id, panel.message.publicId, mine.id, GOOD_ID, "msg_short", "nonsense", `msg_${"Z".repeat(23)}`, `${GOOD_ID}/`]) {
        const res = await h.get(`/api/v1/messages/${id}`, key);
        assert.equal(res.status, 404, id);
        assert.equal(res.json.error.code, "not_found");
        answers.add(answer(res));
      }
      assert.equal(answers.size, 1, "indistinguishable");
    });

    test("the resource of a queued message carries every step, no content and responses null", async () => {
      const made = await queue();
      const res = await h.get(`/api/v1/messages/${made.id}`, key);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json), ["message"]);
      assert.deepEqual(res.json.message, made);
      assert.equal(res.headers["idempotent-replayed"], undefined);
      assert.equal(res.headers.location, undefined);
    });

    test("every status: steps, endedAt and failure", async () => {
      const t = (offset) => new Date(h.now() + offset);
      const made = await queue();
      const base = { acceptedAt: new Date(h.now()) };
      const step = async (patch, check) => {
        const res = await force(made.id, patch);
        assert.equal(res.status, 200);
        check(res.json.message);
      };
      await step({}, (m) => {
        assert.equal(m.status, "queued");
        assert.equal(m.endedAt, null);
      });
      await step({ status: "sending", sendingAt: t(1000) }, (m) => {
        assert.equal(m.status, "sending");
        assert.equal(m.steps.sending, t(1000).toISOString());
        assert.equal(m.steps.sent, null);
      });
      await step({ status: "sent", sentAt: t(2000), waId: "3EB0AAAAAAAAAAAAAAAAAA" }, (m) => {
        assert.equal(m.status, "sent");
        assert.equal(m.steps.sent, t(2000).toISOString());
        assert.equal(m.failure, null);
        assert.equal(m.endedAt, null);
      });
      await step({ status: "delivered", deliveredAt: t(3000) }, (m) => assert.equal(m.steps.delivered, t(3000).toISOString()));
      await step({ status: "read", readAt: t(4000) }, (m) => {
        assert.equal(m.status, "read");
        assert.equal(m.steps.read, t(4000).toISOString());
        assert.deepEqual(Object.keys(m.steps), ["queued", "sending", "sent", "delivered", "read"]);
      });
      assert.ok(base.acceptedAt);
    });

    test("expired has no failure code; failed, cancelled and unknown carry one of the 14 codes", async () => {
      const expired = await queue();
      let res = await force(expired.id, { status: "expired", endedAt: new Date(h.now() + 600000), errorCode: null, payload: null });
      assert.equal(res.json.message.status, "expired");
      assert.equal(res.json.message.failure, null);
      assert.equal(res.json.message.endedAt, new Date(h.now() + 600000).toISOString());
      for (const [code, status] of Object.entries(CODE_STATUS)) {
        const made = await queue();
        res = await force(made.id, { status, errorCode: code, endedAt: new Date(h.now() + 1000), payload: null });
        assert.equal(res.json.message.status, status, code);
        assert.deepEqual(res.json.message.failure, { code }, code);
        assert.ok(res.json.message.endedAt, code);
      }
      assert.equal(Object.keys(CODE_STATUS).length, 14);
    });

    test("an unknown message upgraded by a receipt has no endedAt and no failure again", async () => {
      const made = await queue();
      let res = await force(made.id, { status: "unknown", errorCode: "timeout", endedAt: new Date(h.now()), payload: null });
      assert.equal(res.json.message.status, "unknown");
      res = await force(made.id, { status: "delivered", errorCode: null, endedAt: null, deliveredAt: new Date(h.now() + 5000) });
      assert.equal(res.json.message.status, "delivered");
      assert.equal(res.json.message.endedAt, null);
      assert.equal(res.json.message.failure, null);
    });

    test("size: the bytes of the main text, of the media, or null", async () => {
      const text = await queue({}, { ...TEXT, text: "café \u{1F600}" });
      assert.equal(text.size, Buffer.byteLength("café \u{1F600}", "utf8"));
      const location = await queue({}, { format: "location", to: TO, latitude: 1, longitude: 2 });
      assert.equal(location.size, null);
      const contact = await queue({}, { format: "contact", to: TO, contacts: [{ name: "A", phones: ["237690000002"] }] });
      assert.equal(contact.size, null);
      const poll = await queue({}, { format: "poll", to: TO, question: "Why?", options: ["a", "b"] });
      assert.equal(poll.size, 4);
      const buttons = await queue({}, { format: "buttons", to: TO, text: "Sure?", buttons: [{ id: "y", label: "Y" }] });
      assert.equal(buttons.size, 5);
      const file = await h.sampleFor("document");
      const document = (await h.sendFile(key, { format: "document", to: TO }, file)).json.message;
      assert.equal(document.size, file.data.length);
    });

    test("no wait here (it lives on PUB-1): a query parameter on PUB-2 is an unknown field", async () => {
      const made = await queue();
      const res = await h.get(`/api/v1/messages/${made.id}?wait=5`, key);
      assert.equal(res.status, 422);
      assert.deepEqual(res.json.error.fields, { $unknown: { code: "unknown_field" } });
    });

    test("the right messages.read is required (and checked before the lookup)", async () => {
      const made = await queue();
      const writer = await h.createKey({ name: "writer only", rights: ["messages.send.text"] });
      const res = await h.get(`/api/v1/messages/${made.id}`, writer);
      assert.equal(res.status, 403);
      assert.deepEqual(res.json.error.params, { right: "messages.read" });
      const unknown = await h.get(`/api/v1/messages/${GOOD_ID}`, writer);
      assert.equal(unknown.status, 403, "a missing right is shown whether or not the message exists");
    });
  });

  describe("PUB-3", () => {
    let reader;
    let ids;
    // seven messages, one per minute, kept queued by a disconnection: text, location, text, text, location, text, text
    beforeEach(async () => {
      h.setConnected(false);
      reader = await h.createKey({ name: `reader ${Math.random().toString(16).slice(2, 8)}`, limits: { perMinute: 1000 } });
      ids = [];
      for (let i = 0; i < 7; i += 1) {
        const body = i % 3 === 1 ? { format: "location", to: TO, latitude: 1, longitude: 2 } : { ...TEXT, text: `m${i}` };
        const res = await h.send(reader, body);
        assert.equal(res.status, 202);
        ids.push(res.json.message.id);
        await h.clock.advance(MIN);
      }
    });
    afterEach(() => {
      h.setConnected(true);
    });
    const list = (query, who = () => reader) => h.get(`/api/v1/messages${query}`, who());

    test("newest first, 25 by default, next null when everything fits", async () => {
      const res = await list("");
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json), ["messages", "next"]);
      assert.deepEqual(res.json.messages.map((m) => m.id), [...ids].reverse());
      assert.equal(res.json.next, null);
      for (const message of res.json.messages) assert.equal(Object.hasOwn(message, "responses"), false, "items never carry responses");
    });

    test("keyset pagination: next is the last id when more exist, pages are stable under inserts", async () => {
      const first = await list("?limit=3");
      assert.deepEqual(first.json.messages.map((m) => m.id), [ids[6], ids[5], ids[4]]);
      assert.equal(first.json.next, ids[4]);
      for (let i = 0; i < 2; i += 1) assert.equal((await h.send(reader, { ...TEXT, text: `late ${i}` })).status, 202);
      const second = await list(`?limit=3&after=${first.json.next}`);
      assert.deepEqual(second.json.messages.map((m) => m.id), [ids[3], ids[2], ids[1]], "the new messages did not shift the page");
      assert.equal(second.json.next, ids[1]);
      const third = await list(`?limit=3&after=${second.json.next}`);
      assert.deepEqual(third.json.messages.map((m) => m.id), [ids[0]]);
      assert.equal(third.json.next, null);
      const everything = await list("?limit=100&since=1970-01-01T00:00:00Z&until=2999-01-01T00:00:00Z");
      assert.equal(everything.json.messages.length, 7 + 2);
      assert.equal(everything.json.next, null);
    });

    test("an after that is not a message of this key is the same not_found: unknown, purged, other key, malformed", async () => {
      const other = await h.createKey({ name: "someone else" });
      const theirs = (await h.send(other, TEXT)).json.message.id;
      await h.db.ApiMessage.destroy({ where: { publicId: ids[0] } });
      const answers = new Set();
      for (const after of [GOOD_ID, ids[0], theirs, "nonsense"]) {
        const res = await list(`?after=${after}`);
        assert.equal(res.status, 422, after);
        assert.deepEqual(res.json.error.fields, { after: { code: "not_found" } });
        answers.add(answer(res));
      }
      assert.equal(answers.size, 1);
    });

    test("filters: status, format, since (inclusive), until (exclusive)", async () => {
      await h.db.ApiMessage.update({ status: "failed", errorCode: "send_failed", endedAt: new Date(h.now()), payload: null }, { where: { publicId: ids[2] } });
      const failed = await list("?status=failed");
      assert.deepEqual(failed.json.messages.map((m) => m.id), [ids[2]]);
      const queued = await list("?status=queued");
      assert.equal(queued.json.messages.length, 6);
      const locations = await list("?format=location");
      assert.deepEqual(locations.json.messages.map((m) => m.id), [ids[4], ids[1]]);
      const queuedAt = (id) => failed.json.messages.length && locations.json.messages.concat(queued.json.messages).find((m) => m.id === id).steps.queued;
      const t3 = queuedAt(ids[3]);
      const t5 = queuedAt(ids[5]);
      const window = await list(`?since=${encodeURIComponent(t3)}&until=${encodeURIComponent(t5)}`);
      assert.deepEqual(window.json.messages.map((m) => m.id), [ids[4], ids[3]], "since is inclusive, until exclusive");
      const offset = await list(`?since=${encodeURIComponent(t3.replace("Z", "+00:00"))}&until=${encodeURIComponent(t5)}`);
      assert.deepEqual(offset.json.messages.map((m) => m.id), [ids[4], ids[3]]);
      const combined = await list("?status=queued&format=location&limit=1");
      assert.deepEqual(combined.json.messages.map((m) => m.id), [ids[4]]);
      assert.equal(combined.json.next, ids[4]);
    });

    test("field faults: until <= since, a bad status, format, timestamp or limit, an unknown or repeated parameter", async () => {
      const stamp = "2026-03-10T08:00:00.000Z";
      const same = await list(`?since=${stamp}&until=${stamp}`);
      assert.deepEqual(same.json.error.fields, { until: { code: "out_of_range" } });
      const before = await list(`?since=${stamp}&until=2026-03-09T08:00:00Z`);
      assert.deepEqual(before.json.error.fields, { until: { code: "out_of_range" } });
      const status = await list("?status=done");
      assert.equal(status.json.error.fields.status.code, "not_allowed");
      assert.deepEqual(status.json.error.fields.status.params.allowed, [...STATUSES]);
      const format = await list("?format=fax");
      assert.equal(format.json.error.fields.format.code, "not_allowed");
      assert.equal(format.json.error.fields.format.params.allowed.length, 13);
      for (const bad of ["yesterday", "2026-03-10", "2026-03-10T08:00:00", "2026-02-31T08:00:00Z", "2026-03-10 08:00:00Z"]) {
        const res = await list(`?since=${encodeURIComponent(bad)}`);
        assert.deepEqual(res.json.error.fields, { since: { code: "invalid_format" } }, bad);
      }
      assert.deepEqual((await list("?limit=0")).json.error.fields.limit, { code: "out_of_range", params: { min: 1, max: 100 } });
      assert.deepEqual((await list("?limit=101")).json.error.fields.limit, { code: "out_of_range", params: { min: 1, max: 100 } });
      assert.deepEqual((await list("?limit=abc")).json.error.fields.limit, { code: "invalid_format" });
      assert.deepEqual((await list("?limit=-1")).json.error.fields.limit, { code: "invalid_format" });
      assert.deepEqual((await list("?bogus=1")).json.error.fields, { $unknown: { code: "unknown_field" } });
      const repeated = await list("?limit=2&limit=50&status=queued&status=failed");
      assert.equal(repeated.status, 200);
      assert.equal(repeated.json.messages.length, 2, "a repeated parameter keeps its first value");
    });

    test("only the messages of the calling key, never the panel's", async () => {
      await h.messaging.submit(h.engine.request({ source: "panel", apiKeyId: null, fields: { text: "panel" } }));
      const other = await h.createKey({ name: "list other" });
      await h.send(other, TEXT);
      const mine = await list("?limit=100");
      assert.equal(mine.json.messages.length, 7);
      const theirs = await h.get("/api/v1/messages?limit=100", other);
      assert.equal(theirs.json.messages.length, 1);
      const nobody = await h.createKey({ name: "list nobody" });
      assert.deepEqual((await h.get("/api/v1/messages", nobody)).json, { messages: [], next: null });
    });

    test("the right messages.read is required", async () => {
      const writer = await h.createKey({ name: "list writer", rights: ["messages.send.text"] });
      const res = await h.get("/api/v1/messages", writer);
      assert.equal(res.status, 403);
      assert.deepEqual(res.json.error.params, { right: "messages.read" });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 4: location, contact and poll over HTTP, and the responses of a poll (public-api.md 3.5-3.7, 4.4)
// ---------------------------------------------------------------------------------------------------------------------
describe("part 4: location, contact, poll", () => {
  const { IDS } = fakes;
  const DAY = 24 * 60 * MIN;
  const EXAMPLES = {
    location: { format: "location", to: TO, latitude: 4.0511, longitude: 9.7679, name: "Pickup point", address: "Rue de la Joie, Douala" },
    contact: { format: "contact", to: TO, contacts: [{ name: "Acme Support", phones: ["+237 690 00 00 02"], organization: "Acme", email: "support@acme.example" }] },
    poll: { format: "poll", to: TO, question: "Which day for training?", options: ["Tuesday", "Thursday", "Saturday"], multiple: false },
  };

  for (const [format, body] of Object.entries(EXAMPLES)) {
    test(`${format}: the example of the contract is accepted and sent`, async () => {
      const res = await h.send(key, body);
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.message.format, format);
      const before = h.sock.sent.length;
      await h.tick(2 * SEC);
      assert.equal((await h.row(res.json.message.id)).status, "sent");
      assert.equal(h.sock.sent.length, before + 1);
    });
  }

  test("refused field by field, with nothing queued (US5.5)", async () => {
    const count = await h.db.ApiMessage.count();
    const lat = await h.send(key, { ...EXAMPLES.location, latitude: 91 });
    assert.deepEqual(lat.json.error.fields, { latitude: { code: "out_of_range", params: { min: -90, max: 90 } } });
    const one = await h.send(key, { ...EXAMPLES.poll, options: ["only one"] });
    assert.deepEqual(one.json.error.fields, { options: { code: "too_short", params: { min: 2 } } });
    const twice = await h.send(key, { ...EXAMPLES.poll, options: ["a", "b", "a"] });
    assert.deepEqual(twice.json.error.fields, { "options.2": { code: "duplicate" } });
    const phones = await h.send(key, { ...EXAMPLES.contact, contacts: [{ name: "A", phones: ["abc"] }] });
    assert.deepEqual(phones.json.error.fields, { "contacts.0.phones.0": { code: "invalid_format" } });
    assert.equal(await h.db.ApiMessage.count(), count);
  });

  describe("the responses of a poll", () => {
    const POLL = { format: "poll", to: TO, question: "Which day for training?", options: ["Tuesday", "Thursday", "Saturday"], multiple: true };
    let id;
    beforeEach(async () => {
      const res = await h.send(key, POLL);
      id = res.json.message.id;
    });

    test("a poll still in the queue shows the window not opened yet and no item", async () => {
      const res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.responses.until, null);
      assert.equal(res.json.message.responses.total, 0);
      assert.deepEqual(res.json.message.responses.items, []);
      // the options become the totals once the message is built for sending (the engine keeps them from then on)
      await h.tick(2 * SEC);
      const sent = await h.get(`/api/v1/messages/${id}`, key);
      assert.deepEqual(sent.json.message.responses.totals, [{ id: "0", label: "Tuesday", count: 0 }, { id: "1", label: "Thursday", count: 0 }, { id: "2", label: "Saturday", count: 0 }]);
      assert.ok(sent.json.message.responses.until);
    });

    test("PUB-1 already carries the responses object of an interactive format, and null for the others", async () => {
      const created = await h.send(key, POLL);
      assert.equal(created.json.message.responses.total, 0);
      assert.deepEqual(created.json.message.responses.items, []);
      assert.equal(created.json.message.responses.until, null);
      assert.equal((await h.send(key, TEXT)).json.message.responses, null);
    });

    test("until, total, items (one per voter, the latest vote), a cleared vote and totals with zero counts", async () => {
      await h.tick(2 * SEC);
      const sentAt = (await h.row(id)).sentAt.getTime();
      const at = (ms) => new Date(h.now() + ms);
      assert.equal(await h.recordReply(id, { kind: "vote", author: "237690000001@s.whatsapp.net", choiceIds: ["1"], at: at(10 * SEC) }), true);
      let res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.status, "sent");
      assert.equal(res.json.message.responses.until, new Date(sentAt + 7 * DAY).toISOString());
      assert.deepEqual(res.json.message.responses.items, [{ at: at(10 * SEC).toISOString(), author: "237690000001", kind: "vote", via: null, choices: [{ id: "1", label: "Thursday" }] }]);
      assert.deepEqual(res.json.message.responses.totals, [{ id: "0", label: "Tuesday", count: 0 }, { id: "1", label: "Thursday", count: 1 }, { id: "2", label: "Saturday", count: 0 }]);

      // the same person votes again: the latest vote replaces the earlier one
      await h.recordReply(id, { kind: "vote", author: "237690000001@s.whatsapp.net", choiceIds: ["0", "2"], at: at(20 * SEC) });
      res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.responses.total, 1);
      assert.deepEqual(res.json.message.responses.items[0].choices.map((c) => c.id), ["0", "2"]);
      assert.deepEqual(res.json.message.responses.totals.map((t) => t.count), [1, 0, 1]);

      // a stale vote (older than the recorded one) is ignored
      assert.equal(await h.recordReply(id, { kind: "vote", author: "237690000001@s.whatsapp.net", choiceIds: ["1"], at: at(5 * SEC) }), false);

      // a vote cleared stays as an item with no choice
      await h.recordReply(id, { kind: "vote", author: "237690000001@s.whatsapp.net", choiceIds: [], at: at(30 * SEC) });
      res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.responses.total, 1);
      assert.deepEqual(res.json.message.responses.items[0].choices, []);
      assert.deepEqual(res.json.message.responses.totals.map((t) => t.count), [0, 0, 0], "zero counts are included");
    });

    test("in a group: one item per voter, oldest first, a privacy identifier shown as <number>@lid", async () => {
      const group = await h.send(key, { ...POLL, to: IDS.GROUP });
      assert.equal(group.status, 202, group.text);
      await h.drain();
      const groupId = group.json.message.id;
      assert.equal(group.json.message.chatType, "group");
      assert.equal((await h.row(groupId)).status, "sent", "a poll of a group stops at sent");
      const at = (ms) => new Date(h.now() + ms);
      await h.recordReply(groupId, { kind: "vote", author: "237690000003@s.whatsapp.net", choiceIds: ["0", "2"], at: at(2000) });
      await h.recordReply(groupId, { kind: "vote", author: "237690000002@s.whatsapp.net", choiceIds: ["1"], at: at(1000) });
      await h.recordReply(groupId, { kind: "vote", author: "55555555@lid", choiceIds: ["1"], at: at(3000) });
      const res = await h.get(`/api/v1/messages/${groupId}`, key);
      const items = res.json.message.responses.items;
      assert.deepEqual(items.map((i) => i.author), ["237690000002", "237690000003", "55555555@lid"]);
      assert.deepEqual(items.map((i) => i.kind), ["vote", "vote", "vote"]);
      assert.equal(res.json.message.responses.total, 3);
      assert.deepEqual(res.json.message.responses.totals.map((t) => t.count), [1, 2, 1]);
      assert.equal(res.json.message.steps.delivered, null);
      assert.equal(res.json.message.steps.read, null);
    });

    test("a private chat records the recipient whatever form WhatsApp reports; an unknown option is dropped", async () => {
      await h.tick(2 * SEC);
      await h.recordReply(id, { kind: "vote", author: "999@lid", choiceIds: ["1", "9"] });
      const res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.responses.items[0].author, TO);
      assert.deepEqual(res.json.message.responses.items[0].choices, [{ id: "1", label: "Thursday" }]);
    });

    test("nothing is recorded after the window; the resource stays readable", async () => {
      await h.tick(2 * SEC);
      assert.equal(await h.recordReply(id, { kind: "vote", author: "237690000001@s.whatsapp.net", choiceIds: ["0"] }), true);
      // the window ended: `repliesUntil` (sent + API_REPLY_WINDOW_DAYS) is behind the clock
      await h.db.ApiMessage.update({ repliesUntil: new Date(h.now() - 1000) }, { where: { publicId: id } });
      assert.equal(await h.recordReply(id, { kind: "vote", author: "237690000002@s.whatsapp.net", choiceIds: ["0"] }), false);
      const res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.responses.total, 1);
    });

    test("a poll listed by PUB-3 carries no responses", async () => {
      const res = await h.get("/api/v1/messages?format=poll", key);
      assert.ok(res.json.messages.length >= 1);
      for (const message of res.json.messages) assert.equal(Object.hasOwn(message, "responses"), false);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 5: buttons and list over HTTP (public-api.md 3.8, 3.9, 4.4)
// ---------------------------------------------------------------------------------------------------------------------
describe("part 5: buttons and list", () => {
  const { IDS } = fakes;
  const DAY = 24 * 60 * MIN;
  const BUTTONS = { format: "buttons", to: TO, text: "Do you confirm your appointment tomorrow at 10:00?", buttons: [{ id: "confirm", label: "Yes" }, { id: "cancel", label: "No" }] };
  const LIST = {
    format: "list",
    to: TO,
    text: "Choose a delivery slot",
    buttonLabel: "See slots",
    choices: [{ id: "slot-am", title: "Morning", description: "8:00 - 12:00" }, { id: "slot-pm", title: "Afternoon", description: "14:00 - 18:00" }],
  };

  test("the examples are accepted, the buttons go out numbered (text fallback) and the message is sent", async () => {
    const before = h.sock.sent.length;
    const buttons = await h.send(key, BUTTONS);
    const list = await h.send(key, LIST);
    assert.equal(buttons.status, 202, buttons.text);
    assert.equal(list.status, 202, list.text);
    await h.tick(2 * SEC);
    await h.tick(2200);
    assert.equal(h.sock.sent.length >= before + 2 || (await h.row(list.json.message.id)).status === "sent", true);
    assert.equal((await h.row(buttons.json.message.id)).status, "sent");
    assert.equal((await h.row(list.json.message.id)).status, "sent");
  });

  test("refused field by field, with nothing queued", async () => {
    const count = await h.db.ApiMessage.count();
    const four = await h.send(key, { ...BUTTONS, buttons: ["a", "b", "c", "d"].map((id) => ({ id, label: id })) });
    assert.deepEqual(four.json.error.fields, { buttons: { code: "too_many_items", params: { max: 3 } } });
    const dup = await h.send(key, { ...BUTTONS, buttons: [{ id: "a", label: "A" }, { id: "a", label: "B" }] });
    assert.deepEqual(dup.json.error.fields, { "buttons.1.id": { code: "duplicate" } });
    const long = await h.send(key, { ...BUTTONS, text: "x".repeat(4097) });
    assert.deepEqual(long.json.error.fields, { text: { code: "too_long", params: { max: 1024 } } });
    const rows = await h.send(key, { ...LIST, choices: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, title: `C${i}` })) });
    assert.deepEqual(rows.json.error.fields, { choices: { code: "too_many_items", params: { max: 10 } } });
    assert.equal(await h.db.ApiMessage.count(), count);
  });

  describe("responses", () => {
    async function sendOne(body) {
      const res = await h.send(key, body);
      await h.tick(2 * SEC);
      return res.json.message.id;
    }
    const at = (ms) => new Date(h.now() + ms);

    test("a tap and a numbered answer: via, the caller's id with the label kept, one item per reply", async () => {
      const id = await sendOne(BUTTONS);
      await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["confirm"], via: "tap", at: at(1000) });
      await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["cancel"], via: "number", at: at(2000), sourceId: "src-2" });
      const res = await h.get(`/api/v1/messages/${id}`, key);
      const responses = res.json.message.responses;
      assert.equal(responses.total, 2);
      assert.equal(responses.totals, null, "buttons have no totals");
      assert.deepEqual(responses.items, [
        { at: at(1000).toISOString(), author: TO, kind: "choice", via: "tap", choices: [{ id: "confirm", label: "Yes" }] },
        { at: at(2000).toISOString(), author: TO, kind: "choice", via: "number", choices: [{ id: "cancel", label: "No" }] },
      ]);
      assert.ok(responses.until);
    });

    test("the same person answering twice gives two items; a list shows the row title", async () => {
      const id = await sendOne(LIST);
      await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["slot-am"], via: "tap", at: at(1000) });
      await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["slot-am"], via: "tap", at: at(2000) });
      await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["slot-pm"], via: "number", at: at(3000) });
      const res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.responses.total, 3);
      assert.deepEqual(res.json.message.responses.items.map((i) => i.choices[0].label), ["Morning", "Morning", "Afternoon"]);
      assert.equal(res.json.message.responses.totals, null);
    });

    test("an answer with an unknown id is not recorded", async () => {
      const id = await sendOne(BUTTONS);
      assert.equal(await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["nope"], via: "tap" }), false);
      assert.equal((await h.get(`/api/v1/messages/${id}`, key)).json.message.responses.total, 0);
    });

    test("nothing is recorded after the window", async () => {
      const id = await sendOne(BUTTONS);
      assert.equal(await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["confirm"], via: "tap" }), true);
      await h.db.ApiMessage.update({ repliesUntil: new Date(h.now() - 1000) }, { where: { publicId: id } });
      assert.equal(await h.recordReply(id, { kind: "choice", author: "237690000001@s.whatsapp.net", choiceIds: ["cancel"], via: "tap" }), false);
      assert.equal((await h.get(`/api/v1/messages/${id}`, key)).json.message.responses.total, 1);
    });

    test("in a group the author is the participant, and the message stops at sent (no delivered, no read)", async () => {
      const id = await sendOne({ ...BUTTONS, to: IDS.GROUP });
      await h.recordReply(id, { kind: "choice", author: "237690000007@s.whatsapp.net", choiceIds: ["confirm"], via: "number", at: at(1000) });
      await h.recordReply(id, { kind: "choice", author: "237690000008@s.whatsapp.net", choiceIds: ["cancel"], via: "tap", at: at(2000) });
      const res = await h.get(`/api/v1/messages/${id}`, key);
      assert.equal(res.json.message.chatType, "group");
      assert.equal(res.json.message.status, "sent");
      assert.deepEqual(res.json.message.responses.items.map((i) => i.author), ["237690000007", "237690000008"]);
      assert.equal(res.json.message.steps.delivered, null);
    });
  });
});
