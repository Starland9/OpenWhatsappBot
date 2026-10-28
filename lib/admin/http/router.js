"use strict";

/**
 * Router of the admin HTTP layer (contracts/runtime.md section 15 "Router", admin-http-api.md sections 1.3,
 * 1.7 and 1.9). One registry, enumerable, deny by default: every route goes through `route({...})` and an
 * `auth` level is REQUIRED (registering without it throws, so a forgotten check cannot ship).
 *
 *   const router = createRouter();
 *   router.route({
 *     method: "PATCH", path: "/admin/api/groups/:jid", auth: "session",
 *     handler: async (ctx) => ({ ok: true }),
 *   });
 *
 * ROUTE OPTIONS
 *   method       GET | POST | PUT | PATCH | DELETE (HEAD is answered by the GET route, without a body)
 *   path         "/admin/api/groups/:jid". Exact segment match, no regex. `:param` is decoded ONCE (400 when the
 *                encoding is malformed) and checked against its pattern: a value that does not match is 404 (the
 *                route does not exist for that value). Default patterns: jid (group JID), id and runId (numeric),
 *                key (text key), lang (en|fr), userJid, name, kind, service, category (see PARAM_PATTERNS). A
 *                param name without a pattern needs `params: { name: /re/ }` on the route, else registration throws.
 *                A final `*` segment (public GET only: the static files) matches the rest of the path.
 *   auth         "session" | "public" | "setup"   REQUIRED, no default.
 *                  public   no credential (login, AUTH-1, static files): ctx.session is null
 *                  setup    a valid setup or reset token (cookie owb_setup): ctx.session is what deps.auth returns
 *                  session  a valid session cookie
 *   csrf         true (default for unsafe methods on `session` routes) | "origin" (default for unsafe `public` and
 *                `setup` routes: no session token exists yet, Origin / Sec-Fetch-Site / Content-Type are still
 *                checked) | false (GET only, enforced at registration). See security.js for the guard order.
 *   mutates      default `method !== "GET"`; a GET route declaring it throws (no GET mutates, SC-005)
 *   touch        default true; false for SSE and the 2 s polling routes: the session idle clock is not extended
 *   bodyLimit    bytes, at most 1 MiB, default 64 KiB. A route that declares neither `bodyLimit` nor `schema`
 *                accepts only an empty body or `{}` (any property: 422 validation_failed, fields.$unknown)
 *   schema       strict body schema of request.js#validate: ctx.body is then the FRESH validated object
 *   query        strict query schema, same helper: ctx.query is then the validated object
 *   upload       true: raw `application/octet-stream` body, not read by the router (the handler consumes ctx.req)
 *   sameOrigin   true: a safe-method route also checks Origin (when sent) and Sec-Fetch-Site (EVT-1, QR image)
 *   db           "optional" for the `db:r` routes of section 1.14 (they still answer while the database is down
 *                or the process is starting). Every other route answers 503 `starting` before the database is
 *                ready and 503 `db_unavailable` when a query fails.
 *   handler      async (ctx) => result
 *
 * ctx = { req, res, route, requestId, pathname, params, query, body, session, origin, now, audit, publish, signal }
 *   params   decoded path parameters (strings)
 *   body     the validated fresh object ({} when the request has no body); null on an `upload` route
 *   session  see `deps.auth` below; null on a public route
 *   origin   the throttling key of the client (trust-proxy aware, see trustProxy.js)
 *   now      request time in ms (the injected clock)
 *   audit    (action, target, result = "ok", detail) => Promise, the request origin is filled in
 *   publish  (topic, payload) => void, the hub of lib/admin/events.js
 *   signal   AbortSignal, aborted when the client goes away before the answer is complete
 *
 * HANDLER RESULT
 *   a plain object              200 JSON
 *   reply(status, body, hdrs)   explicit status (201, 202...), body (object | Buffer | string) and headers; the bare
 *                               shape `{ status: <number>, body, headers }` is accepted too
 *   nothing, after taking ctx.res over (SSE, QR image, download): the router leaves the response alone
 *   throw new AdminError(code, { fields, params })    the envelope of section 1.9; any Error whose string `code`
 *                               is one of those codes is mapped the same way; anything else is a 500
 *                               `internal_error` with the stack sent to the logger, never to the client
 *
 * THE `deps.auth` INTERFACE (implemented by lib/admin/auth/index.js, "F8"; tests use a stub)
 *
 *   authenticate(ctx, route) -> session | setupGrant       (sync or async)
 *       Called for every route whose `auth` is "session" or "setup", before anything else about the request is
 *       trusted. ctx has req, res, route, requestId, pathname, params, query, origin and now (body is not read
 *       yet, session is null). Never called for "public" routes: a public handler that wants the optional session
 *       (AUTH-1) calls deps.auth itself.
 *       auth "session": return the session object, or THROW an AdminError:
 *           unauthenticated   no session cookie
 *           session_expired   cookie presented but the session is unknown, idle-expired, absolute-expired or revoked
 *           db_unavailable    uncached session while the database is down (503, never 401)
 *       auth "setup": return the validated token record, or throw token_invalid (401). The router does not touch it.
 *       The session object MUST carry
 *           id    string   stable opaque id of the session (e.g. the SHA-256 of the cookie value): the live-stream
 *                          and upload quotas are per `session.id`; it is never sent to the client
 *           csrf  string   the CSRF token the SPA sends back as X-CSRF-Token (AdminSession.csrfSecret)
 *       and may carry anything else (lastSeenAt, origin, ...): handlers read it as ctx.session.
 *   touch(session) -> void
 *       Called once per request that passed authentication and the guard, on `session` routes whose `touch` is not
 *       false. Extends the idle clock (write-behind, at most one database write per minute is the implementation's
 *       business) and may queue a refreshed cookie. Must not throw for an ordinary reason.
 *   originKey(req) -> string                                     (optional)
 *       The throttling key of the client. When absent the router uses lib/admin/http/trustProxy.js.
 *
 * The live streams (sse.js) re-run `authenticate({ req, ... }, route)` at every heartbeat: a thrown
 * `session_expired` / `unauthenticated` closes the stream with the `session` event, so authenticate() must be
 * cheap on a cached session and must NOT extend the idle clock (touch is only called by the router). To close
 * the streams of a session at once (logout, password change, reset), publish on the hub:
 *     hub.publish("session", { sessionId: session.id, reason: "logout" | "revoked" | "expired" })
 */

