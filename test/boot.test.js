"use strict";
/**
 * lib/core/boot.js, index.js and panel.js (contracts/runtime.md section 15 "Starting it", U18, FR-040):
 *
 *  - the order of the ten steps, with the HTTP server before the database and the pipeline before initialize();
 *  - PANEL_ENABLED in the environment gives exactly one warning, ADMIN_PANEL alone decides and the panel still starts;
 *  - ADMIN_PANEL=false binds nothing in index mode (panel mode keeps the legacy routes for hosting probes);
 *  - a busy port logs the error naming PANEL_PORT, PANEL_HOST and ADMIN_PANEL=false and the bot continues;
 *  - the bind comes from lib/utils/runtime.js#resolveBind (PANEL_HOST wins);
 *  - requiring panel.js binds nothing and installs no handler;
 *  - the engines and the panel collaborators (textOverrides, commandState, ytdlpUpdate) are hard requires: a missing
 *    or broken module fails the start-up with exit(1) (W2, T219);
 *  - the setting store drives BOT_LANG and LOG_LEVEL; fatal start-up failures exit with 1.
 *
 * Every collaborator is a recorder injected through `deps`: no database, no network, no WhatsApp, no real signal
 * handler, no console capture.
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();
fakes.applyPendingI18n(); // the texts of the unmerged bot fragments (admin.panel_enabled_ignored, admin.listen_failed)

const { bootstrap, ENGINES } = require("../lib/core/boot");
const { createSettingsStore } = require("../lib/utils/settingsStore");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const quietLogger = () => {
  const l = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => l };
  return l;
};

/** A process look-alike: handlers are recorded, never installed */
function fakeProcess(env = {}) {
  const proc = new EventEmitter();
  proc.env = env;
  return proc;
}

/** A runtime look-alike recording what boot does to it */
function fakeRuntime(client, log) {
  const hooks = [];
  return {
    client,
    mode: "normal",
    dbReady: false,
    state: { status: "starting", isConnected: false, lastActivity: null, errors: [] },
    handlerOptions: { onMessageProcessed() {}, onError() {} },
    errors: [],
    recordError(type, error) {
      this.errors.push([type, error && error.message]);
    },
    onShutdown: (fn) => hooks.push(fn),
    hooks,
    setTextOverrides(module) {
      log.push(`runtime.setTextOverrides:${module ? "set" : "none"}`);
    },
    shutdown(signal) {
      log.push(`runtime.shutdown:${signal}`);
    },
  };
}

/** Every collaborator of bootstrap(), logging into one ordered list */
function makeBoot(overrides = {}) {
  const log = [];
  const client = fakes.fakeClient();
  client.initialize = async () => {
    log.push("client.initialize");
  };
  const runtime = overrides.runtime || fakeRuntime(client, log);
  const proc = overrides.process || fakeProcess(overrides.env || {});
  const exits = [];

  const config = {
    VERSION: "0.0.0-test",
    ADMIN_PANEL: true,
    LOG_LEVEL: "debug",
    KEEP_ALIVE_INTERVAL: 60000,
    ...(overrides.config || {}),
  };
  const fakeAdmin = {
    handle: () => false,
    start: async () => log.push("admin.start"),
    stop: async () => log.push("admin.stop"),
  };
  const fakeServer = { close: (cb) => cb && cb() };
  const engines = {
    stats: { start: () => log.push("stats.start"), stop: () => log.push("stats.stop") },
    housekeeping: { start: () => log.push("housekeeping.start") },
    broadcaster: { start: (c) => log.push(`broadcaster.start:${c === client}`) },
    alerts: { start: (c) => log.push(`alerts.start:${c === client}`) },
    updater: { startChecker: (c) => log.push(`updater.startChecker:${c === client}`) },
    textOverrides: { load: async () => log.push("texts.load") },
    commandState: null,
    ytdlpUpdate: null,
    ...(overrides.engines || {}),
  };
  const created = { createAdminDeps: null, startOptions: null };
  const deps = {
    process: proc,
    env: proc.env,
    exit: (code) => exits.push(code),
    logger: {
      install: () => log.push("logger.install"),
      createLogger: () => quietLogger(),
      setLevel: (level) => log.push(`logger.setLevel:${level}`),
    },
    config,
    memoryManager: { performCleanup: () => log.push("memory.performCleanup") },
    WhatsAppClient: function () {
      throw new Error("a client was supplied: none must be constructed");
    },
    settingsStore: {
      onChange: (keys, fn) => {
        log.push(`store.onChange:${keys}`);
        created.onChange = { keys, fn };
      },
      load: async () => log.push(`store.load@dbReady=${runtime.dbReady}`),
      markInForce: () => log.push("store.markInForce"),
    },
    secretBox: {},
    redactor: {},
    languageManager: { reload: () => log.push("lang.reload") },
    database: {
      DATABASE: { authenticate: async (opts) => log.push(`db.authenticate:${opts && opts.retry && opts.retry.max}`) },
      sync: async () => log.push("db.sync"),
    },
    registry: {},
    bus: {},
    ring: {},
    PluginLoader: { loadAll: async () => log.push("plugins.loadAll") },
    attachHandlers: (c, options) => log.push(`attachHandlers:${c === client}:${options === runtime.handlerOptions}`),
    createAdmin: (adminDeps) => {
      created.createAdminDeps = adminDeps;
      log.push("createAdmin");
      return fakeAdmin;
    },
    startAdminServer: async (options) => {
      created.startOptions = options;
      log.push(`startAdminServer:admin=${options.admin ? "yes" : "no"}`);
      return { server: fakeServer, url: "http://localhost:0" };
    },
    engines,
    ...(overrides.deps || {}),
  };
  return {
    log,
    client,
    runtime,
    proc,
    exits,
    deps,
    config,
    created,
    fakeAdmin,
    run: (options = {}) => bootstrap({ mode: "normal", client, runtime, deps, ...options }),
  };
}

