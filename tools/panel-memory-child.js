#!/usr/bin/env node
"use strict";

/**
 * One measured process of the memory check (SC-009, quickstart section 6). Run it with --expose-gc:
 *
 *   node --expose-gc tools/panel-memory-child.js baseline [--idle-ms=20000]
 *   node --expose-gc tools/panel-memory-child.js panel    [--idle-ms=20000]
 *
 *   baseline  what the bot loads whether or not the panel is on: config, the in-memory database (additive sync),
 *             the settings store, the text overrides, the engine modules (required, not started), the bot runtime
 *             with a stand-in client, and every plugin (PluginLoader.loadAll). Idles, then measures.
 *   panel     the baseline plus the admin panel: createAdmin with the real services and engines, the HTTP server on
 *             127.0.0.1:0, admin.start(), the setup and login of a first administrator, one GET of every static
 *             file ("every page"), one GET of every read-only session route of the API, one SSE stream kept open
 *             (logs=1), then the same idle. Measured after two forced garbage collections.
 *
 * The last stdout line is a JSON object: { mode, rss, heapUsed, external, arrayBuffers, routes, fetched, failed }
 * (bytes). Nothing else is printed to stdout; the setup link and every error go nowhere near it.
 *
 * Safety: the environment is forced before anything is required. `OWB_NO_CONFIG_ENV=1` keeps config.js from reading
 * config.env, the database is `:memory:`, every secret setting is blank, the secret key and the admin data live in a
 * temporary directory removed on exit, and nothing reaches WhatsApp or the network (the stand-in client never
 * connects, no engine is started). It never reads sessions/, data/ or database.db.
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const ROOT = path.resolve(__dirname, "..");
const MODES = ["baseline", "panel"];
const DEFAULT_IDLE_MS = 20 * 1000;
const PASSWORD = "a long enough password for the measure";
/** Path-parameter values tried in turn for the read-only routes (the first one the router does not 404 wins) */
const SAMPLES = ["120363000000000001@g.us", "1", "ping", "en", "237600000001@s.whatsapp.net", "abc", "openai", "database", "0123456789abcdef0123456789abcdef"];

function parseArgs(argv) {
  const mode = argv[2];
  if (!MODES.includes(mode)) {
    process.stderr.write(`usage: node --expose-gc tools/panel-memory-child.js <${MODES.join("|")}> [--idle-ms=N]\n`);
    process.exit(2);
  }
  let idleMs = DEFAULT_IDLE_MS;
  for (const arg of argv.slice(3)) {
    const match = /^--idle-ms=(\d{1,7})$/.exec(arg);
    if (match) idleMs = Number(match[1]);
  }
  return { mode, idleMs };
}

