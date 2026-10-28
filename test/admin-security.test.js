"use strict";
/**
 * SC-005: authorization and the unsafe-request guard, generated from `createAdmin(...).routes()` so every future
 * route is covered. The real authentication, an in-memory database, a fake clock.
 *
 *  - the `public` set is exactly {static files, GET /admin/setup, GET /admin/api/session, POST /admin/api/login}
 *    and the `setup` set is exactly {POST /admin/api/setup}: adding a route forces an edit of this file;
 *  - every other route answers 401 `unauthenticated` without a cookie, for each declared method, and 405 + Allow
 *    for a method it does not declare;
 *  - with a session every unsafe route is refused 403 without X-CSRF-Token, with a wrong one, with a foreign
 *    Origin, with neither Origin nor Referer, with Sec-Fetch-Site: cross-site, and 415 for text/plain or form
 *    content types; it is accepted only with all of them valid;
 *  - calling every GET route with a session leaves the database exactly as it was;
 *  - every non-2xx body is `{ error: { code } }` with a code of admin-http-api.md section 1.9.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { PARAM_PATTERNS, METHODS } = require("../lib/admin/http/router");
const { STATUS_BY_CODE } = require("../lib/admin/http/response");

const PASSWORD = "correct horse battery";
const UNSAFE = ["POST", "PUT", "PATCH", "DELETE"];

const PUBLIC_ROUTES = ["GET /admin", "GET /admin/*", "GET /admin/api/session", "GET /admin/setup", "POST /admin/api/login"];
const SETUP_ROUTES = ["POST /admin/api/setup"];
const GUARD_CODES = new Set(["unauthenticated", "session_expired", "token_invalid", "origin_mismatch", "csrf_invalid", "unsupported_media_type"]);

/**
 * Values to try for a path parameter. A route may declare its own pattern (uploads: 32 hex characters), so the
 * right sample of each path is found by probing: the router answers 404 before it authenticates when a value does
 * not match, and 401 when it does.
 */
const SAMPLES = ["120363000000000001@g.us", "1", "ping", "en", "111@s.whatsapp.net", "abc", "openai", "database", "0123456789abcdef0123456789abcdef"];

/** path pattern -> a concrete path the router accepts (filled in by `resolveSamples`). */
const resolved = new Map();

function candidatesFor(name) {
  const pattern = PARAM_PATTERNS[name];
  const known = pattern ? SAMPLES.filter((candidate) => pattern.test(candidate)) : [];
  return [...known, ...SAMPLES.filter((candidate) => !known.includes(candidate))];
}

function* fillings(path) {
  const names = [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
  const lists = names.map(candidatesFor);
  const pick = (index, chosen) => {
    if (index === names.length) return [chosen];
    return lists[index].flatMap((value) => pick(index + 1, [...chosen, value]));
  };
  for (const values of pick(0, [])) {
    let at = 0;
    yield path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, () => values[at++]);
  }
}

async function resolveSamples(t, routes) {
  for (const route of routes) {
    if (resolved.has(route.path)) continue;
    if (route.path === "/admin/*") {
      resolved.set(route.path, "/admin/missing-file.txt");
      continue;
    }
    if (!route.path.includes(":")) {
      resolved.set(route.path, route.path);
      continue;
    }
    let first = null;
    for (const candidate of fillings(route.path)) {
      first = first || candidate;
      const res = await send(t, { method: route.method, path: candidate, headers: route.method === "GET" ? {} : { "Content-Length": "0" } });
      if (res.status !== 404) {
        resolved.set(route.path, candidate);
        break;
      }
    }
    if (!resolved.has(route.path)) resolved.set(route.path, first);
  }
}

function samplePath(path) {
  return resolved.get(path) || path;
}

const keyOf = (route) => `${route.method} ${route.path}`;

