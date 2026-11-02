"use strict";
/**
 * The accept path of the messaging engine (feature 004, contracts/runtime.md 4.2, 4.5, 1 and RT-10 to RT-14, RT-40
 * to RT-43). Part 1: the nine steps in order, the INSERT of T1, the quote rule, the lost-race replay, the admission
 * table and its atomicity. Part 2: media (inspect, fetch, stage adoption, RT-42, disk admission). Part 3: `get`/`list`.
 *
 * Real facade over the in-memory database with a fake clock, a fake socket and a fake switch (test/helpers/
 * messagingKit.js). `assertMessageInvariants` runs after every scenario.
 */

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createEngineKit } = require("./helpers/messagingKit");
const { MessagingError } = require("../lib/messaging/errors");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const PN = "237690000001@s.whatsapp.net";
const PN2 = "237690000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

let kit;
let key;

beforeEach(async () => {
  kit = await createEngineKit();
  key = await kit.key();
});

afterEach(async () => {
  await kit.check();
  await kit.close();
});

/** Rejects with a MessagingError of that code; `check(err)` inspects it */
async function refuses(promise, code, check) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof MessagingError, `a MessagingError, not ${err && err.stack}`);
    assert.equal(err.code, code);
    if (check) check(err);
    return true;
  });
}

const count = () => kit.db.ApiMessage.count();

/** Rows that wait in the queue without going through submit (a busy queue) */
async function fillQueue(n, over = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      publicId: `msg_${`${over.salt || ""}${i}`.padStart(22, "F")}`,
      apiKeyId: over.apiKeyId !== undefined ? over.apiKeyId : key.id,
      source: over.apiKeyId === null ? "panel" : "api",
      recipient: PN,
      format: "text",
      status: "queued",
      acceptedAt: new Date(kit.now()),
      expiresAt: new Date(kit.now() + 10 * MIN),
      payload: { v: 1, input: { text: "x" }, media: null, quote: null },
      ...over.row,
    });
  }
  await kit.db.ApiMessage.bulkCreate(rows);
}