const idx = (log, entry) => log.findIndex((l) => l === entry || l.startsWith(`${entry}:`) || l.startsWith(`${entry}@`));

// ---------------------------------------------------------------------------
// Order of the steps
// ---------------------------------------------------------------------------

test("bootstrap: the ten steps in order, the server before the database, the pipeline before initialize()", async () => {
  const b = makeBoot();
  const result = await b.run();

  assert.ok(result && result.client === b.client && result.runtime === b.runtime);
  assert.deepEqual(b.exits, []);
  assert.deepEqual(b.log, [
    "logger.install",
    "memory.performCleanup",
    "store.onChange:BOT_LANG",
    "runtime.setTextOverrides:set",
    "createAdmin",
    "startAdminServer:admin=yes",
    "db.authenticate:3",
    "db.sync",
    // database-gated routes open only after the overrides and texts are loaded
    "store.load@dbReady=false",
    "logger.setLevel:debug",
    "lang.reload",
    "texts.load",
    "store.markInForce",
    "plugins.loadAll",
    "attachHandlers:true:true",
    "stats.start",
    "housekeeping.start",
    "broadcaster.start:true",
    "alerts.start:true",
    "updater.startChecker:true",
    "admin.start",
    "client.initialize",
  ]);
  assert.equal(b.runtime.dbReady, true);
  assert.equal(b.runtime.state.status, "initializing");
});

test("bootstrap: createAdmin receives the engines, the runtime and the client; the server gets the admin and the runtime", async () => {
  const b = makeBoot();
  await b.run();
  const d = b.created.createAdminDeps;
  assert.equal(d.runtime, b.runtime);
  assert.equal(d.client, b.client);
  assert.equal(d.config, b.config);
  assert.equal(d.settingsStore, b.deps.settingsStore);
  assert.equal(d.models, b.deps.database);
  assert.equal(d.stats, b.deps.engines.stats);
  assert.equal(d.broadcaster, b.deps.engines.broadcaster);
  assert.equal(d.alerts, b.deps.engines.alerts);
  assert.equal(d.updater, b.deps.engines.updater);
  assert.equal(d.textOverrides, b.deps.engines.textOverrides);
  assert.equal(d.logger, undefined, "the admin makes its own logger");
  assert.equal(b.created.startOptions.admin, b.fakeAdmin);
  assert.equal(b.created.startOptions.runtime, b.runtime);
});

test("bootstrap: panel mode with a supplied client and runtime constructs no client of its own", async () => {
  const b = makeBoot();
  const result = await b.run({ mode: "panel" });
  assert.ok(result);
  assert.equal(b.exits.length, 0);
});

test("bootstrap: an engine that cannot start is logged and the bot keeps starting", async () => {
  const b = makeBoot({
    engines: {
      broadcaster: {
        start: () => {
          throw new Error("broken engine");
        },
      },
    },
  });
  await b.run();
  assert.deepEqual(b.exits, []);
  assert.ok(b.log.includes("alerts.start:true"), "the next engines still start");
  assert.ok(b.log.includes("client.initialize"));
});

