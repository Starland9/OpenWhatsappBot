"use strict";
/**
 * lib/core/botRuntime.js (contracts/runtime.md section 6, "BotRuntime"):
 *
 *  - restartBot(): the order of the sequence, single-flight (`busy`), `timeout` and `failed` codes, markInForce()
 *    after the restart, the legacy /health 503 window while restarting;
 *  - the legacy `botState` keys and their transitions on the client's ready/close events;
 *  - handlerOptions feed messagesProcessed and the (capped, in place) errors list through the real pipeline;
 *  - shutdown(): hooks, flushes, client.stop(), database close, exit, and NEVER a logout.
 *
 * No network, no WhatsApp: the client is fakes.fakeClient(), the collaborators are recorders.
 */

const { test, before, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createBotRuntime } = require("../lib/core/botRuntime");
const { createPanelServer } = require("../lib/admin/server");
const pipeline = require("../lib/core/pipeline");
const registry = require("../lib/plugins/registry");
const { createSettingsStore } = require("../lib/utils/settingsStore");

let db;
before(async () => {
  db = await fakes.syncDb();
});

/** Recorders for every collaborator of the restart sequence, sharing one ordered log */
function collaborators(log, overrides = {}) {
  return {
    settingsCache: { clear: () => log.push("cache.clear") },
    settingsStore: {
      reload: async () => log.push("store.reload"),
      markInForce: () => log.push("store.markInForce"),
      pendingRestart: () => ["ALWAYS_ONLINE"],
    },
    languageManager: { reload: () => log.push("lang.reload") },
    textOverrides: { load: async () => log.push("texts.load") },
    reconfigure: () => log.push("reconfigure"),
    ...overrides,
  };
}

function makeRuntime(extra = {}) {
  const log = extra.log || [];
  const client = extra.client || fakes.fakeClient();
  const runtime = createBotRuntime({
    client,
    mode: "normal",
    ...collaborators(log, extra.collaborators),
    ...(extra.options || {}),
  });
  return { runtime, client, log };
}

// ---------------------------------------------------------------------------
// Legacy botState
// ---------------------------------------------------------------------------

test("botState keeps the legacy keys and initial values, and follows the client's ready/close events", () => {
  const { runtime, client } = makeRuntime();
  const state = runtime.state;
  assert.deepEqual(Object.keys(state).sort(), [
    "client", "errors", "isConnected", "lastActivity", "messagesProcessed", "startTime", "status", "uptime", "version",
  ]);
  assert.equal(state.status, "starting");
  assert.equal(state.isConnected, false);
  assert.equal(state.startTime, null);
  assert.equal(state.messagesProcessed, 0);
  assert.deepEqual(state.errors, []);
  assert.equal(state.client, client);
  assert.equal(state.version, require("../config").VERSION);
  assert.equal(runtime.dbReady, false, "the admin answers 503 `starting` until bootstrap sets it");

  client.emit("ready");
  assert.equal(state.status, "running");
  assert.equal(state.isConnected, true);
  assert.equal(typeof state.startTime, "number");

  client.emit("close");
  assert.equal(state.status, "disconnected");
  assert.equal(state.isConnected, false);

  state.status = "shutting_down";
  client.emit("close");
  assert.equal(state.status, "shutting_down", "stop() during a shutdown keeps the status");
});

test("getStatus(): client state plus restarting, pendingRestart, codeChanged, uptimeMs, version, messagesProcessed, memory", () => {
  let now = 1_000;
  const { runtime, client } = makeRuntime({ options: { clock: { now: () => now } } });
  now = 5_500;
  runtime.handlerOptions.onMessageProcessed();
  const status = runtime.getStatus();

  for (const key of Object.keys(client.getState())) assert.ok(key in status, `client state key ${key}`);
  assert.equal(status.status, "open");
  assert.equal(status.restarting, false);
  assert.deepEqual(status.pendingRestart, ["ALWAYS_ONLINE"]);
  assert.equal(typeof status.codeChanged, "boolean");
  assert.equal(status.uptimeMs, 4_500);
  assert.equal(status.version, runtime.state.version);
  assert.equal(status.messagesProcessed, 1);
  assert.equal(typeof status.memory.rss, "number");
});

// ---------------------------------------------------------------------------
// handlerOptions through the real pipeline
// ---------------------------------------------------------------------------

test("handlerOptions: messagesProcessed and lastActivity move with each processed message", async () => {
  registry._reset();
  const { runtime } = makeRuntime();
  const client = fakes.fakeClient(fakes.fakeSocket());
  pipeline.attachHandlers(client, runtime.handlerOptions);

  assert.equal(runtime.state.lastActivity, null);
  await client.dispatch("messages", [fakes.rawMessage({ body: "hello" }), fakes.rawMessage({ body: "again" })], "notify");
  assert.equal(runtime.state.messagesProcessed, 2);
  assert.match(runtime.state.lastActivity, /^\d{4}-\d\d-\d\dT/);

  await client.dispatch("messages", [fakes.rawMessage({ body: "late" })], "append"); // history batch: ignored
  assert.equal(runtime.state.messagesProcessed, 2);
});