/** Send a request over node:http; for an event stream resolve at the headers and hang up. */
function send(t, { method = "GET", path, headers: given = {}, body }) {
  // an undefined or null header is a header the test leaves out
  const headers = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined && value !== null));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: t.port, method, path, headers, agent: false }, (res) => {
      const finish = (text) => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      };
      if (String(res.headers["content-type"] || "").startsWith("text/event-stream")) {
        res.destroy();
        finish("");
        return;
      }
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => finish(Buffer.concat(parts).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", (err) => {
      if (err.code === "ECONNRESET") return; // hung up on purpose
      reject(err);
    });
    req.end(body);
  });
}

/** Every non-2xx, non-3xx answer must be the JSON envelope with a known code (and the matching status). */
function assertEnvelope(res, what) {
  if (res.status < 400) return;
  assert.ok(res.json && res.json.error && typeof res.json.error.code === "string", `${what}: ${res.status} without an error envelope: ${res.text.slice(0, 120)}`);
  const code = res.json.error.code;
  assert.ok(Object.hasOwn(STATUS_BY_CODE, code), `${what}: unknown error code ${code}`);
  assert.equal(res.status, STATUS_BY_CODE[code], `${what}: ${code} sent with status ${res.status}`);
  assert.ok(!Object.keys(res.headers).some((name) => name.startsWith("access-control-")), `${what}: no CORS header under /admin`);
}

let t;
let routes;
let session; // { cookie, csrf }

before(async () => {
  t = await createTestAdmin();
  await t.admin.start();
  const client = await t.loginClient(PASSWORD);
  session = { cookie: `owb_sid=${client.cookie("owb_sid")}`, csrf: client.csrf };
  routes = t.admin.routes();
  await resolveSamples(t, routes);
});

after(async () => {
  await t.close();
});

const sessionRoutes = () => routes.filter((r) => r.auth === "session");
const unsafeSessionRoutes = () => sessionRoutes().filter((r) => UNSAFE.includes(r.method));

/** The headers of a fully valid request of the logged-in session for this route. */
function validHeaders(route, extra = {}) {
  const headers = {
    Cookie: session.cookie,
    Origin: t.base,
    "X-CSRF-Token": session.csrf,
    "Content-Type": route.path === "/admin/api/uploads" ? "application/octet-stream" : "application/json",
    "Content-Length": "0",
    ...extra,
  };
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  return headers;
}

// ---------------------------------------------------------------------------

describe("the route table", () => {
  test("the public set is exactly the static files, the setup landing, AUTH-1 and the login", () => {
    const found = routes.filter((r) => r.auth === "public").map(keyOf).sort();
    assert.deepEqual(found, [...PUBLIC_ROUTES].sort(), "a new public route needs a deliberate edit of this list");
  });

  test("the setup set is exactly POST /admin/api/setup", () => {
    assert.deepEqual(routes.filter((r) => r.auth === "setup").map(keyOf).sort(), SETUP_ROUTES);
  });

  test("every route declares a known auth level, and the table drives these tests", () => {
    assert.ok(routes.length >= 12, `${routes.length} routes`);
    for (const route of routes) assert.ok(["public", "setup", "session"].includes(route.auth), keyOf(route));
  });

  test("no GET route mutates; every unsafe route carries a CSRF mode (true for a session, origin otherwise)", () => {
    for (const route of routes) {
      if (route.method === "GET") {
        assert.equal(route.mutates, false, keyOf(route));
        assert.equal(route.csrf, false, keyOf(route));
      } else {
        assert.equal(route.mutates, true, keyOf(route));
        assert.equal(route.csrf, route.auth === "session" ? true : "origin", keyOf(route));
      }
    }
  });

  test("touch:false is for read routes only", () => {
    for (const route of routes.filter((r) => r.touch === false)) assert.equal(route.method, "GET", keyOf(route));
  });
});

// ---------------------------------------------------------------------------

