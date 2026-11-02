"use strict";

/**
 * Error vocabulary of the messaging engine (feature 004, contracts/runtime.md section 2.1). Pure data and one
 * class, no requires: `lib/api/errors.js` (HTTP layer) and the panel import it, so it lives with the engine.
 *
 *   MessagingError          an engine refusal: `code`, optional `fields` (dotted paths), `params` (numbers and codes)
 *   MESSAGING_STATUS        code -> HTTP status of the nine engine refusals (the only HTTP status an engine knows)
 *   FAILURE_CODES           message-level codes of a `failed` message
 *   CANCEL_REASONS          message-level codes of a `cancelled` message
 *   UNKNOWN_REASONS         message-level codes of an `unknown` message
 *   CODE_STATUS             each of the 14 message-level codes -> "failed" | "cancelled" | "unknown"
 *   STATUSES                the nine message statuses of public-api.md 4.2
 *
 * RT-20: a MessagingError carries only codes, field paths and numbers, never a submitted value, a recipient, a URL,
 * a path or a stack. RT-21: a code is in exactly one of MESSAGING_STATUS and `API_STATUS` (lib/api/errors.js); the
 * message-level codes are another vocabulary, never an HTTP error, and may reuse a name (`chat_disabled`,
 * `key_revoked`, `key_expired`). `FAILURE_CODES`, `CANCEL_REASONS` and `UNKNOWN_REASONS` together are the
 * `FailureCode` enum of the OpenAPI document.
 */

class MessagingError extends Error {
  /**
   * @param {string} code
   * @param {{ fields?: object, params?: object, headers?: object, message?: string }} [options]
   */
  constructor(code, options = {}) {
    super(options.message || code);
    this.name = "MessagingError";
    this.code = code;
    this.fields = options.fields || undefined;
    this.params = options.params || undefined;
    this.headers = options.headers || undefined;
  }
}

/** Engine refusals that reach the caller as HTTP errors (public-api.md section 6, rows shared with API_STATUS) */
const MESSAGING_STATUS = Object.freeze({
  validation_failed: 422,
  recipient_not_allowed: 403,
  chat_disabled: 409,
  queue_full: 503,
  pending_limit_reached: 429,
  media_type_mismatch: 422,
  media_too_large: 413,
  url_forbidden: 422,
  url_unreachable: 502,
});

/** `failure.code` of a message whose status is `failed` (public-api.md 4.3) */
const FAILURE_CODES = Object.freeze({
  not_on_whatsapp: "not_on_whatsapp",
  chat_disabled: "chat_disabled",
  not_in_group: "not_in_group",
  group_announce_only: "group_announce_only",
  media_conversion_failed: "media_conversion_failed",
  payload_unavailable: "payload_unavailable",
  whatsapp_rejected: "whatsapp_rejected",
  send_failed: "send_failed",
});

/** `failure.code` of a message whose status is `cancelled` */
const CANCEL_REASONS = Object.freeze({
  key_revoked: "key_revoked",
  key_expired: "key_expired",
  api_disabled: "api_disabled",
});

/** `failure.code` of a message whose status is `unknown` */
const UNKNOWN_REASONS = Object.freeze({
  interrupted: "interrupted",
  timeout: "timeout",
  connection_closed: "connection_closed",
});

/** Status of the message for each of the 14 message-level codes */
const CODE_STATUS = Object.freeze({
  ...Object.fromEntries(Object.keys(FAILURE_CODES).map((code) => [code, "failed"])),
  ...Object.fromEntries(Object.keys(CANCEL_REASONS).map((code) => [code, "cancelled"])),
  ...Object.fromEntries(Object.keys(UNKNOWN_REASONS).map((code) => [code, "unknown"])),
});

/** The nine statuses of a message, in lifecycle order (public-api.md 4.2) */
const STATUSES = Object.freeze(["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]);

module.exports = {
  MessagingError,
  MESSAGING_STATUS,
  FAILURE_CODES,
  CANCEL_REASONS,
  UNKNOWN_REASONS,
  CODE_STATUS,
  STATUSES,
};