test("handlerOptions.onError feeds the errors list: message only, the last 100, same array", () => {
  const { runtime } = makeRuntime();
  const list = runtime.state.errors;
  runtime.handlerOptions.onError(new Error("boom"));
  runtime.handlerOptions.onError("a string");
  assert.equal(list.length, 2);
  assert.equal(list[0].type, "message_processing");
  assert.equal(list[0].error, "boom");
  assert.equal(list[1].error, "a string");
  assert.match(list[0].timestamp, /^\d{4}-\d\d-\d\dT/);

  for (let i = 0; i < 150; i++) runtime.recordError("probe", new Error(`e${i}`));
  assert.equal(list.length, 100);
  assert.equal(runtime.state.errors, list, "other modules keep their reference");
  assert.equal(list.at(-1).error, "e149");
  assert.equal(list[0].error, "e50");
});

// ---------------------------------------------------------------------------
// restartBot
// ---------------------------------------------------------------------------

test("restartBot: status restarting -> cache -> settings -> language and texts -> reconfigure -> client.restart -> markInForce", async () => {
  const log = [];
  const client = fakes.fakeClient();
  let runtime;
  client.restartImpl = async () => {
    log.push("client.restart", `status:${runtime.state.status}`);
    client.setState({ status: "connecting" });
    client.setState({ status: "open" });
    client.emit("ready");
  };
  const store = {
    reload: async () => log.push(`store.reload@${runtime.state.status}`),
    markInForce: () => log.push("store.markInForce"),
    pendingRestart: () => [],
  };
  runtime = createBotRuntime({ client, ...collaborators(log, { settingsStore: store }) });

  const result = await runtime.restartBot({ actor: "test" });

  assert.deepEqual(result, { ok: true, status: "running" });
  assert.deepEqual(log, [
    "cache.clear",
    "store.reload@restarting",
    "lang.reload",
    "texts.load",
    "reconfigure",
    "client.restart",
    "status:restarting",
    "store.markInForce",
  ]);
  assert.equal(runtime.state.status, "running");
  assert.ok(!client.calls.some((c) => c.method === "logout"), "the session is kept");
});

test("restartBot is single-flight: a second call answers `busy` while the first runs", async () => {
  const client = fakes.fakeClient();
  let release;
  client.restartImpl = () => new Promise((resolve) => (release = resolve));
  const { runtime, log } = makeRuntime({ client });

  const first = runtime.restartBot({ actor: "a" });
  await fakes.waitFor(() => typeof release === "function");
  const second = await runtime.restartBot({ actor: "b" });
  assert.deepEqual(second, { ok: false, code: "busy", status: "restarting" });

  client.setState({ status: "open" });
  release();
  assert.equal((await first).ok, true);
  assert.equal(log.filter((l) => l === "reconfigure").length, 1, "the sequence ran once");

  // usable again afterwards
  client.restartImpl = null;
  client.restartStatus = "qr";
  assert.equal((await runtime.restartBot()).ok, true);
});

test("restartBot: a connection that does not settle answers `timeout` (settings still marked in force)", async () => {
  const client = fakes.fakeClient();
  client.restartStatus = null; // stays "connecting"
  const { runtime, log } = makeRuntime({ client, options: { restartTimeoutMs: 25 } });
  const result = await runtime.restartBot();
  assert.equal(result.ok, false);
  assert.equal(result.code, "timeout");
  assert.ok(log.includes("store.markInForce"), "client.restart() created the socket with the new settings");
  assert.notEqual(runtime.state.status, "restarting", "the legacy status is not left on `restarting`");
  assert.equal(runtime.getStatus().restarting, false);
});

test("restartBot: a failure answers `failed`, restarts nothing and leaves no `restarting` status", async () => {
  const client = fakes.fakeClient();
  const { runtime, log } = makeRuntime({
    client,
    collaborators: {
      settingsStore: {
        reload: async () => {
          throw Object.assign(new Error("db down"), { code: "db_unavailable" });
        },
        markInForce: () => log.push("store.markInForce"),
        pendingRestart: () => [],
      },
    },
  });
  const result = await runtime.restartBot();
  assert.equal(result.ok, false);
  assert.equal(result.code, "failed");
  assert.deepEqual(client.calls, [], "the connection was not touched");
  assert.ok(!log.includes("store.markInForce"));
  assert.notEqual(runtime.state.status, "restarting");
  assert.equal(runtime.getStatus().restarting, false);

  // and a client that cannot restart is `failed` too
  const broken = fakes.fakeClient();
  broken.restartImpl = async () => {
    throw new Error("no socket");
  };
  const second = makeRuntime({ client: broken });
  assert.equal((await second.runtime.restartBot()).code, "failed");
});

