"use strict";

/**
 * Request pipeline of the public messaging API (feature 004, contracts/public-api.md section 5, runtime.md 15.6).
 *
 *   dispatch(req, res, env)   never throws, always ends the response. Sets `X-Request-Id` and the `api` header profile
 *                             first, then runs the ordered steps below; the first failing step answers.
 *
 *   1 gate (database not ready, restore running)      503 unavailable            11 static right            403 forbidden
 *   2 verb                                            405 method_not_allowed     12 content type, body peek 415 / 413 / 400
 *   3 transport (HTTPS, local, plainHttpFrom)         403 https_required         12b dynamic rights         422 / 403
 *   4 browser call (Origin, Sec-Fetch-Site)           403 browser_not_allowed    13 recipient parse, policy, own number
 *   5 key in the URL                                  400 key_in_url             14 chat disabled           409
 *   6 origin block                                    429 origin_blocked         15 idempotency lookup      202 replay / 409
 *   7 authenticate                                    401 unauthenticated *      16 quota check             503 / 429
 *   8 key state (revoked, expired)                    401 key_revoked / expired *  17 validation            422
 *   9 IP allowlist                                    403 ip_not_allowed *       18 media (upload or URL)   413 / 422 / 502
 *  10 route match (after authentication)              404 / 405 + Allow          19 idempotency compare, quota reserve
 *                                                                                20 endpoint.handle(ctx)
 *   * only steps 7-9 count toward blocking the origin (10 failures in 5 minutes block it for 15 minutes); every other
 *     refusal never does, so a mis-configured but valid key cannot lock its own network out. `success()` is never called.
 *
 * The order IS the contract (FR-032): key (7-9), right (11, 12b), recipient policy (13), disabled chat (14), quotas
 * (16), content (17-18); a replay (15) precedes the quota; the early quota check refuses a rate-limited client before it
 * uploads 200 MB and the reserve (19) keeps the limits exact under concurrency. Everything before step 10 happens
 * whatever the path: an unauthenticated caller cannot enumerate routes.
 *
 * The engine, the quotas, the idempotency helpers, the multipart reader and the uploader are reached through `env`
 * (lazy getters resolved by lib/api/index.js), so a test injects fakes. The pipeline never reads `Cookie`, never calls
 * the panel's authentication and never sets `Set-Cookie`. Logs: authentication failures at `info`, deduplicated per
 * origin (`cooldown.hit(origin, "apiauth", 60000)`); a request summary at `debug` with `{ requestId, endpoint, status,
 * ms, keyId, keyName }`. Never `req.url`, `req.headers` or `req.body`, never a token, a lookup id, a text or a file name.
 */

const fs = require("fs");
const { ApiError, toApiHttpError } = require("./errors");
const { LIMITS } = require("../messaging/limits");
const { MessagingError } = require("../messaging/errors");
const schema = require("../utils/schema");
const { finish, errorBody, newRequestId, isReply } = require("../admin/http/response");
const { splitUrl, parseQuery, readJsonBody, parseJsonObject } = require("../admin/http/request");
const { mediaType, applySecurityHeaders } = require("../admin/http/security");

const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const QUERY_KEY_NAMES = new Set(["api_key", "apikey", "key", "token", "access_token", "authorization"]);
const KEY_SHAPE = /owbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const BEARER = /^Bearer ([^\s]+)$/i;
const DEFAULT_BODY_LIMIT = 64 * 1024;
const MESSAGE_PART_SLACK = 16 * 1024;
const RETRY_UNAVAILABLE_MS = 5000;
const AUTH_LOG_COOLDOWN_MS = 60 * 1000;

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Does the request announce a body (so a refusal must not keep the connection alive over unread bytes)? */
function declaresBody(req) {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  return Number(req.headers["content-length"]) > 0;
}

/** Decoded text, or the raw text when it does not decode */
function decoded(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, " "));
  } catch {
    return String(text);
  }
}

