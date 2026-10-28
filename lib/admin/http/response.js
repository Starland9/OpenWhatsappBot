"use strict";

/**
 * Responses of the admin HTTP layer (admin-http-api.md sections 1.8 and 1.9).
 *
 *   AdminError(code, { fields, params, headers, status })   the typed error a handler throws
 *   STATUS_BY_CODE                                          envelope code -> HTTP status (section 1.9)
 *   toHttpError(err)                                        any thrown value -> { status, code, fields, params, headers }
 *   errorBody(http, requestId)                              { error: { code, fields?, params?, requestId } }
 *   newRequestId()                                          8 random bytes, hex (also the X-Request-Id header)
 *   reply(status, body, headers)                            explicit { status, body, headers } handler result
 *   finish(res, { status, body, headers, contentType })     THE way an answer leaves the admin: it applies the
 *                                                           security headers (errors and redirects included)
 *
 * The API sends codes and parameters, never prose, and never echoes a submitted value, a secret, a password or
 * a token (section 1.9). Raw upstream or stack text goes to the logger, not to the client.
 */

const crypto = require("crypto");

/** Envelope code -> HTTP status (admin-http-api.md section 1.9; `starting` is the boot window of runtime.md section 15). */
const STATUS_BY_CODE = Object.freeze({
  bad_request: 400,
  unauthenticated: 401,
  session_expired: 401,
  invalid_credentials: 401,
  token_invalid: 401,
  origin_mismatch: 403,
  csrf_invalid: 403,
  forbidden: 403,
  not_found: 404,
  no_qr: 404,
  method_not_allowed: 405,
  conflict: 409,
  busy: 409,
  confirmation_required: 409,
  setup_required: 409,
  not_connected: 409,
  bot_not_admin: 409,
  group_left: 409,
  already_paired: 409,
  not_configured: 409,
  not_pending: 409,
  not_editable: 409,
  limit_reached: 409,
  duplicate: 409,
  upload_in_progress: 409,
  update_unavailable: 409,
  downloads_active: 409,
  restore_token_invalid: 409,
  length_required: 411,
  payload_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  not_testable: 422,
  not_purgeable: 422,
  unsupported_file_type: 422,
  target_protected: 422,
  negative_balance: 422,
  wrong_passphrase: 422,
  backup_corrupted: 422,
  backup_unsupported_format: 422,
  backup_too_new: 422,
  backup_invalid_row: 422,
  login_blocked: 429,
  rate_limited: 429,
  internal_error: 500,
  whatsapp_error: 502,
  db_unavailable: 503,
  maintenance: 503,
  starting: 503,
  quota_exceeded: 507,
});

/** `fields` is only part of the envelope for these two codes (section 1.9). */
const FIELD_CODES = new Set(["validation_failed", "conflict"]);

/**
 * Typed error of the admin layer. The router maps `code` to the status of STATUS_BY_CODE.
 *
 *   throw new AdminError("not_found", { params: { resource: "group" } });
 *   throw new AdminError("validation_failed", { fields: { name: { code: "required" } } });
 *
 * `message` is for logs only. `headers` are added to the answer (Allow, Retry-After...); a `retryAfterMs`
 * parameter of a 429/503 becomes `Retry-After` on its own.
 */
class AdminError extends Error {
  constructor(code, options = {}) {
    super(options.message || code);
    this.name = "AdminError";
    this.code = code;
    this.fields = options.fields || undefined;
    this.params = options.params || undefined;
    this.headers = options.headers || undefined;
    if (options.status) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

const DB_DOWN_NAMES = new Set([
  "SequelizeConnectionError",
  "SequelizeConnectionRefusedError",
  "SequelizeConnectionTimedOutError",
  "SequelizeConnectionAcquireTimeoutError",
  "SequelizeHostNotFoundError",
  "SequelizeHostNotReachableError",
  "SequelizeInvalidConnectionError",
  "SequelizeAccessDeniedError",
]);
const DB_DOWN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "57P01", "08006", "08001"]);

/** True when a thrown value is a Sequelize connection failure (the database is unreachable). */
function isDbDown(err) {
  if (!err || typeof err !== "object") return false;
  if (DB_DOWN_NAMES.has(err.name)) return true;
  const parent = err.parent || err.original;
  if (parent && typeof parent.code === "string" && DB_DOWN_CODES.has(parent.code) && /^Sequelize/.test(String(err.name))) {
    return true;
  }
  return false;
}

