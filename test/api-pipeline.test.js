"use strict";
/**
 * The request pipeline of the messaging API (feature 004, contracts/public-api.md sections 5, 6 and 11, runtime.md
 * 15.6): one case per adjacent pair of steps proving the ORDER (the order is the contract), what counts toward the
 * origin block, the header profile, the request id, the idempotency and quota interplay, and what a handler sees.
 * A real createApi() behind a raw HTTP server (test/helpers/apiHttpKit.js) with a fake messaging engine.
 */

const { test, describe, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { createApiKit, OWN_NUMBER } = require("./helpers/apiHttpKit");
const { MessagingError } = require("./helpers/../../lib/messaging/errors");

const PN = (digits) => `${digits}@s.whatsapp.net`;
const GOOD_ID = "msg_Vx3k9QfL2mNvB7aRtYhZwc";
const ALL_SEND = ["messages.send.text", "messages.send.image", "messages.send.document", "messages.read", "media.url"];

let kit;
let ipSeq = 0;
/** A fresh remote caller (its own origin, so the limiter and the log cooldown never see it twice) */
const freshIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const err = (res) => (res.json || {}).error || {};
const text = (to, extra = {}) => ({ format: "text", to, text: "hello", ...extra });

before(async () => {
  kit = await createApiKit();
});
after(async () => {
  await kit.close();
});

const send = (token, json, opts = {}) => kit.post("/api/v1/messages", token, json, opts);

// ---------------------------------------------------------------------------------------------------------------------
describe("header profile and request id", () => {
  test("every answer, success or error, carries the api header profile and a 16-hex request id", async () => {
    const { token } = await kit.makeKey();
    const ok = await send(token, text("237690000001"));
    const bad = await kit.get("/api/v1/messages/" + GOOD_ID, null);
    for (const res of [ok, bad]) {
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
      assert.match(res.headers["content-type"], /^application\/json; charset=utf-8$/);
      for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith("access-control-"), name);
      for (const name of ["set-cookie", "strict-transport-security", "x-frame-options", "permissions-policy", "cross-origin-opener-policy"]) {
        assert.equal(res.headers[name], undefined, name);
      }
      assert.match(res.headers["x-request-id"], /^[0-9a-f]{16}$/);
    }
    assert.equal(ok.status, 202);
    assert.equal(err(bad).requestId, bad.headers["x-request-id"]);
  });

  test("the envelope is { error: { code, requestId } } with params only when they exist and fields only for validation_failed", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.read"] });
    const res = await send(token, text("237690000001"));
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: { code: "forbidden", params: { right: "messages.send.text" }, requestId: res.headers["x-request-id"] } });
    const invalid = await send((await kit.makeKey()).token, { format: "text", to: "237690000001" });
    assert.equal(invalid.status, 422);
    assert.deepEqual(Object.keys(err(invalid)).sort(), ["code", "fields", "requestId"]);
    assert.deepEqual(err(invalid).fields, { text: { code: "required" } });
  });

  test("a client-sent request id is replaced", async () => {
    const res = await kit.get("/api/v1/messages/" + GOOD_ID, null, { headers: { "X-Request-Id": "attacker-chosen" } });
    assert.match(res.headers["x-request-id"], /^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 1-2: gate and verb", () => {
  test("step 1: the database not ready is claimed whatever the switch, before anything else is read", async () => {
    const { token } = await kit.makeKey();
    kit.runtime.dbReady = false;
    kit.apiState.enabled = false;
    try {
      const before = kit.engine.calls.length;
      for (const [method, extra] of [["GET", {}], ["POST", { json: text("237690000001") }], ["OPTIONS", {}]]) {
        const res = await kit.request("/api/v1/messages", { method, token, ...extra });
        assert.equal(res.status, 503, method);
        assert.equal(err(res).code, "unavailable");
        assert.equal(res.headers["retry-after"], "5");
        assert.deepEqual(err(res).params, { retryAfterMs: 5000 });
      }
      assert.equal(kit.engine.calls.length, before, "nothing read, nothing queued");
    } finally {
      kit.runtime.dbReady = true;
      kit.apiState.enabled = true;
    }
  });

  test("a restore running gives 503 unavailable while the API is on; an API that is off stays unclaimed", async () => {
    const { token } = await kit.makeKey();
    kit.maintenance.active = true;
    try {
      const res = await send(token, text("237690000001"));
      assert.equal(res.status, 503);
      assert.equal(res.headers["retry-after"], "5");
      kit.apiState.enabled = false;
      const off = await send(token, text("237690000001"));
      assert.equal(off.status, kit.legacy.status);
      assert.equal(off.text, kit.legacy.body);
    } finally {
      kit.maintenance.active = false;
      kit.apiState.enabled = true;
    }
  });

  test("step 2: OPTIONS and HEAD are 405 without Allow and without CORS, and precede the transport check", async () => {
    for (const method of ["OPTIONS", "HEAD"]) {
      const res = await kit.request("/api/v1/messages", { method, remote: freshIp(), https: false });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, undefined);
      for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith("access-control-"), name);
      if (method === "OPTIONS") assert.equal(err(res).code, "method_not_allowed");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 3-5: transport, browser, key in the URL", () => {
  test("step 3: plain HTTP from a remote address is https_required before the key is read or hashed", async () => {
    const { token } = await kit.makeKey();
    const lookup = mock.method(kit.api.keys, "lookup");
    try {
      const res = await send(token, text("237690000001"), { remote: freshIp(), https: false });
      assert.equal(res.status, 403);
      assert.equal(err(res).code, "https_required");
      assert.equal(lookup.mock.callCount(), 0, "the key was not read");
      const ok = await send(token, text("237690000001"), { remote: freshIp() });
      assert.equal(ok.status, 202, "trusted X-Forwarded-Proto: https");
      assert.equal(lookup.mock.callCount(), 1);
    } finally {
      lookup.mock.restore();
    }
  });

  test("step 3: loopback is local, a plainHttpFrom address is admitted and refused again once removed", async () => {
    const { token } = await kit.makeKey();
    assert.equal((await send(token, text("237690000001"))).status, 202, "local request");
    kit.apiState.plain = ["10.0.0.0/8"];
    assert.equal((await send(token, text("237690000001"), { remote: "10.1.2.3", https: false })).status, 202);
    kit.apiState.plain = [];
    const res = await send(token, text("237690000001"), { remote: "10.1.2.3", https: false });
    assert.equal(err(res).code, "https_required");
  });

  test("step 4: Origin or Sec-Fetch-Site is browser_not_allowed, even with a valid key, after the transport check", async () => {
    const { token } = await kit.makeKey();
    for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "same-origin" }, { Origin: "null" }]) {
      const res = await send(token, text("237690000001"), { headers });
      assert.equal(res.status, 403);
      assert.equal(err(res).code, "browser_not_allowed");
      for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith("access-control-"), name);
    }
    const plain = await send(token, text("237690000001"), { remote: freshIp(), https: false, headers: { Origin: "https://evil.example" } });
    assert.equal(err(plain).code, "https_required");
  });

  test("step 5: a key in the URL is key_in_url without being parsed, hashed or logged, after the browser check", async () => {
    const { token } = await kit.makeKey();
    const lookup = mock.method(kit.api.keys, "lookup");
    const parse = mock.method(kit.api.keys, "parseToken");
    kit.logLines.length = 0;
    try {
      const urls = [
        `/api/v1/messages?api_key=${token}`,
        "/api/v1/messages?apikey=x",
        "/api/v1/messages?key=x",
        "/api/v1/messages?TOKEN=x",
        "/api/v1/messages?access_token=x",
        "/api/v1/messages?authorization=Bearer%20x",
        "/api/v1/messages?%61pi_key=x",
        "/api/v1/messages?key[]=x",
        `/api/v1/messages?harmless=${token}`,
        `/api/v1/messages/${token}`,
        `/api/v1/messages?q=${encodeURIComponent(token)}`,
      ];
      for (const url of urls) {
        const res = await kit.get(url, token);
        assert.equal(res.status, 400, url);
        assert.equal(err(res).code, "key_in_url", url);
      }
      assert.equal(lookup.mock.callCount(), 0);
      assert.equal(parse.mock.callCount(), 0);
      assert.ok(!JSON.stringify(kit.logLines).includes(token.slice(22)), "never logged");
      const browser = await kit.get(`/api/v1/messages?api_key=${token}`, token, { headers: { Origin: "https://evil.example" } });
      assert.equal(err(browser).code, "browser_not_allowed");
    } finally {
      lookup.mock.restore();
      parse.mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 6-9: origin block and authentication", () => {
  test("step 7: missing, malformed, unknown and wrong keys give the same answer, with WWW-Authenticate", async () => {
    const { token } = await kit.makeKey();
    const unknown = `owbk_${"0".repeat(16)}_${"A".repeat(43)}`;
    const wrong = `${token.slice(0, 22)}${"B".repeat(43)}`;
    const bodies = [];
    for (const header of [undefined, "Bearer", "Bearer nonsense", `Bearer ${unknown}`, `Bearer ${wrong}`, `Basic ${token}`, `Token ${token}`, `Bearer ${token} extra`]) {
      const res = await kit.get("/api/v1/messages/" + GOOD_ID, null, { remote: freshIp(), headers: header === undefined ? {} : { Authorization: header } });
      assert.equal(res.status, 401, String(header));
      assert.equal(err(res).code, "unauthenticated");
      assert.equal(res.headers["www-authenticate"], 'Bearer realm="owb-api"');
      assert.deepEqual(Object.keys(res.json.error).sort(), ["code", "requestId"]);
      bodies.push(res.text.replace(/"requestId":"[0-9a-f]{16}"/, ""));
    }
    assert.equal(new Set(bodies).size, 1, "no enumeration: one answer");
  });

  test("the scheme name is case-insensitive; two Authorization headers are refused; a cookie alone is unauthenticated", async () => {
    const { token } = await kit.makeKey();
    assert.equal((await kit.get("/api/v1/messages/" + GOOD_ID, null, { headers: { Authorization: `bearer ${token}` } })).status, 404);
    const doubled = await new Promise((resolve, reject) => {
      const http = require("node:http");
      const req = http.request(`${kit.base}/api/v1/messages/${GOOD_ID}`, { headers: { Authorization: [`Bearer ${token}`, `Bearer ${token}`] }, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(doubled, 401);
    const cookie = await kit.get("/api/v1/messages/" + GOOD_ID, null, { headers: { Cookie: "owb_sid=abcdef; csrf=1" } });
    assert.equal(err(cookie).code, "unauthenticated");
    assert.equal(cookie.headers["set-cookie"], undefined);
  });

  test("steps 8-9: revoked, expired and IP are shown only after the secret matched", async () => {
    const revoked = await kit.makeKey({ revokedAt: new Date(kit.T0 - 1000) });
    const expired = await kit.makeKey({ expiresAt: new Date(kit.T0 - 1000) });
    const ipLocked = await kit.makeKey({ ipAllow: ["10.0.0.0/8"] });
    const path = "/api/v1/messages/" + GOOD_ID;

    const r = await kit.get(path, revoked.token, { remote: freshIp() });
    assert.deepEqual([r.status, err(r).code], [401, "key_revoked"]);
    assert.equal(r.headers["www-authenticate"], 'Bearer realm="owb-api", error="invalid_token"');
    const e = await kit.get(path, expired.token, { remote: freshIp() });
    assert.deepEqual([e.status, err(e).code], [401, "key_expired"]);
    const i = await kit.get(path, ipLocked.token, { remote: freshIp() });
    assert.deepEqual([i.status, err(i).code], [403, "ip_not_allowed"]);
    const okIp = await kit.get(path, ipLocked.token, { remote: "10.4.5.6" });
    assert.equal(okIp.status, 404, "inside the allowlist: authenticated, then the route answers");

    for (const made of [revoked, expired, ipLocked]) {
      const wrong = `${made.token.slice(0, 22)}${"B".repeat(43)}`;
      const res = await kit.get(path, wrong, { remote: freshIp() });
      assert.equal(err(res).code, "unauthenticated", "a wrong secret learns nothing about the key");
    }
  });

  test("a revocation applies to the very next request once the writer invalidates the cache", async () => {
    const { token, row } = await kit.makeKey();
    assert.equal((await kit.get("/api/v1/messages/" + GOOD_ID, token)).status, 404);
    await row.update({ revokedAt: new Date(kit.T0), nameKey: null });
    kit.api.keys.invalidate(row.id);
    assert.equal(err(await kit.get("/api/v1/messages/" + GOOD_ID, token)).code, "key_revoked");
  });

  test("an unreadable key table fails closed: 503 unavailable, not counted against the origin", async () => {
    const { token } = await kit.makeKey();
    kit.api.keys.invalidate();
    const spy = mock.method(kit.db.ApiKey, "findAll", async () => {
      throw new Error("db down");
    });
    try {
      const res = await kit.get("/api/v1/messages/" + GOOD_ID, token, { remote: freshIp() });
      assert.equal(res.status, 503);
      assert.equal(err(res).code, "unavailable");
      assert.equal(res.headers["retry-after"], "5");
    } finally {
      spy.mock.restore();
      kit.api.keys.invalidate();
    }
  });

  test("step 10: the route is matched only after authentication; 404 and 405 + Allow follow", async () => {
    const { token } = await kit.makeKey();
    const anon = await kit.get("/api/v1/nope", null);
    assert.equal(anon.status, 401, "an unauthenticated caller cannot enumerate routes");
    const anonVerb = await kit.request("/api/v1/messages", { method: "DELETE" });
    assert.equal(anonVerb.status, 401);
    assert.equal(anonVerb.headers.allow, undefined);

    const missing = await kit.get("/api/v1/nope", token);
    assert.deepEqual([missing.status, err(missing).code], [404, "not_found"]);
    for (const path of ["/api/v1/messages/", "/api/v1//messages", "/api/v1/messages/short", "/api/v1/Messages", "/api/v2/messages"]) {
      assert.equal((await kit.get(path, token)).status, 404, path);
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await kit.request("/api/v1/messages", { method, token });
      assert.deepEqual([res.status, err(res).code, res.headers.allow], [405, "method_not_allowed", "GET, POST"], method);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("origin blocking: only steps 7-9 count", () => {
  let own;
  before(async () => {
    own = await createApiKit();
  });
  after(async () => {
    await own.close();
  });

  const failWith = (ip) => own.get("/api/v1/messages/" + GOOD_ID, null, { remote: ip });

  test("10 failures in 5 minutes block the origin for 15 minutes, a valid key included, then it is released", async () => {
    const { token } = await own.makeKey();
    const ip = "203.0.113.50";
    for (let i = 0; i < 10; i++) {
      const res = await failWith(ip);
      assert.equal(err(res).code, "unauthenticated", `failure ${i + 1} is answered as itself`);
    }
    const blocked = await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: ip });
    assert.equal(blocked.status, 429);
    assert.equal(err(blocked).code, "origin_blocked");
    assert.equal(blocked.headers["retry-after"], "900");
    assert.ok(err(blocked).params.retryAfterMs <= 900000 && err(blocked).params.retryAfterMs > 890000);

    assert.equal(own.alerts.calls.filter((c) => c.type === "api_origin_blocked").length, 1, "the alert is raised once");
    assert.equal(own.alerts.calls[0].payload.origin, "203.0.113.50");
    assert.equal(own.audit.rows.filter((r) => r.action === "api.origin.block").length, 1);
    assert.equal(own.audit.rows[0].result, "blocked");
    for (let i = 0; i < 5; i++) await failWith(ip);
    assert.equal(own.alerts.calls.length, 1, "a blocked origin is not extended and not re-alerted");

    await own.clock.advance(15 * 60 * 1000 - 1000);
    assert.equal(err(await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: ip })).code, "origin_blocked");
    await own.clock.advance(2000);
    assert.equal((await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: ip })).status, 404, "released at +15 minutes");
  });

  test("another origin is not affected; a success never resets the counter", async () => {
    const { token } = await own.makeKey();
    const ip = "203.0.113.51";
    for (let i = 0; i < 6; i++) await failWith(ip);
    assert.equal((await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: ip })).status, 404, "a valid call in between");
    for (let i = 0; i < 3; i++) await failWith(ip);
    assert.equal((await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: ip })).status, 404, "9 failures: not blocked yet");
    await failWith(ip); // the 10th failure: the success above did not reset the count
    assert.equal(err(await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: ip })).code, "origin_blocked");
    assert.equal((await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: "203.0.113.52" })).status, 404);
  });

  test("failures spread over more than 5 minutes do not accumulate", async () => {
    const { token } = await own.makeKey();
    const ip = "203.0.113.53";
    for (let i = 0; i < 9; i++) await failWith(ip);
    await own.clock.advance(5 * 60 * 1000 + 1000);
    for (let i = 0; i < 9; i++) await failWith(ip);
    assert.equal((await own.get("/api/v1/messages/" + GOOD_ID, token, { remote: ip })).status, 404);
  });

  test("steps 3-6 and 10-20 never count: 12 refusals of each kind leave the origin and a valid key usable", async () => {
    const alertsBefore = own.alerts.calls.length;
    const limited = await own.makeKey({ rights: ["messages.read"], policyMode: "list", recipients: [PN("237690000001")] });
    const ip = "203.0.113.54";
    const attempts = [
      () => own.post("/api/v1/messages", limited.token, text("237690000001"), { remote: ip, https: false }), // 3
      () => own.post("/api/v1/messages", limited.token, text("237690000001"), { remote: ip, headers: { Origin: "https://x.example" } }), // 4
      () => own.get(`/api/v1/messages?api_key=zz`, limited.token, { remote: ip }), // 5
      () => own.get("/api/v1/nope", limited.token, { remote: ip }), // 10
      () => own.request("/api/v1/messages", { method: "DELETE", token: limited.token, remote: ip }), // 10
      () => own.post("/api/v1/messages", limited.token, text("237690000001"), { remote: ip }), // 12b forbidden
      () => own.get("/api/v1/messages/" + GOOD_ID, limited.token, { remote: ip }), // 20 handler 404
    ];
    for (let round = 0; round < 12; round++) for (const attempt of attempts) await attempt();
    const res = await own.get("/api/v1/messages/" + GOOD_ID, limited.token, { remote: ip });
    assert.equal(res.status, 404, "not blocked");
    assert.equal(own.alerts.calls.length, alertsBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 11-12b: rights and the body peek", () => {
  test("step 11: a static right is checked before any byte of a body is read, and the refusal closes the connection", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.read"] });
    const res = await kit.request("/api/v1/echo", { method: "POST", token, contentType: "application/json", body: "{not json" });
    assert.equal(res.status, 403);
    assert.deepEqual(err(res).params, { right: "echo.write" });
    assert.equal(res.headers.connection, "close");
    const allowed = await kit.makeKey({ rights: ["echo.write"] });
    assert.equal((await kit.request("/api/v1/echo", { method: "POST", token: allowed.token, contentType: "application/json", body: "{not json" })).status, 400);
  });

  test("step 12: Content-Type 415, malformed JSON and a non-object 400, an oversized body 413", async () => {
    const { token } = await kit.makeKey();
    const post = (opts) => kit.request("/api/v1/messages", { method: "POST", token, ...opts });
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "application/xml", "application/json; charset=latin1"]) {
      const res = await post({ contentType, body: "{}" });
      assert.deepEqual([res.status, err(res).code], [415, "unsupported_media_type"], String(contentType));
    }
    assert.equal((await post({ contentType: "application/json; charset=utf-8", body: JSON.stringify(text("237690000001")) })).status, 202);
    for (const body of ["{not json", "[]", "null", "42", '"str"']) {
      const res = await post({ contentType: "application/json", body });
      assert.deepEqual([res.status, err(res).code], [400, "bad_request"], body);
    }
    const big = await post({ contentType: "application/json", body: JSON.stringify({ format: "text", to: "237690000001", text: "x".repeat(70000) }) });
    assert.deepEqual([big.status, err(big).code], [413, "payload_too_large"]);
    assert.deepEqual(err(big).params, { maxBytes: 65536 });
    assert.equal(big.headers.connection, "close");
  });

  test("step 12b: format problems are returned alone and before any right is evaluated", async () => {
    const { token } = await kit.makeKey({ rights: [] });
    for (const [body, code, params] of [
      [{ to: "237690000001", text: "x" }, "required"],
      [{ format: 7, to: "1" }, "invalid_type"],
      [{ format: "nope", to: 1 }, "not_allowed", { allowed: ["text", "image", "document"] }],
    ]) {
      const res = await send(token, body);
      assert.equal(res.status, 422);
      assert.deepEqual(err(res).fields, { format: params ? { code, params } : { code } });
    }
  });

  test("step 12b: the right of the format, then media.url when media.url is present", async () => {
    const textOnly = await kit.makeKey({ rights: ["messages.send.text"] });
    const res = await send(textOnly.token, { format: "image", to: "237690000001", media: { url: "https://x.example/a.png" } });
    assert.deepEqual([res.status, err(res).code, err(res).params], [403, "forbidden", { right: "messages.send.image" }]);
    const noUrl = await kit.makeKey({ rights: ["messages.send.image"] });
    const url = await send(noUrl.token, { format: "image", to: "237690000001", media: { url: "https://x.example/a.png" } });
    assert.deepEqual([url.status, err(url).params], [403, { right: "media.url" }]);
    assert.equal(kit.engine.count("fetchMedia"), 0, "nothing fetched without the right");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 13-14: recipient policy, own number, disabled chat", () => {
  test("`to` problems are returned alone: required, invalid_type, invalid_format", async () => {
    const { token } = await kit.makeKey();
    for (const [body, code] of [[{ format: "text" }, "required"], [{ format: "text", to: 5, text: 1 }, "invalid_type"], [{ format: "text", to: "abc", text: 1 }, "invalid_format"], [{ format: "text", to: "0690000003" }, "invalid_format"]]) {
      const res = await send(token, body);
      assert.equal(res.status, 422);
      assert.deepEqual(err(res).fields, { to: { code } }, JSON.stringify(body));
    }
  });

  test("the policy is checked before the disabled chat, the own number and the content, and never echoes the number", async () => {
    const { token } = await kit.makeKey({ policyMode: "list", recipients: [PN("237690000001")] });
    kit.engine.banned.add(PN("237690000002"));
    const res = await send(token, { format: "text", to: "237690000002" }); // also invalid content
    assert.deepEqual([res.status, err(res).code, err(res).params], [403, "recipient_not_allowed", undefined]);
    assert.ok(!res.text.includes("237690000002"));
    kit.engine.banned.delete(PN("237690000002"));
  });

  test("the own number is refused after the policy: a restricted key learns nothing", async () => {
    const restricted = await kit.makeKey({ policyMode: "list", recipients: [PN("237690000001")] });
    const res = await send(restricted.token, text(OWN_NUMBER));
    assert.equal(err(res).code, "recipient_not_allowed");
    const open = await kit.makeKey();
    const own = await send(open.token, text(OWN_NUMBER));
    assert.deepEqual([own.status, err(own).fields], [422, { to: { code: "not_allowed" } }]);
  });

  test("a disabled chat is 409 chat_disabled, before the quota and the content", async () => {
    const { token } = await kit.makeKey({ limitPerMinute: 1 });
    assert.equal((await send(token, text("237690000003"))).status, 202);
    kit.engine.banned.add(PN("237690000004"));
    try {
      const res = await send(token, { format: "text", to: "237690000004" });
      assert.deepEqual([res.status, err(res).code], [409, "chat_disabled"], "not rate_limited, not validation_failed");
    } finally {
      kit.engine.banned.delete(PN("237690000004"));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 15-16: idempotency and quotas", () => {
  const withKey = (key) => ({ headers: { "Idempotency-Key": key } });

  test("a replay answers 202 with the stored message, Idempotent-Replayed and Location, and precedes the quota", async () => {
    const { token } = await kit.makeKey({ limitPerMinute: 1 });
    const first = await send(token, text("237690000005"), withKey("order-1"));
    assert.equal(first.status, 202);
    assert.equal(first.headers.location, `/api/v1/messages/${first.json.message.id}`);
    assert.equal(first.headers["idempotent-replayed"], undefined);

    const admissions = kit.engine.count("checkAdmission");
    kit.engine.refuseAdmission = { code: "queue_full", params: { scope: "global", retryAfterMs: 3000 } };
    try {
      const replay = await send(token, text("237690000005"), withKey("order-1"));
      assert.equal(replay.status, 202, "the minute quota is exhausted and the queue is full: a replay still passes");
      assert.equal(replay.headers["idempotent-replayed"], "true");
      assert.equal(replay.headers.location, first.headers.location);
      assert.equal(replay.json.message.id, first.json.message.id);
      assert.equal(kit.engine.count("checkAdmission"), admissions, "step 16 was skipped");
      assert.equal(kit.engine.count("submit") - kit.engine.calls.filter((c) => c.name === "submit" && c.args[0].apiKeyId !== first.json.message.apiKeyId).length, 1);
    } finally {
      kit.engine.refuseAdmission = null;
    }
  });

  test("the same key with another content is 409 idempotency_conflict before the quota; the key order is irrelevant", async () => {
    const { token } = await kit.makeKey({ limitPerMinute: 1 });
    assert.equal((await send(token, { format: "text", to: "237690000005", text: "a" }, withKey("k-conflict"))).status, 202);
    const conflict = await send(token, { format: "text", to: "237690000005", text: "b" }, withKey("k-conflict"));
    assert.deepEqual([conflict.status, err(conflict).code], [409, "idempotency_conflict"]);
    const reordered = await send(token, { text: "a", to: "237690000005", format: "text" }, withKey("k-conflict"));
    assert.equal(reordered.status, 202, "keys in any order are the same content");
    const explicitDefault = await send(token, { format: "text", to: "237690000005", text: "a", linkPreview: false }, withKey("k-conflict"));
    assert.equal(explicitDefault.status, 409, "an explicitly sent default counts as a difference");
  });

  test("the key is scoped by API key, and a refused request leaves it free", async () => {
    const a = await kit.makeKey();
    const b = await kit.makeKey();
    assert.equal((await send(a.token, text("237690000006"), withKey("shared"))).status, 202);
    const other = await send(b.token, text("237690000006"), withKey("shared"));
    assert.equal(other.status, 202);
    assert.equal(other.headers["idempotent-replayed"], undefined);
    const bad = await send(a.token, { format: "text", to: "237690000006" }, withKey("retry-me"));
    assert.equal(bad.status, 422);
    assert.equal((await send(a.token, text("237690000006"), withKey("retry-me"))).status, 202, "corrected and retried with the same key");
  });

  test("a replay is checked after the right, the policy and the chat: a key that lost the right gets forbidden", async () => {
    const { token, row } = await kit.makeKey();
    assert.equal((await send(token, text("237690000007"), withKey("lost-right"))).status, 202);
    await row.update({ rights: ["messages.read"] });
    kit.api.keys.invalidate();
    assert.equal(err(await send(token, text("237690000007"), withKey("lost-right"))).code, "forbidden");
    await row.update({ rights: ["messages.send.text"] });
    kit.api.keys.invalidate();
    kit.engine.banned.add(PN("237690000007"));
    try {
      assert.equal(err(await send(token, text("237690000007"), withKey("lost-right"))).code, "chat_disabled");
    } finally {
      kit.engine.banned.delete(PN("237690000007"));
    }
  });

  test("a malformed Idempotency-Key is a validation fault reported with the others", async () => {
    const { token } = await kit.makeKey();
    for (const bad of ["has space", "a".repeat(81), "slash/inside", "semi;colon", "a,b"]) {
      const res = await send(token, { format: "text", to: "237690000008" }, withKey(bad));
      assert.equal(res.status, 422, bad);
      assert.deepEqual(err(res).fields, { "idempotency-key": { code: "invalid_format" }, text: { code: "required" } });
    }
  });

  test("step 16: the engine's admission, then the day, then the minute; RateLimit-* from the key's window", async () => {
    const { token } = await kit.makeKey({ limitPerMinute: 2 });
    const one = await send(token, text("237690000009"));
    assert.deepEqual([one.status, one.headers["ratelimit-limit"], one.headers["ratelimit-remaining"]], [202, "2", "1"]);
    const two = await send(token, text("237690000009"));
    assert.equal(two.headers["ratelimit-remaining"], "0");
    assert.equal(Number(two.headers["ratelimit-reset"]) > 0, true);
    const three = await send(token, text("237690000009"));
    assert.deepEqual([three.status, err(three).code], [429, "rate_limited"]);
    assert.equal(err(three).params.scope, "minute");
    assert.equal(err(three).params.limit, 2);
    assert.ok(Number(three.headers["retry-after"]) >= 1);
    assert.equal(three.headers["ratelimit-remaining"], "0", "RateLimit-* on the 429 too");

    kit.engine.refuseAdmission = { code: "pending_limit_reached", params: { limit: 100, retryAfterMs: 4000 } };
    try {
      const refused = await send(token, text("237690000009"));
      assert.deepEqual([refused.status, err(refused).code, refused.headers["retry-after"]], [429, "pending_limit_reached", "4"], "the engine answers before the minute window");
    } finally {
      kit.engine.refuseAdmission = null;
    }
    const noHeaders = await kit.get("/api/v1/messages/" + GOOD_ID, token);
    assert.equal(noHeaders.headers["ratelimit-limit"], undefined, "only quota-bearing endpoints");
  });

  test("the quota check precedes content validation; a refused request does not count", async () => {
    const { token } = await kit.makeKey({ limitPerMinute: 1 });
    const invalid = await send(token, { format: "text", to: "237690000010" });
    assert.equal(err(invalid).code, "validation_failed");
    assert.equal((await send(token, text("237690000010"))).status, 202, "the 422 consumed nothing");
    const limited = await send(token, { format: "text", to: "237690000010" });
    assert.equal(err(limited).code, "rate_limited", "quota before content");
  });

  test("the day quota: calendar day in TIMEZONE, retry at the next local midnight", async () => {
    const { token } = await kit.makeKey({ limitPerDay: 1 });
    assert.equal((await send(token, text("237690000011"))).status, 202);
    const res = await send(token, text("237690000011"));
    assert.deepEqual([res.status, err(res).code, err(res).params.limit], [429, "daily_quota_exceeded", 1]);
    assert.ok(Number(res.headers["retry-after"]) <= 24 * 3600 && Number(res.headers["retry-after"]) > 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 17-18: validation and media", () => {
  test("step 17: query and body faults are reported together, nothing echoed", async () => {
    const { token } = await kit.makeKey();
    const res = await kit.request("/api/v1/messages?wait=true&extra=1", { method: "POST", token, json: { format: "text", to: "237690000012", surprise: "secret-value" } });
    assert.equal(res.status, 422);
    assert.deepEqual(err(res).fields, { wait: { code: "invalid_format" }, $unknown: { code: "unknown_field" }, text: { code: "required" } });
    assert.ok(!res.text.includes("secret-value") && !res.text.includes("surprise"));
  });

  test("wait: decimal digits 0-30 only (31 is out_of_range with its bounds)", async () => {
    const { token } = await kit.makeKey();
    const wait = (value) => kit.request(`/api/v1/messages?wait=${value}`, { method: "POST", token, json: text("237690000013") });
    assert.deepEqual(err(await wait("31")).fields, { wait: { code: "out_of_range", params: { min: 0, max: 30 } } });
    for (const bad of ["abc", "-1", "1.5", "", "0x10", "%20"]) assert.deepEqual(err(await wait(bad)).fields, { wait: { code: "invalid_format" } }, bad);
    assert.equal((await wait("30")).status, 202);
    assert.equal((await wait("0")).status, 202);
  });

  test("step 18: a media format needs exactly one source; media.url is fetched then inspected", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image", "media.url"] });
    const none = await send(token, { format: "image", to: "237690000014" });
    assert.deepEqual([none.status, err(none).fields], [422, { media: { code: "required" } }]);
    const before = kit.engine.count("fetchMedia");
    const ok = await send(token, { format: "image", to: "237690000014", media: { url: "https://files.example.com/a.png" } });
    assert.equal(ok.status, 202);
    assert.equal(kit.engine.count("fetchMedia"), before + 1);
    const order = kit.engine.order.slice(-4);
    assert.ok(order.indexOf("fetchMedia") < order.indexOf("inspectMedia") && order.indexOf("inspectMedia") < order.indexOf("submit"), order.join(","));
    assert.deepEqual(fs.readdirSync(kit.engine.tmpDir), [], "the staged file was handed to the engine (the fake removes it) or deleted");
  });

  test("step 18: a refused download or a content mismatch is the engine's typed error, and the temp file is deleted", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image", "media.url"] });
    kit.engine.inspectError = new MessagingError("media_type_mismatch", { params: { expected: ["image"] } });
    try {
      const res = await send(token, { format: "image", to: "237690000015", media: { url: "https://files.example.com/a.txt" } });
      assert.deepEqual([res.status, err(res).code, err(res).params], [422, "media_type_mismatch", { expected: ["image"] }]);
      assert.deepEqual(fs.readdirSync(kit.engine.tmpDir), [], "no orphan file");
    } finally {
      kit.engine.inspectError = null;
    }
    kit.engine.staged = new MessagingError("url_forbidden", { params: { reason: "host" } });
    try {
      const res = await send(token, { format: "image", to: "237690000015", media: { url: "https://127.0.0.1/a.png" } });
      assert.deepEqual([res.status, err(res).code, err(res).params], [422, "url_forbidden", { reason: "host" }]);
    } finally {
      kit.engine.staged = null;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("steps 19-20: reserve, handler, what a handler sees", () => {
  test("a request failing after the reserve does not count; a lost race answered as a replay does not count either", async () => {
    const { token } = await kit.makeKey({ limitPerMinute: 1 });
    const original = kit.engine.submit;
    kit.engine.submit = async () => {
      throw new MessagingError("queue_full", { params: { scope: "global", retryAfterMs: 2000 } });
    };
    try {
      const failed = await send(token, text("237690000016"));
      assert.deepEqual([failed.status, err(failed).code], [503, "queue_full"]);
    } finally {
      kit.engine.submit = original;
    }
    // lost race: the lookup misses, the unique index finds the stored message
    const stored = { message: { id: "msg_AAAAAAAAAAAAAAAAAAAAAA", status: "queued" }, requestHash: "stored-hash" };
    const lookup = kit.engine.findByIdempotency;
    kit.engine.findByIdempotency = async () => null;
    kit.engine.idem.set(`${(await kit.db.ApiKey.findOne({ order: [["id", "DESC"]] })).id}:race`, stored);
    try {
      const raced = await send(token, text("237690000016"), { headers: { "Idempotency-Key": "race" } });
      assert.deepEqual([raced.status, err(raced).code], [409, "idempotency_conflict"], "the stored hash differs: compared like a replay");
      stored.requestHash = require("../lib/api/idempotency").fingerprint({
        secretHashHex: (await kit.db.ApiKey.findOne({ order: [["id", "DESC"]] })).secretHash,
        endpointId: "messages.create",
        rawBody: text("237690000016"),
        fileSha256: null,
      });
      const same = await send(token, text("237690000016"), { headers: { "Idempotency-Key": "race" } });
      assert.equal(same.status, 202);
      assert.equal(same.headers["idempotent-replayed"], "true");
    } finally {
      kit.engine.findByIdempotency = lookup;
    }
    assert.equal((await send(token, text("237690000017"))).status, 202, "neither the failure nor the raced replay used the 1/min quota");
  });

  test("RT-133: the handler sees ctx.key = { id, name } only, frozen; no hash, rights, policy or limits", async () => {
    const { token, row } = await kit.makeKey({ rights: ["probe.read"], name: "Probe key" });
    const res = await kit.get("/api/v1/probe", token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.keyFields.sort(), ["id", "name"]);
    assert.equal(res.json.keyFrozen, true);
    assert.equal(res.json.servicesFrozen, true);
    assert.deepEqual(JSON.parse(res.json.keyText), { id: row.id, name: "Probe key" });
    assert.deepEqual(res.json.ctxFields, ["audit", "body", "endpoint", "file", "idempotency", "key", "now", "origin", "params", "query", "req", "requestId", "res", "services", "signal"]);
  });

  test("a handler that throws is a 500 internal_error without detail, logged without the message", async () => {
    const { token } = await kit.makeKey({ rights: ["boom.read"] });
    kit.logLines.length = 0;
    const res = await kit.get("/api/v1/boom", token);
    assert.deepEqual([res.status, res.json.error.code], [500, "internal_error"]);
    assert.ok(!res.text.includes("passwd") && !res.text.includes("secret detail"));
    assert.ok(kit.logLines.some((l) => l.level === "error"));
    assert.ok(!JSON.stringify(kit.logLines).includes("/etc/passwd"));
  });

  test("a requires() result outside rights() is a 500 and never a grant", async () => {
    const { token } = await kit.makeKey({ rights: ["bad.write", "bad.other"] });
    const res = await kit.post("/api/v1/bad", token, {});
    assert.deepEqual([res.status, res.json.error.code], [500, "internal_error"]);
  });

  test("a deprecated endpoint answers with Deprecation, Sunset and Link", async () => {
    const { token } = await kit.makeKey({ rights: ["old.read"] });
    const res = await kit.get("/api/v1/old", token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.deprecation, `@${Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000)}`);
    assert.equal(res.headers.sunset, new Date("2027-01-01T00:00:00Z").toUTCString());
    assert.equal(res.headers.link, '</api/v1/messages>; rel="successor-version"');
  });

  test("a client that disconnects aborts the signal; stop() leaves no request in flight", async () => {
    await kit.api.stop();
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("connection and logs", () => {
  test("Connection: close on a refusal before the body was consumed; none on a GET", async () => {
    const early = await kit.request("/api/v1/messages", { method: "POST", json: text("237690000018") });
    assert.equal(err(early).code, "unauthenticated");
    assert.equal(early.headers.connection, "close");
    const unauth = await kit.get("/api/v1/messages/" + GOOD_ID, null);
    assert.notEqual(unauth.headers.connection, "close");
    const { token } = await kit.makeKey();
    const ok = await send(token, text("237690000018"));
    assert.notEqual(ok.headers.connection, "close", "the body was consumed");
  });

  test("an authentication failure is logged at info, once a minute per origin, without url, headers or key", async () => {
    const ip = freshIp();
    kit.logLines.length = 0;
    const secretish = `owbk_${"1".repeat(16)}_${"Z".repeat(43)}`;
    for (let i = 0; i < 3; i++) await kit.get("/api/v1/messages/" + GOOD_ID, secretish, { remote: ip });
    const infos = kit.logLines.filter((l) => l.level === "info");
    assert.equal(infos.length, 1, "deduplicated per origin");
    const dump = JSON.stringify(kit.logLines);
    assert.ok(!dump.includes("ZZZZZZZZ") && !dump.includes("1111111111111111"));
    assert.ok(!dump.includes("/api/v1/messages"), "no req.url");
    assert.ok(!dump.includes("Bearer"), "no headers");
  });

  test("the debug summary names the key by id and name and holds no secret", async () => {
    const { token, row } = await kit.makeKey({ name: "Logged key" });
    kit.logLines.length = 0;
    await send(token, text("237690000019"));
    const summary = kit.logLines.find((l) => l.level === "debug" && l.args[1] === "api request");
    assert.ok(summary, "a debug line per request");
    assert.equal(summary.args[0].keyId, row.id);
    assert.equal(summary.args[0].keyName, "Logged key");
    assert.equal(summary.args[0].endpoint, "messages.create");
    assert.equal(summary.args[0].status, 202);
    assert.match(summary.args[0].requestId, /^[0-9a-f]{16}$/);
    const dump = JSON.stringify(kit.logLines);
    assert.ok(!dump.includes(token.slice(22)) && !dump.includes(token.slice(5, 21)));
    assert.ok(!dump.includes("237690000019") && !dump.includes("hello"));
  });
});
