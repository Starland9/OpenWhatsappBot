"use strict";
/**
 * Storage rules of the messaging API tables (feature 004, data-model.md 1.5, 1.6, 2.4, 2.5, 3.2 and 10), on an
 * in-memory SQLite database built from the real model files (test/helpers/backupKit.js#makeDb).
 *
 * The modules that will apply these rules do not exist yet (key panel service, outbox, idempotency, reply capture):
 * the statements below are the contract they must issue, written once here as conditional UPDATEs and INSERTs, so a
 * model or index change that breaks a rule fails here first. No clock but explicit dates, no network, no phone.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Op, UniqueConstraintError } = require("sequelize");

const kit = require("./helpers/backupKit");
const { assertMessageInvariants, assertKeyInvariants, keyStatus } = require("./helpers/apiInvariants");
const { withLock } = require("../lib/utils/mutex");

let db;
let seq = 0;

before(async () => {
  db = await kit.makeDb();
});

after(async () => {
  if (db) await db.DATABASE.close();
});

beforeEach(async () => {
  for (const name of ["ApiMessageResponse", "ApiMessage", "ApiKey", "ApiState"]) await db[name].destroy({ where: {} });
});

const T0 = new Date("2026-03-10T08:00:00.000Z");
const at = (ms) => new Date(T0.getTime() + ms);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const PN = "237690000001@s.whatsapp.net";
const PN2 = "237690000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

const keyRow = (over = {}) => {
  const n = ++seq;
  const name = over.name || `Key ${n}`;
  return {
    name,
    nameKey: over.nameKey === undefined ? name.toLowerCase() : over.nameKey,
    lookupId: n.toString(16).padStart(16, "0"),
    secretHash: n.toString(16).padStart(64, "0"),
    last4: "abcd",
    ...over,
  };
};
const createKey = (over) => db.ApiKey.create(keyRow(over));
const publicId = () => `msg_${String(++seq).padStart(22, "A")}`;
const messageRow = (over = {}) => ({
  publicId: publicId(),
  apiKeyId: 1,
  recipient: PN,
  format: "text",
  acceptedAt: T0,
  expiresAt: at(10 * MIN),
  payload: { v: 1, input: { text: "hello" }, media: null, quote: null },
  ...over,
});
const createMessage = (over) => db.ApiMessage.create(messageRow(over));
const fresh = (model, id) => model.findByPk(id);
const liveKeys = () => db.ApiKey.count({ where: { revokedAt: null } });

// ---------------------------------------------------------------------------------------------------------------------
describe("ApiKey: names, revocation, concurrency and usage writes (data-model 1.5, 1.6)", () => {
  /** The revoke statement of data-model 1.6: one UPDATE clears the name reservation and sets the revocation */
  const revoke = (id, now) =>
    db.ApiKey.update(
      { revokedAt: now, nameKey: null, version: db.DATABASE.literal("version + 1") },
      { where: { id, revokedAt: null } },
    );

  test("a name is unique among live keys, case-insensitively, and free again once its key is revoked", async () => {
    const first = await createKey({ name: "Billing" });
    assertKeyInvariants(first);
    await assert.rejects(createKey({ name: "BILLING" }), UniqueConstraintError);
    await assert.rejects(createKey({ name: "billing" }), UniqueConstraintError);
    await createKey({ name: "Marketing" });
    assert.equal(await liveKeys(), 2);

    const [changed] = await revoke(first.id, at(HOUR));
    assert.equal(changed, 1);
    const reused = await createKey({ name: "BILLING" });
    assertKeyInvariants(reused);
    assertKeyInvariants(await fresh(db.ApiKey, first.id));
    assert.equal(await liveKeys(), 2, "the revoked key no longer counts");

    // a second live key with the reused name is refused again, and a revoked name never blocks
    await assert.rejects(createKey({ name: "billing" }), UniqueConstraintError);
    await revoke(reused.id, at(2 * HOUR));
    await createKey({ name: "Billing" });
    assert.equal(await db.ApiKey.count({ where: { name: { [Op.like]: "billing" } } }), 3);
  });

  test("the lower-cased key folds non-ASCII letters, and fits STRING(128) even when lower-casing lengthens the name", async () => {
    await createKey({ name: "Équipe" });
    await assert.rejects(createKey({ name: "ÉQUIPE" }), UniqueConstraintError, "É and é fold to one key");

    // U+0130 lower-cases to two code points: 64 of them make a 128 code point nameKey, the widest case
    const widest = "İ".repeat(64);
    assert.equal([...widest].length, 64);
    const row = await createKey({ name: widest });
    assert.equal([...row.nameKey].length, 128);
    assertKeyInvariants(await fresh(db.ApiKey, row.id));
  });

  test("the duplicate name <name> (n) is cut so the whole stays at most 64 code points", async () => {
    // the rule of admin-api.md section 4 (API-7): the base is truncated, the suffix kept
    const duplicate = (name, n) => {
      const suffix = ` (${n})`;
      return [...name].slice(0, 64 - [...suffix].length).join("") + suffix;
    };
    const base = "k".repeat(64);
    await createKey({ name: base });
    for (const n of [2, 9, 10, 50]) {
      const copy = duplicate(base, n);
      assert.ok([...copy].length <= 64, `(${n}) fits`);
      const row = await createKey({ name: copy });
      assertKeyInvariants(row);
    }
    assert.equal(duplicate("short", 2), "short (2)");
    assert.equal([...duplicate("\u{1F600}".repeat(64), 12)].length, 64);
  });

  test("revoke sets revokedAt, clears nameKey, bumps the version and is idempotent", async () => {
    const key = await createKey({ name: "Reports" });
    assert.equal(key.version, 1);

    const [first] = await revoke(key.id, at(HOUR));
    assert.equal(first, 1);
    const revoked = await fresh(db.ApiKey, key.id);
    assert.equal(revoked.revokedAt.getTime(), at(HOUR).getTime());
    assert.equal(revoked.nameKey, null);
    assert.equal(revoked.name, "Reports", "the display name is kept");
    assert.equal(revoked.version, 2);
    assertKeyInvariants(revoked);

    const [again] = await revoke(key.id, at(2 * HOUR));
    assert.equal(again, 0, "already revoked: nothing changes, so no audit row");
    const same = await fresh(db.ApiKey, key.id);
    assert.deepEqual([same.revokedAt.getTime(), same.version], [at(HOUR).getTime(), 2], "never re-stamped");
  });

  /**
   * The update statement of data-model 1.6: an explicit list of configuration columns, never the usage columns, and a
   * compare-and-swap on the version. `form` is what the panel read earlier, usage columns included and possibly stale.
   */
  const CONFIG_COLUMNS = ["name", "rights", "policyMode", "recipients", "limitPerMinute", "limitPerDay", "limitPending", "ipAllow", "expiresAt"];
  const update = (id, version, form) => {
    const values = {};
    for (const column of CONFIG_COLUMNS) if (column in form) values[column] = form[column];
    return db.ApiKey.update({ ...values, nameKey: form.name.toLowerCase(), version: version + 1 }, { where: { id, version, revokedAt: null } });
  };

  test("the panel update is a compare-and-swap on the version: a stale save changes no row", async () => {
    const key = await createKey({ name: "Sync", rights: ["messages.read"] });

    const [saved] = await update(key.id, 1, { name: "Sync v2", rights: ["messages.read", "media.url"] });
    assert.equal(saved, 1);
    let row = await fresh(db.ApiKey, key.id);
    assert.deepEqual([row.name, row.nameKey, row.version], ["Sync v2", "sync v2", 2]);
    assert.deepEqual(row.rights, ["messages.read", "media.url"]);
    assertKeyInvariants(row);

    const [stale] = await update(key.id, 1, { name: "Lost update", rights: [] });
    assert.equal(stale, 0, "version 1 is stale");
    row = await fresh(db.ApiKey, key.id);
    assert.deepEqual([row.name, row.rights.length, row.version], ["Sync v2", 2, 2]);

    // a revoked key is not editable, whatever the version
    await revoke(key.id, at(HOUR));
    const [revoked] = await update(key.id, 3, { name: "Zombie", rights: [] });
    assert.equal(revoked, 0);
    assert.equal((await fresh(db.ApiKey, key.id)).name, "Sync v2");
  });

  test("the update column list excludes the usage columns, so a concurrent usage write survives a panel save", async () => {
    const key = await createKey({ name: "Busy" });
    const stale = (await fresh(db.ApiKey, key.id)).get({ plain: true }); // the panel read it: lastUsedAt, lastIp, seenIps empty
    const seen = ["203.0.113.5"];
    await db.ApiKey.update({ lastUsedAt: at(MIN), lastIp: "203.0.113.5", seenIps: seen }, { where: { id: key.id }, silent: true });

    const [saved] = await update(key.id, 1, { ...stale, name: "Busy 2", rights: ["messages.read"] });
    assert.equal(saved, 1);
    const row = await fresh(db.ApiKey, key.id);
    assert.equal(row.name, "Busy 2");
    assert.equal(row.lastUsedAt.getTime(), at(MIN).getTime(), "the stale form did not overwrite the usage write");
    assert.equal(row.lastIp, "203.0.113.5");
    assert.deepEqual(row.seenIps, seen);
    for (const secret of ["lookupId", "secretHash", "last4"]) assert.equal(row[secret], key[secret], `${secret} untouched`);
  });

  test("a usage write with silent: true leaves version and updatedAt unchanged", async () => {
    const key = await createKey({ name: "Quiet" });
    const before_ = await fresh(db.ApiKey, key.id);
    await new Promise((resolve) => setTimeout(resolve, 15)); // a plain write would stamp a later updatedAt

    await db.ApiKey.update({ lastUsedAt: at(MIN), lastIp: "198.51.100.7", seenIps: ["198.51.100.7"] }, { where: { id: key.id }, silent: true });
    const quiet = await fresh(db.ApiKey, key.id);
    assert.equal(quiet.lastIp, "198.51.100.7");
    assert.equal(quiet.version, before_.version);
    assert.equal(quiet.updatedAt.getTime(), before_.updatedAt.getTime(), "updatedAt reflects configuration changes only");

    // the instance form behaves the same
    quiet.lastUsedAt = at(2 * MIN);
    await quiet.save({ silent: true });
    const again = await fresh(db.ApiKey, key.id);
    assert.deepEqual([again.version, again.updatedAt.getTime()], [before_.version, before_.updatedAt.getTime()]);

    // a configuration write does move updatedAt
    await update(key.id, 1, { name: "Quiet 2", rights: [] });
    assert.ok((await fresh(db.ApiKey, key.id)).updatedAt.getTime() > before_.updatedAt.getTime());
  });

  test("the 50-key cap is a count of non-revoked keys under withLock: 60 concurrent creations leave exactly 50", async () => {
    const attempt = (i) =>
      withLock("api-keys", async () => {
        if ((await liveKeys()) >= 50) return false;
        await createKey({ name: `Bulk ${i}` });
        return true;
      });
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => attempt(i)));
    assert.equal(results.filter(Boolean).length, 50);
    assert.equal(await liveKeys(), 50);

    // revoking one frees exactly one slot
    const [victim] = await db.ApiKey.findAll({ limit: 1 });
    await revoke(victim.id, at(HOUR));
    assert.equal(await liveKeys(), 49);
    assert.equal(await attempt(100), true);
    assert.equal(await attempt(101), false);
    assert.equal(await db.ApiKey.count(), 51, "the revoked row stays until the retention purge");
  });

  test("the derived status: revoked over expired over active, an expiry equal to now is expired", async () => {
    const now = at(10 * HOUR);
    const rows = {
      never: await createKey({ name: "never" }),
      future: await createKey({ name: "future", expiresAt: new Date(now.getTime() + 1) }),
      boundary: await createKey({ name: "boundary", expiresAt: now }),
      past: await createKey({ name: "past", expiresAt: new Date(now.getTime() - 1) }),
      revokedFuture: await createKey({ name: "rf", nameKey: null, revokedAt: at(HOUR), expiresAt: at(20 * HOUR) }),
      revokedPast: await createKey({ name: "rp", nameKey: null, revokedAt: at(HOUR), expiresAt: at(2 * HOUR) }),
    };
    const expected = { never: "active", future: "active", boundary: "expired", past: "expired", revokedFuture: "revoked", revokedPast: "revoked" };
    for (const [label, row] of Object.entries(rows)) assert.equal(keyStatus(await fresh(db.ApiKey, row.id), now), expected[label], label);

    // the same classification as a query: what the key store and the panel list evaluate at read time
    const ids = async (where) => (await db.ApiKey.findAll({ where, order: [["id", "ASC"]] })).map((r) => r.name);
    assert.deepEqual(await ids({ revokedAt: { [Op.ne]: null } }), ["rf", "rp"]);
    assert.deepEqual(await ids({ revokedAt: null, expiresAt: { [Op.lte]: now } }), ["boundary", "past"]);
    assert.deepEqual(await ids({ revokedAt: null, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: now } }] }), ["never", "future"]);

    // an expired, non-revoked key stays and keeps its name reserved (the owner may extend it)
    await assert.rejects(createKey({ name: "PAST" }), UniqueConstraintError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ApiMessage: idempotency and wire id (data-model 2.4)", () => {
  const key = { apiKeyId: 1 };

  /** The lookup of the pipeline: the stored row of (key, Idempotency-Key), within 24 hours */
  const lookup = (apiKeyId, idempotencyKey) => db.ApiMessage.findOne({ where: { apiKeyId, idempotencyKey } });
  /** The decision of the two possible hits */
  const decide = (row, requestHash) => (!row ? "new" : row.requestHash === requestHash ? "replay" : "conflict");

  test("the same key and hash is a replay of the stored row; another hash is a conflict; another key is new", async () => {
    const first = await createMessage({ ...key, idempotencyKey: "order-1", requestHash: "h".repeat(32) });
    assertMessageInvariants(await fresh(db.ApiMessage, first.id));

    const hit = await lookup(1, "order-1");
    assert.equal(decide(hit, "h".repeat(32)), "replay");
    assert.equal(hit.publicId, first.publicId, "the stored row is returned, nothing is validated or counted again");
    assert.equal(decide(hit, "x".repeat(32)), "conflict");
    assert.equal(decide(await lookup(2, "order-1"), "h".repeat(32)), "new", "scoped to one key");
    assert.equal(decide(await lookup(1, "order-2"), "h".repeat(32)), "new");
    assert.equal(await db.ApiMessage.count(), 1);
  });

  test("two identical concurrent requests: one INSERT wins, the loser gets the unique violation and replays", async () => {
    const accept = async () => {
      try {
        return { row: await createMessage({ ...key, idempotencyKey: "race", requestHash: "r".repeat(32) }), replayed: false };
      } catch (err) {
        if (!(err instanceof UniqueConstraintError)) throw err;
        return { row: await lookup(1, "race"), replayed: true };
      }
    };
    const [a, b] = await Promise.all([accept(), accept()]);
    assert.equal([a, b].filter((r) => r.replayed).length, 1, "exactly one replay");
    assert.equal(a.row.publicId, b.row.publicId, "both callers see the same message");
    assert.equal(await db.ApiMessage.count({ where: { idempotencyKey: "race" } }), 1);
  });

  test("calls without a key, and every panel row, never collide", async () => {
    await createMessage({ ...key });
    await createMessage({ ...key });
    await createMessage({ source: "panel", apiKeyId: null, idempotencyKey: "same", requestHash: "p".repeat(32) });
    await createMessage({ source: "panel", apiKeyId: null, idempotencyKey: "same", requestHash: "p".repeat(32) });
    assert.equal(await db.ApiMessage.count(), 4);
    for (const row of await db.ApiMessage.findAll()) assertMessageInvariants(row);
  });

  test("the fingerprint is released after 24 hours, lazily on a hit and daily by housekeeping", async () => {
    const old = await createMessage({ ...key, idempotencyKey: "reuse", requestHash: "a".repeat(32) });
    const cutoff = (now) => new Date(now.getTime() - 24 * HOUR);

    // a hit older than 24 h: release both columns of the old row, then the new message takes the key
    const now = at(25 * HOUR);
    const hit = await lookup(1, "reuse");
    assert.ok(hit.acceptedAt.getTime() < cutoff(now).getTime());
    const [released] = await db.ApiMessage.update({ idempotencyKey: null, requestHash: null }, { where: { id: hit.id, acceptedAt: { [Op.lt]: cutoff(now) } } });
    assert.equal(released, 1);
    const next = await createMessage({ ...key, idempotencyKey: "reuse", requestHash: "b".repeat(32), acceptedAt: now, expiresAt: at(26 * HOUR) });
    assertMessageInvariants(await fresh(db.ApiMessage, old.id));
    assertMessageInvariants(await fresh(db.ApiMessage, next.id));
    assert.equal((await lookup(1, "reuse")).id, next.id);

    // the daily step: every row older than 24 h loses both columns, a younger one keeps them
    await createMessage({ ...key, idempotencyKey: "stale", requestHash: "c".repeat(32), acceptedAt: at(HOUR) });
    await createMessage({ ...key, idempotencyKey: "young", requestHash: "d".repeat(32), acceptedAt: at(24 * HOUR), expiresAt: at(25 * HOUR) });
    const [swept] = await db.ApiMessage.update(
      { idempotencyKey: null, requestHash: null },
      { where: { [Op.or]: [{ idempotencyKey: { [Op.ne]: null } }, { requestHash: { [Op.ne]: null } }], acceptedAt: { [Op.lt]: cutoff(at(26 * HOUR)) } } },
    );
    assert.equal(swept, 1);
    assert.equal(await lookup(1, "stale"), null);
    assert.ok(await lookup(1, "young"));
    for (const row of await db.ApiMessage.findAll()) assertMessageInvariants(row);
  });

  test("waId is unique once set; several rows may wait without one", async () => {
    await createMessage({ ...key });
    await createMessage({ ...key });
    const claimed = await createMessage({ ...key, status: "sending", sendingAt: at(SEC), waId: "3EB0AAAAAAAAAAAAAAAAAAAA", payload: null });
    assertMessageInvariants(claimed);
    await assert.rejects(createMessage({ ...key, status: "sending", sendingAt: at(2 * SEC), waId: "3EB0AAAAAAAAAAAAAAAAAAAA" }), UniqueConstraintError);
    assert.equal((await db.ApiMessage.findOne({ where: { waId: "3EB0AAAAAAAAAAAAAAAAAAAA" } })).id, claimed.id, "receipts find a row by the wire id");
    // claiming a queued row onto a taken id changes nothing
    const waiting = await createMessage({ ...key });
    await assert.rejects(db.ApiMessage.update({ status: "sending", sendingAt: at(3 * SEC), waId: "3EB0AAAAAAAAAAAAAAAAAAAA" }, { where: { id: waiting.id, status: "queued" } }), UniqueConstraintError);
    assert.equal((await fresh(db.ApiMessage, waiting.id)).status, "queued");
  });

  test("publicId is unique", async () => {
    const first = await createMessage({ ...key });
    await assert.rejects(createMessage({ ...key, publicId: first.publicId }), UniqueConstraintError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ApiMessage: the status machine T1 to T11 as conditional UPDATEs (data-model 2.5)", () => {
  const POLL_CHOICES = [{ id: "0", label: "Yes" }, { id: "1", label: "No" }];
  const POLL_DATA = { v: 1, multi: false, hashes: ["a".repeat(64), "b".repeat(64)] };
  const WA = (n) => `3EB0${String(n).padStart(20, "0")}`;
  let waCounter = 0;

  /** One conditional UPDATE: `from` is a status or a list of statuses; returns the number of rows changed */
  const move = async (id, from, values, extraWhere = {}) => {
    const [changed] = await db.ApiMessage.update(values, { where: { id, status: Array.isArray(from) ? { [Op.in]: from } : from, ...extraWhere } });
    return changed;
  };
  const check = async (id, options) => {
    const row = await fresh(db.ApiMessage, id);
    assertMessageInvariants(row, options);
    return row;
  };

  // T2: the claim, the point of no return
  const claim = (id, now, extra = {}) =>
    move(id, "queued", { status: "sending", sendingAt: now, waId: WA(++waCounter), ...extra }, { expiresAt: { [Op.gt]: now } });
  // T3: sendMessage resolved
  const sent = (id, now, extra = {}) => move(id, "sending", { status: "sent", sentAt: now, payload: null, ...extra });
  const claimPoll = (id, now) => claim(id, now, { choices: POLL_CHOICES, replyData: POLL_DATA, pollSecret: "enc:v1:iv:tag:cipher" });

  test("T1 acceptance: a queued row holding the payload, nothing else", async () => {
    const row = await createMessage({ idempotencyKey: "k", requestHash: "h".repeat(32), requestId: "0123456789abcdef", size: 5 });
    const stored = await check(row.id);
    assert.equal(stored.status, "queued");
    assert.deepEqual(stored.payload, { v: 1, input: { text: "hello" }, media: null, quote: null });
    for (const column of ["waId", "sendingAt", "sentAt", "deliveredAt", "readAt", "endedAt", "errorCode", "choices", "replyData", "pollSecret", "repliesUntil"]) {
      assert.equal(stored[column], null, column);
    }
  });

  test("T2 the claim writes sendingAt and waId in one UPDATE, only on a queued, unexpired row", async () => {
    const row = await createMessage();
    assert.equal(await claim(row.id, at(11 * MIN)), 0, "expiresAt passed: the claim refuses");
    assert.equal((await fresh(db.ApiMessage, row.id)).status, "queued");

    assert.equal(await claim(row.id, at(MIN)), 1);
    const claimed = await check(row.id);
    assert.equal(claimed.status, "sending");
    assert.ok(claimed.waId && claimed.sendingAt);
    assert.ok(claimed.payload, "the content stays until the message leaves sending");
    assert.equal(await claim(row.id, at(2 * MIN)), 0, "a second claim loses the race");
  });

  test("T2 for an interactive format also writes choices, replyData and pollSecret; a queued poll holds none", async () => {
    const row = await createMessage({ format: "poll", payload: { v: 1, input: { question: "Q", options: ["Yes", "No"] } } });
    await check(row.id);
    assert.equal(await claimPoll(row.id, at(MIN)), 1);
    const claimed = await check(row.id);
    assert.deepEqual(claimed.choices, POLL_CHOICES);
    assert.deepEqual(claimed.replyData, POLL_DATA);
    assert.equal(claimed.repliesUntil, null, "I7: repliesUntil is NULL while sending");
  });

  test("T3 sent erases the payload; delivered and read follow (T9, T10); coalesce keeps an earlier deliveredAt", async () => {
    const row = await createMessage();
    await claim(row.id, at(MIN));
    assert.equal(await sent(row.id, at(2 * MIN)), 1);
    let stored = await check(row.id);
    assert.deepEqual([stored.status, stored.payload], ["sent", null]);
    assert.equal(await sent(row.id, at(3 * MIN)), 0, "T3 only leaves sending");

    // T9
    assert.equal(await move(row.id, ["sent", "unknown"], { status: "delivered", deliveredAt: at(3 * MIN) }), 1);
    stored = await check(row.id);
    assert.deepEqual([stored.status, stored.deliveredAt.getTime(), stored.readAt], ["delivered", at(3 * MIN).getTime(), null]);
    // T10: a read receipt fills deliveredAt only when it is still empty
    const coalesce = (t) => db.DATABASE.fn("COALESCE", db.DATABASE.col("deliveredAt"), t);
    assert.equal(await move(row.id, ["sent", "delivered", "unknown"], { status: "read", readAt: at(4 * MIN), deliveredAt: coalesce(at(4 * MIN)) }), 1);
    stored = await check(row.id);
    assert.deepEqual([stored.status, stored.readAt.getTime(), stored.deliveredAt.getTime()], ["read", at(4 * MIN).getTime(), at(3 * MIN).getTime()]);

    // a read straight from sent sets both times
    const quick = await createMessage();
    await claim(quick.id, at(MIN));
    await sent(quick.id, at(2 * MIN));
    await move(quick.id, ["sent", "delivered", "unknown"], { status: "read", readAt: at(5 * MIN), deliveredAt: coalesce(at(5 * MIN)) });
    stored = await check(quick.id);
    assert.equal(stored.deliveredAt.getTime(), at(5 * MIN).getTime());
    // forward only: delivered never overwrites read
    assert.equal(await move(quick.id, ["sent", "unknown"], { status: "delivered", deliveredAt: at(6 * MIN) }), 0);
  });

  test("T3 for an interactive format sets repliesUntil and keeps the reply material", async () => {
    const row = await createMessage({ format: "buttons", payload: { v: 1, input: { text: "t", buttons: [{ id: "a", label: "A" }] } } });
    await claim(row.id, at(MIN), { choices: [{ id: "a", label: "A" }] });
    assert.equal(await sent(row.id, at(2 * MIN), { repliesUntil: at(7 * 24 * HOUR) }), 1);
    const stored = await check(row.id);
    assert.deepEqual(stored.choices, [{ id: "a", label: "A" }]);
    assert.equal(stored.repliesUntil.getTime(), at(7 * 24 * HOUR).getTime());
    assert.equal(stored.payload, null);
  });

  test("T4 expiry: the bulk sweep takes only queued rows whose expiresAt passed and erases their payload", async () => {
    const due1 = await createMessage({ expiresAt: at(5 * MIN) });
    const due2 = await createMessage({ expiresAt: at(10 * MIN) });
    const waiting = await createMessage({ expiresAt: at(30 * MIN) });
    const inFlight = await createMessage({ expiresAt: at(5 * MIN) });
    await claim(inFlight.id, at(MIN));

    const now = at(11 * MIN);
    const [changed] = await db.ApiMessage.update(
      { status: "expired", endedAt: now, payload: null },
      { where: { status: "queued", expiresAt: { [Op.lte]: now } } },
    );
    assert.equal(changed, 2);
    for (const id of [due1.id, due2.id]) {
      const row = await check(id);
      assert.deepEqual([row.status, row.payload, row.errorCode, row.endedAt.getTime()], ["expired", null, null, now.getTime()]);
    }
    assert.equal((await check(waiting.id)).status, "queued");
    assert.equal((await check(inFlight.id)).status, "sending", "a sending row is never expired");
  });

  test("T5 cancellation takes queued rows only, with the reason; a sending row is never cancelled", async () => {
    const queued = await createMessage();
    const sending = await createMessage();
    await claim(sending.id, at(MIN));

    const cancel = (id, code) => move(id, "queued", { status: "cancelled", endedAt: at(2 * MIN), errorCode: code, payload: null });
    assert.equal(await cancel(sending.id, "key_revoked"), 0);
    assert.equal(await cancel(queued.id, "key_revoked"), 1);
    const row = await check(queued.id);
    assert.deepEqual([row.status, row.errorCode, row.payload], ["cancelled", "key_revoked", null]);
    assert.equal((await check(sending.id)).status, "sending");
    assert.equal(await cancel(queued.id, "api_disabled"), 0, "a second cancel is a lost race, ignored");
    assert.equal((await fresh(db.ApiMessage, queued.id)).errorCode, "key_revoked");
  });

  test("T6 a definitive failure before the claim ends the row and erases the payload", async () => {
    const row = await createMessage();
    assert.equal(await move(row.id, "queued", { status: "failed", endedAt: at(MIN), errorCode: "not_on_whatsapp", payload: null }), 1);
    const stored = await check(row.id);
    assert.deepEqual([stored.status, stored.errorCode, stored.payload, stored.waId], ["failed", "not_on_whatsapp", null, null]);
  });

  test("T7 send_failed erases the payload and the reply material of a poll nobody can answer", async () => {
    const row = await createMessage({ format: "poll", payload: { v: 1, input: { question: "Q", options: ["Yes", "No"] } } });
    await claimPoll(row.id, at(MIN));
    assert.equal(
      await move(row.id, "sending", { status: "failed", endedAt: at(2 * MIN), errorCode: "send_failed", payload: null, choices: null, replyData: null, pollSecret: null, repliesUntil: null }),
      1,
    );
    const stored = await check(row.id);
    assert.deepEqual([stored.status, stored.choices, stored.replyData, stored.pollSecret, stored.repliesUntil], ["failed", null, null, null, null]);
    assert.ok(stored.waId, "the id WhatsApp may have seen is kept");
  });

  test("T8 unknown (timeout, interrupted) keeps the reply material of an interactive message and the wire id", async () => {
    const plainRow = await createMessage();
    await claim(plainRow.id, at(MIN));
    assert.equal(await move(plainRow.id, "sending", { status: "unknown", endedAt: at(2 * MIN), errorCode: "timeout", payload: null }), 1);
    const plainStored = await check(plainRow.id);
    assert.deepEqual([plainStored.status, plainStored.errorCode, plainStored.payload, plainStored.sentAt], ["unknown", "timeout", null, null]);
    assert.ok(plainStored.waId);

    const poll = await createMessage({ format: "poll", payload: { v: 1, input: { question: "Q", options: ["Yes", "No"] } } });
    await claimPoll(poll.id, at(MIN));
    await move(poll.id, "sending", { status: "unknown", endedAt: at(2 * MIN), errorCode: "interrupted", payload: null, repliesUntil: at(7 * 24 * HOUR) });
    const pollStored = await check(poll.id);
    assert.deepEqual(pollStored.choices, POLL_CHOICES);
    assert.ok(pollStored.pollSecret && pollStored.repliesUntil, "the message may have left: answers are still captured");
  });

  test("T9 a late receipt upgrades unknown: endedAt and errorCode are cleared, sentAt stays empty", async () => {
    const row = await createMessage();
    await claim(row.id, at(MIN));
    await move(row.id, "sending", { status: "unknown", endedAt: at(2 * MIN), errorCode: "connection_closed", payload: null });
    assert.equal(await move(row.id, ["sent", "unknown"], { status: "delivered", deliveredAt: at(3 * MIN), endedAt: null, errorCode: null }), 1);
    const stored = await check(row.id);
    assert.deepEqual([stored.status, stored.endedAt, stored.errorCode, stored.sentAt], ["delivered", null, null, null]);
    assert.equal(await move(row.id, "unknown", { status: "delivered" }), 0, "no longer unknown");
  });

  test("T10 a read receipt upgrades unknown the same way", async () => {
    const row = await createMessage();
    await claim(row.id, at(MIN));
    await move(row.id, "sending", { status: "unknown", endedAt: at(2 * MIN), errorCode: "interrupted", payload: null });
    const coalesce = db.DATABASE.fn("COALESCE", db.DATABASE.col("deliveredAt"), at(4 * MIN));
    assert.equal(await move(row.id, ["sent", "delivered", "unknown"], { status: "read", readAt: at(4 * MIN), deliveredAt: coalesce, endedAt: null, errorCode: null }), 1);
    const stored = await check(row.id);
    assert.deepEqual([stored.status, stored.endedAt, stored.errorCode, stored.deliveredAt.getTime()], ["read", null, null, at(4 * MIN).getTime()]);
  });

  test("T11 a negative acknowledgement fails a sent or unknown row, the one non-monotone move, and erases the reply material", async () => {
    const sentPoll = await createMessage({ format: "poll", payload: { v: 1, input: { question: "Q", options: ["Yes", "No"] } } });
    await claimPoll(sentPoll.id, at(MIN));
    await sent(sentPoll.id, at(2 * MIN), { repliesUntil: at(7 * 24 * HOUR) });
    const reject = (id) =>
      move(id, ["sent", "unknown"], { status: "failed", endedAt: at(3 * MIN), errorCode: "whatsapp_rejected", choices: null, replyData: null, pollSecret: null, repliesUntil: null });
    assert.equal(await reject(sentPoll.id), 1);
    const stored = await check(sentPoll.id);
    assert.deepEqual([stored.status, stored.errorCode, stored.choices, stored.repliesUntil], ["failed", "whatsapp_rejected", null, null]);

    const delivered = await createMessage();
    await claim(delivered.id, at(MIN));
    await sent(delivered.id, at(2 * MIN));
    await move(delivered.id, "sent", { status: "delivered", deliveredAt: at(3 * MIN) });
    assert.equal(await reject(delivered.id), 0, "a delivered message is not failed by a late nack");

    const unknown = await createMessage();
    await claim(unknown.id, at(MIN));
    await move(unknown.id, "sending", { status: "unknown", endedAt: at(2 * MIN), errorCode: "timeout", payload: null });
    assert.equal(await reject(unknown.id), 1);
    await check(unknown.id);
  });

  test("claim against cancel: the CAS lets exactly one win, in either order and concurrently", async () => {
    const cancel = (id) => move(id, "queued", { status: "cancelled", endedAt: at(MIN), errorCode: "key_revoked", payload: null });
    const outcomes = {};
    for (const order of ["claim first", "cancel first", "together"]) {
      const row = await createMessage();
      let claimed;
      let cancelled;
      if (order === "claim first") {
        claimed = await claim(row.id, at(MIN));
        cancelled = await cancel(row.id);
      } else if (order === "cancel first") {
        cancelled = await cancel(row.id);
        claimed = await claim(row.id, at(MIN));
      } else {
        [claimed, cancelled] = await Promise.all([claim(row.id, at(MIN)), cancel(row.id)]);
      }
      assert.equal(claimed + cancelled, 1, `${order}: exactly one statement changes the row`);
      const stored = await check(row.id);
      assert.equal(stored.status, claimed ? "sending" : "cancelled", order);
      outcomes[order] = stored.status;
    }
    assert.deepEqual([outcomes["claim first"], outcomes["cancel first"]], ["sending", "cancelled"]);
  });

  test("a group stays at sent: the invariants flag delivered and read for an @g.us recipient", async () => {
    const row = await createMessage({ recipient: GROUP });
    await claim(row.id, at(MIN));
    await sent(row.id, at(2 * MIN));
    await check(row.id);
    // the engine never writes a group receipt; if one slipped in, I9 would flag it
    await move(row.id, "sent", { status: "delivered", deliveredAt: at(3 * MIN) });
    const bad = await fresh(db.ApiMessage, row.id);
    assert.throws(() => assertMessageInvariants(bad), /I9/);
  });

  test("a terminal row holding its mediaPath is a deletion pending: tolerated only on request (I6)", async () => {
    const row = await createMessage({ mediaPath: `data/api-media/msg_x/source`, format: "image" });
    await claim(row.id, at(MIN));
    await sent(row.id, at(2 * MIN));
    const stored = await fresh(db.ApiMessage, row.id);
    assert.throws(() => assertMessageInvariants(stored), /I6/);
    assertMessageInvariants(stored, { pendingMedia: true });
    await move(row.id, "sent", { mediaPath: null });
    await check(row.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("assertMessageInvariants and assertKeyInvariants refuse each violation", () => {
  const base = () => ({
    id: 1, publicId: "msg_AAAAAAAAAAAAAAAAAAAAAA", apiKeyId: 1, source: "api", idempotencyKey: null, requestHash: null,
    recipient: PN, format: "text", status: "sent", errorCode: null, waId: "3EB0X", acceptedAt: T0,
    sendingAt: at(SEC), sentAt: at(2 * SEC), deliveredAt: null, readAt: null, endedAt: null, repliesUntil: null,
    payload: null, choices: null, replyData: null, pollSecret: null, mediaPath: null,
  });

  test("a consistent row passes, as a plain object and as an instance", () => {
    assertMessageInvariants(base());
    assertMessageInvariants(db.ApiMessage.build(base()));
    assertMessageInvariants({ ...base(), status: "queued", waId: null, sendingAt: null, sentAt: null, payload: { v: 1 } });
    assertMessageInvariants({ ...base(), format: "poll", choices: [{ id: "0", label: "A" }], replyData: { v: 1 }, pollSecret: "enc:v1:x", repliesUntil: at(HOUR) });
    assertMessageInvariants({ ...base(), recipient: GROUP });
  });

  const MUTATIONS = [
    ["I1 an ended status without endedAt", { status: "failed" }, /I1/],
    ["I1 endedAt on a live status", { endedAt: at(3 * SEC) }, /I1/],
    ["I2 payload on a sent row", { payload: { v: 1 } }, /I2/],
    ["I3 a queued row with a waId", { status: "queued", sendingAt: null, sentAt: null }, /I3/],
    ["I3 a queued row with choices", { status: "queued", waId: null, sendingAt: null, sentAt: null, format: "list", choices: [] }, /I3/],
    ["I4 waId without sendingAt", { sendingAt: null }, /I4/],
    ["I4 sendingAt without waId", { waId: null }, /I4/],
    ["I4 sent without sentAt", { sentAt: null }, /I4/],
    ["I4 delivered without deliveredAt", { status: "delivered" }, /I4/],
    ["I4 read without readAt", { status: "read", deliveredAt: at(3 * SEC) }, /I4/],
    ["I5 sendingAt before acceptedAt", { sendingAt: at(-SEC), sentAt: at(SEC) }, /I5/],
    ["I5 sentAt before sendingAt", { sentAt: at(0) }, /I5/],
    ["I5 endedAt before acceptedAt", { status: "unknown", sentAt: null, endedAt: at(-SEC) }, /I5/],
    ["I6 a mediaPath on a sent row", { mediaPath: "data/api-media/x/source" }, /I6/],
    ["I7 reply material on a text message", { choices: [{ id: "a", label: "A" }] }, /I7/],
    ["I7 reply material on a failed row", { format: "buttons", status: "failed", endedAt: at(3 * SEC), choices: [{ id: "a", label: "A" }] }, /I7/],
    ["I7 replyData on a buttons message", { format: "buttons", replyData: { v: 1 } }, /I7/],
    ["I7 repliesUntil while sending", { format: "buttons", status: "sending", sentAt: null, repliesUntil: at(HOUR) }, /I7/],
    ["I8 source api without a key", { apiKeyId: null }, /I8/],
    ["I8 source panel with a key", { source: "panel" }, /I8/],
    ["I8 idempotencyKey without requestHash", { idempotencyKey: "k" }, /I8/],
    ["I8 requestHash without idempotencyKey", { requestHash: "h" }, /I8/],
    ["I9 a group delivered", { recipient: GROUP, status: "delivered", deliveredAt: at(3 * SEC) }, /I9/],
    ["I9 a group with a readAt", { recipient: GROUP, readAt: at(3 * SEC) }, /I9/],
  ];
  for (const [name, change, pattern] of MUTATIONS) {
    test(name, () => assert.throws(() => assertMessageInvariants({ ...base(), ...change }), pattern));
  }

  test("assertKeyInvariants: revokedAt and nameKey go together, nameKey is the lower-cased name", () => {
    const key = { id: 1, name: "Billing", nameKey: "billing", revokedAt: null, version: 1 };
    assertKeyInvariants(key);
    assertKeyInvariants({ ...key, nameKey: null, revokedAt: T0, version: 2 });
    assert.throws(() => assertKeyInvariants({ ...key, revokedAt: T0 }), /nameKey/);
    assert.throws(() => assertKeyInvariants({ ...key, nameKey: null }), /nameKey/);
    assert.throws(() => assertKeyInvariants({ ...key, nameKey: "Billing" }), /lowerCase|toLowerCase/);
    assert.throws(() => assertKeyInvariants({ ...key, version: 0 }), /version/);
  });

  test("keyStatus: revoked over expired over active", () => {
    const now = at(HOUR);
    assert.equal(keyStatus({ revokedAt: T0, expiresAt: at(-HOUR) }, now), "revoked");
    assert.equal(keyStatus({ revokedAt: null, expiresAt: now }, now), "expired");
    assert.equal(keyStatus({ revokedAt: null, expiresAt: at(HOUR + 1) }, now), "active");
    assert.equal(keyStatus({ revokedAt: null, expiresAt: null }, now.getTime()), "active");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ApiMessageResponse: the recording rules (data-model 3.2)", () => {
  const CAP = 1000;
  const choices = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }, { id: "c", label: "Gamma" }];

  /**
   * The statements reply capture issues. Returns "recorded" or "ignored"; a message past its window, over the cap or
   * unknown is consumed by the caller and not recorded here.
   */
  async function record(message, event, now) {
    if (!message || !message.repliesUntil || now.getTime() > message.repliesUntil.getTime()) return "ignored";
    if ((await db.ApiMessageResponse.count({ where: { messageId: message.id } })) >= CAP) return "ignored";
    const known = new Set(message.choices.map((c) => c.id));
    const choiceIds = event.choiceIds.filter((id) => known.has(id));
    const author = message.recipient.endsWith("@g.us") ? event.author : message.recipient;

    if (event.kind === "choice") {
      if (choiceIds.length !== 1) return "ignored";
      try {
        await db.ApiMessageResponse.create({ messageId: message.id, kind: "choice", author, choiceIds, via: event.via, sourceId: event.sourceId, respondedAt: event.at });
        return "recorded";
      } catch (err) {
        if (err instanceof UniqueConstraintError) return "ignored"; // a redelivered event
        throw err;
      }
    }

    const [changed] = await db.ApiMessageResponse.update(
      { choiceIds, sourceId: event.sourceId, respondedAt: event.at },
      { where: { messageId: message.id, voterKey: author, respondedAt: { [Op.lte]: event.at } } },
    );
    if (changed) return "recorded";
    try {
      await db.ApiMessageResponse.create({ messageId: message.id, kind: "vote", author, voterKey: author, choiceIds, sourceId: event.sourceId, respondedAt: event.at });
      return "recorded";
    } catch (err) {
      if (err instanceof UniqueConstraintError) return "ignored"; // a newer vote exists, or a concurrent insert
      throw err;
    }
  }

  const interactive = (over = {}) => createMessage({ format: "buttons", status: "sent", sendingAt: at(SEC), waId: `3EB0${++seq}`, sentAt: at(2 * SEC), payload: null, choices, repliesUntil: at(7 * 24 * HOUR), ...over });
  const tap = (id, sourceId, ms, over = {}) => ({ kind: "choice", choiceIds: [id], via: "tap", sourceId, author: PN2, at: at(ms), ...over });
  const vote = (ids, sourceId, ms, over = {}) => ({ kind: "vote", choiceIds: ids, sourceId, author: PN2, at: at(ms), ...over });
  const rows = (messageId) => db.ApiMessageResponse.findAll({ where: { messageId }, order: [["id", "ASC"]] });

  test("a choice is append-only: the same person may answer twice and both rows are kept", async () => {
    const message = await interactive();
    assert.equal(await record(message, tap("a", "S1", 10 * SEC), at(MIN)), "recorded");
    assert.equal(await record(message, tap("b", "S2", 20 * SEC), at(MIN)), "recorded");
    const stored = await rows(message.id);
    assert.deepEqual(stored.map((r) => [r.kind, r.choiceIds, r.via, r.voterKey]), [["choice", ["a"], "tap", null], ["choice", ["b"], "tap", null]]);
    for (const row of stored) assert.ok(Array.isArray(row.choiceIds));
    assert.deepEqual(stored.map((r) => r.respondedAt.getTime()), [at(10 * SEC).getTime(), at(20 * SEC).getTime()], "the reply's own time");
  });

  test("a redelivered event cannot double-count (messageId, sourceId)", async () => {
    const message = await interactive();
    assert.equal(await record(message, tap("a", "S1", 10 * SEC), at(MIN)), "recorded");
    assert.equal(await record(message, tap("a", "S1", 10 * SEC), at(MIN)), "ignored");
    assert.equal((await rows(message.id)).length, 1);
    // numbered answers carry the id of the reply message
    assert.equal(await record(message, tap("b", "S2", 11 * SEC, { via: "number" }), at(MIN)), "recorded");
    assert.equal((await rows(message.id))[1].via, "number");
  });

  test("a vote replaces the previous one: one row per voter, the latest selection wins", async () => {
    const message = await interactive({ format: "poll" });
    assert.equal(await record(message, vote(["a"], "V1", 10 * SEC), at(MIN)), "recorded");
    assert.equal(await record(message, vote(["a", "c"], "V2", 20 * SEC), at(MIN)), "recorded");
    let stored = await rows(message.id);
    assert.equal(stored.length, 1);
    assert.deepEqual([stored[0].kind, stored[0].choiceIds, stored[0].sourceId, stored[0].voterKey, stored[0].via], ["vote", ["a", "c"], "V2", PN, null]);

    // a vote cleared is an empty selection, still one row
    assert.equal(await record(message, vote([], "V3", 30 * SEC), at(MIN)), "recorded");
    stored = await rows(message.id);
    assert.deepEqual([stored.length, stored[0].choiceIds], [1, []]);

    // two voters are two rows
    const group = await interactive({ format: "poll", recipient: GROUP });
    await record(group, vote(["a"], "G1", 10 * SEC, { author: "237690000010@s.whatsapp.net" }), at(MIN));
    await record(group, vote(["b"], "G2", 11 * SEC, { author: "237690000011@s.whatsapp.net" }), at(MIN));
    assert.equal((await rows(group.id)).length, 2);
  });

  test("a stale vote never overwrites a newer one (the respondedAt guard, then the unique violation)", async () => {
    const message = await interactive({ format: "poll" });
    await record(message, vote(["b"], "V-new", 50 * SEC), at(MIN));
    assert.equal(await record(message, vote(["a"], "V-old", 10 * SEC), at(MIN)), "ignored");
    const stored = await rows(message.id);
    assert.deepEqual([stored.length, stored[0].choiceIds, stored[0].sourceId], [1, ["b"], "V-new"]);
    // the same event delivered again is harmless
    assert.equal(await record(message, vote(["b"], "V-new", 50 * SEC), at(MIN)), "recorded");
    assert.equal((await rows(message.id)).length, 1);
  });

  test("ids absent from the message's choices are dropped before the write", async () => {
    const message = await interactive({ format: "poll" });
    assert.equal(await record(message, vote(["a", "zzz", "c"], "V1", 10 * SEC), at(MIN)), "recorded");
    assert.deepEqual((await rows(message.id))[0].choiceIds, ["a", "c"]);
    const buttons = await interactive();
    assert.equal(await record(buttons, tap("zzz", "S1", 10 * SEC), at(MIN)), "ignored", "a choice with no known id is not recorded");
    assert.equal((await rows(buttons.id)).length, 0);
  });

  test("in a private chat the author is forced to the recipient, in a group it is the participant", async () => {
    const privateChat = await interactive({ recipient: PN });
    await record(privateChat, tap("a", "S1", 10 * SEC, { author: "99999999999999@lid" }), at(MIN));
    assert.equal((await rows(privateChat.id))[0].author, PN);

    const poll = await interactive({ format: "poll", recipient: PN });
    await record(poll, vote(["a"], "V1", 10 * SEC, { author: "99999999999999@lid" }), at(MIN));
    await record(poll, vote(["b"], "V2", 20 * SEC, { author: PN }), at(MIN));
    const votes = await rows(poll.id);
    assert.deepEqual([votes.length, votes[0].author, votes[0].voterKey, votes[0].choiceIds], [1, PN, PN, ["b"]], "a LID and a PN voter are one person in a private chat");

    const group = await interactive({ recipient: GROUP });
    await record(group, tap("a", "S1", 10 * SEC, { author: "237690000010@s.whatsapp.net" }), at(MIN));
    assert.equal((await rows(group.id))[0].author, "237690000010@s.whatsapp.net");
  });

  test("nothing is recorded after repliesUntil, without one, or for a missing message", async () => {
    const message = await interactive({ repliesUntil: at(HOUR) });
    assert.equal(await record(message, tap("a", "S1", 10 * SEC), at(HOUR)), "recorded", "the boundary is inside the window");
    assert.equal(await record(message, tap("a", "S2", 11 * SEC), at(HOUR + 1)), "ignored");
    const unset = await interactive({ repliesUntil: null });
    assert.equal(await record(unset, tap("a", "S3", 10 * SEC), at(MIN)), "ignored");
    assert.equal(await record(null, tap("a", "S4", 10 * SEC), at(MIN)), "ignored");
    assert.equal(await db.ApiMessageResponse.count(), 1);
  });

  test("a message holds at most 1000 responses; the extra is ignored", async () => {
    const message = await interactive();
    await db.ApiMessageResponse.bulkCreate(
      Array.from({ length: CAP - 1 }, (_, i) => ({ messageId: message.id, kind: "choice", author: PN, choiceIds: ["a"], via: "tap", sourceId: `bulk-${i}`, respondedAt: at(i) })),
    );
    assert.equal(await record(message, tap("a", "last", 5 * SEC), at(MIN)), "recorded");
    assert.equal(await db.ApiMessageResponse.count({ where: { messageId: message.id } }), CAP);
    assert.equal(await record(message, tap("b", "over", 6 * SEC), at(MIN)), "ignored");
    assert.equal(await db.ApiMessageResponse.count({ where: { messageId: message.id } }), CAP);
    // another message is unaffected
    const other = await interactive();
    assert.equal(await record(other, tap("a", "o1", SEC), at(MIN)), "recorded");
  });

  test("the unique key is per message: the same voter and source id on two messages are fine", async () => {
    const one = await interactive({ format: "poll" });
    const two = await interactive({ format: "poll" });
    assert.equal(await record(one, vote(["a"], "SAME", 10 * SEC), at(MIN)), "recorded");
    assert.equal(await record(two, vote(["a"], "SAME", 10 * SEC), at(MIN)), "recorded");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ApiState and the model literals", () => {
  test("ApiState is a single row id 1: a second id is refused, the first write is an upsert", async () => {
    assert.equal(await db.ApiState.count(), 0, "no row until a write");
    await db.ApiState.upsert({ id: 1, enabled: true, plainHttpFrom: ["10.0.0.0/8"] });
    await db.ApiState.upsert({ id: 1, enabled: false, plainHttpFrom: [] });
    assert.equal(await db.ApiState.count(), 1);
    const row = await db.ApiState.findByPk(1);
    assert.deepEqual([row.enabled, row.plainHttpFrom], [false, []]);
    await assert.rejects(db.ApiState.upsert({ id: 2, enabled: true }), /Validation/);
    assert.equal(await db.ApiState.count(), 1);
  });

  // The models repeat literals because they cannot import an engine constant (data-model 0.1): pin that they agree
  // with the engine modules that exist, once those do.
  const errorsFile = path.join(__dirname, "..", "lib", "messaging", "errors.js");
  test("ApiMessage.status lists the nine statuses of lib/messaging/errors.js", { skip: !fs.existsSync(errorsFile) && "lib/messaging/errors.js not delivered yet" }, () => {
    const { STATUSES } = require(errorsFile);
    assert.deepEqual([...db.ApiMessage.rawAttributes.status.validate.isIn[0]].sort(), [...STATUSES].sort());
  });

  test("ApiKey.policyMode lists the three recipient policies", () => {
    assert.deepEqual([...db.ApiKey.rawAttributes.policyMode.validate.isIn[0]], ["list", "known", "anyone"]);
  });
});