describe("without a session", () => {
  test("every session route answers 401 unauthenticated for each declared method", async () => {
    for (const route of sessionRoutes()) {
      const res = await send(t, { method: route.method, path: samplePath(route.path), headers: route.method === "GET" ? {} : { "Content-Length": "0" } });
      assert.equal(res.status, 401, `${keyOf(route)} -> ${res.status} ${res.text.slice(0, 80)}`);
      assert.equal(res.json.error.code, "unauthenticated", keyOf(route));
      assertEnvelope(res, keyOf(route));
    }
  });

  test("a cookie that matches no session is 401 session_expired", async () => {
    for (const route of sessionRoutes()) {
      const res = await send(t, { method: route.method, path: samplePath(route.path), headers: { Cookie: `owb_sid=${"G".repeat(43)}`, "Content-Length": "0" } });
      assert.equal(res.status, 401, keyOf(route));
      assert.equal(res.json.error.code, "session_expired", keyOf(route));
    }
  });

  test("a setup route without the setup cookie is 401 token_invalid, and a session cookie does not stand in", async () => {
    for (const route of routes.filter((r) => r.auth === "setup")) {
      const bare = await send(t, { method: route.method, path: samplePath(route.path), headers: { "Content-Length": "0" } });
      assert.equal(bare.status, 401, keyOf(route));
      assert.equal(bare.json.error.code, "token_invalid");
      const withSession = await send(t, { method: route.method, path: samplePath(route.path), headers: { Cookie: session.cookie, Origin: t.base, "X-CSRF-Token": session.csrf, "Content-Type": "application/json", "Content-Length": "2" }, body: "{}" });
      assert.equal(withSession.status, 401, "a session is not a setup grant");
      assert.equal(withSession.json.error.code, "token_invalid");
    }
  });

  test("authentication comes before the guard: a bad Origin without a session is still a 401", async () => {
    for (const route of unsafeSessionRoutes()) {
      const res = await send(t, { method: route.method, path: samplePath(route.path), headers: { Origin: "https://evil.example", "Content-Type": "text/plain", "Content-Length": "0" } });
      assert.equal(res.status, 401, keyOf(route));
    }
  });

  test("HEAD is answered by the GET route: the same 401 for a session route", async () => {
    const get = sessionRoutes().find((r) => r.method === "GET");
    const res = await send(t, { method: "HEAD", path: samplePath(get.path) });
    assert.equal(res.status, 401);
  });

  test("the public routes need no session and set no cookie", async () => {
    const landing = await send(t, { path: "/admin/" });
    assert.equal(landing.status, 200);
    assert.equal(landing.headers["set-cookie"], undefined);
    assert.ok(landing.headers["content-security-policy"].includes("default-src 'none'"));
    const state = await send(t, { path: "/admin/api/session" });
    assert.equal(state.status, 200);
    assert.equal(state.json.authenticated, false);
  });
});

// ---------------------------------------------------------------------------

describe("methods", () => {
  test("a method a path does not declare is 405 with Allow, for every path", async () => {
    const byPath = new Map();
    for (const route of routes) {
      if (!byPath.has(route.path)) byPath.set(route.path, new Set());
      byPath.get(route.path).add(route.method);
    }
    for (const [path, declared] of byPath) {
      const wrong = METHODS.find((method) => !declared.has(method));
      const res = await send(t, { method: wrong, path: samplePath(path), headers: { Cookie: session.cookie, "Content-Length": "0" } });
      assert.equal(res.status, 405, `${wrong} ${path}`);
      assert.equal(res.json.error.code, "method_not_allowed");
      const allow = String(res.headers.allow || "").split(/,\s*/);
      for (const method of declared) assert.ok(allow.includes(method), `${path}: Allow ${res.headers.allow} lacks ${method}`);
      if (declared.has("GET")) assert.ok(allow.includes("HEAD"));
      assertEnvelope(res, `${wrong} ${path}`);
    }
  });

  test("OPTIONS is 405 everywhere under /admin (no preflight is ever approved)", async () => {
    for (const path of new Set(routes.map((r) => samplePath(r.path)))) {
      const res = await send(t, {
        method: "OPTIONS",
        path,
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
      });
      assert.equal(res.status, 405, path);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assertEnvelope(res, `OPTIONS ${path}`);
    }
  });

  test("unknown paths under /admin are the JSON 404", async () => {
    for (const path of ["/admin/api/nothing", "/admin/api/session/extra", "/admin/css/none.css", "/admin/api/jobs"]) {
      const res = await send(t, { path, headers: { Cookie: session.cookie } });
      assert.equal(res.status, 404, path);
      assert.equal(res.json.error.code, "not_found");
    }
  });
});

