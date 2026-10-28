"use strict";
/**
 * HTTP core of the admin panel with the authentication stubbed (admin-http-api.md sections 1.1 to 1.13):
 * deny-by-default registration, parameter patterns, 405/404, the unsafe-request guard in its stated order,
 * body caps and the strict schema, security headers on every status, static serving and traversal vectors,
 * trust-proxy parsing, the boot / maintenance gates, and the "no I/O, no timer at creation" rule.
 *
 * No database, no WhatsApp, no network: the admin listens on 127.0.0.1:0 and a stub implements deps.auth.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createRouter } = require("../lib/admin/http/router");
const { createAdmin } = require("../lib/admin");
const { AdminError, reply } = require("../lib/admin/http/response");
const { createTrustProxy, parseTrustProxy, keyOf } = require("../lib/admin/http/trustProxy");
const { SECURITY_HEADERS } = require("../lib/admin/http/security");
const { startStubAdmin, createStubAuth, recordingLogger, rawRequest } = require("./helpers/adminStub");
const { createClock } = require("./helpers/fakeClock");

const noop = async () => ({});

/** The strings of this agent's i18n fragment, applied like fakes.applyPendingI18n (the merge is W2-A's job). */
function applyFragment(file) {
  const { languageManager } = require("../lib/utils/language");
  const fragment = JSON.parse(fs.readFileSync(path.join(fakes.ROOT, "specs", "002-admin-panel", "i18n", file), "utf8"));
  const lang = String(languageManager.currentLang || "en").substring(0, 2);
  for (const [key, value] of Object.entries(fragment[lang] || fragment.en)) {
    const parts = key.split(".");
    let node = languageManager.translations;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  }
}

// ---------------------------------------------------------------------------
// Registration (deny by default)
// ---------------------------------------------------------------------------

describe("route registration", () => {
  const ok = { method: "GET", path: "/admin/api/x", auth: "session", handler: noop };

  test("a route without auth throws (deny by default)", () => {
    const router = createRouter();
    assert.throws(() => router.route({ method: "GET", path: "/admin/api/x", handler: noop }), /auth is required/);
    assert.throws(() => router.route({ ...ok, auth: "anyone" }), /auth is required/);
    assert.equal(router.routes().length, 0);
  });

  test("csrf: false on a non-GET route throws; csrf on a GET route throws", () => {
    const router = createRouter();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.throws(() => router.route({ ...ok, method, csrf: false }), /GET routes/);
    }
    assert.throws(() => router.route({ ...ok, csrf: true }), /POST, PUT, PATCH and DELETE only/);
    assert.throws(() => router.route({ ...ok, csrf: "origin" }), /POST, PUT, PATCH and DELETE only/);
  });

  test("csrf defaults: true for a session POST, origin for public and setup POST, false for GET", () => {
    const router = createRouter();
    router.route({ ...ok, path: "/admin/api/a" });
    router.route({ ...ok, path: "/admin/api/b", method: "POST" });
    router.route({ ...ok, path: "/admin/api/c", method: "POST", auth: "public" });
    router.route({ ...ok, path: "/admin/api/d", method: "POST", auth: "setup" });
    const byPath = Object.fromEntries(router.routes().map((r) => [r.path, r]));
    assert.equal(byPath["/admin/api/a"].csrf, false);
    assert.equal(byPath["/admin/api/b"].csrf, true);
    assert.equal(byPath["/admin/api/c"].csrf, "origin");
    assert.equal(byPath["/admin/api/d"].csrf, "origin");
    assert.throws(() => router.route({ ...ok, path: "/admin/api/e", method: "POST", auth: "public", csrf: true }), /needs a session/);
  });

  test("mutates defaults to method !== GET and a GET route may not declare it", () => {
    const router = createRouter();
    router.route({ ...ok, path: "/admin/api/a" });
    router.route({ ...ok, path: "/admin/api/b", method: "DELETE" });
    const byPath = Object.fromEntries(router.routes().map((r) => [r.path, r]));
    assert.equal(byPath["/admin/api/a"].mutates, false);
    assert.equal(byPath["/admin/api/b"].mutates, true);
    assert.throws(() => router.route({ ...ok, path: "/admin/api/c", mutates: true }), /must not mutate/);
  });

  test("touch defaults to true; the table lists method, path, auth, csrf, mutates, touch", () => {
    const router = createRouter();
    router.route(ok);
    router.route({ ...ok, path: "/admin/api/y", touch: false });
    const [a, b] = router.routes();
    assert.deepEqual(Object.keys(a).sort(), ["auth", "csrf", "db", "method", "mutates", "path", "touch"]);
    assert.equal(a.touch, true);
    assert.equal(b.touch, false);
  });

  test("a duplicate route throws", () => {
    const router = createRouter();
    router.route(ok);
    assert.throws(() => router.route(ok), /already registered/);
    assert.doesNotThrow(() => router.route({ ...ok, method: "DELETE" }));
  });

  test("shape conflicts and invalid definitions", () => {
    const router = createRouter();
    router.route({ ...ok, path: "/admin/api/items/:id" });
    assert.throws(() => router.route({ ...ok, path: "/admin/api/items/:key" }), /already registered/);
    assert.throws(() => router.route({ ...ok, path: "/admin/api/things/:weird" }), /no pattern for :weird/);
    assert.doesNotThrow(() => router.route({ ...ok, path: "/admin/api/things/:weird", params: { weird: /^x+$/ } }));
    assert.throws(() => router.route({ ...ok, path: "/admin/api/z", bodyLimit: 1024 * 1024 + 1 }), /bodyLimit/);
    assert.doesNotThrow(() => router.route({ ...ok, path: "/admin/api/z", bodyLimit: 1024 * 1024 }));
    assert.throws(() => router.route({ ...ok, path: "/api/not-admin" }), /must start with \/admin/);
    assert.throws(() => router.route({ ...ok, path: "/admin/api/a//b" }), /invalid route path/);
    assert.throws(() => router.route({ ...ok, path: "/admin/api/trailing/" }), /invalid route path/);
    assert.throws(() => router.route({ ...ok, path: "/admin/*", auth: "session" }), /wildcard/);
    assert.throws(() => router.route({ ...ok, path: "/admin/*", method: "POST", auth: "public" }), /wildcard/);
    assert.throws(() => router.route({ ...ok, path: "/admin/api/w", handler: null }), /handler/);
    assert.throws(() => router.route({ ...ok, path: "/admin/api/v", db: "required" }), /db must be/);
  });
});

// ---------------------------------------------------------------------------
// The server, with test routes
// ---------------------------------------------------------------------------