function retryAfterHeader(params) {
  const ms = params && Number(params.retryAfterMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

/**
 * Reduce a thrown value to what leaves the process. Typed errors (AdminError, or any Error whose string `code`
 * is a section 1.9 code: engines throw those) keep their code, fields and params; a lost database becomes
 * `db_unavailable`; everything else is an `internal_error` (the caller logs the real error).
 */
function toHttpError(err) {
  if (err && typeof err === "object" && typeof err.code === "string" && Object.hasOwn(STATUS_BY_CODE, err.code)) {
    const code = err.code;
    const headers = { ...(err.headers || {}) };
    const retry = retryAfterHeader(err.params);
    if (retry && !headers["Retry-After"]) headers["Retry-After"] = retry;
    if (code === "maintenance" && !headers["Retry-After"]) headers["Retry-After"] = "5";
    return {
      status: err.status || STATUS_BY_CODE[code],
      code,
      fields: FIELD_CODES.has(code) ? err.fields : undefined,
      params: err.params,
      headers,
      typed: true,
    };
  }
  if (isDbDown(err)) {
    return { status: 503, code: "db_unavailable", headers: {}, typed: false };
  }
  return { status: 500, code: "internal_error", headers: {}, typed: false };
}

function newRequestId() {
  return crypto.randomBytes(8).toString("hex");
}

/** The error envelope (section 1.9). Fields and params are included only when present. */
function errorBody(http, requestId) {
  const error = { code: http.code };
  if (http.fields && Object.keys(http.fields).length) error.fields = http.fields;
  if (http.params && Object.keys(http.params).length) error.params = http.params;
  if (requestId) error.requestId = requestId;
  return { error };
}

const REPLY = Symbol("admin.reply");

/** An explicit handler result: `return reply(201, { item }, { Location: "..." })`. */
function reply(status, body, headers) {
  return { [REPLY]: true, status, body, headers: headers || {} };
}

/** True for the `{ status, body, headers }` form a handler may return (marked, or a numeric status with a body). */
function isReply(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) return false;
  if (value[REPLY]) return true;
  return typeof value.status === "number" && Object.hasOwn(value, "body");
}

/**
 * Write an answer. Applies the security headers (idempotent) and the request id, sets Content-Type and
 * Content-Length, then ends the response. A Buffer or string body is sent as is (set `contentType`), anything
 * else is JSON (`application/json; charset=utf-8`). `head: true` sends the headers of the GET answer without the
 * body. Does nothing when the response was already taken over.
 */
function finish(res, { status = 200, body, headers, contentType, cacheControl, requestId, head = false } = {}) {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  // lazy: security.js requires this module (AdminError)
  require("./security").applySecurityHeaders(res, { cacheControl });
  if (requestId && !res.getHeader("X-Request-Id")) res.setHeader("X-Request-Id", requestId);

  let payload;
  let type = contentType;
  if (body === undefined || body === null) {
    payload = Buffer.alloc(0);
  } else if (Buffer.isBuffer(body)) {
    payload = body;
    type = type || "application/octet-stream";
  } else if (typeof body === "string") {
    payload = Buffer.from(body, "utf8");
    type = type || "text/plain; charset=utf-8";
  } else {
    payload = Buffer.from(JSON.stringify(body), "utf8");
    type = type || "application/json; charset=utf-8";
  }

  for (const [name, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  }
  if (type && payload.length) res.setHeader("Content-Type", type);
  else if (type && !res.getHeader("Content-Type")) res.setHeader("Content-Type", type);
  res.statusCode = status;
  if (status === 304 || status === 204) {
    res.end();
    return;
  }
  res.setHeader("Content-Length", payload.length);
  // HEAD: the headers of the GET answer, no body
  if (head) res.end();
  else res.end(payload);
}

/** Answer with the envelope of `err` (see toHttpError). Returns the reduced error for logging. */
function sendError(res, err, { requestId, cacheControl } = {}) {
  const http = toHttpError(err);
  finish(res, {
    status: http.status,
    body: errorBody(http, requestId || res.getHeader("X-Request-Id")),
    headers: http.headers,
    cacheControl,
    requestId,
  });
  return http;
}

module.exports = {
  AdminError,
  STATUS_BY_CODE,
  toHttpError,
  isDbDown,
  errorBody,
  newRequestId,
  reply,
  isReply,
  finish,
  sendError,
};
