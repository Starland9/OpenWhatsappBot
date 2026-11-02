"use strict";

/**
 * Frozen limits of the messaging API (feature 004, contracts/runtime.md section 2.2): the single source for the
 * format modules, the engine, the HTTP layer and the tests. public-api.md section 3 states the same values
 * (`test/api-formats-contract.test.js` compares). Pure data: no require, no `config` (a setting that can be
 * changed lives in the settings catalog and is read at call time, never here).
 */

const MB = 1048576;

const LIMITS = Object.freeze({
  // text
  TEXT: 4096,
  CAPTION: 1024,
  INTERACTIVE_TEXT: 1024,
  BODY_COMPOSED: 4096,
  MENTIONS_MAX: 50,

  // interactive
  BUTTONS_MAX: 3,
  BUTTON_LABEL: 20,
  LIST_ROWS_MAX: 10,
  LIST_BUTTON_LABEL: 20,
  LIST_TITLE: 24,
  LIST_DESCRIPTION: 72,
  ID_PATTERN: /^[A-Za-z0-9_.-]{1,64}$/,

  // poll
  POLL_QUESTION: 255,
  POLL_OPTIONS_MIN: 2,
  POLL_OPTIONS_MAX: 12,
  POLL_OPTION: 100,

  // location, contact
  LOCATION_TEXT: 256,
  CONTACTS_MAX: 10,
  CONTACT_NAME: 128,
  CONTACT_ORG: 128,
  CONTACT_EMAIL: 254,
  PHONES_MAX: 5,

  // media (the effective cap of a request is min(MEDIA_MAX[format], MAX_UPLOAD MB), read at call time)
  MB,
  FILE_NAME: 255,
  MEDIA_URL: 2048,
  MEDIA_MAX: Object.freeze({
    image: 16 * MB,
    video: 16 * MB,
    gif: 16 * MB,
    audio: 16 * MB,
    voice: 16 * MB,
    document: 100 * MB,
    sticker: 10 * MB,
  }),
  STICKER_OUT: 900 * 1024,

  // engine
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
  RESTRICTION_CODES: Object.freeze(["463"]),
});

module.exports = { LIMITS };