/** Test routes registered next to the real ones (events, jobs, uploads). */
function testRoutes({ router, deps }) {
  const seen = { audit: [] };
  const sessionRoute = (def) => router.route({ auth: "session", ...def });

  sessionRoute({ method: "GET", path: "/admin/api/t/ping", handler: () => ({ ok: true }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/live", touch: false, db: "optional", handler: () => ({ ok: true }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/dbonly", handler: () => ({ ok: true }) });
  sessionRoute({
    method: "GET",
    path: "/admin/api/t/same-origin",
    sameOrigin: true,
    db: "optional",
    handler: () => ({ ok: true }),
  });
  sessionRoute({
    method: "GET",
    path: "/admin/api/t/ctx/:id",
    handler: (ctx) => ({
      params: ctx.params,
      query: { ...ctx.query },
      queryProto: Object.getPrototypeOf(ctx.query),
      now: ctx.now,
      origin: ctx.origin,
      requestId: ctx.requestId,
      sessionId: ctx.session.id,
      hasSignal: ctx.signal instanceof AbortSignal,
    }),
  });
  sessionRoute({ method: "GET", path: "/admin/api/t/groups/:jid", handler: (ctx) => ({ jid: ctx.params.jid }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/items/:id", handler: (ctx) => ({ id: ctx.params.id }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/texts/:lang/:key", handler: (ctx) => ({ ...ctx.params }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/users/:userJid", handler: (ctx) => ({ ...ctx.params }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/boom", handler: () => { throw new Error("secret detail /home/x token=abc"); } });
  sessionRoute({ method: "GET", path: "/admin/api/t/typed", handler: () => { throw new AdminError("conflict", { fields: { PREFIX: { code: "conflict", params: { version: 3 } } } }); } });
  sessionRoute({ method: "GET", path: "/admin/api/t/engine", handler: () => { const e = new Error("busy engine"); e.code = "busy"; e.params = { type: "x" }; throw e; } });
  sessionRoute({ method: "GET", path: "/admin/api/t/dbdown", handler: () => { const e = new Error("ECONNREFUSED"); e.name = "SequelizeConnectionRefusedError"; throw e; } });
  sessionRoute({ method: "GET", path: "/admin/api/t/limited", handler: () => { throw new AdminError("rate_limited", { params: { retryAfterMs: 4200 } }); } });
  sessionRoute({ method: "GET", path: "/admin/api/t/see-other", handler: () => reply(303, null, { Location: "/admin/#/x" }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/created", handler: () => reply(201, { item: 1 }) });
  sessionRoute({ method: "GET", path: "/admin/api/t/status-like", handler: () => ({ status: "open", registered: true }) });

  sessionRoute({
    method: "POST",
    path: "/admin/api/t/echo",
    schema: { name: { type: "string", required: true, maxLength: 10 } },
    handler: (ctx) => ({ body: ctx.body, proto: Object.getPrototypeOf(ctx.body) === Object.prototype }),
  });
  sessionRoute({ method: "POST", path: "/admin/api/t/nobody", handler: (ctx) => ({ body: ctx.body }) });
  sessionRoute({ method: "POST", path: "/admin/api/t/limited-body", bodyLimit: 50, handler: (ctx) => ({ body: ctx.body }) });
  sessionRoute({ method: "POST", path: "/admin/api/t/audit", handler: async (ctx) => { await ctx.audit("restart", "t", "ok", { a: 1 }); return { ok: true }; } });
  sessionRoute({ method: "POST", path: "/admin/api/t/db-optional-post", db: "optional", handler: () => ({ ok: true }) });
  router.route({ method: "POST", path: "/admin/api/t/public-post", auth: "public", handler: (ctx) => ({ session: ctx.session }) });
  router.route({ method: "POST", path: "/admin/api/t/setup-post", auth: "setup", handler: (ctx) => ({ session: ctx.session }) });
  router.route({ method: "GET", path: "/admin/api/t/public-get", auth: "public", handler: () => ({ public: true }) });

  deps.seen = seen;
}

describe("admin HTTP core", () => {
  let t;
  let audit;
  let publicDir;

  before(async () => {
    audit = { calls: [], record: async (entry) => { audit.calls.push(entry); return null; } };
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pub-"));
    fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>shell</title>");
    t = await startStubAdmin({ extraRoutes: [testRoutes], audit, publicDir });
  });
  after(async () => {
    await t.close();
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  // --- parameters -----------------------------------------------------------

  test("path parameters: group JID, numeric id, text key, language", async () => {
    const jid = await t.get("/admin/api/t/groups/12036302-1234@g.us");
    assert.equal(jid.status, 200);
    assert.equal(jid.json.jid, "12036302-1234@g.us");
    assert.equal((await t.get("/admin/api/t/groups/123@g.us")).status, 200);
    // decoded ONCE
    assert.equal((await t.get("/admin/api/t/groups/123%40g.us")).json.jid, "123@g.us");
    for (const bad of ["abc@g.us", "123@s.whatsapp.net", "123", "123%2540g.us", "-1@g.us", "123@g.us.evil"]) {
      const res = await t.get(`/admin/api/t/groups/${bad}`);
      assert.equal(res.status, 404, bad);
      assert.equal(res.json.error.code, "not_found");
    }

    for (const good of ["1", "12", "9999999999"]) assert.equal((await t.get(`/admin/api/t/items/${good}`)).status, 200, good);
    for (const bad of ["0", "01", "12345678901", "abc", "1.5", "-3"]) {
      assert.equal((await t.get(`/admin/api/t/items/${bad}`)).status, 404, bad);
    }

    const texts = await t.get("/admin/api/t/texts/fr/plugins.ping.desc");
    assert.deepEqual(texts.json, { lang: "fr", key: "plugins.ping.desc" });
    assert.equal((await t.get("/admin/api/t/texts/de/plugins.ping.desc")).status, 404);
    assert.equal((await t.get("/admin/api/t/texts/en/has%20space")).status, 404);
    assert.equal((await t.get(`/admin/api/t/texts/en/${"k".repeat(161)}`)).status, 404);
    assert.equal((await t.get(`/admin/api/t/texts/en/${"k".repeat(160)}`)).status, 200);

    assert.equal((await t.get("/admin/api/t/users/237612345678@s.whatsapp.net")).status, 200);
    assert.equal((await t.get("/admin/api/t/users/237612345678%3A12%40lid")).status, 200);
    assert.equal((await t.get("/admin/api/t/users/not-a-jid")).status, 404);
  });

  test("a malformed percent-encoding in a parameter is 400, an empty or extra segment is 404", async () => {
    const malformed = await t.get("/admin/api/t/texts/en/%E0%A4%A");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error.code, "bad_request");
    assert.equal((await t.get("/admin/api/t/items/")).status, 404);
    assert.equal((await t.get("/admin/api/t/items/1/")).status, 404);
    assert.equal((await t.get("/admin/api/t/items/1/extra")).status, 404);
    assert.equal((await t.get("/admin/api/t//items/1")).status, 404);
  });

  test("literal segments are matched on the raw path (no decoding of the route itself)", async () => {
    assert.equal((await t.get("/admin/api/t/p%69ng")).status, 404);
    assert.equal((await t.get("/admin/api/t/PING")).status, 404);
    assert.equal((await t.get("/admin/api/t/ping")).status, 200);
    assert.equal((await t.get("/admin/api/t/ping?x=1")).status, 200);
  });

  // --- methods, 404, 405 ----------------------------------------------------

  test("a known path with another method is 405 with Allow, before any authentication", async () => {
    const res = await t.raw({ method: "DELETE", path: "/admin/api/t/ping" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET, HEAD");
    assert.equal(res.json.error.code, "method_not_allowed");
    const post = await t.raw({ method: "GET", path: "/admin/api/t/echo" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "POST");
    const trace = await t.raw({ method: "TRACE", path: "/admin/api/t/ping" });
    assert.equal(trace.status, 405);
  });

  test("OPTIONS anywhere under /admin is 405 and carries no Access-Control header", async () => {
    for (const target of ["/admin", "/admin/", "/admin/api/t/ping", "/admin/api/nothing", "/admin/css/app.css"]) {
      const res = await t.raw({
        method: "OPTIONS",
        path: target,
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
      });
      assert.equal(res.status, 405, target);
      assert.equal(res.json.error.code, "method_not_allowed");
      for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith("access-control-"), `${target}: ${name}`);
    }
  });

  test("an unknown /admin/api/* is the JSON 404, authenticated or not; so is an unknown static path", async () => {
    for (const [target, headers] of [
      ["/admin/api/x", {}],
      ["/admin/api/x", { Cookie: "sid=good" }],
      ["/admin/api", {}],
      ["/admin/api/t/ping/extra", {}],
      ["/admin/does-not-exist.js", {}],
    ]) {
      const res = await t.raw({ path: target, headers });
      assert.equal(res.status, 404, target);
      assert.match(res.headers["content-type"], /^application\/json/);
      assert.equal(res.json.error.code, "not_found");
    }
  });

  test("/administrator, /adminfoo and /ADMIN are not claimed by the admin (they reach the legacy code)", async () => {
    const claims = [];
    const server = require("http").createServer((req, res) => {
      const claimed = t.admin.handle(req, res);
      claims.push([req.url, claimed]);
      if (!claimed) res.end("legacy");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      for (const url of ["/administrator", "/adminfoo", "/ADMIN", "/", "/health", "/api/restart", "/admi", "/x/admin"]) {
        const res = await fetch(`http://127.0.0.1:${port}${url}`);
        assert.equal(await res.text(), "legacy", url);
      }
      for (const url of ["/admin", "/admin/", "/admin/x", "/admin?q=1", "/admin/api/none"]) {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, { redirect: "manual" });
        assert.notEqual(await res.text(), "legacy", url);
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const [url, claimed] of claims) {
      const isAdmin = url === "/admin" || url.startsWith("/admin/") || url.startsWith("/admin?");
      assert.equal(claimed, isAdmin, url);
    }
    // over the wire, the legacy status page answers /administrator
    const legacy = await t.raw({ path: "/administrator" });
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers["content-type"], /text\/html/);
    assert.equal(legacy.headers["access-control-allow-origin"], "*");
    assert.equal(legacy.headers["content-security-policy"], undefined);
  });

  // --- authentication levels ---------------------------------------------------

  test("session routes: 401 unauthenticated without a cookie, 401 session_expired with an unknown one", async () => {
    const none = await t.raw({ path: "/admin/api/t/ping" });
    assert.equal(none.status, 401);
    assert.equal(none.json.error.code, "unauthenticated");
    const stale = await t.raw({ path: "/admin/api/t/ping", headers: { Cookie: "sid=gone" } });
    assert.equal(stale.status, 401);
    assert.equal(stale.json.error.code, "session_expired");
    assert.equal((await t.get("/admin/api/t/ping")).status, 200);
  });

  test("public routes never call authenticate; setup routes call it with their level", async () => {
    t.auth.calls.authenticate.length = 0;
    assert.equal((await t.raw({ path: "/admin/api/t/public-get" })).status, 200);
    assert.deepEqual(t.auth.calls.authenticate, []);

    const headers = { Origin: t.base, "Content-Type": "application/json" };
    const denied = await t.raw({ method: "POST", path: "/admin/api/t/setup-post", headers, body: "{}" });
    assert.equal(denied.status, 401);
    assert.equal(denied.json.error.code, "token_invalid");
    const granted = await t.raw({ method: "POST", path: "/admin/api/t/setup-post", headers: { ...headers, Cookie: "owb_setup=ok" }, body: "{}" });
    assert.equal(granted.status, 200);
    assert.deepEqual(granted.json.session, { kind: "setup" });
    assert.deepEqual(t.auth.calls.authenticate, ["POST /admin/api/t/setup-post", "POST /admin/api/t/setup-post"]);
  });

  test("touch is called once on a live session route, never on touch:false, and not when the guard refuses", async () => {
    t.auth.calls.touch.length = 0;
    await t.get("/admin/api/t/ping");
    assert.deepEqual(t.auth.calls.touch, ["session-good"]);
    await t.get("/admin/api/t/live");
    assert.equal(t.auth.calls.touch.length, 1, "touch:false must not extend the session");
    const refused = await t.send("POST", "/admin/api/t/nobody", { headers: { "X-CSRF-Token": "wrong" }, body: {} });
    assert.equal(refused.status, 403);
    assert.equal(t.auth.calls.touch.length, 1, "a refused request must not extend the session");
    await t.send("POST", "/admin/api/t/nobody", { body: {} });
    assert.equal(t.auth.calls.touch.length, 2);
  });

  // --- the unsafe-request guard ---------------------------------------------------

  describe("unsafe-request guard", () => {
    const post = (headers, body = "{}", name = "good") =>
      t.send("POST", "/admin/api/t/nobody", { headers, rawBody: body, name });

    test("a fully valid request passes", async () => {
      const res = await post({});
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { body: {} });
    });

    test("step 1 comes first: without a session every other defect still answers 401", async () => {
      const res = await t.raw({
        method: "POST",
        path: "/admin/api/t/nobody",
        headers: { Origin: "https://evil.example", "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site" },
        body: "x",
      });
      assert.equal(res.status, 401);
      assert.equal(res.json.error.code, "unauthenticated");
    });

    test("Origin: absent, foreign and null are 403 origin_mismatch; Referer is the fallback", async () => {
      for (const origin of [null, "https://evil.example", "null", "http://127.0.0.1:1", "not a url", "ftp://127.0.0.1"]) {
        const res = await post({ Origin: origin });
        assert.equal(res.status, 403, String(origin));
        assert.equal(res.json.error.code, "origin_mismatch", String(origin));
      }
      const viaReferer = await post({ Origin: null, Referer: `${t.base}/admin/` });
      assert.equal(viaReferer.status, 200);
      const badReferer = await post({ Origin: null, Referer: "https://evil.example/admin/" });
      assert.equal(badReferer.status, 403);
    });

    test("Sec-Fetch-Site: only same-origin is accepted ('none' and 'same-site' are not)", async () => {
      for (const site of ["cross-site", "same-site", "none", ""]) {
        const res = await post({ "Sec-Fetch-Site": site });
        assert.equal(res.status, 403, site);
        assert.equal(res.json.error.code, "origin_mismatch");
      }
      assert.equal((await post({ "Sec-Fetch-Site": "same-origin" })).status, 200);
    });

    test("X-CSRF-Token: missing, wrong, another session's token and an empty one are 403 csrf_invalid", async () => {
      t.auth.addSession("other");
      for (const token of [null, "", "wrong", "csrf-other", t.auth.sessions.get("good").csrf.toUpperCase()]) {
        const res = await post({ "X-CSRF-Token": token });
        assert.equal(res.status, 403, String(token));
        assert.equal(res.json.error.code, "csrf_invalid");
      }
    });

    test("Content-Type: JSON (with charset) passes; text/plain, forms, none and octet-stream are 415", async () => {
      assert.equal((await post({ "Content-Type": "application/json; charset=utf-8" })).status, 200);
      assert.equal((await post({ "Content-Type": "APPLICATION/JSON" })).status, 200);
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/octet-stream", "application/jsonx", null]) {
        const res = await post({ "Content-Type": type });
        assert.equal(res.status, 415, String(type));
        assert.equal(res.json.error.code, "unsupported_media_type");
      }
    });

    test("an empty body is read as {} with the JSON type, and refused with a wrong type (415 even when empty)", async () => {
      assert.deepEqual((await post({}, "")).json, { body: {} });
      assert.equal((await post({ "Content-Type": "text/plain" }, "")).status, 415);
      assert.equal((await post({ "Content-Type": null }, "")).status, 415);
    });

    test("the checks run in the stated order: origin, then Sec-Fetch-Site, then CSRF, then Content-Type", async () => {
      const all = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "X-CSRF-Token": "bad", "Content-Type": "text/plain" };
      assert.equal((await post(all)).json.error.code, "origin_mismatch");
      assert.equal((await post({ ...all, Origin: t.base })).json.error.code, "origin_mismatch"); // Sec-Fetch-Site
      assert.equal((await post({ ...all, Origin: t.base, "Sec-Fetch-Site": "same-origin" })).json.error.code, "csrf_invalid");
      assert.equal(
        (await post({ ...all, Origin: t.base, "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": "csrf-good" })).json.error.code,
        "unsupported_media_type",
      );
    });

    test("PANEL_PUBLIC_URL host and a trusted X-Forwarded-Host are accepted, an untrusted one is not", async () => {
      const proxied = { Origin: "https://panel.example", "X-Forwarded-Host": "panel.example" };
      assert.equal((await post(proxied)).status, 403, "forwarded headers are ignored by default");

      const withPublic = await startStubAdmin({
        config: { PANEL_PUBLIC_URL: "https://panel.example/" },
        extraRoutes: [testRoutes],
      });
      try {
        const res = await withPublic.send("POST", "/admin/api/t/nobody", { headers: { Origin: "https://panel.example" }, body: {} });
        assert.equal(res.status, 200);
        const other = await withPublic.send("POST", "/admin/api/t/nobody", { headers: { Origin: "https://panel.example:8443" }, body: {} });
        assert.equal(other.status, 403);
      } finally {
        await withPublic.close();
      }

      const trustingRoute = await startStubAdmin({ config: { PANEL_TRUST_PROXY: "loopback" }, extraRoutes: [testRoutes] });
      try {
        const res = await trustingRoute.send("POST", "/admin/api/t/nobody", { headers: proxied, body: {} });
        assert.equal(res.status, 200);
        const spoof = await trustingRoute.send("POST", "/admin/api/t/nobody", {
          headers: { Origin: "https://panel.example", "X-Forwarded-Host": "other.example" },
          body: {},
        });
        assert.equal(spoof.status, 403);
      } finally {
        await trustingRoute.close();
      }
    });

    test("an origin mismatch is logged once a minute, with hosts only", async () => {
      const clock = createClock(Date.UTC(2026, 5, 1));
      const logging = await startStubAdmin({ clock, extraRoutes: [testRoutes] });
      try {
        const evil = { Origin: "https://evil.example/path?token=hunter2" };
        for (let i = 0; i < 3; i += 1) await logging.send("POST", "/admin/api/t/nobody", { headers: evil, body: {} });
        const warns = () => logging.logger.lines.filter((l) => l.level === "warn");
        assert.equal(warns().length, 1);
        const text = JSON.stringify(warns()[0].args);
        assert.ok(text.includes("evil.example"));
        assert.ok(!text.includes("hunter2") && !text.includes("/path"), "hosts only: no path, no query");
        await clock.advance(61 * 1000);
        await logging.send("POST", "/admin/api/t/nobody", { headers: evil, body: {} });
        assert.equal(warns().length, 2);
      } finally {
        await logging.close();
      }
    });

    test("public and setup POST routes are checked for Origin and Content-Type but need no CSRF header", async () => {
      const send = (headers, body = "{}") =>
        t.raw({ method: "POST", path: "/admin/api/t/public-post", headers: { "Content-Length": Buffer.byteLength(body), ...headers }, body });
      assert.equal((await send({ Origin: t.base, "Content-Type": "application/json" })).status, 200);
      assert.equal((await send({ "Content-Type": "application/json" })).json.error.code, "origin_mismatch");
      assert.equal((await send({ Origin: "https://evil.example", "Content-Type": "application/json" })).json.error.code, "origin_mismatch");
      assert.equal((await send({ Origin: t.base, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).json.error.code, "origin_mismatch");
      assert.equal((await send({ Origin: t.base, "Content-Type": "text/plain" })).json.error.code, "unsupported_media_type");
    });

    test("a GET flagged sameOrigin refuses a foreign Origin and a cross-site fetch, and accepts a plain request", async () => {
      assert.equal((await t.get("/admin/api/t/same-origin")).status, 200);
      assert.equal((await t.get("/admin/api/t/same-origin", { Origin: t.base })).status, 200);
      assert.equal((await t.get("/admin/api/t/same-origin", { "Sec-Fetch-Site": "same-origin" })).status, 200);
      assert.equal((await t.get("/admin/api/t/same-origin", { Origin: "https://evil.example" })).status, 403);
      assert.equal((await t.get("/admin/api/t/same-origin", { "Sec-Fetch-Site": "cross-site" })).status, 403);
      // an ordinary GET is not subject to the check (the setup link is a cross-site navigation)
      assert.equal((await t.get("/admin/api/t/ping", { "Sec-Fetch-Site": "cross-site" })).status, 200);
    });
  });

  // --- body handling -------------------------------------------------------------

  describe("request body", () => {
    test("a route without bodyLimit or schema accepts {} and an empty body only", async () => {
      assert.deepEqual((await t.send("POST", "/admin/api/t/nobody", { body: {} })).json, { body: {} });
      assert.deepEqual((await t.send("POST", "/admin/api/t/nobody", { rawBody: "" })).json, { body: {} });
      assert.deepEqual((await t.send("POST", "/admin/api/t/nobody", { rawBody: "  \n " })).json, { body: {} });
      const res = await t.send("POST", "/admin/api/t/nobody", { body: { anything: 1 } });
      assert.equal(res.status, 422);
      assert.equal(res.json.error.code, "validation_failed");
      assert.deepEqual(res.json.error.fields, { $unknown: { code: "unknown_field" } });
      assert.ok(!res.text.includes("anything"), "the unknown name is never echoed");
    });

    test("a schema builds a fresh object and refuses unknown properties, __proto__ included", async () => {
      const ok = await t.send("POST", "/admin/api/t/echo", { body: { name: "abc" } });
      assert.deepEqual(ok.json, { body: { name: "abc" }, proto: true });

      const polluted = await t.send("POST", "/admin/api/t/echo", { rawBody: '{"name":"a","__proto__":{"admin":true}}' });
      assert.equal(polluted.status, 422);
      assert.deepEqual(polluted.json.error.fields, { $unknown: { code: "unknown_field" } });
      assert.equal({}.admin, undefined, "Object.prototype was not polluted");

      const missing = await t.send("POST", "/admin/api/t/echo", { body: {} });
      assert.deepEqual(missing.json.error.fields, { name: { code: "required" } });
      const long = await t.send("POST", "/admin/api/t/echo", { body: { name: "x".repeat(11) } });
      assert.deepEqual(long.json.error.fields, { name: { code: "too_long", params: { max: 10 } } });
      assert.ok(!long.text.includes("xxxxx"), "a submitted value is never echoed");
      const wrongType = await t.send("POST", "/admin/api/t/echo", { body: { name: 5 } });
      assert.deepEqual(wrongType.json.error.fields, { name: { code: "invalid_type" } });
    });

    test("strings are NFC-normalised", async () => {
      const decomposed = "é";
      const res = await t.send("POST", "/admin/api/t/echo", { body: { name: decomposed } });
      assert.equal(res.json.body.name, "é");
    });

    test("malformed JSON, arrays, primitives and invalid UTF-8 are 400 bad_request", async () => {
      for (const body of ["{", "{'a':1}", "[]", "123", "null", '"text"', "{} trailing"]) {
        const res = await t.send("POST", "/admin/api/t/nobody", { rawBody: body });
        assert.equal(res.status, 400, body);
        assert.equal(res.json.error.code, "bad_request");
      }
      const bad = await t.raw({
        method: "POST",
        path: "/admin/api/t/nobody",
        headers: { ...t.session().headers, "Content-Length": 4 },
        body: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
      });
      assert.equal(bad.status, 400);
    });

    test("413 comes early from Content-Length (the body is not read), also when chunked", async () => {
      const early = await t.send("POST", "/admin/api/t/limited-body", { rawBody: JSON.stringify({ a: "x".repeat(200) }) });
      assert.equal(early.status, 413);
      assert.equal(early.json.error.code, "payload_too_large");
      assert.deepEqual(early.json.error.params, { maxBytes: 50 });

      const headers = { ...t.session().headers, "Transfer-Encoding": "chunked" };
      const chunked = await t.raw({
        method: "POST",
        path: "/admin/api/t/limited-body",
        headers,
        chunks: ['{"a":"', "x".repeat(40), "x".repeat(40), '"}'],
      });
      assert.equal(chunked.status, 413, "counted while streaming");

      const fits = await t.send("POST", "/admin/api/t/limited-body", { body: { a: "ok" } });
      assert.equal(fits.status, 200);
    });

    test("the default cap is 64 KiB", async () => {
      const big = await t.send("POST", "/admin/api/t/echo", { rawBody: JSON.stringify({ name: "x".repeat(70 * 1024) }) });
      assert.equal(big.status, 413);
      assert.deepEqual(big.json.error.params, { maxBytes: 64 * 1024 });
    });

    test("query strings are null-prototype objects and the first value of a repeated key wins", async () => {
      const res = await t.get("/admin/api/t/ctx/5?a=1&a=2&b=%C3%A9&__proto__=x");
      assert.equal(res.status, 200);
      assert.equal(res.json.query.a, "1");
      assert.equal(res.json.query.b, "é");
      assert.equal(res.json.queryProto, null);
      assert.deepEqual(res.json.params, { id: "5" });
    });
  });

  // --- handler contract ------------------------------------------------------------

  describe("handler results and errors", () => {
    test("ctx carries now, origin, requestId, signal and session; reply() sets the status", async () => {
      t.clock.set(Date.UTC(2026, 2, 3, 4, 5, 6));
      const res = await t.get("/admin/api/t/ctx/9");
      assert.equal(res.json.now, Date.UTC(2026, 2, 3, 4, 5, 6));
      assert.equal(res.json.origin, "127.0.0.1");
      assert.equal(res.json.requestId, res.headers["x-request-id"]);
      assert.match(res.headers["x-request-id"], /^[0-9a-f]{16}$/);
      assert.equal(res.json.sessionId, "session-good");
      assert.equal(res.json.hasSignal, true);
      assert.equal((await t.get("/admin/api/t/created")).status, 201);
      assert.deepEqual((await t.get("/admin/api/t/status-like")).json, { status: "open", registered: true }, "a body with a string status is a plain 200 body");
    });

    test("ctx.audit fills in the request origin", async () => {
      audit.calls.length = 0;
      await t.send("POST", "/admin/api/t/audit", { body: {} });
      assert.deepEqual(audit.calls, [{ action: "restart", target: "t", origin: "127.0.0.1", result: "ok", detail: { a: 1 } }]);
    });

    test("typed errors keep code, fields and params; engine errors with a known code are mapped; the rest is 500", async () => {
      const typed = await t.get("/admin/api/t/typed");
      assert.equal(typed.status, 409);
      assert.deepEqual(typed.json.error.fields, { PREFIX: { code: "conflict", params: { version: 3 } } });

      const engine = await t.get("/admin/api/t/engine");
      assert.equal(engine.status, 409);
      assert.equal(engine.json.error.code, "busy");
      assert.deepEqual(engine.json.error.params, { type: "x" });

      const limited = await t.get("/admin/api/t/limited");
      assert.equal(limited.status, 429);
      assert.equal(limited.headers["retry-after"], "5");

      const down = await t.get("/admin/api/t/dbdown");
      assert.equal(down.status, 503);
      assert.equal(down.json.error.code, "db_unavailable");

      const boom = await t.get("/admin/api/t/boom");
      assert.equal(boom.status, 500);
      assert.equal(boom.json.error.code, "internal_error");
      assert.equal(boom.json.error.requestId, boom.headers["x-request-id"]);
      for (const leaked of ["secret detail", "/home/x", "token=abc", "Error:", "at "]) {
        assert.ok(!boom.text.includes(leaked), `500 body leaks ${JSON.stringify(leaked)}`);
      }
      const logged = t.logger.lines.filter((l) => l.level === "error");
      assert.ok(logged.length >= 1, "the real error goes to the logger");
    });

    test("HEAD is answered by the GET route without a body", async () => {
      const res = await t.raw({ method: "HEAD", path: "/admin/api/t/ping", headers: { Cookie: "sid=good" } });
      assert.equal(res.status, 200);
      assert.equal(res.text, "");
      assert.ok(Number(res.headers["content-length"]) > 0);
    });
  });

  // --- headers -------------------------------------------------------------------

  describe("security headers", () => {
    function assertSecure(res, label) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(res.headers[name.toLowerCase()], value, `${label}: ${name}`);
      }
      assert.ok(res.headers["cache-control"], `${label}: Cache-Control`);
      for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith("access-control-"), `${label}: ${name}`);
      assert.match(res.headers["x-request-id"], /^[0-9a-f]{16}$/, `${label}: X-Request-Id`);
    }

    test("the Content-Security-Policy is the one of the contract", () => {
      assert.equal(
        SECURITY_HEADERS["Content-Security-Policy"],
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
      );
    });

    test("every status class carries them: 200 303 304 308 401 403 404 405 413 415 422 429 500 503", async () => {
      const served = await t.raw({ path: "/admin/" });
      const etag = served.headers.etag;
      const cases = {
        200: await t.get("/admin/api/t/ping"),
        201: await t.get("/admin/api/t/created"),
        303: await t.get("/admin/api/t/see-other"),
        304: await t.raw({ path: "/admin/", headers: { "If-None-Match": etag } }),
        308: await t.raw({ path: "/admin" }),
        401: await t.raw({ path: "/admin/api/t/ping" }),
        403: await t.send("POST", "/admin/api/t/nobody", { headers: { "X-CSRF-Token": "no" }, body: {} }),
        404: await t.raw({ path: "/admin/api/none" }),
        405: await t.raw({ method: "DELETE", path: "/admin/api/t/ping" }),
        413: await t.send("POST", "/admin/api/t/limited-body", { rawBody: "x".repeat(100) }),
        415: await t.send("POST", "/admin/api/t/nobody", { headers: { "Content-Type": "text/plain" }, body: {} }),
        422: await t.send("POST", "/admin/api/t/echo", { body: {} }),
        429: await t.get("/admin/api/t/limited"),
        500: await t.get("/admin/api/t/boom"),
        503: await t.get("/admin/api/t/dbdown"),
      };
      for (const [status, res] of Object.entries(cases)) {
        assert.equal(res.status, Number(status), `expected ${status}`);
        assertSecure(res, String(status));
      }
      assert.equal(cases[303].headers.location, "/admin/#/x");
      assert.equal(cases[308].headers.location, "/admin/");
      assert.equal(cases[200].headers["cache-control"], "no-store");
      assert.equal(cases[404].headers["cache-control"], "no-store");
    });

    test("every non-2xx body is the JSON envelope", async () => {
      for (const res of [
        await t.raw({ path: "/admin/api/none" }),
        await t.raw({ method: "DELETE", path: "/admin/api/t/ping" }),
        await t.raw({ path: "/admin/api/t/ping" }),
        await t.get("/admin/api/t/boom"),
      ]) {
        assert.match(res.headers["content-type"], /^application\/json; charset=utf-8$/);
        assert.deepEqual(Object.keys(res.json), ["error"]);
        assert.equal(typeof res.json.error.code, "string");
      }
    });
  });

  // --- the boot and maintenance gates -----------------------------------------------

  test("503 starting until runtime.dbReady; db:optional routes and static files still answer", async () => {
    const runtime = { dbReady: false };
    const booting = await startStubAdmin({ runtime, extraRoutes: [testRoutes] });
    try {
      const needsDb = await booting.get("/admin/api/t/dbonly");
      assert.equal(needsDb.status, 503);
      assert.equal(needsDb.json.error.code, "starting");
      assert.equal((await booting.get("/admin/api/t/live")).status, 200);
      assert.equal((await booting.raw({ path: "/admin/api/t/public-get" })).status, 503);
      assert.equal((await booting.raw({ path: "/admin/" })).status, 200);
      const post = await booting.send("POST", "/admin/api/t/nobody", { body: {} });
      assert.equal(post.status, 503);
      runtime.dbReady = true;
      assert.equal((await booting.get("/admin/api/t/dbonly")).status, 200);
    } finally {
      await booting.close();
    }
  });

  test("503 maintenance + Retry-After: 5 on mutating routes while a restore applies; reads still answer", async () => {
    const maintenance = { active: false, isActive() { return this.active; } };
    const gated = await startStubAdmin({ maintenanceMode: maintenance, extraRoutes: [testRoutes] });
    try {
      assert.equal((await gated.send("POST", "/admin/api/t/nobody", { body: {} })).status, 200);
      maintenance.active = true;
      const refused = await gated.send("POST", "/admin/api/t/db-optional-post", { body: {} });
      assert.equal(refused.status, 503);
      assert.equal(refused.json.error.code, "maintenance");
      assert.equal(refused.headers["retry-after"], "5");
      assert.equal((await gated.get("/admin/api/t/ping")).status, 200, "reads keep working");
      maintenance.active = false;
      assert.equal((await gated.send("POST", "/admin/api/t/nobody", { body: {} })).status, 200);
    } finally {
      await gated.close();
    }
  });

  // --- bus -> audit ------------------------------------------------------------------

  test("start() persists groupguard:action as guard.antibot.* audit rows; stop() unsubscribes", async () => {
    const bus = new EventEmitter();
    const calls = [];
    const guarded = await startStubAdmin({ bus, audit: { record: async (entry) => { calls.push(entry); } } });
    try {
      await guarded.admin.start();
      bus.emit("groupguard:action", { rule: "3EB0-40", groupJid: "1@g.us", userJid: "2@s.whatsapp.net", outcome: "removed" });
      bus.emit("groupguard:action", { rule: "3EB0-22", groupJid: "1@g.us", userJid: "3@s.whatsapp.net", outcome: "suspect" });
      bus.emit("groupguard:action", { rule: "antilink", groupJid: "1@g.us", userJid: "4@s.whatsapp.net", outcome: "deleted" });
      assert.deepEqual(
        calls.map((c) => [c.action, c.target, c.origin, c.result]),
        [
          ["guard.antibot.remove", "1@g.us", "system", "ok"],
          ["guard.antibot.suspect", "1@g.us", "system", "ok"],
        ],
      );
      assert.deepEqual(calls[0].detail, { jid: "2@s.whatsapp.net", rule: "3EB0-40" });
      await guarded.admin.stop();
      bus.emit("groupguard:action", { rule: "x", groupJid: "1@g.us", userJid: "5@s.whatsapp.net", outcome: "removed" });
      assert.equal(calls.length, 2);
      assert.equal(bus.listenerCount("groupguard:action"), 0);
    } finally {
      await guarded.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

describe("static files", () => {
  let dir;
  let outside;
  let t;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-public-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "owb-outside-"));
    fs.writeFileSync(path.join(outside, "secret.html"), "TOP-SECRET-OUTSIDE");
    fs.writeFileSync(path.join(path.dirname(dir), "owb-sibling-secret.txt"), "TOP-SECRET-SIBLING");
    const put = (rel, content) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    put("index.html", "<!doctype html><title>shell</title>");
    put("css/app.css", "body{color:red}");
    put("js/app.mjs", "export default 1;");
    put("i18n/en.json", '{"a":"b"}');
    put("icons.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
    put("favicon.ico", Buffer.from([0, 0, 1, 0]));
    put("notes.txt", "no known extension: not served");
    put(".hidden.html", "dot file");
    put("vendor/preact.mjs", "export const h = 1;");
    fs.symlinkSync(path.join(outside, "secret.html"), path.join(dir, "link.html"));
    t = await startStubAdmin({ publicDir: dir });
  });
  after(async () => {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(dir), "owb-sibling-secret.txt"), { force: true });
  });

  test("the shell and the assets are public, with the right content types", async () => {
    const expected = {
      "/admin/": "text/html; charset=utf-8",
      "/admin/index.html": "text/html; charset=utf-8",
      "/admin/css/app.css": "text/css; charset=utf-8",
      "/admin/js/app.mjs": "text/javascript; charset=utf-8",
      "/admin/i18n/en.json": "application/json; charset=utf-8",
      "/admin/icons.svg": "image/svg+xml",
      "/admin/favicon.ico": "image/x-icon",
      "/admin/vendor/preact.mjs": "text/javascript; charset=utf-8",
    };
    for (const [target, type] of Object.entries(expected)) {
      const res = await t.raw({ path: target });
      assert.equal(res.status, 200, target);
      assert.equal(res.headers["content-type"], type, target);
      assert.equal(res.headers["cache-control"], "no-cache", target);
      assert.match(res.headers.etag, /^"[0-9a-f]{40}"$/);
    }
    assert.equal((await t.raw({ path: "/admin/css/app.css" })).text, "body{color:red}");
    assert.equal((await t.raw({ path: "/admin/css/app.css?v=3" })).status, 200);
  });

  test("ETag revalidation gives 304 (also for weak validators, lists and *), HEAD has no body", async () => {
    const first = await t.raw({ path: "/admin/css/app.css" });
    const etag = first.headers.etag;
    for (const value of [etag, `W/${etag}`, `"zzz", ${etag}`, "*"]) {
      const res = await t.raw({ path: "/admin/css/app.css", headers: { "If-None-Match": value } });
      assert.equal(res.status, 304, value);
      assert.equal(res.text, "");
      assert.equal(res.headers.etag, etag);
    }
    assert.equal((await t.raw({ path: "/admin/css/app.css", headers: { "If-None-Match": '"other"' } })).status, 200);
    const head = await t.raw({ method: "HEAD", path: "/admin/css/app.css" });
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.equal(head.headers["content-length"], String("body{color:red}".length));
  });

  test("GET /admin redirects to /admin/ with 308", async () => {
    const res = await t.raw({ path: "/admin" });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, "/admin/");
    assert.equal((await t.raw({ method: "POST", path: "/admin" })).status, 405);
  });

  test("files with an unknown extension, dot files, symbolic links and missing files are not served", async () => {
    for (const target of ["/admin/notes.txt", "/admin/.hidden.html", "/admin/link.html", "/admin/missing.js", "/admin/css/", "/admin/css"]) {
      const res = await t.raw({ path: target });
      assert.equal(res.status, 404, target);
      assert.equal(res.json.error.code, "not_found");
      assert.ok(!res.text.includes("TOP-SECRET") && !res.text.includes("no known extension"));
    }
    assert.equal((await t.raw({ method: "POST", path: "/admin/css/app.css" })).status, 405);
  });

  test("traversal vectors never return file content", async () => {
    const vectors = [
      "/admin/../package.json",
      "/admin/css/../../package.json",
      "/admin/%2e%2e/package.json",
      "/admin/%2E%2E/%2E%2E/package.json",
      "/admin/css/%2e%2e%2f%2e%2e%2fpackage.json",
      "/admin/..%2fpackage.json",
      "/admin/css/..%5c..%5cpackage.json",
      "/admin/css\\..\\..\\package.json",
      "/admin/%00",
      "/admin/css/app.css%00.png",
      "/admin/%252e%252e/package.json",
      "/admin/%252e%252e%252fowb-sibling-secret.txt",
      "/admin//etc/passwd",
      "/admin/css//app.css",
      "/admin/./css/app.css",
      "/admin/css/./app.css",
      "/admin/link.html",
      "/admin/.hidden.html",
      `/admin/..${"/..".repeat(6)}/etc/passwd`,
    ];
    for (const target of vectors) {
      const res = await t.raw({ path: target });
      assert.equal(res.status, 404, target);
      assert.match(res.headers["content-type"], /^application\/json/);
      assert.ok(!/"name"\s*:|root:|TOP-SECRET|body\{/.test(res.text), `${target} returned file content`);
    }
  });
});

// ---------------------------------------------------------------------------
// Trust proxy
// ---------------------------------------------------------------------------

describe("trust proxy", () => {
  const req = (peer, headers = {}, extra = {}) => ({ socket: { remoteAddress: peer, ...extra }, headers });

  test("PANEL_TRUST_PROXY parsing: keywords, addresses, CIDR; invalid turns the feature off", () => {
    const off = parseTrustProxy("");
    assert.equal(off.enabled, false);
    assert.equal(parseTrustProxy("loopback").matches("127.0.0.1"), true);
    assert.equal(parseTrustProxy("loopback").matches("::1"), true);
    assert.equal(parseTrustProxy("loopback").matches("::ffff:127.0.0.1"), true);
    assert.equal(parseTrustProxy("loopback").matches("10.0.0.1"), false);
    const priv = parseTrustProxy("private");
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.0.5", "fd00::1", "fe80::1", "127.0.0.1"]) {
      assert.equal(priv.matches(ip), true, ip);
    }
    for (const ip of ["172.32.0.1", "8.8.8.8", "2001:db8::1"]) assert.equal(priv.matches(ip), false, ip);
    const list = parseTrustProxy("203.0.113.7, 198.51.100.0/24 2001:db8::/32");
    assert.equal(list.matches("203.0.113.7"), true);
    assert.equal(list.matches("203.0.113.8"), false);
    assert.equal(list.matches("198.51.100.200"), true);
    assert.equal(list.matches("2001:db8:1::5"), true);
    assert.equal(parseTrustProxy("all").matches("8.8.8.8"), true);
    for (const invalid of ["not-an-ip", "10.0.0.0/33", "10.0.0.0/x", "loopback, banana", "::1/129", "10.0.0.1/"]) {
      const parsed = parseTrustProxy(invalid);
      assert.equal(parsed.enabled, false, invalid);
      assert.equal(parsed.invalid, true, invalid);
      assert.equal(parsed.matches("127.0.0.1"), false);
    }
  });

  test("an invalid value warns once and falls back to the socket address", () => {
    let warnings = 0;
    let value = "loopback, banana";
    const trust = createTrustProxy({ read: () => value, onInvalid: () => (warnings += 1) });
    const r = req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" });
    assert.equal(trust.originKey(r), "127.0.0.1");
    assert.equal(trust.originKey(r), "127.0.0.1");
    assert.equal(warnings, 1);
    value = "loopback";
    assert.equal(trust.originKey(r), "203.0.113.9", "the setting is re-read when it changes");
  });

  test("X-Forwarded-For is ignored from an untrusted peer and honoured from a trusted one", () => {
    const off = createTrustProxy({ value: "" });
    const spoofed = req("198.51.100.4", { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" });
    assert.equal(off.originKey(spoofed), "198.51.100.4");
    assert.equal(off.isHttps(spoofed), false);

    const loopback = createTrustProxy({ value: "loopback" });
    assert.equal(loopback.originKey(spoofed), "198.51.100.4", "the peer does not match");
    assert.equal(loopback.originKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
    assert.equal(loopback.originKey(req("::1", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
    assert.equal(loopback.originKey(req("::ffff:127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  });

  test("the right-most entry that is not itself trusted is the client", () => {
    const trust = createTrustProxy({ value: "loopback, 10.0.0.0/8" });
    // the client forged the first entries; the proxies appended the real address and their own hop
    assert.equal(trust.originKey(req("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 203.0.113.9, 10.0.0.2" })), "203.0.113.9");
    assert.equal(trust.originKey(req("127.0.0.1", { "x-forwarded-for": "10.0.0.5, 10.0.0.2" })), "10.0.0.5", "all trusted: the left-most");
    assert.equal(trust.originKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9,203.0.113.10" })), "203.0.113.10");
    assert.equal(trust.originKey(req("127.0.0.1", {})), "127.0.0.1");
    assert.equal(trust.originKey(req("127.0.0.1", { "x-forwarded-for": "garbage" })), "127.0.0.1", "garbage fails closed on the socket");
    assert.equal(trust.originKey(req("127.0.0.1", { "x-forwarded-for": ["1.1.1.1", "203.0.113.9"] })), "203.0.113.9");
  });

  test("IPv4-mapped IPv6 is unmapped; IPv6 is grouped by /64", () => {
    assert.equal(keyOf("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(keyOf("::ffff:cb00:7109"), "203.0.113.9");
    assert.equal(keyOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
    assert.equal(keyOf("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
    assert.equal(keyOf("2001:0DB8:0001:0002::1"), "2001:db8:1:2::/64");
    assert.equal(keyOf("2001:db8::1"), "2001:db8:0:0::/64");
    assert.notEqual(keyOf("2001:db8:1:3::1"), keyOf("2001:db8:1:2::1"));
    const trust = createTrustProxy({ value: "all" });
    assert.equal(trust.originKey(req("::ffff:198.51.100.4")), "198.51.100.4");
    assert.equal(trust.originKey(req("2001:db8:aa:bb:1:2:3:4")), "2001:db8:aa:bb::/64");
    assert.equal(trust.originKey(req("fe80::1%eth0")), "fe80:0:0:0::/64");
  });

  test("HTTPS: encrypted socket, or X-Forwarded-Proto from a trusted peer only", () => {
    const trust = createTrustProxy({ value: "loopback" });
    assert.equal(trust.isHttps(req("203.0.113.9", {}, { encrypted: true })), true);
    assert.equal(trust.isHttps(req("127.0.0.1", { "x-forwarded-proto": "https" })), true);
    assert.equal(trust.isHttps(req("127.0.0.1", { "x-forwarded-proto": "HTTPS" })), true);
    assert.equal(trust.isHttps(req("127.0.0.1", { "x-forwarded-proto": "http" })), false);
    assert.equal(trust.isHttps(req("127.0.0.1", { "x-forwarded-proto": "https, http" })), false, "the right-most value is the proxy's own");
    assert.equal(trust.isHttps(req("203.0.113.9", { "x-forwarded-proto": "https" })), false);
    assert.equal(trust.isHttps(req("127.0.0.1", {})), false);
  });

  test("proxyHint lists the forwarded headers that came from an untrusted peer", () => {
    const trust = createTrustProxy({ value: "" });
    assert.deepEqual(trust.proxyHint(req("203.0.113.9", {})), []);
    assert.deepEqual(trust.proxyHint(req("203.0.113.9", { "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" })), ["x-forwarded-for", "x-real-ip"]);
    const declared = createTrustProxy({ value: "loopback" });
    assert.deepEqual(declared.proxyHint(req("127.0.0.1", { "x-forwarded-for": "1.2.3.4" })), []);
    assert.deepEqual(declared.proxyHint(req("203.0.113.9", { forwarded: "for=1.2.3.4" })), ["forwarded"]);
    assert.deepEqual(declared.forwardedHosts(req("127.0.0.1", { "x-forwarded-host": "A.example, b.example" })), ["a.example", "b.example"]);
    assert.deepEqual(declared.forwardedHosts(req("203.0.113.9", { "x-forwarded-host": "a.example" })), []);
  });

  test("over HTTP, ctx.origin follows the setting", async () => {
    const trusting = await startStubAdmin({ config: { PANEL_TRUST_PROXY: "loopback" }, extraRoutes: [testRoutes] });
    const plain = await startStubAdmin({ extraRoutes: [testRoutes] });
    try {
      const viaProxy = await trusting.get("/admin/api/t/ctx/1", { "X-Forwarded-For": "203.0.113.9" });
      assert.equal(viaProxy.json.origin, "203.0.113.9");
      const ignored = await plain.get("/admin/api/t/ctx/1", { "X-Forwarded-For": "203.0.113.9" });
      assert.equal(ignored.json.origin, "127.0.0.1");
    } finally {
      await trusting.close();
      await plain.close();
    }
  });
});

// ---------------------------------------------------------------------------
// createAdmin
// ---------------------------------------------------------------------------

describe("createAdmin", () => {
  test("performs no I/O and starts no timer", () => {
    const dataDir = path.join(os.tmpdir(), `owb-never-created-${process.pid}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
    const started = [];
    const wrap = (name) => {
      const original = global[name];
      global[name] = (...args) => {
        started.push(name);
        return original(...args);
      };
      return () => {
        global[name] = original;
      };
    };
    const restore = [wrap("setInterval"), wrap("setTimeout")];
    let admin;
    try {
      admin = createAdmin({ auth: createStubAuth(), config: {}, dataDir, runtime: { dbReady: true } });
    } finally {
      restore.forEach((fn) => fn());
    }
    assert.deepEqual(started, [], "no timer at creation");
    assert.equal(fs.existsSync(dataDir), false, "no directory created");
    assert.equal(admin.hub.tickerArmed(), false);
    assert.equal(admin.uploads.janitorArmed(), false);
    assert.equal(admin.sse.count(), 0);
    assert.ok(admin.routes().length >= 6);
    assert.equal(admin.handle({ url: "/health", method: "GET", headers: {} }, {}), false);
  });

  test("start() and stop() are idempotent and leave no timer behind", async () => {
    const clock = createClock();
    const admin = createAdmin({
      auth: createStubAuth(),
      config: {},
      clock,
      timers: clock.timers,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-start-")),
      bus: new EventEmitter(),
      ring: { list: () => [], subscribe: () => () => {} },
      audit: { record: async () => null },
    });
    await admin.start();
    await admin.start();
    assert.equal(admin.uploads.janitorArmed(), true);
    await admin.stop();
    await admin.stop();
    assert.equal(clock.pending(), 0);
    assert.equal(admin.uploads.janitorArmed(), false);
  });

  test("a route module that throws in register() aborts createAdmin loudly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-routes-"));
    fs.writeFileSync(path.join(dir, "a.js"), "module.exports = { register() { throw new Error('boom'); } };");
    assert.throws(() => createAdmin({ auth: createStubAuth(), config: {}, routesDir: dir }), /a\.js failed to register: boom/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "owb-routes-"));
    fs.writeFileSync(path.join(empty, "b.js"), "module.exports = {};");
    assert.throws(() => createAdmin({ auth: createStubAuth(), config: {}, routesDir: empty }), /does not export register/);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test("the auto-loader registers modules in sorted order and skips index.js", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-routes-"));
    const order = [];
    global.__owbRegisterOrder = order;
    for (const name of ["b.js", "a.js", "c.js"]) {
      fs.writeFileSync(path.join(dir, name), `module.exports = { register() { global.__owbRegisterOrder.push(${JSON.stringify(name)}); } };`);
    }
    fs.writeFileSync(path.join(dir, "index.js"), "throw new Error('index.js must not be loaded');");
    try {
      createAdmin({ auth: createStubAuth(), config: {}, routesDir: dir });
      assert.deepEqual(order, ["a.js", "b.js", "c.js"]);
    } finally {
      delete global.__owbRegisterOrder;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The shared server (lib/admin/server.js)
// ---------------------------------------------------------------------------

describe("startAdminServer", () => {
  const { startAdminServer, createPanelServer } = require("../lib/admin/server");
  const net = require("net");
  let publicDir;

  before(() => {
    applyFragment("bot-server.json");
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pub-"));
    fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>shell</title>");
  });
  after(() => fs.rmSync(publicDir, { recursive: true, force: true }));

  const makeAdmin = () =>
    createAdmin({ auth: createStubAuth(), config: {}, runtime: { dbReady: true }, publicDir, logger: recordingLogger() });

  test("listens on the injected bind, serves the admin and the legacy routes from one server, with the contract limits", async () => {
    const logger = recordingLogger();
    const started = await startAdminServer({
      admin: makeAdmin(),
      botState: { status: "running", isConnected: true },
      bind: { host: "127.0.0.1", port: 0 },
      config: {},
      logger,
    });
    try {
      assert.ok(started);
      const port = started.server.address().port;
      assert.equal(started.url, `http://localhost:${port}`);
      assert.equal(started.adminUrl, `http://localhost:${port}/admin/`);
      assert.equal(started.server.headersTimeout, 15 * 1000);
      assert.equal(started.server.maxHeadersCount, 50);
      assert.equal(started.server.maxConnections, 256);

      const health = await rawRequest({ port, path: "/health" });
      assert.equal(health.status, 200);
      assert.equal(health.json.status, "healthy");
      assert.equal((await rawRequest({ port, path: "/admin/" })).status, 200);
      assert.equal((await rawRequest({ port, path: "/admin/api/jobs/1" })).status, 401);
      assert.ok(logger.lines.some((l) => l.level === "info" && String(l.args[0]).includes(`http://localhost:${port}/admin/`)));
    } finally {
      started.server.close();
    }
  });

  test("the printed URL is PANEL_PUBLIC_URL when it is set", async () => {
    const started = await startAdminServer({
      admin: makeAdmin(),
      botState: {},
      bind: () => ({ host: "127.0.0.1", port: 0 }),
      config: { PANEL_PUBLIC_URL: "https://bot.example.com/" },
      logger: recordingLogger(),
    });
    try {
      assert.equal(started.url, "https://bot.example.com");
      assert.equal(started.adminUrl, "https://bot.example.com/admin/");
    } finally {
      started.server.close();
    }
  });

  test("a busy port is never fatal: null, one error naming PANEL_PORT, PANEL_HOST and ADMIN_PANEL=false", async () => {
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address();
    const logger = recordingLogger();
    try {
      const result = await startAdminServer({ admin: makeAdmin(), botState: {}, bind: { host: "127.0.0.1", port }, config: {}, logger });
      assert.equal(result, null);
      const errors = logger.lines.filter((l) => l.level === "error");
      assert.equal(errors.length, 1);
      const message = String(errors[0].args[0]);
      for (const needle of ["PANEL_PORT", "PANEL_HOST", "ADMIN_PANEL=false", String(port), "EADDRINUSE"]) {
        assert.ok(message.includes(needle), `${needle} in: ${message}`);
      }
      assert.ok(holder.listening, "the other listener is untouched");
    } finally {
      holder.close();
    }
  });

  test("an address that is not local (EADDRNOTAVAIL) and a privileged port (EACCES) are not fatal either", async () => {
    const unavailable = await startAdminServer({
      admin: makeAdmin(),
      botState: {},
      bind: { host: "203.0.113.77", port: 0 },
      config: {},
      logger: recordingLogger(),
    });
    assert.equal(unavailable, null);
    if (process.getuid && process.getuid() !== 0) {
      const privileged = await startAdminServer({
        admin: makeAdmin(),
        botState: {},
        bind: { host: "127.0.0.1", port: 81 },
        config: {},
        logger: recordingLogger(),
      });
      assert.equal(privileged, null);
    }
  });

  test("without an admin (ADMIN_PANEL=false) /admin* is the JSON 404 and the legacy routes still answer", async () => {
    const started = await startAdminServer({ botState: { status: "starting" }, bind: { host: "127.0.0.1", port: 0 }, config: {}, logger: recordingLogger() });
    try {
      const port = started.server.address().port;
      const res = await rawRequest({ port, path: "/admin/" });
      assert.equal(res.status, 404);
      assert.equal(res.json.error.code, "not_found");
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assert.equal((await rawRequest({ port, path: "/health" })).status, 503);
    } finally {
      started.server.close();
    }
  });

  test("close() ends open connections instead of waiting for them (an event stream would block it forever)", async () => {
    const admin = makeAdmin();
    const server = createPanelServer({ botState: {}, admin });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("GET /health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
    await new Promise((resolve) => socket.once("data", resolve));
    const closed = new Promise((resolve) => server.close(resolve));
    const outcome = await Promise.race([closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
    assert.equal(outcome, "closed");
    socket.destroy();
  });
});
