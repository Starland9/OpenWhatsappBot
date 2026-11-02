"use strict";

/**
 * The ids of the messages this process sent for the messaging API (feature 004, contracts/runtime.md section 6).
 *
 *   remember(id[, now])   the engine calls it BEFORE `sendMessage`, so even an echo that arrives before the call
 *                         resolves is known
 *   has(id[, now])        true while the id is remembered; read by `lib/core/pipeline.js#handleMessage` to ignore
 *                         the `fromMe` echo of an API message (never a command, FR-039, SC-008)
 *   size()                number of ids held (tests)
 *   _reset()              forget everything (tests)
 *
 * A `Map<id, expiresAt>` bounded in time (15 minutes, `LIMITS.SENT_IDS_TTL_MS`) and in size (2000 ids,
 * `LIMITS.SENT_IDS_MAX`): expired ids are pruned lazily on `remember`, the oldest go first when the cap is reached.
 * No timer and nothing imported, not even `limits.js`: the pipeline requires this leaf on every start-up and must
 * not pull the engine in (RT-71), so the two numbers are repeated here (`test/messaging-never-command.test.js`
 * pins them).
 */

const TTL_MS = 15 * 60 * 1000;
const MAX = 2000;

/** @type {Map<string, number>} id -> instant after which it is forgotten */
const held = new Map();

const clockNow = () => Date.now();

/** Remember an id; remembering it again refreshes it. */
function remember(id, now = clockNow()) {
  if (typeof id !== "string" || !id) return;
  for (const [known, expiresAt] of held) if (expiresAt <= now) held.delete(known);
  held.delete(id); // a refresh moves it to the end of the insertion order
  while (held.size >= MAX) held.delete(held.keys().next().value);
  held.set(id, now + TTL_MS);
}

/** Was this id sent by this process in the last 15 minutes? */
function has(id, now = clockNow()) {
  if (typeof id !== "string" || !id) return false;
  const expiresAt = held.get(id);
  return expiresAt !== undefined && expiresAt > now;
}

const size = () => held.size;

function _reset() {
  held.clear();
}

module.exports = { remember, has, size, _reset };