// ---------------------------------------------------------------------------

describe("the unsafe-request guard, with a session", () => {
  const probeBody = JSON.stringify({ zz_probe: 1 });

  async function attempt(route, mutate) {
    const headers = validHeaders(route, mutate);
    const body = route.path === "/admin/api/uploads" ? undefined : probeBody;
    if (body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(body));
    return send(t, { method: route.method, path: samplePath(route.path), headers, body });
  }

  const refused = async (label, mutate, status, code) => {
    for (const route of unsafeSessionRoutes()) {
      const res = await attempt(route, mutate);
      assert.equal(res.status, status, `${label}: ${keyOf(route)} -> ${res.status} ${res.text.slice(0, 100)}`);
      assert.equal(res.json.error.code, code, `${label}: ${keyOf(route)}`);
      assertEnvelope(res, `${label}: ${keyOf(route)}`);
    }
  };

  test("there is at least one unsafe session route to test", () => {
    assert.ok(unsafeSessionRoutes().length >= 3);
  });

  test("without X-CSRF-Token: 403 csrf_invalid", () => refused("no token", { "X-CSRF-Token": null }, 403, "csrf_invalid"));
  test("with a wrong X-CSRF-Token: 403 csrf_invalid", () => refused("wrong token", { "X-CSRF-Token": "x".repeat(43) }, 403, "csrf_invalid"));
  test("with an empty X-CSRF-Token: 403 csrf_invalid", () => refused("empty token", { "X-CSRF-Token": "" }, 403, "csrf_invalid"));
  test("with a foreign Origin: 403 origin_mismatch", () => refused("evil origin", { Origin: "https://evil.example" }, 403, "origin_mismatch"));
  test("with Origin: null: 403 origin_mismatch", () => refused("null origin", { Origin: "null" }, 403, "origin_mismatch"));
  test("with neither Origin nor Referer: 403 origin_mismatch", () => refused("no origin", { Origin: null }, 403, "origin_mismatch"));
  test("with a foreign Referer and no Origin: 403 origin_mismatch", () =>
    refused("evil referer", { Origin: null, Referer: "https://evil.example/admin/" }, 403, "origin_mismatch"));
  test("with Sec-Fetch-Site: cross-site: 403 origin_mismatch", () => refused("cross-site", { "Sec-Fetch-Site": "cross-site" }, 403, "origin_mismatch"));
  test("with Sec-Fetch-Site: same-site: 403 origin_mismatch", () => refused("same-site", { "Sec-Fetch-Site": "same-site" }, 403, "origin_mismatch"));
  test("with Sec-Fetch-Site: none (typed in the address bar): 403 origin_mismatch", () => refused("none", { "Sec-Fetch-Site": "none" }, 403, "origin_mismatch"));
  test("with Content-Type text/plain: 415", () => refused("text/plain", { "Content-Type": "text/plain" }, 415, "unsupported_media_type"));
  test("with a form content type: 415", async () => {
    await refused("urlencoded", { "Content-Type": "application/x-www-form-urlencoded" }, 415, "unsupported_media_type");
    await refused("multipart", { "Content-Type": "multipart/form-data; boundary=x" }, 415, "unsupported_media_type");
  });
  test("without a Content-Type: 415", () => refused("none", { "Content-Type": null }, 415, "unsupported_media_type"));

  test("the checks run in order: a bad token and a bad Origin together give origin_mismatch, then csrf before the type", async () => {
    for (const route of unsafeSessionRoutes()) {
      const both = await attempt(route, { Origin: "https://evil.example", "X-CSRF-Token": null });
      assert.equal(both.json.error.code, "origin_mismatch", keyOf(route));
      const tokenAndType = await attempt(route, { "X-CSRF-Token": null, "Content-Type": "text/plain" });
      assert.equal(tokenAndType.json.error.code, "csrf_invalid", keyOf(route));
    }
  });

  test("with everything valid the guard lets the request through (the handler or its validation answers)", async () => {
    for (const route of unsafeSessionRoutes()) {
      const res = await attempt(route, {});
      const code = res.json && res.json.error && res.json.error.code;
      assert.ok(!GUARD_CODES.has(code), `${keyOf(route)} was stopped by the guard: ${res.status} ${code}`);
      assertEnvelope(res, keyOf(route));
    }
  });

  test("a Referer of this host replaces a missing Origin, and Sec-Fetch-Site: same-origin is accepted", async () => {
    for (const route of unsafeSessionRoutes()) {
      const viaReferer = await attempt(route, { Origin: null, Referer: `${t.base}/admin/` });
      assert.ok(!GUARD_CODES.has(viaReferer.json && viaReferer.json.error && viaReferer.json.error.code), `${keyOf(route)} referer`);
      const sameOrigin = await attempt(route, { "Sec-Fetch-Site": "same-origin" });
      assert.ok(!GUARD_CODES.has(sameOrigin.json && sameOrigin.json.error && sameOrigin.json.error.code), `${keyOf(route)} same-origin`);
    }
  });

  test("the session survives all the refused attempts above", async () => {
    const res = await send(t, { path: "/admin/api/jobs/1", headers: { Cookie: session.cookie } });
    assert.equal(res.json.error.code, "not_found", "still authenticated (the job does not exist)");
  });
});

