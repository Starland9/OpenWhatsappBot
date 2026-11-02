"use strict";
/**
 * Key store of the messaging API (feature 004, contracts/runtime.md section 15.7 and 18, data-model.md 1.7): token
 * shape, secret generation, constant-time verification, the `api_keys` cache and its invalidation, the fail-closed
 * load, the usage write-behind with the new-origin alert, and the built-in redaction of a token. The models are the
 * real ones on an in-memory database; alerts, the cache instance and the clock are injected.
 */

const { test, describe, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const kit = require("./helpers/backupKit");
const { createKeyStore, TOKEN_PATTERN, USAGE_WRITE_MS } = require("../lib/api/keyStore");
const SettingsCache = require("../lib/utils/settingsCache").constructor;
const redactor = require("../lib/admin/logs/redactor");

let db;
before(async () => {
  db = await kit.makeDb();
});
after(async () => {
  if (db) await db.DATABASE.close();
});
beforeEach(async () => {
  await db.ApiKey.destroy({ where: {} });
  redactor.clear();
});

const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);

function harness() {
  const clock = { t: T0 };
  const alerts = { calls: [], raise: async (type, payload) => alerts.calls.push({ type, payload }) };
  const cache = new SettingsCache();
  const store = createKeyStore({ models: db, settingsCache: cache, now: () => clock.t, alerts });
  return { clock, alerts, cache, store };
}

let seq = 0;
/** Insert a key row for a token made by the store; returns { token, row } */
async function makeKey(store, over = {}) {
  const made = store.generateSecret();
  const n = ++seq;
  const row = await db.ApiKey.create({
    name: over.name || `Key ${n}`,
    nameKey: over.revokedAt ? null : (over.name || `Key ${n}`).toLowerCase(),
    lookupId: made.lookupId,
    secretHash: made.secretHash,
    last4: made.last4,
    ...over,
  });
  return { token: made.secret, row, made };
}

