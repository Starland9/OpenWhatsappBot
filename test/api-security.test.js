"use strict";
/**
 * Feature 004 (messaging API), SC-002: the security matrix of the public API over the REAL stack (harness
 * test/helpers/apiHarness.js: createApi, the engine, the four endpoint modules, the key store, the quotas), contracts/
 * public-api.md sections 1, 5, 6 and 11. Every endpoint of `api.routes()` is enumerated: no key, a malformed, unknown or
 * wrong key, a revoked, expired or IP-restricted key, every right but the needed one, an out-of-policy recipient and an
 * undeclared verb all end in the contract's refusal and leave the engine and the ApiMessage table untouched.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createApiHarness } = require("./helpers/apiHarness");
const { API_STATUS, statusOf } = require("../lib/api/errors");
const { MESSAGING_STATUS } = require("../lib/messaging/errors");

const MIN = 60 * 1000;
const ID = `msg_${"A".repeat(22)}`;
const TEXT = { format: "text", to: "237690000001", text: "hello" };
const WRONG = `owbk_${"0123456789abcdef"}_${"A".repeat(43)}`;

let h;
let full;
const seen = []; // every response, for the header profile

before(async () => {
  h = await createApiHarness({});
  full = await h.createKey({ name: "full", rights: "all" });
});
after(async () => {
  await h.close();
});

/** a request that also records the response for the profile checks */
async function call(method, path, opts) {
  const res = await h.request(method, path, { fresh: true, ...opts });
  seen.push({ method, path, res });
  return res;
}

const sameAnswer = (res) =>
  JSON.stringify({
    status: res.status,
    headers: Object.fromEntries(Object.entries(res.headers).filter(([name]) => !["x-request-id", "date"].includes(name))),
    body: res.text.replace(/"requestId":"[0-9a-f]{16}"/g, '"requestId":"X"'),
  });

const concrete = (route) => route.path.replace(":id", ID);
const sampleOf = (route) => (route.method === "POST" ? { body: TEXT } : {});
const neededFor = (route) => (route.id === "messages.create" ? ["messages.send.text"] : route.rights);

async function untouched(fn) {
  const before = await h.db.ApiMessage.count();
  const sent = h.sock.sent.length;
  await fn();
  assert.equal(await h.db.ApiMessage.count(), before, "no ApiMessage row was created");
  assert.equal(h.sock.sent.length, sent, "nothing was sent");
}

describe("the route table", () => {
  test("the pinned path set: four endpoints, each with a right", () => {
    const rows = h.api.routes().map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(rows, ["GET /api/v1/messages", "GET /api/v1/messages/:id", "GET /api/v1/openapi.json", "POST /api/v1/messages"]);
    for (const route of h.api.routes()) assert.ok(route.rights.length > 0, `${route.id} declares a right`);
    assert.deepEqual(h.api.state().failure, null);
  });
});