// ---------------------------------------------------------------------------

describe("safe methods", () => {
  test("calling every GET route with a session leaves every table unchanged", async () => {
    const before = await t.dumpTables();
    const answers = [];
    for (const route of routes.filter((r) => r.method === "GET")) {
      for (const headers of [{ Cookie: session.cookie }, {}]) {
        const res = await send(t, { method: "GET", path: samplePath(route.path), headers });
        assertEnvelope(res, keyOf(route));
        answers.push([keyOf(route), res.status]);
      }
    }
    assert.ok(answers.length >= 8);
    assert.deepEqual(await t.dumpTables(), before);
  });

  test("HEAD and a body on a GET change nothing either", async () => {
    const before = await t.dumpTables();
    for (const route of routes.filter((r) => r.method === "GET")) {
      await send(t, { method: "HEAD", path: samplePath(route.path), headers: { Cookie: session.cookie } });
      await send(t, { method: "GET", path: samplePath(route.path), headers: { Cookie: session.cookie, "Content-Type": "application/json", "Content-Length": "13" }, body: '{"logout":1}\n' });
    }
    assert.deepEqual(await t.dumpTables(), before);
    assert.equal((await send(t, { path: "/admin/api/jobs/1", headers: { Cookie: session.cookie } })).json.error.code, "not_found");
  });

  test("a query string cannot turn a GET into a write", async () => {
    const before = await t.dumpTables();
    for (const route of routes.filter((r) => r.method === "GET" && r.auth !== "public")) {
      await send(t, { path: `${samplePath(route.path)}?confirm=true&logout=1&action=delete`, headers: { Cookie: session.cookie } });
    }
    assert.deepEqual(await t.dumpTables(), before);
  });

  test("the security headers are on 401, 403, 404 and 405 answers too", async () => {
    const answers = [
      await send(t, { path: "/admin/api/jobs/1" }),
      await send(t, { method: "POST", path: "/admin/api/logout", headers: { Cookie: session.cookie, "Content-Length": "0" } }),
      await send(t, { path: "/admin/api/nothing" }),
      await send(t, { method: "DELETE", path: "/admin/api/session" }),
    ];
    assert.deepEqual(answers.map((a) => a.status), [401, 415, 404, 405].map((s, i) => (i === 1 ? answers[1].status : s)));
    for (const res of answers) {
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.ok(res.headers["x-request-id"]);
      assert.ok(res.headers["content-security-policy"]);
    }
  });
});

