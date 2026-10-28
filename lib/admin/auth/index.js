"use strict";

/**
 * The `deps.auth` facade of the admin HTTP core (interface documented in lib/admin/http/router.js).
 * `createAdmin` calls `createAuth({ ...deps, hub, trustProxy, clock, logger, audit })`.
 *
 *   authenticate(ctx, route)   session route: the session snapshot (`id` and `csrf` included) or an AdminError
 *                              (unauthenticated | session_expired | db_unavailable); setup route: the validated
 *                              one-time token `{ kind, purpose, expiresAt, token }` or token_invalid / rate_limited.
 *                              Cheap on a cached session; NEVER extends the idle clock (the live streams call it).
 *                              On a touching route it also queues a refreshed cookie (at most once per 60 s).
 *   touch(session)             extends the idle clock (write-behind)
 *   originKey(req)             throttling key, trust-proxy aware
 *   start() / stop()           start: sweep and hourly sweep, limiter rehydration, the setup link when no account
 *                              exists (a NEW token at every boot), the `data/admin-reset` marker file.
 *   optionalSession(ctx)       the session of a public route (AUTH-1) or null; never throws
 *   peekSetup(req)             `{ purpose, expiresAt }` of a valid owb_setup cookie, or null; never throws
 *   accountExists()            true/false, null when the database cannot be read (a positive answer is cached)
 *   issueLink(kind, opts)      issue, register with the redactor and print a setup / reset link
 *   alerts.loginBlocked(...)   / alerts.newOrigin(...): alerts.raise through a guarded require (the W1 engine is optional)
 *   passwords, sessions, tokens, limits, cookies, audit, models()   the services, for lib/admin/routes/auth.js
 *
 * The setup link is printed with `printToConsole` (the ORIGINAL stdout write: it never enters the log ring),
 * through getLang("admin.setup_link"), and its token is registered as an ephemeral secret of the redactor so it
 * cannot reach a pino line.
 */

const fs = require("fs");
const path = require("path");
const { AdminError } = require("../http/response");
const { createPasswords } = require("./password");
const { createRateLimits } = require("./rateLimit");
const { createSessions, cookies } = require("./sessions");
const { createTokens, linkBase } = require("./tokens");

const RESET_MARKER = "admin-reset";

/** Require a module, tolerating only the absence of that exact module (a later batch delivers it). */
function guardedRequire(request) {
  try {
    return require(request);
  } catch (err) {
    const missing = err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes(`'${request}'`);
    if (!missing) throw err;
    return null;
  }
}