describe("step 7: one answer for a missing, malformed, unknown or wrong key", () => {
  for (const route of ["POST /api/v1/messages", "GET /api/v1/messages", "GET /api/v1/messages/:id", "GET /api/v1/openapi.json"]) {
    const [method, path] = route.split(" ");
    const url = path.replace(":id", ID);
    test(route, async () => {
      await untouched(async () => {
        const shapes = new Set();
        const wrongSecret = `owbk_${full.lookupId}_${"B".repeat(43)}`;
        const variants = [
          {}, // no header
          { headers: { Authorization: "Bearer" } },
          { headers: { Authorization: "Bearer not-a-key" } },
          { headers: { Authorization: "Basic dXNlcjpwYXNz" } },
          { headers: { Authorization: `Bearer ${full.token} ${full.token}` } },
          { token: WRONG }, // well formed, unknown id
          { token: wrongSecret }, // known id, wrong secret
          { token: full.token.toUpperCase() },
          { token: full.token.slice(0, -1) },
        ];
        for (const variant of variants) {
          const res = await call(method, url, { ...sampleOf({ method }), ...variant });
          assert.equal(res.status, 401, JSON.stringify(variant));
          assert.equal(res.json.error.code, "unauthenticated");
          assert.equal(res.headers["www-authenticate"], 'Bearer realm="owb-api"');
          shapes.add(sameAnswer(res));
        }
        // the header-less variant sends an empty request, the others a body: compare the bodied ones with each other
        assert.ok(shapes.size <= 2, "the answers differ only by Connection (an unread body)");
      });
    });
  }

  test("two Authorization headers are refused", async () => {
    const res = await new Promise((resolve, reject) => {
      const http = require("node:http");
      const req = http.request(`${h.base}/api/v1/messages`, { method: "GET", headers: { Authorization: [`Bearer ${full.token}`, `Bearer ${full.token}`] } }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
      req.end();
    }).catch(() => null);
    // Node folds duplicate Authorization headers into one comma-joined value or rejects them: never a success
    if (res) assert.equal(res.status === 200, false);
  });

  test("a panel cookie alone gives 401, and no Set-Cookie is ever produced", async () => {
    const res = await call("GET", "/api/v1/messages", { headers: { Cookie: "owb_session=abcdef; sid=1" } });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "unauthenticated");
    assert.equal(res.headers["set-cookie"], undefined);
  });

  test("a key presented to /admin/api/** is inert", async () => {
    const { createTestAdmin } = require("./helpers/adminHarness");
    const t = await createTestAdmin({});
    try {
      const route = t.admin.routes().find((r) => r.method === "GET" && r.auth === "session" && !r.path.includes(":"));
      assert.ok(route, "a session route exists");
      const res = await fetch(`${t.base}${route.path}`, { headers: { Authorization: full.authorization, "X-API-Key": full.token } });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.notEqual(body.error && body.error.code, "key_revoked");
    } finally {
      await t.close();
    }
  });
});

describe("steps 8 and 9: the key state is shown only to the holder of the whole secret", () => {
  test("revoked, expired and IP outside the list", async () => {
    const revoked = await h.createKey({ name: "revoked", revokedAt: new Date(h.now() - MIN) });
    const expired = await h.createKey({ name: "expired", expiresAt: new Date(h.now() - 1000) });
    const fenced = await h.createKey({ name: "fenced", ipAllow: ["192.0.2.0/24"] });
    for (const route of h.api.routes()) {
      const url = concrete(route);
      await untouched(async () => {
        const a = await call(route.method, url, { ...sampleOf(route), key: revoked });
        assert.equal(a.status, 401);
        assert.equal(a.json.error.code, "key_revoked");
        assert.equal(a.headers["www-authenticate"], 'Bearer realm="owb-api", error="invalid_token"');
        const b = await call(route.method, url, { ...sampleOf(route), key: expired });
        assert.equal(b.status, 401);
        assert.equal(b.json.error.code, "key_expired");
        const c = await call(route.method, url, { ...sampleOf(route), key: fenced });
        assert.equal(c.status, 403);
        assert.equal(c.json.error.code, "ip_not_allowed");
        // the wrong secret of each of these keys is the plain `unauthenticated`
        for (const key of [revoked, expired, fenced]) {
          const w = await call(route.method, url, { ...sampleOf(route), token: `owbk_${key.lookupId}_${"C".repeat(43)}` });
          assert.equal(w.json.error.code, "unauthenticated");
        }
      });
    }
    // an address inside the list is served
    const inside = await h.get("/api/v1/messages", fenced, { remote: "192.0.2.77" });
    assert.equal(inside.status, 200);
  });

  test("a key that expires between two requests is refused at the boundary", async () => {
    const soon = await h.createKey({ name: "soon", expiresAt: new Date(h.now() + 5 * MIN) });
    assert.equal((await h.get("/api/v1/messages", soon)).status, 200);
    await h.clock.advance(5 * MIN);
    const res = await h.get("/api/v1/messages", soon);
    assert.equal(res.json.error.code, "key_expired");
  });
});