/** Step 5: a query parameter named like a credential, or any key-shaped text in the path or the query */
function keyInUrl(url) {
  const target = String(url || "");
  if (KEY_SHAPE.test(target) || KEY_SHAPE.test(decoded(target))) return true;
  const { search } = splitUrl(target);
  if (!search) return false;
  for (const pair of search.split("&")) {
    const name = decoded(pair.split("=")[0]).toLowerCase().replace(/\[\]$/, "");
    if (QUERY_KEY_NAMES.has(name)) return true;
  }
  return false;
}

/** The single Bearer token of the request, or null (missing, duplicated or another scheme) */
function bearerToken(req) {
  const distinct = req.headersDistinct && req.headersDistinct.authorization;
  const values = Array.isArray(distinct) ? distinct : req.headers.authorization === undefined ? [] : [req.headers.authorization];
  if (values.length !== 1) return null;
  const match = BEARER.exec(values[0]);
  return match ? match[1] : null;
}

/** `application/json[; charset=utf-8]` or `multipart/form-data; boundary=...` against what the endpoint accepts */
function contentKind(req, kinds) {
  const header = String(req.headers["content-type"] || "");
  const type = mediaType(header);
  const params = header.split(";").slice(1).map((part) => part.trim());
  if (type === "application/json" && kinds.includes("json")) {
    const charset = params.find((part) => /^charset=/i.test(part));
    if (charset && !/^charset="?utf-?8"?$/i.test(charset)) return null;
    return { kind: "json" };
  }
  if (type === "multipart/form-data" && kinds.includes("multipart")) return { kind: "multipart", header };
  return null;
}

/** Query values arrive as strings: an int is decimal digits (else invalid_format), a boolean is true or false */
function coerceQuery(query, rules) {
  const out = {};
  const fields = {};
  for (const [name, value] of Object.entries(query)) {
    const rule = rules && Object.hasOwn(rules, name) ? rules[name] : null;
    if (!rule) {
      out[name] = value;
    } else if (rule.type === "int") {
      if (/^[0-9]{1,15}$/.test(value)) out[name] = Number(value);
      else fields[name] = { code: "invalid_format" };
    } else if (rule.type === "boolean") {
      if (value === "true" || value === "false") out[name] = value === "true";
      else fields[name] = { code: "invalid_format" };
    } else {
      out[name] = value;
    }
  }
  return { query: out, fields };
}

/** The same facade with a `submit` that compares the fingerprint of a replay found by a lost race (step 19) */
function guardMessaging(messaging, state) {
  const wrapped = {};
  const names = new Set(Reflect.ownKeys(messaging));
  const proto = Object.getPrototypeOf(messaging);
  if (proto && proto !== Object.prototype) for (const name of Reflect.ownKeys(proto)) names.add(name);
  for (const name of names) {
    if (name === "constructor") continue;
    const value = messaging[name];
    wrapped[name] = typeof value === "function" ? value.bind(messaging) : value;
  }
  wrapped.submit = async (request) => {
    // The engine re-runs the policy and the admission under its own lock: hand it the key's policy and limits unless
    // the handler already set them (ctx never carries them, RT-133), so a key's own pending limit applies there too.
    const key = state.key;
    const full = key
      ? { ...request, policy: request.policy || key.policy, limits: request.limits || { maxPending: key.limits.maxPending ?? null } }
      : request;
    const result = await messaging.submit(full);
    if (result && result.replayed) {
      state.replayed = true;
      const expected = state.idempotency && state.idempotency.requestHash;
      if (expected && result.requestHash !== expected) throw new ApiError("idempotency_conflict");
    }
    return result;
  };
  return Object.freeze(wrapped);
}