/** Force the environment before config.js, the catalog or the database are required */
function prepareEnvironment() {
  process.env.OWB_NO_CONFIG_ENV = "1";
  process.env.LOG_LEVEL = "silent";
  process.env.BAILEYS_LOG_LVL = "silent";
  const { entries } = require(path.join(ROOT, "lib/utils/settingsCatalog"));
  for (const entry of entries) if (entry.secret) process.env[entry.key] = ""; // blank, whatever the parent passed
  process.env.DATABASE_URL = ":memory:";
  process.env.DATABASE_SSL = "false";
  process.env.UPDATE_CHECK = "false";
  process.env.SUDO = "237600000009";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client that never connects: just enough surface for the runtime, the dashboard and the pairing routes */
function standInClient() {
  const client = new EventEmitter();
  const state = {
    status: "open",
    since: Date.now(),
    generation: 1,
    registered: true,
    me: { number: "237600000001", name: "Bot" },
    qrVersion: 0,
    hasQr: false,
    pairing: null,
    lastClose: null,
    reconnectAttempt: 0,
  };
  client.getState = () => ({ ...state });
  client.ready = () => false;
  client.getSocket = () => null;
  client.getPairingArtifacts = () => ({ qr: null, qrVersion: 0 });
  client.initialize = async () => {};
  client.stop = async () => {};
  client.restart = async () => ({ ok: true });
  return client;
}

/** Everything the bot has with or without the panel; returns what the panel mode needs to build on */
async function loadBaseline() {
  const database = require(path.join(ROOT, "lib/database"));
  await database.DATABASE.authenticate();
  await database.sync();

  const settingsStore = require(path.join(ROOT, "lib/utils/settingsStore"));
  const secretBox = require(path.join(ROOT, "lib/utils/secretBox"));
  const redactor = require(path.join(ROOT, "lib/admin/logs/redactor"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-memory-"));
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  secretBox.configure({ dir: dataDir }); // never the real data/panel.key
  await settingsStore.load({ models: database, secretBox, redactor });
  settingsStore.markInForce();

  const engines = {};
  for (const name of ["stats", "housekeeping", "broadcaster", "alerts", "updater", "textOverrides", "commandState", "ytdlpUpdate"]) {
    engines[name] = require(path.join(ROOT, "lib/utils", name)); // required as boot.js does, never started
  }
  await engines.textOverrides.load({ models: database });

  const client = standInClient();
  const { createBotRuntime } = require(path.join(ROOT, "lib/core/botRuntime"));
  const runtime = createBotRuntime({ client, mode: "normal", exit: () => {} });
  runtime.dbReady = true;

  const PluginLoader = require(path.join(ROOT, "lib/plugins/loader"));
  await PluginLoader.loadAll();
  return { database, settingsStore, secretBox, redactor, engines, client, runtime, tmp, dataDir };
}

/** A fetch-based cookie jar: what a browser would hold after the setup link */
function makeBrowser(base) {
  const jar = new Map();
  let csrf = null;
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  async function send(method, route, { body, guarded = true } = {}) {
    const headers = { Accept: "application/json" };
    if (guarded) headers.Origin = base;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }
    if (jar.size) headers.Cookie = cookieHeader();
    const res = await fetch(`${base}${route}`, { method, headers, redirect: "manual", body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const first = line.split(";")[0];
      const at = first.indexOf("=");
      const attrs = line.toLowerCase();
      if (/max-age=0(;|$)/.test(attrs)) jar.delete(first.slice(0, at).trim());
      else jar.set(first.slice(0, at).trim(), first.slice(at + 1).trim());
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (res.headers.get("content-type") && res.headers.get("content-type").includes("json")) {
      try {
        const json = JSON.parse(buffer.toString("utf8"));
        if (json && typeof json.csrf === "string") csrf = json.csrf;
      } catch {
        // not JSON after all
      }
    }
    return { status: res.status, bytes: buffer.length };
  }
  return { send, cookieHeader };
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

/** Fill each `:param` of a route path with the first sample its router pattern accepts (else the first sample) */
function fill(routePath) {
  const { PARAM_PATTERNS } = require(path.join(ROOT, "lib/admin/http/router"));
  return routePath.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name) => {
    const pattern = PARAM_PATTERNS[name];
    const sample = (pattern && SAMPLES.find((candidate) => pattern.test(candidate))) || SAMPLES[0];
    return encodeURIComponent(sample);
  });
}

async function runPanel(base, { admin, port, printed }) {
  const browser = makeBrowser(base);
  const link = /\/admin\/setup\?token=([A-Za-z0-9_-]{43})/.exec(printed.join("\n"));
  if (!link) throw new Error("no setup link was printed");
  await browser.send("GET", `/admin/setup?token=${encodeURIComponent(link[1])}`, { guarded: false });
  const setup = await browser.send("POST", "/admin/api/setup", { body: { password: PASSWORD } });
  if (setup.status !== 200) throw new Error(`setup answered ${setup.status}`);

  let fetched = 0;
  const failed = [];

  // every page: each static file of the SPA
  const publicDir = path.join(ROOT, "lib/admin/public");
  for (const file of ["", ...listFiles(publicDir)]) {
    const res = await browser.send("GET", `/admin/${file}`, { guarded: false });
    fetched += 1;
    // the static server only knows web file types: the licence texts of the vendored libraries are 404 by design
    if (res.status >= 400 && !/(^|\/)LICENSE/.test(file)) failed.push([`/admin/${file}`, res.status]);
  }

  // every read-only API route, once (the event stream is opened below, not fetched)
  const routes = admin.routes().filter((r) => r.method === "GET" && r.auth === "session" && r.path !== "/admin/api/events");
  for (const route of routes) {
    const res = await browser.send("GET", fill(route.path));
    fetched += 1;
    if (res.status >= 500) failed.push([route.path, res.status]);
  }

  // one SSE stream, kept open for the whole idle
  const stream = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/admin/api/events?logs=1", method: "GET", agent: false, headers: { Accept: "text/event-stream", Origin: base, Cookie: browser.cookieHeader() } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`events answered ${res.statusCode}`));
          return;
        }
        res.on("data", () => {}); // consumed, never kept
        resolve({ req, res });
      },
    );
    req.on("error", () => {});
    req.end();
  });
  return { fetched, failed, routes: routes.length, stream };
}