test("bootstrap: an engine supplied as null is left out, the others start with the client", async () => {
  const b = makeBoot({ engines: { housekeeping: null, alerts: null, updater: null } });
  await b.run();
  assert.ok(!b.log.some((l) => l.startsWith("housekeeping") || l.startsWith("alerts") || l.startsWith("updater")));
  assert.ok(b.log.includes("broadcaster.start:true"));
  assert.deepEqual(
    ENGINES.map((e) => e.name),
    ["stats", "housekeeping", "broadcaster", "alerts", "updater"],
    "the order of contracts/runtime.md section 15, step 9",
  );
});

test("bootstrap: shutdown hooks stop the admin, the server and the engines", async () => {
  const b = makeBoot();
  await b.run();
  for (const hook of b.runtime.hooks) await hook();
  assert.ok(b.log.includes("admin.stop"));
  assert.ok(b.log.includes("stats.stop"));
});

test("bootstrap: the keep-alive timer is unref'd and only stamps lastActivity while connected", async (t) => {
  const timers = [];
  const real = global.setInterval;
  global.setInterval = (fn, ms, ...rest) => {
    const timer = real(fn, ms, ...rest);
    timers.push({ timer, fn, ms });
    return timer;
  };
  t.after(() => {
    global.setInterval = real;
    for (const { timer } of timers) clearInterval(timer);
  });
  const b = makeBoot();
  await b.run();
  global.setInterval = real;

  const keepAlive = timers.find((x) => x.ms === 60000);
  assert.ok(keepAlive, "a 60 s keep-alive timer exists");
  assert.equal(keepAlive.timer.hasRef(), false, "unref'd: it never holds the process open");
  keepAlive.fn();
  assert.equal(b.runtime.state.lastActivity, null, "not connected: no stamp");
  b.runtime.state.isConnected = true;
  keepAlive.fn();
  assert.match(b.runtime.state.lastActivity, /^\d{4}-\d\d-\d\dT/);
});

// ---------------------------------------------------------------------------
// Process handlers
// ---------------------------------------------------------------------------

test("bootstrap: SIGTERM and SIGINT go to runtime.shutdown; uncaught errors are recorded, never fatal", async () => {
  const b = makeBoot();
  await b.run();
  b.proc.emit("SIGTERM");
  b.proc.emit("SIGINT");
  assert.ok(b.log.includes("runtime.shutdown:SIGTERM"));
  assert.ok(b.log.includes("runtime.shutdown:SIGINT"));

  b.proc.emit("uncaughtException", new Error("kaboom"));
  b.proc.emit("unhandledRejection", new Error("rejected"));
  assert.deepEqual(b.runtime.errors, [
    ["uncaught_exception", "kaboom"],
    ["unhandled_rejection", "rejected"],
  ]);
  assert.deepEqual(b.exits, [], "the process keeps running");
});

test("bootstrap: an error logged by the global handlers never carries an axios config", async () => {
  const lines = [];
  const b = makeBoot({
    deps: {
      logger: {
        install() {},
        createLogger: () => ({ ...quietLogger(), error: (fields) => lines.push(JSON.stringify(fields)) }),
        setLevel() {},
      },
    },
  });
  await b.run();
  const error = Object.assign(new Error("request failed"), {
    config: { headers: { Authorization: "Bearer sk-live-SECRET-SECRET" }, url: "https://api.example/?key=SECRET12345" },
    response: { status: 401 },
  });
  b.proc.emit("unhandledRejection", error);
  const logged = lines.join("\n");
  assert.match(logged, /request failed/);
  assert.ok(!logged.includes("SECRET"), logged);
});

// ---------------------------------------------------------------------------
// PANEL_ENABLED (U18) and ADMIN_PANEL (U2)
// ---------------------------------------------------------------------------

