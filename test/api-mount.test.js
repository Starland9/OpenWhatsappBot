"use strict";
/**
 * Mounting of the messaging API (feature 004, contracts/runtime.md sections 15.1, 15.2 and 15.14, public-api.md 9):
 * what `handle` claims, the unclaimed answer of a disabled or failed API, `createPanelServer` trying the API before the
 * panel, `createAdmin` building it only with the panel and starting and stopping it, the registry failure log, and the
 * shapes of routes(), rights(), catalog(), openapi() and state(). The pipeline itself is test/api-pipeline.test.js.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createApiKit, fakeFormats } = require("./helpers/apiHttpKit");
const { createApi, API_PATH } = require("../lib/api");
const { createPanelServer } = require("../lib/admin/server");

const ROOT = path.join(__dirname, "..");
const GOOD_ID = "msg_Vx3k9QfL2mNvB7aRtYhZwc";

let kit;
before(async () => {
  kit = await createApiKit();
});
after(async () => {
  await kit.close();
});

const recorder = () => {
  const lines = [];
  return { lines, logger: new Proxy({}, { get: (_, level) => (...args) => lines.push({ level, args }) }) };
};

/** A req/res pair that fails the test when it is touched beyond the URL */
const untouchable = (url, method = "GET") => ({
  req: new Proxy({ url, method }, { get: (target, name) => (name in target ? target[name] : assert.fail(`req.${String(name)} was read`)) }),
  res: new Proxy({}, { get: (_, name) => assert.fail(`res.${String(name)} was touched`) }),
});

describe("what handle() claims", () => {
  test("only /api/v<n> and below; /api/info and /api/restart are never claimed", () => {
    const api = createApi({ config: {}, formats: fakeFormats, endpointsDir: kit.endpointsDir, apiState: { isEnabled: () => false, plainHttpFrom: () => [] }, runtime: { dbReady: true } });
    for (const url of ["/api/info", "/api/restart", "/api", "/api/", "/apiv1", "/api/v", "/api/vx", "/api/v1x", "/api/v1abc/x", "/", "/health", "/admin/api/v1", "/x/api/v1", "/API/v1", "/api//v1"]) {
      const { req, res } = untouchable(url);
      assert.equal(api.handle(req, res), false, url);
      assert.equal(API_PATH.test(url.split("?")[0]), false, url);
    }
    for (const url of ["/api/v1", "/api/v1/", "/api/v1/messages", "/api/v2/anything", "/api/v10/x", "/api/v1?x=1"]) {
      assert.equal(API_PATH.test(url.split("?")[0]), true, url);
    }
  });

  test("a switch that is off returns false without touching the response (GET, POST, OPTIONS, with or without a key)", () => {
    kit.apiState.enabled = false;
    try {
      for (const method of ["GET", "POST", "OPTIONS", "DELETE", "HEAD"]) {
        for (const url of ["/api/v1/messages", "/api/v1/openapi.json", "/api/v1"]) {
          const { req, res } = untouchable(url, method);
          assert.equal(kit.api.handle(req, res), false, `${method} ${url}`);
        }
      }
    } finally {
      kit.apiState.enabled = true;
    }
  });

  test("a failed registry returns false whatever the switch (state().failure)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mount-"));
    fs.writeFileSync(path.join(dir, "bad.js"), '"use strict";\nmodule.exports = { id: "bad.get", method: "GET", path: "/api/v1/bad", doc: { summary: "x" }, handle() {} };\n');
    try {
      const api = createApi({ config: {}, formats: fakeFormats, endpointsDir: dir, apiState: { isEnabled: () => true, plainHttpFrom: () => [] }, runtime: { dbReady: true } });
      assert.equal(api.state().failure.endpoint, "bad.get");
      const { req, res } = untouchable("/api/v1/bad");
      assert.equal(api.handle(req, res), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the database not ready is a claim whatever the switch (503 + Retry-After: 5), a restore running is 503 only while on", async () => {
    kit.runtime.dbReady = false;
    kit.apiState.enabled = false;
    try {
      const res = await kit.get("/api/v1/messages", null);
      assert.deepEqual([res.status, res.headers["retry-after"], res.json.error.code], [503, "5", "unavailable"]);
    } finally {
      kit.runtime.dbReady = true;
    }
    kit.maintenance.active = true;
    try {
      const off = await kit.get("/api/v1/messages", null);
      assert.equal(off.text, kit.legacy.body, "a switched-off API stays 'not found' during a restore");
      kit.apiState.enabled = true;
      assert.equal((await kit.get("/api/v1/messages", null)).status, 503);
    } finally {
      kit.maintenance.active = false;
      kit.apiState.enabled = true;
    }
  });

  test("the switch is read per request", async () => {
    const { token } = await kit.makeKey();
    assert.equal((await kit.get("/api/v1/messages/" + GOOD_ID, token)).status, 404);
    kit.apiState.enabled = false;
    assert.equal((await kit.get("/api/v1/messages/" + GOOD_ID, token)).text, kit.legacy.body);
    kit.apiState.enabled = true;
    assert.equal((await kit.get("/api/v1/messages/" + GOOD_ID, token)).status, 404);
  });
});