async function main() {
  const { mode, idleMs } = parseArgs(process.argv);
  if (typeof global.gc !== "function") {
    process.stderr.write("panel-memory-child: run with node --expose-gc\n");
    process.exit(2);
  }
  prepareEnvironment();
  const baseline = await loadBaseline();
  const cleanups = [];
  let report = { routes: 0, fetched: 0, failed: [] };

  if (mode === "panel") {
    const { createAdmin } = require(path.join(ROOT, "lib/admin"));
    const { startAdminServer } = require(path.join(ROOT, "lib/admin/server"));
    const config = require(path.join(ROOT, "config"));
    const printed = [];
    let panel = null;
    const admin = createAdmin({
      config,
      models: baseline.database,
      settingsStore: baseline.settingsStore,
      secretBox: baseline.secretBox,
      languageManager: require(path.join(ROOT, "lib/utils/language")).languageManager,
      textOverrides: baseline.engines.textOverrides,
      runtime: baseline.runtime,
      client: baseline.client,
      registry: require(path.join(ROOT, "lib/plugins/registry")),
      commandState: baseline.engines.commandState,
      stats: baseline.engines.stats,
      bus: require(path.join(ROOT, "lib/utils/events")),
      ring: require(path.join(ROOT, "lib/admin/logs/ring")),
      redactor: baseline.redactor,
      broadcaster: baseline.engines.broadcaster,
      alerts: baseline.engines.alerts,
      updater: baseline.engines.updater,
      ytdlpUpdate: baseline.engines.ytdlpUpdate,
      dataDir: baseline.dataDir,
      port: () => (panel && panel.server ? panel.server.address().port : 0),
      printToConsole: (line) => printed.push(String(line)),
    });
    panel = await startAdminServer({ admin, runtime: baseline.runtime, bind: { host: "127.0.0.1", port: 0 }, config });
    if (!panel) throw new Error("the panel could not listen");
    await admin.start();
    const port = panel.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const result = await runPanel(base, { admin, port, printed });
    report = { routes: result.routes, fetched: result.fetched, failed: result.failed };
    cleanups.push(async () => {
      result.stream.req.destroy();
      await admin.stop();
      await new Promise((resolve) => panel.server.close(() => resolve()));
    });
  }

  await sleep(idleMs);
  global.gc();
  await sleep(250);
  global.gc();
  const usage = process.memoryUsage();
  process.stdout.write(
    `${JSON.stringify({
      mode,
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      routes: report.routes,
      fetched: report.fetched,
      failed: report.failed,
    })}\n`,
  );

  for (const cleanup of cleanups) await cleanup().catch(() => {});
  fs.rmSync(baseline.tmp, { recursive: true, force: true });
  process.exit(0); // plugins may leave handles open: the measure is done
}

main().catch((err) => {
  // the name and the message only: never a request, a header or a setting
  process.stderr.write(`panel-memory-child: ${(err && err.name) || "Error"}: ${String((err && err.message) || "failed").slice(0, 300)}\n`);
  process.exit(1);
});
