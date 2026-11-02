"use strict";

/**
 * HTTP-layer errors of the public messaging API (feature 004, contracts/runtime.md section 15.13).
 *
 *   ApiError(code, { fields, params, headers, message })   a refusal of the HTTP layer (never carries prose)
 *   API_STATUS                                             the 19 HTTP-layer codes -> status (public-api.md section 6)
 *   statusOf(code)                                         status of a code of API_STATUS or MESSAGING_STATUS (500 if unknown)
 *   toApiHttpError(err)                                    any thrown value -> { status, code, fields, params, headers, typed }
 *
 * One source per HTTP code (RT-21): `lib/messaging/errors.js` holds the nine engine refusals, this file the
 * HTTP-layer ones; the panel's STATUS_BY_CODE gets none of the API-only codes. `fields` leaves the process for
 * `validation_failed` only, `params.retryAfterMs` becomes `Retry-After` (response.js#retryAfterHeader), a 401 carries
 * its `WWW-Authenticate`. Whatever is not a typed refusal is a 500 `internal_error`: the caller logs the reduced
 * error (`typed: false`), the client learns nothing. A `MessagingError` and an `ApiError` keep their code, fields and
 * params; a `SchemaError` or an `AdminError` of one of six shared codes (the helpers of request.js / schema.js) is
 * mapped to the same code.
 */

const { MESSAGING_STATUS, MessagingError } = require("../messaging/errors");
const { SchemaError } = require("../utils/schema");
const { AdminError, isDbDown, retryAfterHeader } = require("../admin/http/response");

/** Codes of the HTTP layer only; none is in MESSAGING_STATUS (RT-21) */
const API_STATUS = Object.freeze({
  unavailable: 503,
  method_not_allowed: 405,
  not_found: 404,
  bad_request: 400,
  https_required: 403,
  browser_not_allowed: 403,
  key_in_url: 400,
  origin_blocked: 429,
  unauthenticated: 401,
  key_revoked: 401,
  key_expired: 401,
  ip_not_allowed: 403,
  forbidden: 403,
  rate_limited: 429,
  daily_quota_exceeded: 429,
  idempotency_conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
});

/** Codes of the shared panel helpers (request.js, schema.js) that mean the same thing here */
const SHARED_CODES = new Set([
  "bad_request",
  "payload_too_large",
  "validation_failed",
  "unsupported_media_type",
  "method_not_allowed",
  "not_found",
]);

const WWW_AUTHENTICATE = Object.freeze({
  unauthenticated: 'Bearer realm="owb-api"',
  key_revoked: 'Bearer realm="owb-api", error="invalid_token"',
  key_expired: 'Bearer realm="owb-api", error="invalid_token"',
});

/** Seconds a client should wait when a 429 / 503 carries no `retryAfterMs` of its own */
const DEFAULT_RETRY_AFTER = Object.freeze({ 429: "1", 503: "5" });

class ApiError extends Error {
  /**
   * @param {string} code
   * @param {{ fields?: object, params?: object, headers?: object, message?: string }} [options]
   */
  constructor(code, options = {}) {
    super(options.message || code);
    this.name = "ApiError";
    this.code = code;
    this.fields = options.fields || undefined;
    this.params = options.params || undefined;
    this.headers = options.headers || undefined;
  }
}

/** HTTP status of a code of either table; an unknown code is a server fault */
function statusOf(code) {
  if (Object.hasOwn(API_STATUS, code)) return API_STATUS[code];
  if (Object.hasOwn(MESSAGING_STATUS, code)) return MESSAGING_STATUS[code];
  return 500;
}

const isKnownCode = (code) => typeof code === "string" && (Object.hasOwn(API_STATUS, code) || Object.hasOwn(MESSAGING_STATUS, code));

function typedResult(code, source) {
  const status = statusOf(code);
  const headers = { ...(source.headers || {}) };
  const retry = retryAfterHeader(source.params);
  if (retry && !headers["Retry-After"]) headers["Retry-After"] = retry;
  if (!headers["Retry-After"] && DEFAULT_RETRY_AFTER[status]) headers["Retry-After"] = DEFAULT_RETRY_AFTER[status];
  if (WWW_AUTHENTICATE[code] && !headers["WWW-Authenticate"]) headers["WWW-Authenticate"] = WWW_AUTHENTICATE[code];
  return {
    status,
    code,
    fields: code === "validation_failed" ? source.fields : undefined,
    params: source.params,
    headers,
    typed: true,
  };
}

/**
 * Reduce a thrown value to what leaves the process.
 * @returns {{ status: number, code: string, fields?: object, params?: object, headers: object, typed: boolean }}
 */
function toApiHttpError(err) {
  if ((err instanceof ApiError || err instanceof MessagingError) && isKnownCode(err.code)) return typedResult(err.code, err);
  if ((err instanceof SchemaError || err instanceof AdminError) && SHARED_CODES.has(err.code)) return typedResult(err.code, err);
  if (isDbDown(err)) return typedResult("unavailable", { params: { retryAfterMs: 5000 } });
  return { status: 500, code: "internal_error", headers: {}, typed: false };
}

module.exports = { ApiError, API_STATUS, statusOf, toApiHttpError };