const { AdminError, finish, sendError, isReply, newRequestId, toHttpError } = require("./response");
const { splitUrl, parseQuery, readJsonBody, validate } = require("./request");

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_LEVELS = new Set(["session", "public", "setup"]);
const MAX_BODY_LIMIT = 1024 * 1024;
const API_PREFIX = "/admin/api";

/** Parameter patterns of admin-http-api.md section 1.7 (a user JID is normalised later by the handler). */
const PARAM_PATTERNS = Object.freeze({
  jid: /^\d+(-\d+)?@g\.us$/,
  id: /^[1-9]\d{0,9}$/,
  runId: /^[1-9]\d{0,9}$/,
  key: /^[A-Za-z0-9_.-]{1,160}$/,
  lang: /^(en|fr)$/,
  userJid: /^\d{5,20}(?::\d{1,4})?(?:@(?:s\.whatsapp\.net|lid))?$/,
  name: /^[A-Za-z0-9_.-]{1,64}$/,
  kind: /^[A-Za-z0-9_.-]{1,64}$/,
  service: /^[A-Za-z0-9_.-]{1,64}$/,
  category: /^[A-Za-z0-9_.-]{1,64}$/,
});

function parsePath(path) {
  if (typeof path !== "string" || !path.startsWith("/admin")) {
    throw new Error(`admin route path must start with /admin: ${JSON.stringify(path)}`);
  }
  const rawSegments = path.slice(1).split("/");
  const segments = [];
  rawSegments.forEach((segment, index) => {
    if (segment === "*") {
      if (index !== rawSegments.length - 1) throw new Error(`wildcard must be the last segment: ${path}`);
      segments.push({ wildcard: true });
    } else if (segment.startsWith(":")) {
      if (!/^:[A-Za-z][A-Za-z0-9]*$/.test(segment)) throw new Error(`invalid route parameter in ${path}`);
      segments.push({ param: segment.slice(1) });
    } else if (segment === "" || /[:*%?#\s]/.test(segment)) {
      throw new Error(`invalid route path (empty or unsafe segment): ${path}`);
    } else {
      segments.push({ literal: segment });
    }
  });
  return segments;
}

/** Shape signature of a path ("/admin/api/groups/:" ...) to detect two routes that would be ambiguous. */
const shapeOf = (segments) =>
  segments.map((s) => (s.wildcard ? "*" : s.param ? ":" : s.literal)).join("/");

function createRouter() {
  /** @type {object[]} */
  const table = [];
  const shapes = new Set();

  function route(def) {
    const where = `${def && def.method} ${def && def.path}`;
    if (!def || typeof def !== "object") throw new Error("route(): an object is required");
    const method = String(def.method || "").toUpperCase();
    if (!METHODS.includes(method)) throw new Error(`route ${where}: unsupported method`);
    if (!AUTH_LEVELS.has(def.auth)) {
      throw new Error(`route ${where}: auth is required ("session", "public" or "setup"); deny by default`);
    }
    if (typeof def.handler !== "function") throw new Error(`route ${where}: handler must be a function`);

    const segments = parsePath(def.path);
    const wildcard = segments.some((s) => s.wildcard);
    if (wildcard && (method !== "GET" || def.auth !== "public")) {
      throw new Error(`route ${where}: a wildcard path is only for public GET routes (static files)`);
    }

    const unsafe = UNSAFE.has(method);
    let csrf = def.csrf;
    if (csrf === undefined) csrf = unsafe ? (def.auth === "session" ? true : "origin") : false;
    if (![true, false, "origin"].includes(csrf)) throw new Error(`route ${where}: csrf must be true, false or "origin"`);
    if (!unsafe && csrf !== false) throw new Error(`route ${where}: csrf applies to POST, PUT, PATCH and DELETE only`);
    if (unsafe && csrf === false) throw new Error(`route ${where}: csrf: false is only allowed on GET routes`);
    if (csrf === true && def.auth !== "session") {
      throw new Error(`route ${where}: a CSRF token needs a session; use csrf: "origin" on public and setup routes`);
    }

    const mutates = def.mutates === undefined ? method !== "GET" : Boolean(def.mutates);
    if (method === "GET" && mutates) throw new Error(`route ${where}: a GET route must not mutate anything`);

    let bodyLimit;
    if (def.bodyLimit !== undefined) {
      if (!Number.isInteger(def.bodyLimit) || def.bodyLimit < 0 || def.bodyLimit > MAX_BODY_LIMIT) {
        throw new Error(`route ${where}: bodyLimit must be an integer between 0 and 1 MiB`);
      }
      bodyLimit = def.bodyLimit;
    }
    if (def.upload && !["POST", "PUT"].includes(method)) throw new Error(`route ${where}: upload is for POST or PUT`);
    if (def.db !== undefined && def.db !== "optional") throw new Error(`route ${where}: db must be "optional" or absent`);

    const patterns = { ...PARAM_PATTERNS, ...(def.params || {}) };
    for (const segment of segments) {
      if (segment.param && !(patterns[segment.param] instanceof RegExp)) {
        throw new Error(`route ${where}: no pattern for :${segment.param} (declare params: { ${segment.param}: /re/ })`);
      }
    }

    const shape = `${method} ${shapeOf(segments)}`;
    if (shapes.has(shape)) throw new Error(`route ${where}: already registered`);
    shapes.add(shape);

    const entry = Object.freeze({
      method,
      path: def.path,
      segments,
      wildcard,
      literals: segments.filter((s) => s.literal).length,
      auth: def.auth,
      csrf,
      mutates,
      touch: def.touch === undefined ? true : Boolean(def.touch),
      bodyLimit,
      schema: def.schema || null,
      query: def.query || null,
      upload: Boolean(def.upload),
      sameOrigin: Boolean(def.sameOrigin),
      db: def.db || null,
      patterns,
      handler: def.handler,
    });
    table.push(entry);
    return entry;
  }

  /** The table for tests and for SC-005: [{ method, path, auth, csrf, mutates, touch, db }]. */
  function routes() {
    return table.map((r) => ({
      method: r.method,
      path: r.path,
      auth: r.auth,
      csrf: r.csrf,
      mutates: r.mutates,
      touch: r.touch,
      db: r.db,
    }));
  }

  function structural(r, parts) {
    const raw = {};
    for (let i = 0; i < r.segments.length; i += 1) {
      const segment = r.segments[i];
      if (segment.wildcard) return raw; // matches the rest, empty included
      if (i >= parts.length) return null;
      if (segment.literal !== undefined) {
        if (parts[i] !== segment.literal) return null;
      } else {
        if (parts[i] === "") return null;
        raw[segment.param] = parts[i];
      }
    }
    return parts.length === r.segments.length ? raw : null;
  }

  /**
   * @returns {{ kind: "route", route, rawParams: object }
   *          | { kind: "method", allow: string[] }
   *          | { kind: "none" }}
   */
  function match(method, pathname) {
    const parts = String(pathname).slice(1).split("/");
    const lookup = method === "HEAD" ? "GET" : method;
    const found = [];
    for (const r of table) {
      if (r.wildcard && (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`))) continue;
      const raw = structural(r, parts);
      if (raw) found.push({ route: r, rawParams: raw });
    }
    if (!found.length) return { kind: "none" };
    const usable = found.filter((f) => f.route.method === lookup);
    if (!usable.length) {
      const allow = [...new Set(found.map((f) => f.route.method))];
      if (allow.includes("GET")) allow.push("HEAD");
      return { kind: "method", allow };
    }
    usable.sort(
      (a, b) =>
        Number(a.route.wildcard) - Number(b.route.wildcard) || b.route.literals - a.route.literals,
    );
    return { kind: "route", ...usable[0] };
  }

  /** Decode and check the path parameters of a matched route. */
  function decodeParams(r, rawParams) {
    const params = {};
    for (const [name, value] of Object.entries(rawParams)) {
      let decoded;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        throw new AdminError("bad_request");
      }
      if (!r.patterns[name].test(decoded)) throw new AdminError("not_found");
      params[name] = decoded;
    }
    return params;
  }

  /**
   * Run one request through the pipeline: gates, authentication, guard, body, handler, answer.
   * Never throws; always ends the response (unless a handler took it over).
   */
  async function dispatch(req, res, env) {
    const started = Date.now();
    const requestId = newRequestId();
    res.setHeader("X-Request-Id", requestId);
    env.security.applyHeaders(res);

    let matched = null;
    let status = 0;
    try {
      const { pathname, search } = splitUrl(req.url);
      const method = String(req.method || "GET").toUpperCase();

      if (method === "OPTIONS") {
        const known = match("OPTIONS", pathname);
        throw new AdminError("method_not_allowed", { headers: known.kind === "method" ? { Allow: known.allow.join(", ") } : {} });
      }
      if (!METHODS.includes(method) && method !== "HEAD") {
        throw new AdminError("method_not_allowed", { headers: { Allow: "GET, HEAD, POST, PUT, PATCH, DELETE" } });
      }

      const found = match(method, pathname);
      if (found.kind === "none") throw new AdminError("not_found");
      if (found.kind === "method") throw new AdminError("method_not_allowed", { headers: { Allow: found.allow.join(", ") } });

      const r = found.route;
      matched = r;
      const params = decodeParams(r, found.rawParams);

      // Gates: the process is still starting / a restore is applying (the db:r routes stay open)
      const gate = env.gate ? env.gate(r, req) : null;
      if (gate) throw gate;

      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });

      const ctx = {
        req,
        res,
        route: r,
        requestId,
        pathname,
        params,
        query: parseQuery(search),
        body: {},
        session: null,
        origin: env.originKey(req),
        now: env.now(),
        audit: null,
        publish: (topic, payload) => env.hub && env.hub.publish(topic, payload),
        signal: abort.signal,
      };
      ctx.audit = (action, target = null, result = "ok", detail) =>
        env.audit({ action, target, origin: ctx.origin, result, detail });

      // 1. the auth level (401 comes first so the SPA can drop to the login view)
      if (r.auth !== "public") ctx.session = await env.auth.authenticate(ctx, r);

      // 2. the unsafe-request guard (Origin, Sec-Fetch-Site, CSRF token, Content-Type)
      env.security.guard({ req, route: r, session: ctx.session });

      // 3. query and body
      if (r.query) ctx.query = validate(ctx.query, r.query);
      if (r.upload) {
        ctx.body = null;
      } else if (UNSAFE.has(method)) {
        const raw = await readJsonBody(req, { limit: r.bodyLimit });
        if (r.schema) ctx.body = validate(raw, r.schema);
        else if (r.bodyLimit === undefined) ctx.body = validate(raw, {}); // only {} is accepted
        else ctx.body = raw;
      } else {
        req.resume(); // a body on a GET is ignored
      }

      // 4. a live route extends the session idle clock (touch:false routes never do)
      if (r.auth === "session" && r.touch) await env.auth.touch(ctx.session);

      // 5. the handler
      const result = await r.handler(ctx);
      if (res.headersSent || res.writableEnded) {
        status = res.statusCode;
        return;
      }
      if (isReply(result)) {
        status = result.status;
        finish(res, { status: result.status, body: result.body, headers: result.headers, requestId, head: method === "HEAD" });
      } else {
        status = 200;
        finish(res, { status: 200, body: result === undefined || result === null ? {} : result, requestId, head: method === "HEAD" });
      }
    } catch (err) {
      const http = toHttpError(err);
      status = http.status;
      if (http.code === "internal_error" || http.code === "db_unavailable" || http.code === "whatsapp_error") {
        logFailure(env, err, requestId, matched);
      }
      if (res.headersSent) {
        // nothing sensible can be written any more
        try {
          res.end();
        } catch {
          // ignore
        }
      } else {
        sendError(res, err, { requestId });
      }
    } finally {
      if (env.logger && env.logger.debug) {
        env.logger.debug(
          { method: req.method, route: matched ? matched.path : null, status, ms: Date.now() - started },
          "admin request",
        );
      }
    }
  }

  return { route, routes, match, dispatch };
}

/** Log an unexpected failure: reduced error plus a short stack, never the request. */
function logFailure(env, err, requestId, route) {
  if (!env.logger) return;
  let reduced;
  try {
    reduced = require("../../utils/http").safeLog(err);
  } catch {
    reduced = { message: String((err && err.message) || err).slice(0, 300) };
  }
  const stack = String((err && err.stack) || "").split("\n").slice(0, 8).join("\n");
  env.logger.error({ err: reduced, stack, requestId, route: route ? route.path : null }, "admin: request failed");
}

module.exports = { createRouter, PARAM_PATTERNS, METHODS };
