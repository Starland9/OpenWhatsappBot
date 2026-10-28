"use strict";
/**
 * End-to-end harness of the admin panel (contracts/runtime.md section 16): the real `createAdmin` with the real
 * authentication, an in-memory database, an injectable clock and a very low scrypt cost, listening on
 * 127.0.0.1:0. The admin is UNSTARTED: call `await t.admin.start()` to get the setup link (printed into
 * `t.printed`, never to the real stdout).
 *
 *   const t = await createTestAdmin({ clock, trustProxy: "", config: {...}, alerts, kdf });
 *   const client = t.client();                 cookie-jar client, see test/helpers/adminClient.js
 *   await t.admin.start();
 *   const { token } = t.lastLink();            the printed setup (or reset) link
 *   await client.setup("a long enough password", { token });
 *   ...
 *   await t.close();
 *
 * What it exposes: `admin`, `server`, `port`, `base`, `clock` (a fake clock, NOT installed on the global Date),
 * `config` (the object handed to createAdmin: mutate PANEL_TRUST_PROXY or PANEL_PUBLIC_URL between requests),
 * `db` (the database module), `audit` (a real audit instance on the fake clock), `auth` (the real facade),
 * `hub`, `alerts` (a recorder: `alerts.calls`), `printed` (lines sent to printToConsole), `dataDir`,
 * `dumpTables()` and `close()`.
 *
 * Each call starts from empty admin tables (accounts, sessions, tokens, audit rows) because the in-memory
 * database is shared by every test of a file; pass `fresh: false` to keep them. Nothing here touches the real
 * `data/`, `sessions/` or `database.db`, and `config.env` is never read (OWB_NO_CONFIG_ENV).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const fakes = require("./fakes");
const { createClock } = require("./fakeClock");
const { createAdminClient } = require("./adminClient");
const { applyBotFragments } = require("./botFragments");

/** Tiny scrypt cost (the hash string is self-describing, so verification follows). */
const LOW_KDF = Object.freeze({ N: 16, r: 1, p: 1 });
const LINK = /(https?:\/\/\S+?\/admin\/setup\?token=([A-Za-z0-9_-]{43}))/;
const ADMIN_TABLES = ["AdminSession", "AdminToken", "AdminAccount", "AuditLog"];

function silentLogger() {
  const lines = [];
  const log = (level) => (...args) => lines.push({ level, args });
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** A stand-in for lib/utils/alerts.js: records every `raise`. */
function recordingAlerts() {
  const calls = [];
  return {
    calls,
    raise(type, payload, options) {
      calls.push({ type, payload, options });
      return Promise.resolve({ queued: true });
    },
  };
}

async function clearAdminTables(db) {
  for (const name of ADMIN_TABLES) await db[name].destroy({ where: {}, truncate: true });
}

/**
 * @param {object} [opts]
 * @param {object} [opts.clock]          fake clock (default: a new one)
 * @param {string} [opts.trustProxy]     PANEL_TRUST_PROXY ("loopback", "all", an address list...)
 * @param {string} [opts.publicUrl]      PANEL_PUBLIC_URL
 * @param {object} [opts.config]         extra settings handed to createAdmin as `config`
 * @param {object} [opts.kdf]            scrypt cost (default LOW_KDF)
 * @param {object} [opts.alerts]         alerts engine stand-in (default: a recorder)
 * @param {object} [opts.setup]          options of fakes.setupEnv (sudo, prefix, lang, env)
 * @param {boolean} [opts.fresh=true]    empty the admin tables first
 * @param {boolean} [opts.rehydrate]     true: let start() rehydrate the login limiter from audit rows
 * @param {Array<Function>} [opts.extraRoutes]  [(registerArgs) => void] registered after the modules
 * @param {object} [opts.deps]           anything else for createAdmin (overrides the defaults)
 */
async function createTestAdmin(opts = {}) {
  if (process.env.OWB_NO_CONFIG_ENV === undefined) process.env.OWB_NO_CONFIG_ENV = "1";
  const realConfig = fakes.setupEnv(opts.setup || {});
  const db = await fakes.syncDb();
  if (opts.fresh !== false) await clearAdminTables(db);
  await require("../../lib/utils/settingsStore").load({ models: db });
  applyBotFragments();

  const { createAdmin } = require("../../lib/admin");
  const { createPanelServer } = require("../../lib/admin/server");
  const { createAudit } = require("../../lib/admin/audit");

  const clock = opts.clock || createClock();
  const printed = [];
  const alerts = opts.alerts || recordingAlerts();
  const audit = createAudit({ models: db, now: () => clock.now() });
  const logger = opts.logger || silentLogger();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-auth-"));
  const config = {
    PANEL_TRUST_PROXY: opts.trustProxy || "",
    PANEL_PUBLIC_URL: opts.publicUrl || "",
    MAX_UPLOAD: 230,
    VERSION: realConfig.VERSION,
    LANG: realConfig.LANG,
    TIMEZONE: realConfig.TIMEZONE,
    ...(opts.config || {}),
  };

  const captured = {};
  let server = null;
  const admin = createAdmin({
    models: db,
    config,
    clock,
    timers: clock.timers,
    logger,
    audit,
    alerts,
    kdf: opts.kdf || LOW_KDF,
    dataDir,
    port: () => (server ? server.address().port : 3000),
    printToConsole: (line) => printed.push(String(line)),
    rehydrateLimits: opts.rehydrate === true,
    runtime: { dbReady: true },
    maintenanceMode: { isActive: () => false },
    bus: new EventEmitter(),
    ring: { list: () => [], subscribe: () => () => {} },
    ...(opts.deps || {}),
    extraRoutes: [
      (args) => {
        captured.registerArgs = args;
      },
      ...(opts.extraRoutes || []),
    ],
  });

  server = createPanelServer({ botState: { status: "starting" }, admin });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const t = {
    admin,
    server,
    port,
    base,
    clock,
    config,
    db,
    audit,
    alerts,
    logger,
    printed,
    dataDir,
    deps: captured.registerArgs.deps,
    auth: captured.registerArgs.deps.auth,
    hub: admin.hub,

    client: () => createAdminClient({ base, port }),

    /** The last printed setup or reset link: { url, token }. */
    lastLink() {
      for (let i = printed.length - 1; i >= 0; i -= 1) {
        const match = LINK.exec(printed[i]);
        if (match) return { url: match[1], token: match[2], line: printed[i] };
      }
      return null;
    },

    /** Every table as JSON text, to prove that a request changed nothing. */
    async dumpTables() {
      const out = {};
      for (const [name, model] of Object.entries(db)) {
        if (name === "DATABASE" || name === "sync" || typeof model.findAll !== "function") continue;
        out[name] = (await model.findAll({ raw: true })).map((row) => JSON.stringify(row)).sort();
      }
      return out;
    },

    /** Create the account and return a logged-in client. */
    async loginClient(password = "a long enough password", client = t.client()) {
      if (!t.lastLink()) await admin.start();
      await client.setup(password, { token: t.lastLink().token });
      return client;
    },

    async close() {
      await admin.stop();
      await new Promise((resolve) => server.close(resolve));
      clock.restore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return t;
}

module.exports = { createTestAdmin, recordingAlerts, silentLogger, applyBotFragments, LOW_KDF, LINK };