async function dispatch(req, res, env) {
  const requestId = newRequestId();
  const startedAt = env.now();
  const controller = new AbortController();
  const state = {
    req,
    requestId,
    controller,
    bodyDone: false,
    endpoint: null,
    key: null,
    reservation: null,
    committed: false,
    file: null,
    replayed: false,
    idempotency: null,
  };
  res.setHeader("X-Request-Id", requestId);
  applySecurityHeaders(res, { profile: "api" });
  res.once("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  res.once("finish", () => {
    env.logger.debug(
      {
        requestId,
        endpoint: state.endpoint ? state.endpoint.id : null,
        status: res.statusCode,
        ms: env.now() - startedAt,
        keyId: state.key ? state.key.id : null,
        keyName: state.key ? state.key.name : null,
      },
      "api request",
    );
  });

  const task = (async () => {
    let outcome;
    try {
      outcome = { ok: true, answer: answerOf(await run(req, res, env, state, startedAt)) };
      if (outcome.answer.status < 400 && !state.replayed) state.committed = true;
    } catch (err) {
      outcome = { ok: false, err };
    }
    // the reservation is released and the temp file deleted BEFORE the answer leaves, so the client never sees a
    // success or a refusal while a file or a reserved slot is still pending
    await cleanup(state);
    if (outcome.ok) sendReply(res, env, state, outcome.answer);
    else sendError(res, env, state, outcome.err);
  })();
  if (env.inflight) {
    const entry = { controller, task };
    env.inflight.add(entry);
    task.then(() => env.inflight.delete(entry));
  }
  return task;
}

function rateLimitHeaders(env, state) {
  if (!state.key || !state.endpoint || !state.endpoint.quota) return {};
  try {
    const snap = env.quotas().snapshot(state.key);
    return { "RateLimit-Limit": String(snap.limit), "RateLimit-Remaining": String(snap.remaining), "RateLimit-Reset": String(snap.resetSeconds) };
  } catch {
    return {};
  }
}

function baseHeaders(req, env, state, headers) {
  const out = { ...rateLimitHeaders(env, state), ...(headers || {}) };
  if (!state.bodyDone && declaresBody(req)) out.Connection = "close";
  return out;
}

/** What a handler returned, as { status, body, headers } */
function answerOf(result) {
  if (isReply(result)) return { status: result.status, body: result.body, headers: result.headers || {} };
  if (isPlain(result)) return { status: 200, body: result, headers: {} };
  return { status: 204, body: undefined, headers: {} };
}

function sendReply(res, env, state, answer) {
  finish(res, { status: answer.status, body: answer.body, headers: baseHeaders(state.req, env, state, answer.headers), requestId: state.requestId, profile: "api" });
}

function sendError(res, env, state, err) {
  const http = toApiHttpError(err);
  if (!http.typed) {
    env.logger.error(
      { requestId: state.requestId, endpoint: state.endpoint ? state.endpoint.id : null, name: (err && err.name) || "Error", code: err && typeof err.code === "string" ? err.code : undefined },
      "api: request failed",
    );
  }
  finish(res, {
    status: http.status,
    body: errorBody(http, state.requestId),
    headers: baseHeaders(state.req, env, state, http.headers),
    requestId: state.requestId,
    profile: "api",
  });
}

