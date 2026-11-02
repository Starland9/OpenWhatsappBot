"use strict";
/**
 * lib/messaging/errors.js and lib/messaging/limits.js (feature 004, contracts/runtime.md sections 2.1 and 2.2):
 * pure data and one class, shared by the format modules, the engine, the HTTP layer and the panel.
 *
 *  - MessagingError carries only codes, field paths and numbers (RT-20);
 *  - MESSAGING_STATUS is the nine rows of 2.1; the failure / cancel / unknown vocabularies and CODE_STATUS equal
 *    the failure rows of contracts/public-api.md 4.3 (parsed with the machine-read regex of that file);
 *  - RT-21: a code is in MESSAGING_STATUS or in API_STATUS, never both;
 *  - LIMITS is frozen and every entry has the exact value of the 2.2 table and of public-api.md section 3.
 *
 * Pure: no database, no WhatsApp, no network.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const errors = require("../lib/messaging/errors");
const limits = require("../lib/messaging/limits");

const { MessagingError, MESSAGING_STATUS, FAILURE_CODES, CANCEL_REASONS, UNKNOWN_REASONS, CODE_STATUS, STATUSES } = errors;
const { LIMITS } = limits;

const PUBLIC_API = fs.readFileSync(path.join(__dirname, "..", "specs", "004-messaging-api", "contracts", "public-api.md"), "utf8");

/** The text between two level-2 headings `## <from>. ` and `## <to>. ` (the slices of the machine-read format). */
function slice(from, to) {
  const start = PUBLIC_API.search(new RegExp(`^## ${from}\\. `, "m"));
  const end = PUBLIC_API.search(new RegExp(`^## ${to}\\. `, "m"));
  assert.ok(start >= 0 && end > start, `slice ${from} -> ${to} found`);
  return PUBLIC_API.slice(start, end);
}

const rowsOf = (text, regex) => Array.from(text.matchAll(regex), (m) => m.slice(1));

/** The 19 HTTP-layer codes of runtime.md 15.13 (lib/api/errors.js, written by D-HTTP in the next wave). */
const API_STATUS_CODES = [
  "unavailable",
  "method_not_allowed",
  "not_found",
  "bad_request",
  "https_required",
  "browser_not_allowed",
  "key_in_url",
  "origin_blocked",
  "unauthenticated",
  "key_revoked",
  "key_expired",
  "ip_not_allowed",
  "forbidden",
  "rate_limited",
  "daily_quota_exceeded",
  "idempotency_conflict",
  "payload_too_large",
  "unsupported_media_type",
  "internal_error",
];

