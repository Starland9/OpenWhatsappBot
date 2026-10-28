"use strict";

/**
 * Composition root of the admin panel (contracts/runtime.md section 15, "createAdmin").
 *
 *   const admin = createAdmin(deps);
 *   admin.handle(req, res)  -> boolean   false for any URL outside /admin and /admin/** (the caller falls through
 *                                        to the legacy handler; `/administrator` is NOT claimed); true once the
 *                                        admin owns the response, 404/405 under /admin included
 *   admin.routes()          -> [{ method, path, auth, csrf, mutates, touch, db }]   drives SC-005
 *   admin.hub               topic hub (lib/admin/events.js)
 *   admin.jobs              registry of long operations (lib/admin/jobs.js)
 *   admin.start()           async, after sync() and the settings load: auth.start() (setup link), the route
 *                           modules' onStart hooks (upload janitor...), the log ring -> hub feed, the audit
 *                           subscription to the bus topic `groupguard:action`
 *   admin.stop()            closes the live streams, clears every timer, unsubscribes
 *
 * `createAdmin` does no I/O and starts no timer: the static files are read on the first request (or by start()),
 * the routes are loaded by requiring modules, nothing listens. Everything that depends on the clock takes
 * `deps.clock.now()`.
 *
 * DEPS (all optional; engines are resolved lazily so a module delivered later never breaks the loading of others)
 *   auth            the `deps.auth` facade documented in lib/admin/http/router.js. Default:
 *                   `require("./auth").createAuth({ ...deps, hub, trustProxy, clock, logger, audit })`; when that module
 *                   does not exist yet every session route answers 401 (deny by default)
 *   audit           lib/admin/audit.js (record, auditDiff...); a no-op stand-in while the module is absent
 *   runtime         BotRuntime: DB-backed routes answer 503 `starting` until `runtime.dbReady === true`
 *   maintenanceMode lib/utils/maintenanceMode.js: mutating routes answer 503 `maintenance` (Retry-After: 5) while active
 *   bus             lib/utils/events.js: `groupguard:action` is persisted as `guard.antibot.remove|suspect` audit rows
 *   ring            lib/admin/logs/ring.js (log stream and replay)
 *   config          settings object (PANEL_PUBLIC_URL, PANEL_TRUST_PROXY, MAX_UPLOAD...); default require("../../config")
 *   clock           { now(): ms }, default Date
 *   timers          { setInterval, clearInterval, setTimeout, clearTimeout } for the hub, streams and janitors
 *   hub, jobs, uploads, sse, trustProxy, logger   replace the default instances (tests)
 *   rootDir, dataDir        default: the repository root and <root>/data
 *   publicDir       directory of the static files, default lib/admin/public
 *   routesDir       directory of the route modules, default lib/admin/routes
 *   extraRoutes     [(registerArgs) => void] registered after the modules (tests)
 * Anything else in `deps` (models, settingsStore, client, registry...) is handed untouched to the route modules.
 */

const path = require("path");
const { createRouter } = require("./http/router");
const { createSecurity } = require("./http/security");
const { createTrustProxy } = require("./http/trustProxy");
const { createStatic } = require("./http/static");
const { createSse } = require("./http/sse");
const { createUploads } = require("./http/uploads");
const { createHub } = require("./events");
const { createJobs } = require("./jobs");
const { registerAll } = require("./routes");
const { AdminError, finish } = require("./http/response");
const { splitUrl } = require("./http/request");
const { createLogger } = require("../utils/logger");

const NOOP_AUDIT = Object.freeze({ record: async () => null });

/** Require a sibling module, tolerating only the absence of that exact module (a later batch delivers it). */
function optionalRequire(request) {
  try {
    return require(request);
  } catch (err) {
    const missing = err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes(`'${request}'`);
    if (!missing) throw err;
    return null;
  }
}

/** Deny-all stand-in: every session route answers 401 until the real authentication is wired. */
const DENY_ALL_AUTH = Object.freeze({
  authenticate() {
    throw new AdminError("unauthenticated");
  },
  touch() {},
});