describe("createApi builds no I/O and no timer", () => {
  test("construction and start() create no timer and no listener", async () => {
    const realSetTimeout = global.setTimeout;
    const realSetInterval = global.setInterval;
    let created = 0;
    global.setTimeout = (...args) => (created++, realSetTimeout(...args));
    global.setInterval = (...args) => (created++, realSetInterval(...args));
    try {
      const api = createApi({ config: {}, formats: fakeFormats, endpointsDir: kit.endpointsDir, apiState: { isEnabled: () => false, plainHttpFrom: () => [] } });
      await api.start();
      await api.stop();
      assert.equal(created, 0);
    } finally {
      global.setTimeout = realSetTimeout;
      global.setInterval = realSetInterval;
    }
  });

  test("requiring lib/admin and building an admin loads none of the heavy modules (SC-011)", () => {
    const script = `
      process.env.OWB_NO_CONFIG_ENV = "1";
      const { createAdmin } = require(${JSON.stringify(path.join(ROOT, "lib", "admin"))});
      const admin = createAdmin({ config: { ADMIN_PANEL: true }, runtime: { dbReady: true }, auth: { authenticate() { throw new Error("x"); } }, dataDir: require("os").tmpdir() });
      if (!admin.api) throw new Error("no api");
      const heavy = Object.keys(require.cache).filter((f) => /[\\\\/](sharp|file-type|node-webpmux|fluent-ffmpeg)[\\\\/]|urlFetch|stickerMaker|plugins[\\\\/]buttons|lib[\\\\/]messaging[\\\\/](index|outbox|formats)/.test(f));
      console.log(JSON.stringify(heavy));
      admin.stop().then(() => process.exit(0));
    `;
    const out = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env, OWB_NO_CONFIG_ENV: "1" }, timeout: 60000 });
    assert.equal(out.status, 0, out.stderr);
    const heavy = JSON.parse(out.stdout.trim().split("\n").pop());
    assert.deepEqual(heavy.filter((f) => !/lib[\\/]messaging[\\/]formats/.test(f)), [], "heavy modules stay unloaded");
  });
});

