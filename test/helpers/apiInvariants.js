"use strict";
/**
 * Invariants of the messaging API tables (feature 004, data-model.md 1.3 and 2.5).
 *
 *   assertMessageInvariants(row[, { pendingMedia }])   I1-I9 of an ApiMessage row (a model instance or a plain object)
 *   assertKeyInvariants(row)                           `revokedAt IS NULL <=> nameKey IS NOT NULL`, `nameKey = name.toLowerCase()`
 *   keyStatus(row, now)                                the derived key status: revoked over expired over active
 *   INTERACTIVE_FORMATS, ENDED_STATUSES, PENDING_STATUSES   the sets the invariants are written with
 *
 * Called after every scenario of the engine, receipts, replies, retention and panel tests: these facts are not
 * enforced by the models (a static `Model.update` runs partial validation), they are service invariants. Messages
 * name the offending row by its `publicId`, never by its content.
 */

const assert = require("node:assert/strict");

const ENDED_STATUSES = Object.freeze(["failed", "expired", "cancelled", "unknown"]);
const PENDING_STATUSES = Object.freeze(["queued", "sending"]);
const LEFT_STATUSES = Object.freeze(["sending", "sent", "delivered", "read", "unknown"]);
const SENT_STATUSES = Object.freeze(["sent", "delivered", "read"]);
const INTERACTIVE_FORMATS = Object.freeze(["poll", "buttons", "list"]);

const plain = (row) => (row && typeof row.get === "function" ? row.get({ plain: true }) : row);
const isSet = (value) => value !== null && value !== undefined;
const time = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/**
 * I1-I9 of data-model.md 2.5. `pendingMedia: true` accepts the one tolerated window of I6: a terminal row that still
 * holds its `mediaPath` between the status UPDATE and the best-effort `mediaPath = NULL` (the pointer of a deletion
 * housekeeping finishes). Without it, a terminal row must have no `mediaPath`.
 * @param {object} row  an ApiMessage instance or its plain object
 */
function assertMessageInvariants(row, { pendingMedia = false } = {}) {
  const r = plain(row);
  const who = `message ${r.publicId || r.id}`;
  const ended = ENDED_STATUSES.includes(r.status);
  const pending = PENDING_STATUSES.includes(r.status);

  // I1
  assert.equal(isSet(r.endedAt), ended, `${who}: I1 endedAt is set exactly for failed, expired, cancelled and unknown (status ${r.status})`);

  // I2
  if (isSet(r.payload)) assert.ok(pending, `${who}: I2 payload only while queued or sending (status ${r.status})`);

  // I3
  if (r.status === "queued") {
    for (const column of ["waId", "sendingAt", "sentAt", "deliveredAt", "readAt", "endedAt", "errorCode", "choices", "replyData", "pollSecret", "repliesUntil"]) {
      assert.ok(!isSet(r[column]), `${who}: I3 a queued message has no ${column}`);
    }
  }

  // I4
  assert.equal(isSet(r.sendingAt), isSet(r.waId), `${who}: I4 sendingAt and waId are written by one UPDATE`);
  if (SENT_STATUSES.includes(r.status)) assert.ok(isSet(r.sendingAt), `${who}: I4 ${r.status} implies sendingAt`);
  if (r.status === "sent") assert.ok(isSet(r.sentAt), `${who}: I4 sent implies sentAt`);
  if (r.status === "delivered") assert.ok(isSet(r.deliveredAt), `${who}: I4 delivered implies deliveredAt`);
  if (r.status === "read") assert.ok(isSet(r.readAt), `${who}: I4 read implies readAt`);

  // I5: engine-clock steps are monotone (deliveredAt and readAt carry WhatsApp's time and are not compared)
  const chain = [["acceptedAt", r.acceptedAt], ["sendingAt", r.sendingAt], ["sentAt", r.sentAt]].filter(([, value]) => isSet(value));
  for (let i = 1; i < chain.length; i++) {
    assert.ok(time(chain[i - 1][1]) <= time(chain[i][1]), `${who}: I5 ${chain[i - 1][0]} <= ${chain[i][0]}`);
  }
  if (isSet(r.endedAt)) assert.ok(time(r.acceptedAt) <= time(r.endedAt), `${who}: I5 acceptedAt <= endedAt`);

  // I6
  if (isSet(r.mediaPath) && !pending) {
    assert.ok(pendingMedia, `${who}: I6 a message outside queued and sending still holds its mediaPath (deletion pending)`);
  }

  // I7: reply material
  const material = ["choices", "replyData", "pollSecret", "repliesUntil"].filter((column) => isSet(r[column]));
  if (material.length) {
    assert.ok(INTERACTIVE_FORMATS.includes(r.format), `${who}: I7 reply material (${material.join(", ")}) only for an interactive format (${r.format})`);
    assert.ok(LEFT_STATUSES.includes(r.status), `${who}: I7 reply material only once the message was claimed and not failed (status ${r.status})`);
  }
  for (const column of ["replyData", "pollSecret"]) {
    if (isSet(r[column])) assert.equal(r.format, "poll", `${who}: I7 ${column} only for a poll`);
  }
  if (r.status === "sending") assert.ok(!isSet(r.repliesUntil), `${who}: I7 repliesUntil is NULL while sending`);

  // I8
  assert.equal(r.source === "api", isSet(r.apiKeyId), `${who}: I8 source api <=> apiKeyId (source ${r.source})`);
  assert.equal(isSet(r.idempotencyKey), isSet(r.requestHash), `${who}: I8 idempotencyKey and requestHash are NULL together`);

  // I9
  if (String(r.recipient).endsWith("@g.us")) {
    assert.ok(!["delivered", "read"].includes(r.status), `${who}: I9 a group never reaches ${r.status}`);
    assert.ok(!isSet(r.deliveredAt) && !isSet(r.readAt), `${who}: I9 a group has no deliveredAt or readAt`);
  }
}

/**
 * `revokedAt IS NULL <=> nameKey IS NOT NULL`, and `nameKey = name.toLowerCase()` while set (data-model.md 1.3, 1.5).
 * @param {object} row  an ApiKey instance or its plain object
 */
function assertKeyInvariants(row) {
  const r = plain(row);
  const who = `key ${r.id}`;
  assert.equal(!isSet(r.revokedAt), isSet(r.nameKey), `${who}: revokedAt IS NULL <=> nameKey IS NOT NULL`);
  if (isSet(r.nameKey)) assert.equal(r.nameKey, String(r.name).toLowerCase(), `${who}: nameKey is name.toLowerCase()`);
  assert.ok(Number.isInteger(r.version) && r.version >= 1, `${who}: version is a positive integer`);
}

/**
 * Derived key status, first match (data-model.md 1.4). `now` is a Date or milliseconds; an expiry equal to `now`
 * is already expired.
 * @returns {"revoked"|"expired"|"active"}
 */
function keyStatus(row, now) {
  const r = plain(row);
  if (isSet(r.revokedAt)) return "revoked";
  if (isSet(r.expiresAt) && time(r.expiresAt) <= time(now)) return "expired";
  return "active";
}

module.exports = {
  assertMessageInvariants,
  assertKeyInvariants,
  keyStatus,
  ENDED_STATUSES,
  PENDING_STATUSES,
  INTERACTIVE_FORMATS,
};