describe("steps 10-12b: route match after authentication, then the rights", () => {
  test("every right but the needed one gives forbidden { right }, with nothing touched", async () => {
    for (const route of h.api.routes()) {
      const needed = neededFor(route);
      const key = await h.createKey({ name: `without ${route.id}`, rights: h.allRights().filter((r) => !needed.includes(r)) });
      await untouched(async () => {
        const res = await call(route.method, concrete(route), { ...sampleOf(route), key });
        assert.equal(res.status, 403, route.id);
        assert.equal(res.json.error.code, "forbidden");
        assert.deepEqual(res.json.error.params, { right: needed[0] });
      });
    }
  });

  test("a key with no right at all is refused on every endpoint", async () => {
    const bare = await h.createKey({ name: "bare", rights: [] });
    for (const route of h.api.routes()) {
      const res = await call(route.method, concrete(route), { ...sampleOf(route), key: bare });
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, "forbidden");
    }
  });

  test("media.url and linkPreview need the right media.url, nothing is fetched", async () => {
    const noUrl = await h.createKey({ name: "no url", rights: h.allRights().filter((r) => r !== "media.url") });
    await untouched(async () => {
      for (const body of [
        { format: "image", to: "237690000001", media: { url: "https://files.example.com/a.png" } },
        { format: "text", to: "237690000001", text: "x", linkPreview: true },
      ]) {
        const res = await call("POST", "/api/v1/messages", { key: noUrl, body });
        assert.equal(res.status, 403);
        assert.deepEqual(res.json.error.params, { right: "media.url" });
      }
    });
    assert.equal(h.web.calls.length, 0);
    assert.equal(h.web.resolved.length, 0);
  });

  test("an undeclared verb is 405 with Allow; an unknown path is 404 only for an authenticated caller", async () => {
    const cases = [
      ["DELETE", "/api/v1/messages", "GET, POST"],
      ["PUT", "/api/v1/messages", "GET, POST"],
      ["PATCH", `/api/v1/messages/${ID}`, "GET"],
      ["POST", "/api/v1/openapi.json", "GET"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await call(method, path, { key: full });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.json.error.code, "method_not_allowed");
      assert.deepEqual(res.headers.allow.split(", ").sort(), allow.split(", ").sort());
    }
    for (const path of ["/api/v1/nothing", "/api/v1/messages/", "/api/v1/Messages", "/api/v1//messages", "/api/v2/messages", `/api/v1/messages/${ID}/x`, "/api/v1/messages/msg_short"]) {
      const anonymous = await call("GET", path, {});
      assert.equal(anonymous.status, 401, `${path} gives no hint to an unauthenticated caller`);
      const known = await call("GET", path, { key: full });
      assert.equal(known.status, 404, path);
      assert.equal(known.json.error.code, "not_found");
    }
  });

  test("OPTIONS and HEAD are 405 with no Allow and no CORS header, before authentication", async () => {
    for (const method of ["OPTIONS", "HEAD"]) {
      for (const key of [undefined, full]) {
        const res = await call(method, "/api/v1/messages", { key });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.allow, undefined);
        assert.equal(res.headers["access-control-allow-origin"], undefined);
        if (method === "OPTIONS") assert.equal(res.json.error.code, "method_not_allowed");
      }
    }
  });
});

describe("step 13: recipient policy", () => {
  test("a recipient outside the policy is refused without echoing the number", async () => {
    const listed = await h.createKey({ name: "listed", policy: "list", recipients: ["237690000777@s.whatsapp.net"] });
    await untouched(async () => {
      const res = await call("POST", "/api/v1/messages", { key: listed, body: TEXT });
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, "recipient_not_allowed");
      assert.equal(res.text.includes("237690000001"), false);
      const group = await call("POST", "/api/v1/messages", { key: listed, body: { ...TEXT, to: "120363025246125486@g.us" } });
      assert.equal(group.json.error.code, "recipient_not_allowed");
    });
    const ok = await call("POST", "/api/v1/messages", { key: listed, body: { ...TEXT, to: "+237 690 00 07 77" } });
    assert.equal(ok.status, 202);
  });

  test("the bot's own number is refused after the policy (a restricted key learns nothing)", async () => {
    const listed = await h.createKey({ name: "listed2", policy: "list", recipients: ["237690000777@s.whatsapp.net"] });
    const restricted = await call("POST", "/api/v1/messages", { key: listed, body: { ...TEXT, to: h.OWN_NUMBER } });
    assert.equal(restricted.json.error.code, "recipient_not_allowed");
    const open = await call("POST", "/api/v1/messages", { key: full, body: { ...TEXT, to: h.OWN_NUMBER } });
    assert.equal(open.status, 422);
    assert.deepEqual(open.json.error.fields.to, { code: "not_allowed" });
  });
});

