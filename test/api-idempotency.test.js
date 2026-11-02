"use strict";
/**
 * Idempotency helpers of the messaging API (feature 004, contracts/runtime.md section 15.8, public-api.md 7.4):
 * the fingerprint (HMAC keyed by the key's secret hash, canonical JSON, file hash), the comparison and the lookup
 * through the engine. The pipeline-level behaviour (replay before quota, conflict, racing duplicates, a refused request
 * leaving the key free, per-key scope) is in test/api-pipeline.test.js.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { fingerprint, lookup, compare, canonicalJson } = require("../lib/api/idempotency");
const { ApiError, statusOf } = require("../lib/api/errors");
const { LIMITS } = require("../lib/messaging/limits");

const HASH = crypto.createHash("sha256").update("secret-a").digest("hex");
const OTHER_HASH = crypto.createHash("sha256").update("secret-b").digest("hex");
const base = { secretHashHex: HASH, endpointId: "messages.create", rawBody: { format: "text", to: "237690000001", text: "hello" }, fileSha256: null };

describe("canonicalJson", () => {
  test("sorts keys recursively and keeps array order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } }), '{"a":{"c":null,"d":[3,1,2]},"b":1}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });
});

describe("fingerprint", () => {
  test("is 32 lower-case hex characters, deterministic, and a keyed HMAC", () => {
    const fp = fingerprint(base);
    assert.match(fp, /^[0-9a-f]{32}$/);
    assert.equal(fingerprint({ ...base }), fp);
    const data = `messages.create\u0000${canonicalJson(base.rawBody)}\u0000`;
    assert.equal(fp, crypto.createHmac("sha256", Buffer.from(HASH, "hex")).update(data).digest("hex").slice(0, 32));
  });

  test("the JSON keys in any order are the same content; an explicitly sent default is a difference", () => {
    const reordered = { text: "hello", to: "237690000001", format: "text" };
    assert.equal(fingerprint({ ...base, rawBody: reordered }), fingerprint(base));
    assert.notEqual(fingerprint({ ...base, rawBody: { ...base.rawBody, linkPreview: false } }), fingerprint(base));
  });

  test("another endpoint, another key, another content, another file all differ", () => {
    const fp = fingerprint(base);
    assert.notEqual(fingerprint({ ...base, endpointId: "messages.other" }), fp);
    assert.notEqual(fingerprint({ ...base, secretHashHex: OTHER_HASH }), fp);
    assert.notEqual(fingerprint({ ...base, rawBody: { ...base.rawBody, text: "hello!" } }), fp);
    const withFile = fingerprint({ ...base, fileSha256: "a".repeat(64) });
    assert.notEqual(withFile, fp);
    assert.notEqual(fingerprint({ ...base, fileSha256: "b".repeat(64) }), withFile);
  });

  test("no content is derivable: the text does not appear and a different key gives an unrelated value", () => {
    const fp = fingerprint(base);
    assert.ok(!fp.includes("hello"));
    assert.notEqual(fingerprint({ ...base, secretHashHex: OTHER_HASH }).slice(0, 8), fp.slice(0, 8));
  });

  test("a media.url counts as the string, not as downloaded bytes", () => {
    const a = fingerprint({ ...base, rawBody: { ...base.rawBody, media: { url: "https://x.example/a.png" } } });
    const b = fingerprint({ ...base, rawBody: { ...base.rawBody, media: { url: "https://x.example/b.png" } } });
    assert.notEqual(a, b);
  });
});

describe("compare", () => {
  test("equal fingerprints pass, different ones are idempotency_conflict (409)", () => {
    const fp = fingerprint(base);
    assert.doesNotThrow(() => compare({ message: {}, requestHash: fp }, fp));
    try {
      compare({ message: {}, requestHash: fp }, fingerprint({ ...base, rawBody: { ...base.rawBody, text: "other" } }));
      assert.fail("should conflict");
    } catch (err) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "idempotency_conflict");
      assert.equal(statusOf(err.code), 409);
    }
  });

  test("a stored message without a hash conflicts: it is never silently replayed", () => {
    assert.throws(() => compare({ message: {}, requestHash: null }, fingerprint(base)), (err) => err.code === "idempotency_conflict");
    assert.throws(() => compare(null, fingerprint(base)), (err) => err.code === "idempotency_conflict");
  });
});

describe("lookup and the window", () => {
  test("goes through messaging.findByIdempotency with the key, its scope and the time", async () => {
    const seen = [];
    const messaging = { findByIdempotency: async (args) => (seen.push(args), { message: { id: "msg_x" }, requestHash: "h" }) };
    const found = await lookup({ messaging, apiKeyId: 7, key: "order-1", now: 123 });
    assert.deepEqual(seen, [{ apiKeyId: 7, key: "order-1", now: 123 }]);
    assert.equal(found.requestHash, "h");
    assert.equal(await lookup({ messaging: { findByIdempotency: async () => null }, apiKeyId: 7, key: "x", now: 1 }), null);
  });

  test("the window is fixed at 24 hours (the engine releases an older key lazily)", () => {
    assert.equal(LIMITS.IDEMPOTENCY_MS, 24 * 60 * 60 * 1000);
  });
});
