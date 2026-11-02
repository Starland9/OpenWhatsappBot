"use strict";

/**
 * The messaging API's switch and plain-HTTP network list (specs/004-messaging-api: contracts/runtime.md section 13,
 * data-model.md section 4), over the singleton `ApiState` row (id 1).
 *
 *   load({ models })                       -> Promise<void>   absence of the row = { enabled: false, plainHttpFrom: [] };
 *                                                              a read failure = disabled + one warning
 *   get()                                  -> { enabled, plainHttpFrom, updatedAt }   frozen snapshot, synchronous
 *   isEnabled()                            -> boolean         the row's switch AND the admin panel (FR-007)
 *   plainHttpFrom()                        -> string[]
 *   setEnabled(enabled, { now })           -> Promise<{ changed, enabled }>             alias: set
 *   setPlainHttpFrom(list, { now })        -> Promise<{ changed, plainHttpFrom }>
 *   setState({ enabled, plainHttpFrom }, { now }) -> Promise<{ changed, enabled, plainHttpFrom }>
 *                                                              both fields in ONE statement (panel route API-2)
 *   onChange(fn)                           -> off()           fn({ enabled, plainHttpFrom, previous })
 *
 * Not a catalog setting: the settings page, config.env, the environment and a restore reach settings without the
 * password, this row has one writer (the panel route API-2, behind the step-up, which also audits: this module
 * never audits). A write goes to the row (an upsert on id 1, only the changed columns), then to memory, then to the
 * listeners, each isolated; a failed write leaves memory unchanged and tells nobody. The same state returns
 * `changed: false` with no write and no notification. **No row is created by a read**: the first write creates it
 * (the "no GET writes" rule of test/admin-security.test.js).
 *
 * `plainHttpFrom` is validated here as a backstop (the panel service validates the same way first to answer 422
 * with the indices): an array, every entry parsed by lib/api/ipRules.js with `privateOnly` (RFC 1918, CGNAT, ULA; a
 * loopback, a public range, `0.0.0.0/0` and `::/0` are refused) and at most MAX_PLAIN_HTTP distinct entries, before
 * anything is written. A refusal is an `Error` with `code: "invalid_format"` and `params: { indices }` (a syntax
 * error), `{ indices, reason: "not_private" }` or `{ indices, reason: "too_many" }`; the submitted value is never in
 * the message. The canonical strings are stored.
 *
 * Layering (RT-01): no lib/admin, and lib/api/ipRules.js (a dependency-free leaf) only lazily. Settings are read at
 * call time (RT-03); `now` makes the written time injectable (RT-08). Nothing runs at require.
 */

const config = require("../../config");
const { createLogger } = require("./logger");
const { withLock } = require("./mutex");

const logger = createLogger("apiState");

// Writes are serialised by their own key: "api-state" belongs to the panel service, which holds it while it calls us
const WRITE_LOCK = "api-state:write";
const EMPTY_LIST = Object.freeze([]);

/** An immutable view of the state */
const snapshot = (enabled, list, updatedAt) =>
  Object.freeze({ enabled, plainHttpFrom: Object.freeze([...list]), updatedAt });

let model = null;
let state = snapshot(false, EMPTY_LIST, null);
const listeners = [];

function stateError(code, params) {
  const error = new Error(`ApiState: ${code}`);
  error.code = code;
  error.params = params;
  return error;
}

/** A JSON column as a list of strings; a damaged value is an empty list (data-model 0.2) */
function asList(value) {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
}

/** The state is read once at boot (and after a restore or restart); no row means the safe default */
async function load({ models } = {}) {
  const source = models || require("../database");
  model = source.ApiState;
  try {
    const row = await model.findByPk(1);
    state = row
      ? snapshot(row.enabled === true || row.enabled === 1, asList(row.plainHttpFrom), row.updatedAt ? new Date(row.updatedAt) : null)
      : snapshot(false, EMPTY_LIST, null);
  } catch {
    state = snapshot(false, EMPTY_LIST, null);
    logger.warn("API state unreadable: the messaging API stays disabled");
  }
}

const get = () => state;

/** The row's switch AND the admin panel: with ADMIN_PANEL=false there is no API whatever the row says */
const isEnabled = () => state.enabled && config.ADMIN_PANEL !== false;

