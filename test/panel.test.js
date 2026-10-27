"use strict";
/**
 * panel.js and lib/baileys/client.js shutdown behaviour:
 *
 *  - POST /api/restart: 405 for any other method, 403 while PANEL_TOKEN is empty, 401 without the right
 *    bearer token, and the restart (process.exit, stubbed here) only with the right one;
 *  - the public read-only endpoints expose no token, owner number or path;
 *  - WhatsAppClient.stop() closes the socket WITHOUT sock.logout() (the linked device stays paired) and
 *    nothing reconnects afterwards; logout() is the explicit, separate way to unlink.
 *
 * No network and no WhatsApp: Baileys is replaced by a fake module and sockets by fakes.fakeSocket().
 */

const { test, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fakes = require("./helpers/fakes");

const { ROOT } = fakes;
const OWNER = "15551234567";
const config = fakes.setupEnv({ sudo: OWNER });

/**
 * Requiring panel.js (through lib/utils/memoryManager.js) starts a setInterval that is never unref'd:
 * unref every interval created while it is being required (same workaround as test/pipeline.test.js).
 */
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

const TOKEN = "s3cret-panel-token-for-tests";
const exitStub = { calls: [], restore() {} };
let panel;
let server;
let base;

before(async () => {
  panel = requirePanel();
  server = panel.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // The restart schedules process.exit: record it instead of killing the test process
  Object.assign(exitStub, fakes.stubProcessExit());
});

after(async () => {
  exitStub.restore();
  config.PANEL_TOKEN = "";
  await new Promise((resolve) => server.close(resolve));
});

const post = (headers = {}) => fetch(`${base}/api/restart`, { method: "POST", headers });

// ---------------------------------------------------------------------------
// POST /api/restart
// ---------------------------------------------------------------------------

test("config: PANEL_TOKEN exists and is empty by default", () => {
  assert.equal(typeof config.PANEL_TOKEN, "string");
  assert.equal(config.PANEL_TOKEN, "");
});

test("/api/restart answers 403 when PANEL_TOKEN is not configured, even with an Authorization header", async () => {
  config.PANEL_TOKEN = "";
  for (const headers of [{}, { Authorization: `Bearer ${TOKEN}` }, { Authorization: "Bearer " }]) {
    const res = await post(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.match((await res.json()).error, /PANEL_TOKEN/);
  }
});

test("/api/restart answers 401 without a token or with a wrong one", async () => {
  config.PANEL_TOKEN = TOKEN;
  const wrong = [
    {},
    { Authorization: "Bearer wrong-token" },
    { Authorization: `Bearer ${TOKEN}x` }, // longer
    { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }, // shorter
    { Authorization: `Bearer ${TOKEN.toUpperCase()}` },
    { Authorization: "Bearer " },
    { Authorization: TOKEN }, // no scheme
    { Authorization: `Basic ${TOKEN}` },
  ];
  for (const headers of wrong) {
    const res = await post(headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    const text = await res.text();
    assert.equal(JSON.parse(text).error, "Unauthorized");
    assert.ok(!text.includes(TOKEN), "the answer must not echo the token");
  }
});

test("/api/restart accepts only POST (405), whatever the token", async () => {
  for (const token of ["", TOKEN]) {
    config.PANEL_TOKEN = token;
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${base}/api/restart`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 405, `${method} with PANEL_TOKEN=${JSON.stringify(token)}`);
      assert.equal(res.headers.get("allow"), "POST");
      assert.equal((await res.json()).error, "Method not allowed");
    }
  }
});

test("/api/restart with the right token answers 200 and exits the process (only once, only for it)", async () => {
  config.PANEL_TOKEN = TOKEN;
  assert.deepEqual(exitStub.calls, [], "the rejected requests above must not have scheduled a restart");

  const res = await post({ Authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).message, "Bot restart initiated");

  const exited = await fakes.waitFor(() => exitStub.calls.length > 0, { timeout: 4000 });
  assert.ok(exited, "process.exit was not requested after an authorized restart");
  await fakes.sleep(1200); // the rejected requests would have fired by now
  assert.equal(exitStub.calls.length, 1, "exactly one exit: the 403/401/405 requests restart nothing");
  assert.equal(exitStub.calls[0].code, 0);
});

test("the scheme is case-insensitive and the token may be surrounded by blanks", async () => {
  config.PANEL_TOKEN = TOKEN;
  const before = exitStub.calls.length;
  const res = await post({ Authorization: `bearer   ${TOKEN}  ` });
  assert.equal(res.status, 200);
  assert.ok(await fakes.waitFor(() => exitStub.calls.length > before, { timeout: 4000 }));
});

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

test("public endpoints expose no token, owner number, session or file path", async () => {
  config.PANEL_TOKEN = TOKEN;
  panel.botState.errors.push({ type: "probe", error: "boom", timestamp: new Date().toISOString() });
  try {
    for (const route of ["/", "/health", "/healthz", "/status", "/ping", "/metrics", "/api/info", "/unknown"]) {
      const res = await fetch(`${base}${route}`);
      const text = await res.text();
      assert.ok(res.status === 200 || res.status === 503, `${route}: ${res.status}`);
      for (const secret of [TOKEN, OWNER, ROOT, "sessions", "SESSION_ID", "config.env"]) {
        assert.ok(!text.includes(secret), `${route} leaks ${JSON.stringify(secret)}`);
      }
      assert.ok(!/"errors"/.test(text), `${route} must not list the internal error log`);
    }
  } finally {
    panel.botState.errors.pop();
  }
});

// ---------------------------------------------------------------------------
// WhatsAppClient.stop() / logout()
// ---------------------------------------------------------------------------

/**
 * Load lib/baileys/client.js against a fake Baileys. Every makeWASocket() call returns a new
 * fakes.fakeSocket() whose end() behaves like Baileys: it emits connection.update "close".
 * `delay()` (used by the reconnect path instead of a real 3 s wait) is recorded and can be gated.
 */
function loadClientWithFakeBaileys() {
  const sockets = [];
  const delays = [];
  const gate = { promise: null };

  const makeSocket = () => {
    const sock = fakes.fakeSocket();
    sock.end = async (error) => {
      sock.calls.push({ method: "end", args: [error] });
      sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error, date: new Date() } });
    };
    sock.logout = async () => {
      sock.calls.push({ method: "logout", args: [] });
      sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: undefined } });
    };
    sockets.push(sock);
    return sock;
  };

  const fakeBaileys = {
    makeWASocket: () => makeSocket(),
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    DisconnectReason: { loggedOut: 401 },
    delay: async (ms) => {
      delays.push(ms);
      if (gate.promise) await gate.promise;
    },
  };

  // client.js requires "baileys" inside initialize(): keep the fake in place until restore()
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === "baileys" ? fakeBaileys : realLoad.call(this, request, ...rest);
  };
  const { WhatsAppClient } = require("../lib/baileys/client");
  return {
    WhatsAppClient,
    sockets,
    delays,
    gate,
    restore() {
      Module._load = realLoad;
    },
  };
}

const callsOf = (sock, method) => sock.calls.filter((c) => c.method === method);

/** Start a client on a fake Baileys and open its connection. */
async function startedClient(env) {
  const client = new env.WhatsAppClient();
  await client.initialize();
  const sock = env.sockets.at(-1);
  sock.ev.emit("connection.update", { connection: "open" });
  assert.equal(client.ready(), true);
  return { client, sock };
}

test("client.stop() closes the connection without logging out and nothing reconnects afterwards", async (t) => {
  const log = mock.method(console, "log", () => {});
  const env = loadClientWithFakeBaileys();
  t.after(() => {
    env.restore();
    log.mock.restore();
  });

  const { client, sock } = await startedClient(env);
  const closed = [];
  client.on("close", () => closed.push("close"));
  client.reactedStatuses.add("x");

  await client.stop();
  await fakes.sleep(30); // let the async connection.update handler run

  assert.equal(callsOf(sock, "logout").length, 0, "stop() must not unlink the device");
  assert.equal(callsOf(sock, "end").length, 1, "stop() closes the socket with sock.end()");
  assert.equal(callsOf(sock, "end")[0].args[0], undefined, "an intentional close carries no error");
  assert.equal(client.ready(), false);
  assert.equal(client.stopped, true);
  assert.equal(client.getSocket(), null);
  assert.equal(client.reactedStatuses.size, 0);
  assert.deepEqual(closed, ["close"], "the close event is still emitted (the panel flips its status)");

  assert.deepEqual(env.delays, [], "no reconnect delay was scheduled after stop()");
  assert.equal(env.sockets.length, 1, "no second socket was created after stop()");
});

test("control: an unintentional close still reconnects", async (t) => {
  const log = mock.method(console, "log", () => {});
  const env = loadClientWithFakeBaileys();
  t.after(() => {
    env.restore();
    log.mock.restore();
  });

  const { client, sock } = await startedClient(env);
  sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Error("network down") } });
  await fakes.waitFor(() => env.sockets.length === 2);

  assert.deepEqual(env.delays, [3000]);
  assert.equal(env.sockets.length, 2, "a dropped connection reconnects");
  assert.equal(client.stopped, false);
});

test("stop() during the reconnect delay cancels the reconnection", async (t) => {
  const log = mock.method(console, "log", () => {});
  const env = loadClientWithFakeBaileys();
  t.after(() => {
    env.restore();
    log.mock.restore();
  });

  const { client, sock } = await startedClient(env);
  let release;
  env.gate.promise = new Promise((resolve) => (release = resolve));

  sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Error("network down") } });
  await fakes.waitFor(() => env.delays.length === 1); // now waiting out the 3 s delay

  await client.stop(); // SIGTERM arrives during the wait
  release();
  await fakes.sleep(30);

  assert.equal(env.sockets.length, 1, "no new socket once the delay ends");
  assert.equal(client.getSocket(), null);
  assert.equal(client.ready(), false);
});

test("stop() before connecting does not throw, and a later initialize() re-arms the client", async (t) => {
  const log = mock.method(console, "log", () => {});
  const env = loadClientWithFakeBaileys();
  t.after(() => {
    env.restore();
    log.mock.restore();
  });

  const client = new env.WhatsAppClient();
  await client.stop(); // nothing to close
  assert.equal(client.stopped, true);

  await client.initialize(); // an explicit restart
  assert.equal(client.stopped, false);
  assert.equal(env.sockets.length, 1);
});

test("stop() while initialize() is still creating the socket closes that socket", async (t) => {
  const log = mock.method(console, "log", () => {});
  const env = loadClientWithFakeBaileys();
  t.after(() => {
    env.restore();
    log.mock.restore();
  });

  const client = new env.WhatsAppClient();
  const starting = client.initialize();
  await client.stop(); // SIGTERM while the auth state is loading
  await starting;
  await fakes.sleep(30);

  assert.equal(env.sockets.length, 1);
  assert.equal(callsOf(env.sockets[0], "end").length, 1, "the late socket is closed");
  assert.equal(callsOf(env.sockets[0], "logout").length, 0);
  assert.equal(client.getSocket(), null);
  assert.equal(client.ready(), false);
  assert.deepEqual(env.delays, []);
});

test("logout() is the explicit way to unlink: it calls sock.logout() and does not reconnect", async (t) => {
  const log = mock.method(console, "log", () => {});
  const env = loadClientWithFakeBaileys();
  t.after(() => {
    env.restore();
    log.mock.restore();
  });

  const { client, sock } = await startedClient(env);
  await client.logout();
  await fakes.sleep(30);

  assert.equal(callsOf(sock, "logout").length, 1);
  assert.equal(client.ready(), false);
  assert.equal(client.getSocket(), null);
  assert.deepEqual(env.delays, []);
  assert.equal(env.sockets.length, 1);
});

test("the shutdown path of panel.js and index.js never calls logout", () => {
  const fs = require("fs");
  const path = require("path");
  for (const file of ["panel.js", "index.js"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(!/\.logout\s*\(/.test(source), `${file} must not log the session out`);
  }
  const clientSource = fs.readFileSync(path.join(ROOT, "lib/baileys/client.js"), "utf8");
  const stopBody = clientSource.slice(clientSource.indexOf("async stop()"), clientSource.indexOf("async logout()"));
  assert.ok(!/logout\s*\(/.test(stopBody), "stop() must not call logout");
});