test("restartBot emits `state` with the restarting flag; /health answers 503 during the restart window", async () => {
  const client = fakes.fakeClient();
  let release;
  client.restartImpl = () => new Promise((resolve) => (release = resolve));
  const { runtime } = makeRuntime({ client });
  runtime.state.status = "running";
  runtime.state.isConnected = true;

  const server = createPanelServer({ botState: runtime.state });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  runtime.events.on("state", (snapshot) => seen.push(snapshot.restarting));
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);

    const restart = runtime.restartBot();
    await fakes.waitFor(() => typeof release === "function");
    const during = await fetch(`${base}/health`);
    assert.equal(during.status, 503);
    assert.equal((await during.json()).botStatus, "restarting");
    assert.equal(runtime.getStatus().restarting, true);

    client.setState({ status: "open" });
    client.emit("ready");
    release();
    await restart;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(runtime.getStatus().restarting, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(seen.includes(true) && seen.at(-1) === false, JSON.stringify(seen));
});

test("restartBot with the real store: the keys of effect `restart` are no longer pending afterwards", async () => {
  const store = createSettingsStore();
  await store.load({ models: db });
  store.markInForce();
  await store.set({ ALWAYS_ONLINE: true }, { actor: "test" });
  assert.deepEqual(store.pendingRestart(), ["ALWAYS_ONLINE"], "changed in the panel, not in force yet");

  const client = fakes.fakeClient();
  const { runtime } = makeRuntime({ client, collaborators: { settingsStore: store } });
  assert.deepEqual(runtime.getStatus().pendingRestart, ["ALWAYS_ONLINE"]);
  const result = await runtime.restartBot({ actor: "test" });
  assert.equal(result.ok, true);
  assert.deepEqual(store.pendingRestart(), []);
  assert.deepEqual(runtime.getStatus().pendingRestart, []);
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

test("shutdown: hooks, flushes, client.stop(), database close, then exit(0) -- never a logout", async () => {
  const log = [];
  const client = fakes.fakeClient();
  client.stop = async () => {
    log.push("client.stop");
  };
  const exits = [];
  const runtime = createBotRuntime({
    client,
    exit: (code) => exits.push(code),
    shutdownDelayMs: 5,
    stats: { flush: async () => log.push("stats.flush") },
    conversationManager: { flush: async () => log.push("conversations.flush") },
    database: { DATABASE: { close: async () => log.push("db.close") } },
    ...collaborators(log),
  });
  runtime.onShutdown(() => log.push(`hook:${runtime.state.status}`));
  runtime.onShutdown(() => {
    throw new Error("a failing hook never blocks the shutdown");
  });
  runtime.onShutdown(async () => log.push("hook2"));

  const first = runtime.shutdown("SIGTERM");
  const second = runtime.shutdown("SIGINT");
  assert.equal(first, second, "a second signal joins the shutdown in progress");
  await first;

  assert.deepEqual(log, ["hook:shutting_down", "hook2", "stats.flush", "conversations.flush", "client.stop", "db.close"]);
  assert.equal(runtime.state.status, "shutting_down");
  assert.equal(runtime.isShuttingDown(), true);
  await fakes.waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [0]);
  assert.ok(!client.calls.some((c) => c.method === "logout"), "the device stays linked");
});

test("shutdown survives failing collaborators and still exits", async () => {
  const exits = [];
  const client = fakes.fakeClient();
  client.stop = async () => {
    throw new Error("stop failed");
  };
  const runtime = createBotRuntime({
    client,
    exit: (code) => exits.push(code),
    shutdownDelayMs: 5,
    stats: { flush: async () => { throw new Error("flush failed"); } },
    conversationManager: { flush: async () => { throw new Error("flush failed"); } },
    database: { DATABASE: { close: async () => { throw new Error("close failed"); } } },
    ...collaborators([]),
  });
  await runtime.shutdown("SIGTERM");
  await fakes.waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [0]);
});

test("botRuntime.js never unlinks the device", () => {
  const fs = require("fs");
  const path = require("path");
  for (const file of ["lib/core/botRuntime.js", "lib/core/boot.js", "index.js", "panel.js"]) {
    const source = fs.readFileSync(path.join(fakes.ROOT, file), "utf8");
    assert.ok(!/\.logout\s*\(/.test(source), `${file} must not log the session out`);
  }
});

test("creating a runtime starts no timer and registers no signal handler", () => {
  const timers = mock.method(global, "setInterval");
  const signals = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
  try {
    makeRuntime();
    assert.equal(timers.mock.calls.length, 0);
    assert.equal(process.listenerCount("SIGTERM") + process.listenerCount("SIGINT"), signals);
  } finally {
    timers.mock.restore();
  }
});