describe("MessagingError", () => {
  test("code, fields, params, a default message equal to the code", () => {
    const err = new MessagingError("validation_failed", { fields: { "buttons.1.id": { code: "duplicate" } }, params: { max: 3 } });
    assert.ok(err instanceof Error);
    assert.equal(err.name, "MessagingError");
    assert.equal(err.code, "validation_failed");
    assert.equal(err.message, "validation_failed");
    assert.deepEqual(err.fields, { "buttons.1.id": { code: "duplicate" } });
    assert.deepEqual(err.params, { max: 3 });
  });

  test("an explicit message is kept; options are optional", () => {
    assert.equal(new MessagingError("queue_full", { message: "global queue is full" }).message, "global queue is full");
    const bare = new MessagingError("chat_disabled");
    assert.equal(bare.code, "chat_disabled");
    assert.equal(bare.fields, undefined);
    assert.equal(bare.params, undefined);
    assert.equal(bare.headers, undefined);
  });

  test("headers are carried when given (Retry-After is built from params by the HTTP layer)", () => {
    assert.deepEqual(new MessagingError("queue_full", { headers: { "Retry-After": "5" } }).headers, { "Retry-After": "5" });
  });

  test("it carries only what the caller passed: no recipient, URL, path or submitted value (RT-20)", () => {
    const err = new MessagingError("recipient_not_allowed");
    assert.ok(Object.keys(err).every((key) => ["name", "code", "fields", "params", "headers"].includes(key)), Object.keys(err).join(","));
    const dump = JSON.stringify({ ...err, message: err.message });
    assert.doesNotMatch(dump, /@s\.whatsapp\.net|https?:|\/home\//);
  });

  test("the stack is never part of the serialised error", () => {
    const err = new MessagingError("url_unreachable");
    assert.ok(!("stack" in JSON.parse(JSON.stringify(err))));
  });
});

describe("MESSAGING_STATUS: the nine rows of 2.1", () => {
  const EXPECTED = {
    validation_failed: 422,
    recipient_not_allowed: 403,
    chat_disabled: 409,
    queue_full: 503,
    pending_limit_reached: 429,
    media_type_mismatch: 422,
    media_too_large: 413,
    url_forbidden: 422,
    url_unreachable: 502,
  };

  test("exactly these nine codes with these statuses", () => {
    assert.deepEqual({ ...MESSAGING_STATUS }, EXPECTED);
    assert.equal(Object.keys(MESSAGING_STATUS).length, 9);
  });

  test("frozen", () => {
    assert.ok(Object.isFrozen(MESSAGING_STATUS));
    assert.throws(() => {
      MESSAGING_STATUS.extra = 500;
    }, TypeError);
  });

  test("the statuses equal the error rows of public-api.md section 6", () => {
    const rows = Object.fromEntries(rowsOf(slice(6, 7), /^\| `([a-z_]+)` \| (\d{3}) \|/gm).map(([code, status]) => [code, Number(status)]));
    for (const [code, status] of Object.entries(MESSAGING_STATUS)) assert.equal(rows[code], status, code);
  });

  test("the error rows of section 6 are exactly MESSAGING_STATUS plus the 19 API_STATUS codes", () => {
    const rows = rowsOf(slice(6, 7), /^\| `([a-z_]+)` \| (\d{3}) \|/gm).map(([code]) => code);
    assert.deepEqual([...rows].sort(), [...Object.keys(MESSAGING_STATUS), ...API_STATUS_CODES].sort());
  });

  test("RT-21: no code is in both MESSAGING_STATUS and the 19 API_STATUS codes", () => {
    assert.equal(API_STATUS_CODES.length, 19);
    const both = Object.keys(MESSAGING_STATUS).filter((code) => API_STATUS_CODES.includes(code));
    assert.deepEqual(both, []);
  });
});

describe("failure vocabularies equal the failure rows of public-api.md 4.3", () => {
  const rows = rowsOf(slice(4, 5), /^\| `([a-z_]+)` \| `(failed|cancelled|unknown)` \|/gm);

  test("the document has the 14 rows", () => {
    assert.equal(rows.length, 14);
  });

  test("FAILURE_CODES: the eight codes of status failed", () => {
    const expected = rows.filter(([, status]) => status === "failed").map(([code]) => code);
    assert.equal(expected.length, 8);
    assert.deepEqual(Object.keys(FAILURE_CODES).sort(), expected.sort());
    assert.deepEqual(Object.keys(FAILURE_CODES).sort(), [
      "chat_disabled",
      "group_announce_only",
      "media_conversion_failed",
      "not_in_group",
      "not_on_whatsapp",
      "payload_unavailable",
      "send_failed",
      "whatsapp_rejected",
    ]);
  });

  test("CANCEL_REASONS: the three codes of status cancelled", () => {
    const expected = rows.filter(([, status]) => status === "cancelled").map(([code]) => code);
    assert.deepEqual(Object.keys(CANCEL_REASONS).sort(), expected.sort());
    assert.deepEqual(Object.keys(CANCEL_REASONS).sort(), ["api_disabled", "key_expired", "key_revoked"]);
  });

  test("UNKNOWN_REASONS: the three codes of status unknown", () => {
    const expected = rows.filter(([, status]) => status === "unknown").map(([code]) => code);
    assert.deepEqual(Object.keys(UNKNOWN_REASONS).sort(), expected.sort());
    assert.deepEqual(Object.keys(UNKNOWN_REASONS).sort(), ["connection_closed", "interrupted", "timeout"]);
  });

  test("CODE_STATUS maps each of the 14 codes to its status, exactly as the document says", () => {
    assert.equal(Object.keys(CODE_STATUS).length, 14);
    assert.deepEqual({ ...CODE_STATUS }, Object.fromEntries(rows));
  });

  test("each vocabulary maps a name to itself, and all four objects are frozen", () => {
    for (const set of [FAILURE_CODES, CANCEL_REASONS, UNKNOWN_REASONS]) {
      for (const [key, value] of Object.entries(set)) assert.equal(value, key);
    }
    for (const obj of [FAILURE_CODES, CANCEL_REASONS, UNKNOWN_REASONS, CODE_STATUS]) assert.ok(Object.isFrozen(obj));
  });

  test("names reused across vocabularies keep their own status (chat_disabled / key_revoked / key_expired)", () => {
    assert.equal(CODE_STATUS.chat_disabled, "failed");
    assert.equal(CODE_STATUS.key_revoked, "cancelled");
    assert.equal(CODE_STATUS.key_expired, "cancelled");
    // chat_disabled is both an HTTP refusal (MESSAGING_STATUS) and a message-level failure code: allowed (RT-21)
    assert.equal(MESSAGING_STATUS.chat_disabled, 409);
  });
});

describe("STATUSES: the nine of public-api.md 4.2", () => {
  test("equal to the status rows and in the documented order", () => {
    assert.deepEqual([...STATUSES], ["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]);
    const rows = rowsOf(slice(4, 5), /^\| `(queued|sending|sent|delivered|read|failed|expired|cancelled|unknown)` \|/gm).map(([s]) => s);
    assert.deepEqual([...rows].sort(), [...STATUSES].sort());
  });

  test("every status named by CODE_STATUS is one of them", () => {
    for (const status of Object.values(CODE_STATUS)) assert.ok(STATUSES.includes(status), status);
  });
});

describe("LIMITS (2.2)", () => {
  test("frozen, with frozen nested values", () => {
    assert.ok(Object.isFrozen(LIMITS));
    assert.throws(() => {
      LIMITS.TEXT = 1;
    }, TypeError);
    assert.ok(Object.isFrozen(LIMITS.RESTRICTION_CODES));
    assert.ok(Object.isFrozen(LIMITS.MEDIA_MAX));
  });

  test("text and interactive", () => {
    const expected = {
      TEXT: 4096,
      CAPTION: 1024,
      INTERACTIVE_TEXT: 1024,
      BODY_COMPOSED: 4096,
      MENTIONS_MAX: 50,
      BUTTONS_MAX: 3,
      BUTTON_LABEL: 20,
      LIST_ROWS_MAX: 10,
      LIST_BUTTON_LABEL: 20,
      LIST_TITLE: 24,
      LIST_DESCRIPTION: 72,
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(LIMITS[key], value, key);
  });

  test("ID_PATTERN", () => {
    assert.ok(LIMITS.ID_PATTERN instanceof RegExp);
    assert.equal(String(LIMITS.ID_PATTERN), String(/^[A-Za-z0-9_.-]{1,64}$/));
    for (const ok of ["a", "Yes_1", "a.b-c", "x".repeat(64)]) assert.ok(LIMITS.ID_PATTERN.test(ok), ok);
    for (const bad of ["", "x".repeat(65), "a b", "a:b", "é", "a/b"]) assert.ok(!LIMITS.ID_PATTERN.test(bad), bad);
  });

  test("poll, location and contact", () => {
    const expected = {
      POLL_QUESTION: 255,
      POLL_OPTIONS_MIN: 2,
      POLL_OPTIONS_MAX: 12,
      POLL_OPTION: 100,
      LOCATION_TEXT: 256,
      CONTACTS_MAX: 10,
      CONTACT_NAME: 128,
      CONTACT_ORG: 128,
      CONTACT_EMAIL: 254,
      PHONES_MAX: 5,
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(LIMITS[key], value, key);
  });

  test("media", () => {
    assert.equal(LIMITS.MB, 1048576);
    assert.equal(LIMITS.FILE_NAME, 255);
    assert.equal(LIMITS.MEDIA_URL, 2048);
    assert.equal(LIMITS.STICKER_OUT, 900 * 1024);
    assert.deepEqual(
      { ...LIMITS.MEDIA_MAX },
      {
        image: 16 * 1048576,
        video: 16 * 1048576,
        gif: 16 * 1048576,
        audio: 16 * 1048576,
        voice: 16 * 1048576,
        document: 100 * 1048576,
        sticker: 10 * 1048576,
      },
    );
  });

  test("engine", () => {
    const expected = {
      TICK_INTERVAL_MS: 1000,
      SEND_TIMEOUT_MS: 30000,
      SEND_TIMEOUT_MEDIA_MS: 90000,
      VERIFY_TIMEOUT_MS: 10000,
      VERIFY_DEFER_MS: 15000,
      WAIT_MAX_MS: 30000,
      WAITERS_MAX: 200,
      PAUSE_MS: 900000,
      RESTRICTION_THRESHOLD: 3,
      RESTRICTION_WINDOW_MS: 600000,
      IDEMPOTENCY_MS: 86400000,
      STAGE_GRACE_MS: 3600000,
      ADMISSION_FACTOR: 1.1,
      RETRY_MIN_MS: 1000,
      RETRY_MAX_MS: 300000,
      RESPONSES_MAX: 1000,
      SENT_IDS_TTL_MS: 900000,
      SENT_IDS_MAX: 2000,
      ONWHATSAPP_POSITIVE_MS: 86400000,
      ONWHATSAPP_NEGATIVE_MS: 600000,
      ONWHATSAPP_CACHE_MAX: 1000,
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(LIMITS[key], value, key);
    assert.deepEqual([...LIMITS.RESTRICTION_CODES], ["463"]);
  });

  test("every entry of the 2.2 table is present and nothing else is (no stray key)", () => {
    const table = [
      "TEXT", "CAPTION", "INTERACTIVE_TEXT", "BODY_COMPOSED", "MENTIONS_MAX",
      "BUTTONS_MAX", "BUTTON_LABEL", "LIST_ROWS_MAX", "LIST_BUTTON_LABEL", "LIST_TITLE", "LIST_DESCRIPTION", "ID_PATTERN",
      "POLL_QUESTION", "POLL_OPTIONS_MIN", "POLL_OPTIONS_MAX", "POLL_OPTION",
      "LOCATION_TEXT", "CONTACTS_MAX", "CONTACT_NAME", "CONTACT_ORG", "CONTACT_EMAIL", "PHONES_MAX",
      "MB", "FILE_NAME", "MEDIA_URL", "MEDIA_MAX", "STICKER_OUT",
      "TICK_INTERVAL_MS", "SEND_TIMEOUT_MS", "SEND_TIMEOUT_MEDIA_MS", "VERIFY_TIMEOUT_MS", "VERIFY_DEFER_MS", "WAIT_MAX_MS",
      "WAITERS_MAX", "PAUSE_MS", "RESTRICTION_THRESHOLD", "RESTRICTION_WINDOW_MS", "IDEMPOTENCY_MS", "STAGE_GRACE_MS",
      "ADMISSION_FACTOR", "RETRY_MIN_MS", "RETRY_MAX_MS", "RESPONSES_MAX", "SENT_IDS_TTL_MS", "SENT_IDS_MAX",
      "ONWHATSAPP_POSITIVE_MS", "ONWHATSAPP_NEGATIVE_MS", "ONWHATSAPP_CACHE_MAX", "RESTRICTION_CODES",
    ];
    assert.deepEqual(Object.keys(LIMITS).sort(), [...table].sort());
  });

  test("limits.js exports LIMITS and nothing is read from config (pure data)", () => {
    assert.deepEqual(Object.keys(limits), ["LIMITS"]);
    const source = fs.readFileSync(require.resolve("../lib/messaging/limits"), "utf8");
    assert.doesNotMatch(source, /require\(/);
  });
});

describe("public-api.md section 3 states the same numbers", () => {
  const section3 = slice(3, 4);

  test("text 4,096, caption 1,024, file name 255, URL 2,048", () => {
    assert.match(section3, /1 to 4,096/);
    assert.match(section3, /1 to 1,024/);
    assert.match(section3, /1 to 255/);
    assert.match(section3, /1 to 2,048/);
    assert.equal(LIMITS.TEXT, 4096);
    assert.equal(LIMITS.CAPTION, 1024);
    assert.equal(LIMITS.FILE_NAME, 255);
    assert.equal(LIMITS.MEDIA_URL, 2048);
  });

  test("media caps per format", () => {
    const caps = Object.fromEntries(
      rowsOf(section3, /^\| `(image|video|gif|audio|voice|document|sticker)` \| [^|]+ \| (\d+) MB/gm).map(([format, mb]) => [format, Number(mb)]),
    );
    assert.deepEqual(Object.keys(caps).sort(), ["audio", "document", "gif", "image", "sticker", "video", "voice"]);
    for (const [format, mb] of Object.entries(caps)) assert.equal(LIMITS.MEDIA_MAX[format], mb * LIMITS.MB, format);
  });

  test("the interactive, poll, location and contact limits appear in the document", () => {
    for (const needle of ["1 to 3", "1 to 20", "1 to 24", "1 to 72", "2 to 12", "1 to 255", "1 to 100", "1 to 128", "1 to 5"]) {
      assert.ok(section3.includes(needle) || PUBLIC_API.includes(needle), `${needle} appears in public-api.md`);
    }
  });
});
