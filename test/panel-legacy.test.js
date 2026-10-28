"use strict";
/**
 * Frozen legacy HTTP contract (admin-http-api.md section 1.2, FR-011, SC-010): status code, exact key set and
 * Content-Type of every legacy route, the CORS headers on every answer (POST /api/restart included), and no
 * token, owner number, session id or path in any body.
 *
 * The same expectations run against every server that serves the legacy routes:
 *   - panel.js#createServer()                  (the launcher the hosting panels use);
 *   - lib/admin/server.js#createPanelServer()  (the shared server of the admin panel, legacy part only),
 *     when that module exists. It additionally reads config.PREFIX live in /api/info and answers /admin* with
 *     the JSON 404 while no admin is mounted.
 *
 * test/panel.test.js stays the original, unedited companion of this file.
 */

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fakes = require("./helpers/fakes");

const { ROOT } = fakes;
const OWNER = "15551234567";
const TOKEN = "legacy-contract-panel-token-0123";
const config = fakes.setupEnv({ sudo: OWNER, prefix: "." });

/** Requiring panel.js starts the memory manager interval: unref it, like test/panel.test.js. */
function requirePanel() {
  const realSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    const timer = realSetInterval(...args);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  };
  try {
    return require("../panel.js");
  } finally {
    global.setInterval = realSetInterval;
  }
}

const panel = requirePanel();
const SERVER_MODULE = path.join(ROOT, "lib", "admin", "server.js");