function createAuth(deps = {}) {
  const clock = deps.clock || { now: () => Date.now() };
  const now = () => clock.now();
  const trustProxy = deps.trustProxy;
  const hub = deps.hub || null;
  const dataDir = deps.dataDir || path.join(__dirname, "..", "..", "..", "data");

  let loggerInstance = deps.logger || null;
  const logger = () => {
    if (!loggerInstance) loggerInstance = require("../../utils/logger").createLogger("admin-auth");
    return loggerInstance;
  };
  const warn = (err, message) => {
    try {
      logger().warn({ name: err && err.name, code: err && err.code }, message);
    } catch {
      // logging never matters here
    }
  };

  const models = () => deps.models || require("../../database");
  const audit = deps.audit || null;
  const redactor = () => deps.redactor || require("../logs/redactor");
  const print = (line) => (deps.printToConsole || require("../../utils/logger").printToConsole)(line);

  /** A key of the injected config object, else of the real config module (never the environment). */
  function fromConfig(key) {
    const own = deps.config && deps.config[key];
    if (own !== undefined && own !== null) return own;
    try {
      const value = require("../../../config")[key];
      return value === undefined ? null : value;
    } catch {
      return null; // config.js cannot be loaded here
    }
  }

  /** A setting: the injected config object, then config.js, then the environment. */
  function readSetting(key) {
    const value = fromConfig(key);
    return value !== null && value !== undefined ? value : process.env[key];
  }

  /** BOT_LANG (the property of config.js is `LANG`); "fr" when unknown. */
  function botLang() {
    const value = fromConfig("LANG") || fromConfig("BOT_LANG") || process.env.BOT_LANG || "fr";
    return String(value).slice(0, 2).toLowerCase();
  }

  const passwords = createPasswords({ kdf: deps.kdf, scrypt: deps.scrypt });
  const limits = createRateLimits({ now });
  const sessions = createSessions({ models: deps.models, now, timers: deps.timers, hub, logger: deps.logger });
  const tokens = createTokens({ models: deps.models, now });

  let started = false;
  let accountKnown = false;

  // ---- links ---------------------------------------------------------------------------------

  function currentPort() {
    const port = typeof deps.port === "function" ? deps.port() : deps.port;
    return port || Number(readSetting("PANEL_PORT")) || 3000;
  }

  const baseUrl = () => linkBase({ publicUrl: readSetting("PANEL_PUBLIC_URL"), port: currentPort() });

  /** Issue a token of `kind`, register it with the redactor and print the link (never through pino). */
  async function issueLink(kind) {
    const issued = await tokens.issue(kind);
    const url = tokens.buildLink(baseUrl(), issued.token);
    try {
      redactor().registerEphemeral(`admin.token.${kind}`, issued.token, issued.ttlMs);
    } catch (err) {
      warn(err, "admin: a link token could not be registered with the redactor");
    }
    const { getLang } = require("../../utils/language");
    print(getLang(kind === "reset" ? "admin.reset_link" : "admin.setup_link", url, Math.round(issued.ttlMs / 60000)));
    return { ...issued, url };
  }

  // ---- account -------------------------------------------------------------------------------

  async function accountExists() {
    if (accountKnown) return true;
    try {
      const row = await models().AdminAccount.findByPk(1, { attributes: ["id"] });
      if (row) accountKnown = true;
      return Boolean(row);
    } catch {
      return null;
    }
  }

  // ---- alerts (optional engine) --------------------------------------------------------------

  function raiseAlert(type, payload) {
    try {
      const alerts = deps.alerts || guardedRequire("../../utils/alerts");
      if (!alerts || typeof alerts.raise !== "function") return;
      Promise.resolve(alerts.raise(type, { ...payload, at: new Date(now()).toISOString() }, { now: now() })).catch((err) =>
        warn(err, "admin: an alert could not be raised"),
      );
    } catch (err) {
      warn(err, "admin: an alert could not be raised");
    }
  }

  const alerts = {
    /** An origin was blocked after 5 failed logins. */
    loginBlocked: ({ origin, retryAfterMs }) => raiseAlert("login_blocked", { origin, retryAfterMs }),
    /** A successful login from an origin with no earlier login. */
    newOrigin: ({ origin }) => raiseAlert("new_origin", { origin }),
  };

  // ---- authentication ------------------------------------------------------------------------

  async function authenticateSession(ctx, route) {
    const value = cookies.readSessionCookie(ctx.req);
    if (!value) throw new AdminError("unauthenticated");
    const session = await sessions.resolve(value);
    // a touching route re-issues the cookie (new Max-Age), at most once per 60 s; the live streams have no response
    if (ctx.res && !ctx.res.headersSent && route && route.touch !== false && sessions.cookieDue(session.id)) {
      ctx.res.setHeader(
        "Set-Cookie",
        cookies.sessionCookie(value, { https: trustProxy.isHttps(ctx.req), maxAgeSec: sessions.cookieMaxAge(session) }),
      );
      sessions.markCookie(session.id);
    }
    return session;
  }

  async function authenticateSetup(ctx) {
    const at = now();
    const wrongToken = limits.token.check(ctx.origin, at);
    if (wrongToken.blocked) throw new AdminError("rate_limited", { params: { retryAfterMs: wrongToken.retryAfterMs } });
    const value = cookies.readSetupCookie(ctx.req);
    if (!value) throw new AdminError("token_invalid");
    const record = await tokens.validate(value);
    if (!record) {
      limits.token.fail(ctx.origin, at);
      throw new AdminError("token_invalid");
    }
    return { kind: record.kind, purpose: record.kind, expiresAt: record.expiresAt, token: value };
  }

  // ---- boot ----------------------------------------------------------------------------------

  async function rehydrateLimits() {
    if (deps.rehydrateLimits === false || !audit || typeof audit.recentFailures !== "function") return 0;
    const rows = await audit.recentFailures({ since: now() - limits.login.windowMs });
    return limits.login.rehydrate(rows, now());
  }

  /** The `data/admin-reset` marker file: an empty file that asks for a reset link at the next boot (FR-007). */
  async function handleResetMarker(exists) {
    const marker = path.join(dataDir, RESET_MARKER);
    if (!fs.existsSync(marker)) return;
    try {
      fs.unlinkSync(marker);
    } catch (err) {
      warn(err, "admin: the reset marker file could not be removed");
    }
    // no account yet: the setup link is the way in
    if (!exists) return;
    await issueLink("reset");
    if (audit) await audit.record({ action: "reset.issued", target: null, origin: "system", result: "ok", detail: { source: "marker" } });
  }

  return {
    passwords,
    sessions,
    tokens,
    limits,
    cookies,
    audit,
    alerts,
    models,
    readSetting,
    botLang,
    baseUrl,
    issueLink,
    accountExists,
    markAccountCreated() {
      accountKnown = true;
    },

    originKey: (req) => trustProxy.originKey(req),
    isHttps: (req) => trustProxy.isHttps(req),
    /** True when forwarded headers arrived from a peer that is not declared in PANEL_TRUST_PROXY. */
    proxyHint: (req) => trustProxy.proxyHint(req).length > 0,

    /** Queue and in-flight count of the password hashing gate. */
    hashQueue: () => passwords.queueStats(),

    authenticate(ctx, route) {
      return route && route.auth === "setup" ? authenticateSetup(ctx) : authenticateSession(ctx, route);
    },

    touch(session) {
      if (session && session.id !== undefined) sessions.touch(session.id);
    },

    /** The session of a request on a public route, or null (never throws). */
    async optionalSession(ctx) {
      try {
        return await authenticateSession({ req: ctx.req, res: ctx.res }, ctx.route);
      } catch {
        return null;
      }
    },

    /** `{ purpose, expiresAt }` of a valid owb_setup cookie, or null. Does not count as a wrong guess. */
    async peekSetup(req) {
      const value = cookies.readSetupCookie(req);
      if (!value) return null;
      try {
        const record = await tokens.validate(value);
        return record ? { purpose: record.kind, expiresAt: record.expiresAt } : null;
      } catch {
        return null;
      }
    },

    async start() {
      if (started) return;
      started = true;
      sessions.start();
      try {
        await sessions.sweep();
      } catch (err) {
        warn(err, "admin: the first session sweep failed");
      }
      try {
        await rehydrateLimits();
      } catch (err) {
        warn(err, "admin: the login limiter could not be rehydrated");
      }
      const exists = await accountExists();
      if (exists === false) await issueLink("setup");
      await handleResetMarker(exists === true);
    },

    async stop() {
      started = false;
      await sessions.stop();
    },
  };
}

module.exports = { createAuth, guardedRequire, RESET_MARKER };
