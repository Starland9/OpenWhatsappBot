"use strict";

/**
 * Process start-up shared by index.js (mode "normal") and panel.js (mode "panel"), contracts/runtime.md
 * section 15 "Starting it". The two entry files are thin wrappers around `bootstrap()`.
 *
 *   1  logger.install(), global error handlers, the one-line PANEL_ENABLED warning (research U18)
 *   2  memoryManager.performCleanup()
 *   3  WhatsAppClient + BotRuntime, SIGTERM/SIGINT -> runtime.shutdown
 *   4  the HTTP server, BEFORE the database so a host sees the port during boot. With ADMIN_PANEL it serves the
 *      admin panel and the legacy routes; panel mode keeps the legacy routes alone when ADMIN_PANEL=false (that
 *      is what hosting panels probe); index mode without ADMIN_PANEL binds nothing, as before.
 *      A port that cannot be used is never fatal (FR-040).
 *   5  database authenticate -> sync -> runtime.dbReady (fatal otherwise)
 *   6  settingsStore.load -> languageManager.reload -> textOverrides.load -> settingsStore.markInForce
 *   7  PluginLoader.loadAll()
 *   8  attachHandlers(client, runtime.handlerOptions), before initialize() so no early event is missed
 *   9  engines: stats, housekeeping, broadcaster, alerts, updater checker; then admin.start()
 *   10 client.initialize()
 *
 * The engines (stats, housekeeping, broadcaster, alerts, updater) and the modules `textOverrides`, `commandState` and
 * `ytdlpUpdate` are HARD requires: a module that is missing or broken fails the start-up (exit 1) instead of leaving a
 * feature silently off. A test replaces any of them through `options.deps.engines` (a recorder, or `null` to leave
 * one out on purpose) or the whole loader through `options.deps.requireModule`.
 *
 * Every collaborator can be replaced through `options.deps` (tests); nothing is required at module load except
 * Node built-ins, so requiring this file has no side effect.
 */

/** The engines started in step 9, in order: { name, id, start(module, client) } */
const ENGINES = [
  { name: "stats", id: "../utils/stats", start: (engine) => engine.start() },
  { name: "housekeeping", id: "../utils/housekeeping", start: (engine) => engine.start() },
  { name: "broadcaster", id: "../utils/broadcaster", start: (engine, client) => engine.start(client) },
  { name: "alerts", id: "../utils/alerts", start: (engine, client) => engine.start(client) },
  { name: "updater", id: "../utils/updater", start: (engine, client) => engine.startChecker(client) },
];

/** A log-safe view of an error (never an axios config, which holds API keys) */
function describeError(error, safeLog) {
  const view = safeLog(error);
  return {
    ...view,
    name: error && error.name,
    stack: error && typeof error.stack === "string" ? error.stack.split("\n").slice(0, 12).join("\n") : undefined,
  };
}

/**
 * @param {object} [options]
 * @param {"normal"|"panel"} [options.mode="normal"]
 * @param {object} [options.client]   a client created by the caller (panel.js builds its runtime at require time)
 * @param {object} [options.runtime]  the runtime created for that client
 * @param {object} [options.deps]     replacements for the collaborators (tests): logger, config, process, env,
 *   exit, database, settingsStore, secretBox, languageManager, memoryManager, PluginLoader, attachHandlers,
 *   WhatsAppClient, createAdmin, startAdminServer, bind, requireModule (the loader of the engines), engines (by
 *   name: stats, housekeeping, broadcaster, alerts, updater, textOverrides, commandState, ytdlpUpdate)
 * @returns {Promise<{ client, runtime, admin, panel }|null>} null when start-up failed (the process exits)
 */