test("PANEL_ENABLED in the environment: exactly one warning, ADMIN_PANEL alone decides, the panel still starts", async (t) => {
  const warn = mock.method(console, "warn", () => {});
  t.after(() => warn.mock.restore());
  for (const value of ["false", "true", ""]) {
    warn.mock.resetCalls();
    const b = makeBoot({ env: { PANEL_ENABLED: value }, config: { ADMIN_PANEL: true } });
    await b.run();
    assert.equal(warn.mock.calls.length, 1, `PANEL_ENABLED=${JSON.stringify(value)}`);
    const text = String(warn.mock.calls[0].arguments[0]);
    assert.match(text, /PANEL_ENABLED/);
    assert.match(text, /ADMIN_PANEL=false/);
    assert.ok(b.log.includes("createAdmin"), "the panel starts although PANEL_ENABLED=false");
    assert.ok(b.log.includes("startAdminServer:admin=yes"));
  }
});

test("PANEL_ENABLED: the variable never disables the panel, ADMIN_PANEL=false does", async (t) => {
  const warn = mock.method(console, "warn", () => {});
  t.after(() => warn.mock.restore());
  const b = makeBoot({ env: { PANEL_ENABLED: "true" }, config: { ADMIN_PANEL: false } });
  await b.run();
  assert.equal(warn.mock.calls.length, 1);
  assert.ok(!b.log.includes("createAdmin"));
  assert.ok(!b.log.some((l) => l.startsWith("startAdminServer")), "index mode with ADMIN_PANEL=false binds nothing");
});

test("without PANEL_ENABLED there is no warning", async (t) => {
  const warn = mock.method(console, "warn", () => {});
  t.after(() => warn.mock.restore());
  const b = makeBoot({ env: {} });
  await b.run();
  assert.equal(warn.mock.calls.length, 0);
});

test("ADMIN_PANEL=false starts no server and no admin in index mode; panel mode keeps the legacy routes alone", async () => {
  const index = makeBoot({ config: { ADMIN_PANEL: false } });
  const indexResult = await index.run({ mode: "normal" });
  assert.equal(indexResult.panel, null);
  assert.equal(indexResult.admin, null);
  assert.ok(!index.log.some((l) => l.startsWith("startAdminServer")));
  assert.ok(index.log.includes("client.initialize"), "the bot itself starts");

  const panel = makeBoot({ config: { ADMIN_PANEL: false } });
  const panelResult = await panel.run({ mode: "panel" });
  assert.equal(panelResult.admin, null);
  assert.ok(panel.log.includes("startAdminServer:admin=no"), "hosting panels probe /health: legacy server, no admin");
  assert.ok(!panel.log.includes("createAdmin"));
});

// ---------------------------------------------------------------------------
// The real listener: busy port, bind
// ---------------------------------------------------------------------------

function listen(host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => res.end("x"));
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

test("a busy port is never fatal: the error names PANEL_PORT, PANEL_HOST and ADMIN_PANEL=false and the bot continues", async (t) => {
  const blocker = await listen();
  t.after(() => closeServer(blocker));
  const logger = require("../lib/utils/logger");
  const lines = [];
  logger.setLevel("error");
  logger.setOutput((text) => lines.push(text));
  t.after(() => {
    logger.setOutput();
    logger.setLevel("silent");
  });

  const { startAdminServer } = require("../lib/admin/server");
  const b = makeBoot({
    deps: {
      startAdminServer: (options) =>
        startAdminServer({ ...options, bind: { host: "127.0.0.1", port: blocker.address().port } }),
    },
  });
  const result = await b.run();

  assert.deepEqual(b.exits, [], "never fatal (FR-040)");
  assert.equal(result.panel, null);
  const logged = lines.join("\n");
  assert.match(logged, /PANEL_PORT/);
  assert.match(logged, /PANEL_HOST/);
  assert.match(logged, /ADMIN_PANEL=false/);
  assert.ok(b.log.includes("client.initialize"), "the bot continues without a panel");
  assert.ok(b.log.includes("plugins.loadAll"));
});

test("the bind comes from resolveBind: PANEL_HOST wins over HOST, PANEL_PORT over PORT", async (t) => {
  const free = await listen();
  const port = free.address().port;
  await closeServer(free);
  const saved = { PANEL_HOST: process.env.PANEL_HOST, HOST: process.env.HOST, PANEL_PORT: process.env.PANEL_PORT, PORT: process.env.PORT };
  Object.assign(process.env, { PANEL_HOST: "127.0.0.1", HOST: "0.0.0.0", PANEL_PORT: String(port), PORT: "1" });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { startAdminServer } = require("../lib/admin/server");
  const b = makeBoot({ deps: { startAdminServer } });
  const result = await b.run();
  t.after(() => closeServer(result.panel.server));

  assert.ok(result.panel, "the panel listens");
  const address = result.panel.server.address();
  assert.equal(address.address, "127.0.0.1", "PANEL_HOST wins over HOST");
  assert.equal(address.port, port, "PANEL_PORT wins over PORT");
  assert.equal(result.panel.url, `http://localhost:${port}`);
});