describe("the answer profile", () => {
  test("the error envelope and API_STATUS / MESSAGING_STATUS agree on every refusal seen so far", () => {
    const codes = new Set();
    for (const { res } of seen) {
      if (res.status < 400 || !res.json) continue;
      const error = res.json.error;
      assert.deepEqual(Object.keys(res.json), ["error"]);
      assert.ok(typeof error.code === "string");
      assert.match(error.requestId, /^[0-9a-f]{16}$/);
      assert.equal(error.requestId, res.headers["x-request-id"]);
      assert.equal(res.status, statusOf(error.code), error.code);
      assert.ok(Object.hasOwn(API_STATUS, error.code) || Object.hasOwn(MESSAGING_STATUS, error.code), error.code);
      for (const key of Object.keys(error)) assert.ok(["code", "fields", "params", "requestId"].includes(key), key);
      codes.add(error.code);
    }
    assert.ok(codes.size >= 6, `several codes exercised (${[...codes].join(", ")})`);
  });

  test("the header profile of 1.4 holds for every answer, and Access-Control-* never appears", () => {
    assert.ok(seen.length > 30);
    for (const { method, path, res } of seen) {
      const label = `${method} ${path} -> ${res.status}`;
      assert.match(res.headers["x-request-id"], /^[0-9a-f]{16}$/, label);
      assert.equal(res.headers["cache-control"], "no-store", label);
      assert.equal(res.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'", label);
      assert.equal(res.headers["x-content-type-options"], "nosniff", label);
      assert.equal(res.headers["referrer-policy"], "no-referrer", label);
      assert.equal(res.headers["cross-origin-resource-policy"], "same-origin", label);
      if (method !== "HEAD") assert.match(res.headers["content-type"], /^application\/json; charset=utf-8$/i, label);
      for (const name of Object.keys(res.headers)) {
        assert.equal(/^access-control-/.test(name), false, `${label}: ${name}`);
      }
      for (const name of ["set-cookie", "strict-transport-security", "permissions-policy", "x-frame-options", "content-encoding"]) {
        assert.equal(res.headers[name], undefined, `${label}: ${name}`);
      }
    }
  });
});

describe("steps 3-5: transport, browser, key in the URL", () => {
  test("Origin and Sec-Fetch-Site are refused, with or without a key", async () => {
    for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "same-origin" }]) {
      for (const key of [undefined, full]) {
        const res = await call("GET", "/api/v1/messages", { key, headers });
        assert.equal(res.status, 403);
        assert.equal(res.json.error.code, "browser_not_allowed");
      }
    }
  });

  test("a key in the query or the path is refused and never reaches the key store", async () => {
    let lookups = 0;
    const real = h.api.keys.lookup;
    h.api.keys.lookup = (...args) => {
      lookups += 1;
      return real(...args);
    };
    try {
      const urls = [
        `/api/v1/messages?api_key=${full.token}`,
        "/api/v1/messages?apikey=x",
        "/api/v1/messages?key=x",
        "/api/v1/messages?token=x",
        "/api/v1/messages?access_token=x",
        "/api/v1/messages?authorization=x",
        "/api/v1/messages?Token=x",
        `/api/v1/messages?x=${full.token}`,
        `/api/v1/${full.token}/messages`,
        `/api/v1/messages/${encodeURIComponent(full.token)}`,
      ];
      for (const url of urls) {
        const res = await call("GET", url, { key: full });
        assert.equal(res.status, 400, url);
        assert.equal(res.json.error.code, "key_in_url");
      }
      assert.equal(lookups, 0, "authenticate was never reached");
      assert.equal((await call("GET", "/api/v1/messages", { key: full })).status, 200);
      assert.equal(lookups, 1);
    } finally {
      h.api.keys.lookup = real;
    }
  });

  test("plain HTTP: refused from a public address, accepted over a trusted https proxy, loopback or plainHttpFrom", async () => {
    const remote = { remote: "203.0.113.9", https: false };
    const refused = await call("GET", "/api/v1/messages", { key: full, ...remote });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error.code, "https_required");
    assert.equal((await call("GET", "/api/v1/messages", { key: full, remote: "203.0.113.9" })).status, 200, "X-Forwarded-Proto: https");
    assert.equal((await call("GET", "/api/v1/messages", { key: full })).status, 200, "loopback");
    h.state.plain = ["10.0.0.0/8"];
    assert.equal((await call("GET", "/api/v1/messages", { key: full, remote: "10.1.2.3", https: false })).status, 200, "inside plainHttpFrom");
    assert.equal((await call("GET", "/api/v1/messages", { key: full, remote: "11.1.2.3", https: false })).status, 403, "outside it");
    h.state.plain = [];
    assert.equal((await call("GET", "/api/v1/messages", { key: full, remote: "10.1.2.3", https: false })).status, 403, "refused again once the entry is removed");
    // https_required comes before the key is read: no key at all gives the same answer
    const anonymous = await call("GET", "/api/v1/messages", { ...remote });
    assert.equal(anonymous.json.error.code, "https_required");
  });
});