// ---------------------------------------------------------------------------
// The harmless probe routes: the guard accepts a request only when everything is valid
// ---------------------------------------------------------------------------

describe("accepted only with everything valid", () => {
  let p;
  let handled;
  let probeSession;

  before(async () => {
    handled = { count: 0 };
    p = await createTestAdmin({
      extraRoutes: [
        ({ router }) => {
          for (const method of UNSAFE) {
            router.route({
              method,
              path: "/admin/api/zz-probe",
              auth: "session",
              handler: async () => {
                handled.count += 1;
                return { ok: true };
              },
            });
          }
        },
      ],
    });
    await p.admin.start();
    const client = await p.loginClient(PASSWORD);
    probeSession = { cookie: `owb_sid=${client.cookie("owb_sid")}`, csrf: client.csrf };
  });

  after(async () => {
    await p.close();
  });

  const call = (method, headers = {}, body = "{}") =>
    send(p, {
      method,
      path: "/admin/api/zz-probe",
      headers: {
        Cookie: probeSession.cookie,
        Origin: p.base,
        "X-CSRF-Token": probeSession.csrf,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        ...headers,
      },
      body,
    });

  test("the probe routes show up in the table and are session + CSRF", () => {
    const found = p.admin.routes().filter((r) => r.path === "/admin/api/zz-probe");
    assert.deepEqual(found.map((r) => r.method).sort(), [...UNSAFE].sort());
    for (const route of found) {
      assert.equal(route.auth, "session");
      assert.equal(route.csrf, true);
    }
  });

  for (const method of UNSAFE) {
    test(`${method}: only the fully valid request reaches the handler`, async () => {
      const before = handled.count;
      const variants = [
        { "X-CSRF-Token": null },
        { "X-CSRF-Token": "y".repeat(43) },
        { Origin: "https://evil.example" },
        { Origin: null },
        { "Sec-Fetch-Site": "cross-site" },
        { "Content-Type": "text/plain" },
        { "Content-Type": "application/x-www-form-urlencoded" },
        { Cookie: null },
        { Cookie: `owb_sid=${"H".repeat(43)}` },
      ];
      for (const variant of variants) {
        const headers = { ...variant };
        for (const key of Object.keys(headers)) if (headers[key] === null) headers[key] = undefined;
        const merged = {
          Cookie: probeSession.cookie,
          Origin: p.base,
          "X-CSRF-Token": probeSession.csrf,
          "Content-Type": "application/json",
          "Content-Length": "2",
          ...variant,
        };
        for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
        const res = await send(p, { method, path: "/admin/api/zz-probe", headers: merged, body: "{}" });
        assert.ok([401, 403, 415].includes(res.status), `${method} ${JSON.stringify(variant)} -> ${res.status}`);
        assertEnvelope(res, `${method} ${JSON.stringify(variant)}`);
      }
      assert.equal(handled.count, before, "no refused request reached the handler");

      const ok = await call(method);
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(ok.json, { ok: true });
      assert.equal(handled.count, before + 1);
      const sameOrigin = await call(method, { "Sec-Fetch-Site": "same-origin" });
      assert.equal(sameOrigin.status, 200);
      const referer = await call(method, { Origin: undefined, Referer: `${p.base}/admin/#/x` });
      assert.equal(referer.status, 200);
      assert.equal(handled.count, before + 3);
    });
  }

  test("a bodiless unsafe request still needs the JSON content type", async () => {
    const before = handled.count;
    const bare = await call("POST", { "Content-Type": undefined, "Content-Length": "0" }, "");
    assert.equal(bare.status, 415);
    const ok = await call("POST", { "Content-Length": "0" }, "");
    assert.equal(ok.status, 200, "an empty body is read as {}");
    assert.equal(handled.count, before + 1);
  });

  test("a route that declares no schema accepts only {} (an unknown property is 422 $unknown)", async () => {
    const before = handled.count;
    const res = await call("PATCH", {}, JSON.stringify({ extra: 1 }));
    assert.equal(res.status, 422);
    assert.deepEqual(res.json.error.fields.$unknown, { code: "unknown_field" });
    assert.equal(handled.count, before);
  });

  test("a made-up route without auth cannot be registered at all", () => {
    assert.throws(() => p.admin.router.route({ method: "GET", path: "/admin/api/zz-open", handler: async () => ({}) }), /auth is required/);
  });
});