// ---------------------------------------------------------------------------
// Requiring the launchers
// ---------------------------------------------------------------------------

test("requiring panel.js binds nothing and installs no handler, no console capture", () => {
  const listen = mock.method(http.Server.prototype, "listen");
  const before = {
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGINT: process.listenerCount("SIGINT"),
    uncaught: process.listenerCount("uncaughtException"),
    rejection: process.listenerCount("unhandledRejection"),
    log: console.log,
    warn: console.warn,
  };
  try {
    const panel = require("../panel.js");
    assert.equal(typeof panel.createServer, "function");
    assert.equal(typeof panel.botState, "object");
    assert.equal(panel.botState.status, "starting");
    assert.equal(listen.mock.calls.length, 0, "no port was opened");
  } finally {
    listen.mock.restore();
  }
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
  assert.equal(process.listenerCount("uncaughtException"), before.uncaught);
  assert.equal(process.listenerCount("unhandledRejection"), before.rejection);
  assert.equal(console.log, before.log);
  assert.equal(console.warn, before.warn);
});

test("panel.js: botState is the runtime's own object; createServer() serves the legacy routes without a database", async () => {
  const panel = require("../panel.js");
  const server = panel.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).botStatus, "starting");
    panel.botState.status = "running";
    panel.botState.isConnected = true;
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    Object.assign(panel.botState, { status: "starting", isConnected: false });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("index.js and panel.js are thin wrappers: bootstrap() and nothing else", () => {
  const index = fs.readFileSync(path.join(fakes.ROOT, "index.js"), "utf8");
  assert.match(index.split("\n").find((l) => l.trim() && !l.startsWith("//")), /require\("\.\/lib\/utils\/logger"\)\.install\(\)/, "logger.install() first");
  assert.match(index, /bootstrap\(\{ mode: "normal" \}\)/);
  assert.ok(index.split("\n").length < 20);
  const panel = fs.readFileSync(path.join(fakes.ROOT, "panel.js"), "utf8");
  assert.match(panel, /bootstrap\(\{ mode: 'panel'/);
  assert.match(panel, /module\.exports = \{ createServer, botState \}/);
  for (const source of [index, panel]) assert.ok(!/pino\s*\(/.test(source), "no pino( outside the logger");
});

// ---------------------------------------------------------------------------
// Hard requires (T219): a missing engine fails the boot
// ---------------------------------------------------------------------------

const HARD_REQUIRES = [
  "../utils/stats",
  "../utils/housekeeping",
  "../utils/broadcaster",
  "../utils/alerts",
  "../utils/updater",
  "../utils/textOverrides",
  "../utils/commandState",
  "../utils/ytdlpUpdate",
];

/** A loader that serves recorders (no engine of the repository is started) and notes what was asked */
function recorderLoader(asked, failing = {}) {
  return (id) => {
    asked.push(id);
    if (failing[id]) throw failing[id];
    return { start() {}, startChecker() {}, load: async () => {} };
  };
}

test("bootstrap: the engines and the panel collaborators are required by id, none is optional", async () => {
  const asked = [];
  const b = makeBoot({ deps: { engines: undefined, requireModule: recorderLoader(asked) } });
  const result = await b.run();
  assert.ok(result);
  assert.deepEqual([...asked].sort(), [...HARD_REQUIRES].sort());
  assert.deepEqual(
    ENGINES.map((e) => e.id),
    HARD_REQUIRES.slice(0, 5),
  );
  const d = b.created.createAdminDeps;
  assert.ok(d.commandState && d.ytdlpUpdate && d.textOverrides, "handed to the admin, never null");
  assert.ok(d.stats && d.broadcaster && d.alerts && d.updater);
});

test("bootstrap: a missing engine module fails the boot with exit(1), nothing starts after it", async () => {
  for (const id of HARD_REQUIRES) {
    const missing = Object.assign(new Error(`Cannot find module '${id}'\nRequire stack:\n- /x/boot.js`), { code: "MODULE_NOT_FOUND" });
    const b = makeBoot({ deps: { engines: undefined, requireModule: recorderLoader([], { [id]: missing }) } });
    const result = await b.run();
    assert.equal(result, null, id);
    assert.deepEqual(b.exits, [1], id);
    assert.equal(b.runtime.state.status, "error", id);
    assert.deepEqual(b.runtime.errors.map((e) => e[0]), ["startup"], id);
    for (const step of ["createAdmin", "db.sync", "plugins.loadAll", "admin.start", "client.initialize"]) {
      assert.ok(!b.log.includes(step), `${id}: ${step} must not run`);
    }
  }
});

test("bootstrap: a broken engine (syntax error, missing dependency) fails the boot as well", async () => {
  for (const error of [new SyntaxError("Unexpected token"), Object.assign(new Error("Cannot find module 'left-pad'"), { code: "MODULE_NOT_FOUND" })]) {
    const b = makeBoot({ deps: { engines: undefined, requireModule: recorderLoader([], { "../utils/alerts": error }) } });
    assert.equal(await b.run(), null);
    assert.deepEqual(b.exits, [1]);
  }
});

test("every hard-required module exists on disk and loads without side effect", () => {
  const libCore = path.join(fakes.ROOT, "lib", "core");
  for (const id of HARD_REQUIRES) {
    const file = require.resolve(path.resolve(libCore, id));
    assert.ok(fs.existsSync(file), id);
    assert.equal(typeof require(file), "object", id);
  }
});

test("boot.js has no guarded require left: no optionalRequire, no try/catch around a require of an engine", () => {
  const source = fs.readFileSync(path.join(fakes.ROOT, "lib", "core", "boot.js"), "utf8");
  assert.ok(!/optionalRequire|optional\(/.test(source));
  assert.ok(!/MODULE_NOT_FOUND/.test(source));
});

// ---------------------------------------------------------------------------
// Settings hooks
// ---------------------------------------------------------------------------

test("a BOT_LANG change reloads the language manager (real store, real change event)", async () => {
  const db = await fakes.syncDb();
  const store = createSettingsStore();
  const b = makeBoot({ deps: { settingsStore: store, database: { ...db, DATABASE: db.DATABASE, sync: async () => {} } } });
  // the real store's load() stands in for the recorder
  await b.run();
  const reloads = () => b.log.filter((l) => l === "lang.reload").length;
  const before = reloads();
  await store.set({ BOT_LANG: "en" }, { actor: "test" });
  assert.equal(reloads(), before + 1, "BOT_LANG changed in the panel: the bot's texts follow at once");
  await store.set({ ALWAYS_ONLINE: true }, { actor: "test" });
  assert.equal(reloads(), before + 1, "other keys do not reload the language");
});

test("LOG_LEVEL is applied from the loaded settings right after the store loads", async () => {
  const b = makeBoot({ config: { LOG_LEVEL: "warn" } });
  await b.run();
  const load = b.log.findIndex((l) => l.startsWith("store.load"));
  assert.equal(b.log[load + 1], "logger.setLevel:warn");
});

// ---------------------------------------------------------------------------
// Fatal failures
// ---------------------------------------------------------------------------

test("a database that cannot be reached is fatal in both modes: exit(1), status error, nothing after it runs", async () => {
  for (const mode of ["normal", "panel"]) {
    const b = makeBoot({
      deps: {
        database: {
          DATABASE: {
            authenticate: async () => {
              throw new Error("ECONNREFUSED");
            },
          },
          sync: async () => b.log.push("db.sync"),
        },
      },
    });
    const result = await b.run({ mode });
    assert.equal(result, null);
    assert.deepEqual(b.exits, [1], mode);
    assert.equal(b.runtime.state.status, "error");
    assert.deepEqual(b.runtime.errors, [["startup", "ECONNREFUSED"]]);
    assert.ok(!b.log.includes("db.sync"));
    assert.ok(!b.log.includes("plugins.loadAll"));
    assert.ok(!b.log.includes("client.initialize"));
    assert.equal(b.runtime.dbReady, false);
  }
});

test("a client that cannot initialize is fatal too", async () => {
  const b = makeBoot();
  b.client.initialize = async () => {
    throw new Error("no network at all");
  };
  const result = await b.run();
  assert.equal(result, null);
  assert.deepEqual(b.exits, [1]);
});

test("boot.js and the launchers never log the session out", () => {
  for (const file of ["lib/core/boot.js", "index.js", "panel.js"]) {
    assert.ok(!/\.logout\s*\(/.test(fs.readFileSync(path.join(fakes.ROOT, file), "utf8")), file);
  }
});