describe("generateSecret and parseToken", () => {
  test("a token is owbk_ + 16 hex + _ + 43 base64url characters (65 in all)", () => {
    const { store } = harness();
    const made = store.generateSecret();
    assert.equal(made.secret.length, 65);
    assert.match(made.secret, TOKEN_PATTERN);
    assert.match(made.secret, /^owbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    assert.equal(made.lookupId, made.secret.slice(5, 21));
    assert.equal(made.last4, made.secret.slice(-4));
  });

  test("secretHash is the lower-case hex SHA-256 of the 43-character secret string", () => {
    const { store } = harness();
    const made = store.generateSecret();
    const part = made.secret.slice(22);
    assert.equal(part.length, 43);
    assert.equal(made.secretHash, crypto.createHash("sha256").update(part).digest("hex"));
    assert.match(made.secretHash, /^[0-9a-f]{64}$/);
  });

  test("secrets are unique and spread over the alphabet (2,000 draws, no repeated id or secret)", () => {
    const { store } = harness();
    const ids = new Set();
    const hashes = new Set();
    const chars = new Set();
    for (let i = 0; i < 2000; i++) {
      const made = store.generateSecret();
      ids.add(made.lookupId);
      hashes.add(made.secretHash);
      for (const c of made.secret.slice(22)) chars.add(c);
    }
    assert.equal(ids.size, 2000);
    assert.equal(hashes.size, 2000);
    assert.ok(chars.size > 50, `base64url alphabet used (${chars.size} symbols seen)`);
  });

  test("parseToken is a shape check only", () => {
    const { store } = harness();
    const made = store.generateSecret();
    assert.deepEqual(store.parseToken(made.secret), { lookupId: made.lookupId, secret: made.secret.slice(22) });
    const unknownButWellFormed = `owbk_${"0".repeat(16)}_${"A".repeat(43)}`;
    assert.deepEqual(store.parseToken(unknownButWellFormed), { lookupId: "0".repeat(16), secret: "A".repeat(43) });
    const bad = [
      undefined, null, 42, {}, "", "owbk_", made.secret.slice(0, 64), `${made.secret}x`, ` ${made.secret}`, `${made.secret}\n`,
      made.secret.replace("owbk_", "OWBK_"), made.secret.replace("owbk_", "owbx_"),
      `owbk_${"G".repeat(16)}_${"A".repeat(43)}`, `owbk_${"a".repeat(15)}_${"A".repeat(44)}`, `owbk_${"a".repeat(16)}_${"A".repeat(42)}+`,
      `owbk_${"a".repeat(16)}-${"A".repeat(43)}`, `Bearer ${made.secret}`,
    ];
    for (const text of bad) assert.equal(store.parseToken(text), null, JSON.stringify(text));
  });
});

describe("lookup", () => {
  test("malformed, unknown, mismatch and ok", async () => {
    const { store } = harness();
    const { token, row } = await makeKey(store, { rights: ["messages.read"] });
    assert.deepEqual(await store.lookup("nonsense"), { status: "malformed" });
    assert.deepEqual(await store.lookup(undefined), { status: "malformed" });
    const unknown = `owbk_${"0".repeat(16)}_${"A".repeat(43)}`;
    assert.deepEqual(await store.lookup(unknown), { status: "unknown" });
    const wrong = `${token.slice(0, 22)}${"B".repeat(43)}`;
    assert.deepEqual(await store.lookup(wrong), { status: "mismatch" });
    const ok = await store.lookup(token);
    assert.equal(ok.status, "ok");
    assert.equal(ok.key.id, row.id);
    assert.equal(ok.key.name, row.name);
  });

  test("the KeyRecord carries the parsed configuration of the row", async () => {
    const { store } = harness();
    const expiresAt = new Date(T0 + 86400000);
    const { token, row } = await makeKey(store, {
      rights: ["messages.send.text", "messages.read"],
      policyMode: "list",
      recipients: ["237690000001@s.whatsapp.net", "120363025246125486@g.us"],
      limitPerMinute: 5,
      limitPerDay: null,
      limitPending: 7,
      ipAllow: ["10.0.0.0/8", "203.0.113.9"],
      expiresAt,
      seenIps: ["1.2.3.4"],
    });
    const { key } = await store.lookup(token);
    assert.equal(key.id, row.id);
    assert.ok(key.rights instanceof Set);
    assert.deepEqual([...key.rights].sort(), ["messages.read", "messages.send.text"]);
    assert.deepEqual(key.policy, { mode: "list", entries: ["237690000001@s.whatsapp.net", "120363025246125486@g.us"] });
    assert.deepEqual(key.limits, { perMinute: 5, perDay: null, maxPending: 7 });
    assert.equal(key.expiresAtMs, expiresAt.getTime());
    assert.equal(key.revokedAtMs, null);
    assert.ok(key.seenIps instanceof Set);
    assert.deepEqual([...key.seenIps], ["1.2.3.4"]);
    assert.equal(key.ipAllow.check("10.9.9.9"), true);
    assert.equal(key.ipAllow.check("203.0.113.9"), true);
    assert.equal(key.ipAllow.check("203.0.113.10"), false);
    assert.equal(key.secretHash, row.secretHash);
  });

  test("an empty allowlist means no restriction; a damaged one fails closed", async () => {
    const { store } = harness();
    const open = await makeKey(store, { ipAllow: [] });
    const damaged = await makeKey(store, { ipAllow: ["not-an-ip"] });
    assert.equal((await store.lookup(open.token)).key.ipAllow.check("203.0.113.9"), true);
    assert.equal((await store.lookup(damaged.token)).key.ipAllow.check("203.0.113.9"), false);
  });

  test("a revoked or expired key is returned only to the right secret (the pipeline decides the state)", async () => {
    const { store } = harness();
    const revoked = await makeKey(store, { revokedAt: new Date(T0 - 1000) });
    const expired = await makeKey(store, { expiresAt: new Date(T0 - 1000) });
    assert.equal((await store.lookup(revoked.token)).key.revokedAtMs, T0 - 1000);
    assert.equal((await store.lookup(expired.token)).key.expiresAtMs, T0 - 1000);
    const wrong = `${revoked.token.slice(0, 22)}${"C".repeat(43)}`;
    assert.deepEqual(await store.lookup(wrong), { status: "mismatch" }, "a wrong secret never learns the key is revoked");
  });

  test("unknown id, wrong secret and right secret run the same comparison (constant time, no early return)", async () => {
    const { store } = harness();
    const { token } = await makeKey(store);
    const spy = mock.method(crypto, "timingSafeEqual");
    try {
      await store.lookup(`owbk_${"0".repeat(16)}_${"A".repeat(43)}`);
      await store.lookup(`${token.slice(0, 22)}${"B".repeat(43)}`);
      await store.lookup(token);
      assert.equal(spy.mock.callCount(), 3, "one timingSafeEqual per well-formed token, whatever the outcome");
      for (const call of spy.mock.calls) {
        assert.equal(call.arguments[0].length, 32);
        assert.equal(call.arguments[1].length, 32);
      }
      await store.lookup("malformed");
      assert.equal(spy.mock.callCount(), 3, "a malformed token costs nothing (no database, no hash)");
    } finally {
      spy.mock.restore();
    }
  });

  test("never logs a token, a secret or a lookup id", async () => {
    const lines = [];
    const logger = new Proxy({}, { get: () => (...args) => lines.push(JSON.stringify(args)) });
    const cache = new SettingsCache();
    const store = createKeyStore({ models: db, settingsCache: cache, logger });
    const { token } = await makeKey(store);
    const realWrite = process.stdout.write.bind(process.stdout);
    const captured = [];
    process.stdout.write = (chunk, ...rest) => (captured.push(String(chunk)), true);
    try {
      await store.lookup(token);
      await store.lookup(`${token.slice(0, 22)}${"B".repeat(43)}`);
      await store.touch((await store.lookup(token)).key, { ip: "10.0.0.1", origin: "10.0.0.1", at: T0 });
    } finally {
      process.stdout.write = realWrite;
    }
    const text = lines.join("\n") + captured.join("");
    assert.ok(!text.includes(token.slice(5, 21)), "no lookup id");
    assert.ok(!text.includes(token.slice(22)), "no secret");
  });
});

describe("the api_keys cache", () => {
  test("rows are loaded once for 5 minutes under the key api_keys, revoked rows included", async () => {
    const { store, cache } = harness();
    const { token } = await makeKey(store);
    const revoked = await makeKey(store, { revokedAt: new Date(T0) });
    const spy = mock.method(db.ApiKey, "findAll");
    try {
      await store.lookup(token);
      await store.lookup(token);
      await store.lookup(revoked.token);
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
    const entry = cache.cache.get("api_keys");
    assert.equal(entry.ttl, 5 * 60 * 1000);
    assert.equal(entry.value.size, 2);
  });

  test("a revocation applies to the very next request once the writer invalidates", async () => {
    const { store } = harness();
    const { token, row } = await makeKey(store);
    assert.equal((await store.lookup(token)).key.revokedAtMs, null);

    await db.ApiKey.update({ revokedAt: new Date(T0), nameKey: null }, { where: { id: row.id } });
    assert.equal((await store.lookup(token)).key.revokedAtMs, null, "still cached until the writer invalidates");

    store.invalidate(row.id);
    assert.equal((await store.lookup(token)).key.revokedAtMs, T0, "the next request sees the revocation");
  });

  test("invalidateAll behaves like invalidate (the cache is one map)", async () => {
    const { store } = harness();
    const { token, row } = await makeKey(store);
    await store.lookup(token);
    await db.ApiKey.update({ expiresAt: new Date(T0 + 5) }, { where: { id: row.id } });
    store.invalidateAll();
    assert.equal((await store.lookup(token)).key.expiresAtMs, T0 + 5);
  });

  test("a new key is visible after invalidate", async () => {
    const { store } = harness();
    await store.lookup(`owbk_${"0".repeat(16)}_${"A".repeat(43)}`);
    const { token } = await makeKey(store);
    assert.equal((await store.lookup(token)).status, "unknown", "cached map predates the key");
    store.invalidate();
    assert.equal((await store.lookup(token)).status, "ok");
  });

  test("a load failure with no previous value fails closed, then recovers", async () => {
    const { store } = harness();
    const { token } = await makeKey(store);
    const spy = mock.method(db.ApiKey, "findAll", async () => {
      throw new Error("database is gone");
    });
    try {
      assert.deepEqual(await store.lookup(token), { status: "unavailable" });
    } finally {
      spy.mock.restore();
    }
    assert.equal((await store.lookup(token)).status, "ok");
  });
});

describe("L4: a failing reload serves the old keys for a while, then fails closed", () => {
  const MIN = 60 * 1000;
  /** Age the cache entry by `ms` of real time, as the passing of time would (the cache stamps with Date.now) */
  const age = (cache, ms) => {
    cache.cache.get("api_keys").timestamp -= ms;
  };

  test("within twice the TTL the previous map answers; past it the answer is unavailable, never ok; recovery is immediate", async () => {
    const { store, cache, clock } = harness();
    const { token } = await makeKey(store);
    assert.equal((await store.lookup(token)).status, "ok");
    const spy = mock.method(db.ApiKey, "findAll", async () => {
      throw new Error("database is gone");
    });
    try {
      age(cache, 6 * MIN); // the entry expired (TTL 5 min): every lookup tries to reload and fails
      clock.t = T0 + 6 * MIN;
      assert.equal((await store.lookup(token)).status, "ok", "6 minutes old: the previous map is better than nothing");
      clock.t = T0 + 9 * MIN;
      assert.equal((await store.lookup(token)).status, "ok", "still inside twice the TTL");
      clock.t = T0 + 11 * MIN;
      assert.deepEqual(await store.lookup(token), { status: "unavailable" }, "a revoked key could be served from a map this old");
      clock.t = T0 + 3 * 60 * MIN;
      assert.deepEqual(await store.lookup(token), { status: "unavailable" }, "and it stays unavailable for as long as the table cannot be read");
    } finally {
      spy.mock.restore();
    }
    assert.equal((await store.lookup(token)).status, "ok", "the table is back: loaded again");
  });

  test("a map the cache still considers fresh is never questioned, however far the injected clock has moved", async () => {
    const { store, clock } = harness();
    const { token } = await makeKey(store);
    assert.equal((await store.lookup(token)).status, "ok");
    clock.t = T0 + 3 * 60 * MIN; // the cache (real time) did not expire: no reload was tried, nothing failed
    assert.equal((await store.lookup(token)).status, "ok");
  });

  test("a successful reload restarts the clock: the map is as old as its last good load, not its first", async () => {
    const { store, cache, clock } = harness();
    const { token } = await makeKey(store);
    await store.lookup(token);
    age(cache, 6 * MIN);
    clock.t = T0 + 6 * MIN;
    assert.equal((await store.lookup(token)).status, "ok"); // reloaded fine at +6 min
    const spy = mock.method(db.ApiKey, "findAll", async () => {
      throw new Error("database is gone");
    });
    try {
      age(cache, 6 * MIN);
      clock.t = T0 + 14 * MIN; // 8 minutes after the last good load
      assert.equal((await store.lookup(token)).status, "ok");
      age(cache, 6 * MIN);
      clock.t = T0 + 17 * MIN; // 11 minutes after it
      assert.equal((await store.lookup(token)).status, "unavailable");
    } finally {
      spy.mock.restore();
    }
  });
});

describe("usage write-behind", () => {
  async function setup(over = {}) {
    const h = harness();
    const made = await makeKey(h.store, over);
    h.key = (await h.store.lookup(made.token)).key;
    h.row = made.row;
    return h;
  }
  const fresh = (id) => db.ApiKey.findByPk(id);

  test("the first use writes at once, never alerts, and leaves version and updatedAt alone", async () => {
    const { store, key, row, alerts } = await setup();
    const before = await fresh(row.id);
    await store.touch(key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 });
    const after = await fresh(row.id);
    assert.equal(after.lastUsedAt.getTime(), T0);
    assert.equal(after.lastIp, "203.0.113.9");
    assert.deepEqual(after.seenIps, ["203.0.113.9"]);
    assert.equal(after.version, before.version);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    assert.deepEqual(alerts.calls, [], "the first origin of a key never alerts");
  });

  test("at most one write per key per 60 s for a known origin", async () => {
    const { store, key, row } = await setup();
    await store.touch(key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 });
    const spy = mock.method(db.ApiKey, "update");
    try {
      assert.equal(store.touch(key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 + 1000 }), undefined);
      assert.equal(store.touch(key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 + USAGE_WRITE_MS - 1 }), undefined);
      assert.equal(spy.mock.callCount(), 0);
      assert.equal(key.lastUsedAtMs, T0 + USAGE_WRITE_MS - 1, "the cached record is updated in place");
      await store.touch(key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 + USAGE_WRITE_MS });
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
    assert.equal((await fresh(row.id)).lastUsedAt.getTime(), T0 + USAGE_WRITE_MS);
  });

  test("a new origin on a key that already has some writes at once and raises api_key_new_ip", async () => {
    const { store, key, row, alerts } = await setup({ name: "Billing" });
    await store.touch(key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 });
    await store.touch(key, { ip: "198.51.100.4", origin: "198.51.100.4", at: T0 + 5 });
    assert.deepEqual(alerts.calls, [{ type: "api_key_new_ip", payload: { keyId: row.id, keyName: "Billing", ip: "198.51.100.4" } }]);
    assert.deepEqual((await fresh(row.id)).seenIps, ["203.0.113.9", "198.51.100.4"]);
    await store.touch(key, { ip: "198.51.100.4", origin: "198.51.100.4", at: T0 + 10 });
    assert.equal(alerts.calls.length, 1, "a known origin is silent");
  });

  test("seenIps keeps at most 20 origins, the oldest dropped", async () => {
    const { store, key, row } = await setup();
    for (let i = 1; i <= 25; i++) await store.touch(key, { ip: `10.0.0.${i}`, origin: `10.0.0.${i}`, at: T0 + i });
    const stored = (await fresh(row.id)).seenIps;
    assert.equal(stored.length, 20);
    assert.equal(stored[0], "10.0.0.6");
    assert.equal(stored[19], "10.0.0.25");
  });

  test("a usage write does not invalidate the cache (the record is mutated in place)", async () => {
    const h = await setup();
    const map = h.cache.cache.get("api_keys").value;
    await h.store.touch(h.key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 });
    assert.equal(h.cache.cache.get("api_keys").value, map);
    assert.equal(map.get(h.key.lookupId), h.key);
  });

  test("a failed write is swallowed and logged without the key material", async () => {
    const lines = [];
    const logger = { warn: (...args) => lines.push(JSON.stringify(args)) };
    const cache = new SettingsCache();
    const store = createKeyStore({ models: db, settingsCache: cache, now: () => T0, alerts: { raise: async () => {} }, logger });
    const made = await makeKey(store);
    const { key } = await store.lookup(made.token);
    const spy = mock.method(db.ApiKey, "update", async () => {
      throw new Error(`SQLITE failure for ${made.token}`);
    });
    try {
      await store.touch(key, { ip: "203.0.113.9", origin: "203.0.113.9", at: T0 });
    } finally {
      spy.mock.restore();
    }
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(made.token) && !lines[0].includes(made.token.slice(22)));
  });

  test("a raising alert never breaks touch", async () => {
    const cache = new SettingsCache();
    const alerts = { raise: async () => { throw new Error("outbox down"); } };
    const store = createKeyStore({ models: db, settingsCache: cache, now: () => T0, alerts });
    const made = await makeKey(store, { seenIps: ["1.1.1.1"] });
    const { key } = await store.lookup(made.token);
    await assert.doesNotReject(async () => store.touch(key, { ip: "2.2.2.2", origin: "2.2.2.2", at: T0 }));
  });
});