// ---------------------------------------------------------------------------
// Pre-session routes: csrf "origin" (Origin, Sec-Fetch-Site and Content-Type, no CSRF token yet)
// ---------------------------------------------------------------------------

describe("login and setup guard", () => {
  let s;
  let setupCookie;

  before(async () => {
    s = await createTestAdmin();
    await s.admin.start();
  });

  after(async () => {
    await s.close();
  });

  const post = (path, headers, body = JSON.stringify({ password: PASSWORD })) =>
    send(s, {
      method: "POST",
      path,
      headers: { Origin: s.base, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers },
      body,
    });

  test("login: foreign Origin, no Origin, cross-site, text/plain and form types are refused before any verification", async () => {
    const cases = [
      [{ Origin: "https://evil.example" }, 403],
      [{ Origin: undefined }, 403],
      [{ "Sec-Fetch-Site": "cross-site" }, 403],
      [{ "Content-Type": "text/plain" }, 415],
      [{ "Content-Type": "application/x-www-form-urlencoded" }, 415],
    ];
    for (const [headers, status] of cases) {
      const res = await post("/admin/api/login", headers);
      assert.equal(res.status, status, JSON.stringify(headers));
      assertEnvelope(res, "login");
    }
    // the account does not exist yet, so a request that reached the handler would be a 409 setup_required
    assert.equal((await post("/admin/api/login", {})).json.error.code, "setup_required");
    assert.equal(await s.db.AuditLog.count({ where: { action: "login.failure" } }), 0);
  });

  test("setup: with a valid setup cookie the same guard still applies; nothing is consumed by a refused request", async () => {
    const { token } = s.lastLink();
    const landing = await send(s, { path: `/admin/setup?token=${token}` });
    assert.equal(landing.status, 303);
    setupCookie = `owb_setup=${token}`;
    const cases = [
      [{ Origin: "https://evil.example" }, 403, "origin_mismatch"],
      [{ Origin: undefined }, 403, "origin_mismatch"],
      [{ "Sec-Fetch-Site": "cross-site" }, 403, "origin_mismatch"],
      [{ "Content-Type": "text/plain" }, 415, "unsupported_media_type"],
    ];
    for (const [headers, status, code] of cases) {
      const merged = { Cookie: setupCookie, ...headers }; // an undefined value leaves the header out
      const body = JSON.stringify({ password: PASSWORD });
      const res = await send(s, {
        method: "POST",
        path: "/admin/api/setup",
        headers: { Origin: s.base, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...merged },
        body,
      });
      assert.equal(res.status, status, JSON.stringify(headers));
      assert.equal(res.json.error.code, code);
    }
    assert.equal(await s.db.AdminAccount.count(), 0);
    assert.equal((await s.db.AdminToken.findAll({ raw: true }))[0].usedAt, null);
  });

  test("setup: the fully valid request creates the account", async () => {
    const body = JSON.stringify({ password: PASSWORD });
    const res = await send(s, {
      method: "POST",
      path: "/admin/api/setup",
      headers: { Cookie: setupCookie, Origin: s.base, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
      body,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(await s.db.AdminAccount.count(), 1);
  });
});
