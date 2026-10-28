"use strict";

/**
 * Bot runtime (contracts/runtime.md section 6, "BotRuntime"): the process-level state of the bot that panel.js used
 * to keep in module variables, shared by index.js, panel.js and the admin panel.
 *
 *   const runtime = createBotRuntime({ client, mode });
 *   runtime.state             the legacy `botState` object (status, startTime, isConnected, messagesProcessed,
 *                             lastActivity, version, uptime, errors, client); panel.js re-exports this very object
 *   runtime.handlerOptions    { onMessageProcessed, onError } for attachHandlers(), applied by its first call only
 *   runtime.events            EventEmitter: "state" (the client's state plus the `restarting` flag)
 *   runtime.dbReady           false until bootstrap has synced the database (the admin answers 503 `starting`)
 *   runtime.getStatus()       client state + restarting, pendingRestart, codeChanged, uptimeMs, version, memory
 *   runtime.restartBot({ actor })   in-process restart, single-flight; the WhatsApp session is kept
 *   runtime.shutdown(signal)        graceful stop; NEVER a logout (the device stays linked)
 *   runtime.onShutdown(fn)    run `fn` first when shutting down (bootstrap closes the HTTP server and the admin)
 *   runtime.recordError(type, error)
 *   runtime.setTextOverrides(module)   the texts engine, once bootstrap has found it
 *
 * `restartBot` is not `POST /api/restart`: the legacy endpoint still exits the process one second after its
 * answer and lets a supervisor start it again; this one re-reads the settings and reconnects in the same process.
 *
 * Nothing runs at creation but listener registration on the client: no I/O, no timer. Every collaborator is looked
 * up lazily and can be injected (tests, and panel.js which creates the runtime at require time before the database
 * exists).
 */

const EventEmitter = require("events");
const { createLogger } = require("../utils/logger");

const logger = createLogger("runtime");

const RESTART_TIMEOUT_MS = 60 * 1000; // wait for open | qr | logged_out after client.restart()
const SHUTDOWN_EXIT_DELAY_MS = 2000; // let the last writes finish before process.exit
const MAX_ERRORS = 100;
const SETTLED_STATUSES = ["open", "qr", "logged_out"];

/** Run `fn`, return `fallback` when it throws (a status read never fails the caller) */
function attempt(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return fallback;
  }
}