async function cleanup(state) {
  if (state.reservation && (!state.committed || state.replayed)) {
    try {
      state.reservation.release();
    } catch {
      // a release never throws into the response
    }
  }
  state.reservation = null;
  if (state.file && state.file.path) {
    // a successful submit moved the file; whatever is still there is ours to delete
    await fs.promises.rm(state.file.path, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------------
async function run(req, res, env, state, startedAt) {
  const config = env.config();

  // 1. gate (index.handle answered the common case; kept as the second line)
  if ((env.runtime && env.runtime.dbReady !== true) || env.maintenance().isActive()) {
    throw new ApiError("unavailable", { params: { retryAfterMs: RETRY_UNAVAILABLE_MS } });
  }

  // 2. verb: OPTIONS and HEAD are refused, with no Allow and no CORS header
  if (!API_METHODS.has(req.method)) throw new ApiError("method_not_allowed");

  // 3. transport
  if (!env.transport.transportAllowed(req)) throw new ApiError("https_required");

  // 4. no browser calls
  if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) throw new ApiError("browser_not_allowed");

  // 5. a key in the URL is refused without being parsed, hashed or logged
  if (keyInUrl(req.url)) throw new ApiError("key_in_url");

  // 6. origin block (a valid key is refused too; a blocked origin is not extended)
  const origin = env.trust.originKey(req);
  const blocked = env.originLimiter.check(origin);
  if (blocked.blocked) throw new ApiError("origin_blocked", { params: { retryAfterMs: blocked.retryAfterMs } });

  // 7-9. authenticate: the only steps that count toward the block
  const refuse = (code) => {
    const outcome = env.originLimiter.fail(origin);
    if (outcome.newlyBlocked) originBlocked(env, origin, outcome.retryAfterMs);
    if (env.cooldown.hit(origin, "apiauth", AUTH_LOG_COOLDOWN_MS) === 0) {
      env.logger.info({ requestId: state.requestId, code, origin }, "api: authentication refused");
    }
    throw new ApiError(code);
  };
  const token = bearerToken(req);
  if (token === null) refuse("unauthenticated");
  const found = await env.keys.lookup(token);
  if (found.status === "unavailable") throw new ApiError("unavailable", { params: { retryAfterMs: RETRY_UNAVAILABLE_MS } });
  if (found.status !== "ok") refuse("unauthenticated");
  const key = found.key;
  if (key.revokedAtMs) refuse("key_revoked");
  if (key.expiresAtMs && key.expiresAtMs <= env.now()) refuse("key_expired");
  const clientAddress = env.trust.clientAddress(req);
  if (!key.ipAllow.check(clientAddress)) refuse("ip_not_allowed");
  state.key = key;
  env.keys.touch(key, { ip: String(clientAddress).toLowerCase(), origin, at: env.now() });

  // 10. route match, only now
  const { pathname, search } = splitUrl(req.url);
  const match = env.router.match(req.method, pathname);
  if (!match) throw new ApiError("not_found");
  if (match.allow) throw new ApiError("method_not_allowed", { headers: { Allow: match.allow.join(", ") } });
  const { endpoint, params } = match;
  state.endpoint = endpoint;
  deprecationHeaders(res, endpoint);
  const info = env.endpointInfo(endpoint);

  // 11. static right, before any byte of a body is read
  if (endpoint.right !== undefined && !key.rights.has(endpoint.right)) {
    throw new ApiError("forbidden", { params: { right: endpoint.right } });
  }

  // 12. content type and body peek
  const body = endpoint.body || { kinds: ["none"] };
  const kinds = body.kinds || ["none"];
  let peek = null;
  let multipart = null;
  if (!kinds.includes("none")) {
    const content = contentKind(req, kinds);
    if (!content) throw new ApiError("unsupported_media_type");
    const limit = body.limit || DEFAULT_BODY_LIMIT;
    if (content.kind === "json") {
      peek = await readJsonBody(req, { limit });
      state.bodyDone = true;
    } else {
      const fileBound = Math.min((Number(config.MAX_UPLOAD) || 230) * LIMITS.MB, Math.max(...Object.values(LIMITS.MEDIA_MAX)));
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limit + fileBound + MESSAGE_PART_SLACK) {
        throw new ApiError("media_too_large", { params: { maxBytes: fileBound } });
      }
      multipart = await env.multipart().readMessagePart(req, { limit, header: content.header });
      peek = parseJsonObject(multipart.raw);
    }
  }

  // 12b. dynamic rights: a valid discriminator first, then every right the body needs
  if (body.variants) {
    const by = body.variants.by;
    const value = peek[by];
    if (value === undefined || value === null) throw invalid(by, "required");
    if (typeof value !== "string") throw invalid(by, "invalid_type");
    if (!info.variants.includes(value)) throw invalid(by, "not_allowed", { allowed: info.variants.slice() });
  }
  if (typeof endpoint.requires === "function") {
    const needed = endpoint.requires(peek, { formats: env.formats });
    for (const right of needed) {
      if (!info.declared.has(right)) throw new Error("requires() returned a right outside rights()"); // a programming error, never a grant
    }
    for (const right of needed) {
      if (!key.rights.has(right)) throw new ApiError("forbidden", { params: { right } });
    }
  }

  // the file rules of the format, known now that the discriminator is valid: a declared length beyond message + cap is refused
  const fileRules = body.file ? { accept: body.file.accept(peek, { formats: env.formats }), maxBytes: body.file.maxBytes(peek, { formats: env.formats }) } : null;
  if (multipart && fileRules && fileRules.accept) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > multipart.raw.length + fileRules.maxBytes + MESSAGE_PART_SLACK) {
      throw new ApiError("media_too_large", { params: { maxBytes: fileRules.maxBytes } });
    }
  }

  // 13, 14. recipient: parse, policy, own number, disabled chat (one call, FR-032 order)
  let target = null;
  if (typeof endpoint.recipient === "function") {
    const to = endpoint.recipient(peek);
    if (to === undefined || to === null) throw invalid("to", "required");
    if (typeof to !== "string") throw invalid("to", "invalid_type");
    target = await env.messaging().resolveRecipient(to, { policy: key.policy });
  }

  // 15. idempotency: a known key can only replay or conflict
  let idempotencyKey = null;
  let headerFault = null;
  let known = null;
  if (endpoint.idempotent) {
    const raw = req.headers["idempotency-key"];
    if (raw !== undefined) {
      if (IDEMPOTENCY_KEY.test(raw)) idempotencyKey = raw;
      else headerFault = { code: "invalid_format" };
    }
  }
  const fingerprint = (extra) =>
    env.idempotency.fingerprint({ secretHashHex: key.secretHash, endpointId: endpoint.id, rawBody: peek, fileSha256: extra });
  if (idempotencyKey !== null) {
    known = await env.idempotency.lookup({ messaging: env.messaging(), apiKeyId: key.id, key: idempotencyKey, now: env.now() });
    if (known && !multipart) {
      const requestHash = fingerprint(null);
      env.idempotency.compare(known, requestHash);
      state.idempotency = { key: idempotencyKey, requestHash, replay: known.message };
    } else {
      state.idempotency = { key: idempotencyKey, requestHash: multipart ? null : fingerprint(null), replay: null };
    }
  }
  const replay = state.idempotency && state.idempotency.replay ? state.idempotency.replay : null;

  let validated = null;
  let query = {};
  if (!replay) {
    // 16. quota check (skipped for a known key)
    if (endpoint.quota && !known) {
      const maxPending = key.limits.maxPending ?? Number(config.API_MAX_PENDING);
      await env.messaging().checkAdmission({ apiKeyId: key.id, maxPending });
      await env.quotas().check(key);
    }

    // 17. strict validation of query and body together; nothing else of a known multipart key
    if (!known) {
      const checkedQuery = coerceQuery(parseQuery(search), endpoint.query);
      const faults = { ...checkedQuery.fields };
      const queried = schema.check({ ...checkedQuery.query }, endpoint.query || {});
      Object.assign(faults, queried.fields);
      query = queried.value;
      if (headerFault) faults["idempotency-key"] = headerFault;
      if (!kinds.includes("none")) {
        if (body.variants) {
          try {
            validated = await env.messaging().validateInput(peek[body.variants.by], peek, { target, apiKeyId: key.id });
          } catch (err) {
            if (err instanceof MessagingError && err.code === "validation_failed") Object.assign(faults, err.fields || {});
            else throw err;
          }
        } else {
          const checked = schema.check(peek, body.schema);
          Object.assign(faults, checked.fields);
          validated = checked.value;
          if (typeof body.refine === "function" && !Object.keys(checked.fields).length) {
            Object.assign(faults, body.refine(validated, { target }) || {});
          }
        }
      }
      if (Object.keys(faults).length) throw new ApiError("validation_failed", { fields: faults });
    }

    // 18. media: exactly one source (an uploaded file or media.url)
    if (body.file) {
      const format = body.variants ? peek[body.variants.by] : null;
      const accept = fileRules.accept;
      const filePart = multipart ? await multipart.next() : null;
      const url = !known && validated && validated.mediaMarker === true;
      if (!accept) {
        if (filePart) throw fieldFault("file", "not_allowed");
      } else if (known) {
        if (filePart) state.file = await env.upload().receive(filePart, uploadOptions(env, req, state, key, fileRules.maxBytes, null));
      } else {
        if (!filePart && !url) throw fieldFault("media", "required");
        if (filePart && url) throw fieldFault("media", "not_allowed");
        if (filePart) {
          state.file = await env.upload().receive(filePart, uploadOptions(env, req, state, key, fileRules.maxBytes, accept.kinds));
        } else {
          state.file = await env.messaging().fetchMedia(format, peek.media.url, { signal: controllerSignal(state) });
        }
        await env.messaging().inspectMedia(format, state.file, { name: state.file.name });
      }
      if (multipart) state.bodyDone = true;
    } else if (multipart) {
      await multipart.next();
      state.bodyDone = true;
    }

    // 19. multipart: the replay is decided by the file hash, then the atomic quota reserve
    if (multipart && idempotencyKey !== null) {
      const requestHash = fingerprint(state.file ? state.file.sha256 : null);
      if (known) {
        env.idempotency.compare(known, requestHash);
        state.idempotency = { key: idempotencyKey, requestHash, replay: known.message };
      } else {
        state.idempotency = { key: idempotencyKey, requestHash, replay: null };
      }
    }
    if (endpoint.quota && !(state.idempotency && state.idempotency.replay)) {
      await env.quotas().hydrate(key);
      state.reservation = env.quotas().reserve(key);
    }
  }

  // 20. hand over to the endpoint
  const audit = (action, targetText, result, detail) =>
    Promise.resolve(env.audit.record({ action, target: targetText, origin, result, detail })).catch(() => null);
  const ctx = {
    req,
    res,
    requestId: state.requestId,
    endpoint,
    params,
    query,
    body: validated,
    file: state.file,
    key: Object.freeze({ id: key.id, name: key.name }),
    origin,
    now: startedAt,
    signal: controllerSignal(state),
    idempotency: state.idempotency,
    services: Object.freeze({ messaging: guardMessaging(env.messaging(), state), formats: env.formats, openapi: env.openapi }),
    audit,
  };
  return endpoint.handle(ctx);
}