describe("step 6: the origin block", () => {
  const BAD = `owbk_${"fedcba9876543210"}_${"Z".repeat(43)}`;

  test("10 authentication failures in 5 minutes block the origin for 15 minutes, a valid key included", async () => {
    const origin = { remote: "198.51.100.7" };
    const before = h.alerts.calls.filter((c) => c.type === "api_origin_blocked").length;
    for (let i = 0; i < 10; i += 1) {
      const res = await call("GET", "/api/v1/messages", { token: BAD, ...origin });
      assert.equal(res.status, 401, `failure ${i + 1}`);
    }
    const blocked = await call("GET", "/api/v1/messages", { key: full, ...origin });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "origin_blocked");
    assert.equal(blocked.headers["retry-after"], "900");
    assert.ok(blocked.json.error.params.retryAfterMs <= 15 * MIN);
    // the alert is raised once, however many requests the block refuses
    for (let i = 0; i < 3; i += 1) await call("GET", "/api/v1/messages", { key: full, ...origin });
    assert.equal(h.alerts.calls.filter((c) => c.type === "api_origin_blocked").length, before + 1);
    assert.ok(h.audit.rows.some((row) => row.action === "api.origin.block" && row.result === "blocked"));
    // another origin is served
    assert.equal((await call("GET", "/api/v1/messages", { key: full, remote: "198.51.100.99" })).status, 200);
    // the block ends 15 minutes after it started and is not extended by the refused requests
    await h.clock.advance(15 * MIN + 1000);
    assert.equal((await call("GET", "/api/v1/messages", { key: full, ...origin })).status, 200);
  });

  test("refusals of steps 3-6 and 10-20 never count toward the block", async () => {
    const origin = { remote: "198.51.100.8" };
    const noText = await h.createKey({ name: "no text", rights: ["messages.read"] });
    for (let i = 0; i < 14; i += 1) {
      await call("GET", "/api/v1/messages", { key: full, headers: { Origin: "https://x.example" }, ...origin });
      await call("GET", "/api/v1/messages?token=x", { key: full, ...origin });
      await call("GET", "/api/v1/messages", { key: full, ...origin, https: false });
      await call("GET", "/api/v1/nothing", { key: full, ...origin });
      await call("POST", "/api/v1/messages", { key: noText, body: TEXT, ...origin });
      await call("POST", "/api/v1/messages", { key: full, body: { format: "text", to: "237690000001" }, ...origin });
      await call("DELETE", "/api/v1/messages", { key: full, ...origin });
    }
    const ok = await call("GET", "/api/v1/messages", { key: full, ...origin });
    assert.equal(ok.status, 200, "the origin was never blocked");
  });

  test("a revoked or expired key counts as a failure; the whole secret is needed to learn it", async () => {
    const origin = { remote: "198.51.100.9" };
    const revoked = await h.createKey({ name: "revoked again", revokedAt: new Date(h.now() - MIN) });
    for (let i = 0; i < 10; i += 1) await call("GET", "/api/v1/messages", { key: revoked, ...origin });
    const res = await call("GET", "/api/v1/messages", { key: full, ...origin });
    assert.equal(res.json.error.code, "origin_blocked");
    await h.clock.advance(16 * MIN);
  });
});