// ---------------------------------------------------------------------------------------------------------------------
describe("submit: the steps in order, the first failure answers and nothing is written (4.2, FR-032)", () => {
  test("a message is accepted: queued, the view carries the public fields only", async () => {
    const { message, replayed, requestHash } = await kit.send({ requestId: "0123456789abcdef" });
    assert.equal(replayed, false);
    assert.equal(requestHash, null);
    assert.match(message.publicId, /^msg_[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(
      { status: message.status, format: message.format, recipient: message.recipient, chatType: message.chatType, source: message.source, apiKeyId: message.apiKeyId },
      { status: "queued", format: "text", recipient: PN, chatType: "private", source: "api", apiKeyId: key.id },
    );
    assert.equal(message.requestId, "0123456789abcdef");
    assert.equal(message.interactive, false);
    assert.equal(message.waId, null);
    assert.ok(message.acceptedAt instanceof Date && message.expiresAt instanceof Date);
    assert.equal(message.expiresAt.getTime() - message.acceptedAt.getTime(), 10 * MIN);
    for (const forbidden of ["payload", "pollSecret", "replyData", "mediaPath", "requestHash", "idempotencyKey"]) {
      assert.ok(!(forbidden in message), `${forbidden} is never part of the view`);
    }
    assert.equal(await count(), 1);
  });

  test("the switch off: api_disabled / switch_off, nothing written (RT-13)", async () => {
    kit.setEnabled(false);
    await refuses(kit.send(), "api_disabled", (err) => assert.deepEqual(err.params, { reason: "switch_off" }));
    assert.equal(await count(), 0);
  });

  test("an unknown format: validation_failed with fields.format not_allowed", async () => {
    await refuses(kit.send({ format: "carrier_pigeon", fields: {} }), "validation_failed", (err) => {
      assert.equal(err.fields.format.code, "not_allowed");
    });
    assert.equal(await count(), 0);
  });

  test("schema faults come before the policy: all faults at once, dotted paths", async () => {
    await refuses(
      kit.send({ fields: { text: "" }, policy: { mode: "list", entries: [PN2] } }),
      "validation_failed",
      (err) => assert.equal(err.fields.text.code, "too_short"),
    );
    await refuses(kit.send({ fields: {} }), "validation_failed", (err) => assert.equal(err.fields.text.code, "required"));
    await refuses(
      kit.send({ fields: { text: "hi", mentions: ["237690000002"] } }),
      "validation_failed",
      (err) => assert.equal(err.fields.mentions.code, "not_allowed"),
    );
    assert.equal(await count(), 0);
  });

  test("an unknown nested property is refused and the value never echoed (RT-20, RT-121)", async () => {
    await refuses(kit.send({ fields: { text: "hi", sneaky: "TOP-SECRET-VALUE" } }), "validation_failed", (err) => {
      assert.equal(err.fields.$unknown.code, "unknown_field");
      assert.ok(!JSON.stringify(err.fields).includes("TOP-SECRET-VALUE"));
      assert.ok(!JSON.stringify(err.fields).includes("sneaky"));
    });
  });

  test("an unreadable recipient is a fields.to fault, never the number", async () => {
    await refuses(kit.send({ to: "not a number" }), "validation_failed", (err) => {
      assert.equal(err.fields.to.code, "invalid_format");
      assert.ok(!JSON.stringify(err).includes("not a number"));
    });
    await refuses(kit.send({ to: "12345678@lid" }), "validation_failed", (err) => assert.equal(err.fields.to.code, "invalid_format"));
    assert.equal(await count(), 0);
  });

  test("the policy: recipient_not_allowed carries no parameter and no number", async () => {
    await refuses(kit.send({ policy: { mode: "list", entries: [PN2] } }), "recipient_not_allowed", (err) => {
      assert.equal(err.params, undefined);
      assert.ok(!JSON.stringify(err).includes("237690000001"));
    });
    const accepted = await kit.send({ policy: { mode: "list", entries: [PN] } });
    assert.equal(accepted.message.status, "queued");
    assert.equal(await count(), 1);
  });

  test("the bot's own number comes after the policy (a restricted key learns nothing) and is not_allowed", async () => {
    await kit.start(); // the identity of the socket is learned at start
    await refuses(kit.send({ to: kit.OWN_NUMBER, policy: { mode: "list", entries: [PN] } }), "recipient_not_allowed");
    await refuses(kit.send({ to: kit.OWN_NUMBER }), "validation_failed", (err) => assert.equal(err.fields.to.code, "not_allowed"));
    assert.equal(await count(), 0);
  });

  test("a disabled chat: chat_disabled, after the own-number check", async () => {
    kit.banned.add(PN);
    await refuses(kit.send(), "chat_disabled");
    assert.equal(await count(), 0);
    kit.banned.delete(PN);
    await kit.send();
    assert.equal(await count(), 1);
  });

  test("no policy (the panel) skips the recipient policy only", async () => {
    const { message } = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null });
    assert.equal(message.source, "panel");
    assert.equal(message.apiKeyId, null);
    kit.banned.add(PN2);
    await refuses(kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, to: "237690000002" }), "chat_disabled");
  });

  test("a group target accepts mentions and stores them as digit strings", async () => {
    const { message } = await kit.send({ to: GROUP, fields: { text: "hi @x", mentions: ["+237 690-000-002", "237690000002"] } });
    assert.equal(message.chatType, "group");
    const stored = await kit.row(message.publicId);
    assert.deepEqual(stored.payload.input.mentions, ["237690000002"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("submit: the INSERT of T1 (RT-40 to RT-43, data-model 2.6)", () => {
  test("payload holds the validated own fields after normalize; nothing of the request level, no URL", async () => {
    const { message } = await kit.send({ requestId: "aaaaaaaaaaaaaaaa", fields: { text: "  héllo  .eval 1+1 " } });
    const stored = await kit.row(message.publicId);
    assert.equal(stored.status, "queued");
    assert.deepEqual(stored.payload, { v: 1, input: { text: "héllo  .eval 1+1", linkPreview: false }, media: null, quote: null });
    for (const excluded of ["to", "quote", "fileName", "media", "format"]) assert.ok(!(excluded in stored.payload.input), excluded);
    assert.equal(stored.requestId, "aaaaaaaaaaaaaaaa");
    assert.equal(stored.mediaPath, null);
    for (const empty of ["waId", "sendingAt", "sentAt", "deliveredAt", "readAt", "endedAt", "errorCode", "choices", "replyData", "pollSecret", "repliesUntil"]) {
      assert.equal(stored[empty], null, empty);
    }
  });

  test("a request that smuggles a media URL into the fields is refused, so a URL can never reach the payload", async () => {
    await refuses(kit.send({ fields: { text: "x", media: { url: "https://secret.example/file?token=abc" } } }), "validation_failed");
    assert.equal(await count(), 0);
  });

  test("size per format: UTF-8 bytes of the text or the question, null for a location", async () => {
    const text = await kit.send({ fields: { text: "héllo" } });
    assert.equal((await kit.row(text.message.publicId)).size, 6);
    const poll = await kit.send({ format: "poll", fields: { question: "Quel jour ?", options: ["Mardi", "Jeudi"] } });
    assert.equal((await kit.row(poll.message.publicId)).size, Buffer.byteLength("Quel jour ?", "utf8"));
    const buttons = await kit.send({ format: "buttons", fields: { text: "Ok ?", buttons: [{ id: "y", label: "Oui" }] } });
    assert.equal((await kit.row(buttons.message.publicId)).size, 4);
    const location = await kit.send({ format: "location", fields: { latitude: 4.05, longitude: 9.7 } });
    assert.equal((await kit.row(location.message.publicId)).size, null);
    assert.equal(poll.message.interactive, true);
    assert.equal(location.message.interactive, false);
  });

  test("acceptedAt is the injected time and expiresAt a snapshot: a settings change never moves queued rows", async () => {
    const first = await kit.send({ now: kit.T0 });
    const stored = await kit.row(first.message.publicId);
    assert.equal(stored.acceptedAt.getTime(), kit.T0);
    assert.equal(stored.expiresAt.getTime(), kit.T0 + 10 * MIN);

    kit.config.API_QUEUE_EXPIRY_MIN = 1;
    const second = await kit.send({ now: kit.T0 });
    assert.equal((await kit.row(second.message.publicId)).expiresAt.getTime(), kit.T0 + MIN, "the next message follows the new setting");
    assert.equal((await kit.row(first.message.publicId)).expiresAt.getTime(), kit.T0 + 10 * MIN, "the queued row did not move");
  });

  test("the interactive formats store no reply material at acceptance (it is written by the claim)", async () => {
    const { message } = await kit.send({ format: "poll", fields: { question: "Q", options: ["a", "b"] } });
    const stored = await kit.row(message.publicId);
    assert.equal(stored.choices, null);
    assert.equal(stored.replyData, null);
    assert.equal(stored.pollSecret, null);
    assert.deepEqual(stored.payload.input, { question: "Q", options: ["a", "b"], multiple: false });
  });

  test("two messages get two distinct public ids", async () => {
    const a = await kit.send();
    const b = await kit.send();
    assert.notEqual(a.message.publicId, b.message.publicId);
  });

  test("a public id collision is retried once; a second collision is not hidden", async () => {
    await kit.close();
    const draws = [];
    kit = await createEngineKit({ deps: { mintBytes: () => (draws.length ? draws.shift() : crypto.randomBytes(16)) } });
    key = await kit.key();
    const first = await kit.send();
    const taken = Buffer.from(first.message.publicId.slice(4), "base64url");
    assert.equal(taken.length, 16);

    draws.push(taken, Buffer.alloc(16, 9));
    const second = await kit.send();
    assert.equal(second.replayed, false);
    assert.notEqual(second.message.publicId, first.message.publicId);
    assert.equal(await count(), 2);

    draws.push(taken, taken);
    await assert.rejects(kit.send(), (err) => !(err instanceof MessagingError));
    assert.equal(await count(), 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("submit: the quote rule (4.2 step 6, data-model 2.6)", () => {
  /** A message of this key to this recipient that already left */
  async function sentMessage(over = {}) {
    const { message } = await kit.send(over);
    await kit.db.ApiMessage.update(
      { status: "sent", waId: `3EB0QUOTE${message.publicId.slice(4, 14)}`, sendingAt: new Date(kit.now()), sentAt: new Date(kit.now()), payload: null },
      { where: { publicId: message.publicId } },
    );
    return kit.row(message.publicId);
  }

  test("a sent message of the same key to the same chat resolves to { publicId, waId, format } in the payload", async () => {
    const quoted = await sentMessage();
    const { message } = await kit.send({ quote: quoted.publicId, fields: { text: "re" } });
    const stored = await kit.row(message.publicId);
    assert.deepEqual(stored.payload.quote, { publicId: quoted.publicId, waId: quoted.waId, format: "text" });
    assert.ok(!("quote" in stored.payload.input));
  });

  test("delivered and read count, queued does not", async () => {
    const quoted = await sentMessage();
    await kit.db.ApiMessage.update({ status: "read", readAt: new Date(kit.now()), deliveredAt: new Date(kit.now()) }, { where: { id: quoted.id } });
    await kit.send({ quote: quoted.publicId });
    const queued = await kit.send();
    await refuses(kit.send({ quote: queued.message.publicId }), "validation_failed", (err) => assert.equal(err.fields.quote.code, "not_found"));
  });

  test("another key, another recipient, a panel row, an unknown id: fields.quote not_found and nothing written", async () => {
    const other = await kit.key();
    const mine = await sentMessage();
    const theirs = await sentMessage({ apiKeyId: other.id });
    const elsewhere = await sentMessage({ to: "237690000002" });
    const panel = await sentMessage({ source: "panel", apiKeyId: null, policy: null, limits: null });
    const before = await count();
    for (const quote of [theirs.publicId, elsewhere.publicId, panel.publicId, `msg_${"Z".repeat(22)}`]) {
      await refuses(kit.send({ quote }), "validation_failed", (err) => assert.equal(err.fields.quote.code, "not_found"));
    }
    assert.equal(await count(), before);
    assert.ok(mine);
  });

  test("a panel message quotes only panel messages", async () => {
    const panelSent = await sentMessage({ source: "panel", apiKeyId: null, policy: null, limits: null });
    const { message } = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, quote: panelSent.publicId });
    assert.equal((await kit.row(message.publicId)).payload.quote.publicId, panelSent.publicId);
    const apiSent = await sentMessage();
    await refuses(kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, quote: apiSent.publicId }), "validation_failed");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("submit: idempotency, the lost race and the lazy release (4.2 steps 7-8, data-model 2.4)", () => {
  const idem = (keyText, hash) => ({ key: keyText, requestHash: hash });

  test("the stored key and hash are written with the row", async () => {
    const { message, requestHash } = await kit.send({ idempotency: idem("order-1", "h".repeat(32)) });
    assert.equal(requestHash, "h".repeat(32));
    const stored = await kit.row(message.publicId);
    assert.deepEqual([stored.idempotencyKey, stored.requestHash], ["order-1", "h".repeat(32)]);
  });

  test("a second submit with the same key loses the race: the stored row comes back, replayed, with the STORED hash", async () => {
    const first = await kit.send({ idempotency: idem("order-1", "a".repeat(32)) });
    const second = await kit.send({ idempotency: idem("order-1", "b".repeat(32)), fields: { text: "another text" } });
    assert.equal(second.replayed, true);
    assert.equal(second.message.publicId, first.message.publicId);
    assert.equal(second.requestHash, "a".repeat(32), "the caller compares it with its own fingerprint");
    assert.equal(await count(), 1);
  });

  test("another key, another api key, and no key never collide", async () => {
    const other = await kit.key();
    await kit.send({ idempotency: idem("k", "a".repeat(32)) });
    const sameKeyOtherApiKey = await kit.send({ apiKeyId: other.id, idempotency: idem("k", "a".repeat(32)) });
    assert.equal(sameKeyOtherApiKey.replayed, false);
    assert.equal((await kit.send()).replayed, false);
    assert.equal((await kit.send()).replayed, false);
    assert.equal((await kit.send({ idempotency: idem("k2", "c".repeat(32)) })).replayed, false);
    assert.equal(await count(), 5);
  });

  test("two identical concurrent requests: one row, the loser replays", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => kit.send({ idempotency: idem("burst", "d".repeat(32)) })));
    assert.equal(results.filter((r) => r.replayed === false).length, 1);
    assert.equal(results.filter((r) => r.replayed === true).length, 4);
    assert.equal(new Set(results.map((r) => r.message.publicId)).size, 1);
    assert.equal(await count(), 1);
  });

  test("after 24 h the old fingerprint is released lazily inside the lock and the new message is inserted", async () => {
    const old = await kit.send({ idempotency: idem("daily", "a".repeat(32)), now: kit.T0 });
    kit.clock.set(kit.T0 + 25 * HOUR);
    const fresh = await kit.send({ idempotency: idem("daily", "e".repeat(32)), now: kit.T0 + 25 * HOUR });
    assert.equal(fresh.replayed, false);
    assert.notEqual(fresh.message.publicId, old.message.publicId);
    const released = await kit.row(old.message.publicId);
    assert.deepEqual([released.idempotencyKey, released.requestHash], [null, null]);
    assert.equal((await kit.row(fresh.message.publicId)).idempotencyKey, "daily");
  });

  test("findByIdempotency: the stored view and hash inside the window, null for an unknown key, null once released", async () => {
    assert.equal(await kit.messaging.findByIdempotency({ apiKeyId: key.id, key: "nope", now: kit.T0 }), null);
    const sent = await kit.send({ idempotency: idem("look", "f".repeat(32)), now: kit.T0 });
    const found = await kit.messaging.findByIdempotency({ apiKeyId: key.id, key: "look", now: kit.T0 + HOUR });
    assert.equal(found.message.publicId, sent.message.publicId);
    assert.equal(found.requestHash, "f".repeat(32));
    assert.equal(await kit.messaging.findByIdempotency({ apiKeyId: key.id + 99, key: "look", now: kit.T0 }), null, "another api key");

    assert.equal(await kit.messaging.findByIdempotency({ apiKeyId: key.id, key: "look", now: kit.T0 + 25 * HOUR }), null);
    const released = await kit.row(sent.message.publicId);
    assert.deepEqual([released.idempotencyKey, released.requestHash], [null, null], "the lazy release also clears the row");
  });

  test("a retry of an accepted message is a replay even when the queue has filled up meanwhile", async () => {
    const first = await kit.send({ idempotency: idem("busy", "a".repeat(32)) });
    kit.config.API_QUEUE_MAX = 1;
    const again = await kit.send({ idempotency: idem("busy", "a".repeat(32)) });
    assert.equal(again.replayed, true);
    assert.equal(again.message.publicId, first.message.publicId);
    await refuses(kit.send(), "queue_full");
  });

  test("a refused request leaves the key free: nothing is stored for it", async () => {
    await refuses(kit.send({ fields: { text: "" }, idempotency: idem("free", "a".repeat(32)) }), "validation_failed");
    const ok = await kit.send({ idempotency: idem("free", "b".repeat(32)) });
    assert.equal(ok.replayed, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("admission (4.5): global cap, estimated wait, key pending, retryAfterMs clamped, check-only twin", () => {
  /** The verdict of submit and of checkAdmission for the same situation must be the same refusal */
  async function sameVerdict(code, params, over = {}) {
    let fromSubmit;
    await assert.rejects(kit.send(over), (err) => {
      fromSubmit = err;
      return true;
    });
    assert.ok(fromSubmit instanceof MessagingError);
    assert.equal(fromSubmit.code, code);
    assert.deepEqual(fromSubmit.params, params);
    const maxPending = over.limits ? over.limits.maxPending : 100;
    await assert.rejects(kit.messaging.checkAdmission({ apiKeyId: over.apiKeyId !== undefined ? over.apiKeyId : key.id, maxPending }), (err) => {
      assert.ok(err instanceof MessagingError);
      assert.equal(err.code, code);
      assert.deepEqual(err.params, params);
      return true;
    });
  }

  test("global: pending >= API_QUEUE_MAX gives queue_full { scope: global } with retryAfterMs = spacing * (size - cap + 1)", async () => {
    kit.config.API_QUEUE_MAX = 3;
    await fillQueue(3);
    await sameVerdict("queue_full", { scope: "global", retryAfterMs: 2000 });
    await fillQueue(2, { salt: "b" });
    await sameVerdict("queue_full", { scope: "global", retryAfterMs: 6000 });
    assert.equal(await count(), 5, "nothing written by the refusals");
  });

  test("sending rows count as pending, delivered rows do not", async () => {
    kit.config.API_QUEUE_MAX = 2;
    await fillQueue(1, { row: { status: "sending", sendingAt: new Date(kit.now()), waId: "3EB0AAAAAAAAAAAA0001" } });
    await fillQueue(1, { salt: "b", row: { status: "sent", sendingAt: new Date(kit.now()), sentAt: new Date(kit.now()), waId: "3EB0AAAAAAAAAAAA0002", payload: null } });
    await kit.send();
    await sameVerdict("queue_full", { scope: "global", retryAfterMs: 2000 });
  });

  test("wait: (pending + 1) x spacing x 1.1 over the expiry gives queue_full { scope: wait } at 272 pending with the defaults", async () => {
    const other = await kit.key();
    await fillQueue(271, { apiKeyId: other.id });
    const accepted = await kit.send();
    assert.equal(accepted.replayed, false, "(271 + 1) x 2000 x 1.1 = 598,400 ms is still inside 10 minutes");
    await sameVerdict("queue_full", { scope: "wait", retryAfterMs: 1000 });
  });

  test("wait: a longer estimate is clamped to 300000 ms; the spacing is read at call time", async () => {
    kit.config.API_QUEUE_MAX = 5000;
    kit.config.SEND_MIN_SPACING_MS = 60000;
    await fillQueue(100);
    await sameVerdict("queue_full", { scope: "wait", retryAfterMs: 300000 });
  });

  test("key pending: pending_limit_reached { limit, retryAfterMs } for keyed submissions only", async () => {
    await fillQueue(2);
    await sameVerdict("pending_limit_reached", { limit: 2, retryAfterMs: 2000 }, { limits: { maxPending: 2 } });
    await fillQueue(3, { salt: "b" });
    await sameVerdict("pending_limit_reached", { limit: 2, retryAfterMs: 8000 }, { limits: { maxPending: 2 } });

    const other = await kit.key();
    const accepted = await kit.send({ apiKeyId: other.id, limits: { maxPending: 2 } });
    assert.equal(accepted.replayed, false, "the count is per key");
    const panel = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null });
    assert.equal(panel.message.source, "panel", "a panel message is under no key limit but counts toward the global queue");
  });

  test("a keyed submission without limits falls back to API_MAX_PENDING", async () => {
    kit.config.API_MAX_PENDING = 1;
    await fillQueue(1);
    await refuses(kit.send({ limits: null }), "pending_limit_reached", (err) => assert.equal(err.params.limit, 1));
  });

  test("refusal order: global first, then the estimated wait, then the key", async () => {
    kit.config.API_QUEUE_MAX = 2;
    await fillQueue(2);
    await refuses(kit.send({ limits: { maxPending: 1 } }), "queue_full", (err) => assert.equal(err.params.scope, "global"));
  });

  test("count-then-insert is atomic: 50 concurrent accepts never exceed the cap", async () => {
    kit.config.API_QUEUE_MAX = 10;
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => kit.send({ fields: { text: `m${i}` } })));
    const accepted = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(accepted.length, 10);
    assert.equal(refused.length, 40);
    assert.ok(refused.every((r) => r.reason instanceof MessagingError && r.reason.code === "queue_full"));
    assert.equal(await count(), 10);
  });

  test("the same under a per-key limit", async () => {
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => kit.send({ limits: { maxPending: 5 }, fields: { text: `m${i}` } })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "pending_limit_reached"));
  });

  test("pendingOf, queueSize and spacingMs", async () => {
    await kit.send();
    await kit.send();
    const other = await kit.key();
    await kit.send({ apiKeyId: other.id });
    assert.equal(await kit.messaging.pendingOf(key.id), 2);
    assert.equal(await kit.messaging.pendingOf(other.id), 1);
    assert.equal(await kit.messaging.queueSize(), 3);
    assert.equal(kit.messaging.spacingMs(), 2000);
    kit.config.SEND_MIN_SPACING_MS = 5000;
    assert.equal(kit.messaging.spacingMs(), 5000);
    kit.config.SEND_MIN_SPACING_MS = 100;
    assert.equal(kit.messaging.spacingMs(), 2000, "never below the 2 s floor");
    assert.equal(await kit.messaging.pendingMediaBytes(), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("validateInput and resolveRecipient: the building blocks the HTTP pipeline calls (RT-10, RT-12)", () => {
  test("validateInput returns Validated: the own fields in stored form, the quote and the media marker", async () => {
    const target = await kit.messaging.resolveRecipient(GROUP, { policy: null });
    assert.deepEqual(target, { jid: GROUP, kind: "group", number: null });
    const validated = await kit.messaging.validateInput("text", { format: "text", to: GROUP, text: "hi", mentions: ["+237 690-000-002"] }, { target, apiKeyId: key.id });
    assert.equal(validated.format, "text");
    assert.equal(validated.to, GROUP);
    assert.equal(validated.quote, null);
    assert.equal(validated.mediaMarker, false);
    assert.deepEqual(validated.fields, { text: "hi", mentions: ["237690000002"], linkPreview: false });
  });

  test("validateInput turns every fault into one validation_failed with all the fields; an unknown format is not_allowed", async () => {
    const target = await kit.messaging.resolveRecipient("237690000001");
    await refuses(kit.messaging.validateInput("text", { format: "text", to: "237690000001", text: "", mentions: ["x"] }, { target }), "validation_failed", (err) => {
      assert.ok(err.fields.text);
      assert.ok(err.fields.mentions);
    });
    await refuses(kit.messaging.validateInput("nope", {}, { target }), "validation_failed", (err) => assert.equal(err.fields.format.code, "not_allowed"));
  });

  test("resolveRecipient: parse, policy, own number (from the live socket), disabled chat", async () => {
    await refuses(kit.messaging.resolveRecipient("abc"), "validation_failed", (err) => assert.equal(err.fields.to.code, "invalid_format"));
    await refuses(kit.messaging.resolveRecipient("237690000001", { policy: { mode: "list", entries: [] } }), "recipient_not_allowed");
    await kit.start();
    await refuses(kit.messaging.resolveRecipient(kit.OWN_NUMBER), "validation_failed", (err) => assert.equal(err.fields.to.code, "not_allowed"));
    kit.banned.add(PN);
    await refuses(kit.messaging.resolveRecipient("237690000001"), "chat_disabled");
  });

  test("the facade exposes the surface the HTTP pipeline calls, and the format registry", () => {
    for (const name of ["resolveRecipient", "validateInput", "checkAdmission", "findByIdempotency", "pendingMediaBytes", "submit", "waitFor", "pendingOf", "queueSize", "spacingMs", "stats", "parseRecipient", "mask", "start", "stop", "isRunning", "enable", "disable", "cancelForKey"]) {
      assert.equal(typeof kit.messaging[name], "function", name);
    }
    assert.ok(kit.messaging.formats && typeof kit.messaging.formats.get === "function");
    assert.equal(kit.messaging.mask(PN), "237...01");
    assert.deepEqual(kit.messaging.parseRecipient(GROUP), { kind: "group", jid: GROUP, number: null });
  });
});

// =====================================================================================================================
// Part 2: media (runtime.md 4.2 steps 5-8, 10.2-10.4; data-model 7)
// =====================================================================================================================

const fs = require("node:fs");
const path = require("node:path");
const { samples } = require("./helpers/messagingKit");

/** The models with `ApiMessage.create` made to fail (a database refusing the INSERT) */
function failingCreate(db, error = new Error("database is locked")) {
  const wrapped = new Proxy(db.ApiMessage, {
    get(target, prop) {
      if (prop === "create") return async () => Promise.reject(error);
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...db, ApiMessage: wrapped };
}

describe("inspectMedia: the type comes from the bytes, the cap from the format (10.2)", () => {
  test("a PNG for image: kind, detected mime and extension, size", async () => {
    const png = await samples.png();
    const info = await kit.messaging.inspectMedia("image", kit.file(png, "photo.jpg"), { name: "photo.jpg" });
    assert.deepEqual(info, { kind: "image", mime: "image/png", ext: "png", size: png.length });
  });

  test("a declared type and a file name never decide: a PDF called .png for image is media_type_mismatch with the expected kinds only", async () => {
    const staged = { ...kit.file(samples.pdf(), "receipt.png"), mime: "image/png" };
    await refuses(kit.messaging.inspectMedia("image", staged, { name: "receipt.png" }), "media_type_mismatch", (err) => {
      assert.deepEqual(err.params, { expected: ["image"] });
      assert.ok(!JSON.stringify(err).includes("pdf"), "the detected type is never echoed");
    });
    await refuses(kit.messaging.inspectMedia("document", kit.file(samples.exe(), "run.pdf"), { name: "run.pdf" }), "media_type_mismatch", (err) => {
      assert.deepEqual(err.params, { expected: ["document"] });
    });
  });

  test("a plain text and a CSV are documents (by content), a script is not", async () => {
    assert.equal((await kit.messaging.inspectMedia("document", kit.file(samples.text(), "data.csv"), { name: "data.csv" })).mime, "text/csv");
    assert.equal((await kit.messaging.inspectMedia("document", kit.file(samples.text(), "notes.txt"), { name: "notes.txt" })).mime, "text/plain");
    await refuses(kit.messaging.inspectMedia("document", kit.file(Buffer.from("#!/bin/sh\nrm -rf /\n"), "x.txt"), { name: "x.txt" }), "media_type_mismatch");
  });

  test("a format without media gives fields.file = not_allowed", async () => {
    await refuses(kit.messaging.inspectMedia("text", kit.file(samples.text()), {}), "validation_failed", (err) => assert.equal(err.fields.file.code, "not_allowed"));
    await refuses(kit.messaging.inspectMedia("poll", kit.file(samples.text()), {}), "validation_failed", (err) => assert.equal(err.fields.file.code, "not_allowed"));
  });

  test("over the effective cap: media_too_large with maxBytes (min of the format cap and MAX_UPLOAD)", async () => {
    await kit.close();
    const sniff = { ...require("../lib/messaging/sniff"), effectiveMax: (format) => (format.name === "image" ? 100 : 1e9) };
    kit = await createEngineKit({ deps: { sniff: { ...sniff, effectiveMax: () => 100 } } });
    key = await kit.key();
    const png = await samples.png();
    assert.ok(png.length > 100);
    await refuses(kit.messaging.inspectMedia("image", kit.file(png)), "media_too_large", (err) => assert.deepEqual(err.params, { maxBytes: 100 }));
  });

  test("the real cap follows MAX_UPLOAD at call time", async () => {
    const config = require("../config");
    const png = await samples.png();
    const previous = config.MAX_UPLOAD;
    try {
      config.MAX_UPLOAD = 1;
      assert.equal((await kit.messaging.inspectMedia("image", kit.file(png))).size, png.length, "16 x 16 PNG is far below 1 MB");
      config.MAX_UPLOAD = 0.00003; // about 31 bytes
      await refuses(kit.messaging.inspectMedia("image", kit.file(png)), "media_too_large", (err) => assert.equal(err.params.maxBytes, Math.floor(0.00003 * 1048576)));
    } finally {
      config.MAX_UPLOAD = previous;
    }
  });
});

describe("fetchMedia: the guarded fetcher, then the same inspection (9, 10.2)", () => {
  /** A fetcher that "downloads" the given bytes and records how it was called */
  function fakeFetcher(bytes) {
    const calls = [];
    return {
      calls,
      async fetchMedia(url, opts) {
        calls.push({ url, ...opts });
        const staged = kit.file(bytes);
        return { path: staged.path, size: staged.size, contentType: "application/octet-stream", sha256: staged.sha256 };
      },
    };
  }

  async function withFetcher(bytes) {
    await kit.close();
    const fetcher = fakeFetcher(bytes);
    kit = await createEngineKit({ deps: { urlFetch: fetcher } });
    key = await kit.key();
    return fetcher;
  }

  test("the format's cap and kinds go to the fetcher with the caller's signal; the result is a StagedFile marked as from a URL", async () => {
    const png = await samples.png();
    const fetcher = await withFetcher(png);
    const signal = new AbortController().signal;
    const staged = await kit.messaging.fetchMedia("image", "https://files.example.com/a.png?token=SECRET", { signal });
    assert.equal(fetcher.calls.length, 1);
    assert.equal(fetcher.calls[0].url, "https://files.example.com/a.png?token=SECRET");
    assert.deepEqual(fetcher.calls[0].kinds, ["image"]);
    assert.ok(fetcher.calls[0].maxBytes > 0 && fetcher.calls[0].maxBytes <= 16 * 1048576);
    assert.equal(fetcher.calls[0].signal, signal);
    assert.deepEqual(
      { size: staged.size, name: staged.name, mime: staged.mime, ext: staged.ext, kind: staged.kind, source: staged.source },
      { size: png.length, name: null, mime: "image/png", ext: "png", kind: "image", source: "url" },
    );
    assert.match(staged.sha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(staged.path));
    assert.ok(!JSON.stringify(staged).includes("SECRET"), "the URL is never part of the result");
  });

  test("a download that turns out to be of the wrong type is deleted and refused media_type_mismatch", async () => {
    const fetcher = await withFetcher(samples.pdf());
    let leftover = null;
    const original = fetcher.fetchMedia.bind(fetcher);
    fetcher.fetchMedia = async (...args) => {
      const result = await original(...args);
      leftover = result.path;
      return result;
    };
    await refuses(kit.messaging.fetchMedia("image", "https://files.example.com/a.png"), "media_type_mismatch", (err) => assert.deepEqual(err.params, { expected: ["image"] }));
    assert.ok(leftover && !fs.existsSync(leftover), "the temporary file is removed on a refusal");
  });

  test("a format without media refuses before any connection; a refusal of the fetcher passes through untouched", async () => {
    const fetcher = await withFetcher(await samples.png());
    await refuses(kit.messaging.fetchMedia("text", "https://files.example.com/a.png"), "validation_failed", (err) => assert.equal(err.fields.media.code, "not_allowed"));
    assert.equal(fetcher.calls.length, 0);

    const { MessagingError } = require("../lib/messaging/errors");
    fetcher.fetchMedia = async () => {
      throw new MessagingError("url_forbidden", { params: { reason: "host" } });
    };
    await refuses(kit.messaging.fetchMedia("image", "https://localhost/a.png"), "url_forbidden", (err) => assert.deepEqual(err.params, { reason: "host" }));
  });
});

describe("submit with a file: stage adoption, mediaPath, admission and RT-42 (4.2 steps 5-8, 10.3, data-model 7)", () => {
  const dirOf = (publicId) => path.join(kit.stage.rootDir(), publicId);

  test("an API file is MOVED into data/api-media/<publicId>/source (0600 in a 0700 directory) and the row points at it", async () => {
    const png = await samples.png();
    const staged = kit.file(png, "photo.png");
    const { message } = await kit.send({ format: "image", fields: { caption: "Your receipt" }, media: staged });
    assert.equal(fs.existsSync(staged.path), false, "moved: the temporary file is gone");

    const row = await kit.row(message.publicId);
    assert.equal(row.mediaPath, `data/api-media/${message.publicId}/source`, "repo-relative, forward slashes");
    const file = path.join(dirOf(message.publicId), "source");
    assert.deepEqual(fs.readFileSync(file), png);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dirOf(message.publicId)).mode & 0o777, 0o700);
    assert.equal(row.size, png.length);
    assert.deepEqual(row.payload, {
      v: 1,
      input: { caption: "Your receipt" },
      media: { source: "upload", mime: "image/png", ext: "png", size: png.length, fileName: null },
      quote: null,
    });
    assert.equal(message.format, "image");
    assert.equal(message.size, png.length);
  });

  test("a panel file is COPIED: the upload record still has its file (it is consumed after acceptance)", async () => {
    const staged = { ...kit.file(await samples.png(), "photo.png"), mode: "copy" };
    const { message } = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, format: "image", fields: {}, media: staged });
    assert.equal(fs.existsSync(staged.path), true);
    assert.deepEqual(fs.readFileSync(path.join(dirOf(message.publicId), "source")), fs.readFileSync(staged.path));
    assert.equal((await kit.row(message.publicId)).source, "panel");
  });

  test("the type is detected again at submit: the declared mime and name are ignored, the stored mime is the detected one", async () => {
    const staged = { ...kit.file(await samples.png(), "photo.pdf"), mime: "application/pdf" };
    const { message } = await kit.send({ format: "image", fields: {}, media: staged });
    assert.equal((await kit.row(message.publicId)).payload.media.mime, "image/png");
    assert.equal((await kit.row(message.publicId)).payload.media.ext, "png");
  });

  test("a document keeps its sanitised name in payload.media.fileName, never in payload.input", async () => {
    const { message } = await kit.send({ format: "document", fields: { caption: "Invoice", fileName: "../../etc/invoice 2026.pdf" }, media: kit.file(samples.pdf(), "ignored.bin") });
    const row = await kit.row(message.publicId);
    assert.ok(!("fileName" in row.payload.input));
    assert.deepEqual(row.payload.input, { caption: "Invoice" });
    assert.match(row.payload.media.fileName, /^[^/\\]+\.pdf$/, "no path, the extension of the detected type");
    assert.equal(row.payload.media.mime, "application/pdf");

    const noName = await kit.send({ format: "document", fields: {}, media: kit.file(samples.pdf(), "report.pdf") });
    assert.equal((await kit.row(noName.message.publicId)).payload.media.fileName, "report.pdf", "the multipart name is the fallback");
  });

  test("a file that came from a URL is recorded as source url, and no URL is stored anywhere", async () => {
    const staged = { ...kit.file(await samples.png(), null), source: "url" };
    const { message } = await kit.send({ format: "image", fields: {}, media: staged });
    const row = await kit.row(message.publicId);
    assert.equal(row.payload.media.source, "url");
    assert.ok(!/https?:/.test(JSON.stringify(row.toJSON())), "a URL is never stored");
  });

  test("a media format without a file gives fields.media = required; a format without media given a file gives fields.file = not_allowed", async () => {
    await refuses(kit.send({ format: "image", fields: {} }), "validation_failed", (err) => assert.equal(err.fields.media.code, "required"));
    const stray = kit.file(samples.text());
    await refuses(kit.send({ format: "text", fields: { text: "hi" }, media: stray }), "validation_failed", (err) => assert.equal(err.fields.file.code, "not_allowed"));
    assert.equal(fs.existsSync(stray.path), true, "RT-42: a refusal before adoption leaves the temporary file to the pipeline");
    assert.equal(await count(), 0);
  });

  test("a type mismatch and an oversize file are refused at submit too, with nothing adopted and the temp file left alone", async () => {
    const wrong = kit.file(samples.pdf());
    await refuses(kit.send({ format: "image", fields: {}, media: wrong }), "media_type_mismatch");
    assert.equal(fs.existsSync(wrong.path), true);
    assert.equal(fs.existsSync(kit.stage.rootDir()) ? fs.readdirSync(kit.stage.rootDir()).length : 0, 0);
    assert.equal(await count(), 0);
  });

  test("the policy and the other refusals come before the file is touched (media step is after the recipient)", async () => {
    const staged = kit.file(await samples.png());
    await refuses(kit.send({ format: "image", fields: {}, media: staged, policy: { mode: "list", entries: [PN2] } }), "recipient_not_allowed");
    assert.equal(fs.existsSync(staged.path), true);
  });

  test("RT-42: a refusal after adoption removes the staged directory (the INSERT failed)", async () => {
    await kit.close();
    const base = await createEngineKit();
    const db = base.db;
    await base.close();
    kit = await createEngineKit({ clear: false, models: failingCreate(db) });
    key = await kit.key();
    const staged = { ...kit.file(await samples.png()), mode: "copy" };
    await assert.rejects(kit.send({ format: "image", fields: {}, media: staged }), /database is locked/);
    assert.equal(fs.existsSync(kit.stage.rootDir()) ? fs.readdirSync(kit.stage.rootDir()).length : 0, 0, "no directory left behind");
    assert.equal(fs.existsSync(staged.path), true, "the copy mode left the caller's file");
    assert.equal(await count(), 0);
  });

  test("an idempotent retry with a file is a replay answered before the file is adopted: no second directory", async () => {
    const first = await kit.send({ format: "image", fields: {}, media: kit.file(await samples.png()), idempotency: { key: "photo-1", requestHash: "a".repeat(32) } });
    const again = kit.file(await samples.png());
    const replay = await kit.send({ format: "image", fields: {}, media: again, idempotency: { key: "photo-1", requestHash: "a".repeat(32) } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.publicId, first.message.publicId);
    assert.deepEqual(fs.readdirSync(kit.stage.rootDir()), [first.message.publicId]);
    assert.equal(fs.existsSync(again.path), true, "the pipeline's finally removes it");
  });

  test("a public id that is already taken is skipped before a file is adopted: the first message's directory is never written over", async () => {
    await kit.close();
    const draws = [];
    kit = await createEngineKit({ deps: { mintBytes: () => (draws.length ? draws.shift() : crypto.randomBytes(16)) } });
    key = await kit.key();
    const firstPng = await samples.png();
    const first = await kit.send({ format: "image", fields: {}, media: kit.file(firstPng) });
    draws.push(Buffer.from(first.message.publicId.slice(4), "base64url"), Buffer.alloc(16, 5));
    const png = await require("sharp")({ create: { width: 8, height: 8, channels: 3, background: "#00f" } }).png().toBuffer();
    const second = await kit.send({ format: "image", fields: {}, media: kit.file(png) });
    assert.notEqual(second.message.publicId, first.message.publicId);
    assert.deepEqual(fs.readdirSync(kit.stage.rootDir()).sort(), [first.message.publicId, second.message.publicId].sort());
    assert.deepEqual(fs.readFileSync(path.join(dirOf(second.message.publicId), "source")), png);
    assert.deepEqual(fs.readFileSync(path.join(dirOf(first.message.publicId), "source")), firstPng, "the first file is untouched");
    assert.equal((await kit.row(first.message.publicId)).mediaPath.endsWith(`${first.message.publicId}/source`), true);
  });

  test("disk admission: pending media bytes plus the new file over twice MAX_UPLOAD gives queue_full { scope: disk, retryAfterMs: 5000 }", async () => {
    const config = require("../config");
    const previous = config.MAX_UPLOAD;
    kit.config.MAX_UPLOAD = 1; // the bound is 2 MB
    try {
      await kit.db.ApiMessage.bulkCreate([
        { publicId: `msg_${"D".repeat(22)}`, apiKeyId: key.id, recipient: PN, format: "image", status: "queued", size: 1900000, acceptedAt: new Date(kit.now()), expiresAt: new Date(kit.now() + 10 * MIN), payload: { v: 1, input: {}, media: null, quote: null }, mediaPath: `data/api-media/msg_${"D".repeat(22)}/source` },
        { publicId: `msg_${"E".repeat(22)}`, apiKeyId: key.id, recipient: PN, format: "image", status: "sent", size: 9000000, acceptedAt: new Date(kit.now()), expiresAt: new Date(kit.now() + 10 * MIN), sendingAt: new Date(kit.now()), sentAt: new Date(kit.now()), waId: "3EB0DISKSENT000000001", payload: null },
      ]);
      assert.equal(await kit.messaging.pendingMediaBytes(), 1900000, "only queued and sending rows that still hold a file count");
      // a real image of ~480 KB: noise does not compress
      const noisy = await require("sharp")({ create: { width: 400, height: 400, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png({ compressionLevel: 0 }).toBuffer();
      assert.ok(noisy.length > 100000 && noisy.length < 1000000);
      config.MAX_UPLOAD = 1; // the cap seen by the type check is the real one
      const staged = kit.file(noisy);
      await refuses(kit.send({ format: "image", fields: {}, media: staged }), "queue_full", (err) => assert.deepEqual(err.params, { scope: "disk", retryAfterMs: 5000 }));
      assert.equal(fs.existsSync(staged.path), true);
      assert.equal(await count(), 2, "nothing written by the refusal");
      kit.config.MAX_UPLOAD = 230;
      const accepted = await kit.send({ format: "image", fields: {}, media: kit.file(noisy) });
      assert.equal(accepted.replayed, false);
      assert.equal(await kit.messaging.pendingMediaBytes(), 1900000 + noisy.length);
    } finally {
      config.MAX_UPLOAD = previous;
    }
  });
});

// =====================================================================================================================
// Part 3: get and list (runtime.md 1, RT-11)
// =====================================================================================================================

describe("get: scoped by the key in the WHERE clause (RT-11)", () => {
  test("the owning key reads its message as a MessageView; every other case is the same null", async () => {
    const other = await kit.key();
    const { message } = await kit.send({ fields: { text: "mine" } });
    const theirs = await kit.send({ apiKeyId: other.id, fields: { text: "theirs" } });
    const panel = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, fields: { text: "panel" } });

    const view = await kit.messaging.get({ apiKeyId: key.id, publicId: message.publicId });
    assert.equal(view.publicId, message.publicId);
    assert.deepEqual([view.status, view.format, view.recipient, view.chatType, view.source], ["queued", "text", PN, "private", "api"]);
    assert.ok(view.acceptedAt instanceof Date);
    assert.equal(view.responses, null);

    for (const miss of [
      { apiKeyId: key.id, publicId: theirs.message.publicId }, // another key's
      { apiKeyId: key.id, publicId: panel.message.publicId }, // a panel row
      { apiKeyId: other.id, publicId: panel.message.publicId },
      { apiKeyId: key.id, publicId: `msg_${"Q".repeat(22)}` }, // unknown
      { apiKeyId: key.id, publicId: "msg_short" }, // malformed
      { apiKeyId: key.id, publicId: "" },
      { apiKeyId: key.id, publicId: undefined },
      { apiKeyId: null, publicId: message.publicId },
    ]) {
      assert.equal(await kit.messaging.get(miss), null, JSON.stringify(miss));
    }
    await kit.db.ApiMessage.destroy({ where: { publicId: message.publicId } }); // purged by the retention job
    assert.equal(await kit.messaging.get({ apiKeyId: key.id, publicId: message.publicId }), null);
  });

  test("the view carries the steps, the choices of an interactive message and never a content column", async () => {
    const row = await kit.db.ApiMessage.create({
      publicId: `msg_${"G".repeat(22)}`,
      apiKeyId: key.id,
      recipient: PN,
      format: "poll",
      size: 12,
      status: "sent",
      acceptedAt: new Date(kit.T0),
      expiresAt: new Date(kit.T0 + 10 * MIN),
      sendingAt: new Date(kit.T0 + SEC),
      sentAt: new Date(kit.T0 + 2 * SEC),
      waId: "3EB0GETVIEW00000000001",
      requestId: "0123456789abcdef",
      choices: [{ id: "0", label: "Yes" }],
      repliesUntil: new Date(kit.T0 + 7 * 24 * HOUR),
      pollSecret: "enc:v1:a:b:c",
      replyData: { v: 1, multi: false, hashes: ["a".repeat(64)] },
    });
    const view = await kit.messaging.get({ apiKeyId: key.id, publicId: row.publicId }, { responses: false });
    assert.equal(view.interactive, true);
    assert.deepEqual(view.choices, [{ id: "0", label: "Yes" }]);
    assert.equal(view.responses, null, "not requested");
    assert.equal(view.waId, "3EB0GETVIEW00000000001");
    assert.equal(view.requestId, "0123456789abcdef");
    for (const forbidden of ["payload", "pollSecret", "replyData", "mediaPath", "requestHash", "idempotencyKey", "id"]) {
      assert.ok(!(forbidden in view), `${forbidden} is not part of the view`);
    }
  });
});

describe("list: newest first by keyset on the internal id (RT-11, public-api 2.3)", () => {
  async function many(n, over = {}) {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push((await kit.send({ fields: { text: `m${i}` }, now: kit.T0 + i * SEC, ...over })).message.publicId);
    return out;
  }

  test("newest first, scoped to the key: other keys and panel rows are invisible", async () => {
    const other = await kit.key();
    const ids = await many(3);
    await kit.send({ apiKeyId: other.id, fields: { text: "theirs" } });
    await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, fields: { text: "panel" } });
    const { items, next } = await kit.messaging.list({ apiKeyId: key.id });
    assert.deepEqual(items.map((i) => i.publicId), [...ids].reverse());
    assert.equal(next, null);
    assert.ok(items.every((i) => i.responses === null), "items never carry responses");
    assert.deepEqual((await kit.messaging.list({ apiKeyId: other.id })).items.length, 1);
    assert.deepEqual((await kit.messaging.list({ apiKeyId: 99999 })).items, []);
  });

  test("limit defaults to 25, is capped at 100; next is the last item's id when more exist", async () => {
    const ids = await many(27);
    const first = await kit.messaging.list({ apiKeyId: key.id });
    assert.equal(first.items.length, 25);
    assert.equal(first.next, first.items.at(-1).publicId);
    const second = await kit.messaging.list({ apiKeyId: key.id, after: first.next });
    assert.deepEqual(second.items.map((i) => i.publicId), [ids[1], ids[0]]);
    assert.equal(second.next, null);

    const small = await kit.messaging.list({ apiKeyId: key.id, limit: 5 });
    assert.equal(small.items.length, 5);
    assert.equal(small.next, small.items[4].publicId);
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, limit: 500 })).items.length, 27, "capped at 100, there are only 27");
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, limit: 0 })).items.length, 25, "an unusable limit is the default");
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, limit: -4 })).items.length, 1, "never fewer than one");
    const exact = await kit.messaging.list({ apiKeyId: key.id, limit: 27 });
    assert.equal(exact.next, null, "exactly the last page: nothing more exists");
  });

  test("keyset pagination is stable while new messages arrive", async () => {
    await many(6);
    const first = await kit.messaging.list({ apiKeyId: key.id, limit: 3 });
    await many(4, {}); // newer messages arrive between the pages
    const second = await kit.messaging.list({ apiKeyId: key.id, limit: 3, after: first.next });
    const all = (await kit.messaging.list({ apiKeyId: key.id, limit: 100 })).items.map((i) => i.publicId);
    const tail = all.slice(all.indexOf(first.next) + 1);
    assert.deepEqual(second.items.map((i) => i.publicId), tail.slice(0, 3), "page 2 continues exactly after page 1");
    assert.equal(new Set([...first.items, ...second.items].map((i) => i.publicId)).size, 6);
  });

  test("an after that is not a message of this key (unknown, purged, other key, panel, malformed) is the same fields.after = not_found", async () => {
    const other = await kit.key();
    const mine = await many(2);
    const theirs = await kit.send({ apiKeyId: other.id });
    const panel = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null });
    await kit.db.ApiMessage.destroy({ where: { publicId: mine[0] } });
    for (const after of [`msg_${"Z".repeat(22)}`, mine[0], theirs.message.publicId, panel.message.publicId, "msg_x", "garbage"]) {
      await refuses(kit.messaging.list({ apiKeyId: key.id, after }), "validation_failed", (err) => assert.deepEqual(err.fields, { after: { code: "not_found" } }), after);
    }
  });

  test("filters: status, format, since (inclusive) and until (exclusive) on the acceptance time", async () => {
    await many(5); // accepted at T0 + 0..4 s
    await kit.send({ format: "poll", fields: { question: "Q", options: ["a", "b"] }, now: kit.T0 + 10 * SEC });
    await kit.db.ApiMessage.update({ status: "cancelled", errorCode: "key_revoked", endedAt: new Date(kit.T0 + 30 * SEC), payload: null }, { where: { format: "text", acceptedAt: { [require("sequelize").Op.lt]: new Date(kit.T0 + 2 * SEC) } } });

    assert.equal((await kit.messaging.list({ apiKeyId: key.id, status: "cancelled" })).items.length, 2);
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, status: "queued" })).items.length, 4);
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, format: "poll" })).items.length, 1);
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, since: new Date(kit.T0 + 2 * SEC) })).items.length, 4, "since is inclusive");
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, until: new Date(kit.T0 + 2 * SEC) })).items.length, 2, "until is exclusive");
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, since: new Date(kit.T0 + SEC), until: new Date(kit.T0 + 4 * SEC) })).items.length, 3);
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, since: kit.T0 + 2 * SEC, until: new Date(kit.T0 + 4 * SEC).toISOString() })).items.length, 2, "ms, Date and ISO text are accepted");
    assert.equal((await kit.messaging.list({ apiKeyId: key.id, status: "failed" })).items.length, 0);
  });
});