function createAdmin(deps = {}) {
  const logger = deps.logger || createLogger("admin");
  const clock = deps.clock || { now: () => Date.now() };
  const now = () => clock.now();
  const rootDir = deps.rootDir || path.join(__dirname, "..", "..");
  const dataDir = deps.dataDir || path.join(rootDir, "data");

  const readSetting = (key) => {
    let config = deps.config;
    if (!config) {
      try {
        config = require("../../config");
      } catch {
        config = null;
      }
    }
    const value = config ? config[key] : undefined;
    return value !== undefined && value !== null ? value : process.env[key];
  };

  const hub = deps.hub || createHub({ now, timers: deps.timers, logger });
  const jobs = deps.jobs || createJobs({ hub, now });
  const trustProxy =
    deps.trustProxy ||
    createTrustProxy({
      read: () => readSetting("PANEL_TRUST_PROXY"),
      onInvalid: () => {
        const { getLang } = require("../utils/language");
        logger.warn(getLang("admin.trust_proxy_invalid"));
      },
    });
  const security = createSecurity({ trustProxy, getPublicUrl: () => readSetting("PANEL_PUBLIC_URL"), logger, now });
  const files = createStatic({ dir: deps.publicDir, logger });
  const uploads =
    deps.uploads ||
    createUploads({
      dir: path.join(dataDir, "admin-uploads"),
      now,
      timers: deps.timers,
      logger,
      maxBytes: () => (Number(readSetting("MAX_UPLOAD")) || 230) * 1024 * 1024,
    });

  const auditApi = deps.audit || optionalRequire("./audit") || NOOP_AUDIT;
  const recordAudit = async (entry) => {
    try {
      return await auditApi.record(entry);
    } catch {
      return null; // an audit failure never breaks the request (audit.record itself logs it)
    }
  };

  const baseDeps = { ...deps, hub, jobs, uploads, trustProxy, security, clock, logger, rootDir, dataDir };

  let auth = deps.auth;
  if (!auth) {
    const authModule = optionalRequire("./auth");
    if (authModule && typeof authModule.createAuth === "function") {
      auth = authModule.createAuth({ ...baseDeps, audit: auditApi });
    } else {
      auth = DENY_ALL_AUTH;
    }
  }
  const sse =
    deps.sse || createSse({ hub, auth, ring: deps.ring, now, timers: deps.timers, logger });
  const routeDeps = { ...baseDeps, auth, sse, audit: auditApi };

  const router = createRouter();
  const startHooks = [];
  const stopHooks = [];
  const registerArgs = {
    router,
    deps: routeDeps,
    hub,
    jobs,
    audit: auditApi,
    onStart: (fn) => startHooks.push(fn),
    onStop: (fn) => stopHooks.push(fn),
  };

  // The two routes of the shell itself: the redirect and the static files (public, GET only, db:r)
  router.route({
    method: "GET",
    path: "/admin",
    auth: "public",
    db: "optional",
    handler: (ctx) => {
      finish(ctx.res, { status: 308, headers: { Location: "/admin/" }, requestId: ctx.requestId });
    },
  });
  router.route({
    method: "GET",
    path: "/admin/*",
    auth: "public",
    db: "optional",
    handler: (ctx) => {
      const entry = files.lookup(ctx.pathname);
      if (!entry) throw new AdminError("not_found");
      files.serve(ctx.req, ctx.res, entry);
    },
  });

  registerAll({ ...registerArgs, dir: deps.routesDir });
  for (const extra of deps.extraRoutes || []) extra(registerArgs);

  const getMaintenance = () => deps.maintenanceMode || require("../utils/maintenanceMode");

  /** Gates of runtime.md section 15: booting, and a restore in progress. */
  function gate(route) {
    if (!route.db && deps.runtime && deps.runtime.dbReady !== true) return new AdminError("starting");
    if (route.mutates && getMaintenance().isActive()) return new AdminError("maintenance");
    return null;
  }

  const env = {
    auth,
    security,
    gate,
    hub,
    logger,
    now,
    audit: recordAudit,
    originKey: (req) => (typeof auth.originKey === "function" ? auth.originKey(req) : trustProxy.originKey(req)),
  };

  let started = false;
  let unsubscribers = [];

  /** Persist the group-guard bus events (anti-bot) as audit rows; the plugin itself never imports lib/admin. */
  function onGuardAction(payload) {
    if (!payload || typeof payload !== "object") return;
    const action =
      payload.outcome === "suspect" ? "guard.antibot.suspect" : payload.outcome === "removed" ? "guard.antibot.remove" : null;
    if (!action) return;
    recordAudit({
      action,
      target: payload.groupJid || null,
      origin: "system",
      result: "ok",
      detail: { jid: payload.userJid || null, rule: payload.rule || null },
    });
  }

  return {
    hub,
    jobs,
    uploads,
    sse,
    trustProxy,
    router,

    handle(req, res) {
      const { pathname } = splitUrl(req.url);
      if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return false;
      router.dispatch(req, res, env).catch((err) => {
        // dispatch never rejects; this is the last line of defence
        logger.error({ code: err && err.code }, "admin: dispatch failed");
        if (!res.headersSent) finish(res, { status: 500, body: { error: { code: "internal_error" } } });
      });
      return true;
    },

    routes: () => router.routes(),

    async start() {
      if (started) return;
      started = true;
      try {
        files.load();
      } catch (err) {
        logger.warn({ code: err && err.code }, "admin: static files could not be indexed");
      }

      const ring = deps.ring || require("./logs/ring");
      unsubscribers.push(ring.subscribe((entry) => hub.publish("log", entry)));
      const bus = deps.bus || require("../utils/events");
      bus.on("groupguard:action", onGuardAction);
      unsubscribers.push(() => bus.off("groupguard:action", onGuardAction));

      if (typeof auth.start === "function") {
        try {
          await auth.start();
        } catch (err) {
          logger.error({ name: err && err.name, code: err && err.code }, "admin: authentication could not start");
        }
      }
      for (const hook of startHooks) {
        try {
          await hook();
        } catch (err) {
          logger.error({ name: err && err.name, code: err && err.code }, "admin: a start hook failed");
        }
      }
    },

    async stop() {
      if (!started) {
        sse.closeAll();
        hub.stop();
        return;
      }
      started = false;
      for (const off of unsubscribers.splice(0)) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      for (const hook of [...stopHooks].reverse()) {
        try {
          await hook();
        } catch {
          // stopping never throws
        }
      }
      if (typeof auth.stop === "function") {
        try {
          await auth.stop();
        } catch {
          // ignore
        }
      }
      sse.closeAll();
      hub.stop();
      jobs.stop();
    },
  };
}

module.exports = { createAdmin };