describe("createPanelServer tries the API before the panel", () => {
  async function ask(server, pathText) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${pathText}`);
      return { status: res.status, text: await res.text() };
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  const handler = (name, calls, claims) => ({ handle: (req) => (calls.push(name), claims(req.url)) });

  test("api.handle, then admin.handle, then the legacy handler", async () => {
    const calls = [];
    const api = handler("api", calls, (u) => false);
    const admin = { api, handle: (req, res) => (calls.push("admin"), false) };
    const server = createPanelServer({ botState: {}, admin, legacy: (req, res) => (calls.push("legacy"), res.end("legacy")) });
    assert.equal((await ask(server, "/anything")).text, "legacy");
    assert.deepEqual(calls, ["api", "admin", "legacy"]);
  });

  test("a claim by the API ends the chain; the default api is admin.api and an explicit api wins", async () => {
    const calls = [];
    const claiming = { handle: (req, res) => (calls.push("api"), res.end("api!"), true) };
    const admin = { api: claiming, handle: () => (calls.push("admin"), false) };
    let server = createPanelServer({ botState: {}, admin, legacy: () => calls.push("legacy") });
    assert.equal((await ask(server, "/api/v1/x")).text, "api!");
    assert.deepEqual(calls, ["api"]);

    calls.length = 0;
    const other = { handle: (req, res) => (calls.push("explicit"), res.end("explicit"), true) };
    server = createPanelServer({ botState: {}, admin, api: other, legacy: () => calls.push("legacy") });
    assert.equal((await ask(server, "/api/v1/x")).text, "explicit");
    assert.deepEqual(calls, ["explicit"]);

    calls.length = 0;
    server = createPanelServer({ botState: {}, admin, api: null, legacy: (req, res) => (calls.push("legacy"), res.end("legacy")) });
    assert.equal((await ask(server, "/api/v1/x")).text, "legacy");
    assert.deepEqual(calls, ["admin", "legacy"]);
  });

  test("without an admin there is no API", async () => {
    const server = createPanelServer({ botState: {}, legacy: (req, res) => res.end("legacy") });
    assert.equal((await ask(server, "/api/v1/messages")).text, "legacy");
  });
});

describe("createAdmin builds, starts and stops the API", () => {
  const { startStubAdmin } = require("./helpers/adminStub");

  test("the API is built with the panel, before the routes, and exposed as admin.api", async () => {
    const order = [];
    const fake = { handle: () => false, start: async () => order.push("api.start"), stop: async () => order.push("api.stop") };
    let received;
    const t = await startStubAdmin({
      config: { ADMIN_PANEL: true },
      createApi: (deps) => ((received = deps), order.push("createApi"), fake),
      extraRoutes: [({ deps, onStart }) => (order.push(deps.api === fake ? "routes see api" : "routes miss api"), onStart(() => order.push("route hook")))],
      messaging: { name: "engine" },
      apiState: { name: "state" },
    });
    try {
      assert.equal(t.admin.api, fake);
      assert.deepEqual(order, ["createApi", "routes see api"]);
      assert.equal(received.messaging.name, "engine", "the engines are handed through");
      assert.equal(received.apiState.name, "state");
      assert.ok(received.trustProxy && received.clock && received.logger && received.dataDir && received.audit, "shared instances");
      await t.admin.start();
      assert.deepEqual(order, ["createApi", "routes see api", "route hook", "api.start"], "api.start runs after the route hooks");
    } finally {
      await t.close();
    }
    assert.ok(order.includes("api.stop"));
  });

  test("ADMIN_PANEL=false builds no API (FR-007)", async () => {
    let built = 0;
    const t = await startStubAdmin({ config: { ADMIN_PANEL: false }, createApi: () => (built++, {}) });
    try {
      assert.equal(built, 0);
      assert.equal(t.admin.api, null);
      assert.equal((await t.raw({ path: "/api/v1/messages" })).status, 200, "the status page of the legacy handler stand-in or its JSON; never an API answer");
    } finally {
      await t.close();
    }
  });

  test("stop() aborts the requests in flight and waits for them", async () => {
    const own = await createApiKit();
    try {
      const { token } = await own.makeKey({ rights: ["slow.read"] });
      globalThis.__owbSlowStarted = 0;
      const pending = own.get("/api/v1/slow", token);
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (globalThis.__owbSlowStarted) (clearInterval(timer), resolve());
        }, 5);
      });
      await own.api.stop();
      const res = await pending;
      assert.deepEqual([res.status, res.json.aborted], [200, true]);
    } finally {
      await own.close();
    }
  });
});

describe("registry failure: the log at start()", () => {
  test("start() logs api.registry_failed at error level naming the endpoint; construction logged nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mount-fail-"));
    fs.writeFileSync(path.join(dir, "bad.js"), '"use strict";\nmodule.exports = { id: "bad.get", method: "GET", path: "/api/v1/bad", doc: { summary: "x" }, handle() {} };\n');
    const { lines, logger } = recorder();
    try {
      const api = createApi({ config: {}, formats: fakeFormats, endpointsDir: dir, logger });
      assert.equal(lines.length, 0);
      await api.start();
      const errors = lines.filter((l) => l.level === "error");
      assert.equal(errors.length, 1);
      assert.match(String(errors[0].args[0]), /bad\.get/);
      assert.equal(api.state().failure.code, "registry_failed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a healthy registry logs nothing at start()", async () => {
    const { lines, logger } = recorder();
    const api = createApi({ config: {}, formats: fakeFormats, endpointsDir: kit.endpointsDir, logger });
    await api.start();
    assert.equal(lines.filter((l) => l.level === "error").length, 0);
  });
});

describe("routes(), rights(), catalog(), openapi(), state()", () => {
  test("routes() enumerates every endpoint with its rights, body and flags", () => {
    const routes = kit.api.routes();
    const create = routes.find((r) => r.id === "messages.create");
    assert.deepEqual(create, {
      id: "messages.create",
      method: "POST",
      path: "/api/v1/messages",
      rights: ["messages.send.text", "messages.send.image", "messages.send.document", "media.url"],
      dynamic: true,
      body: { kinds: ["json", "multipart"], limitBytes: 65536 },
      idempotent: true,
    });
    const get = routes.find((r) => r.id === "messages.get");
    assert.deepEqual(get, { id: "messages.get", method: "GET", path: "/api/v1/messages/:id", rights: ["messages.read"], dynamic: false, body: { kinds: ["none"], limitBytes: 0 }, idempotent: false });
    assert.equal(new Set(routes.map((r) => `${r.method} ${r.path}`)).size, routes.length);
  });

  test("rights() is the catalogue [{ id, group, format }]: send first, then read, media, docs, others", () => {
    const rights = kit.api.rights();
    assert.deepEqual(rights.slice(0, 3), [
      { id: "messages.send.text", group: "send", format: "text" },
      { id: "messages.send.image", group: "send", format: "image" },
      { id: "messages.send.document", group: "send", format: "document" },
    ]);
    const groups = rights.map((r) => r.group);
    assert.deepEqual(groups.filter((g, i) => groups.indexOf(g) === i).slice(0, 4), ["send", "read", "media", "docs"]);
    assert.ok(rights.find((r) => r.id === "api.docs" && r.group === "docs"));
  });

  test("catalog() = version, basePath, rights, formats, endpoints with their summary", () => {
    const catalog = kit.api.catalog();
    assert.deepEqual(Object.keys(catalog), ["version", "basePath", "rights", "formats", "endpoints"]);
    assert.equal(catalog.version, "v1");
    assert.equal(catalog.basePath, "/api/v1");
    assert.deepEqual(catalog.rights, kit.api.rights());
    assert.deepEqual(catalog.formats.map((f) => f.name), ["text", "image", "document"]);
    const row = catalog.endpoints.find((e) => e.id === "messages.get");
    assert.deepEqual(row, { id: "messages.get", method: "GET", path: "/api/v1/messages/:id", rights: ["messages.read"], dynamic: false, idempotent: false, summary: "Status of one message", body: { kinds: ["none"], limitBytes: 0 } });
  });

  test("state() is { loaded, failure, version } and a copy", () => {
    const state = kit.api.state();
    assert.deepEqual(state, { loaded: true, failure: null, version: "v1" });
    state.loaded = false;
    assert.equal(kit.api.state().loaded, true);
  });

  test("keys, ipRules and limits are exposed", () => {
    assert.equal(typeof kit.api.keys.lookup, "function");
    assert.equal(typeof kit.api.ipRules.compile, "function");
    assert.equal(typeof kit.api.limits.reserve, "function");
  });

  test("openapi({ baseUrl }) works while the API is disabled and only `servers` varies", () => {
    kit.apiState.enabled = false;
    try {
      const a = kit.api.openapi({ baseUrl: "https://bot.example.com" });
      const b = kit.api.openapi({});
      assert.equal(a.openapi, "3.1.0");
      assert.deepEqual(a.servers, [{ url: "https://bot.example.com/api/v1" }]);
      assert.deepEqual(b.servers, [{ url: "/api/v1" }]);
      assert.deepEqual({ ...a, servers: null }, { ...b, servers: null });
    } finally {
      kit.apiState.enabled = true;
    }
  });
});