const variants = [
  { name: "panel.js createServer()", livePrefix: false, adminNotFound: false, make: () => panel.createServer() },
];
if (fs.existsSync(SERVER_MODULE)) {
  variants.push({
    name: "lib/admin/server.js createPanelServer()",
    livePrefix: true,
    adminNotFound: true,
    make: () => require(SERVER_MODULE).createPanelServer({ botState: panel.botState }),
  });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

const sortedKeys = (obj) => Object.keys(obj).sort();

describe("legacy HTTP contract", () => {
  for (const variant of variants) {
    describe(variant.name, () => {
      let server;
      let base;
      let exitStub;
      const saved = {};

      const get = (route, init) => fetch(`${base}${route}`, init);
      const post = (headers = {}) => fetch(`${base}/api/restart`, { method: "POST", headers });

      function assertCors(res, label) {
        for (const [name, value] of Object.entries(CORS)) {
          assert.equal(res.headers.get(name), value, `${label}: ${name}`);
        }
      }

      async function assertJson(res, { status, keys, label }) {
        assert.equal(res.status, status, `${label}: status`);
        assert.equal(res.headers.get("content-type"), "application/json", `${label}: content-type`);
        assertCors(res, label);
        const body = await res.json();
        if (keys) assert.deepEqual(sortedKeys(body), [...keys].sort(), `${label}: key set`);
        return body;
      }

      before(async () => {
        Object.assign(saved, {
          status: panel.botState.status,
          isConnected: panel.botState.isConnected,
          startTime: panel.botState.startTime,
          messagesProcessed: panel.botState.messagesProcessed,
          lastActivity: panel.botState.lastActivity,
          version: panel.botState.version,
        });
        server = variant.make();
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        exitStub = fakes.stubProcessExit();
      });

      after(async () => {
        exitStub.restore();
        Object.assign(panel.botState, saved);
        config.PANEL_TOKEN = "";
        config.PREFIX = ".";
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });

      test("health: /, /health and /healthz share one shape, 503 while not running and connected, any method", async () => {
        Object.assign(panel.botState, { status: "starting", isConnected: false });
        for (const route of ["/", "/health", "/healthz"]) {
          const body = await assertJson(await get(route), {
            status: 503,
            keys: ["status", "botStatus", "connected", "timestamp"],
            label: route,
          });
          assert.equal(body.status, "unhealthy");
          assert.equal(body.botStatus, "starting");
          assert.equal(body.connected, false);
          assert.ok(!Number.isNaN(Date.parse(body.timestamp)), "timestamp is an ISO date");
        }

        Object.assign(panel.botState, { status: "running", isConnected: true });
        for (const route of ["/", "/health", "/healthz"]) {
          const body = await assertJson(await get(route), {
            status: 200,
            keys: ["status", "botStatus", "connected", "timestamp"],
            label: route,
          });
          assert.equal(body.status, "healthy");
          assert.equal(body.connected, true);
        }

        // the method is ignored
        const viaPost = await fetch(`${base}/health`, { method: "POST" });
        assert.equal(viaPost.status, 200);
        const viaHead = await fetch(`${base}/health`, { method: "HEAD" });
        assert.equal(viaHead.status, 200);

        // running but disconnected is still unhealthy
        Object.assign(panel.botState, { status: "running", isConnected: false });
        assert.equal((await get("/health")).status, 503);
        Object.assign(panel.botState, { status: "starting", isConnected: false });
      });

      test("/ never redirects and does not negotiate content: browsers get the health JSON too", async () => {
        const res = await get("/", { headers: { Accept: "text/html" }, redirect: "manual" });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("content-type"), "application/json");
        assert.equal(res.headers.get("location"), null);
      });

      test("/status: exact key set, numbers and memory", async () => {
        Object.assign(panel.botState, {
          status: "running",
          isConnected: true,
          startTime: Date.now() - 125 * 1000,
          messagesProcessed: 7,
          lastActivity: "2026-01-01T00:00:00.000Z",
        });
        const body = await assertJson(await get("/status"), {
          status: 200,
          keys: [
            "status", "connected", "uptime", "uptimeFormatted", "version", "messagesProcessed", "lastActivity",
            "memory", "timestamp",
          ],
          label: "/status",
        });
        assert.equal(body.status, "running");
        assert.equal(body.connected, true);
        assert.ok(body.uptime >= 125 && body.uptime < 140, `uptime ${body.uptime}`);
        assert.equal(body.uptimeFormatted, "2m");
        assert.equal(body.version, config.VERSION);
        assert.equal(body.messagesProcessed, 7);
        assert.equal(body.lastActivity, "2026-01-01T00:00:00.000Z");
        for (const key of ["rss", "heapTotal", "heapUsed", "external"]) {
          assert.equal(typeof body.memory[key], "number", `memory.${key}`);
        }

        panel.botState.startTime = null;
        assert.equal((await (await get("/status")).json()).uptime, 0);
        Object.assign(panel.botState, { status: "starting", isConnected: false });
      });

      test("/ping: { pong: true, timestamp, latency: 0 }", async () => {
        const body = await assertJson(await get("/ping"), {
          status: 200,
          keys: ["pong", "timestamp", "latency"],
          label: "/ping",
        });
        assert.equal(body.pong, true);
        assert.equal(body.latency, 0);
        assert.equal(typeof body.timestamp, "number");
      });

      test("/metrics: exact nested key sets, memory in MB", async () => {
        const body = await assertJson(await get("/metrics"), {
          status: 200,
          keys: ["bot", "system", "timestamp"],
          label: "/metrics",
        });
        assert.deepEqual(sortedKeys(body.bot), ["connected", "messagesProcessed", "status", "uptime", "version"]);
        assert.deepEqual(sortedKeys(body.system), ["arch", "memory", "memoryUnit", "nodeVersion", "platform"]);
        assert.deepEqual(sortedKeys(body.system.memory), ["external", "heapTotal", "heapUsed", "rss"]);
        assert.equal(body.system.memoryUnit, "MB");
        assert.equal(body.system.nodeVersion, process.version);
        for (const value of Object.values(body.system.memory)) assert.ok(Number.isInteger(value));
        assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
      });

      test("/api/info: key set and static values", async () => {
        const body = await assertJson(await get("/api/info"), {
          status: 200,
          keys: ["name", "version", "prefix", "repository", "documentation", "features"],
          label: "/api/info",
        });
        assert.equal(body.name, "OpenWhatsappBot");
        assert.equal(body.version, config.VERSION);
        assert.equal(body.prefix, ".");
        assert.equal(body.repository, "https://github.com/Starland9/OpenWhatsappBot");
        assert.equal(body.documentation, "https://starland9.github.io/OpenWhatsappBot");
        assert.deepEqual(body.features, [
          "AI Chat (Gemini, GPT)",
          "Media Downloads",
          "Sticker Creation",
          "Group Management",
          "Auto Responder",
          "Multi-language Support",
        ]);
      });

      // panel.js itself is not pinned either way: it keeps a stale constant until the launcher is rewritten to read
      // config.PREFIX per request (capture site 3); the shared server always reads it live.
      if (variant.livePrefix) {
        test("/api/info prefix follows the live config.PREFIX", async () => {
          config.PREFIX = "!";
          try {
            assert.equal((await (await get("/api/info")).json()).prefix, "!");
          } finally {
            config.PREFIX = ".";
          }
          assert.equal((await (await get("/api/info")).json()).prefix, ".");
        });
      }

      test("POST /api/restart: 403 while PANEL_TOKEN is empty, whatever the Authorization header", async () => {
        config.PANEL_TOKEN = "";
        for (const headers of [{}, { Authorization: `Bearer ${TOKEN}` }, { Authorization: "Bearer " }]) {
          const res = await post(headers);
          const body = await assertJson(res, { status: 403, keys: ["error"], label: JSON.stringify(headers) });
          assert.equal(body.error, "Restart endpoint disabled: PANEL_TOKEN is not configured");
        }
        assert.deepEqual(exitStub.calls, []);
      });

      test("POST /api/restart: 401 + WWW-Authenticate without the right bearer token", async () => {
        config.PANEL_TOKEN = TOKEN;
        for (const headers of [
          {},
          { Authorization: "Bearer wrong" },
          { Authorization: `Bearer ${TOKEN}x` },
          { Authorization: TOKEN },
          { Authorization: `Basic ${TOKEN}` },
        ]) {
          const res = await post(headers);
          const text = await res.clone().text();
          const body = await assertJson(res, { status: 401, keys: ["error"], label: JSON.stringify(headers) });
          assert.equal(body.error, "Unauthorized");
          assert.equal(res.headers.get("www-authenticate"), "Bearer");
          assert.ok(!text.includes(TOKEN));
        }
        assert.deepEqual(exitStub.calls, []);
      });

      test("/api/restart: 405 + Allow: POST for any other method", async () => {
        for (const token of ["", TOKEN]) {
          config.PANEL_TOKEN = token;
          for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
            const res = await fetch(`${base}/api/restart`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
            const body = await assertJson(res, { status: 405, keys: ["error"], label: `${method}/${token === "" ? "no token" : "token"}` });
            assert.equal(res.headers.get("allow"), "POST");
            assert.equal(body.error, "Method not allowed");
          }
        }
        assert.deepEqual(exitStub.calls, []);
      });

      test("POST /api/restart with the right token: 200, CORS headers kept, process.exit(0) once about 1 s later", async () => {
        config.PANEL_TOKEN = TOKEN;
        const startedAt = Date.now();
        const res = await post({ Authorization: `Bearer ${TOKEN}` });
        const body = await assertJson(res, { status: 200, keys: ["message", "timestamp"], label: "restart" });
        assert.equal(body.message, "Bot restart initiated");
        assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
        assert.deepEqual(exitStub.calls, [], "the exit is scheduled after the answer, not before");

        assert.ok(await fakes.waitFor(() => exitStub.calls.length > 0, { timeout: 4000 }), "process.exit was not requested");
        assert.ok(Date.now() - startedAt >= 900, "the exit waits about one second");
        await fakes.sleep(1200);
        assert.equal(exitStub.calls.length, 1);
        assert.equal(exitStub.calls[0].code, 0);
        config.PANEL_TOKEN = "";
      });

      test("OPTIONS on any non-admin path: 200, empty body, CORS headers", async () => {
        for (const route of ["/", "/health", "/api/restart", "/anything", "/administrator"]) {
          const res = await fetch(`${base}${route}`, { method: "OPTIONS" });
          assert.equal(res.status, 200, route);
          assertCors(res, route);
          assert.equal(await res.text(), "", route);
        }
      });

      test("any other path answers 200 text/html (the status page), with the CORS headers", async () => {
        for (const route of ["/unknown", "/health?x=1", "/status/", "/administrator", "/adminfoo", "/api/info/x"]) {
          for (const method of ["GET", "POST"]) {
            const res = await fetch(`${base}${route}`, { method });
            assert.equal(res.status, 200, `${method} ${route}`);
            assert.equal(res.headers.get("content-type"), "text/html", `${method} ${route}`);
            assertCors(res, route);
            const html = await res.text();
            assert.match(html, /^<!DOCTYPE html>/i);
            assert.match(html, /OpenWhatsappBot/);
          }
        }
      });

      test("matching is exact on the raw URL: a query string defeats it", async () => {
        const res = await get("/health?x=1");
        assert.equal(res.headers.get("content-type"), "text/html");
      });

      if (variant.adminNotFound) {
        test("/admin and /admin/** answer the JSON 404 while no admin is mounted (ADMIN_PANEL=false)", async () => {
          for (const route of ["/admin", "/admin/", "/admin/api/state", "/admin/js/app.mjs"]) {
            const res = await get(route);
            assert.equal(res.status, 404, route);
            assert.match(res.headers.get("content-type"), /^application\/json/);
            assert.equal((await res.json()).error.code, "not_found");
            assert.equal(res.headers.get("access-control-allow-origin"), null, "no CORS under /admin");
          }
        });
      }

      test("no body leaks a token, the owner number, a session id or a path (SC-010)", async () => {
        config.PANEL_TOKEN = TOKEN;
        panel.botState.errors.push({ type: "probe", error: "boom", timestamp: new Date().toISOString() });
        try {
          for (const route of ["/", "/health", "/healthz", "/status", "/ping", "/metrics", "/api/info", "/unknown"]) {
            const res = await get(route);
            const text = await res.text();
            for (const secret of [TOKEN, OWNER, ROOT, "sessions", "SESSION_ID", "config.env", "admin_sessions", "owb_sid"]) {
              assert.ok(!text.includes(secret), `${route} leaks ${JSON.stringify(secret)}`);
            }
            assert.ok(!/"errors"/.test(text), `${route} must not list the internal error log`);
            assert.ok(!/\/home\/|[A-Za-z]:\\\\/.test(text), `${route} leaks a file path`);
          }
        } finally {
          panel.botState.errors.pop();
          config.PANEL_TOKEN = "";
        }
      });
    });
  }
});
