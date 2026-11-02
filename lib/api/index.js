"use strict";

/**
 * Composition root of the public messaging API (feature 004, contracts/runtime.md section 15.1 and 15.2).
 *
 *   const api = createApi(deps);
 *   api.handle(req, res)     -> boolean   false unless the path matches /^\/api\/v[0-9]+(\/|$)/ (`/api/info` and
 *                                         `POST /api/restart` are never claimed). Then, in this order: the database
 *                                         not ready gives a claim and `503 unavailable` + `Retry-After: 5` (the switch
 *                                         is unknown during that window, so the answer cannot depend on it); a switch
 *                                         that is off or a registry that failed returns FALSE, so the legacy handler
 *                                         answers exactly as for any unknown URL (no oracle, RT-130); a restore running
 *                                         gives `503 unavailable`; otherwise the pipeline runs and the call returns true.
 *   api.start()              -> Promise   logs `api.registry_failed` at error level when the registry failed
 *   api.stop()               -> Promise   aborts in-flight requests (uploads, fetches, waits) and waits for their cleanup
 *   api.state()              -> { loaded, failure: null | { code: "registry_failed", endpoint, reason }, version: "v1" }
 *   api.routes() / rights() / catalog() / openapi({ baseUrl })     the enumerations of the panel, the tests and the docs
 *   api.keys / api.ipRules / api.limits                             the key store, the IP grammar, the quotas
 *
 * `createApi` does no network, no database and no timer: it requires the endpoint and format modules and builds the
 * registry. A registry failure (an endpoint without a right, a broken format) is caught: `state().failure` is set,
 * `handle()` returns false, `catalog()` is empty, and the bot and the panel keep running (FR-090, US7.2). Without a
 * panel there is no `createApi` call (FR-007).
 *
 * DEPS (all optional; everything is resolved lazily with `deps.x || require(...)`, so a test injects fakes):
 *   config, models, runtime ({ dbReady }), messaging, formats, apiState, alerts, audit ({ record }), trustProxy,
 *   maintenanceMode, settingsCache, clock ({ now }), logger, endpointsDir, createLimiter, quotas, idempotency,
 *   multipart, upload, cooldown.
 */

const path = require("path");
const { createLogger } = require("../utils/logger");
const { splitUrl } = require("../admin/http/request");
const { finish, errorBody, newRequestId } = require("../admin/http/response");
const { createTrustProxy } = require("../admin/http/trustProxy");
const { loadEndpoints, rightsOf } = require("./registry");
const { createKeyStore } = require("./keyStore");
const { createTransport } = require("./transport");
const { dispatch } = require("./pipeline");
const { BODY_LIMIT_DEFAULT } = require("./registry");
const ipRules = require("./ipRules");
const { API_VERSION, PATH_VERSION, BASE_PATH } = require("./version");
const { LIMITS } = require("../messaging/limits");

const API_PATH = /^\/api\/v[0-9]+(\/|$)/;
const ORIGIN_LIMIT = Object.freeze({ limit: 10, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000, maxEntries: 10000 });
const STOP_GRACE_MS = 5000;
const NOOP_AUDIT = Object.freeze({ record: async () => null });

/** Require a sibling module, tolerating only the absence of that exact module (a later wave delivers it) */
function optionalRequire(request) {
  try {
    return require(request);
  } catch (err) {
    const missing = err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes(`'${request}'`);
    if (!missing) throw err;
    return null;
  }
}