async function bootstrap(options = {}) {
  const mode = options.mode === "panel" ? "panel" : "normal";
  const deps = options.deps || {};
  const pick = (key, load) => (deps[key] !== undefined ? deps[key] : load());
  const proc = deps.process || process;
  const env = deps.env || proc.env;
  const exit = deps.exit || ((code) => process.exit(code));

  // 1. logging first: everything the next modules print goes through the capture
  const loggerModule = pick("logger", () => require("../utils/logger"));
  loggerModule.install();
  const log = loggerModule.createLogger("boot");
  const config = pick("config", () => require("../../config"));
  const { safeLog } = pick("http", () => require("../utils/http"));
  const { getLang } = pick("language", () => require("../utils/language"));

  let runtime = options.runtime || null;
  const recordError = (type, error) => {
    if (runtime) runtime.recordError(type, error);
  };

  // Global safety: catch uncaught errors/rejections to avoid a process crash
  proc.on("uncaughtException", (error) => {
    try {
      log.error({ err: describeError(error, safeLog) }, "Uncaught exception");
    } catch (e) {
      console.error("Uncaught exception");
    }
    recordError("uncaught_exception", error);
  });
  proc.on("unhandledRejection", (reason) => {
    try {
      log.error({ err: describeError(reason, safeLog) }, "Unhandled rejection");
    } catch (e) {
      console.error("Unhandled rejection");
    }
    recordError("unhandled_rejection", reason);
  });

  // The variable is never consulted: ADMIN_PANEL decides. One line tells whoever still sets it.
  if (env.PANEL_ENABLED !== undefined) console.warn(getLang("admin.panel_enabled_ignored"));

  // Set a sane global timeout for axios (used by many plugins)
  try {
    const axios = require("axios");
    if (axios && axios.defaults) axios.defaults.timeout = 30000; // 30s
  } catch (e) {
    log.debug("axios not available to set global timeout");
  }

  try {
    log.info(`🤖 Open Whatsapp Bot v${config.VERSION}${mode === "panel" ? " (Panel Mode)" : ""}`);

    // 2. memory manager
    const memoryManager = pick("memoryManager", () => require("../utils/memoryManager"));
    memoryManager.performCleanup();
    log.info("✅ Memory manager initialized");

    // 3. client and runtime (cheap, no I/O)
    let client = options.client || (runtime && runtime.client) || null;
    if (!client) {
      const WhatsAppClient = pick("WhatsAppClient", () => require("../baileys/client").WhatsAppClient);
      client = new WhatsAppClient();
    }
    if (!runtime) {
      const { createBotRuntime } = require("./botRuntime");
      runtime = createBotRuntime({ client, mode });
    }
    runtime.state.status = "initializing";
    for (const signal of ["SIGTERM", "SIGINT"]) proc.on(signal, () => runtime.shutdown(signal));

    const settingsStore = pick("settingsStore", () => require("../utils/settingsStore"));
    const secretBox = pick("secretBox", () => require("../utils/secretBox"));
    const redactor = pick("redactor", () => require("../admin/logs/redactor"));
    const languageManager = pick("languageManager", () => require("../utils/language").languageManager);
    const database = pick("database", () => require("../database"));

    // BOT_LANG changed in the panel: the bot's texts follow at once (descriptions are lazy, so they follow too)
    settingsStore.onChange(["BOT_LANG"], () => languageManager.reload());

    // Engine modules and the other panel collaborators: hard requires now (no I/O, no timer), started in step 9
    const requireModule = deps.requireModule || ((id) => require(id));
    const supplied = (name) => deps.engines && Object.prototype.hasOwnProperty.call(deps.engines, name);
    const engineOf = (name, id) => (supplied(name) ? deps.engines[name] : requireModule(id));
    const engineModules = {};
    for (const engine of ENGINES) engineModules[engine.name] = engineOf(engine.name, engine.id);
    const textOverrides = engineOf("textOverrides", "../utils/textOverrides");
    const commandState = engineOf("commandState", "../utils/commandState");
    const ytdlpUpdate = engineOf("ytdlpUpdate", "../utils/ytdlpUpdate");
    runtime.setTextOverrides(textOverrides);

    // 4. HTTP server, before the database
    let admin = null;
    let panel = null;
    if (config.ADMIN_PANEL) {
      const createAdmin = pick("createAdmin", () => require("../admin").createAdmin);
      admin = createAdmin({
        config,
        models: database,
        settingsStore,
        secretBox,
        languageManager,
        textOverrides,
        runtime,
        client,
        registry: pick("registry", () => require("../plugins/registry")),
        commandState,
        stats: engineModules.stats,
        bus: pick("bus", () => require("../utils/events")),
        ring: pick("ring", () => require("../admin/logs/ring")),
        redactor,
        broadcaster: engineModules.broadcaster,
        alerts: engineModules.alerts,
        updater: engineModules.updater,
        ytdlpUpdate,
      });
      runtime.onShutdown(() => admin.stop());
    }
    if (config.ADMIN_PANEL || mode === "panel") {
      const startAdminServer = pick("startAdminServer", () => require("../admin/server").startAdminServer);
      panel = await startAdminServer({ admin, runtime, bind: deps.bind, config });
      if (panel && panel.server) {
        runtime.onShutdown(
          () =>
            new Promise((resolve) => {
              // close() also ends the open connections (SSE streams would keep it waiting forever)
              panel.server.close(() => resolve());
              const timer = setTimeout(resolve, 1000);
              if (typeof timer.unref === "function") timer.unref();
            }),
        );
      }
    }

    // 5. database
    await database.DATABASE.authenticate({ retry: { max: 3 } });
    log.info("✅ Database connected");
    await database.sync();
    runtime.dbReady = true;
    log.info("✅ Database synced");

    // 6. settings and texts
    await settingsStore.load({ models: database, secretBox, redactor });
    loggerModule.setLevel(config.LOG_LEVEL);
    languageManager.reload();
    if (textOverrides && typeof textOverrides.load === "function") {
      await textOverrides.load({ models: database });
    }
    settingsStore.markInForce();

    // 7. plugins
    const PluginLoader = pick("PluginLoader", () => require("../plugins/loader"));
    await PluginLoader.loadAll();
    log.info("✅ Plugins loaded");

    // 8. The shared pipeline (lib/core/pipeline.js) handles messages, anti-delete, group participants and ready
    //    hooks; it is attached first so that no event is missed.
    const attachHandlers = pick("attachHandlers", () => require("./pipeline").attachHandlers);
    attachHandlers(client, runtime.handlerOptions);

    // 9. engines, then the admin (which prints the setup link when no account exists)
    for (const engine of ENGINES) {
      const engineModule = engineModules[engine.name];
      if (!engineModule) continue;
      try {
        await engine.start(engineModule, client);
        log.debug({ engine: engine.name }, "engine started");
        if (typeof engineModule.stop === "function") runtime.onShutdown(() => engineModule.stop());
      } catch (error) {
        // an engine that cannot start (a broken alert channel...) must not keep the bot from running
        log.error({ engine: engine.name, err: describeError(error, safeLog) }, "engine failed to start");
      }
    }
    if (admin) await admin.start();

    // Keep-alive: the last activity stamp of /status. unref'd, it never holds the process open.
    const keepAlive = setInterval(() => {
      if (runtime.state.isConnected) {
        runtime.state.lastActivity = new Date().toISOString();
        log.debug("Keep-alive ping");
      }
    }, config.KEEP_ALIVE_INTERVAL || 60000);
    if (typeof keepAlive.unref === "function") keepAlive.unref();
    runtime.onShutdown(() => clearInterval(keepAlive));

    // 10. connect
    await client.initialize();

    return { client, runtime, admin, panel };
  } catch (error) {
    log.error({ err: describeError(error, safeLog) }, "Failed to start bot");
    if (runtime) {
      runtime.state.status = "error";
      runtime.recordError("startup", error);
    }
    exit(1);
    return null;
  }
}

module.exports = { bootstrap, ENGINES };