const controllerSignal = (state) => state.controller.signal;

function uploadOptions(env, req, state, key, maxBytes, kinds) {
  return {
    req,
    keyId: key.id,
    maxBytes,
    kinds,
    signal: controllerSignal(state),
    dir: env.tmpDir,
    pendingBytes: () => env.messaging().pendingMediaBytes(),
  };
}

function invalid(name, code, params) {
  return new ApiError("validation_failed", { fields: { [name]: params ? { code, params } : { code } } });
}
const fieldFault = (name, code) => invalid(name, code);

/** Alert and audit row for the origin whose block just started (once per block) */
function originBlocked(env, origin, retryAfterMs) {
  try {
    Promise.resolve(env.alerts().raise("api_origin_blocked", { origin, retryAfterMs })).catch(() => {});
  } catch {
    // an alert never fails a request
  }
  try {
    Promise.resolve(env.audit.record({ action: "api.origin.block", target: origin, origin, result: "blocked", detail: { retryAfterMs } })).catch(() => {});
  } catch {
    // nor does the audit
  }
}

/** `Deprecation` and `Sunset` (and a `Link` to the replacement) of a deprecated endpoint */
function deprecationHeaders(res, endpoint) {
  const d = endpoint.deprecated;
  if (!d) return;
  const since = Date.parse(d.since);
  const sunset = Date.parse(d.sunset);
  res.setHeader("Deprecation", Number.isFinite(since) ? `@${Math.floor(since / 1000)}` : "true");
  if (Number.isFinite(sunset)) res.setHeader("Sunset", new Date(sunset).toUTCString());
  if (typeof d.link === "string" && d.link) res.setHeader("Link", `<${d.link}>; rel="successor-version"`);
}

module.exports = { dispatch, keyInUrl, bearerToken, coerceQuery, guardMessaging, IDEMPOTENCY_KEY };