function createApi(deps = {}) {
  const logger = deps.logger || createLogger("api");
  const clock = deps.clock || { now: () => Date.now() };
  const now = () => clock.now();
  const getConfig = () => deps.config || require("../../config");
  const getApiState = () => deps.apiState || require("../utils/apiState");
  const getMessaging = () => deps.messaging || require("../messaging");
  const getAlerts = () => deps.alerts || require("../utils/alerts");
  const getMaintenance = () => deps.maintenanceMode || require("../utils/maintenanceMode");
  const audit = deps.audit && typeof deps.audit.record === "function" ? deps.audit : NOOP_AUDIT;
  const trust =
    deps.trustProxy ||
    createTrustProxy({
      read: () => {
        const config = getConfig();
        return config.PANEL_TRUST_PROXY !== undefined ? config.PANEL_TRUST_PROXY : process.env.PANEL_TRUST_PROXY;
      },
    });

  // ---- the registry: endpoints and formats -----------------------------------------------------------------------
  const state = { loaded: false, failure: null, version: PATH_VERSION };
  let failureName = null;
  let registry = null;
  let formats = null;
  const info = new Map(); // endpoint -> { declared: Set<right>, variants: string[] | null }

  try {
    formats = deps.formats || optionalRequire("../messaging/formats");
    if (formats && typeof formats.load === "function") formats.load();
    registry = loadEndpoints({ dir: deps.endpointsDir || path.join(__dirname, "endpoints"), formats });
    for (const endpoint of registry.endpoints) {
      let variants = null;
      if (endpoint.body && endpoint.body.variants) {
        const schemas = endpoint.body.variants.schemas;
        variants = Object.keys(typeof schemas === "function" ? schemas({ formats }) : schemas);
      }
      info.set(endpoint, { declared: new Set(rightsOf(endpoint, { formats })), variants });
    }
    state.loaded = true;
  } catch (err) {
    registry = null;
    const named = err && typeof err.endpoint === "string";
    failureName = named ? err.endpoint : (err && err.file) || null;
    const reason = err && err.reason ? (named ? err.reason : `${err.file ? `${err.file}: ` : ""}${err.reason}`) : `unexpected ${(err && err.name) || "error"}`;
    state.failure = { code: "registry_failed", endpoint: named ? err.endpoint : null, reason };
  }

  // ---- collaborators ---------------------------------------------------------------------------------------------
  const originLimiter = (deps.createLimiter || require("../admin/auth/rateLimit").createLimiter)({ ...ORIGIN_LIMIT, now });
  const keys = deps.keyStore || createKeyStore({ models: deps.models, settingsCache: deps.settingsCache, now, alerts: deps.alerts, logger });
  const transport = createTransport({ trust, apiState: { plainHttpFrom: () => getApiState().plainHttpFrom() } });

  let quotas = deps.quotas || null;
  const getQuotas = () => {
    if (!quotas) {
      const { createQuotas } = require("./limits");
      quotas = createQuotas({ now, config: deps.config, models: deps.models });
    }
    return quotas;
  };
  const inflight = new Set();

  const env = {
    now,
    logger,
    config: getConfig,
    runtime: deps.runtime,
    maintenance: getMaintenance,
    trust,
    transport,
    router: registry ? registry.router : null,
    keys,
    originLimiter,
    cooldown: deps.cooldown || require("../utils/cooldown"),
    quotas: getQuotas,
    idempotency: deps.idempotency || require("./idempotency"),
    multipart: () => deps.multipart || require("./multipart"),
    upload: () => deps.upload || require("./upload"),
    messaging: getMessaging,
    formats,
    alerts: getAlerts,
    audit,
    tmpDir: path.join(deps.dataDir || path.join(__dirname, "..", "..", "data"), "tmp", "api"),
    endpointInfo: (endpoint) => info.get(endpoint),
    inflight,
  };

  // ---- views for the panel, the tests and the docs ---------------------------------------------------------------
  const bodyOf = (endpoint) => {
    const kinds = (endpoint.body && endpoint.body.kinds) || ["none"];
    return { kinds: [...kinds], limitBytes: kinds.includes("none") ? 0 : (endpoint.body && endpoint.body.limit) || BODY_LIMIT_DEFAULT };
  };

  function routes() {
    if (!registry) return [];
    return registry.endpoints.map((endpoint) => ({
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      rights: [...info.get(endpoint).declared],
      dynamic: typeof endpoint.rights === "function",
      body: bodyOf(endpoint),
      idempotent: endpoint.idempotent === true,
    }));
  }

  const rights = () => (registry ? registry.rights.map((row) => ({ ...row })) : []);

  function catalog() {
    if (!registry) return { version: PATH_VERSION, basePath: BASE_PATH, rights: [], formats: [], endpoints: [] };
    return {
      version: PATH_VERSION,
      basePath: BASE_PATH,
      rights: rights(),
      formats: formats ? formats.list().map((row) => formats.describe(row.name)) : [],
      endpoints: routes().map((route) => {
        const endpoint = registry.byRoute.get(`${route.method} ${route.path}`);
        return {
          id: route.id,
          method: route.method,
          path: route.path,
          rights: route.rights,
          dynamic: route.dynamic,
          idempotent: route.idempotent,
          summary: endpoint.doc.summary,
          body: route.body,
        };
      }),
    };
  }

  let openapiBuilder = null;
  function openapi({ baseUrl } = {}) {
    if (!openapiBuilder) {
      const { createOpenApi } = require("./openapi");
      const { API_STATUS } = require("./errors");
      openapiBuilder = createOpenApi({ endpoints: registry ? registry.endpoints : [], formats, errors: { API_STATUS } });
    }
    return openapiBuilder.document(baseUrl ? `${String(baseUrl).replace(/\/+$/, "")}${BASE_PATH}` : BASE_PATH);
  }

  function unavailable(req, res) {
    const requestId = newRequestId();
    const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"]) > 0;
    finish(res, {
      status: 503,
      body: errorBody({ code: "unavailable", params: { retryAfterMs: 5000 } }, requestId),
      headers: { "Retry-After": "5", ...(hasBody ? { Connection: "close" } : {}) },
      requestId,
      profile: "api",
    });
  }

  return {
    handle(req, res) {
      const { pathname } = splitUrl(req.url);
      if (!API_PATH.test(pathname)) return false;
      if (deps.runtime && deps.runtime.dbReady !== true) {
        unavailable(req, res);
        return true;
      }
      if (state.failure || !registry || !getApiState().isEnabled()) return false;
      if (getMaintenance().isActive()) {
        unavailable(req, res);
        return true;
      }
      dispatch(req, res, env).catch((err) => {
        // dispatch never rejects; this is the last line of defence
        logger.error({ name: err && err.name }, "api: dispatch failed");
        if (!res.headersSent) unavailable(req, res);
      });
      return true;
    },

    async start() {
      if (!state.failure) return;
      const { getLang } = require("../utils/language");
      logger.error(getLang("api.registry_failed", failureName || "formats"));
    },

    async stop() {
      const running = [...inflight];
      for (const entry of running) entry.controller.abort();
      if (!running.length) return;
      let timer;
      const grace = new Promise((resolve) => {
        timer = setTimeout(resolve, STOP_GRACE_MS);
        if (timer.unref) timer.unref();
      });
      await Promise.race([Promise.allSettled(running.map((entry) => entry.task)), grace]);
      clearTimeout(timer);
    },

    state: () => ({ loaded: state.loaded, failure: state.failure ? { ...state.failure } : null, version: state.version }),
    routes,
    rights,
    catalog,
    openapi,
    keys,
    ipRules,
    get limits() {
      return getQuotas();
    },
    version: API_VERSION,
  };
}

module.exports = { createApi, API_PATH };