describe("redactor built-in pattern", () => {
  test("scrub removes a token even when no value is registered", () => {
    assert.equal(redactor.size(), 0);
    const made = createKeyStore({}).generateSecret();
    const out = redactor.scrub(`header Authorization: Bearer ${made.secret} done`);
    assert.equal(out, "header Authorization: Bearer [redacted] done");
    assert.ok(!out.includes(made.lookupId));
  });

  test("it also works next to registered values and several tokens in one text", () => {
    redactor.register("setting:X", "super-secret-value");
    const a = createKeyStore({}).generateSecret().secret;
    const b = createKeyStore({}).generateSecret().secret;
    const out = redactor.scrub(`${a} and ${b} and super-secret-value`);
    assert.equal(out, "[redacted] and [redacted] and [redacted]");
  });

  test("a text without a token is returned unchanged; short look-alikes are left alone", () => {
    const text = "owbk_ is a prefix, owbk_0123456789abcdef_short stays";
    assert.equal(redactor.scrub(text), text);
    assert.equal(redactor.scrub(""), "");
    assert.equal(redactor.scrub(undefined), undefined);
  });

  test("registerEphemeral still redacts the freshly created token for its time and then lets go", () => {
    const token = createKeyStore({}).generateSecret().secret;
    redactor.registerEphemeral("apikey:test", token, 1000, { now: 5000 });
    assert.equal(redactor.scrub(`x ${token} y`, { now: 5500 }), "x [redacted] y");
    assert.equal(redactor.scrub(Buffer.from(token).toString("base64"), { now: 5500 }), "[redacted]", "variants of an ephemeral value");
    // after expiry the shape still protects the raw token
    assert.equal(redactor.scrub(`x ${token} y`, { now: 7000 }), "x [redacted] y");
    assert.equal(redactor.size(), 0, "the ephemeral entry expired");
  });
});