const plainHttpFrom = () => state.plainHttpFrom;

/**
 * A list for `ApiState.plainHttpFrom`: canonical strings, or a throw (see the header). The indices are 0-based
 * positions in the submitted list.
 */
function normalizeNetworks(list) {
  const rules = require("../api/ipRules");
  if (!Array.isArray(list)) throw stateError("invalid_format", { indices: [] });
  const parsed = rules.parse(list, { privateOnly: true, max: rules.MAX_PLAIN_HTTP });

  const syntax = parsed.invalid.filter((item) => !item.reason).map((item) => item.index);
  if (syntax.length) throw stateError("invalid_format", { indices: syntax });
  const outside = parsed.invalid.filter((item) => item.reason === "not_private").map((item) => item.index);
  if (outside.length) throw stateError("invalid_format", { indices: outside, reason: "not_private" });

  if (parsed.tooMany) {
    const seen = new Set();
    const overflow = [];
    list.forEach((item, index) => {
      const value = rules.parseEntry(item).value;
      if (seen.has(value)) return;
      seen.add(value);
      if (seen.size > rules.MAX_PLAIN_HTTP) overflow.push(index);
    });
    throw stateError("invalid_format", { indices: overflow, reason: "too_many" });
  }
  return parsed.entries;
}

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

/** Each listener runs after the write, in registration order; a throw or a rejection never reaches the caller */
async function notify(previous) {
  const change = { enabled: state.enabled, plainHttpFrom: state.plainHttpFrom, previous };
  for (const listener of [...listeners]) {
    try {
      await listener.fn(change);
    } catch {
      logger.warn("API state listener failed");
    }
  }
}

async function setState(changes = {}, { now } = {}) {
  const patch = {};
  if (changes.enabled !== undefined) {
    if (typeof changes.enabled !== "boolean") throw stateError("invalid_format", { indices: [] });
    patch.enabled = changes.enabled;
  }
  if (changes.plainHttpFrom !== undefined) patch.plainHttpFrom = normalizeNetworks(changes.plainHttpFrom);

  return withLock(WRITE_LOCK, async () => {
    const previous = state;
    const diff = {};
    if (patch.enabled !== undefined && patch.enabled !== previous.enabled) diff.enabled = patch.enabled;
    if (patch.plainHttpFrom !== undefined && !sameList(patch.plainHttpFrom, previous.plainHttpFrom)) diff.plainHttpFrom = patch.plainHttpFrom;

    if (!Object.keys(diff).length) {
      return { changed: false, enabled: previous.enabled, plainHttpFrom: [...previous.plainHttpFrom] };
    }

    const when = now === undefined ? new Date() : new Date(now);
    if (!model) model = require("../database").ApiState;
    // only the changed columns: the INSERT of a first write takes the defaults for the others
    await model.upsert({ id: 1, ...diff, updatedAt: when });

    state = snapshot(diff.enabled ?? previous.enabled, diff.plainHttpFrom ?? previous.plainHttpFrom, when);
    await notify(previous);
    return { changed: true, enabled: state.enabled, plainHttpFrom: [...state.plainHttpFrom] };
  });
}

// `undefined` is "unchanged" for setState but a mistake for these two single-field setters: null makes it a refusal
async function setEnabled(enabled, options) {
  const { changed, enabled: now } = await setState({ enabled: enabled === undefined ? null : enabled }, options);
  return { changed, enabled: now };
}

async function setPlainHttpFrom(list, options) {
  const { changed, plainHttpFrom: stored } = await setState({ plainHttpFrom: list === undefined ? null : list }, options);
  return { changed, plainHttpFrom: stored };
}

/** Register a listener of changes; the returned function removes it (and may be called twice) */
function onChange(fn) {
  if (typeof fn !== "function") throw new TypeError("onChange expects a function");
  const entry = { fn };
  listeners.push(entry);
  return () => {
    const index = listeners.indexOf(entry);
    if (index !== -1) listeners.splice(index, 1);
  };
}

module.exports = {
  load,
  get,
  isEnabled,
  plainHttpFrom,
  setEnabled,
  set: setEnabled,
  setPlainHttpFrom,
  setState,
  onChange,
};
