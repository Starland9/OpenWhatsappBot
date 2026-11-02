"use strict";
/**
 * The accept path of the messaging engine (feature 004, contracts/runtime.md 4.2, 4.5, 1 and RT-10 to RT-14, RT-40
 * to RT-43). Part 1: the nine steps in order, the INSERT of T1, the quote rule, the lost-race replay, the admission
 * table and its atomicity. The media branch (part 2) and `get`/`list` (part 3) are appended in Phases 4 and 5.
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
