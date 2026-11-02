"use strict";
/**
 * HTTP-layer errors of the messaging API (feature 004, contracts/runtime.md section 15.13, public-api.md section 6):
 * the 19 codes of API_STATUS, the lookup over both tables, the reduction of any thrown value to an envelope, the
 * Retry-After and WWW-Authenticate headers, and the version constant.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ApiError, API_STATUS, statusOf, toApiHttpError } = require("../lib/api/errors");
const { API_VERSION, PATH_VERSION, BASE_PATH, majorOf } = require("../lib/api/version");
const { MessagingError, MESSAGING_STATUS } = require("../lib/messaging/errors");
const { SchemaError } = require("../lib/utils/schema");
const { AdminError, retryAfterHeader, STATUS_BY_CODE } = require("../lib/admin/http/response");

const EXPECTED = {
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
};

describe("API_STATUS", () => {
  test("has exactly the 19 HTTP-layer codes of runtime.md 15.13, frozen", () => {
    assert.deepEqual({ ...API_STATUS }, EXPECTED);
    assert.equal(Object.keys(API_STATUS).length, 19);
    assert.ok(Object.isFrozen(API_STATUS));
  });

  test("RT-21: no code is both an HTTP-layer code and an engine refusal", () => {
    for (const code of Object.keys(API_STATUS)) assert.ok(!Object.hasOwn(MESSAGING_STATUS, code), code);
  });

  test("the panel table gets none of the API-only codes", () => {
    for (const code of ["https_required", "browser_not_allowed", "key_in_url", "origin_blocked", "key_revoked", "key_expired", "ip_not_allowed", "daily_quota_exceeded", "idempotency_conflict", "unavailable"]) {
      assert.ok(!Object.hasOwn(STATUS_BY_CODE, code), `${code} must stay out of STATUS_BY_CODE`);
    }
  });
});

describe("statusOf", () => {
  test("looks up both tables", () => {
    assert.equal(statusOf("unauthenticated"), 401);
    assert.equal(statusOf("queue_full"), 503);
    assert.equal(statusOf("media_too_large"), 413);
    assert.equal(statusOf("validation_failed"), 422);
    for (const [code, status] of Object.entries({ ...MESSAGING_STATUS, ...API_STATUS })) assert.equal(statusOf(code), status, code);
  });

  test("an unknown code is a server fault", () => {
    assert.equal(statusOf("nope"), 500);
    assert.equal(statusOf(undefined), 500);
    assert.equal(statusOf("constructor"), 500);
  });
});

describe("toApiHttpError", () => {
  test("an ApiError keeps its code, params and headers", () => {
    const out = toApiHttpError(new ApiError("forbidden", { params: { right: "messages.read" }, headers: { "X-Test": "1" } }));
    assert.equal(out.status, 403);
    assert.equal(out.code, "forbidden");
    assert.deepEqual(out.params, { right: "messages.read" });
    assert.equal(out.headers["X-Test"], "1");
    assert.equal(out.typed, true);
  });

  test("a MessagingError keeps code, fields and params", () => {
    const fields = { to: { code: "invalid_format" } };
    const out = toApiHttpError(new MessagingError("validation_failed", { fields }));
    assert.equal(out.status, 422);
    assert.deepEqual(out.fields, fields);
    const full = toApiHttpError(new MessagingError("queue_full", { params: { scope: "global", retryAfterMs: 2500 } }));
    assert.equal(full.status, 503);
    assert.deepEqual(full.params, { scope: "global", retryAfterMs: 2500 });
    assert.equal(full.headers["Retry-After"], "3");
  });

  test("fields leave the process for validation_failed only", () => {
    const fields = { a: { code: "required" } };
    assert.deepEqual(toApiHttpError(new ApiError("validation_failed", { fields })).fields, fields);
    assert.equal(toApiHttpError(new ApiError("rate_limited", { fields, params: { scope: "minute", limit: 3, retryAfterMs: 1000 } })).fields, undefined);
    assert.equal(toApiHttpError(new MessagingError("chat_disabled", { fields })).fields, undefined);
  });

  test("a SchemaError and an AdminError of the six shared codes map to the same code", () => {
    const fields = { text: { code: "too_long", params: { max: 3 } } };
    const schema = toApiHttpError(new SchemaError("validation_failed", { fields }));
    assert.equal(schema.status, 422);
    assert.deepEqual(schema.fields, fields);
    assert.equal(toApiHttpError(new SchemaError("bad_request")).status, 400);
    for (const code of ["bad_request", "payload_too_large", "validation_failed", "unsupported_media_type", "method_not_allowed", "not_found"]) {
      const out = toApiHttpError(new AdminError(code, { params: code === "payload_too_large" ? { maxBytes: 5 } : undefined }));
      assert.equal(out.code, code);
      assert.equal(out.status, statusOf(code));
      assert.equal(out.typed, true);
    }
    assert.deepEqual(toApiHttpError(new AdminError("payload_too_large", { params: { maxBytes: 5 } })).params, { maxBytes: 5 });
  });

  test("an AdminError of any other code is an internal error, never echoed", () => {
    for (const code of ["conflict", "starting", "maintenance", "csrf_invalid", "db_unavailable"]) {
      const out = toApiHttpError(new AdminError(code));
      assert.equal(out.status, 500, code);
      assert.equal(out.code, "internal_error");
      assert.equal(out.typed, false);
    }
  });

  test("a lost database becomes unavailable with Retry-After 5", () => {
    const err = new Error("connect ECONNREFUSED 10.0.0.1:5432");
    err.name = "SequelizeConnectionRefusedError";
    const out = toApiHttpError(err);
    assert.equal(out.status, 503);
    assert.equal(out.code, "unavailable");
    assert.equal(out.headers["Retry-After"], "5");
    assert.deepEqual(out.params, { retryAfterMs: 5000 });
  });

  test("anything else is 500 internal_error, not typed, without message or stack", () => {
    for (const thrown of [new Error("secret path /etc/passwd"), new TypeError("x"), "boom", null, undefined, { code: "forbidden" }]) {
      const out = toApiHttpError(thrown);
      assert.equal(out.status, 500);
      assert.equal(out.code, "internal_error");
      assert.equal(out.typed, false);
      assert.equal(out.fields, undefined);
      assert.equal(out.params, undefined);
      assert.deepEqual(out.headers, {});
    }
  });

  test("a plain Error that only borrows a known code is not trusted", () => {
    const borrowed = Object.assign(new Error("x"), { code: "forbidden" });
    assert.equal(toApiHttpError(borrowed).code, "internal_error");
  });

  test("params.retryAfterMs becomes Retry-After through response.js#retryAfterHeader (whole seconds, at least 1)", () => {
    assert.equal(retryAfterHeader({ retryAfterMs: 1 }), "1");
    assert.equal(retryAfterHeader({ retryAfterMs: 1001 }), "2");
    assert.equal(retryAfterHeader({}), null);
    assert.equal(toApiHttpError(new ApiError("origin_blocked", { params: { retryAfterMs: 900000 } })).headers["Retry-After"], "900");
    assert.equal(toApiHttpError(new ApiError("daily_quota_exceeded", { params: { limit: 5, retryAfterMs: 90500 } })).headers["Retry-After"], "91");
  });

  test("every 429 and 503 carries a Retry-After, even without retryAfterMs", () => {
    for (const [code, status] of Object.entries({ ...MESSAGING_STATUS, ...API_STATUS })) {
      if (status !== 429 && status !== 503) continue;
      const out = toApiHttpError(new ApiError(code));
      assert.ok(Number(out.headers["Retry-After"]) >= 1, code);
    }
  });

  test("a 401 carries its WWW-Authenticate", () => {
    assert.equal(toApiHttpError(new ApiError("unauthenticated")).headers["WWW-Authenticate"], 'Bearer realm="owb-api"');
    for (const code of ["key_revoked", "key_expired"]) {
      assert.equal(toApiHttpError(new ApiError(code)).headers["WWW-Authenticate"], 'Bearer realm="owb-api", error="invalid_token"');
    }
    assert.equal(toApiHttpError(new ApiError("forbidden")).headers["WWW-Authenticate"], undefined);
  });
});

describe("version", () => {
  test("API_VERSION is a semver whose major is the path version", () => {
    assert.match(API_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(majorOf(API_VERSION), 1);
    assert.equal(PATH_VERSION, "v1");
    assert.equal(BASE_PATH, "/api/v1");
  });
});

describe("the error table of public-api.md section 6", () => {
  test("error rows equal API_STATUS plus MESSAGING_STATUS (code and status, nothing more)", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "specs", "004-messaging-api", "contracts", "public-api.md"), "utf8");
    const start = text.search(/^## 6\. /m);
    const end = text.search(/^## 7\. /m);
    const slice = text.slice(start, end);
    const rows = [...slice.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|/gm)].map((m) => [m[1], Number(m[2])]);
    const documented = Object.fromEntries(rows);
    assert.deepEqual(documented, { ...MESSAGING_STATUS, ...API_STATUS });
  });
});