/** Resolve true as soon as the client reports one of `statuses`, false after `timeoutMs` */
function waitForStatus(client, statuses, timeoutMs) {
  return new Promise((resolve) => {
    const current = attempt(() => client.getState(), null);
    if (current && statuses.includes(current.status)) {
      resolve(true);
      return;
    }
    let timer = null;
    const finish = (value) => {
      if (timer) clearTimeout(timer);
      client.off("state", onState);
      resolve(value);
    };
    const onState = (snapshot) => {
      if (snapshot && statuses.includes(snapshot.status)) finish(true);
    };
    client.on("state", onState);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * @param {object} options
 * @param {object} options.client            WhatsAppClient (or a fake with on/off/getState/restart/stop)
 * @param {"normal"|"panel"} [options.mode]
 * @param {object} [options.settingsStore]   default lib/utils/settingsStore
 * @param {object} [options.languageManager] default lib/utils/language#languageManager
 * @param {object} [options.textOverrides]   optional (lib/utils/textOverrides once delivered): { load({ models }) }
 * @param {object} [options.settingsCache]   default lib/utils/settingsCache
 * @param {Function} [options.reconfigure]   re-arms conversationManager, antiDeleteHandler and memoryManager
 * @param {{ now(): number }} [options.clock]
 * @param {Function} [options.exit]          default process.exit
 * @param {number} [options.shutdownDelayMs]
 * @param {number} [options.restartTimeoutMs]
 * @param {object} [options.stats]           default lib/utils/stats (flush on shutdown)
 * @param {object} [options.conversationManager] default lib/utils/conversationManager (flush on shutdown)
 * @param {object} [options.database]        default lib/database (models and DATABASE.close on shutdown)
 */
function createBotRuntime(options = {}) {
  const { client, mode = "normal" } = options;
  const clock = options.clock || { now: () => Date.now() };
  const exit = options.exit || ((code) => process.exit(code));
  const shutdownDelayMs = options.shutdownDelayMs ?? SHUTDOWN_EXIT_DELAY_MS;
  const restartTimeoutMs = options.restartTimeoutMs ?? RESTART_TIMEOUT_MS;

  const getStore = () => options.settingsStore || require("../utils/settingsStore");
  const getLanguageManager = () => options.languageManager || require("../utils/language").languageManager;
  const getSettingsCache = () => options.settingsCache || require("../utils/settingsCache");
  const getDatabase = () => options.database || require("../database");
  const reconfigure =
    options.reconfigure ||
    (() => {
      for (const id of ["../utils/conversationManager", "../utils/antiDeleteHandler", "../utils/memoryManager"]) {
        const singleton = require(id);
        if (typeof singleton.reconfigure === "function") singleton.reconfigure();
      }
    });

  let textOverrides = options.textOverrides || null;
  const startedAt = clock.now();
  const events = new EventEmitter();
  const shutdownHooks = [];
  let restarting = false;
  let restartPromise = null;
  let shuttingDown = false;
  let shutdownPromise = null;

  // The legacy botState: same keys, same initial values as panel.js
  const state = {
    status: "starting",
    startTime: null,
    isConnected: false,
    messagesProcessed: 0,
    lastActivity: null,
    version: require("../../config").VERSION,
    uptime: 0,
    errors: [],
    client: client || null,
  };

  function recordError(type, error) {
    state.errors.push({
      type,
      error: (error && error.message) || String(error),
      timestamp: new Date(clock.now()).toISOString(),
    });
    // keep the last 100, in place: other modules hold a reference to this array
    if (state.errors.length > MAX_ERRORS) state.errors.splice(0, state.errors.length - MAX_ERRORS);
  }

  function emitState() {
    const snapshot = { ...attempt(() => client.getState(), {}), restarting };
    try {
      events.emit("state", snapshot);
    } catch (error) {
      logger.error({ name: error && error.name }, "A runtime state listener failed");
    }
  }

  if (client && typeof client.on === "function") {
    client.on("ready", () => {
      state.status = "running";
      state.isConnected = true;
      state.startTime = clock.now();
    });
    client.on("close", () => {
      state.isConnected = false;
      // stop() closes the socket during shutdown, and restartBot() on purpose: keep those statuses
      if (state.status !== "shutting_down" && state.status !== "restarting") state.status = "disconnected";
    });
    client.on("state", emitState);
  }

  const handlerOptions = {
    onMessageProcessed: () => {
      state.messagesProcessed++;
      state.lastActivity = new Date(clock.now()).toISOString();
    },
    onError: (error) => recordError("message_processing", error),
  };

  function getStatus() {
    const clientState = attempt(() => client.getState(), {});
    const store = attempt(getStore, null);
    const updater = attempt(() => require("../utils/updater"), null);
    const codeChanged = attempt(() => {
      const verdict = updater && typeof updater.restartRequired === "function" ? updater.restartRequired() : null;
      return !!(verdict && verdict.required === true);
    }, false);
    return {
      ...clientState,
      restarting,
      pendingRestart: attempt(() => (store ? store.pendingRestart() : []), []),
      codeChanged,
      uptimeMs: clock.now() - startedAt,
      version: state.version,
      messagesProcessed: state.messagesProcessed,
      memory: process.memoryUsage(),
    };
  }

  /**
   * In-process restart: re-read the settings and the texts, re-arm the singletons that read their
   * configuration when built, then close and reopen the connection with the same credentials.
   * @returns {Promise<{ ok: boolean, code?: "busy"|"timeout"|"failed", status: string }>}
   */
  function restartBot({ actor } = {}) {
    if (restartPromise) return Promise.resolve({ ok: false, code: "busy", status: state.status });
    restartPromise = (async () => {
      restarting = true;
      state.status = "restarting"; // /health answers 503 for the few seconds it takes
      emitState();
      logger.info({ actor: actor || null }, "Restarting the bot in process");
      try {
        getSettingsCache().clear();
        await getStore().reload();
        getLanguageManager().reload();
        if (textOverrides && typeof textOverrides.load === "function") {
          await textOverrides.load({ models: getDatabase() });
        }
        reconfigure();
        await client.restart();

        const settled = await waitForStatus(client, SETTLED_STATUSES, restartTimeoutMs);
        // the settings are in force now even when the connection is slow to settle: it keeps converging
        getStore().markInForce();
        if (!settled) {
          logger.warn("The connection did not settle within the restart window");
          return { ok: false, code: "timeout", status: state.status };
        }
        return { ok: true, status: state.status };
      } catch (error) {
        logger.error({ name: error && error.name, code: error && error.code }, "In-process restart failed");
        return { ok: false, code: "failed", status: state.status };
      } finally {
        restarting = false;
        if (state.status === "restarting") state.status = state.isConnected ? "running" : "disconnected";
        restartPromise = null;
        emitState();
      }
    })();
    return restartPromise;
  }

  /** Graceful shutdown: flush what is pending, close the connection WITHOUT unlinking the device, then exit. */
  function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info(`${signal || "shutdown"} received, shutting down gracefully...`);
      state.status = "shutting_down";
      emitState();

      for (const hook of shutdownHooks) {
        try {
          await hook();
        } catch (error) {
          logger.error({ name: error && error.name }, "A shutdown hook failed");
        }
      }
      try {
        await (options.stats || require("../utils/stats")).flush();
      } catch (error) {
        logger.error({ name: error && error.name }, "Flushing the statistics failed");
      }
      try {
        await (options.conversationManager || require("../utils/conversationManager")).flush();
      } catch (error) {
        logger.error({ name: error && error.name }, "Flushing the conversations failed");
      }
      // Closes the connection but keeps the linked device: no new QR on restart
      if (client && typeof client.stop === "function") {
        try {
          await client.stop();
          logger.info("WhatsApp client stopped");
        } catch (error) {
          logger.error({ name: error && error.name }, "Error stopping the client");
        }
      }
      try {
        await getDatabase().DATABASE.close();
        logger.info("Database connection closed");
      } catch (error) {
        logger.error({ name: error && error.name }, "Error closing the database");
      }

      // Give time for cleanup
      setTimeout(() => {
        logger.info("Goodbye!");
        exit(0);
      }, shutdownDelayMs);
    })();
    return shutdownPromise;
  }

  return {
    mode,
    client: client || null,
    state,
    handlerOptions,
    events,
    dbReady: false,
    getStatus,
    restartBot,
    shutdown,
    recordError,
    isShuttingDown: () => shuttingDown,
    /** lib/utils/textOverrides once it exists: restartBot() reloads it (panel.js builds the runtime before) */
    setTextOverrides(module) {
      textOverrides = module || null;
    },
    onShutdown(fn) {
      if (typeof fn === "function") shutdownHooks.push(fn);
    },
  };
}

module.exports = { createBotRuntime, RESTART_TIMEOUT_MS, SHUTDOWN_EXIT_DELAY_MS };
